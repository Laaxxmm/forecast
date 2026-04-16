import { Router } from 'express';
import { branchFilter, getBranchIdForInsert } from '../utils/branch.js';

const router = Router();

router.get('/', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, business_unit } = req.query;
  const bf = branchFilter(req);
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  if (business_unit) {
    res.json(db.all(
      `SELECT * FROM budgets WHERE fy_id = ? AND business_unit = ?${bf.where} ORDER BY month, department_id, metric`,
      fy_id, business_unit, ...bf.params
    ));
  } else {
    res.json(db.all(
      `SELECT * FROM budgets WHERE fy_id = ?${bf.where} ORDER BY month, department_id, metric`,
      fy_id, ...bf.params
    ));
  }
});

router.post('/', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, business_unit, entries } = req.body;
  const bf = branchFilter(req);
  const branchId = getBranchIdForInsert(req);
  if (!fy_id || !business_unit || !entries?.length) {
    return res.status(400).json({ error: 'fy_id, business_unit, and entries required' });
  }

  // Delete existing entries for this FY/unit (branch-scoped) and re-insert
  db.beginBatch();
  try {
    db.run(`DELETE FROM budgets WHERE fy_id = ? AND business_unit = ?${bf.where}`, fy_id, business_unit, ...bf.params);

    for (const e of entries) {
      db.run(
        `INSERT INTO budgets (fy_id, business_unit, month, department_id, metric, amount, version, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        fy_id, business_unit, e.month, e.department_id || null, e.metric, e.amount || 0, branchId
      );
    }
    db.endBatch();
  } catch (e) { db.rollbackBatch(); throw e; }

  res.json({ ok: true, count: entries.length });
});

router.delete('/', async (req, res) => {
  const db = req.tenantDb!;
  const { fy_id, business_unit } = req.query;
  const bf = branchFilter(req);
  if (!fy_id) return res.status(400).json({ error: 'fy_id required' });

  if (business_unit) {
    db.run(`DELETE FROM budgets WHERE fy_id = ? AND business_unit = ?${bf.where}`, fy_id, business_unit, ...bf.params);
  } else {
    db.run(`DELETE FROM budgets WHERE fy_id = ?${bf.where}`, fy_id, ...bf.params);
  }
  res.json({ ok: true });
});

export default router;
