// Auto-sync configuration + history + manual trigger.
// Mounted at /api/sync/auto in index.ts.

import { Router, type Request, type Response } from 'express';
import { requireRole, requireIntegration } from '../middleware/auth.js';
import { branchSettingsKey, branchFilter, getBranchIdForInsert } from '../utils/branch.js';
import { runAutoSyncOneOff } from '../services/scheduler/auto-sync.js';
import { getPlatformHelper } from '../db/platform-connection.js';

const router = Router();

const SOURCES = ['healthplix', 'oneglance'] as const;
type Source = typeof SOURCES[number];

function isSource(v: any): v is Source {
  return SOURCES.includes(v);
}

// ─── Read flags for the current branch ─────────────────────────────────
router.get('/config', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const out: Record<string, boolean> = {};
  for (const src of SOURCES) {
    const row = db.get(
      'SELECT value FROM app_settings WHERE key = ?',
      branchSettingsKey(`auto_sync_${src}_enabled`, req)
    );
    out[`${src}Enabled`] = row?.value === '1';
  }
  res.json(out);
});

// ─── Update flags for the current branch ───────────────────────────────
router.put('/config', requireRole('admin', 'operational_head'), async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const { healthplixEnabled, oneglanceEnabled } = req.body || {};

  if (typeof healthplixEnabled === 'boolean') {
    const key = branchSettingsKey('auto_sync_healthplix_enabled', req);
    db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      key, healthplixEnabled ? '1' : '0'
    );
  }
  if (typeof oneglanceEnabled === 'boolean') {
    const key = branchSettingsKey('auto_sync_oneglance_enabled', req);
    db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      key, oneglanceEnabled ? '1' : '0'
    );
  }
  res.json({ ok: true });
});

// ─── Recent auto-sync runs (branch-scoped) ─────────────────────────────
router.get('/history', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const source = req.query.source as string | undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || '20'), 100);
  const bf = branchFilter(req);

  const sourceClause = source && isSource(source) ? ' AND source = ?' : '';
  const sourceParams = source && isSource(source) ? [source] : [];

  const rows = db.all(
    `SELECT id, run_date_ist, branch_id, source, trigger, status,
            started_at, finished_at, rows_imported, import_id, error
     FROM auto_sync_runs
     WHERE 1=1${bf.where}${sourceClause}
     ORDER BY id DESC
     LIMIT ?`,
    ...bf.params, ...sourceParams, limit
  );
  res.json({ runs: rows });
});

// ─── Manual trigger for testing without waiting for 23:00 IST ─────────
router.post('/run-now', requireRole('admin', 'operational_head'), async (req: Request, res: Response) => {
  const { source } = req.body || {};
  if (!isSource(source)) {
    return res.status(400).json({ error: 'source must be "healthplix" or "oneglance"' });
  }

  // Re-use the same integration check the manual sync routes use.
  const platformDb = (await import('../db/platform-connection.js')).getPlatformHelper();
  const integration = (await platformDb).get(
    'SELECT is_enabled FROM client_integrations WHERE client_id = ? AND integration_key = ?',
    req.clientId, source
  );
  if (req.userType !== 'super_admin' && !integration?.is_enabled) {
    return res.status(403).json({ error: `Integration "${source}" is not enabled for this client` });
  }

  // Confirm the per-branch opt-in flag is set — refuse to run if not, so
  // /run-now stays consistent with what the schedule would do.
  const flagRow = req.tenantDb!.get(
    'SELECT value FROM app_settings WHERE key = ?',
    branchSettingsKey(`auto_sync_${source}_enabled`, req)
  );
  if (flagRow?.value !== '1') {
    return res.status(400).json({ error: 'Auto-sync for this source is not enabled on this branch' });
  }

  const branchId = getBranchIdForInsert(req);
  res.json({ status: 'started' });

  // Fire-and-forget — runner manages its own lock + auto_sync_runs row.
  runAutoSyncOneOff({
    clientId: req.clientId!,
    slug: req.tenantSlug!,
    branchId,
    isMultiBranch: !!req.isMultiBranch,
    source,
  }).catch(err => console.error('[auto-sync] /run-now error:', err));
});

// ─── Auto-Sync Health: tenant-wide last-N-days matrix ──────────────────
// Returns the data the Admin → Auto-Sync Health page renders. One row
// per (branch × source) tuple, one column per day in the requested
// window, plus the per-branch opt-in flag for each source so the UI
// can flag "not enabled" cells distinctly from "enabled but never ran".
//
// Auth: admin / operational_head / super_admin. Scoped to the caller's
// current tenant via req.tenantDb + req.clientId.
router.get('/health', requireRole('admin', 'operational_head'), async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const clientId = req.clientId!;
  const days = Math.min(Math.max(parseInt((req.query.days as string) || '7'), 1), 30);

  // Build the day window in IST (most recent last). Same formula the
  // scheduler uses for run_date_ist so the JOIN keys match exactly.
  const tz = 'Asia/Kolkata';
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dayList.push(d.toISOString().slice(0, 10));
  }
  const oldestDay = dayList[0];

  const platformDb = await getPlatformHelper();

  // Branch list. Multi-branch tenants enumerate from platform DB;
  // single-branch tenants get one synthetic "All branches" row with
  // id=null so the UI can still show their runs.
  const clientRow = platformDb.get(
    'SELECT slug, is_multi_branch, name FROM clients WHERE id = ?',
    clientId,
  );
  const isMultiBranch = !!clientRow?.is_multi_branch;
  let branchList: Array<{
    id: number | null;
    name: string;
    code: string | null;
    city: string | null;
    role: string;
    is_user_visible: number;
  }>;
  if (isMultiBranch) {
    branchList = platformDb.all(
      `SELECT id, name, code, city,
              COALESCE(branch_role, 'standalone') as role,
              COALESCE(is_user_visible, 1) as is_user_visible
         FROM branches
        WHERE client_id = ? AND is_active = 1
        ORDER BY COALESCE(city, ''), name`,
      clientId,
    );
  } else {
    branchList = [{
      id: null,
      name: clientRow?.name || 'All branches',
      code: null,
      city: null,
      role: 'standalone',
      is_user_visible: 1,
    }];
  }

  // Per-branch enablement flags. Bulk-load all rows then filter in JS —
  // single-branch tenants store the key without a `branch_<id>__` prefix,
  // multi-branch tenants prefix it.
  const allFlags: Array<{ key: string; value: string | null }> = db.all(
    `SELECT key, value FROM app_settings WHERE key LIKE 'auto_sync_%_enabled' OR key LIKE 'branch_%_auto_sync_%_enabled'`,
  );
  const flagFor = (branchId: number | null, src: Source): boolean => {
    const target = isMultiBranch && branchId
      ? `branch_${branchId}__auto_sync_${src}_enabled`
      : `auto_sync_${src}_enabled`;
    const row = allFlags.find(f => f.key === target);
    return row?.value === '1';
  };

  // Pull every run row in the window for this tenant, then bucket by
  // (branch_id, source, run_date_ist) in JS. Also de-duplicate when
  // multiple triggers ran for the same key — prefer the freshest by
  // started_at.
  const runRows: Array<{
    id: number;
    run_date_ist: string;
    branch_id: number | null;
    source: string;
    trigger: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    rows_imported: number | null;
    import_id: number | null;
    error: string | null;
  }> = db.all(
    `SELECT id, run_date_ist, branch_id, source, trigger, status,
            started_at, finished_at, rows_imported, import_id, error
       FROM auto_sync_runs
      WHERE run_date_ist >= ?
      ORDER BY started_at ASC`,
    oldestDay,
  );

  type CellRun = {
    status: string;
    trigger: string;
    started_at: string;
    finished_at: string | null;
    rows_imported: number | null;
    import_id: number | null;
    error: string | null;
    runId: number;
  };
  // Map: `${branchId}|${source}|${date}` → latest run for that cell.
  const cellMap = new Map<string, CellRun>();
  // Map: `${branchId}|${source}|${date}` → array of all runs (so a failed
  // schedule run + a successful catchup retry are both visible).
  const cellAttempts = new Map<string, CellRun[]>();
  for (const r of runRows) {
    const key = `${r.branch_id ?? 'null'}|${r.source}|${r.run_date_ist}`;
    const cellRun: CellRun = {
      status: r.status,
      trigger: r.trigger,
      started_at: r.started_at,
      finished_at: r.finished_at,
      rows_imported: r.rows_imported,
      import_id: r.import_id,
      error: r.error,
      runId: r.id,
    };
    // Latest = highest priority status, then most recent. Order:
    // success > running > failed > skipped (so a failed schedule +
    // successful catchup shows as success, not failed).
    const priority = (s: string) =>
      s === 'success' ? 4 : s === 'running' ? 3 : s === 'failed' ? 2 : 1;
    const existing = cellMap.get(key);
    if (!existing || priority(cellRun.status) > priority(existing.status)) {
      cellMap.set(key, cellRun);
    } else if (priority(cellRun.status) === priority(existing.status)
               && cellRun.started_at > existing.started_at) {
      cellMap.set(key, cellRun);
    }
    if (!cellAttempts.has(key)) cellAttempts.set(key, []);
    cellAttempts.get(key)!.push(cellRun);
  }

  // Assemble response.
  const result = {
    tenantSlug: clientRow?.slug || req.tenantSlug,
    tenantName: clientRow?.name || null,
    isMultiBranch,
    days: dayList,
    branches: branchList.map(b => ({
      id: b.id,
      name: b.name,
      code: b.code,
      city: b.city,
      role: b.role,
      is_user_visible: b.is_user_visible,
      sources: SOURCES.map(src => ({
        key: src,
        enabled: flagFor(b.id, src),
        runs: dayList.map(date => {
          const key = `${b.id ?? 'null'}|${src}|${date}`;
          const cell = cellMap.get(key);
          const attempts = cellAttempts.get(key) || [];
          return {
            date,
            cell: cell || null,
            attemptCount: attempts.length,
          };
        }),
      })),
    })),
  };

  res.json(result);
});

// ─── Recent failure count (for the in-app banner) ──────────────────────
// Lightweight query — counts failed runs in the last N days for the
// current tenant. Frontend polls this on dashboard / import-page load.
router.get('/failures-recent', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const days = Math.min(Math.max(parseInt((req.query.days as string) || '2'), 1), 14);
  const tz = 'Asia/Kolkata';
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Count distinct (branch, source, date) tuples that have a failed
  // status for their LATEST attempt — i.e. retries have not (yet)
  // succeeded. Skipped doesn't count as a failure (the manual run took
  // precedence).
  const rows: Array<{ branch_id: number | null; source: string; run_date_ist: string; status: string }> = db.all(
    `WITH latest AS (
       SELECT branch_id, source, run_date_ist,
              MAX(started_at) AS started_at
         FROM auto_sync_runs
        WHERE run_date_ist >= ?
        GROUP BY branch_id, source, run_date_ist
     )
     SELECT a.branch_id, a.source, a.run_date_ist, a.status
       FROM auto_sync_runs a
       JOIN latest l ON a.branch_id IS l.branch_id
                    AND a.source = l.source
                    AND a.run_date_ist = l.run_date_ist
                    AND a.started_at = l.started_at`,
    cutoffStr,
  );
  const failures = rows.filter(r => r.status === 'failed');
  res.json({
    failureCount: failures.length,
    failures: failures.map(f => ({
      branch_id: f.branch_id,
      source: f.source,
      date: f.run_date_ist,
    })),
  });
});

export default router;
