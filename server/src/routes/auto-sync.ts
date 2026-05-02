// Auto-sync configuration + history + manual trigger.
// Mounted at /api/sync/auto in index.ts.

import { Router, type Request, type Response } from 'express';
import { requireRole, requireIntegration } from '../middleware/auth.js';
import { branchSettingsKey, branchFilter, getBranchIdForInsert } from '../utils/branch.js';
import { runAutoSyncOneOff } from '../services/scheduler/auto-sync.js';

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

export default router;
