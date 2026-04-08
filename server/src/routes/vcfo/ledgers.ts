/**
 * VCFO Ledger Routes — Ledger search and categorization
 */

import { Router } from 'express';
import { idPh, resolveIds } from '../../services/vcfo/company-resolver.js';

const router = Router();

// Search ledgers by name pattern
router.get('/search', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const ids = resolveIds(db, req.query);
    if (!ids || !ids.length) return res.json([]);
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const escapedQ = q.replace(/[%_]/g, '\\$&');
    const rows = db.all(
      `SELECT DISTINCT name, group_name FROM vcfo_ledgers
       WHERE company_id IN (${idPh(ids)}) AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 50`,
      ...ids, `%${escapedQ}%`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ledgers grouped by P&L category
router.get('/by-category', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const ids = resolveIds(db, req.query);
    if (!ids || !ids.length) return res.json({});
    const rows = db.all(
      `SELECT DISTINCT l.name, l.group_name, ag.bs_pl, ag.dr_cr, ag.affects_gross_profit
       FROM vcfo_ledgers l
       LEFT JOIN vcfo_account_groups ag ON ag.company_id = l.company_id AND ag.group_name = l.group_name
       WHERE l.company_id IN (${idPh(ids)})
       ORDER BY l.group_name, l.name`,
      ...ids
    );

    const categories: Record<string, any[]> = {
      directIncome: [], directExpense: [], indirectIncome: [], indirectExpense: [], balanceSheet: []
    };
    for (const r of rows) {
      if (r.bs_pl === 'PL') {
        if (r.dr_cr === 'C' && r.affects_gross_profit === 'Y') categories.directIncome.push(r);
        else if (r.dr_cr === 'D' && r.affects_gross_profit === 'Y') categories.directExpense.push(r);
        else if (r.dr_cr === 'C') categories.indirectIncome.push(r);
        else categories.indirectExpense.push(r);
      } else {
        categories.balanceSheet.push(r);
      }
    }
    res.json(categories);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ledgers for writeoff rule (searchable, group-filtered)
router.get('/for-writeoff', (req, res) => {
  try {
    const db = (req as any).tenantDb;
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const memberIds = db.all(
      'SELECT company_id FROM vcfo_company_group_members WHERE group_id = ?', groupId
    ).map((r: any) => r.company_id);

    if (!memberIds.length) return res.json([]);

    const q = String(req.query.q || '').trim();
    let sql = `SELECT DISTINCT name, group_name FROM vcfo_ledgers WHERE company_id IN (${idPh(memberIds)})`;
    const params: any[] = [...memberIds];
    if (q) {
      const escapedQ = q.replace(/[%_]/g, '\\$&');
      sql += " AND name LIKE ? ESCAPE '\\'";
      params.push(`%${escapedQ}%`);
    }
    sql += ' ORDER BY name LIMIT 100';

    res.json(db.all(sql, ...params));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
