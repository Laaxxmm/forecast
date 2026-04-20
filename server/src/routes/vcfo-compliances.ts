// ─────────────────────────────────────────────────────────────────────────────
// VCFO Compliances routes.
//
// Applicability model (scope_type):
//   state  — one filing covers a whole state (GSTIN, TAN, PT). The
//            `state` column holds the two-letter code; `branch_id` points
//            at a representative branch just to satisfy NOT NULL.
//   branch — per-establishment (Drug Licence, Clinical Estd, PF, ESI, etc.).
//            branch_id is the owning branch.
//   stream — stream-specific at a given branch (pharmacy-only licence).
//            Both branch_id and stream_id are populated.
//
// Filtering honours the sidebar context (req.branchId, req.streamId from
// the resolveBranch middleware). When a branch is picked:
//   state-scope rows   → state = <that branch's state>
//   branch-scope rows  → branch_id = <that branch>
//   stream-scope rows  → branch_id = <that branch> (+ stream_id if a
//                        specific stream is picked in the sidebar)
// When no branch is picked the query returns every row the client owns.
//
// Endpoints:
//   GET  /api/vcfo/compliances                 — scoped list
//   GET  /api/vcfo/compliances/catalog         — master list, optionally state-filtered
//   GET  /api/vcfo/compliances/branches        — branches with state (picker)
//   GET  /api/vcfo/compliances/streams         — streams for selected branch
//   POST /api/vcfo/compliances                 — create; scope object required
//   PATCH /api/vcfo/compliances/:id            — update fields
//   POST /api/vcfo/compliances/:id/file        — mark filed + rollforward next period
//   DELETE /api/vcfo/compliances/:id           — delete
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { getPlatformHelper } from '../db/platform-connection.js';

const router = Router();

interface BranchRow { id: number; name: string; code: string | null; city: string | null; state: string | null }

async function clientBranches(req: Request): Promise<BranchRow[]> {
  const platformDb = await getPlatformHelper();
  return platformDb.all(
    `SELECT id, name, code, city, state FROM branches
     WHERE client_id = ? AND is_active = 1
     ORDER BY sort_order, name`,
    req.clientId,
  ) as BranchRow[];
}

async function branchStreamIds(branchId: number): Promise<number[]> {
  const platformDb = await getPlatformHelper();
  const rows = platformDb.all(
    `SELECT stream_id FROM branch_streams WHERE branch_id = ?`,
    branchId,
  ) as Array<{ stream_id: number }>;
  return rows.map(r => r.stream_id);
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
function rollForward(dueDate: string, frequency: string): string {
  const [y, m, d] = dueDate.split('-').map(n => parseInt(n, 10));
  const step = frequency === 'monthly' ? 1
    : frequency === 'quarterly' ? 3
    : frequency === 'half-yearly' ? 6
    : 12;
  const dt = new Date(Date.UTC(y, m - 1 + step, d));
  if (dt.getUTCMonth() !== ((m - 1 + step) % 12 + 12) % 12) {
    dt.setUTCDate(0);
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
  const m = now.getUTCMonth() + 1;
  const y = now.getUTCFullYear();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Endpoints ──────────────────────────────────────────────────────────────

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

router.get('/branches', async (req: Request, res: Response) => {
  const rows = await clientBranches(req);
  res.json(rows);
});

router.get('/streams', async (req: Request, res: Response) => {
  const branchId = toInt(req.query.branchId);
  if (branchId === null) return res.status(400).json({ error: 'branchId required' });
  const branches = await clientBranches(req);
  if (!branches.find(b => b.id === branchId)) {
    return res.status(404).json({ error: 'branch not found' });
  }
  const platformDb = await getPlatformHelper();
  const rows = platformDb.all(
    `SELECT bs.stream_id, s.name, s.slug, s.icon
     FROM branch_streams bs
     JOIN business_streams s ON bs.stream_id = s.id
     WHERE bs.branch_id = ? AND s.is_active = 1
     ORDER BY s.sort_order, s.name`,
    branchId,
  );
  res.json(rows);
});

// List compliance instances. Honours sidebar branch/stream context via the
// middleware-populated req.branchId / req.streamId. `branchId` / `streamId`
// query params override the sidebar choice when explicitly passed.
router.get('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const branches = await clientBranches(req);
  if (branches.length === 0) return res.json([]);
  const allowedIds = branches.map(b => b.id);
  const branchById = new Map(branches.map(b => [b.id, b] as const));

  const overrideBranch = toInt(req.query.branchId);
  const overrideStream = toInt(req.query.streamId);
  const branchCtx =
    overrideBranch !== null ? overrideBranch :
    req.branchId != null ? req.branchId :
    null;
  const streamCtx =
    overrideStream !== null ? overrideStream :
    req.streamId != null ? req.streamId :
    null;

  const status = String(req.query.status || '').trim();
  const from = isoDate(req.query.from);
  const to = isoDate(req.query.to);

  const where: string[] = [];
  const params: any[] = [];

  where.push(`branch_id IN (${allowedIds.join(',')})`);

  if (branchCtx !== null) {
    const branch = branchById.get(branchCtx);
    if (!branch) return res.json([]);
    const state = (branch.state || '').toUpperCase();
    const streamIdsForBranch = await branchStreamIds(branchCtx);
    const streamClause = streamIdsForBranch.length
      ? `stream_id IN (${streamIdsForBranch.join(',')})`
      : `0 = 1`;
    const streamFilter = streamCtx !== null
      ? `stream_id = ${streamCtx}`
      : streamClause;
    where.push(
      `((scope_type = 'branch' AND branch_id = ?)` +
      ` OR (scope_type = 'state' AND state = ?)` +
      ` OR (scope_type = 'stream' AND branch_id = ? AND ${streamFilter}))`,
    );
    params.push(branchCtx, state, branchCtx);
  }

  if (status) {
    where.push('status = ?');
    params.push(status);
  } else {
    // Default list hides soft-cancelled rows (service was disabled). Pass
    // ?status=cancelled explicitly if you want to see them.
    where.push(`status != 'cancelled'`);
  }
  if (from)   { where.push('due_date >= ?'); params.push(from); }
  if (to)     { where.push('due_date <= ?'); params.push(to); }

  const rows = db.all(
    `SELECT * FROM vcfo_compliances WHERE ${where.join(' AND ')} ORDER BY due_date ASC, id ASC`,
    ...params,
  );
  res.json(rows);
});

// Create a compliance row. Accepts either:
//   { scope: { type: 'state',  state: 'KA', branchId: 5 }, catalogId, ... }
//   { scope: { type: 'branch', branchId: 5 },              catalogId, ... }
//   { scope: { type: 'stream', branchId: 5, streamId: 12 },catalogId, ... }
// For backwards compat also accepts a top-level `branchId` with implicit
// scope='branch'.
router.post('/', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const branches = await clientBranches(req);
  const branchById = new Map(branches.map(b => [b.id, b] as const));

  const scope = req.body.scope || {};
  const scopeType = String(scope.type || 'branch').toLowerCase();
  if (!['state', 'branch', 'stream'].includes(scopeType)) {
    return res.status(400).json({ error: 'scope.type must be state | branch | stream' });
  }

  // Resolve branchId (always needed — for state scope we store a representative).
  const rawBranchId = toInt(scope.branchId) ?? toInt(req.body.branchId);
  if (rawBranchId === null || !branchById.has(rawBranchId)) {
    return res.status(400).json({ error: 'branchId is required and must belong to this client' });
  }
  const branch = branchById.get(rawBranchId)!;

  let state: string | null = null;
  let streamId: number | null = null;
  if (scopeType === 'state') {
    state = String(scope.state || branch.state || '').toUpperCase() || null;
    if (!state) return res.status(400).json({ error: 'scope.state is required for state-scope compliance' });
  } else if (scopeType === 'stream') {
    streamId = toInt(scope.streamId);
    if (streamId === null) return res.status(400).json({ error: 'scope.streamId is required for stream-scope compliance' });
    const validStreams = await branchStreamIds(rawBranchId);
    if (!validStreams.includes(streamId)) {
      return res.status(400).json({ error: 'streamId does not belong to this branch' });
    }
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
     (branch_id, scope_type, state, stream_id, catalog_id, name, category, frequency,
      due_date, period_label, status, amount, assignee, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [rawBranchId, scopeType, state, streamId, catalogId, name, category, frequency,
     dueDate, periodLabel, amount, assignee, notes],
  );
  const row = db.get(
    `SELECT * FROM vcfo_compliances WHERE branch_id = ? AND name = ? AND due_date = ? ORDER BY id DESC LIMIT 1`,
    rawBranchId, name, dueDate,
  );
  res.status(201).json(row);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const branches = await clientBranches(req);
  const allowedIds = new Set(branches.map(b => b.id));
  const row = db.get(`SELECT branch_id FROM vcfo_compliances WHERE id = ?`, id) as any;
  if (!row || !allowedIds.has(row.branch_id)) return res.status(404).json({ error: 'not found' });

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

router.post('/:id/file', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const branches = await clientBranches(req);
  const allowedIds = new Set(branches.map(b => b.id));
  const row = db.get(`SELECT * FROM vcfo_compliances WHERE id = ?`, id) as any;
  if (!row || !allowedIds.has(row.branch_id)) return res.status(404).json({ error: 'not found' });
  if (row.status === 'filed') return res.status(400).json({ error: 'already filed' });

  const filedAt = new Date().toISOString();
  db.run(
    `UPDATE vcfo_compliances SET status = 'filed', filed_at = ? WHERE id = ?`,
    [filedAt, id],
  );

  const nextDue = rollForward(row.due_date, row.frequency);
  const nextLabel = autoPeriodLabel(nextDue, row.frequency);
  db.run(
    `INSERT INTO vcfo_compliances
     (branch_id, scope_type, state, stream_id, catalog_id, name, category, frequency,
      due_date, period_label, status, amount, assignee, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    [row.branch_id, row.scope_type || 'branch', row.state, row.stream_id, row.catalog_id,
     row.name, row.category, row.frequency, nextDue, nextLabel, row.assignee],
  );

  const updated = db.get(`SELECT * FROM vcfo_compliances WHERE id = ?`, id);
  const next = db.get(
    `SELECT * FROM vcfo_compliances WHERE branch_id = ? AND name = ? AND due_date = ?`,
    row.branch_id, row.name, nextDue,
  );
  res.json({ filed: updated, next });
});

router.delete('/:id', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const id = toInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'id must be integer' });
  const branches = await clientBranches(req);
  const allowedIds = new Set(branches.map(b => b.id));
  const row = db.get(`SELECT branch_id FROM vcfo_compliances WHERE id = ?`, id) as any;
  if (!row || !allowedIds.has(row.branch_id)) return res.status(404).json({ error: 'not found' });
  db.run(`DELETE FROM vcfo_compliances WHERE id = ?`, id);
  res.status(204).end();
});

export default router;
