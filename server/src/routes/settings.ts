import { Router } from 'express';

const router = Router();

router.get('/fy', async (_req, res) => {
  const db = _req.tenantDb!;
  res.json(db.all('SELECT * FROM financial_years ORDER BY start_date DESC'));
});

router.post('/fy', async (req, res) => {
  const { label, start_date, end_date } = req.body;
  if (!label || !start_date || !end_date) return res.status(400).json({ error: 'label, start_date, end_date required' });
  const db = req.tenantDb!;
  const result = db.run('INSERT INTO financial_years (label, start_date, end_date) VALUES (?, ?, ?)', label, start_date, end_date);
  res.json({ id: result.lastInsertRowid });
});

router.put('/fy/:id/activate', async (req, res) => {
  const db = req.tenantDb!;
  db.run('UPDATE financial_years SET is_active = 0');
  db.run('UPDATE financial_years SET is_active = 1 WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

router.get('/doctors', async (_req, res) => {
  const db = _req.tenantDb!;
  res.json(db.all('SELECT * FROM doctors ORDER BY name'));
});

router.post('/doctors', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const db = req.tenantDb!;
  const result = db.run('INSERT OR IGNORE INTO doctors (name) VALUES (?)', name);
  res.json({ id: result.lastInsertRowid });
});

router.get('/departments', async (_req, res) => {
  const db = _req.tenantDb!;
  res.json(db.all('SELECT * FROM departments ORDER BY sort_order'));
});

export default router;
