/**
 * VCFO Companies — CRUD for Tally companies registered under this client
 */
import { Router, Request, Response } from 'express';

const router = Router();

// List VCFO companies
router.get('/', (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const branchId = req.branchId;

  let sql = 'SELECT * FROM vcfo_companies WHERE is_active = 1';
  const params: any[] = [];
  if (branchId) {
    sql += ' AND branch_id = ?';
    params.push(branchId);
  }
  sql += ' ORDER BY name';

  const companies = db.all(sql, ...params);
  res.json(companies);
});

// Get single company
router.get('/:id', (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const company = db.get('SELECT * FROM vcfo_companies WHERE id = ?', parseInt(req.params.id as string));
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json(company);
});

// Create / register a company
router.post('/', (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { name, guid, fy_from, fy_to, tally_version, state, city, location, entity_type } = req.body;
  if (!name) return res.status(400).json({ error: 'Company name is required' });

  const branchId = req.branchId;
  const result = db.run(
    'INSERT OR IGNORE INTO vcfo_companies (name, guid, fy_from, fy_to, tally_version, state, city, location, entity_type, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    name, guid || null, fy_from || null, fy_to || null, tally_version || null,
    state || '', city || '', location || '', entity_type || '', branchId
  );

  const company = db.get('SELECT * FROM vcfo_companies WHERE name = ? AND (branch_id = ? OR branch_id IS NULL)', name, branchId);
  res.json(company);
});

// Update company metadata
router.put('/:id', (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const id = parseInt(req.params.id as string);
  const { state, city, location, entity_type, sync_modules, is_active } = req.body;

  const existing = db.get('SELECT * FROM vcfo_companies WHERE id = ?', id);
  if (!existing) return res.status(404).json({ error: 'Company not found' });

  db.run(
    'UPDATE vcfo_companies SET state=?, city=?, location=?, entity_type=?, sync_modules=?, is_active=? WHERE id=?',
    state ?? existing.state, city ?? existing.city, location ?? existing.location,
    entity_type ?? existing.entity_type, sync_modules ?? existing.sync_modules,
    is_active ?? existing.is_active, id
  );

  res.json(db.get('SELECT * FROM vcfo_companies WHERE id = ?', id));
});

// Delete (soft)
router.delete('/:id', (req: Request, res: Response) => {
  const db = req.tenantDb!;
  db.run('UPDATE vcfo_companies SET is_active = 0 WHERE id = ?', parseInt(req.params.id as string));
  res.json({ success: true });
});

export default router;
