import { Router, Request, Response, NextFunction } from 'express';
import { branchFilter, getBranchIdForInsert, streamFilter, getStreamIdForInsert } from '../utils/branch.js';

const router = Router();

// Write-protection: only admin/super_admin can modify forecast data
function requireWriteAccess(req: Request, res: Response, next: NextFunction) {
  if (req.userType === 'super_admin' || req.session?.role === 'admin') return next();
  return res.status(403).json({ error: 'Write access requires admin role' });
}

// === CONSOLIDATED VIEW (All Streams) ===
router.get('/consolidated', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  // Find ALL scenarios for this FY + branch.
  // Includes both per-stream (stream_id set) and company-level (stream_id NULL)
  // scenarios so that admin-created forecasts are visible in the "All" view.
  const scenarios = db.all(
    `SELECT * FROM scenarios WHERE fy_id = ?${bf.where} ORDER BY stream_id IS NULL, id`,
    fy_id, ...bf.params
  );

  if (scenarios.length === 0) {
    return res.json({ items: [], values: {}, settings: {}, scenarioCount: 0 });
  }

  const scenarioIds = scenarios.map((s: any) => s.id);
  const placeholders = scenarioIds.map(() => '?').join(',');

  // Get all items from all stream scenarios
  const items = db.all(
    `SELECT * FROM forecast_items WHERE scenario_id IN (${placeholders}) ORDER BY category, sort_order, id`,
    ...scenarioIds
  ).map((item: any) => ({ ...item, meta: item.meta ? JSON.parse(item.meta) : {} }));

  // Get all values
  const rawValues = db.all(
    `SELECT fv.* FROM forecast_values fv
     JOIN forecast_items fi ON fv.item_id = fi.id
     WHERE fi.scenario_id IN (${placeholders})`,
    ...scenarioIds
  );

  // Build values lookup: { item_id: { month: amount } }
  const values: Record<number, Record<string, number>> = {};
  for (const v of rawValues) {
    if (!values[v.item_id]) values[v.item_id] = {};
    values[v.item_id][v.month] = v.amount;
  }

  // Merge settings from first scenario
  const settingsObj: Record<string, any> = {};
  const rawSettings = db.all('SELECT * FROM forecast_settings WHERE scenario_id = ?', scenarios[0].id);
  for (const s of rawSettings) {
    try { settingsObj[s.setting_key] = JSON.parse(s.setting_value); } catch { settingsObj[s.setting_key] = s.setting_value; }
  }

  res.json({ items, values, settings: settingsObj, scenarioCount: scenarios.length });
});

// === SCENARIOS ===
router.get('/scenarios', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.query;
  const bf = branchFilter(req);
  const sf = streamFilter(req);
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });
  res.json(db.all(`SELECT * FROM scenarios WHERE fy_id = ?${bf.where}${sf.where} ORDER BY is_default DESC, name`, fy_id, ...bf.params, ...sf.params));
});

router.post('/scenarios', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, name } = req.body;
  const bf = branchFilter(req);
  const sf = streamFilter(req);
  const branchId = getBranchIdForInsert(req);
  const streamId = getStreamIdForInsert(req);
  if (!fy_id || !name) return res.status(400).json({ error: 'fy_id and name required' });
  const existing = db.all(`SELECT id FROM scenarios WHERE fy_id = ?${bf.where}${sf.where}`, fy_id, ...bf.params, ...sf.params);
  const isDefault = existing.length === 0 ? 1 : 0;
  db.run('INSERT INTO scenarios (fy_id, name, is_default, branch_id, stream_id) VALUES (?, ?, ?, ?, ?)', fy_id, name, isDefault, branchId, streamId);
  const created = db.get('SELECT * FROM scenarios WHERE fy_id = ? AND name = ? ORDER BY id DESC LIMIT 1', fy_id, name);
  res.json(created);
});

router.post('/scenarios/ensure', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id } = req.body;
  const bf = branchFilter(req);
  const sf = streamFilter(req);
  const branchId = getBranchIdForInsert(req);
  const streamId = getStreamIdForInsert(req);
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  // Don't create scenarios for "all" stream mode — use /consolidated instead
  if (req.streamMode === 'all' || req.streamMode === 'none') {
    // Prefer NULL-branch (company-level, admin-created) scenarios so branch
    // users see the populated data instead of an auto-created empty stub.
    const scenario = db.get(
      `SELECT * FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where} ORDER BY branch_id IS NOT NULL, id`,
      fy_id, ...bf.params
    );
    return res.json(scenario || null);
  }

  // Find a matching scenario, preferring ones that actually have forecast items.
  // An empty orphan stub (branch_id=NULL, stream_id=X) can otherwise sort before
  // the admin's populated scenario (branch_id=Y, stream_id=NULL) when ordering by
  // NULLs first, causing the stream-specific view to appear empty.
  let scenario = db.get(
    `SELECT * FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where}${sf.where}
       AND EXISTS (SELECT 1 FROM forecast_items WHERE scenario_id = scenarios.id)
     ORDER BY branch_id IS NOT NULL, stream_id IS NOT NULL, id`,
    fy_id, ...bf.params, ...sf.params
  );
  // Fallback: any matching default scenario (even empty)
  if (!scenario) {
    scenario = db.get(
      `SELECT * FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where}${sf.where} ORDER BY branch_id IS NOT NULL, stream_id IS NOT NULL, id`,
      fy_id, ...bf.params, ...sf.params
    );
  }
  // Fallback: any matching scenario (non-default)
  if (!scenario) {
    scenario = db.get(
      `SELECT * FROM scenarios WHERE fy_id = ?${bf.where}${sf.where} ORDER BY branch_id IS NOT NULL, stream_id IS NOT NULL, id`,
      fy_id, ...bf.params, ...sf.params
    );
  }
  // Last resort: create a new scenario for this stream
  if (!scenario) {
    db.run('INSERT INTO scenarios (fy_id, name, is_default, branch_id, stream_id) VALUES (?, ?, 1, ?, ?)', fy_id, 'Original Scenario', branchId, streamId);
    scenario = db.get(
      `SELECT * FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where}${sf.where} ORDER BY branch_id IS NOT NULL, stream_id IS NOT NULL, id`,
      fy_id, ...bf.params, ...sf.params
    );
  }
  res.json(scenario);
});

// === FORECAST ITEMS ===
router.get('/items', async (req, res) => {
  const db = req.tenantDb!;
  const { scenario_id, category } = req.query;
  if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });
  let items;
  if (category) {
    items = db.all('SELECT * FROM forecast_items WHERE scenario_id = ? AND category = ? ORDER BY sort_order, id', scenario_id, category);
  } else {
    items = db.all('SELECT * FROM forecast_items WHERE scenario_id = ? ORDER BY category, sort_order, id', scenario_id);
  }
  // Parse meta JSON
  items = items.map((item: any) => ({
    ...item,
    meta: (() => { try { return item.meta ? JSON.parse(item.meta) : {}; } catch { return {}; } })(),
  }));
  res.json(items);
});

router.post('/items', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { scenario_id, category, name, item_type, entry_mode, constant_amount, constant_period, start_month, annual_raise_pct, tax_rate_pct, sort_order, parent_id, meta } = req.body;
  if (!scenario_id || !category || !name) {
    return res.status(400).json({ error: 'scenario_id, category, and name required' });
  }
  const maxOrder = db.get('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM forecast_items WHERE scenario_id = ? AND category = ?', scenario_id, category);
  db.run(
    `INSERT INTO forecast_items (scenario_id, category, name, item_type, entry_mode, constant_amount, constant_period, start_month, annual_raise_pct, tax_rate_pct, sort_order, parent_id, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    scenario_id, category, name, item_type || null, entry_mode || 'constant',
    constant_amount || 0, constant_period || 'month', start_month || null,
    annual_raise_pct || 0, tax_rate_pct || 0,
    sort_order ?? (maxOrder?.max_order || 0) + 1,
    parent_id || null, meta ? JSON.stringify(meta) : null
  );
  // sql.js lastInsertRowid can be unreliable, so fetch the most recently inserted item
  const item = db.get(
    'SELECT * FROM forecast_items WHERE scenario_id = ? AND category = ? AND name = ? ORDER BY id DESC LIMIT 1',
    scenario_id, category, name
  );
  res.json({ ...item, meta: (() => { try { return item?.meta ? JSON.parse(item.meta) : {}; } catch { return {}; } })() });
});

// Reorder must come BEFORE :id to avoid 'reorder' matching as a param
router.put('/items/reorder', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { items } = req.body; // [{id, sort_order}]
  for (const item of items) {
    db.run('UPDATE forecast_items SET sort_order = ? WHERE id = ?', item.sort_order, item.id);
  }
  res.json({ ok: true });
});

router.put('/items/:id', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { name, item_type, entry_mode, constant_amount, constant_period, start_month, annual_raise_pct, tax_rate_pct, sort_order, parent_id, meta, category } = req.body;
  const fields: string[] = [];
  const values: any[] = [];

  if (category !== undefined) { fields.push('category = ?'); values.push(category); }
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (item_type !== undefined) { fields.push('item_type = ?'); values.push(item_type); }
  if (entry_mode !== undefined) { fields.push('entry_mode = ?'); values.push(entry_mode); }
  if (constant_amount !== undefined) { fields.push('constant_amount = ?'); values.push(constant_amount); }
  if (constant_period !== undefined) { fields.push('constant_period = ?'); values.push(constant_period); }
  if (start_month !== undefined) { fields.push('start_month = ?'); values.push(start_month); }
  if (annual_raise_pct !== undefined) { fields.push('annual_raise_pct = ?'); values.push(annual_raise_pct); }
  if (tax_rate_pct !== undefined) { fields.push('tax_rate_pct = ?'); values.push(tax_rate_pct); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(sort_order); }
  if (parent_id !== undefined) { fields.push('parent_id = ?'); values.push(parent_id); }
  if (meta !== undefined) { fields.push('meta = ?'); values.push(JSON.stringify(meta)); }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(req.params.id);
  db.run(`UPDATE forecast_items SET ${fields.join(', ')} WHERE id = ?`, ...values);
  const item = db.get('SELECT * FROM forecast_items WHERE id = ?', req.params.id);
  res.json({ ...item, meta: (() => { try { return item?.meta ? JSON.parse(item.meta) : {}; } catch { return {}; } })() });
});

router.delete('/items/:id', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  // Verify item belongs to a scenario accessible by this tenant
  const item = db.get('SELECT fi.id FROM forecast_items fi JOIN scenarios s ON fi.scenario_id = s.id WHERE fi.id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.run('DELETE FROM forecast_items WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// === FORECAST VALUES (monthly amounts) ===
router.get('/values', async (req, res) => {
  const db = req.tenantDb!;
  const { item_id, scenario_id } = req.query;
  if (item_id) {
    res.json(db.all('SELECT * FROM forecast_values WHERE item_id = ? ORDER BY month', item_id));
  } else if (scenario_id) {
    // Get all values for all items in a scenario
    res.json(db.all(
      `SELECT fv.* FROM forecast_values fv
       JOIN forecast_items fi ON fv.item_id = fi.id
       WHERE fi.scenario_id = ?
       ORDER BY fv.item_id, fv.month`, scenario_id
    ));
  } else {
    return res.status(400).json({ error: 'item_id or scenario_id required' });
  }
});

router.post('/values', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { item_id, values } = req.body; // values: [{month, amount}]
  if (!item_id || !values?.length) return res.status(400).json({ error: 'item_id and values required' });

  db.beginBatch();
  try {
    for (const v of values) {
      // Upsert
      const existing = db.get('SELECT id FROM forecast_values WHERE item_id = ? AND month = ?', item_id, v.month);
      if (existing) {
        db.run('UPDATE forecast_values SET amount = ? WHERE id = ?', v.amount || 0, existing.id);
      } else {
        db.run('INSERT INTO forecast_values (item_id, month, amount) VALUES (?, ?, ?)', item_id, v.month, v.amount || 0);
      }
    }
    db.endBatch();
  } catch (e) { db.rollbackBatch(); throw e; }

  res.json({ ok: true, count: values.length });
});

// Bulk save all values for a scenario (used by the grid)
router.post('/values/bulk', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { item_id, entries } = req.body; // item_id (optional top-level), entries: [{item_id?, month, amount}]
  if (!entries?.length) return res.status(400).json({ error: 'entries required' });

  db.beginBatch();
  try {
    for (const e of entries) {
      const effectiveItemId = e.item_id || item_id;
      if (!effectiveItemId) continue;
      const existing = db.get('SELECT id FROM forecast_values WHERE item_id = ? AND month = ?', effectiveItemId, e.month);
      if (existing) {
        db.run('UPDATE forecast_values SET amount = ? WHERE id = ?', e.amount || 0, existing.id);
      } else {
        db.run('INSERT INTO forecast_values (item_id, month, amount) VALUES (?, ?, ?)', effectiveItemId, e.month, e.amount || 0);
      }
    }
    db.endBatch();
  } catch (e) { db.rollbackBatch(); throw e; }

  res.json({ ok: true, count: entries.length });
});

// === AUTO-GENERATE VALUES from constant settings ===
router.post('/items/:id/generate', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { months } = req.body; // array of month strings to generate for
  const item = db.get('SELECT * FROM forecast_items WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (item.entry_mode !== 'constant' || !months?.length) {
    return res.json({ ok: true, message: 'No generation needed' });
  }

  let amount = item.constant_amount || 0;
  if (item.constant_period === 'year') {
    amount = amount / 12;
  }

  const startMonth = item.start_month || months[0];

  for (const month of months) {
    if (month < startMonth) continue;

    // Apply annual raise: for each year after start, compound the raise
    let adjustedAmount = amount;
    if (item.annual_raise_pct > 0) {
      const startYear = parseInt(startMonth.slice(0, 4));
      const currentYear = parseInt(month.slice(0, 4));
      const yearsElapsed = currentYear - startYear;
      if (yearsElapsed > 0) {
        adjustedAmount = amount * Math.pow(1 + item.annual_raise_pct / 100, yearsElapsed);
      }
    }

    const existing = db.get('SELECT id FROM forecast_values WHERE item_id = ? AND month = ?', item.id, month);
    if (existing) {
      db.run('UPDATE forecast_values SET amount = ? WHERE id = ?', Math.round(adjustedAmount * 100) / 100, existing.id);
    } else {
      db.run('INSERT INTO forecast_values (item_id, month, amount) VALUES (?, ?, ?)', item.id, month, Math.round(adjustedAmount * 100) / 100);
    }
  }

  res.json({ ok: true });
});

// === SETTINGS (tax rates, employee benefits %, etc.) ===
router.get('/settings', async (req, res) => {
  const db = req.tenantDb!;
  const { scenario_id } = req.query;
  if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });
  const settings = db.all('SELECT * FROM forecast_settings WHERE scenario_id = ?', scenario_id);
  const obj: Record<string, any> = {};
  settings.forEach((s: any) => {
    try { obj[s.setting_key] = JSON.parse(s.setting_value); } catch { obj[s.setting_key] = s.setting_value; }
  });
  res.json(obj);
});

router.post('/settings', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { scenario_id, settings } = req.body; // settings: {key: value, ...}
  if (!scenario_id || !settings) return res.status(400).json({ error: 'scenario_id and settings required' });

  for (const [key, value] of Object.entries(settings)) {
    const val = typeof value === 'string' ? value : JSON.stringify(value);
    const existing = db.get('SELECT id FROM forecast_settings WHERE scenario_id = ? AND setting_key = ?', scenario_id, key);
    if (existing) {
      db.run('UPDATE forecast_settings SET setting_value = ? WHERE id = ?', val, existing.id);
    } else {
      db.run('INSERT INTO forecast_settings (scenario_id, setting_key, setting_value) VALUES (?, ?, ?)', scenario_id, key, val);
    }
  }
  res.json({ ok: true });
});

// === SUMMARY / REPORTS ===
router.get('/summary', async (req, res) => {
  const db = req.tenantDb!;
  const { scenario_id } = req.query;
  if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });

  const items = db.all('SELECT * FROM forecast_items WHERE scenario_id = ? ORDER BY category, sort_order', scenario_id);
  const values = db.all(
    `SELECT fv.* FROM forecast_values fv
     JOIN forecast_items fi ON fv.item_id = fi.id
     WHERE fi.scenario_id = ?`, scenario_id
  );

  // Build a lookup: item_id -> {month -> amount}
  const valueLookup: Record<number, Record<string, number>> = {};
  values.forEach((v: any) => {
    if (!valueLookup[v.item_id]) valueLookup[v.item_id] = {};
    valueLookup[v.item_id][v.month] = v.amount;
  });

  // Group items by category
  const categories: Record<string, any[]> = {};
  items.forEach((item: any) => {
    if (!categories[item.category]) categories[item.category] = [];
    categories[item.category].push({
      ...item,
      meta: (() => { try { return item.meta ? JSON.parse(item.meta) : {}; } catch { return {}; } })(),
      values: valueLookup[item.id] || {},
    });
  });

  // Get settings
  const settings = db.all('SELECT * FROM forecast_settings WHERE scenario_id = ?', scenario_id);
  const settingsObj: Record<string, any> = {};
  settings.forEach((s: any) => {
    try { settingsObj[s.setting_key] = JSON.parse(s.setting_value); } catch { settingsObj[s.setting_key] = s.setting_value; }
  });

  res.json({ categories, settings: settingsObj });
});

// === CATEGORY MAPPING (forecast category ↔ Tally group) ===
// Tenant-scoped table seeded with defaults on first boot. Drives the Step 8
// Budget vs Actual report by declaring which vcfo_* Tally groups roll up
// into which forecast category. `ledger_filter` is an optional comma-
// separated list of LIKE patterns for categories that carve a subset out
// of a broader group (e.g. personnel = Indirect Expenses WHERE ledger LIKE
// 'Salary%' OR LIKE 'Wages%').

router.get('/category-mapping', async (req, res) => {
  const db = req.tenantDb!;
  const rows = db.all(
    'SELECT id, forecast_category, tally_group_name, ledger_filter FROM forecast_category_mapping ORDER BY forecast_category, tally_group_name'
  );
  res.json(rows);
});

router.post('/category-mapping', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { forecast_category, tally_group_name, ledger_filter } = req.body;
  if (!forecast_category || !tally_group_name) {
    return res.status(400).json({ error: 'forecast_category and tally_group_name are required' });
  }
  try {
    db.run(
      'INSERT INTO forecast_category_mapping (forecast_category, tally_group_name, ledger_filter) VALUES (?, ?, ?)',
      String(forecast_category).trim(),
      String(tally_group_name).trim(),
      ledger_filter ? String(ledger_filter).trim() : null
    );
    const row = db.get(
      'SELECT id, forecast_category, tally_group_name, ledger_filter FROM forecast_category_mapping WHERE forecast_category = ? AND tally_group_name = ?',
      String(forecast_category).trim(), String(tally_group_name).trim()
    );
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Mapping already exists for this category + Tally group' });
    }
    throw e;
  }
});

router.put('/category-mapping/:id', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const id = parseInt(req.params.id);
  const { forecast_category, tally_group_name, ledger_filter } = req.body;
  if (!forecast_category || !tally_group_name) {
    return res.status(400).json({ error: 'forecast_category and tally_group_name are required' });
  }
  const existing = db.get('SELECT id FROM forecast_category_mapping WHERE id = ?', id);
  if (!existing) return res.status(404).json({ error: 'Mapping not found' });
  try {
    db.run(
      'UPDATE forecast_category_mapping SET forecast_category = ?, tally_group_name = ?, ledger_filter = ? WHERE id = ?',
      String(forecast_category).trim(),
      String(tally_group_name).trim(),
      ledger_filter ? String(ledger_filter).trim() : null,
      id
    );
    const row = db.get(
      'SELECT id, forecast_category, tally_group_name, ledger_filter FROM forecast_category_mapping WHERE id = ?',
      id
    );
    res.json(row);
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Another mapping already uses this category + Tally group' });
    }
    throw e;
  }
});

router.delete('/category-mapping/:id', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const id = parseInt(req.params.id);
  const existing = db.get('SELECT id FROM forecast_category_mapping WHERE id = ?', id);
  if (!existing) return res.status(404).json({ error: 'Mapping not found' });
  db.run('DELETE FROM forecast_category_mapping WHERE id = ?', id);
  res.json({ ok: true });
});

// === BUDGET vs ACTUAL (Step 8) ===
// Compares forecast totals from forecast_items + forecast_values against
// real Tally totals from vcfo_trial_balance, joined via forecast_category
// _mapping. Returns one row per (category, month) for the scenario's FY.
//
// Tally hierarchy: vcfo_trial_balance.group_name is the IMMEDIATE parent
// group (e.g. "Salaries & Wages" → parent "Direct Expenses"). We walk up
// through vcfo_account_groups.parent_group to find the top-level Tally
// group ("Primary" is the root sentinel) so a sub-group ledger still
// rolls into its primary group's mapping.
//
// Sign convention: vcfo stores credits positive / debits negative. Both
// revenue (credit) and expense (debit) categories should display as
// positive forecast-friendly values, so we ABS() the actuals.
//
// v1 limitation: when two mappings share the same Tally group (e.g.
// expenses + personnel both map to "Indirect Expenses"), the un-filtered
// one will double-count the filtered subset. Acceptable for first ship
// — user can adjust mappings.
router.get('/budget-vs-actual', async (req, res) => {
  const db = req.tenantDb!;
  const scenarioIdRaw = req.query.scenario_id;
  if (!scenarioIdRaw) return res.status(400).json({ error: 'scenario_id required' });
  const scenarioId = parseInt(String(scenarioIdRaw));
  if (Number.isNaN(scenarioId)) return res.status(400).json({ error: 'scenario_id must be numeric' });

  // Resolve FY for this scenario
  const scenario = db.get(
    `SELECT s.id, s.fy_id, s.name, fy.label, fy.start_date, fy.end_date
       FROM scenarios s JOIN financial_years fy ON fy.id = s.fy_id
      WHERE s.id = ?`,
    scenarioId
  );
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

  // Build the FY months (Apr → Mar) as YYYY-MM strings
  const startYear = parseInt(String(scenario.start_date).slice(0, 4));
  const months: string[] = [];
  for (let m = 4; m <= 12; m++) months.push(`${startYear}-${String(m).padStart(2, '0')}`);
  for (let m = 1; m <= 3; m++) months.push(`${startYear + 1}-${String(m).padStart(2, '0')}`);
  const monthStart = months[0];
  const monthEnd = months[months.length - 1];

  // ── Forecast aggregation (per category, per month) ──
  const forecastRows = db.all(
    `SELECT fi.category, fv.month, COALESCE(SUM(fv.amount), 0) AS total
       FROM forecast_items fi
       JOIN forecast_values fv ON fv.item_id = fi.id
      WHERE fi.scenario_id = ?
        AND fv.month BETWEEN ? AND ?
      GROUP BY fi.category, fv.month`,
    scenarioId, monthStart, monthEnd
  );
  const forecast: Record<string, Record<string, number>> = {};
  for (const r of forecastRows) {
    if (!forecast[r.category]) forecast[r.category] = {};
    forecast[r.category][r.month] = Number(r.total) || 0;
  }

  // ── Actual aggregation ──
  // Quick check: any trial-balance data at all for the tenant?
  const tbCount = db.get('SELECT COUNT(*) AS n FROM vcfo_trial_balance').n as number;
  const hasActuals = tbCount > 0;
  const actual: Record<string, Record<string, number>> = {};

  if (hasActuals) {
    const mappings = db.all(
      'SELECT id, forecast_category, tally_group_name, ledger_filter FROM forecast_category_mapping'
    );

    // Recursive CTE walking parent_group up to "Primary" (Tally's root sentinel).
    // Returns one row per (company_id, leaf_group, root_group). Cached as a
    // shared SQL fragment used by both the bulk filterless query and the
    // per-mapping filtered queries.
    const ROOTS_CTE = `
      WITH RECURSIVE walk AS (
        SELECT company_id, group_name AS leaf, group_name AS cur, parent_group, 0 AS d
          FROM vcfo_account_groups
        UNION ALL
        SELECT w.company_id, w.leaf, g.group_name, g.parent_group, w.d + 1
          FROM walk w
          JOIN vcfo_account_groups g
            ON g.company_id = w.company_id AND g.group_name = w.parent_group
         WHERE w.parent_group IS NOT NULL AND w.parent_group != '' AND w.parent_group != 'Primary' AND w.d < 10
      ),
      roots AS (
        SELECT DISTINCT company_id, leaf AS group_name, cur AS root_name
          FROM walk
         WHERE parent_group = 'Primary' OR parent_group IS NULL OR parent_group = ''
      )
    `;

    // 1. Filterless mappings — single query with JOIN to mapping table.
    const filterlessRows = db.all(
      `${ROOTS_CTE}
       SELECT substr(tb.period_from, 1, 7) AS month,
              fcm.forecast_category AS category,
              SUM(tb.closing_balance) AS total
         FROM vcfo_trial_balance tb
         LEFT JOIN roots r
           ON r.company_id = tb.company_id AND r.group_name = tb.group_name
         JOIN forecast_category_mapping fcm
           ON fcm.tally_group_name = COALESCE(r.root_name, tb.group_name)
          AND (fcm.ledger_filter IS NULL OR fcm.ledger_filter = '')
        WHERE substr(tb.period_from, 1, 7) BETWEEN ? AND ?
        GROUP BY month, category`,
      monthStart, monthEnd
    );
    for (const row of filterlessRows) {
      if (!actual[row.category]) actual[row.category] = {};
      actual[row.category][row.month] = (actual[row.category][row.month] || 0) + Math.abs(Number(row.total) || 0);
    }

    // 2. Filtered mappings — one query per mapping (small N, usually 0–2).
    const filtered = mappings.filter((m: any) => m.ledger_filter && String(m.ledger_filter).trim());
    for (const m of filtered) {
      const patterns = String(m.ledger_filter)
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
      if (patterns.length === 0) continue;
      const likeClause = patterns.map(() => 'tb.ledger_name LIKE ?').join(' OR ');
      const rows = db.all(
        `${ROOTS_CTE}
         SELECT substr(tb.period_from, 1, 7) AS month,
                SUM(tb.closing_balance) AS total
           FROM vcfo_trial_balance tb
           LEFT JOIN roots r
             ON r.company_id = tb.company_id AND r.group_name = tb.group_name
          WHERE substr(tb.period_from, 1, 7) BETWEEN ? AND ?
            AND COALESCE(r.root_name, tb.group_name) = ?
            AND (${likeClause})
          GROUP BY month`,
        monthStart, monthEnd, m.tally_group_name, ...patterns
      );
      for (const row of rows) {
        if (!actual[m.forecast_category]) actual[m.forecast_category] = {};
        actual[m.forecast_category][row.month] = (actual[m.forecast_category][row.month] || 0) + Math.abs(Number(row.total) || 0);
      }
    }
  }

  res.json({
    scenario: { id: scenario.id, name: scenario.name, fy_id: scenario.fy_id },
    fy: { id: scenario.fy_id, label: scenario.label, start_date: scenario.start_date, end_date: scenario.end_date },
    months,
    forecast,
    actual,
    hasActuals,
  });
});

export default router;
