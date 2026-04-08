/**
 * VCFO Forecast View — Read-only endpoints to expose forecast data within VCFO module.
 * Reads from the same tenant DB's forecast tables (scenarios, forecast_items, forecast_values).
 * No writes — all edits must happen in the Forecast module.
 */
import { Router } from 'express';
import { branchFilter } from '../../utils/branch.js';

const router = Router();

// GET /financial-years — list all FYs
router.get('/financial-years', async (req, res) => {
  try {
    const db = req.tenantDb!;
    const fys = db.all('SELECT * FROM financial_years ORDER BY start_date DESC');
    res.json(fys);
  } catch (err: any) {
    console.error('VCFO forecast-view /financial-years error:', err.message);
    res.status(500).json({ error: 'Failed to load financial years' });
  }
});

// GET /scenarios?fy_id= — list scenarios for a FY
router.get('/scenarios', async (req, res) => {
  try {
    const db = req.tenantDb!;
    const { fy_id } = req.query;
    const bf = branchFilter(req);
    if (!fy_id) return res.status(400).json({ error: 'fy_id required' });
    const scenarios = db.all(
      `SELECT * FROM scenarios WHERE fy_id = ?${bf.where} ORDER BY is_default DESC, name`,
      fy_id, ...bf.params
    );
    res.json(scenarios);
  } catch (err: any) {
    console.error('VCFO forecast-view /scenarios error:', err.message);
    res.status(500).json({ error: 'Failed to load scenarios' });
  }
});

// GET /summary?scenario_id= — full read-only summary (items + values + settings)
router.get('/summary', async (req, res) => {
  try {
    const db = req.tenantDb!;
    const { scenario_id } = req.query;
    if (!scenario_id) return res.status(400).json({ error: 'scenario_id required' });

    const items = db.all(
      'SELECT * FROM forecast_items WHERE scenario_id = ? ORDER BY category, sort_order, id',
      scenario_id
    );
    const values = db.all(
      `SELECT fv.* FROM forecast_values fv
       JOIN forecast_items fi ON fv.item_id = fi.id
       WHERE fi.scenario_id = ?`,
      scenario_id
    );

    // Build value lookup: item_id -> {month -> amount}
    const valueLookup: Record<number, Record<string, number>> = {};
    values.forEach((v: any) => {
      if (!valueLookup[v.item_id]) valueLookup[v.item_id] = {};
      valueLookup[v.item_id][v.month] = v.amount;
    });

    // Parse meta JSON on items
    const parsedItems = items.map((item: any) => ({
      ...item,
      meta: item.meta ? JSON.parse(item.meta) : {},
    }));

    // Get settings
    const settings = db.all('SELECT * FROM forecast_settings WHERE scenario_id = ?', scenario_id);
    const settingsObj: Record<string, any> = {};
    settings.forEach((s: any) => {
      try { settingsObj[s.setting_key] = JSON.parse(s.setting_value); } catch { settingsObj[s.setting_key] = s.setting_value; }
    });

    // Get actuals for comparison
    const actuals = db.all(
      'SELECT * FROM dashboard_actuals WHERE scenario_id = ? ORDER BY month',
      scenario_id
    );
    const actualsLookup: Record<string, Record<string, number>> = {};
    actuals.forEach((a: any) => {
      const key = `${a.category}::${a.item_name}`;
      if (!actualsLookup[key]) actualsLookup[key] = {};
      actualsLookup[key][a.month] = a.amount;
    });

    res.json({
      items: parsedItems,
      values: valueLookup,
      settings: settingsObj,
      actuals: actualsLookup,
    });
  } catch (err: any) {
    console.error('VCFO forecast-view /summary error:', err.message);
    res.status(500).json({ error: 'Failed to load forecast summary' });
  }
});

export default router;
