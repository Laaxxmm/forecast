import { Router } from 'express';
import { getHelper } from '../db/connection.js';

const router = Router();

router.get('/', async (req, res) => {
  const db = await getHelper();
  const { fy_id, business_unit } = req.query;
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  if (business_unit) {
    res.json(db.all(
      'SELECT * FROM forecasts WHERE fy_id = ? AND business_unit = ? ORDER BY month, department_id, metric',
      fy_id, business_unit
    ));
  } else {
    res.json(db.all('SELECT * FROM forecasts WHERE fy_id = ? ORDER BY month, department_id, metric', fy_id));
  }
});

router.post('/', async (req, res) => {
  const db = await getHelper();
  const { fy_id, business_unit, entries, forecast_date } = req.body;
  if (!fy_id || !business_unit || !entries?.length) {
    return res.status(400).json({ error: 'fy_id, business_unit, and entries required' });
  }

  const fDate = forecast_date || new Date().toISOString().slice(0, 10);
  db.run('DELETE FROM forecasts WHERE fy_id = ? AND business_unit = ? AND forecast_date = ?', fy_id, business_unit, fDate);

  for (const e of entries) {
    db.run(
      `INSERT INTO forecasts (fy_id, business_unit, month, department_id, metric, amount, forecast_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      fy_id, business_unit, e.month, e.department_id || null, e.metric, e.amount || 0, fDate, e.notes || null
    );
  }

  res.json({ ok: true, count: entries.length, forecast_date: fDate });
});

router.get('/auto-fill', async (req, res) => {
  const db = await getHelper();
  const { fy_id, business_unit } = req.query;
  if (!fy_id || !business_unit) return res.status(400).json({ error: 'fy_id and business_unit required' });

  const budgets = db.all(
    'SELECT * FROM budgets WHERE fy_id = ? AND business_unit = ? ORDER BY month', fy_id, business_unit
  );
  res.json(budgets);
});

export default router;
