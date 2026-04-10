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

  // Find ALL per-stream scenarios for this FY + branch
  const scenarios = db.all(
    `SELECT * FROM scenarios WHERE fy_id = ? AND stream_id IS NOT NULL${bf.where}`,
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
    const scenario = db.get(`SELECT * FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where}`, fy_id, ...bf.params);
    return res.json(scenario || null);
  }

  let scenario = db.get(`SELECT * FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where}${sf.where}`, fy_id, ...bf.params, ...sf.params);
  if (!scenario) {
    scenario = db.get(`SELECT * FROM scenarios WHERE fy_id = ?${bf.where}${sf.where}`, fy_id, ...bf.params, ...sf.params);
  }
  if (!scenario) {
    db.run('INSERT INTO scenarios (fy_id, name, is_default, branch_id, stream_id) VALUES (?, ?, 1, ?, ?)', fy_id, 'Original Scenario', branchId, streamId);
    scenario = db.get(`SELECT * FROM scenarios WHERE fy_id = ? AND is_default = 1${bf.where}${sf.where}`, fy_id, ...bf.params, ...sf.params);
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

  for (const v of values) {
    // Upsert
    const existing = db.get('SELECT id FROM forecast_values WHERE item_id = ? AND month = ?', item_id, v.month);
    if (existing) {
      db.run('UPDATE forecast_values SET amount = ? WHERE id = ?', v.amount || 0, existing.id);
    } else {
      db.run('INSERT INTO forecast_values (item_id, month, amount) VALUES (?, ?, ?)', item_id, v.month, v.amount || 0);
    }
  }
  res.json({ ok: true, count: values.length });
});

// Bulk save all values for a scenario (used by the grid)
router.post('/values/bulk', requireWriteAccess, async (req, res) => {
  const db = req.tenantDb!;
  const { item_id, entries } = req.body; // item_id (optional top-level), entries: [{item_id?, month, amount}]
  if (!entries?.length) return res.status(400).json({ error: 'entries required' });

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

export default router;
