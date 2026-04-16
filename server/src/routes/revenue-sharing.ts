import { Router } from 'express';
import { branchFilter } from '../utils/branch.js';

const router = Router();

// ── Helper: classify a clinic_actuals row into a revenue-sharing category ──
// Replaces the former buildCategoryCase() which interpolated user-controlled
// values directly into SQL (SQL injection risk). Classification now happens
// entirely in JavaScript after the raw data is fetched.
function classifyRow(row: { department?: string; service_name?: string }, clinicCategories: any[]): string {
  for (const cat of clinicCategories) {
    let matches = true;

    if (cat.match_department) {
      if (row.department !== cat.match_department) matches = false;
    }

    if (matches && cat.match_keyword) {
      const serviceLower = (row.service_name || '').toLowerCase();
      if (cat.match_mode === 'contains') {
        if (!serviceLower.includes(cat.match_keyword.toLowerCase())) matches = false;
      } else if (cat.match_mode === 'and_contains') {
        const keywords = cat.match_keyword.split(',').map((k: string) => k.trim().toLowerCase());
        for (const kw of keywords) {
          if (!serviceLower.includes(kw)) { matches = false; break; }
        }
      }
    }

    // A category with no match_department and no match_keyword has no conditions — skip it
    if (!cat.match_department && !cat.match_keyword) continue;

    if (matches) return cat.name;
  }
  return 'Other';
}

// ══════════════════════════════════════════════════════════════════════
//  DASHBOARD — Revenue sharing computation
// ══════════════════════════════════════════════════════════════════════
router.get('/dashboard', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);

  const fy = fy_id
    ? db.get('SELECT * FROM financial_years WHERE id = ?', fy_id)
    : db.get('SELECT * FROM financial_years WHERE is_active = 1');
  if (!fy) return res.json({ error: 'No active FY' });

  const startMonth = fy.start_date.slice(0, 7);
  const endMonth = fy.end_date.slice(0, 7);

  // Load categories & rules
  const categories = db.all('SELECT * FROM revenue_sharing_categories WHERE is_active = 1');
  const rules = db.all(
    `SELECT r.*, d.name as doctor_name, c.name as category_name
     FROM revenue_sharing_rules r
     JOIN doctors d ON r.doctor_id = d.id
     JOIN revenue_sharing_categories c ON r.category_id = c.id
     WHERE r.is_active = 1`
  );

  // Build lookup: doctor_name → category_name → { doctor_pct, magna_pct }
  const ruleLookup: Record<string, Record<string, { doctor_pct: number; magna_pct: number }>> = {};
  for (const r of rules as any[]) {
    if (!ruleLookup[r.doctor_name]) ruleLookup[r.doctor_name] = {};
    ruleLookup[r.doctor_name][r.category_name] = { doctor_pct: r.doctor_pct, magna_pct: r.magna_pct };
  }

  // ── Clinic revenue by doctor × category ──
  // Fetch raw rows without SQL-level classification to avoid SQL injection.
  // Category classification is done in JavaScript below.
  const clinicCategories = [...categories].filter(c => c.source === 'clinic').sort((a, b) => b.priority - a.priority);
  const rawClinicRows = db.all(
    `SELECT ca.billed_doctor AS doctor_name, ca.bill_month,
       ca.department, ca.service_name,
       COALESCE(ca.item_price, 0) AS item_price
     FROM clinic_actuals ca
     WHERE ca.bill_month >= ? AND ca.bill_month <= ?
       AND ca.billed_doctor IS NOT NULL AND ca.billed_doctor != '-' AND ca.billed_doctor != ''${bf.where}`,
    startMonth, endMonth, ...bf.params
  );

  // Classify each row in JS, then aggregate by (doctor, month, category)
  const clinicAgg: Record<string, { doctor_name: string; bill_month: string; service_category: string; total_revenue: number }> = {};
  for (const row of rawClinicRows as any[]) {
    const category = classifyRow(row, clinicCategories);
    const key = `${row.doctor_name}|${row.bill_month}|${category}`;
    if (!clinicAgg[key]) {
      clinicAgg[key] = { doctor_name: row.doctor_name, bill_month: row.bill_month, service_category: category, total_revenue: 0 };
    }
    clinicAgg[key].total_revenue += row.item_price;
  }
  const clinicRows = Object.values(clinicAgg);

  // ── Pharmacy revenue by doctor ──
  const pharmacyCat = categories.find((c: any) => c.source === 'pharmacy');
  const pharmacyRows = pharmacyCat ? db.all(
    `SELECT COALESCE(NULLIF(referred_by, ''), 'Walk-in') AS doctor_name, bill_month,
       COALESCE(SUM(sales_amount), 0) AS total_revenue
     FROM pharmacy_sales_actuals
     WHERE bill_month >= ? AND bill_month <= ?
       AND referred_by IS NOT NULL AND referred_by != ''${bf.where}
     GROUP BY referred_by, bill_month`,
    startMonth, endMonth, ...bf.params
  ) : [];

  // ── Aggregate into doctor → category → { revenue, monthly } ──
  const doctorMap: Record<string, Record<string, { revenue: number; monthly: Record<string, number> }>> = {};

  const ensureDoc = (name: string, cat: string) => {
    if (!doctorMap[name]) doctorMap[name] = {};
    if (!doctorMap[name][cat]) doctorMap[name][cat] = { revenue: 0, monthly: {} };
  };

  for (const row of clinicRows as any[]) {
    ensureDoc(row.doctor_name, row.service_category);
    doctorMap[row.doctor_name][row.service_category].revenue += row.total_revenue;
    doctorMap[row.doctor_name][row.service_category].monthly[row.bill_month] =
      (doctorMap[row.doctor_name][row.service_category].monthly[row.bill_month] || 0) + row.total_revenue;
  }

  for (const row of pharmacyRows as any[]) {
    ensureDoc(row.doctor_name, 'Pharmacy');
    doctorMap[row.doctor_name]['Pharmacy'].revenue += row.total_revenue;
    doctorMap[row.doctor_name]['Pharmacy'].monthly[row.bill_month] =
      (doctorMap[row.doctor_name]['Pharmacy'].monthly[row.bill_month] || 0) + row.total_revenue;
  }

  // ── Build response ──
  let grandTotalRevenue = 0, grandDoctorShare = 0, grandMagnaShare = 0;
  const doctors: any[] = [];

  for (const [doctorName, catMap] of Object.entries(doctorMap)) {
    const docRules = ruleLookup[doctorName] || {};
    let docTotalRev = 0, docTotalDoctorShare = 0, docTotalMagnaShare = 0;
    const catBreakdown: any[] = [];

    for (const [catName, data] of Object.entries(catMap)) {
      const rule = docRules[catName];
      const doctorPct = rule?.doctor_pct ?? 0;
      const magnaPct = rule?.magna_pct ?? 100;
      const doctorShare = data.revenue * doctorPct / 100;
      const magnaShare = data.revenue * magnaPct / 100;

      catBreakdown.push({
        category: catName,
        revenue: Math.round(data.revenue),
        doctor_pct: doctorPct,
        magna_pct: magnaPct,
        doctor_share: Math.round(doctorShare),
        magna_share: Math.round(magnaShare),
        has_rule: !!rule,
        monthly: Object.entries(data.monthly).map(([month, rev]) => ({
          month, revenue: Math.round(rev as number),
          doctor_share: Math.round((rev as number) * doctorPct / 100),
          magna_share: Math.round((rev as number) * magnaPct / 100),
        })).sort((a, b) => a.month.localeCompare(b.month)),
      });

      docTotalRev += data.revenue;
      docTotalDoctorShare += doctorShare;
      docTotalMagnaShare += magnaShare;
    }

    grandTotalRevenue += docTotalRev;
    grandDoctorShare += docTotalDoctorShare;
    grandMagnaShare += docTotalMagnaShare;

    doctors.push({
      doctor_name: doctorName,
      has_any_rule: Object.keys(docRules).length > 0,
      categories: catBreakdown.sort((a, b) => b.revenue - a.revenue),
      totals: {
        revenue: Math.round(docTotalRev),
        doctor_share: Math.round(docTotalDoctorShare),
        magna_share: Math.round(docTotalMagnaShare),
        doctor_pct: docTotalRev > 0 ? Math.round((docTotalDoctorShare / docTotalRev) * 100) : 0,
      },
    });
  }

  // Sort doctors by total revenue DESC
  doctors.sort((a, b) => b.totals.revenue - a.totals.revenue);

  // All unique category names that appear in data
  const allCategories = [...new Set(doctors.flatMap(d => d.categories.map((c: any) => c.category)))];

  res.json({
    fy,
    doctors,
    allCategories,
    grandTotals: {
      revenue: Math.round(grandTotalRevenue),
      doctor_share: Math.round(grandDoctorShare),
      magna_share: Math.round(grandMagnaShare),
      magna_pct: grandTotalRevenue > 0 ? Math.round((grandMagnaShare / grandTotalRevenue) * 100) : 0,
    },
  });
});

// ══════════════════════════════════════════════════════════════════════
//  CATEGORIES CRUD
// ══════════════════════════════════════════════════════════════════════
router.get('/categories', (req, res) => {
  const db = req.tenantDb!;
  const rows = db.all('SELECT * FROM revenue_sharing_categories ORDER BY priority DESC, name');
  res.json(rows);
});

router.post('/categories', (req, res) => {
  const db = req.tenantDb!;
  const { name, source, match_department, match_keyword, match_mode, priority } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.run(
    `INSERT INTO revenue_sharing_categories (name, source, match_department, match_keyword, match_mode, priority) VALUES (?, ?, ?, ?, ?, ?)`,
    name, source || 'clinic', match_department || null, match_keyword || null, match_mode || 'contains', priority || 0
  );
  res.json({ ok: true });
});

router.put('/categories/:id', (req, res) => {
  const db = req.tenantDb!;
  const { name, source, match_department, match_keyword, match_mode, priority, is_active } = req.body;
  db.run(
    `UPDATE revenue_sharing_categories SET name=?, source=?, match_department=?, match_keyword=?, match_mode=?, priority=?, is_active=? WHERE id=?`,
    name, source, match_department || null, match_keyword || null, match_mode, priority, is_active ?? 1, req.params.id
  );
  res.json({ ok: true });
});

router.delete('/categories/:id', (req, res) => {
  const db = req.tenantDb!;
  db.run('DELETE FROM revenue_sharing_categories WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
//  RULES CRUD
// ══════════════════════════════════════════════════════════════════════
router.get('/rules', (req, res) => {
  const db = req.tenantDb!;
  const rows = db.all(
    `SELECT r.*, d.name as doctor_name, c.name as category_name
     FROM revenue_sharing_rules r
     JOIN doctors d ON r.doctor_id = d.id
     JOIN revenue_sharing_categories c ON r.category_id = c.id
     ORDER BY d.name, c.priority DESC`
  );
  res.json(rows);
});

router.post('/rules', (req, res) => {
  const db = req.tenantDb!;
  const { doctor_id, category_id, doctor_pct } = req.body;
  if (!doctor_id || !category_id || doctor_pct == null) return res.status(400).json({ error: 'doctor_id, category_id, doctor_pct required' });
  const magnaPct = 100 - Number(doctor_pct);
  db.run(
    `INSERT INTO revenue_sharing_rules (doctor_id, category_id, doctor_pct, magna_pct)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(doctor_id, category_id) DO UPDATE SET doctor_pct = excluded.doctor_pct, magna_pct = excluded.magna_pct`,
    doctor_id, category_id, doctor_pct, magnaPct
  );
  res.json({ ok: true });
});

router.put('/rules/:id', (req, res) => {
  const db = req.tenantDb!;
  const { doctor_pct } = req.body;
  const magnaPct = 100 - Number(doctor_pct);
  db.run('UPDATE revenue_sharing_rules SET doctor_pct = ?, magna_pct = ? WHERE id = ?', doctor_pct, magnaPct, req.params.id);
  res.json({ ok: true });
});

router.delete('/rules/:id', (req, res) => {
  const db = req.tenantDb!;
  db.run('DELETE FROM revenue_sharing_rules WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ── Doctors list for dropdowns ──
router.get('/doctors', (req, res) => {
  const db = req.tenantDb!;
  const rows = db.all('SELECT id, name FROM doctors WHERE is_active = 1 ORDER BY name');
  res.json(rows);
});

export default router;
