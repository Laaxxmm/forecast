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

  const scenario = db.get(
    `SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where} LIMIT 1`,
    fy.id, ...bf.params
  );

  // Build per-stream revenue data (used by both cards and charts)
  const streams: any[] = [];
  let totalRevenue = 0;
  let totalBudget = 0;
  const streamDataMap: Record<number, any> = {};

  for (const stream of clientStreams) {
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
  if (scenario) {
    const untagged = db.get(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM dashboard_actuals
       WHERE scenario_id = ? AND category = 'revenue' AND month >= ? AND month <= ?${bf.where}
       AND stream_id IS NULL`,
      scenario.id, startMonth, endMonth, ...bf.params
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
    } else if (card.card_type === 'custom' && scenario) {
      const catData = db.get(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM dashboard_actuals
         WHERE scenario_id = ? AND category = ? AND month >= ? AND month <= ?${bf.where}`,
        scenario.id, card.category, startMonth, endMonth, ...bf.params
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
  const crossToOther = apptSet.filter((p: any) => p.deptSet.has(OTHER) && !p.deptSet.has(LAB)).length;
  const crossToLab = apptSet.filter((p: any) => p.deptSet.has(LAB) && !p.deptSet.has(OTHER)).length;
  const crossToBoth = apptSet.filter((p: any) => p.deptSet.has(LAB) && p.deptSet.has(OTHER)).length;
  const apptOnly = apptSet.filter((p: any) => p.dept_count === 1).length;

  // Patient flow from appointment
  const patientFlow = {
    totalAppointment: apptPatients,
    crossToOther, crossToLab, crossToBoth, apptOnly,
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
    .sort((a, b) => b.crossSellRate - a.crossSellRate);

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

  // Build budget rows from forecast module
  const scenario = db.get(
    `SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where}${sf.where} LIMIT 1`,
    fy_id, ...bf.params, ...sf.params
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

export default router;
