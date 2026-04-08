/**
 * VCFO Tracker — Compliance, Accounting, and Internal Control tracking
 * Three tracker types with per-company, per-period status tracking.
 */
import { Router, Request, Response } from 'express';

const router = Router();

// ── Tracker Items CRUD ───────────────────────────────────────────────────────

// List items by type
router.get('/items', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const trackerType = req.query.type as string || 'compliance';
    const branchId = req.branchId;

    let sql = 'SELECT * FROM vcfo_tracker_items WHERE tracker_type = ? AND is_active = 1';
    const params: any[] = [trackerType];
    if (branchId) { sql += ' AND (branch_id = ? OR branch_id IS NULL)'; params.push(branchId); }
    sql += ' ORDER BY sort_order, name';

    res.json(db.all(sql, ...params));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create item
router.post('/items', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const { tracker_type, name, category, frequency, default_due_day, config } = req.body;
    if (!tracker_type || !name) return res.status(400).json({ error: 'tracker_type and name required' });

    const result = db.run(
      'INSERT OR IGNORE INTO vcfo_tracker_items (tracker_type, name, category, frequency, default_due_day, config, branch_id) VALUES (?,?,?,?,?,?,?)',
      tracker_type, name, category || '', frequency || 'monthly', default_due_day || 0,
      JSON.stringify(config || {}), req.branchId
    );
    res.json({ id: result.lastInsertRowid });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update item
router.put('/items/:id', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const id = parseInt(req.params.id as string);
    const { name, category, frequency, default_due_day, sort_order, is_active, config } = req.body;

    db.run(
      `UPDATE vcfo_tracker_items SET name=COALESCE(?,name), category=COALESCE(?,category),
       frequency=COALESCE(?,frequency), default_due_day=COALESCE(?,default_due_day),
       sort_order=COALESCE(?,sort_order), is_active=COALESCE(?,is_active),
       config=COALESCE(?,config) WHERE id=?`,
      name, category, frequency, default_due_day, sort_order, is_active,
      config ? JSON.stringify(config) : null, id
    );
    res.json(db.get('SELECT * FROM vcfo_tracker_items WHERE id = ?', id));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete item (soft)
router.delete('/items/:id', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    db.run('UPDATE vcfo_tracker_items SET is_active = 0 WHERE id = ?', parseInt(req.params.id as string));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Tracker Status ───────────────────────────────────────────────────────────

// Get status grid for a tracker type, company, and period range
router.get('/status', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const trackerType = req.query.type as string || 'compliance';
    const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
    const periodFrom = req.query.periodFrom as string;
    const periodTo = req.query.periodTo as string;
    const branchId = req.branchId;

    // Get items
    let itemSql = 'SELECT * FROM vcfo_tracker_items WHERE tracker_type = ? AND is_active = 1';
    const itemParams: any[] = [trackerType];
    if (branchId) { itemSql += ' AND (branch_id = ? OR branch_id IS NULL)'; itemParams.push(branchId); }
    itemSql += ' ORDER BY sort_order, name';
    const items = db.all(itemSql, ...itemParams);

    // Get statuses
    let statusSql = `SELECT ts.* FROM vcfo_tracker_status ts
      JOIN vcfo_tracker_items ti ON ts.item_id = ti.id
      WHERE ti.tracker_type = ?`;
    const statusParams: any[] = [trackerType];
    if (companyId) { statusSql += ' AND ts.company_id = ?'; statusParams.push(companyId); }
    if (periodFrom) { statusSql += ' AND ts.period_key >= ?'; statusParams.push(periodFrom); }
    if (periodTo) { statusSql += ' AND ts.period_key <= ?'; statusParams.push(periodTo); }

    const statuses = db.all(statusSql, ...statusParams);

    // Build status map: item_id -> period_key -> status
    const statusMap: Record<number, Record<string, any>> = {};
    for (const s of statuses) {
      if (!statusMap[s.item_id]) statusMap[s.item_id] = {};
      statusMap[s.item_id][s.period_key] = s;
    }

    res.json({ items, statuses: statusMap });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update a single status cell
router.put('/status', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const { item_id, company_id, period_key, status, due_date, completion_date, assigned_to, notes } = req.body;
    if (!item_id || !company_id || !period_key) {
      return res.status(400).json({ error: 'item_id, company_id, period_key required' });
    }

    db.run(
      `INSERT INTO vcfo_tracker_status (item_id, company_id, period_key, status, due_date, completion_date, assigned_to, notes, branch_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(item_id, company_id, period_key) DO UPDATE SET
       status=excluded.status, due_date=excluded.due_date, completion_date=excluded.completion_date,
       assigned_to=excluded.assigned_to, notes=excluded.notes, updated_at=datetime('now')`,
      item_id, company_id, period_key, status || 'pending', due_date || null,
      completion_date || null, assigned_to || '', notes || '', req.branchId
    );

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk seed default items for a tracker type
router.post('/seed', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const { tracker_type } = req.body;
    if (!tracker_type) return res.status(400).json({ error: 'tracker_type required' });

    const defaults: Record<string, { name: string; category: string; frequency: string }[]> = {
      compliance: [
        { name: 'GST Return Filing (GSTR-1)', category: 'GST', frequency: 'monthly' },
        { name: 'GST Return Filing (GSTR-3B)', category: 'GST', frequency: 'monthly' },
        { name: 'TDS Return Filing', category: 'TDS', frequency: 'quarterly' },
        { name: 'TDS Payment', category: 'TDS', frequency: 'monthly' },
        { name: 'PF Payment', category: 'PF/ESI', frequency: 'monthly' },
        { name: 'ESI Payment', category: 'PF/ESI', frequency: 'monthly' },
        { name: 'Professional Tax', category: 'Other', frequency: 'monthly' },
        { name: 'Advance Tax Payment', category: 'Income Tax', frequency: 'quarterly' },
        { name: 'ROC Annual Filing', category: 'ROC', frequency: 'annual' },
        { name: 'Income Tax Return', category: 'Income Tax', frequency: 'annual' },
        { name: 'Tax Audit Report', category: 'Income Tax', frequency: 'annual' },
        { name: 'GST Annual Return (GSTR-9)', category: 'GST', frequency: 'annual' },
      ],
      accounting: [
        { name: 'Bank Reconciliation', category: 'Reconciliation', frequency: 'monthly' },
        { name: 'Accounts Receivable Review', category: 'Receivables', frequency: 'monthly' },
        { name: 'Accounts Payable Review', category: 'Payables', frequency: 'monthly' },
        { name: 'Fixed Asset Register Update', category: 'Assets', frequency: 'quarterly' },
        { name: 'Inventory Reconciliation', category: 'Inventory', frequency: 'monthly' },
        { name: 'Depreciation Booking', category: 'Assets', frequency: 'monthly' },
        { name: 'Inter-Company Reconciliation', category: 'Reconciliation', frequency: 'monthly' },
        { name: 'Trial Balance Review', category: 'Review', frequency: 'monthly' },
      ],
      internal_control: [
        { name: 'Cash Handling Audit', category: 'Cash', frequency: 'monthly' },
        { name: 'Vendor Payment Authorization Review', category: 'Payments', frequency: 'monthly' },
        { name: 'Expense Report Compliance', category: 'Expenses', frequency: 'monthly' },
        { name: 'Credit Limit Review', category: 'Credit', frequency: 'quarterly' },
        { name: 'Signatory Authority Review', category: 'Authorization', frequency: 'half_yearly' },
        { name: 'Insurance Coverage Review', category: 'Insurance', frequency: 'annual' },
      ],
    };

    const items = defaults[tracker_type] || [];
    let seeded = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const result = db.run(
        'INSERT OR IGNORE INTO vcfo_tracker_items (tracker_type, name, category, frequency, branch_id, sort_order) VALUES (?,?,?,?,?,?)',
        tracker_type, item.name, item.category, item.frequency, req.branchId, i
      );
      if (result.changes > 0) seeded++;
    }

    res.json({ seeded });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Summary stats ────────────────────────────────────────────────────────────

router.get('/summary', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
    const periodKey = req.query.period as string;

    let sql = `SELECT ts.status, COUNT(*) as count
      FROM vcfo_tracker_status ts
      JOIN vcfo_tracker_items ti ON ts.item_id = ti.id
      WHERE ti.is_active = 1`;
    const params: any[] = [];
    if (companyId) { sql += ' AND ts.company_id = ?'; params.push(companyId); }
    if (periodKey) { sql += ' AND ts.period_key = ?'; params.push(periodKey); }
    sql += ' GROUP BY ts.status';

    const rows = db.all(sql, ...params);
    const summary: Record<string, number> = { pending: 0, in_progress: 0, completed: 0, overdue: 0, not_applicable: 0 };
    for (const r of rows) summary[r.status] = r.count;

    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
