import { Router } from 'express';

const router = Router();

router.get('/', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, business_unit } = req.query;
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  if (business_unit) {
    res.json(db.all(
      'SELECT * FROM budgets WHERE fy_id = ? AND business_unit = ? ORDER BY month, department_id, metric',
      fy_id, business_unit
    ));
  } else {
    res.json(db.all(
      'SELECT * FROM budgets WHERE fy_id = ? ORDER BY month, department_id, metric',
      fy_id
    ));
  }
});

router.post('/', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, business_unit, entries } = req.body;
  if (!fy_id || !business_unit || !entries?.length) {
    return res.status(400).json({ error: 'fy_id, business_unit, and entries required' });
  }

  // Delete existing entries for this FY/unit and re-insert
  db.run('DELETE FROM budgets WHERE fy_id = ? AND business_unit = ?', fy_id, business_unit);

  for (const e of entries) {
    db.run(
      `INSERT INTO budgets (fy_id, business_unit, month, department_id, metric, amount, version)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      fy_id, business_unit, e.month, e.department_id || null, e.metric, e.amount || 0
    );
  }

  res.json({ ok: true, count: entries.length });
});

router.delete('/', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, business_unit } = req.query;
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  if (business_unit) {
    db.run('DELETE FROM budgets WHERE fy_id = ? AND business_unit = ?', fy_id, business_unit);
  } else {
    db.run('DELETE FROM budgets WHERE fy_id = ?', fy_id);
  }
  res.json({ ok: true });
});

export default router;
