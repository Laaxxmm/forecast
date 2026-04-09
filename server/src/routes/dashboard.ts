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

  res.json({
    fy, streams, cards,
    combined: { total_revenue: totalRevenue, total_budget: totalBudget },
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
