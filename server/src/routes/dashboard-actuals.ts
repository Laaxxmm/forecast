import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { branchFilter, getBranchIdForInsert, streamFilter, getStreamIdForInsert } from '../utils/branch.js';
import { getPlatformHelper } from '../db/platform-connection.js';
import { requireInt, requireString, requireNumber, requireMonth, optionalString, ValidationError } from '../middleware/validate.js';

const router = Router();

// GET /api/dashboard-actuals?scenario_id=1&month=2026-04
// Returns all actuals for a scenario, optionally filtered by month
router.get('/', async (req, res) => {
  const db = req.tenantDb!;
  const bf = branchFilter(req);
  const sf = streamFilter(req);
  if (!req.query.scenario_id) return res.status(400).json({ error: 'scenario_id required' });
  const scenario_id = requireInt(req.query.scenario_id, 'scenario_id');
  const month = optionalString(req.query.month as string | undefined, 'month', 7);
  const category = optionalString(req.query.category as string | undefined, 'category', 100);

  let sql = 'SELECT * FROM dashboard_actuals WHERE scenario_id = ?';
  const params: any[] = [scenario_id];

  if (month) { sql += ' AND month = ?'; params.push(month); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += bf.where;
  params.push(...bf.params);
  sql += sf.where;
  params.push(...sf.params);

  sql += ' ORDER BY category, item_name, month';
  const rows = db.all(sql, ...params);
  res.json(rows);
});

// POST /api/dashboard-actuals/bulk
// Bulk upsert actuals: { scenario_id, entries: [{ category, item_name, linked_item_id?, month, amount }] }
// Scoped by the caller's current branch so manual entries for one branch don't
// overwrite another branch's row with the same (scenario, category, item, month).
router.post('/bulk', requireRole('admin', 'operational_head'), async (req, res) => {
  const db = req.tenantDb!;
  const { entries } = req.body;
  if (!req.body.scenario_id || !entries) return res.status(400).json({ error: 'scenario_id and entries required' });
  const scenario_id = requireInt(req.body.scenario_id, 'scenario_id');

  // Validate each entry before touching the database
  if (!Array.isArray(entries)) throw new ValidationError('entries must be an array');
  for (let i = 0; i < entries.length; i++) {
    requireString(entries[i].category, `entries[${i}].category`, 100);
    requireString(entries[i].item_name, `entries[${i}].item_name`, 200);
    requireMonth(entries[i].month, `entries[${i}].month`);
    requireNumber(entries[i].amount ?? 0, `entries[${i}].amount`);
  }

  const branchId = getBranchIdForInsert(req);
  const streamId = getStreamIdForInsert(req);

  db.beginBatch();
  try {
    for (const entry of entries) {
      db.run(
        `INSERT INTO dashboard_actuals (scenario_id, category, item_name, linked_item_id, month, amount, branch_id, stream_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
         DO UPDATE SET amount = excluded.amount, linked_item_id = excluded.linked_item_id, updated_at = datetime('now')`,
        scenario_id, entry.category, entry.item_name, entry.linked_item_id || null, entry.month, entry.amount || 0, branchId, streamId
      );
    }
    db.endBatch();
  } catch (e) { db.rollbackBatch(); throw e; }

  res.json({ success: true, count: entries.length });
});

// GET /api/dashboard-actuals/summary?scenario_id=1 or ?fy_id=1 (consolidated)
// Returns monthly category totals for actuals
router.get('/summary', async (req, res) => {
  const db = req.tenantDb!;
  const bf = branchFilter(req);

  if (req.query.fy_id && !req.query.scenario_id) {
    const fy_id = requireInt(req.query.fy_id, 'fy_id');
    // Consolidated mode: sum actuals across all scenarios for this FY
    const scenarios = db.all(
      `SELECT id FROM scenarios WHERE fy_id = ?${bf.where}`,
      fy_id, ...bf.params
    );
    if (scenarios.length === 0) return res.json([]);
    const ids = scenarios.map((s: any) => s.id);
    const ph = ids.map(() => '?').join(',');
    const rows = db.all(
      `SELECT category, month, SUM(amount) as total
       FROM dashboard_actuals
       WHERE scenario_id IN (${ph})
       GROUP BY category, month
       ORDER BY category, month`,
      ...ids
    );
    return res.json(rows);
  }

  if (!req.query.scenario_id) return res.status(400).json({ error: 'scenario_id required' });
  const scenario_id = requireInt(req.query.scenario_id, 'scenario_id');
  const sf = streamFilter(req);

  const rows = db.all(
    `SELECT category, month, SUM(amount) as total
     FROM dashboard_actuals
     WHERE scenario_id = ?${bf.where}${sf.where}
     GROUP BY category, month
     ORDER BY category, month`,
    scenario_id, ...bf.params, ...sf.params
  );
  res.json(rows);
});

// POST /api/dashboard-actuals/sync-from-imports
// Auto-populate revenue actuals from integration-specific tables
// into dashboard_actuals for the given scenario.
// Uses stream names from business_streams config instead of hardcoded values.
router.post('/sync-from-imports', async (req, res) => {
  try {
    const db = req.tenantDb!;
    if (!req.body.scenario_id) return res.status(400).json({ error: 'scenario_id required' });
    const scenario_id = requireInt(req.body.scenario_id, 'scenario_id');

    const bf = branchFilter(req);
    const branchId = getBranchIdForInsert(req);
    const streamId = getStreamIdForInsert(req);
    let count = 0;

    // Get stream names from platform config to use as item_name labels
    const platformDb = await getPlatformHelper();
    const streams = platformDb.all(
      'SELECT id, name FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order',
      req.clientId
    );

    // Map integration tables to stream names (first stream = clinic-like, second = pharmacy-like)
    // This is a convention: integrations tag their data with the stream they belong to
    const clinicStreamName = streams.find((s: any) => s.id === streamId)?.name
      || streams[0]?.name || 'Revenue';
    const pharmacyStreamName = streams.length > 1 ? streams[1].name : streams[0]?.name || 'Revenue';

    // Aggregate clinic-type data by month (from clinic_actuals if it exists)
    try {
      const clinicMonthly = db.all(
        `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
         FROM clinic_actuals
         WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where}
         GROUP BY bill_month ORDER BY bill_month`,
        ...bf.params
      );
      for (const row of clinicMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
          scenario_id, `${clinicStreamName} Revenue`, row.month, row.total, branchId, streams[0]?.id || streamId
        );
        count++;
      }
    } catch { /* clinic_actuals table may not exist */ }

    // Aggregate pharmacy-type data by month (from pharmacy_sales_actuals if it exists)
    try {
      const pharmacyMonthly = db.all(
        `SELECT bill_month as month, COALESCE(SUM(sales_amount), 0) as revenue, COALESCE(SUM(purchase_amount), 0) as cogs
         FROM pharmacy_sales_actuals
         WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where}
         GROUP BY bill_month ORDER BY bill_month`,
        ...bf.params
      );
      for (const row of pharmacyMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
          scenario_id, `${pharmacyStreamName} Revenue`, row.month, row.revenue, branchId, streams[1]?.id || streamId
        );
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'direct_costs', ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
          scenario_id, `${pharmacyStreamName} COGS`, row.month, row.cogs, branchId, streams[1]?.id || streamId
        );
        count += 2;
      }
    } catch { /* pharmacy tables may not exist */ }

    res.json({ success: true, count });
  } catch (err: any) {
    console.error('sync-from-imports error:', err);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({ error: isProd ? 'Sync failed' : err.message });
  }
});

export default router;
