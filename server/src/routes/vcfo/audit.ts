/**
 * VCFO Audit — Milestones, milestone status, and audit observations
 */
import { Router, Request, Response } from 'express';

const router = Router();

// ── Audit Milestones CRUD ────────────────────────────────────────────────────

router.get('/milestones', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const branchId = req.branchId;

    let sql = 'SELECT * FROM vcfo_audit_milestones WHERE is_active = 1';
    const params: any[] = [];
    if (branchId) { sql += ' AND (branch_id = ? OR branch_id IS NULL)'; params.push(branchId); }
    sql += ' ORDER BY sort_order, name';

    res.json(db.all(sql, ...params));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/milestones', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const { name, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const result = db.run(
      'INSERT OR IGNORE INTO vcfo_audit_milestones (name, sort_order, branch_id) VALUES (?,?,?)',
      name, sort_order || 0, req.branchId
    );
    res.json({ id: result.lastInsertRowid });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/milestones/:id', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const id = parseInt(req.params.id as string);
    const { name, sort_order, is_active } = req.body;

    db.run(
      'UPDATE vcfo_audit_milestones SET name=COALESCE(?,name), sort_order=COALESCE(?,sort_order), is_active=COALESCE(?,is_active) WHERE id=?',
      name, sort_order, is_active, id
    );
    res.json(db.get('SELECT * FROM vcfo_audit_milestones WHERE id = ?', id));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/milestones/:id', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    db.run('UPDATE vcfo_audit_milestones SET is_active = 0 WHERE id = ?', parseInt(req.params.id as string));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Seed default milestones
router.post('/milestones/seed', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const defaults = [
      'Engagement Letter Signed',
      'Prior Year Data Received',
      'Trial Balance Verified',
      'Bank Reconciliation Reviewed',
      'Fixed Assets Verified',
      'Debtors Confirmation Sent',
      'Creditors Confirmation Sent',
      'Inventory Verification Done',
      'Tax Computations Reviewed',
      'Draft Report Prepared',
      'Management Discussion',
      'Final Report Issued',
      'Tax Return Filed',
    ];
    let count = 0;
    for (let i = 0; i < defaults.length; i++) {
      const result = db.run(
        'INSERT OR IGNORE INTO vcfo_audit_milestones (name, sort_order, branch_id) VALUES (?,?,?)',
        defaults[i], i, req.branchId
      );
      if (result.changes > 0) count++;
    }
    res.json({ seeded: count });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Milestone Status ─────────────────────────────────────────────────────────

router.get('/milestone-status', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
    const fyYear = req.query.fy ? parseInt(req.query.fy as string) : null;

    const milestones = db.all(
      'SELECT * FROM vcfo_audit_milestones WHERE is_active = 1 ORDER BY sort_order, name'
    );

    let statusSql = 'SELECT * FROM vcfo_audit_milestone_status WHERE 1=1';
    const params: any[] = [];
    if (companyId) { statusSql += ' AND company_id = ?'; params.push(companyId); }
    if (fyYear) { statusSql += ' AND fy_year = ?'; params.push(fyYear); }

    const statuses = db.all(statusSql, ...params);
    const statusMap: Record<string, any> = {};
    for (const s of statuses) {
      statusMap[`${s.milestone_id}-${s.company_id}-${s.fy_year}`] = s;
    }

    res.json({ milestones, statuses: statusMap });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/milestone-status', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const { milestone_id, company_id, fy_year, status, due_date, completion_date, assigned_to, notes } = req.body;
    if (!milestone_id || !company_id || !fy_year) {
      return res.status(400).json({ error: 'milestone_id, company_id, fy_year required' });
    }

    db.run(
      `INSERT INTO vcfo_audit_milestone_status (milestone_id, company_id, fy_year, status, due_date, completion_date, assigned_to, notes, branch_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(milestone_id, company_id, fy_year) DO UPDATE SET
       status=excluded.status, due_date=excluded.due_date, completion_date=excluded.completion_date,
       assigned_to=excluded.assigned_to, notes=excluded.notes, updated_at=datetime('now')`,
      milestone_id, company_id, fy_year, status || 'pending',
      due_date || null, completion_date || null, assigned_to || '', notes || '', req.branchId
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Audit Observations ───────────────────────────────────────────────────────

router.get('/observations', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
    const fyYear = req.query.fy ? parseInt(req.query.fy as string) : null;
    const status = req.query.status as string;

    let sql = "SELECT * FROM vcfo_audit_observations WHERE status != 'deleted'";
    const params: any[] = [];
    if (companyId) { sql += ' AND company_id = ?'; params.push(companyId); }
    if (fyYear) { sql += ' AND fy_year = ?'; params.push(fyYear); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';

    res.json(db.all(sql, ...params));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/observations', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const { company_id, fy_year, title, description, severity, category, recommendation, assigned_to, due_date } = req.body;
    if (!fy_year || !title) return res.status(400).json({ error: 'fy_year and title required' });

    const result = db.run(
      `INSERT INTO vcfo_audit_observations (company_id, fy_year, title, description, severity, category, recommendation, assigned_to, due_date, branch_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      company_id || null, fy_year, title, description || '', severity || 'medium',
      category || '', recommendation || '', assigned_to || '', due_date || null, req.branchId
    );
    res.json({ id: result.lastInsertRowid });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/observations/:id', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const id = parseInt(req.params.id as string);
    const { title, description, severity, category, recommendation, mgmt_response, status, assigned_to, due_date, resolution_date } = req.body;

    db.run(
      `UPDATE vcfo_audit_observations SET
       title=COALESCE(?,title), description=COALESCE(?,description), severity=COALESCE(?,severity),
       category=COALESCE(?,category), recommendation=COALESCE(?,recommendation),
       mgmt_response=COALESCE(?,mgmt_response), status=COALESCE(?,status),
       assigned_to=COALESCE(?,assigned_to), due_date=COALESCE(?,due_date),
       resolution_date=COALESCE(?,resolution_date), updated_at=datetime('now') WHERE id=?`,
      title, description, severity, category, recommendation, mgmt_response, status,
      assigned_to, due_date, resolution_date, id
    );
    res.json(db.get('SELECT * FROM vcfo_audit_observations WHERE id = ?', id));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/observations/:id', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    db.run("UPDATE vcfo_audit_observations SET status = 'deleted', updated_at = datetime('now') WHERE id = ?", parseInt(req.params.id as string));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

router.get('/summary', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const fyYear = req.query.fy ? parseInt(req.query.fy as string) : null;

    // Milestone progress
    const totalMilestones = db.get('SELECT COUNT(*) as cnt FROM vcfo_audit_milestones WHERE is_active = 1')?.cnt || 0;

    let completedSql = 'SELECT COUNT(*) as cnt FROM vcfo_audit_milestone_status WHERE status = ?';
    const completedParams: any[] = ['completed'];
    if (fyYear) { completedSql += ' AND fy_year = ?'; completedParams.push(fyYear); }
    const completedMilestones = db.get(completedSql, ...completedParams)?.cnt || 0;

    // Observation stats
    let obsSql = 'SELECT status, severity, COUNT(*) as cnt FROM vcfo_audit_observations WHERE 1=1';
    const obsParams: any[] = [];
    if (fyYear) { obsSql += ' AND fy_year = ?'; obsParams.push(fyYear); }
    obsSql += ' GROUP BY status, severity';
    const obsRows = db.all(obsSql, ...obsParams);

    const observations = { open: 0, in_progress: 0, resolved: 0, closed: 0, high: 0, medium: 0, low: 0 };
    for (const r of obsRows) {
      observations[r.status as keyof typeof observations] = (observations[r.status as keyof typeof observations] || 0) + r.cnt;
      observations[r.severity as keyof typeof observations] = (observations[r.severity as keyof typeof observations] || 0) + r.cnt;
    }

    res.json({
      milestones: { total: totalMilestones, completed: completedMilestones },
      observations,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
