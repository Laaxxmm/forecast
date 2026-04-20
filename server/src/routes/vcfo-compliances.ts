// ─────────────────────────────────────────────────────────────────────────────
// VCFO Compliances routes.
//
// Endpoints:
//   GET  /api/vcfo/compliances                 — list instances (branch-filtered)
//   GET  /api/vcfo/compliances/catalog         — master list, optionally state-filtered
//   GET  /api/vcfo/compliances/branches        — client's branches with state (picker)
//   POST /api/vcfo/compliances                 — create (from catalog or free-form)
//   PATCH /api/vcfo/compliances/:id            — update fields
//   POST /api/vcfo/compliances/:id/file        — mark filed + rollforward next period
//   DELETE /api/vcfo/compliances/:id           — delete
//
// Mounted under /api/vcfo/compliances with the standard forecastOps middleware
// stack (requireAuth → resolveTenant → resolveBranch → requireModule).
// Branch ownership is enforced by joining to the platform-DB branches table
// filtered by the caller's client_id.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { getPlatformHelper } from '../db/platform-connection.js';

const router = Router();

async function clientBranchIds(req: Request): Promise<Set<number>> {
  const platformDb = await getPlatformHelper();
  const rows = platformDb.all(
    `SELECT id FROM branches WHERE client_id = ? AND is_active = 1`,
    req.clientId,
  ) as Array<{ id: number }>;
  return new Set(rows.map(r => r.id));
}

function toInt(val: any): number | null {
  const n = parseInt(String(val), 10);
  return Number.isNaN(n) ? null : n;
}

function isoDate(val: any): string | null {
  const s = String(val || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ── Period math ────────────────────────────────────────────────────────────
// Given a due_date (YYYY-MM-DD) + frequency, return the next period's due_date.
function rollForward(dueDate: string, frequency: string): string {
  const [y, m, d] = dueDate.split('-').map(n => parseInt(n, 10));
  const step = frequency === 'monthly' ? 1
    : frequency === 'quarterly' ? 3
    : frequency === 'half-yearly' ? 6
    : 12;
  const dt = new Date(Date.UTC(y, m - 1 + step, d));
  // If the day overflowed (e.g. Jan 31 + 1mo = Mar 3), clamp to last day of target month.
  if (dt.getUTCMonth() !== ((m - 1 + step) % 12 + 12) % 12) {
    dt.setUTCDate(0); // last day of previous month
  }
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function autoPeriodLabel(dueDate: string, frequency: string): string {
  const [y, m] = dueDate.split('-').map(n => parseInt(n, 10));
  if (frequency === 'monthly')    return `${MONTHS[m - 1]} ${y}`;
  if (frequency === 'quarterly')  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (frequency === 'half-yearly')return `${m <= 6 ? 'H1' : 'H2'} ${y}`;
  return `${y}`;
}

// ── Endpoints ──────────────────────────────────────────────────────────────

// List catalog entries, optionally state-filtered.
router.get('/catalog', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const state = String(req.query.state || '').trim().toUpperCase();
  const rows = state
    ? db.all(
        `SELECT * FROM vcfo_compliance_catalog WHERE state IS NULL OR state = ? ORDER BY category, name`,
        state,
      )
    : db.all(`SELECT * FROM vcfo_compliance_catalog ORDER BY category, name`);
  res.json(rows);
});

// Branches visible to this client (for the branch picker inside Compliances).
router.get('/branches', async (req: Request, res: Response) => {
  const platformDb = await getPlatformHelper();
  const rows = platformDb.all(
    `SELECT id, name, code, city, state FROM branches
     WHERE client_id = ? AND is_active = 1
     ORDER BY sort_order, name`,
    req.clientId,
  );
  res.json(rows);
});

// List compliance instances. Filters: branchId, status, from, to.
router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const allowed = await clientBranchIds(req);
  if (allowed.size === 0) return res.json([]);

  const where: string[] = [`branch_id IN (${[...allowed].join(',')})`];
  const params: any[] = [];

  const branchId = toInt(req.query.branchId);
  if (branchId !== null) {
    if (!allowed.has(branchId)) return res.json([]);
    where.length = 0;
    where.push('branch_id = ?');
    params.push(branchId);
  }

  const status = String(req.query.status || '').trim();
  if (status) { where.push('status = ?'); params.push(status); }

  const from = isoDate(req.query.from);
  const to = isoDate(req.query.to);
  if (from) { where.push('due_date >= ?'); params.push(from); }
  if (to)   { where.push('due_date <= ?'); params.push(to); }

  const rows = db.all(
    `SELECT * FROM vcfo_compliances WHERE ${where.join(' AND ')} ORDER BY due_date ASC, id ASC`,
    ...params,
  );
  res.json(rows);
});

// Create a compliance row — from catalog (catalogId) or free-form.
router.post('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const allowed = await clientBranchIds(req);
  const branchId = toInt(req.body.branchId);
  if (branchId === null || !allowed.has(branchId)) {
    return res.status(400).json({ error: 'branchId is invalid or not owned by this client' });
  }

  const catalogId = toInt(req.body.catalogId);
  let name: string, category: string, frequency: string, dueDate: string;
  if (catalogId !== null) {
    const cat = db.get(`SELECT * FROM vcfo_compliance_catalog WHERE id = ?`, catalogId) as any;
    if (!cat) return res.status(404).json({ error: 'catalog entry not found' });
    name = String(req.body.name || cat.name);
    category = cat.category;
    frequency = cat.frequency;
    dueDate = isoDate(req.body.dueDate) || defaultDueDate(cat);
  } else {
    name = String(req.body.name || '').trim();
    category = String(req.body.category || 'Other').trim();
    frequency = String(req.body.frequency || 'monthly').trim();
    dueDate = isoDate(req.body.dueDate) || '';
    if (!name || !dueDate) {
      return res.status(400).json({ error: 'name and dueDate are required for free-form compliances' });
    }
  }

  const periodLabel = String(req.body.periodLabel || autoPeriodLabel(dueDate, frequency));
  const amount = req.body.amount != null ? Number(req.body.amount) : null;
  const assignee = req.body.assignee ? String(req.body.assignee) : null;
  const notes = req.body.notes ? String(req.body.notes) : null;

  db.run(
    `INSERT INTO vcfo_compliances
     (branch_id, catalog_id, name, category, frequency, due_date, period_label, status, amount, assignee, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [branchId, catalogId, name, category, frequency, dueDate, periodLabel, amount, assignee, notes],
  );
  const row = db.get(
    `SELECT * FROM vcfo_compliances WHERE branch_id = ? AND name = ? AND due_date = ? ORDER BY id DESC LIMIT 1`,
    branchId, name, dueDate,
  );
  res.status(201).json(row);
});

// Default due_date from catalog entry. Picks the next upcoming instance
// based on default_due_day/default_due_month. For monthly/quarterly we use
// today's year+month and advance one cycle if already past.
function defaultDueDate(cat: any): string {
  const now = new Date();
  const day = cat.default_due_day || 15;
  const freq = cat.frequency;
  if (freq === 'annual') {
    const m = cat.default_due_month || 3;
    let y = now.getUTCFullYear();
    const candidate = new Date(Date.UTC(y, m - 1, Math.min(day, 28)));
    if (candidate < now) y += 1;
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (freq === 'half-yearly') {
    const month = cat.default_due_month || 1;
    let y = now.getUTCFullYear();
    const candidate = new Date(Date.UTC(y, month - 1, Math.min(day, 28)));
    if (candidate < now) y += 1;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // monthly / quarterly — use this month
  const m = now.getUTCMonth() + 1;
  const y = now.getUTCFullYear();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Update fields on a compliance row.
router.patch('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const allowed = await clientBranchIds(req);
  const row = db.get(`SELECT branch_id FROM vcfo_compliances WHERE id = ?`, id) as any;
  if (!row || !allowed.has(row.branch_id)) return res.status(404).json({ error: 'not found' });

  const fields: string[] = [];
  const params: any[] = [];
  const allowedFields = ['name', 'due_date', 'period_label', 'status', 'amount', 'assignee', 'notes'];
  const aliases: Record<string, string> = {
    dueDate: 'due_date',
    periodLabel: 'period_label',
  };
  for (const [k, dbCol] of Object.entries({ ...aliases, ...Object.fromEntries(allowedFields.map(f => [f, f])) })) {
    if (req.body[k] !== undefined) {
      fields.push(`${dbCol} = ?`);
      params.push(req.body[k]);
    }
  }
  if (fields.length === 0) return res.json(row);
  params.push(id);
  db.run(`UPDATE vcfo_compliances SET ${fields.join(', ')} WHERE id = ?`, params);
  res.json(db.get(`SELECT * FROM vcfo_compliances WHERE id = ?`, id));
});

// Mark filed + roll forward next period.
router.post('/:id/file', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const allowed = await clientBranchIds(req);
  const row = db.get(`SELECT * FROM vcfo_compliances WHERE id = ?`, id) as any;
  if (!row || !allowed.has(row.branch_id)) return res.status(404).json({ error: 'not found' });
  if (row.status === 'filed') return res.status(400).json({ error: 'already filed' });

  const filedAt = new Date().toISOString();
  db.run(
    `UPDATE vcfo_compliances SET status = 'filed', filed_at = ? WHERE id = ?`,
    [filedAt, id],
  );

  // Create next-period instance (history preserved).
  const nextDue = rollForward(row.due_date, row.frequency);
  const nextLabel = autoPeriodLabel(nextDue, row.frequency);
  db.run(
    `INSERT INTO vcfo_compliances
     (branch_id, catalog_id, name, category, frequency, due_date, period_label, status, amount, assignee, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    [row.branch_id, row.catalog_id, row.name, row.category, row.frequency, nextDue, nextLabel, row.assignee],
  );

  const updated = db.get(`SELECT * FROM vcfo_compliances WHERE id = ?`, id);
  const next = db.get(
    `SELECT * FROM vcfo_compliances WHERE branch_id = ? AND name = ? AND due_date = ?`,
    row.branch_id, row.name, nextDue,
  );
  res.json({ filed: updated, next });
});

// Delete a row.
router.delete('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const allowed = await clientBranchIds(req);
  const row = db.get(`SELECT branch_id FROM vcfo_compliances WHERE id = ?`, id) as any;
  if (!row || !allowed.has(row.branch_id)) return res.status(404).json({ error: 'not found' });
  db.run(`DELETE FROM vcfo_compliances WHERE id = ?`, id);
  res.status(204).end();
});

export default router;
