/**
 * VCFO Budgets Routes — Budget management and variance analysis
 */

import { Router } from 'express';
import { idPh, resolveIds } from '../../services/vcfo/company-resolver.js';
import { computeKPIData } from '../../services/vcfo/kpi-engine.js';


const router = Router();

// Get budgets for a group
router.get('/', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    let q = 'SELECT * FROM vcfo_budgets WHERE group_id = ?';
    const params: any[] = [groupId];
    if (req.query.companyId) { q += ' AND company_id = ?'; params.push(Number(req.query.companyId)); }
    if (req.query.period_month) { q += ' AND period_month = ?'; params.push(req.query.period_month); }
    q += ' ORDER BY period_month, line_item';

    res.json(db.all(q, ...params));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save/upsert budget entries
router.post('/', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const { entries } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array required' });

    db.exec('BEGIN');
    let count = 0;
    for (const e of entries) {
      if (!e.group_id || !e.period_month || !e.line_item) continue;
      db.run(
        `INSERT INTO vcfo_budgets (group_id, company_id, period_month, line_item, amount)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(group_id, company_id, period_month, line_item)
         DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
        e.group_id, e.company_id || null, e.period_month, e.line_item, e.amount || 0
      );
      count++;
    }
    db.exec('COMMIT');
    res.json({ success: true, count });
  } catch (err: any) {
    try { (req as any).tenantDb.exec('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Budget vs Actual variance
router.get('/variance', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const from = String(req.query.fromDate || '2024-04-01');
    const to = String(req.query.toDate || '2025-03-31');

    // Get budgets
    const budgets = db.all(
      'SELECT line_item, SUM(amount) as budget FROM vcfo_budgets WHERE group_id = ? AND period_month >= ? AND period_month <= ? GROUP BY line_item',
      groupId, from.substring(0, 7), to.substring(0, 7)
    );

    // Get actuals
    const ids = resolveIds(db, { groupId: String(groupId) });
    if (!ids || !ids.length) return res.json({ budgets: [], actuals: null });

    const actuals = computeKPIData(db, ids, from, to);

    const variance = budgets.map((b: any) => {
      const actualVal = (actuals as any)[b.line_item] || 0;
      return {
        line_item: b.line_item,
        budget: b.budget,
        actual: actualVal,
        variance: actualVal - b.budget,
        variance_pct: b.budget ? ((actualVal - b.budget) / Math.abs(b.budget) * 100) : 0
      };
    });

    res.json({ variance, actuals });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
