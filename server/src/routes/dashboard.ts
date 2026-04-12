import { Router } from 'express';
import { branchFilter, streamFilter } from '../utils/branch.js';
import { getPlatformHelper } from '../db/platform-connection.js';

const router = Router();

router.get('/overview', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);
  const sf = streamFilter(req);
  const fy = fy_id
    ? db.get('SELECT * FROM financial_years WHERE id = ?', fy_id)
    : db.get('SELECT * FROM financial_years WHERE is_active = 1');

  if (!fy) return res.json({ fy: null, streams: [], cards: [], combined: { total_revenue: 0, total_budget: 0 } });

  const startMonth = fy.start_date.slice(0, 7);
  const endMonth = fy.end_date.slice(0, 7);

  const platformDb = await getPlatformHelper();
  const clientStreams = platformDb.all(
    'SELECT id, name, icon, color FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order',
    req.clientId
  );

  // Get dashboard cards (visible ones, ordered)
  const dashboardCards = platformDb.all(
    'SELECT * FROM dashboard_cards WHERE client_id = ? AND is_visible = 1 ORDER BY sort_order, id',
    req.clientId
  );

  // Get chart visibility settings
  const chartVisibility = platformDb.all(
    'SELECT scope, element_key, is_visible FROM dashboard_chart_visibility WHERE client_id = ?',
    req.clientId
  );

  // Default scenario (for legacy untagged revenue and custom cards)
  const defaultScenario = db.get(
    `SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where} ORDER BY id LIMIT 1`,
    fy.id, ...bf.params
  );

  // Build per-stream revenue data (used by both cards and charts)
  const streams: any[] = [];
  let totalRevenue = 0;
  let totalBudget = 0;
  const streamDataMap: Record<number, any> = {};

  for (const stream of clientStreams) {
    // Find the best scenario for THIS stream (prefer stream-specific, fall back to default)
    const scenario = db.get(
      `SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1
       AND (stream_id = ? OR stream_id IS NULL)${bf.where}
       ORDER BY CASE WHEN stream_id = ? THEN 0 ELSE 1 END, id LIMIT 1`,
      fy.id, stream.id, ...bf.params, stream.id
    );

    const revenue = scenario ? db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM dashboard_actuals
       WHERE scenario_id = ? AND category = 'revenue' AND month >= ? AND month <= ?${bf.where}
       AND (stream_id = ? OR stream_id IS NULL)`,
      scenario.id, startMonth, endMonth, ...bf.params, stream.id
    ) : { total: 0 };

    const monthly = scenario ? db.all(
      `SELECT month, category, COALESCE(SUM(amount), 0) as total
       FROM dashboard_actuals
       WHERE scenario_id = ? AND month >= ? AND month <= ?${bf.where}
       AND (stream_id = ? OR stream_id IS NULL)
       GROUP BY month, category ORDER BY month`,
      scenario.id, startMonth, endMonth, ...bf.params, stream.id
    ) : [];

    const budget = db.get(
      `SELECT COALESCE(SUM(amount), 0) as total FROM budgets
       WHERE fy_id = ? AND business_unit = ? AND metric = 'revenue'${bf.where}`,
      fy.id, stream.name, ...bf.params
    );

    const streamTotal = revenue?.total || 0;
    const budgetTotal = budget?.total || 0;
    totalRevenue += streamTotal;
    totalBudget += budgetTotal;

    const streamData = {
      id: stream.id, name: stream.name, icon: stream.icon, color: stream.color,
      total_revenue: streamTotal, budget_total: budgetTotal, monthly,
    };
    streams.push(streamData);
    streamDataMap[stream.id] = streamData;
  }

  // Legacy untagged revenue
  if (defaultScenario) {
    const untagged = db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM dashboard_actuals
       WHERE scenario_id = ? AND category = 'revenue' AND month >= ? AND month <= ?${bf.where}
       AND stream_id IS NULL`,
      defaultScenario.id, startMonth, endMonth, ...bf.params
    );
    if (untagged?.total > 0 && clientStreams.length === 0) {
      totalRevenue += untagged.total;
    }
  }

  // Fallback: if dashboard_actuals has no revenue data, read directly from import tables
  // This handles cases where the auto-sync didn't run or data was lost
  if (totalRevenue === 0) {
    // Build a map of stream name → raw table for known integrations
    const streamSourceMap: Record<string, { table: string; amountCol: string; monthCol: string }> = {};
    for (const stream of clientStreams) {
      const nameLower = stream.name.toLowerCase();
      if (nameLower.includes('clinic') || nameLower.includes('health')) {
        streamSourceMap[stream.id] = { table: 'clinic_actuals', amountCol: 'item_price', monthCol: 'bill_month' };
      } else if (nameLower.includes('pharma')) {
        streamSourceMap[stream.id] = { table: 'pharmacy_sales_actuals', amountCol: 'sales_amount', monthCol: 'bill_month' };
      } else if (nameLower.includes('consult') || nameLower.includes('turia')) {
        streamSourceMap[stream.id] = { table: 'turia_invoices', amountCol: 'total_amount', monthCol: 'invoice_month' };
      }
    }
    // Fallback for no-stream clients
    if (clientStreams.length === 0) {
      try {
        const clinicTotal = db.get(
          `SELECT COALESCE(SUM(item_price), 0) as total FROM clinic_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}`,
          startMonth, endMonth, ...bf.params
        );
        const pharmaTotal = db.get(
          `SELECT COALESCE(SUM(sales_amount), 0) as total FROM pharmacy_sales_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}`,
          startMonth, endMonth, ...bf.params
        );
        totalRevenue = (clinicTotal?.total || 0) + (pharmaTotal?.total || 0);
      } catch { /* tables may not exist */ }
    }
    // Per-stream fallback from raw import tables
    for (const stream of clientStreams) {
      const src = streamSourceMap[stream.id];
      if (!src) continue;
      try {
        const rawTotal = db.get(
          `SELECT COALESCE(SUM(${src.amountCol}), 0) as total FROM ${src.table} WHERE ${src.monthCol} >= ? AND ${src.monthCol} <= ?${bf.where}`,
          startMonth, endMonth, ...bf.params
        );
        const rawMonthly = db.all(
          `SELECT ${src.monthCol} as month, COALESCE(SUM(${src.amountCol}), 0) as total
           FROM ${src.table} WHERE ${src.monthCol} >= ? AND ${src.monthCol} <= ?${bf.where}
           GROUP BY ${src.monthCol} ORDER BY ${src.monthCol}`,
          startMonth, endMonth, ...bf.params
        );
        const rawRevenue = rawTotal?.total || 0;
        if (rawRevenue > 0) {
          totalRevenue += rawRevenue;
          const sd = streamDataMap[stream.id];
          if (sd) {
            sd.total_revenue = rawRevenue;
            sd.monthly = rawMonthly.map((r: any) => ({ month: r.month, category: 'revenue', total: r.total }));
          }
        }
      } catch { /* table may not exist */ }
    }
  }

  // Build cards array from dashboard_cards
  const cards: any[] = [];
  for (const card of dashboardCards) {
    let value = 0, budget = 0, trend: number | undefined;
    let subtitle = '';

    if (card.card_type === 'total') {
      value = totalRevenue;
      budget = totalBudget;
      subtitle = 'All streams';
    } else if (card.card_type === 'stream' && card.stream_id) {
      const sd = streamDataMap[card.stream_id];
      if (sd) {
        value = sd.total_revenue;
        budget = sd.budget_total;
        subtitle = value > 0 ? `vs ${budget} budget` : 'No data yet';
      }
    } else if (card.card_type === 'custom' && defaultScenario) {
      const catData = db.get(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM dashboard_actuals
         WHERE scenario_id = ? AND category = ? AND month >= ? AND month <= ?${bf.where}`,
        defaultScenario.id, card.category, startMonth, endMonth, ...bf.params
      );
      value = catData?.total || 0;
      subtitle = card.category.replace(/_/g, ' ');
    }

    if (budget > 0) {
      trend = ((value - budget) / budget) * 100;
    }

    cards.push({
      id: card.id, card_type: card.card_type, title: card.title,
      icon: card.icon, color: card.color, stream_id: card.stream_id,
      value, budget, trend, subtitle,
    });
  }

  // Filter cards based on selected stream
  let filteredCards = cards;
  let combinedRevenue = totalRevenue;
  let combinedBudget = totalBudget;

  if (req.streamMode === 'specific' && req.streamId) {
    filteredCards = cards.filter(c =>
      c.card_type === 'total' ||
      (c.card_type === 'stream' && c.stream_id === req.streamId)
    );
    const selectedStream = streamDataMap[req.streamId];
    if (selectedStream) {
      combinedRevenue = selectedStream.total_revenue;
      combinedBudget = selectedStream.budget_total;
      for (const c of filteredCards) {
        if (c.card_type === 'total') {
          c.value = combinedRevenue;
          c.budget = combinedBudget;
          c.trend = combinedBudget > 0
            ? ((combinedRevenue - combinedBudget) / combinedBudget) * 100
            : undefined;
        }
      }
    }
  }

  res.json({
    fy, streams, cards: filteredCards, chartVisibility,
    combined: { total_revenue: combinedRevenue, total_budget: combinedBudget },
  });
});

// ─── Clinic Analytics (Healthplix) ───────────────────────────────────────────

router.get('/clinic-analytics', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);

  const fy = fy_id
    ? db.get('SELECT * FROM financial_years WHERE id = ?', fy_id)
    : db.get('SELECT * FROM financial_years WHERE is_active = 1');
  if (!fy) return res.json({ error: 'No FY found' });

  const startMonth = fy.start_date.slice(0, 7);
  const endMonth = fy.end_date.slice(0, 7);

  // Check table exists
  try { db.get('SELECT 1 FROM clinic_actuals LIMIT 1'); } catch {
    return res.json({ hasData: false });
  }

  // Patient-level aggregation
  const patients = db.all(
    `SELECT patient_id, patient_name,
      GROUP_CONCAT(DISTINCT department) as departments,
      COUNT(DISTINCT department) as dept_count,
      COALESCE(SUM(item_price), 0) as total_revenue,
      COALESCE(SUM(billed), 0) as total_billed,
      COALESCE(SUM(paid), 0) as total_paid,
      COALESCE(SUM(discount), 0) as total_discount,
      COUNT(DISTINCT order_number) as visits
     FROM clinic_actuals
     WHERE bill_month >= ? AND bill_month <= ?
       AND patient_id IS NOT NULL AND patient_id != ''${bf.where}
     GROUP BY patient_id`,
    startMonth, endMonth, ...bf.params
  );

  if (patients.length === 0) return res.json({ hasData: false });

  // Department sets per patient
  const deptSets = patients.map((p: any) => ({
    ...p,
    deptSet: new Set((p.departments || '').split(',').map((d: string) => d.trim()).filter(Boolean)),
  }));

  const APPT = 'APPOINTMENT';
  const LAB = 'LAB TEST';
  const OTHER = 'OTHER SERVICES';

  // KPI counts
  const totalUnique = patients.length;
  const apptPatients = deptSets.filter((p: any) => p.deptSet.has(APPT)).length;
  const labPatients = deptSets.filter((p: any) => p.deptSet.has(LAB)).length;
  const otherPatients = deptSets.filter((p: any) => p.deptSet.has(OTHER)).length;
  const directLabWalkins = deptSets.filter((p: any) => p.deptSet.has(LAB) && !p.deptSet.has(APPT)).length;
  const directOtherWalkins = deptSets.filter((p: any) => p.deptSet.has(OTHER) && !p.deptSet.has(APPT)).length;

  // Department overlap counts
  const in1 = deptSets.filter((p: any) => p.dept_count === 1).length;
  const in2 = deptSets.filter((p: any) => p.dept_count === 2).length;
  const in3 = deptSets.filter((p: any) => p.dept_count >= 3).length;

  // Department combination breakdown
  const comboCounts: Record<string, number> = {};
  for (const p of deptSets) {
    const sorted = [...(p as any).deptSet].sort().join(' + ');
    comboCounts[sorted] = (comboCounts[sorted] || 0) + 1;
  }
  const combinations = Object.entries(comboCounts)
    .map(([combo, count]) => ({ combo, count }))
    .sort((a, b) => b.count - a.count);

  // Revenue per patient by dept count
  const revByDeptCount = [1, 2, 3].map(n => {
    const group = deptSets.filter((p: any) => n === 3 ? p.dept_count >= 3 : p.dept_count === n);
    const total = group.reduce((s: number, p: any) => s + p.total_revenue, 0);
    return { deptCount: n, patients: group.length, totalRevenue: total, avgRevenue: group.length ? total / group.length : 0 };
  });

  // Cross-sell funnel (from appointment patients)
  const apptSet = deptSets.filter((p: any) => p.deptSet.has(APPT));
  const otherGroup = apptSet.filter((p: any) => p.deptSet.has(OTHER) && !p.deptSet.has(LAB));
  const labGroup = apptSet.filter((p: any) => p.deptSet.has(LAB) && !p.deptSet.has(OTHER));
  const bothGroup = apptSet.filter((p: any) => p.deptSet.has(LAB) && p.deptSet.has(OTHER));
  const apptOnlyGroup = apptSet.filter((p: any) => p.dept_count === 1);
  const crossToOther = otherGroup.length;
  const crossToLab = labGroup.length;
  const crossToBoth = bothGroup.length;
  const apptOnly = apptOnlyGroup.length;
  const sumRev = (arr: any[]) => arr.reduce((s: number, p: any) => s + (p.total_revenue || 0), 0);

  // Patient flow from appointment
  const patientFlow = {
    totalAppointment: apptPatients,
    totalAppointmentRevenue: apptSet.reduce((s: number, p: any) => s + (p.total_revenue || 0), 0),
    crossToOther, crossToLab, crossToBoth, apptOnly,
    crossToOtherRevenue: sumRev(otherGroup),
    crossToLabRevenue: sumRev(labGroup),
    crossToBothRevenue: sumRev(bothGroup),
    apptOnlyRevenue: sumRev(apptOnlyGroup),
  };

  // Doctor cross-sell analysis
  const doctorRows = db.all(
    `SELECT billed_doctor, patient_id, department
     FROM clinic_actuals
     WHERE bill_month >= ? AND bill_month <= ?
       AND billed_doctor IS NOT NULL AND billed_doctor != '-' AND billed_doctor != ''${bf.where}
     GROUP BY billed_doctor, patient_id, department`,
    startMonth, endMonth, ...bf.params
  );

  // Build per-doctor patient sets
  const doctorPatients: Record<string, Set<string>> = {};
  for (const r of doctorRows as any[]) {
    if (r.department !== APPT) continue;
    if (!doctorPatients[r.billed_doctor]) doctorPatients[r.billed_doctor] = new Set();
    doctorPatients[r.billed_doctor].add(r.patient_id);
  }

  // For each doctor, find which of their appointment patients also got lab/other
  const patientDeptLookup = new Map(deptSets.map((p: any) => [p.patient_id, p.deptSet]));
  const doctorCrossSell = Object.entries(doctorPatients)
    .map(([doctor, pids]) => {
      const total = pids.size;
      let crossSold = 0;
      for (const pid of pids) {
        const depts = patientDeptLookup.get(pid);
        if (depts && (depts.has(LAB) || depts.has(OTHER))) crossSold++;
      }
      return { doctor, totalPatients: total, crossSold, apptOnly: total - crossSold, crossSellRate: total > 0 ? (crossSold / total) * 100 : 0 };
    })
    .filter(d => d.totalPatients >= 1)
    .sort((a, b) => b.totalPatients - a.totalPatients);

  // Patient table data (top 200 for initial load)
  const patientTable = patients
    .map((p: any) => ({
      patient_id: p.patient_id,
      patient_name: p.patient_name,
      departments: p.departments,
      total_billed: p.total_billed,
      total_paid: p.total_paid,
      total_discount: p.total_discount,
      visits: p.visits,
    }))
    .sort((a: any, b: any) => b.total_billed - a.total_billed);

  res.json({
    hasData: true,
    kpi: { totalUnique, apptPatients, labPatients, otherPatients, directLabWalkins, directOtherWalkins },
    departmentOverlap: { in1, in2, in3 },
    combinations,
    revenueByDeptCount: revByDeptCount,
    patientFlow,
    crossSellFunnel: { totalAppointment: apptPatients, crossToOther, crossToLab, crossToBoth, apptOnly },
    doctorCrossSell,
    patientTable,
  });
});

// ─── Pharmacy Analytics (OneGlance) ─────────────────────────────────────────

router.get('/pharmacy-analytics', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);

  const fy = fy_id
    ? db.get('SELECT * FROM financial_years WHERE id = ?', fy_id)
    : db.get('SELECT * FROM financial_years WHERE is_active = 1');
  if (!fy) return res.json({ hasData: false });

  const startMonth = fy.start_date.slice(0, 7);
  const endMonth = fy.end_date.slice(0, 7);

  // Check which pharmacy tables have data in this FY
  let hasSales = false, hasPurchases = false, hasStock = false;
  try {
    const c = db.get(`SELECT COUNT(*) as n FROM pharmacy_sales_actuals WHERE bill_month >= ? AND bill_month <= ?${bf.where}`, startMonth, endMonth, ...bf.params);
    hasSales = (c?.n || 0) > 0;
  } catch {}
  try {
    const c = db.get(`SELECT COUNT(*) as n FROM pharmacy_purchase_actuals WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}`, startMonth, endMonth, ...bf.params);
    hasPurchases = (c?.n || 0) > 0;
  } catch {}
  try {
    const c = db.get(`SELECT COUNT(*) as n FROM pharmacy_stock_actuals WHERE 1=1${bf.where}`, ...bf.params);
    hasStock = (c?.n || 0) > 0;
  } catch {}

  if (!hasSales && !hasPurchases && !hasStock) {
    return res.json({ hasData: false });
  }

  const result: any = { hasData: true, hasSales, hasPurchases, hasStock };

  // ── PURCHASES TAB ──────────────────────────────────────────────────────────
  if (hasPurchases) {
    const purchaseKpi = db.get(`
      SELECT
        COALESCE(SUM(purchase_value), 0) as totalPurchaseValue,
        COUNT(DISTINCT invoice_no) as totalInvoices,
        COUNT(DISTINCT stockiest_name) as uniqueStockists,
        COUNT(DISTINCT drug_name) as uniqueProducts,
        COALESCE(SUM(free_qty), 0) as totalFreeQty,
        COALESCE(SUM(tax_amount), 0) as totalTax,
        COALESCE(SUM(discount_amount), 0) as totalDiscount
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
    `, startMonth, endMonth, ...bf.params);

    const purchaseMonthly = db.all(`
      SELECT invoice_month as month,
        COALESCE(SUM(purchase_value), 0) as purchaseValue,
        COALESCE(SUM(net_purchase_value), 0) as netPurchase,
        COALESCE(SUM(tax_amount), 0) as tax,
        COUNT(DISTINCT invoice_no) as invoices
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
      GROUP BY invoice_month ORDER BY invoice_month
    `, startMonth, endMonth, ...bf.params);

    const topStockists = db.all(`
      SELECT stockiest_name as name,
        COALESCE(SUM(purchase_value), 0) as value,
        COUNT(DISTINCT invoice_no) as invoices,
        COUNT(DISTINCT drug_name) as products
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
        AND stockiest_name IS NOT NULL AND stockiest_name != ''
      GROUP BY stockiest_name ORDER BY value DESC LIMIT 10
    `, startMonth, endMonth, ...bf.params);

    const topManufacturers = db.all(`
      SELECT mfg_name as name,
        COALESCE(SUM(purchase_value), 0) as value,
        COUNT(DISTINCT drug_name) as products
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
        AND mfg_name IS NOT NULL AND mfg_name != ''
      GROUP BY mfg_name ORDER BY value DESC LIMIT 10
    `, startMonth, endMonth, ...bf.params);

    const topPurchaseProducts = db.all(`
      SELECT drug_name as name,
        COALESCE(SUM(purchase_value), 0) as value,
        COALESCE(SUM(purchase_qty), 0) as qty
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
      GROUP BY drug_name ORDER BY value DESC LIMIT 15
    `, startMonth, endMonth, ...bf.params);

    const profitMarginDist = db.all(`
      SELECT
        CASE
          WHEN profit_pct IS NULL THEN 'Unknown'
          WHEN profit_pct < 0 THEN 'Loss'
          WHEN profit_pct < 10 THEN '0-10%'
          WHEN profit_pct < 20 THEN '10-20%'
          WHEN profit_pct < 30 THEN '20-30%'
          WHEN profit_pct < 50 THEN '30-50%'
          ELSE '50%+'
        END as range,
        COUNT(*) as count,
        COALESCE(SUM(purchase_value), 0) as value
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
      GROUP BY range
    `, startMonth, endMonth, ...bf.params);

    const freeQtyAnalysis = db.all(`
      SELECT stockiest_name as name,
        COALESCE(SUM(free_qty), 0) as freeQty,
        COALESCE(SUM(batch_qty), 0) as batchQty,
        CASE WHEN SUM(batch_qty) > 0
          THEN ROUND(SUM(free_qty) * 100.0 / SUM(batch_qty), 1)
          ELSE 0 END as freePct
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
        AND free_qty > 0
      GROUP BY stockiest_name ORDER BY freeQty DESC LIMIT 10
    `, startMonth, endMonth, ...bf.params);

    const purchaseTable = db.all(`
      SELECT invoice_no, invoice_date, stockiest_name, mfg_name, drug_name,
        batch_no, batch_qty, free_qty, mrp, rate, discount_amount,
        purchase_value, net_purchase_value, tax_amount, profit_pct
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
      ORDER BY purchase_value DESC LIMIT 200
    `, startMonth, endMonth, ...bf.params);

    result.purchases = {
      kpi: purchaseKpi,
      monthlyTrend: purchaseMonthly,
      topStockists,
      topManufacturers,
      topProducts: topPurchaseProducts,
      profitMarginDist,
      freeQtyAnalysis,
      table: purchaseTable,
    };
  }

  // ── SALES TAB ──────────────────────────────────────────────────────────────
  if (hasSales) {
    const salesKpi = db.get(`
      SELECT
        COALESCE(SUM(sales_amount), 0) as totalSales,
        COALESCE(SUM(purchase_amount), 0) as totalCogs,
        COALESCE(SUM(profit), 0) as totalProfit,
        COUNT(DISTINCT bill_no) as totalBills,
        COUNT(DISTINCT CASE WHEN patient_id IS NOT NULL AND patient_id != '' THEN patient_id END) as uniquePatients,
        COUNT(DISTINCT drug_name) as uniqueDrugs,
        COALESCE(SUM(qty), 0) as totalQty,
        COALESCE(SUM(sales_tax), 0) as totalTax
      FROM pharmacy_sales_actuals
      WHERE bill_month >= ? AND bill_month <= ?${bf.where}
    `, startMonth, endMonth, ...bf.params);

    salesKpi.profitMargin = salesKpi.totalSales > 0
      ? Math.round(salesKpi.totalProfit * 100 / salesKpi.totalSales * 100) / 100
      : 0;

    const salesMonthly = db.all(`
      SELECT bill_month as month,
        COALESCE(SUM(sales_amount), 0) as sales,
        COALESCE(SUM(purchase_amount), 0) as cogs,
        COALESCE(SUM(profit), 0) as profit,
        COUNT(DISTINCT bill_no) as bills
      FROM pharmacy_sales_actuals
      WHERE bill_month >= ? AND bill_month <= ?${bf.where}
      GROUP BY bill_month ORDER BY bill_month
    `, startMonth, endMonth, ...bf.params);

    const topDrugsBySales = db.all(`
      SELECT drug_name as name,
        COALESCE(SUM(sales_amount), 0) as sales,
        COALESCE(SUM(qty), 0) as qty,
        COALESCE(SUM(profit), 0) as profit
      FROM pharmacy_sales_actuals
      WHERE bill_month >= ? AND bill_month <= ?${bf.where}
      GROUP BY drug_name ORDER BY sales DESC LIMIT 15
    `, startMonth, endMonth, ...bf.params);

    const topDrugsByProfit = db.all(`
      SELECT drug_name as name,
        COALESCE(SUM(profit), 0) as profit,
        COALESCE(SUM(sales_amount), 0) as sales,
        CASE WHEN SUM(sales_amount) > 0
          THEN ROUND(SUM(profit) * 100.0 / SUM(sales_amount), 2)
          ELSE 0 END as marginPct
      FROM pharmacy_sales_actuals
      WHERE bill_month >= ? AND bill_month <= ?${bf.where}
      GROUP BY drug_name HAVING SUM(sales_amount) > 0
      ORDER BY profit DESC LIMIT 15
    `, startMonth, endMonth, ...bf.params);

    const referralAnalysis = db.all(`
      SELECT COALESCE(NULLIF(referred_by, ''), 'Walk-in / Unknown') as name,
        COUNT(DISTINCT bill_no) as bills,
        COALESCE(SUM(sales_amount), 0) as sales,
        COUNT(DISTINCT CASE WHEN patient_id IS NOT NULL AND patient_id != '' THEN patient_id END) as patients
      FROM pharmacy_sales_actuals
      WHERE bill_month >= ? AND bill_month <= ?${bf.where}
      GROUP BY name ORDER BY sales DESC LIMIT 10
    `, startMonth, endMonth, ...bf.params);

    const topPatients = db.all(`
      SELECT patient_name, patient_id,
        COALESCE(SUM(sales_amount), 0) as totalSales,
        COUNT(DISTINCT bill_no) as visits,
        COUNT(DISTINCT drug_name) as drugs
      FROM pharmacy_sales_actuals
      WHERE bill_month >= ? AND bill_month <= ?${bf.where}
        AND patient_id IS NOT NULL AND patient_id != ''
      GROUP BY patient_id ORDER BY totalSales DESC LIMIT 20
    `, startMonth, endMonth, ...bf.params);

    const salesTable = db.all(`
      SELECT bill_no, bill_date, patient_name, drug_name, batch_no,
        qty, sales_amount, purchase_amount, profit, referred_by
      FROM pharmacy_sales_actuals
      WHERE bill_month >= ? AND bill_month <= ?${bf.where}
      ORDER BY sales_amount DESC LIMIT 200
    `, startMonth, endMonth, ...bf.params);

    result.sales = {
      kpi: salesKpi,
      monthlyTrend: salesMonthly,
      topDrugsBySales,
      topDrugsByProfit,
      referralAnalysis,
      topPatients,
      table: salesTable,
    };
  }

  // ── STOCK TAB ──────────────────────────────────────────────────────────────
  if (hasStock) {
    const latest = db.get(`SELECT MAX(snapshot_date) as date FROM pharmacy_stock_actuals WHERE 1=1${bf.where}`, ...bf.params);
    const snapshotDate = latest?.date;

    if (snapshotDate) {
      const stockKpi = db.get(`
        SELECT
          COALESCE(SUM(stock_value), 0) as totalStockValue,
          COUNT(DISTINCT drug_name) as totalSkus,
          COALESCE(SUM(avl_qty), 0) as totalQty,
          COUNT(*) as totalBatches
        FROM pharmacy_stock_actuals
        WHERE snapshot_date = ?${bf.where}
      `, snapshotDate, ...bf.params);

      const topStockProducts = db.all(`
        SELECT drug_name as name,
          COALESCE(SUM(stock_value), 0) as value,
          COALESCE(SUM(avl_qty), 0) as qty,
          COUNT(*) as batches
        FROM pharmacy_stock_actuals
        WHERE snapshot_date = ?${bf.where}
        GROUP BY drug_name ORDER BY value DESC LIMIT 15
      `, snapshotDate, ...bf.params);

      // Get all stock rows for expiry zone analysis (process in JS)
      const stockRows = db.all(`
        SELECT drug_name, batch_no, expiry_date, avl_qty, stock_value, received_date
        FROM pharmacy_stock_actuals
        WHERE snapshot_date = ?${bf.where}
      `, snapshotDate, ...bf.params);

      const now = new Date();
      const curMonth = now.getMonth();
      const curYear = now.getFullYear();

      const zones: Record<string, { batches: number; value: number; qty: number }> = {
        'Expired': { batches: 0, value: 0, qty: 0 },
        'Critical (0-3m)': { batches: 0, value: 0, qty: 0 },
        'Warning (3-6m)': { batches: 0, value: 0, qty: 0 },
        'Safe (6-12m)': { batches: 0, value: 0, qty: 0 },
        'Long Term (12m+)': { batches: 0, value: 0, qty: 0 },
        'Unknown': { batches: 0, value: 0, qty: 0 },
      };
      let nearExpiry = 0, expired = 0;

      for (const row of stockRows as any[]) {
        let zone = 'Unknown';
        const ed = row.expiry_date;
        if (ed && typeof ed === 'string') {
          const parts = ed.match(/(\d{1,2})[\/\-](\d{4})/);
          const partsAlt = ed.match(/(\d{4})[\/\-](\d{1,2})/);
          let expMonth = -1, expYear = -1;
          if (parts) { expMonth = parseInt(parts[1]) - 1; expYear = parseInt(parts[2]); }
          else if (partsAlt) { expYear = parseInt(partsAlt[1]); expMonth = parseInt(partsAlt[2]) - 1; }
          if (expMonth >= 0 && expYear > 0) {
            const diff = (expYear - curYear) * 12 + (expMonth - curMonth);
            if (diff < 0) { zone = 'Expired'; expired++; }
            else if (diff <= 3) { zone = 'Critical (0-3m)'; nearExpiry++; }
            else if (diff <= 6) { zone = 'Warning (3-6m)'; nearExpiry++; }
            else if (diff <= 12) { zone = 'Safe (6-12m)'; }
            else { zone = 'Long Term (12m+)'; }
          }
        }
        zones[zone].batches++;
        zones[zone].value += row.stock_value || 0;
        zones[zone].qty += row.avl_qty || 0;
      }

      const expiryZones = Object.entries(zones)
        .map(([name, data]) => ({ name, ...data }))
        .filter(z => z.batches > 0);

      stockKpi.nearExpiry = nearExpiry;
      stockKpi.expired = expired;
      stockKpi.snapshotDate = snapshotDate;

      const stockTable = db.all(`
        SELECT drug_name, batch_no, received_date, expiry_date, avl_qty, strips,
          purchase_price, purchase_value, stock_value
        FROM pharmacy_stock_actuals
        WHERE snapshot_date = ?${bf.where}
        ORDER BY stock_value DESC LIMIT 200
      `, snapshotDate, ...bf.params);

      result.stock = {
        kpi: stockKpi,
        topProducts: topStockProducts,
        expiryZones,
        table: stockTable,
      };
    }
  }

  // ── CROSS-REPORT INSIGHTS ─────────────────────────────────────────────────
  if (hasSales && hasPurchases) {
    const salesByProduct = db.all(`
      SELECT drug_name, COALESCE(SUM(sales_amount), 0) as sales,
        COALESCE(SUM(qty), 0) as salesQty
      FROM pharmacy_sales_actuals
      WHERE bill_month >= ? AND bill_month <= ?${bf.where}
      GROUP BY drug_name
    `, startMonth, endMonth, ...bf.params);

    const purchasesByProduct = db.all(`
      SELECT drug_name, COALESCE(SUM(purchase_value), 0) as purchases,
        COALESCE(SUM(purchase_qty), 0) as purchaseQty
      FROM pharmacy_purchase_actuals
      WHERE invoice_month >= ? AND invoice_month <= ?${bf.where}
      GROUP BY drug_name
    `, startMonth, endMonth, ...bf.params);

    // Merge products from both sources
    const productMap = new Map<string, any>();
    for (const p of purchasesByProduct as any[]) {
      productMap.set(p.drug_name, { name: p.drug_name, purchases: p.purchases, purchaseQty: p.purchaseQty, sales: 0, salesQty: 0 });
    }
    for (const s of salesByProduct as any[]) {
      const existing = productMap.get(s.drug_name);
      if (existing) { existing.sales = s.sales; existing.salesQty = s.salesQty; }
      else { productMap.set(s.drug_name, { name: s.drug_name, purchases: 0, purchaseQty: 0, sales: s.sales, salesQty: s.salesQty }); }
    }

    const allProducts = [...productMap.values()];
    const purchasedNotSold = allProducts.filter(p => p.purchases > 0 && p.sales === 0);
    const soldNotPurchased = allProducts.filter(p => p.sales > 0 && p.purchases === 0);
    const topCross = allProducts
      .filter(p => p.purchases > 0 && p.sales > 0)
      .map(p => ({ ...p, sellThrough: p.purchaseQty > 0 ? Math.round(p.salesQty / p.purchaseQty * 100) : 0 }))
      .sort((a, b) => (b.purchases + b.sales) - (a.purchases + a.sales))
      .slice(0, 15);

    const totalPurchaseVal = allProducts.reduce((s, p) => s + p.purchases, 0);
    const totalSalesVal = allProducts.reduce((s, p) => s + p.sales, 0);

    result.crossInsights = {
      kpi: {
        totalProducts: allProducts.length,
        purchasedNotSoldCount: purchasedNotSold.length,
        soldNotPurchasedCount: soldNotPurchased.length,
        sellThroughRate: totalPurchaseVal > 0 ? Math.round(totalSalesVal / totalPurchaseVal * 100) : 0,
        purchasedNotSoldValue: purchasedNotSold.reduce((s, p) => s + p.purchases, 0),
      },
      topCrossProducts: topCross,
      purchasedNotSold: purchasedNotSold.sort((a, b) => b.purchases - a.purchases).slice(0, 10),
      soldNotPurchased: soldNotPurchased.sort((a, b) => b.sales - a.sales).slice(0, 10),
    };
  }

  res.json(result);
});

router.get('/variance', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);
  const sf = streamFilter(req);
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  const fy = db.get('SELECT * FROM financial_years WHERE id = ?', fy_id);
  if (!fy) return res.json([]);

  const startMonth = fy.start_date.slice(0, 7);
  const endMonth = fy.end_date.slice(0, 7);

  // Build budget rows from forecast module (prefer stream-specific scenario)
  const scenario = db.get(
    `SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where}
     ORDER BY CASE WHEN stream_id IS NOT NULL THEN 0 ELSE 1 END, id LIMIT 1`,
    fy_id, ...bf.params
  );

  let budgetRows: any[] = [];

  if (scenario) {
    const revenueItems = db.all(
      "SELECT * FROM forecast_items WHERE scenario_id = ? AND category = 'revenue'",
      scenario.id
    );

    const months: string[] = [];
    const [startY, startM] = fy.start_date.split('-').map(Number);
    for (let i = 0; i < 12; i++) {
      const m = ((startM - 1 + i) % 12) + 1;
      const y = startY + Math.floor((startM - 1 + i) / 12);
      months.push(`${y}-${String(m).padStart(2, '0')}`);
    }

    for (const item of revenueItems) {
      const meta = typeof item.meta === 'string' ? JSON.parse(item.meta) : item.meta;
      const stepValues = meta?.stepValues || {};

      for (const month of months) {
        let budgetAmount = 0;
        if (item.item_type === 'unit_sales') {
          budgetAmount = (stepValues.units?.[month] || 0) * (stepValues.prices?.[month] || 0);
        } else if (item.item_type === 'recurring') {
          budgetAmount = stepValues.amount?.[month] || 0;
        } else {
          const amountKey = Object.keys(stepValues).find(k => stepValues[k]?.[month] !== undefined);
          budgetAmount = amountKey ? (stepValues[amountKey][month] || 0) : 0;
        }

        if (budgetAmount > 0) {
          budgetRows.push({ month, metric: 'revenue', amount: budgetAmount, item_name: item.name });
        }
      }
    }
  }

  // Fallback to old budgets table
  if (budgetRows.length === 0) {
    budgetRows = db.all(
      `SELECT b.*, d.name as dept_name FROM budgets b LEFT JOIN departments d ON b.department_id = d.id
       WHERE b.fy_id = ?${bf.where} ORDER BY b.month`,
      fy_id, ...bf.params
    );
  }

  // Get actuals from dashboard_actuals (generic)
  const actualsByMonth: Record<string, number> = {};
  if (scenario) {
    const actuals = db.all(
      `SELECT month, COALESCE(SUM(amount), 0) as total
       FROM dashboard_actuals
       WHERE scenario_id = ? AND category = 'revenue' AND month >= ? AND month <= ?${bf.where}${sf.where}
       GROUP BY month`,
      scenario.id, startMonth, endMonth, ...bf.params, ...sf.params
    );
    for (const a of actuals) actualsByMonth[a.month] = a.total;
  }

  const variance = budgetRows.map((b: any) => {
    const actualAmount = actualsByMonth[b.month] || 0;
    const varianceAmt = actualAmount - b.amount;
    const variancePct = b.amount !== 0 ? (varianceAmt / b.amount) * 100 : 0;
    const absVar = Math.abs(variancePct);
    let rag = 'GREEN';
    if (absVar > 15) rag = 'RED';
    else if (absVar > 5) rag = 'AMBER';

    return { ...b, actual_amount: actualAmount, variance_amount: varianceAmt, variance_pct: Math.round(variancePct * 100) / 100, rag };
  });

  res.json(variance);
});

// ── Operational Insights (COO decision dashboard) ──────────────────────
router.get('/operational-insights', async (req, res) => {
  const db = req.tenantDb!;
  const bf = branchFilter(req);

  const fy = db.get('SELECT * FROM financial_years WHERE is_active = 1');
  if (!fy) return res.json({ error: 'No active FY' });

  const platformDb = await getPlatformHelper();
  const clientStreams = platformDb.all(
    'SELECT id, name, icon, color FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order',
    req.clientId
  );

  // Date calculations
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysElapsed = dayOfMonth;
  const daysRemaining = daysInMonth - dayOfMonth;

  // Last month for trend comparison (same # of days elapsed)
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthCutoffDay = Math.min(dayOfMonth, new Date(lastMonthDate.getFullYear(), lastMonthDate.getMonth() + 1, 0).getDate());

  // Week boundaries (Monday-based)
  const todayDay = now.getDay(); // 0=Sun
  const mondayOffset = todayDay === 0 ? 6 : todayDay - 1;
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - mondayOffset);
  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);
  const lastMonday = new Date(lastSunday);
  lastMonday.setDate(lastSunday.getDate() - 6);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const thisMondayStr = fmt(thisMonday);
  const todayStr = fmt(now);
  const lastMondayStr = fmt(lastMonday);
  const lastSundayStr = fmt(lastSunday);

  // FY month range for forecast
  const startMonth = fy.start_date.slice(0, 7);
  const endMonth = fy.end_date.slice(0, 7);

  const streamsResult: any[] = [];
  let combinedMtdRevenue = 0;
  let combinedTargetRevenue = 0;
  const actions: any[] = [];

  for (const stream of clientStreams) {
    const nameLower = stream.name.toLowerCase();
    const isClinic = nameLower.includes('clinic') || nameLower.includes('health');
    const isPharmacy = nameLower.includes('pharma');

    // Rule 4: stream-specific scenario lookup
    const scenario = db.get(
      `SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1
       AND (stream_id = ? OR stream_id IS NULL)${bf.where}
       ORDER BY CASE WHEN stream_id = ? THEN 0 ELSE 1 END, id LIMIT 1`,
      fy.id, stream.id, ...bf.params, stream.id
    );

    // ── Forecast target for current month ──
    let monthlyTarget = 0;
    let unitTarget = 0;
    let targetItemName = '';
    // Per-category targets for clinic (Consultation / Diagnostics / Other Revenue)
    const catTargets: Record<string, { units: number; revenue: number }> = {
      'Consultation': { units: 0, revenue: 0 },
      'Diagnostics': { units: 0, revenue: 0 },
      'Other Revenue': { units: 0, revenue: 0 },
    };
    if (scenario) {
      const revenueItems = db.all(
        "SELECT * FROM forecast_items WHERE scenario_id = ? AND category = 'revenue'",
        scenario.id
      );
      for (const item of revenueItems) {
        const meta = typeof item.meta === 'string' ? JSON.parse(item.meta) : item.meta;
        const sv = meta?.stepValues || {};
        let amt = 0;
        let units = 0;
        if (item.item_type === 'unit_sales') {
          units = sv.units?.[currentMonth] || 0;
          const prices = sv.prices?.[currentMonth] || 0;
          amt = units * prices;
          unitTarget += units;
        } else if (item.item_type === 'recurring') {
          amt = sv.amount?.[currentMonth] || 0;
        } else {
          const key = Object.keys(sv).find(k => sv[k]?.[currentMonth] !== undefined);
          amt = key ? (sv[key][currentMonth] || 0) : 0;
        }
        monthlyTarget += amt;
        if (!targetItemName && amt > 0) targetItemName = item.name;

        // Map forecast item to clinic category by name
        if (isClinic) {
          const n = (item.name || '').toLowerCase();
          let cat = 'Other Revenue';
          if (n.includes('consult') || n.includes('appointment') || n.includes('opd')) cat = 'Consultation';
          else if (n.includes('lab') || n.includes('diagnostic') || n.includes('test')) cat = 'Diagnostics';
          catTargets[cat].revenue += amt;
          catTargets[cat].units += units;
        }
      }
    }

    // ── MTD Actuals ──
    let mtdPatients = 0, mtdRevenue = 0, mtdTransactions = 0, mtdProfit = 0, mtdCogs = 0;

    // Per-category breakdown for clinic KPI cards
    let clinicCatBreakdown: { label: string; patients: number; revenue: number; lastRevenue: number; lastPatients: number }[] = [];

    if (isClinic) {
      const r = db.get(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(patient_id, ''), patient_name)) as patients, COALESCE(SUM(item_price), 0) as revenue, COUNT(*) as txns
         FROM clinic_actuals WHERE bill_month = ?${bf.where}`,
        currentMonth, ...bf.params
      );
      mtdPatients = r?.patients || 0;
      mtdRevenue = r?.revenue || 0;
      mtdTransactions = r?.txns || 0;

      // Category breakdown: Consultation / Diagnostics / Other
      const catDefs = [
        { label: 'Consultation', where: "AND department = 'APPOINTMENT'" },
        { label: 'Diagnostics', where: "AND department = 'LAB TEST'" },
        { label: 'Other Revenue', where: "AND (department NOT IN ('APPOINTMENT', 'LAB TEST') OR department IS NULL)" },
      ];
      for (const cat of catDefs) {
        const cr = db.get(
          `SELECT COUNT(DISTINCT COALESCE(NULLIF(patient_id, ''), patient_name)) as patients, COALESCE(SUM(item_price), 0) as revenue
           FROM clinic_actuals WHERE bill_month = ? ${cat.where}${bf.where}`,
          currentMonth, ...bf.params
        );
        const lr = db.get(
          `SELECT COALESCE(SUM(item_price), 0) as revenue, COUNT(DISTINCT COALESCE(NULLIF(patient_id, ''), patient_name)) as patients
           FROM clinic_actuals WHERE bill_month = ? AND CAST(SUBSTR(bill_date, 9, 2) AS INTEGER) <= ? ${cat.where}${bf.where}`,
          lastMonth, lastMonthCutoffDay, ...bf.params
        );
        clinicCatBreakdown.push({
          label: cat.label, patients: cr?.patients || 0, revenue: cr?.revenue || 0,
          lastRevenue: lr?.revenue || 0, lastPatients: lr?.patients || 0,
        });
      }
    } else if (isPharmacy) {
      const r = db.get(
        `SELECT COUNT(DISTINCT bill_no) as txns, COALESCE(SUM(sales_amount), 0) as revenue,
                COALESCE(SUM(profit), 0) as profit, COALESCE(SUM(purchase_amount), 0) as cogs
         FROM pharmacy_sales_actuals WHERE bill_month = ?${bf.where}`,
        currentMonth, ...bf.params
      );
      mtdRevenue = r?.revenue || 0;
      mtdTransactions = r?.txns || 0;
      mtdProfit = r?.profit || 0;
      mtdCogs = r?.cogs || 0;
    }

    // ── Last month same-period (for trend) ──
    let lastMonthMtdRevenue = 0, lastMonthMtdPatients = 0;
    if (isClinic) {
      const r = db.get(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(patient_id, ''), patient_name)) as patients, COALESCE(SUM(item_price), 0) as revenue
         FROM clinic_actuals WHERE bill_month = ? AND CAST(SUBSTR(bill_date, 9, 2) AS INTEGER) <= ?${bf.where}`,
        lastMonth, lastMonthCutoffDay, ...bf.params
      );
      lastMonthMtdRevenue = r?.revenue || 0;
      lastMonthMtdPatients = r?.patients || 0;
    } else if (isPharmacy) {
      const r = db.get(
        `SELECT COALESCE(SUM(sales_amount), 0) as revenue
         FROM pharmacy_sales_actuals WHERE bill_month = ? AND CAST(SUBSTR(bill_date, 9, 2) AS INTEGER) <= ?${bf.where}`,
        lastMonth, lastMonthCutoffDay, ...bf.params
      );
      lastMonthMtdRevenue = r?.revenue || 0;
    }

    // ── Weekly data ──
    let thisWeek: any = { patients: 0, revenue: 0, transactions: 0, profit: 0, avgTicket: 0 };
    let lastWeek: any = { patients: 0, revenue: 0, transactions: 0, profit: 0, avgTicket: 0 };

    if (isClinic) {
      const tw = db.get(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(patient_id, ''), patient_name)) as patients, COALESCE(SUM(item_price), 0) as revenue, COUNT(*) as txns
         FROM clinic_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
        thisMondayStr, todayStr, ...bf.params
      );
      thisWeek = { patients: tw?.patients || 0, revenue: tw?.revenue || 0, transactions: tw?.txns || 0, profit: 0, avgTicket: (tw?.patients || 0) > 0 ? Math.round((tw?.revenue || 0) / tw.patients) : 0 };

      const lw = db.get(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(patient_id, ''), patient_name)) as patients, COALESCE(SUM(item_price), 0) as revenue, COUNT(*) as txns
         FROM clinic_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
        lastMondayStr, lastSundayStr, ...bf.params
      );
      lastWeek = { patients: lw?.patients || 0, revenue: lw?.revenue || 0, transactions: lw?.txns || 0, profit: 0, avgTicket: (lw?.patients || 0) > 0 ? Math.round((lw?.revenue || 0) / lw.patients) : 0 };
    } else if (isPharmacy) {
      const tw = db.get(
        `SELECT COUNT(DISTINCT bill_no) as txns, COALESCE(SUM(sales_amount), 0) as revenue, COALESCE(SUM(profit), 0) as profit
         FROM pharmacy_sales_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
        thisMondayStr, todayStr, ...bf.params
      );
      thisWeek = { patients: 0, revenue: tw?.revenue || 0, transactions: tw?.txns || 0, profit: tw?.profit || 0, avgTicket: (tw?.txns || 0) > 0 ? Math.round((tw?.revenue || 0) / tw.txns) : 0 };

      const lw = db.get(
        `SELECT COUNT(DISTINCT bill_no) as txns, COALESCE(SUM(sales_amount), 0) as revenue, COALESCE(SUM(profit), 0) as profit
         FROM pharmacy_sales_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where}`,
        lastMondayStr, lastSundayStr, ...bf.params
      );
      lastWeek = { patients: 0, revenue: lw?.revenue || 0, transactions: lw?.txns || 0, profit: lw?.profit || 0, avgTicket: (lw?.txns || 0) > 0 ? Math.round((lw?.revenue || 0) / lw.txns) : 0 };
    }

    // ── Daily breakdown for chart ──
    let daily: any[] = [];
    if (isClinic) {
      daily = db.all(
        `SELECT bill_date as date, COUNT(DISTINCT COALESCE(NULLIF(patient_id, ''), patient_name)) as patients, COALESCE(SUM(item_price), 0) as revenue
         FROM clinic_actuals WHERE bill_month = ?${bf.where} GROUP BY bill_date ORDER BY bill_date`,
        currentMonth, ...bf.params
      );
    } else if (isPharmacy) {
      daily = db.all(
        `SELECT bill_date as date, COUNT(DISTINCT bill_no) as transactions, COALESCE(SUM(sales_amount), 0) as revenue, COALESCE(SUM(profit), 0) as profit
         FROM pharmacy_sales_actuals WHERE bill_month = ?${bf.where} GROUP BY bill_date ORDER BY bill_date`,
        currentMonth, ...bf.params
      );
    }

    // ── Pace calculations ──
    const dailyRate = daysElapsed > 0 ? mtdRevenue / daysElapsed : 0;
    const projected = dailyRate * daysInMonth;
    const requiredRate = daysRemaining > 0 ? (monthlyTarget - mtdRevenue) / daysRemaining : 0;
    const pctOfTarget = monthlyTarget > 0 ? (projected / monthlyTarget) * 100 : 0;
    const rag = monthlyTarget === 0 ? 'GREY' : pctOfTarget >= 95 ? 'GREEN' : pctOfTarget >= 80 ? 'AMBER' : 'RED';

    // Build cards
    const cards: any[] = [];
    if (isClinic) {
      // Build 2 cards per category: Patients + Revenue (with targets from catTargets)
      for (const cat of clinicCatBreakdown) {
        const ct = catTargets[cat.label] || { units: 0, revenue: 0 };

        // Card 1: Patients
        const patDaily = daysElapsed > 0 ? cat.patients / daysElapsed : 0;
        const patProj = Math.round(patDaily * daysInMonth);
        const patNeed = ct.units > 0 && daysRemaining > 0 ? Math.round((ct.units - cat.patients) / daysRemaining) : 0;
        const patPct = ct.units > 0 ? (patProj / ct.units) * 100 : 0;
        const patRag = ct.units === 0 ? 'GREY' : patPct >= 95 ? 'GREEN' : patPct >= 80 ? 'AMBER' : 'RED';
        cards.push({
          label: 'Patients', mtd: cat.patients, target: ct.units, projected: patProj,
          dailyRate: Math.round(patDaily), requiredRate: patNeed,
          rag: patRag, lastMonthMtd: cat.lastPatients, unit: 'count', category: cat.label,
        });

        // Card 2: Revenue
        const revDaily = daysElapsed > 0 ? cat.revenue / daysElapsed : 0;
        const revProj = Math.round(revDaily * daysInMonth);
        const revNeed = ct.revenue > 0 && daysRemaining > 0 ? Math.round((ct.revenue - cat.revenue) / daysRemaining) : 0;
        const revPct = ct.revenue > 0 ? (revProj / ct.revenue) * 100 : 0;
        const revRag = ct.revenue === 0 ? 'GREY' : revPct >= 95 ? 'GREEN' : revPct >= 80 ? 'AMBER' : 'RED';
        cards.push({
          label: 'Revenue', mtd: cat.revenue, target: ct.revenue, projected: revProj,
          dailyRate: Math.round(revDaily), requiredRate: revNeed,
          rag: revRag, lastMonthMtd: cat.lastRevenue, unit: 'currency', category: cat.label,
        });
      }
    } else if (isPharmacy) {
      cards.push({
        label: 'Sales', mtd: mtdRevenue, target: monthlyTarget, projected: Math.round(projected),
        dailyRate: Math.round(dailyRate), requiredRate: Math.round(requiredRate),
        rag, lastMonthMtd: lastMonthMtdRevenue, unit: 'currency',
      });
      cards.push({
        label: 'Profit', mtd: mtdProfit, target: 0, projected: daysElapsed > 0 ? Math.round((mtdProfit / daysElapsed) * daysInMonth) : 0,
        dailyRate: daysElapsed > 0 ? Math.round(mtdProfit / daysElapsed) : 0, requiredRate: 0,
        rag: 'GREY', lastMonthMtd: 0, unit: 'currency',
      });
      if (mtdRevenue > 0) {
        cards.push({
          label: 'Margin', mtd: Math.round((mtdProfit / mtdRevenue) * 10000) / 100, target: 0, projected: 0,
          dailyRate: 0, requiredRate: 0, rag: 'GREY', lastMonthMtd: 0, unit: 'percent',
        });
      }
    }

    combinedMtdRevenue += mtdRevenue;
    combinedTargetRevenue += monthlyTarget;

    // ── Action items ──
    if (rag === 'RED' && monthlyTarget > 0) {
      const gap = monthlyTarget - mtdRevenue;
      actions.push({ severity: 'RED', stream: stream.name, message: `${stream.name} revenue is ${Math.round(pctOfTarget)}% of target. Need ₹${Math.round(requiredRate).toLocaleString('en-IN')}/day to recover (gap: ₹${Math.round(gap).toLocaleString('en-IN')})` });
    }
    if (lastWeek.revenue > 0 && thisWeek.revenue > 0) {
      const wowChange = ((thisWeek.revenue - lastWeek.revenue) / lastWeek.revenue) * 100;
      if (wowChange < -15) {
        actions.push({ severity: 'AMBER', stream: stream.name, message: `${stream.name} revenue dropped ${Math.abs(Math.round(wowChange))}% vs last week` });
      }
    }

    // Check departments with zero activity (clinic only)
    if (isClinic) {
      const activeDepts = db.all(
        `SELECT DISTINCT department FROM clinic_actuals WHERE bill_date >= ? AND bill_date <= ?${bf.where} AND department IS NOT NULL AND department != ''`,
        thisMondayStr, todayStr, ...bf.params
      );
      const allDepts = db.all(
        `SELECT DISTINCT department FROM clinic_actuals WHERE bill_month = ?${bf.where} AND department IS NOT NULL AND department != ''`,
        lastMonth, ...bf.params
      );
      const activeSet = new Set(activeDepts.map((d: any) => d.department));
      for (const dept of allDepts) {
        if (!activeSet.has(dept.department)) {
          actions.push({ severity: 'INFO', stream: stream.name, message: `${dept.department}: no patients this week` });
        }
      }
    }

    streamsResult.push({
      name: stream.name, streamId: stream.id, icon: stream.icon, color: stream.color,
      cards, thisWeek, lastWeek, daily,
    });
  }

  // Combined
  const combinedProjected = daysElapsed > 0 ? (combinedMtdRevenue / daysElapsed) * daysInMonth : 0;
  const combinedPct = combinedTargetRevenue > 0 ? (combinedProjected / combinedTargetRevenue) * 100 : 0;
  const combinedRag = combinedTargetRevenue === 0 ? 'GREY' : combinedPct >= 95 ? 'GREEN' : combinedPct >= 80 ? 'AMBER' : 'RED';

  res.json({
    month: currentMonth,
    monthLabel: now.toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
    daysElapsed, daysInMonth, daysRemaining,
    streams: streamsResult,
    combined: {
      mtdRevenue: combinedMtdRevenue,
      targetRevenue: combinedTargetRevenue,
      projectedRevenue: Math.round(combinedProjected),
      rag: combinedRag,
    },
    actions,
  });
});

export default router;
