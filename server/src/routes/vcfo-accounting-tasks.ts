// ─────────────────────────────────────────────────────────────────────────────
// VCFO Accounting Tracker routes.
//
// Month/quarter/year-end close checklist with an accountant → reviewer
// approval workflow and a per-task file module for workings and supporting
// docs. Tables:
//   vcfo_accounting_task_catalog   — curated master list (seeded per tenant)
//   vcfo_accounting_tasks          — instances; one row per (branch, catalog, period)
//   vcfo_accounting_task_files     — attachments stored under DATA_DIR/uploads
//   vcfo_accounting_task_events    — immutable audit log (CFO's trail)
//
// Status lifecycle: pending → in_progress → submitted → approved | rejected
// (plus cancelled escape hatch). `overdue` is DERIVED at read time.
//
// Branch scoping mirrors the compliances model: tasks always own a branch_id
// (the representative branch for org-wide work). `resolveBranch` middleware
// puts the user's current sidebar branch into req.branchId; consolidated view
// (branchId = null) falls back to the client's first active branch for
// `generate` and refuses task-creation (caller must pick a branch first).
//
// Endpoints:  (vcfo_write = admin + accountant; approve/reject = admin only)
//   GET    /api/vcfo/accounting-tasks                 — scoped list
//   GET    /api/vcfo/accounting-tasks/catalog         — master list
//   GET    /api/vcfo/accounting-tasks/:id             — single task + files + events
//   POST   /api/vcfo/accounting-tasks/generate        — materialise this period (vcfo_write)
//   POST   /api/vcfo/accounting-tasks                 — ad-hoc create (vcfo_write)
//   PATCH  /api/vcfo/accounting-tasks/:id             — full edit (vcfo_write) or notes-only (assignee)
//   POST   /api/vcfo/accounting-tasks/:id/claim       — self-assign
//   POST   /api/vcfo/accounting-tasks/:id/submit      — submit for review (assignee)
//   POST   /api/vcfo/accounting-tasks/:id/approve     — approve (ADMIN-ONLY maker-checker)
//   POST   /api/vcfo/accounting-tasks/:id/reject      — reject w/ reason (ADMIN-ONLY maker-checker)
//   POST   /api/vcfo/accounting-tasks/:id/reopen      — undo approval (vcfo_write)
//   POST   /api/vcfo/accounting-tasks/:id/cancel      — soft-cancel (vcfo_write)
//   DELETE /api/vcfo/accounting-tasks/:id             — hard-delete + unlink files (vcfo_write)
//   POST   /api/vcfo/accounting-tasks/:id/files       — upload 1..10 files (vcfo_write or assignee)
//   GET    /api/vcfo/accounting-tasks/:id/files/:fid  — stream file
//   DELETE /api/vcfo/accounting-tasks/:id/files/:fid  — remove attachment (vcfo_write or uploader)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { getPlatformHelper } from '../db/platform-connection.js';
import { taskFileUpload, getTaskFilesDir } from '../middleware/upload.js';
import { canWriteVcfo, canApproveAccountingTask } from '../middleware/auth.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

interface BranchRow { id: number; name: string; state: string | null }

async function clientBranches(req: Request): Promise<BranchRow[]> {
  const platformDb = await getPlatformHelper();
  return platformDb.all(
    `SELECT id, name, state FROM branches
     WHERE client_id = ? AND is_active = 1
     ORDER BY sort_order, name`,
    req.clientId,
  ) as BranchRow[];
}

function toInt(val: any): number | null {
  const n = parseInt(String(val), 10);
  return Number.isNaN(n) ? null : n;
}

function isoDate(val: any): string | null {
  const s = String(val || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Local alias kept for readability — delegates to the middleware helper which
// grants VCFO write access to admin + accountant (and super_admin).
// Approve / reject are still admin-only via canApproveAccountingTask.

/**
 * Compute a concrete due_date from a catalog entry + a period end date.
 * Honours default_due_day / default_due_month (annual & half-yearly use the
 * month; others anchor on the month after period_end).
 */
function catalogDueDate(catalog: any, periodEnd: string): string {
  const [py, pm] = periodEnd.split('-').map(n => parseInt(n, 10));
  const dueDay = catalog.default_due_day || 15;
  let y: number, m: number;
  if (catalog.frequency === 'annual' || catalog.frequency === 'half-yearly') {
    m = catalog.default_due_month || pm;
    y = py;
    if (m < pm) y = py + 1;  // due month rolls into next year
  } else {
    // monthly / quarterly — due in the month AFTER period end
    m = pm + 1;
    y = py;
    if (m > 12) { m = 1; y = py + 1; }
  }
  // clamp day to month length (handle 31-day → Feb etc.)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(dueDay, lastDay);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Append an audit-log row. Caller owns the transaction; this just runs the INSERT. */
function logEvent(
  db: any,
  taskId: number,
  actorUserId: number | null,
  eventType: string,
  fromStatus: string | null,
  toStatus: string | null,
  note: string | null,
) {
  db.run(
    `INSERT INTO vcfo_accounting_task_events
     (task_id, actor_user_id, event_type, from_status, to_status, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [taskId, actorUserId, eventType, fromStatus, toStatus, note],
  );
}

/** Load a task and enforce client-ownership via allowed branches. Returns null if not allowed. */
async function loadOwnedTask(req: Request, taskId: number): Promise<any | null> {
  const db = req.tenantDb!;
  const branches = await clientBranches(req);
  const allowed = new Set(branches.map(b => b.id));
  const row = db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, taskId);
  if (!row) return null;
  if (!allowed.has(row.branch_id)) return null;
  return row;
}

function decorateIsOverdue(row: any): any {
  const today = new Date().toISOString().slice(0, 10);
  const open = !['approved', 'cancelled'].includes(row.status);
  return { ...row, is_overdue: open && row.due_date < today ? 1 : 0 };
}

// ── Catalog ────────────────────────────────────────────────────────────────

router.get('/catalog', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const rows = db.all(
    `SELECT * FROM vcfo_accounting_task_catalog
     WHERE is_active = 1
     ORDER BY category, sort_order, name`,
  );
  res.json(rows);
});

// ── List ───────────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const branches = await clientBranches(req);
  const allowedIds = branches.map(b => b.id);
  if (allowedIds.length === 0) return res.json([]);

  // Scope to current branch if one is picked, otherwise the user's allowed set.
  const scopeIds = req.branchId ? [req.branchId] : allowedIds;
  const placeholders = scopeIds.map(() => '?').join(',');

  const params: any[] = [...scopeIds];
  const filters: string[] = [`t.branch_id IN (${placeholders})`];

  const status = String(req.query.status || '').trim();
  if (status) { filters.push('t.status = ?'); params.push(status); }

  const category = String(req.query.category || '').trim();
  if (category) { filters.push('t.category = ?'); params.push(category); }

  const periodLabel = String(req.query.period_label || '').trim();
  if (periodLabel) { filters.push('t.period_label = ?'); params.push(periodLabel); }

  const assigneeUserId = toInt(req.query.assignee_user_id);
  if (assigneeUserId !== null) { filters.push('t.assignee_user_id = ?'); params.push(assigneeUserId); }

  const dueBefore = isoDate(req.query.due_before);
  if (dueBefore) { filters.push('t.due_date < ?'); params.push(dueBefore); }

  const rows = db.all(
    `SELECT
       t.*,
       (SELECT COUNT(*) FROM vcfo_accounting_task_files f WHERE f.task_id = t.id) AS file_count,
       (SELECT COUNT(*) FROM vcfo_accounting_task_events e WHERE e.task_id = t.id) AS event_count
     FROM vcfo_accounting_tasks t
     WHERE ${filters.join(' AND ')}
     ORDER BY t.due_date ASC, t.id ASC`,
    params,
  );

  // Enrich with assignee/reviewer display names from platform DB
  const platformDb = await getPlatformHelper();
  const userIds = new Set<number>();
  for (const r of rows) {
    if (r.assignee_user_id) userIds.add(r.assignee_user_id);
    if (r.reviewer_user_id) userIds.add(r.reviewer_user_id);
  }
  const nameMap = new Map<number, string>();
  if (userIds.size > 0) {
    const placeholders2 = Array.from(userIds).map(() => '?').join(',');
    const userRows = platformDb.all(
      `SELECT id, display_name FROM client_users WHERE id IN (${placeholders2})`,
      ...Array.from(userIds),
    );
    for (const u of userRows) nameMap.set(u.id, u.display_name);
  }
  const enriched = rows.map((r: any) => decorateIsOverdue({
    ...r,
    assignee_name: r.assignee_user_id ? (nameMap.get(r.assignee_user_id) || null) : null,
    reviewer_name: r.reviewer_user_id ? (nameMap.get(r.reviewer_user_id) || null) : null,
  }));
  res.json(enriched);
});

// ── Single task ────────────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const db = req.tenantDb!;
  const files = db.all(
    `SELECT id, original_name, stored_name, size_bytes, mime_type, uploaded_at, uploaded_by_user_id
     FROM vcfo_accounting_task_files
     WHERE task_id = ?
     ORDER BY id DESC`,
    id,
  );
  const events = db.all(
    `SELECT id, actor_user_id, event_type, from_status, to_status, note, created_at
     FROM vcfo_accounting_task_events
     WHERE task_id = ?
     ORDER BY id DESC
     LIMIT 50`,
    id,
  );

  // Resolve user display names for events + files + task assignee/reviewer
  const platformDb = await getPlatformHelper();
  const userIds = new Set<number>();
  if (task.assignee_user_id) userIds.add(task.assignee_user_id);
  if (task.reviewer_user_id) userIds.add(task.reviewer_user_id);
  for (const f of files) if (f.uploaded_by_user_id) userIds.add(f.uploaded_by_user_id);
  for (const e of events) if (e.actor_user_id) userIds.add(e.actor_user_id);

  const nameMap = new Map<number, string>();
  if (userIds.size > 0) {
    const placeholders = Array.from(userIds).map(() => '?').join(',');
    const userRows = platformDb.all(
      `SELECT id, display_name FROM client_users WHERE id IN (${placeholders})`,
      ...Array.from(userIds),
    );
    for (const u of userRows) nameMap.set(u.id, u.display_name);
  }

  res.json({
    ...decorateIsOverdue(task),
    assignee_name: task.assignee_user_id ? (nameMap.get(task.assignee_user_id) || null) : null,
    reviewer_name: task.reviewer_user_id ? (nameMap.get(task.reviewer_user_id) || null) : null,
    files: files.map((f: any) => ({
      ...f,
      uploaded_by_name: f.uploaded_by_user_id ? (nameMap.get(f.uploaded_by_user_id) || null) : null,
    })),
    events: events.map((e: any) => ({
      ...e,
      actor_name: e.actor_user_id ? (nameMap.get(e.actor_user_id) || null) : null,
    })),
  });
});

// ── Generate tasks from catalog for a given period ─────────────────────────

router.post('/generate', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) return res.status(403).json({ error: 'VCFO write access required' });
  const db = req.tenantDb!;

  const periodLabel = String(req.body.period_label || '').trim();
  const periodStart = isoDate(req.body.period_start);
  const periodEnd = isoDate(req.body.period_end);
  if (!periodLabel || !periodStart || !periodEnd) {
    return res.status(400).json({ error: 'period_label, period_start, period_end (YYYY-MM-DD) are required' });
  }
  const frequency = String(req.body.frequency || '').trim();   // optional filter
  const catalogKeys: string[] = Array.isArray(req.body.catalog_keys) ? req.body.catalog_keys : [];

  // Resolve target branch — use picked branch if any, else first active branch.
  const branches = await clientBranches(req);
  if (branches.length === 0) return res.status(400).json({ error: 'client has no active branches' });
  const targetBranchId = req.branchId || branches[0].id;

  // Pull catalog rows matching the optional frequency / key filter.
  const catParams: any[] = [];
  const catFilters: string[] = ['is_active = 1'];
  if (frequency) { catFilters.push('frequency = ?'); catParams.push(frequency); }
  if (catalogKeys.length > 0) {
    catFilters.push(`key IN (${catalogKeys.map(() => '?').join(',')})`);
    catParams.push(...catalogKeys);
  }
  const catalog = db.all(
    `SELECT * FROM vcfo_accounting_task_catalog
     WHERE ${catFilters.join(' AND ')}
     ORDER BY sort_order, name`,
    catParams,
  );

  let created = 0, skipped = 0;
  const actorId = req.session?.userId || null;

  db.exec('BEGIN');
  try {
    for (const c of catalog) {
      const dueDate = catalogDueDate(c, periodEnd);
      const before = db.get(
        `SELECT id FROM vcfo_accounting_tasks
         WHERE branch_id = ? AND catalog_id = ? AND period_label = ?`,
        [targetBranchId, c.id, periodLabel],
      );
      if (before) { skipped++; continue; }
      // Partial unique index catches races too; INSERT OR IGNORE is the belt to its braces.
      const result = db.run(
        `INSERT OR IGNORE INTO vcfo_accounting_tasks
         (catalog_id, branch_id, title, category, frequency,
          period_label, period_start, period_end, due_date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [c.id, targetBranchId, c.name, c.category, c.frequency,
         periodLabel, periodStart, periodEnd, dueDate],
      );
      if (result.changes > 0) {
        const newId = db.get(
          `SELECT id FROM vcfo_accounting_tasks
           WHERE branch_id = ? AND catalog_id = ? AND period_label = ?`,
          [targetBranchId, c.id, periodLabel],
        )?.id;
        if (newId) logEvent(db, newId, actorId, 'created', null, 'pending', `from catalog:${c.key}`);
        created++;
      } else {
        skipped++;
      }
    }
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('[accounting-tasks] generate failed:', err.message);
    return res.status(500).json({ error: 'generate failed', detail: err.message });
  }

  res.json({ created, skipped, period_label: periodLabel, branch_id: targetBranchId });
});

// ── Ad-hoc create ──────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) return res.status(403).json({ error: 'VCFO write access required' });
  const db = req.tenantDb!;

  const title = String(req.body.title || '').trim();
  const category = String(req.body.category || '').trim();
  const frequency = String(req.body.frequency || '').trim();
  const periodLabel = String(req.body.period_label || '').trim();
  const periodStart = isoDate(req.body.period_start);
  const periodEnd = isoDate(req.body.period_end);
  const dueDate = isoDate(req.body.due_date);
  if (!title || !category || !frequency || !periodLabel || !periodStart || !periodEnd || !dueDate) {
    return res.status(400).json({
      error: 'title, category, frequency, period_label, period_start, period_end, due_date are required',
    });
  }

  const branches = await clientBranches(req);
  if (branches.length === 0) return res.status(400).json({ error: 'client has no active branches' });
  const branchId = toInt(req.body.branch_id) || req.branchId || branches[0].id;

  const priority = ['low', 'normal', 'high', 'critical'].includes(req.body.priority)
    ? req.body.priority : 'normal';
  const notes = req.body.notes ? String(req.body.notes) : null;
  const assigneeUserId = toInt(req.body.assignee_user_id);

  const actorId = req.session?.userId || null;

  db.exec('BEGIN');
  try {
    const result = db.run(
      `INSERT INTO vcfo_accounting_tasks
       (catalog_id, branch_id, title, category, frequency,
        period_label, period_start, period_end, due_date,
        assignee_user_id, priority, notes, status)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [branchId, title, category, frequency, periodLabel, periodStart, periodEnd, dueDate,
       assigneeUserId, priority, notes],
    );
    const newId = Number(result.lastInsertRowid);
    logEvent(db, newId, actorId, 'created', null, 'pending', 'ad-hoc');
    db.exec('COMMIT');
    const row = db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, newId);
    res.status(201).json(decorateIsOverdue(row));
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'create failed', detail: err.message });
  }
});

// ── Patch ──────────────────────────────────────────────────────────────────

router.patch('/:id', async (req: Request, res: Response) => {
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const db = req.tenantDb!;
  const actorId = req.session?.userId || null;
  // canEditAll = admin + accountant + super_admin. They can touch every field.
  // Assignees on their own task can only edit notes/submission_note.
  const canEditAll = canWriteVcfo(req);
  const isAssignee = task.assignee_user_id && actorId && task.assignee_user_id === actorId;
  if (!canEditAll && !isAssignee) return res.status(403).json({ error: 'not authorised' });

  const adminFields = ['title', 'category', 'frequency', 'period_label', 'period_start',
    'period_end', 'due_date', 'assignee_user_id', 'reviewer_user_id', 'priority', 'notes'];
  const assigneeFields = ['notes', 'submission_note'];
  const allowed = canEditAll ? adminFields : assigneeFields;

  const fields: string[] = [];
  const params: any[] = [];
  let noteChanged = false;
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      fields.push(`${f} = ?`);
      params.push(req.body[f]);
      if (f === 'notes' || f === 'submission_note') noteChanged = true;
    }
  }
  if (fields.length === 0) return res.json(decorateIsOverdue(task));
  fields.push(`updated_at = datetime('now')`);
  params.push(id);

  db.exec('BEGIN');
  try {
    db.run(`UPDATE vcfo_accounting_tasks SET ${fields.join(', ')} WHERE id = ?`, params);
    if (noteChanged) logEvent(db, id, actorId, 'note_updated', null, null, null);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'update failed', detail: err.message });
  }
  const updated = db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, id);
  res.json(decorateIsOverdue(updated));
});

// ── Claim (self-assign) ────────────────────────────────────────────────────

router.post('/:id/claim', async (req: Request, res: Response) => {
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const db = req.tenantDb!;
  const actorId = req.session?.userId || null;
  if (!actorId) return res.status(401).json({ error: 'login required' });

  if (task.assignee_user_id && task.assignee_user_id !== actorId) {
    return res.status(409).json({ error: 'already claimed by another user' });
  }
  if (!['pending', 'in_progress', 'rejected'].includes(task.status)) {
    return res.status(400).json({ error: `cannot claim task in status ${task.status}` });
  }

  db.exec('BEGIN');
  try {
    db.run(
      `UPDATE vcfo_accounting_tasks
       SET assignee_user_id = ?, status = 'in_progress', updated_at = datetime('now')
       WHERE id = ? AND (assignee_user_id IS NULL OR assignee_user_id = ?)`,
      [actorId, id, actorId],
    );
    logEvent(db, id, actorId, 'claimed', task.status, 'in_progress', null);
    logEvent(db, id, actorId, 'status_changed', task.status, 'in_progress', null);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'claim failed', detail: err.message });
  }
  res.json(decorateIsOverdue(db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, id)));
});

// ── Submit ─────────────────────────────────────────────────────────────────

router.post('/:id/submit', async (req: Request, res: Response) => {
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const db = req.tenantDb!;
  const actorId = req.session?.userId || null;

  // Assignee-only (admins may also submit if they're the assignee).
  if (!task.assignee_user_id || task.assignee_user_id !== actorId) {
    return res.status(403).json({ error: 'only the assignee may submit; claim first' });
  }
  if (!['pending', 'in_progress', 'rejected'].includes(task.status)) {
    return res.status(400).json({ error: `cannot submit from status ${task.status}` });
  }

  const submissionNote = req.body.submission_note ? String(req.body.submission_note) : null;
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.run(
      `UPDATE vcfo_accounting_tasks
       SET status = 'submitted', submitted_at = ?, submission_note = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [now, submissionNote, id],
    );
    logEvent(db, id, actorId, 'submitted', task.status, 'submitted', submissionNote);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'submit failed', detail: err.message });
  }
  res.json(decorateIsOverdue(db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, id)));
});

// ── Approve ────────────────────────────────────────────────────────────────

router.post('/:id/approve', async (req: Request, res: Response) => {
  // Maker-checker: approvals stay admin-only (accountant is the maker).
  if (!canApproveAccountingTask(req)) return res.status(403).json({ error: 'admin access required to approve' });
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status !== 'submitted') {
    return res.status(400).json({ error: `cannot approve from status ${task.status}` });
  }
  const db = req.tenantDb!;
  const actorId = req.session?.userId || null;
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.run(
      `UPDATE vcfo_accounting_tasks
       SET status = 'approved', approved_at = ?, reviewer_user_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [now, actorId, id],
    );
    logEvent(db, id, actorId, 'approved', 'submitted', 'approved', null);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'approve failed', detail: err.message });
  }
  res.json(decorateIsOverdue(db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, id)));
});

// ── Reject ─────────────────────────────────────────────────────────────────

router.post('/:id/reject', async (req: Request, res: Response) => {
  // Maker-checker: rejections stay admin-only (accountant is the maker).
  if (!canApproveAccountingTask(req)) return res.status(403).json({ error: 'admin access required to reject' });
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status !== 'submitted') {
    return res.status(400).json({ error: `cannot reject from status ${task.status}` });
  }
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: 'rejection reason is required (min 5 characters)' });
  }
  const db = req.tenantDb!;
  const actorId = req.session?.userId || null;
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.run(
      `UPDATE vcfo_accounting_tasks
       SET status = 'rejected', rejected_at = ?, reviewer_user_id = ?, rejection_reason = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [now, actorId, reason, id],
    );
    logEvent(db, id, actorId, 'rejected', 'submitted', 'rejected', reason);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'reject failed', detail: err.message });
  }
  res.json(decorateIsOverdue(db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, id)));
});

// ── Reopen (undo approval) ─────────────────────────────────────────────────

router.post('/:id/reopen', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) return res.status(403).json({ error: 'VCFO write access required' });
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status !== 'approved') {
    return res.status(400).json({ error: 'can only reopen approved tasks' });
  }
  const db = req.tenantDb!;
  const actorId = req.session?.userId || null;

  db.exec('BEGIN');
  try {
    db.run(
      `UPDATE vcfo_accounting_tasks
       SET status = 'in_progress', approved_at = NULL, updated_at = datetime('now')
       WHERE id = ?`,
      [id],
    );
    logEvent(db, id, actorId, 'reopened', 'approved', 'in_progress', null);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'reopen failed', detail: err.message });
  }
  res.json(decorateIsOverdue(db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, id)));
});

// ── Cancel (soft) ──────────────────────────────────────────────────────────

router.post('/:id/cancel', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) return res.status(403).json({ error: 'VCFO write access required' });
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status === 'cancelled' || task.status === 'approved') {
    return res.status(400).json({ error: `cannot cancel from status ${task.status}` });
  }
  const db = req.tenantDb!;
  const actorId = req.session?.userId || null;
  const note = req.body.note ? String(req.body.note) : null;

  db.exec('BEGIN');
  try {
    db.run(
      `UPDATE vcfo_accounting_tasks
       SET status = 'cancelled', updated_at = datetime('now')
       WHERE id = ?`,
      [id],
    );
    logEvent(db, id, actorId, 'cancelled', task.status, 'cancelled', note);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'cancel failed', detail: err.message });
  }
  res.json(decorateIsOverdue(db.get(`SELECT * FROM vcfo_accounting_tasks WHERE id = ?`, id)));
});

// ── Hard-delete ────────────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response) => {
  if (!canWriteVcfo(req)) return res.status(403).json({ error: 'VCFO write access required' });
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const db = req.tenantDb!;

  // Unlink files from disk first; DB cascade cleans up rows.
  const files = db.all(
    `SELECT stored_name, storage_path FROM vcfo_accounting_task_files WHERE task_id = ?`,
    id,
  );
  for (const f of files) {
    try {
      const abs = path.join(getTaskFilesDir(), req.tenantSlug || '', f.stored_name);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (e) {
      // Best-effort — don't abort the DB delete on a missing file.
      console.error('[accounting-tasks] unlink failed:', (e as Error).message);
    }
  }
  db.run(`DELETE FROM vcfo_accounting_tasks WHERE id = ?`, id);
  res.status(204).end();
});

// ── Files: upload ──────────────────────────────────────────────────────────

router.post('/:id/files', taskFileUpload.array('files', 10), async (req: Request, res: Response) => {
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const db = req.tenantDb!;
  const actorId = req.session?.userId || null;
  const elevated = canWriteVcfo(req); // admin + accountant + super_admin
  const isAssignee = task.assignee_user_id && actorId && task.assignee_user_id === actorId;
  if (!elevated && !isAssignee) return res.status(403).json({ error: 'only assignee or VCFO-write role may upload' });

  const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
  if (files.length === 0) return res.status(400).json({ error: 'no files received' });

  const slug = req.tenantSlug || '_unknown';
  const inserted: any[] = [];

  db.exec('BEGIN');
  try {
    for (const f of files) {
      const relativePath = path.posix.join('uploads', 'vcfo_accounting', slug, f.filename);
      const result = db.run(
        `INSERT INTO vcfo_accounting_task_files
         (task_id, uploaded_by_user_id, original_name, stored_name, storage_path, size_bytes, mime_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, actorId, f.originalname, f.filename, relativePath, f.size, f.mimetype || null],
      );
      const newId = Number(result.lastInsertRowid);
      logEvent(db, id, actorId, 'file_added', null, null, f.originalname);
      inserted.push({
        id: newId,
        task_id: id,
        original_name: f.originalname,
        stored_name: f.filename,
        storage_path: relativePath,
        size_bytes: f.size,
        mime_type: f.mimetype || null,
      });
    }
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    // Best-effort filesystem cleanup for failed inserts.
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    return res.status(500).json({ error: 'file upload failed', detail: err.message });
  }
  res.status(201).json({ files: inserted });
});

// ── Files: download ────────────────────────────────────────────────────────

router.get('/:id/files/:fileId', async (req: Request, res: Response) => {
  const id = toInt(req.params.id);
  const fileId = toInt(req.params.fileId);
  if (id === null || fileId === null) return res.status(400).json({ error: 'ids must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const db = req.tenantDb!;
  const file = db.get(
    `SELECT * FROM vcfo_accounting_task_files WHERE id = ? AND task_id = ?`,
    [fileId, id],
  );
  if (!file) return res.status(404).json({ error: 'file not found' });

  // Path-traversal defence: absolute path must start with the task-files base dir.
  const base = path.resolve(getTaskFilesDir());
  const abs = path.resolve(path.join(base, req.tenantSlug || '', file.stored_name));
  if (!abs.startsWith(base + path.sep) && abs !== base) {
    return res.status(400).json({ error: 'invalid file path' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file missing on disk' });

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
  if (file.mime_type) res.setHeader('Content-Type', file.mime_type);
  res.sendFile(abs);
});

// ── Files: delete ──────────────────────────────────────────────────────────

router.delete('/:id/files/:fileId', async (req: Request, res: Response) => {
  const id = toInt(req.params.id);
  const fileId = toInt(req.params.fileId);
  if (id === null || fileId === null) return res.status(400).json({ error: 'ids must be integer' });
  const task = await loadOwnedTask(req, id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const db = req.tenantDb!;
  const file = db.get(
    `SELECT * FROM vcfo_accounting_task_files WHERE id = ? AND task_id = ?`,
    [fileId, id],
  );
  if (!file) return res.status(404).json({ error: 'file not found' });

  const actorId = req.session?.userId || null;
  const elevated = canWriteVcfo(req); // admin + accountant + super_admin
  const isUploader = file.uploaded_by_user_id && actorId && file.uploaded_by_user_id === actorId;
  if (!elevated && !isUploader) return res.status(403).json({ error: 'only uploader or VCFO-write role may delete' });

  // Unlink on disk first.
  try {
    const base = path.resolve(getTaskFilesDir());
    const abs = path.resolve(path.join(base, req.tenantSlug || '', file.stored_name));
    if (abs.startsWith(base) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) {
    console.error('[accounting-tasks] file unlink failed:', (e as Error).message);
  }

  db.exec('BEGIN');
  try {
    db.run(`DELETE FROM vcfo_accounting_task_files WHERE id = ?`, fileId);
    logEvent(db, id, actorId, 'file_removed', null, null, file.original_name);
    db.exec('COMMIT');
  } catch (err: any) {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'delete failed', detail: err.message });
  }
  res.status(204).end();
});

export default router;
