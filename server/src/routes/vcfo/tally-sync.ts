/**
 * VCFO Tally Sync — Connection, sync trigger, progress polling
 */
import { Router, Request, Response } from 'express';
import { TallyConnector } from '../../services/tally/tally-connector.js';
import { DataExtractor, type ProgressInfo } from '../../services/tally/data-extractor.js';

const router = Router();

// Per-client sync state
interface SyncState {
  inProgress: boolean;
  progress: ProgressInfo | null;
}
const syncStates = new Map<string, SyncState>();

function getSyncKey(req: Request): string {
  return `${req.tenantSlug}-${req.branchId || 'all'}`;
}

function getState(req: Request): SyncState {
  const key = getSyncKey(req);
  if (!syncStates.has(key)) syncStates.set(key, { inProgress: false, progress: null });
  return syncStates.get(key)!;
}

// Helper to get Tally host/port from tenant settings
function getTallyConfig(req: Request): { host: string; port: number } {
  const db = req.tenantDb!;
  const hostRow = db.get("SELECT value FROM vcfo_app_settings WHERE key = 'tally_host'");
  const portRow = db.get("SELECT value FROM vcfo_app_settings WHERE key = 'tally_port'");
  return {
    host: hostRow?.value || 'localhost',
    port: parseInt(portRow?.value || '9000'),
  };
}

// ── Tally connection status ──────────────────────────────────────────────────

router.get('/status', async (req: Request, res: Response) => {
  try {
    const { host, port } = getTallyConfig(req);
    const tally = new TallyConnector({ host, port });
    const health = await tally.healthCheck();
    const state = getState(req);
    res.json({
      tally: health,
      sync: { inProgress: state.inProgress, progress: state.progress },
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── List companies from live Tally ───────────────────────────────────────────

router.get('/companies', async (req: Request, res: Response) => {
  const { host, port } = getTallyConfig(req);
  const tally = new TallyConnector({ host, port });
  try {
    const companies = await tally.getCompanies();

    // Enrich with DB sync status
    const db = req.tenantDb!;
    const enriched = companies.map(tc => {
      const dbRec = db.get(
        'SELECT id, last_sync_at, fy_from, fy_to FROM vcfo_companies WHERE name = ? AND is_active = 1',
        tc.name
      );
      return {
        ...tc,
        dbCompanyId: dbRec?.id || null,
        lastSyncAt: dbRec?.last_sync_at || null,
      };
    });
    res.json({ companies: enriched });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Trigger sync ─────────────────────────────────────────────────────────────

router.post('/sync', async (req: Request, res: Response) => {
  const state = getState(req);
  if (state.inProgress) return res.status(409).json({ error: 'Sync already in progress' });

  const { companyName, fromDate, toDate, forceResync } = req.body;
  if (!companyName || !fromDate || !toDate) {
    return res.status(400).json({ error: 'companyName, fromDate, toDate required' });
  }

  const db = req.tenantDb!;
  const branchId = req.branchId;
  const { host, port } = getTallyConfig(req);

  // Ensure company exists in vcfo_companies
  db.run(
    'INSERT OR IGNORE INTO vcfo_companies (name, branch_id) VALUES (?,?)',
    companyName, branchId
  );
  const company = db.get(
    'SELECT * FROM vcfo_companies WHERE name = ? AND (branch_id = ? OR branch_id IS NULL)',
    companyName, branchId
  );
  if (!company) return res.status(500).json({ error: 'Failed to register company' });

  state.inProgress = true;
  state.progress = { step: 'init', status: 'running', message: 'Starting...' };

  const extractor = new DataExtractor(db, {
    host, port,
    onProgress: (p) => { state.progress = p; },
  }, branchId);

  // Pre-flight check
  const alive = await extractor.tally.ping();
  if (!alive) {
    state.inProgress = false;
    return res.status(503).json({ error: 'Tally is not reachable' });
  }

  // Run sync in background
  extractor.runFullSync(company.id, companyName, fromDate, toDate, { forceResync: !!forceResync })
    .then(results => {
      db.run(
        'UPDATE vcfo_companies SET last_sync_at=?, fy_from=?, fy_to=? WHERE id=?',
        new Date().toISOString(), fromDate, toDate, company.id
      );
      state.inProgress = false;
      state.progress = { step: 'complete', status: 'done', message: 'Sync complete', results };
    })
    .catch(err => {
      state.inProgress = false;
      state.progress = { step: 'error', status: 'error', message: err.message };
    });

  res.json({ message: 'Sync started', companyId: company.id });
});

// ── Poll sync progress ───────────────────────────────────────────────────────

router.get('/sync/progress', (req: Request, res: Response) => {
  try {
    const state = getState(req);
    res.json({ inProgress: state.inProgress, progress: state.progress });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Sync log ─────────────────────────────────────────────────────────────────

router.get('/sync/log', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : null;
    let sql = 'SELECT * FROM vcfo_sync_log';
    const params: any[] = [];
    if (companyId) {
      sql += ' WHERE company_id = ?';
      params.push(companyId);
    }
    sql += ' ORDER BY id DESC LIMIT 100';
    res.json(db.all(sql, ...params));
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Tally credentials (host/port) ────────────────────────────────────────────

router.get('/credentials', (req: Request, res: Response) => {
  try {
    const { host, port } = getTallyConfig(req);
    res.json({ host, port });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/credentials', (req: Request, res: Response) => {
  try {
    const db = req.tenantDb!;
    const { host, port } = req.body;
    if (host) db.run("INSERT OR REPLACE INTO vcfo_app_settings (key, value, updated_at) VALUES ('tally_host', ?, datetime('now'))", host);
    if (port) db.run("INSERT OR REPLACE INTO vcfo_app_settings (key, value, updated_at) VALUES ('tally_port', ?, datetime('now'))", String(port));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
