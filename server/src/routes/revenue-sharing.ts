import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { branchFilter, getBranchIdForInsert } from '../utils/branch.js';
import { requireInt, requireString, requireNumber, optionalString, optionalNumber, ValidationError } from '../middleware/validate.js';

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
  const bf = branchFilter(req);
  const fy_id = req.query.fy_id ? requireInt(req.query.fy_id, 'fy_id') : null;

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

  // Rules are keyed by doctor_id, not doctor_name — name variants ("DR.SMITH"
  // vs "Dr Smith") that all alias to the same canonical doctor share one rule
  // set, which is the whole point of the alias layer.
  const ruleLookup: Record<number, Record<string, { doctor_pct: number; magna_pct: number }>> = {};
  for (const r of rules as any[]) {
    if (!ruleLookup[r.doctor_id]) ruleLookup[r.doctor_id] = {};
    ruleLookup[r.doctor_id][r.category_name] = { doctor_pct: r.doctor_pct, magna_pct: r.magna_pct };
  }

  // Map every raw billed_doctor / referred_by string to its canonical doctor.
  // Filtered by the caller's branch — a Chennai-only user only resolves
  // aliases that point to Chennai (or unscoped) doctors. Raw names without a
  // matching alias fall through to an "unmapped" group keyed on raw text so
  // their revenue is still visible (just not rolled up under a rule).
  const aliasBf = branchFilter(req, 'd');
  const aliasRows = db.all(
    `SELECT a.alias, a.doctor_id, d.name AS doctor_name
     FROM doctor_aliases a
     JOIN doctors d ON a.doctor_id = d.id
     WHERE 1=1${aliasBf.where}`,
    ...aliasBf.params
  );
  const aliasLookup: Record<string, { doctor_id: number; doctor_name: string }> = {};
  for (const a of aliasRows as any[]) {
    aliasLookup[a.alias] = { doctor_id: a.doctor_id, doctor_name: a.doctor_name };
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

  // Aggregate into a doctor bucket keyed by canonical doctor_id when the raw
  // name resolves through doctor_aliases, otherwise by the raw string itself.
  // The "raw:" prefix on unmapped keys keeps them from colliding with a
  // numeric id key.
  type DocBucket = {
    doctor_id: number | null;
    doctor_name: string;
    is_unmapped: boolean;
    raw_aliases: Set<string>;
    categories: Record<string, { revenue: number; monthly: Record<string, number> }>;
  };
  const doctorMap: Record<string, DocBucket> = {};

  const ensureDoc = (rawName: string): DocBucket => {
    const alias = aliasLookup[rawName];
    const key = alias ? `id:${alias.doctor_id}` : `raw:${rawName}`;
    if (!doctorMap[key]) {
      doctorMap[key] = {
        doctor_id: alias?.doctor_id ?? null,
        doctor_name: alias?.doctor_name ?? rawName,
        is_unmapped: !alias,
        raw_aliases: new Set(),
        categories: {},
      };
    }
    doctorMap[key].raw_aliases.add(rawName);
    return doctorMap[key];
  };
  const ensureCat = (bucket: DocBucket, cat: string) => {
    if (!bucket.categories[cat]) bucket.categories[cat] = { revenue: 0, monthly: {} };
    return bucket.categories[cat];
  };

  for (const row of clinicRows as any[]) {
    const bucket = ensureDoc(row.doctor_name);
    const cat = ensureCat(bucket, row.service_category);
    cat.revenue += row.total_revenue;
    cat.monthly[row.bill_month] = (cat.monthly[row.bill_month] || 0) + row.total_revenue;
  }

  for (const row of pharmacyRows as any[]) {
    const bucket = ensureDoc(row.doctor_name);
    const cat = ensureCat(bucket, 'Pharmacy');
    cat.revenue += row.total_revenue;
    cat.monthly[row.bill_month] = (cat.monthly[row.bill_month] || 0) + row.total_revenue;
  }

  // ── Build response ──
  let grandTotalRevenue = 0, grandDoctorShare = 0, grandMagnaShare = 0;
  const doctors: any[] = [];

  for (const bucket of Object.values(doctorMap)) {
    const docRules = bucket.doctor_id != null ? (ruleLookup[bucket.doctor_id] || {}) : {};
    let docTotalRev = 0, docTotalDoctorShare = 0, docTotalMagnaShare = 0;
    const catBreakdown: any[] = [];

    for (const [catName, data] of Object.entries(bucket.categories)) {
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
      doctor_id: bucket.doctor_id,
      doctor_name: bucket.doctor_name,
      is_unmapped: bucket.is_unmapped,
      raw_aliases: [...bucket.raw_aliases].sort(),
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

router.post('/categories', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const name = requireString(req.body.name, 'name', 100);
  const source = optionalString(req.body.source, 'source', 50) || 'clinic';
  const match_department = optionalString(req.body.match_department, 'match_department', 200);
  const match_keyword = optionalString(req.body.match_keyword, 'match_keyword', 200);
  const match_mode = optionalString(req.body.match_mode, 'match_mode', 50) || 'contains';
  const priority = optionalNumber(req.body.priority, 'priority') ?? 0;
  db.run(
    `INSERT INTO revenue_sharing_categories (name, source, match_department, match_keyword, match_mode, priority) VALUES (?, ?, ?, ?, ?, ?)`,
    name, source, match_department || null, match_keyword || null, match_mode, priority
  );
  res.json({ ok: true });
});

router.put('/categories/:id', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const id = requireInt(req.params.id, 'id');
  const name = requireString(req.body.name, 'name', 100);
  const source = optionalString(req.body.source, 'source', 50) || 'clinic';
  const match_department = optionalString(req.body.match_department, 'match_department', 200);
  const match_keyword = optionalString(req.body.match_keyword, 'match_keyword', 200);
  const match_mode = optionalString(req.body.match_mode, 'match_mode', 50) || 'contains';
  const priority = optionalNumber(req.body.priority, 'priority') ?? 0;
  const is_active = req.body.is_active ?? 1;
  db.run(
    `UPDATE revenue_sharing_categories SET name=?, source=?, match_department=?, match_keyword=?, match_mode=?, priority=?, is_active=? WHERE id=?`,
    name, source, match_department || null, match_keyword || null, match_mode, priority, is_active, id
  );
  res.json({ ok: true });
});

router.delete('/categories/:id', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const id = requireInt(req.params.id, 'id');
  db.run('DELETE FROM revenue_sharing_categories WHERE id = ?', id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
//  RULES CRUD
// ══════════════════════════════════════════════════════════════════════
router.get('/rules', (req, res) => {
  const db = req.tenantDb!;
  // Alias 'd' so the branch filter applies to the joined doctors row, not
  // to revenue_sharing_rules itself (which has no branch_id — rules inherit
  // visibility through the JOIN).
  const bf = branchFilter(req, 'd');
  const rows = db.all(
    `SELECT r.*, d.name as doctor_name, c.name as category_name
     FROM revenue_sharing_rules r
     JOIN doctors d ON r.doctor_id = d.id
     JOIN revenue_sharing_categories c ON r.category_id = c.id
     WHERE 1=1${bf.where}
     ORDER BY d.name, c.priority DESC`,
    ...bf.params
  );
  res.json(rows);
});

router.post('/rules', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const doctor_id = requireInt(req.body.doctor_id, 'doctor_id');
  const category_id = requireInt(req.body.category_id, 'category_id');
  const doctor_pct = requireNumber(req.body.doctor_pct, 'doctor_pct');
  const magnaPct = 100 - doctor_pct;
  db.run(
    `INSERT INTO revenue_sharing_rules (doctor_id, category_id, doctor_pct, magna_pct)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(doctor_id, category_id) DO UPDATE SET doctor_pct = excluded.doctor_pct, magna_pct = excluded.magna_pct`,
    doctor_id, category_id, doctor_pct, magnaPct
  );
  res.json({ ok: true });
});

router.put('/rules/:id', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const id = requireInt(req.params.id, 'id');
  const doctor_pct = requireNumber(req.body.doctor_pct, 'doctor_pct');
  const magnaPct = 100 - doctor_pct;
  db.run('UPDATE revenue_sharing_rules SET doctor_pct = ?, magna_pct = ? WHERE id = ?', doctor_pct, magnaPct, id);
  res.json({ ok: true });
});

router.delete('/rules/:id', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const id = requireInt(req.params.id, 'id');
  db.run('DELETE FROM revenue_sharing_rules WHERE id = ?', id);
  res.json({ ok: true });
});

// ── Doctors list for dropdowns ──
// Branch-scoped: a Chennai-restricted user only sees Chennai doctors. Doctors
// with branch_id IS NULL stay visible to everyone (legacy / unassigned rows).
router.get('/doctors', (req, res) => {
  const db = req.tenantDb!;
  const bf = branchFilter(req);
  const rows = db.all(
    `SELECT id, name FROM doctors WHERE is_active = 1${bf.where} ORDER BY name`,
    ...bf.params
  );
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════
//  DOCTOR NAME ALIASES
// ══════════════════════════════════════════════════════════════════════
// Returns:
//   - aliases: raw_name → doctor row (branch-scoped via the joined doctor)
//   - unmapped: raw_name strings still without an alias, with the revenue
//     they would carry across the active FY (sorted desc) so admin can
//     prioritize the highest-impact merges first.
router.get('/aliases', (req, res) => {
  const db = req.tenantDb!;
  const bfDoc = branchFilter(req, 'd');
  const aliases = db.all(
    `SELECT a.id, a.alias, a.doctor_id, d.name AS doctor_name
     FROM doctor_aliases a
     JOIN doctors d ON a.doctor_id = d.id
     WHERE 1=1${bfDoc.where}
     ORDER BY d.name COLLATE NOCASE, a.alias COLLATE NOCASE`,
    ...bfDoc.params
  );

  const fy = db.get('SELECT * FROM financial_years WHERE is_active = 1');
  const startMonth = fy ? fy.start_date.slice(0, 7) : '0000-00';
  const endMonth = fy ? fy.end_date.slice(0, 7) : '9999-99';
  const bfRaw = branchFilter(req);

  // Distinct raw names from clinic + pharmacy that don't yet have an alias,
  // each carrying the FY revenue they currently sit on. UNION ALL inside a
  // GROUP BY so a name appearing in both sources collapses to one row.
  const unmapped = db.all(
    `SELECT raw_name, SUM(revenue) AS revenue, MAX(source_label) AS source
     FROM (
       SELECT ca.billed_doctor AS raw_name,
              SUM(COALESCE(ca.item_price, 0)) AS revenue,
              'clinic' AS source_label
       FROM clinic_actuals ca
       WHERE ca.bill_month >= ? AND ca.bill_month <= ?
         AND ca.billed_doctor IS NOT NULL
         AND ca.billed_doctor != '' AND ca.billed_doctor != '-'
         AND ca.billed_doctor NOT IN (SELECT alias FROM doctor_aliases)${bfRaw.where}
       GROUP BY ca.billed_doctor
       UNION ALL
       SELECT ps.referred_by AS raw_name,
              SUM(COALESCE(ps.sales_amount, 0)) AS revenue,
              'pharmacy' AS source_label
       FROM pharmacy_sales_actuals ps
       WHERE ps.bill_month >= ? AND ps.bill_month <= ?
         AND ps.referred_by IS NOT NULL AND ps.referred_by != ''
         AND ps.referred_by NOT IN (SELECT alias FROM doctor_aliases)${bfRaw.where}
       GROUP BY ps.referred_by
     )
     GROUP BY raw_name
     ORDER BY revenue DESC`,
    startMonth, endMonth, ...bfRaw.params,
    startMonth, endMonth, ...bfRaw.params
  );

  res.json({ aliases, unmapped });
});

// Upsert an alias → doctor mapping. Used both to create new aliases for
// previously-unmapped raw names, and to re-target an existing alias to a
// different canonical doctor (the merge action).
router.post('/aliases', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const alias = requireString(req.body.alias, 'alias', 200);
  const doctor_id = requireInt(req.body.doctor_id, 'doctor_id');
  db.run(
    `INSERT INTO doctor_aliases (alias, doctor_id) VALUES (?, ?)
     ON CONFLICT(alias) DO UPDATE SET doctor_id = excluded.doctor_id`,
    alias, doctor_id
  );
  res.json({ ok: true });
});

router.delete('/aliases/:id', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const id = requireInt(req.params.id, 'id');
  db.run('DELETE FROM doctor_aliases WHERE id = ?', id);
  res.json({ ok: true });
});

// Create a new canonical doctor row. Mirrors POST /api/settings/doctors so
// the alias-merge UI can spin up a fresh "Dr. Shanmugasundar" inline without
// leaving the Rules tab. Returns the existing id when the name is already
// taken (INSERT OR IGNORE leaves lastInsertRowid at 0 in that case).
router.post('/doctors', requireRole('admin'), (req, res) => {
  const db = req.tenantDb!;
  const name = requireString(req.body.name, 'name', 200);
  const branchId = getBranchIdForInsert(req);
  const result = db.run('INSERT OR IGNORE INTO doctors (name, branch_id) VALUES (?, ?)', name, branchId);
  let id = Number(result.lastInsertRowid);
  if (!id) {
    const existing = db.get('SELECT id FROM doctors WHERE name = ?', name);
    if (existing) id = existing.id;
  }
  res.json({ id });
});

export default router;
