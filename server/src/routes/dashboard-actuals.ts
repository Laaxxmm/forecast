import { Router } from 'express';

const router = Router();

// GET /api/dashboard-actuals?scenario_id=1&month=2026-04
// Returns all actuals for a scenario, optionally filtered by month
router.get('/', async (req, res) => {
  const db = req.tenantDb!;
  const { scenario_id, month, category } = req.query;
  if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });

  let sql = 'SELECT * FROM dashboard_actuals WHERE scenario_id = ?';
  const params: any[] = [scenario_id];

  if (month) { sql += ' AND month = ?'; params.push(month); }
  if (category) { sql += ' AND category = ?'; params.push(category); }

  sql += ' ORDER BY category, item_name, month';
  const rows = db.all(sql, ...params);
  res.json(rows);
});

// POST /api/dashboard-actuals/bulk
// Bulk upsert actuals: { scenario_id, entries: [{ category, item_name, linked_item_id?, month, amount }] }
router.post('/bulk', async (req, res) => {
  const db = req.tenantDb!;
  const { scenario_id, entries } = req.body;
  if (!scenario_id || !entries) return res.status(400).json({ error: 'scenario_id and entries required' });

  for (const entry of entries) {
    db.run(
      `INSERT INTO dashboard_actuals (scenario_id, category, item_name, linked_item_id, month, amount, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(scenario_id, category, item_name, month)
       DO UPDATE SET amount = excluded.amount, linked_item_id = excluded.linked_item_id, updated_at = datetime('now')`,
      scenario_id, entry.category, entry.item_name, entry.linked_item_id || null, entry.month, entry.amount || 0
    );
  }
  res.json({ success: true, count: entries.length });
});

// GET /api/dashboard-actuals/summary?scenario_id=1
// Returns monthly category totals for actuals
router.get('/summary', async (req, res) => {
  const db = req.tenantDb!;
  const { scenario_id } = req.query;
  if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });

  const rows = db.all(
    `SELECT category, month, SUM(amount) as total
     FROM dashboard_actuals
     WHERE scenario_id = ?
     GROUP BY category, month
     ORDER BY category, month`,
    scenario_id
  );
  res.json(rows);
});

// POST /api/dashboard-actuals/sync-from-imports
// Auto-populate revenue actuals from clinic_actuals + pharmacy_sales_actuals
// into dashboard_actuals for the given scenario
router.post('/sync-from-imports', async (req, res) => {
  try {
    const db = req.tenantDb!;
    const { scenario_id } = req.body;
    if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });

    let count = 0;

    // Aggregate clinic revenue by month (sum of item_price)
    const clinicMonthly = db.all(
      `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
       FROM clinic_actuals
       WHERE bill_month IS NOT NULL AND bill_month != ''
       GROUP BY bill_month
       ORDER BY bill_month`
    );

    for (const row of clinicMonthly) {
      if (!row.month) continue;
      db.run(
        `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, updated_at)
         VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, datetime('now'))
         ON CONFLICT(scenario_id, category, item_name, month)
         DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
        scenario_id, row.month, row.total
      );
      count++;
    }

    // Aggregate pharmacy revenue + COGS by month
    try {
      const pharmacyMonthly = db.all(
        `SELECT bill_month as month, COALESCE(SUM(sales_amount), 0) as revenue, COALESCE(SUM(purchase_amount), 0) as cogs
         FROM pharmacy_sales_actuals
         WHERE bill_month IS NOT NULL AND bill_month != ''
         GROUP BY bill_month
         ORDER BY bill_month`
      );
      for (const row of pharmacyMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, updated_at)
           VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
          scenario_id, row.month, row.revenue
        );
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, updated_at)
           VALUES (?, 'direct_costs', 'Pharmacy COGS', ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
          scenario_id, row.month, row.cogs
        );
        count += 2;
      }
    } catch { /* pharmacy tables may not have data yet */ }

    res.json({ success: true, count });
  } catch (err: any) {
    console.error('sync-from-imports error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
