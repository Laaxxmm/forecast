import { Router, type Request, type Response } from 'express';
import { requireRole, requireIntegration } from '../middleware/auth.js';
import { encrypt } from '../utils/crypto.js';
import { branchSettingsKey, branchFilter, getBranchIdForInsert } from '../utils/branch.js';
import { runHealthplixSync } from '../services/sync/healthplix-runner.js';
import { runOneglanceSync } from '../services/sync/oneglance-runner.js';
import { parseTuriaInvoices } from '../services/parsers/turia.js';
import { findActiveScenarioForStream } from '../utils/scenarios.js';
import { getPlatformHelper } from '../db/platform-connection.js';
// Lazy-import Playwright sync modules (not available on cloud hosts)
const loadSyncTuria = () => import('../services/sync/turia-sync.js').then(m => m.syncTuria);
import fs from 'fs';
import path from 'path';

const router = Router();

const isProd = process.env.NODE_ENV === 'production';

// Per-tenant sync state for progress tracking. Exported so the auto-sync
// scheduler can peek at active manual runs and skip them rather than starting
// a second Chromium for the same (tenant, source).
export interface SyncState {
  activeSyncId: string | null;
  progress: { step: string; message: string; pct: number; error?: string; result?: any } | null;
}

// Turia sync state includes OTP callback
interface TuriaSyncState extends SyncState {
  otpResolver: ((otp: string) => void) | null;
}

export const hpSyncStates = new Map<string, SyncState>();
export const ogSyncStates = new Map<string, SyncState>();
const turiaSyncStates = new Map<string, TuriaSyncState>();

export function getHpState(slug: string): SyncState {
  if (!hpSyncStates.has(slug)) {
    hpSyncStates.set(slug, { activeSyncId: null, progress: null });
  }
  return hpSyncStates.get(slug)!;
}

export function getOgState(slug: string): SyncState {
  if (!ogSyncStates.has(slug)) {
    ogSyncStates.set(slug, { activeSyncId: null, progress: null });
  }
  return ogSyncStates.get(slug)!;
}

function getTuriaState(slug: string): TuriaSyncState {
  if (!turiaSyncStates.has(slug)) {
    turiaSyncStates.set(slug, { activeSyncId: null, progress: null, otpResolver: null });
  }
  return turiaSyncStates.get(slug)!;
}

// ─── Credential Management ───────────────────────────────────────────────────

router.get('/credentials/healthplix', requireIntegration('healthplix'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const username = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_username', _req));
  const clinic = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_clinic', _req));
  const hasPassword = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_password', _req));

  res.json({
    username: username?.value || '',
    clinicName: clinic?.value || '',
    hasPassword: !!hasPassword?.value,
  });
});

router.put('/credentials/healthplix', requireRole('admin', 'operational_head'), requireIntegration('healthplix'), async (req: Request, res: Response) => {
  const { username, password, clinicName } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const db = req.tenantDb!;
  const uKey = branchSettingsKey('healthplix_username', req);
  const cKey = branchSettingsKey('healthplix_clinic', req);
  const pKey = branchSettingsKey('healthplix_password', req);

  db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, uKey, username);

  db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, cKey, clinicName || '');

  if (password) {
    const encrypted = encrypt(password);
    db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, pKey, encrypted);
  }

  res.json({ ok: true });
});

router.delete('/credentials/healthplix', requireRole('admin', 'operational_head'), requireIntegration('healthplix'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const prefix = branchSettingsKey('healthplix_', _req);
  db.run("DELETE FROM app_settings WHERE key LIKE ?", prefix + '%');
  res.json({ ok: true });
});

// ─── Sync Trigger ─────────────────────────────────────────────────────────────

router.post('/healthplix', requireRole('admin', 'operational_head'), requireIntegration('healthplix'), async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.body;

  if (!fromDate || !toDate) {
    return res.status(400).json({ error: 'fromDate and toDate are required (YYYY-MM-DD)' });
  }

  const tenantSlug = req.tenantSlug!;
  const state = getHpState(tenantSlug);

  if (state.activeSyncId) {
    return res.status(409).json({ error: 'A sync is already in progress' });
  }

  const branchId = getBranchIdForInsert(req);
  const syncId = Date.now().toString();
  state.activeSyncId = syncId;
  state.progress = { step: 'starting', message: 'Initializing...', pct: 0 };

  // Respond immediately with syncId; runner executes in the background.
  res.json({ syncId, status: 'started' });

  try {
    const summary = await runHealthplixSync({
      tenantSlug,
      clientId: req.clientId!,
      ctx: req,
      branchId,
      fromDate,
      toDate,
      trigger: 'manual',
      onProgress: (step, message, pct) => {
        state.progress = { step, message, pct };
      },
    });

    state.progress = {
      step: 'complete',
      message: 'Sync completed successfully',
      pct: 100,
      result: {
        importId: summary.importId,
        ...summary.summary,
      },
    };
  } catch (err: any) {
    console.error(`[HP Sync] Failed for ${tenantSlug}:`, err.message);
    state.progress = {
      step: 'error',
      message: err.message || 'Sync failed',
      pct: 0,
      error: err.message || 'Sync failed',
    };
    // Clear lock immediately on error so user can retry
    state.activeSyncId = null;
  } finally {
    if (state.progress?.step === 'complete') {
      setTimeout(() => {
        if (state.activeSyncId === syncId) {
          state.activeSyncId = null;
          state.progress = null;
        }
      }, 60_000);
    }
  }
});

// ─── Progress Polling ─────────────────────────────────────────────────────────

router.get('/healthplix/status', (_req: Request, res: Response) => {
  const state = getHpState(_req.tenantSlug!);
  if (!state.activeSyncId && !state.progress) {
    return res.json({ status: 'idle' });
  }
  res.json({
    syncId: state.activeSyncId,
    status: state.progress?.step === 'complete' ? 'complete'
          : state.progress?.step === 'error' ? 'error'
          : 'running',
    ...state.progress,
  });
});

// ─── Reset stuck sync ─────────────────────────────────────────────────────────

router.post('/healthplix/reset', (_req: Request, res: Response) => {
  const state = getHpState(_req.tenantSlug!);
  state.activeSyncId = null;
  state.progress = null;
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ONEGLANCE SYNC
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Oneglance Credential Management ─────────────────────────────────────────

router.get('/credentials/oneglance', requireIntegration('oneglance'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const username = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('oneglance_username', _req));
  const hasPassword = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('oneglance_password', _req));

  res.json({
    username: username?.value || '',
    hasPassword: !!hasPassword?.value,
  });
});

router.put('/credentials/oneglance', requireRole('admin', 'operational_head'), requireIntegration('oneglance'), async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const db = req.tenantDb!;
  const uKey = branchSettingsKey('oneglance_username', req);
  const pKey = branchSettingsKey('oneglance_password', req);

  db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, uKey, username);

  if (password) {
    const encrypted = encrypt(password);
    db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, pKey, encrypted);
  }

  res.json({ ok: true });
});

router.delete('/credentials/oneglance', requireRole('admin', 'operational_head'), requireIntegration('oneglance'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const prefix = branchSettingsKey('oneglance_', _req);
  db.run("DELETE FROM app_settings WHERE key LIKE ?", prefix + '%');
  res.json({ ok: true });
});

// ─── Oneglance Sync ──────────────────────────────────────────────────────────

router.post('/oneglance', requireRole('admin', 'operational_head'), requireIntegration('oneglance'), async (req: Request, res: Response) => {
  const { fromDate, toDate, reportType } = req.body;

  if (!fromDate || !toDate) {
    return res.status(400).json({ error: 'fromDate and toDate are required (YYYY-MM-DD)' });
  }

  const tenantSlug = req.tenantSlug!;
  const ogState = getOgState(tenantSlug);

  if (ogState.activeSyncId) {
    return res.status(409).json({ error: 'An Oneglance sync is already in progress' });
  }

  const branchId = getBranchIdForInsert(req);
  const syncId = Date.now().toString();
  ogState.activeSyncId = syncId;
  ogState.progress = { step: 'starting', message: 'Initializing...', pct: 0 };

  res.json({ syncId, status: 'started' });

  try {
    const result = await runOneglanceSync({
      tenantSlug,
      clientId: req.clientId!,
      ctx: req,
      branchId,
      fromDate,
      toDate,
      reportType: reportType || 'both',
      trigger: 'manual',
      onProgress: (step, message, pct) => {
        ogState.progress = { step, message, pct };
      },
    });

    // Compose the final message. When stock failed but sales/purchase
    // succeeded (partial-success path for huge-inventory branches), surface
    // the stock failure as a warning rather than swallowing it — the user
    // needs to know to upload the stock CSV manually.
    const partialStockWarning = result.stockError
      ? ` · Stock report skipped (${result.stockError}). Download the stock CSV manually from OneGlance and upload via Import Data → Upload File.`
      : '';
    ogState.progress = {
      step: 'complete',
      message: `Sync completed — ${result.totalRows} rows imported${partialStockWarning}`,
      pct: 100,
      result: { totalRows: result.totalRows, stockError: result.stockError || null },
    };
  } catch (err: any) {
    console.error('[oneglance-sync] Error:', err.message || err);
    ogState.progress = {
      step: 'error',
      message: err.message || 'Sync failed',
      pct: 0,
      error: err.message || 'Sync failed',
    };
    ogState.activeSyncId = null;
  } finally {
    if (ogState.progress?.step === 'complete') {
      setTimeout(() => {
        if (ogState.activeSyncId === syncId) {
          ogState.activeSyncId = null;
          ogState.progress = null;
        }
      }, 60_000);
    }
  }
});

router.get('/oneglance/status', (_req: Request, res: Response) => {
  const ogState = getOgState(_req.tenantSlug!);
  if (!ogState.activeSyncId && !ogState.progress) {
    return res.json({ status: 'idle' });
  }
  res.json({
    syncId: ogState.activeSyncId,
    status: ogState.progress?.step === 'complete' ? 'complete'
          : ogState.progress?.step === 'error' ? 'error'
          : 'running',
    ...ogState.progress,
  });
});

router.post('/oneglance/reset', (_req: Request, res: Response) => {
  const ogState = getOgState(_req.tenantSlug!);
  ogState.activeSyncId = null;
  ogState.progress = null;
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TURIA SYNC (OTP-based)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Turia Credential Management ─────────────────────────────────────────────

router.get('/credentials/turia', requireIntegration('turia'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const phone = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('turia_phone', _req));
  const fy = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('turia_fy', _req));

  res.json({
    phoneNumber: phone?.value || '',
    financialYear: fy?.value || '',
    hasCredentials: !!phone?.value,
  });
});

router.put('/credentials/turia', requireRole('admin', 'operational_head'), requireIntegration('turia'), async (req: Request, res: Response) => {
  const { phoneNumber, financialYear } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

  const db = req.tenantDb!;
  const pKey = branchSettingsKey('turia_phone', req);
  const fKey = branchSettingsKey('turia_fy', req);

  db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, pKey, phoneNumber);

  if (financialYear) {
    db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, fKey, financialYear);
  }

  res.json({ ok: true });
});

router.delete('/credentials/turia', requireRole('admin', 'operational_head'), requireIntegration('turia'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const prefix = branchSettingsKey('turia_', _req);
  db.run("DELETE FROM app_settings WHERE key LIKE ?", prefix + '%');
  res.json({ ok: true });
});

// ─── Turia Sync Trigger ─────────────────────────────────────────────────────

router.post('/turia', requireRole('admin', 'operational_head'), requireIntegration('turia'), async (req: Request, res: Response) => {
  const tenantSlug = req.tenantSlug!;
  const state = getTuriaState(tenantSlug);

  if (state.activeSyncId) {
    return res.status(409).json({ error: 'A Turia sync is already in progress' });
  }

  const db = req.tenantDb!;
  const branchId = getBranchIdForInsert(req);
  const phoneRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('turia_phone', req));
  const fyRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('turia_fy', req));

  if (!phoneRow?.value) {
    return res.status(400).json({ error: 'Turia phone number not configured. Go to Settings to set it up.' });
  }

  const phoneNumber = phoneRow.value;
  const financialYear = req.body.financialYear || fyRow?.value || '2025-26';

  const syncId = Date.now().toString();
  state.activeSyncId = syncId;
  state.progress = { step: 'starting', message: 'Initializing Turia sync...', pct: 0 };
  state.otpResolver = null;

  res.json({ syncId, status: 'started' });

  try {
    const syncTuria = await loadSyncTuria();
    const result = await syncTuria({
      phoneNumber,
      financialYear,
      onProgress: (step, message, pct) => {
        state.progress = { step, message, pct };
      },
      onOtpRequired: () => {
        state.progress = { step: 'waiting_otp', message: 'Please enter the OTP sent to your phone', pct: 20 };
      },
      getOtp: () => new Promise<string>((resolve, reject) => {
        state.otpResolver = resolve;
        // Timeout after 5 minutes if no OTP provided
        setTimeout(() => {
          if (state.otpResolver === resolve) {
            state.otpResolver = null;
            reject(new Error('OTP entry timed out. Please try again.'));
          }
        }, 5 * 60 * 1000);
      }),
    });

    // Parse the downloaded file
    state.progress = { step: 'parsing', message: 'Parsing invoice data...', pct: 85 };
    const { rows, summary } = parseTuriaInvoices(result.filePath);

    state.progress = { step: 'saving', message: `Saving ${rows.length} invoices to database...`, pct: 92 };

    // Dedup: delete existing turia rows for THIS BRANCH on the dates being
    // re-synced. branch_id scope is MANDATORY.
    const turiaDatesToReplace = [...new Set(rows.map((r: any) => r.invoice_date).filter(Boolean))];
    if (turiaDatesToReplace.length > 0) {
      const ph = turiaDatesToReplace.map(() => '?').join(',');
      db.run(
        `DELETE FROM turia_invoices WHERE branch_id IS ? AND invoice_date IN (${ph})`,
        branchId, ...turiaDatesToReplace
      );
      console.log(`[turia-sync] Cleared existing data for branch=${branchId}, dates=${turiaDatesToReplace.length}`);
    }

    db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'TURIA_SYNC', result.filename, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId, result.filePath
    );
    const turiaImportId = db.get("SELECT id FROM import_logs WHERE source = 'TURIA_SYNC' ORDER BY id DESC LIMIT 1")?.id || 0;

    db.beginBatch();
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO turia_invoices (import_id, invoice_id, billing_org, client_name, gstin, service,
            sac_code, invoice_date, invoice_month, due_date, total_amount, status, branch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          turiaImportId, r.invoice_id, r.billing_org, r.client_name, r.gstin,
          r.service, r.sac_code, r.invoice_date, r.invoice_month, r.due_date,
          r.total_amount, r.status, branchId
        );
      }
      db.endBatch();
    } catch (e) { db.rollbackBatch(); throw e; }

    // Auto-sync consultancy revenue to dashboard_actuals
    // Strict: NULL-branch legacy rows excluded from the rebuild.
    const bf = branchFilter(req, { strict: true });
    const platformDb = await getPlatformHelper();
    const consultStream = req.clientId ? platformDb.get(
      "SELECT id FROM business_streams WHERE client_id = ? AND (LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%turia%') AND is_active = 1 LIMIT 1",
      req.clientId
    ) : null;
    const consultStreamId = consultStream?.id || null;
    // Canonical scenario helper — same scenario the dashboard read picks.
    // No fallback: a previous "last-ditch" `SELECT id, name FROM scenarios
    // WHERE is_default = 1 LIMIT 1` (no fy / branch / stream filter)
    // happily returned the wrong branch's scenario for multi-branch
    // tenants — Turia rows would land under branch A while branch B
    // owned the actuals (audit Critical #5). Better to skip the rollup
    // entirely if no proper scenario exists; admin can retry after
    // creating one via the Forecast page.
    const activeScenario: { id: number; name?: string } | null =
      findActiveScenarioForStream(db, req, consultStreamId);

    if (activeScenario) {
      console.log(`Turia: Using scenario ${activeScenario.id} (${activeScenario.name}) for dashboard_actuals`);

      // Aggregate ALL turia_invoices (not just current import) by month
      const turiaMonthly = db.all(
        `SELECT invoice_month as month, COALESCE(SUM(total_amount), 0) as total
         FROM turia_invoices WHERE invoice_month IS NOT NULL AND invoice_month != ''${bf.where}
         GROUP BY invoice_month`,
        ...bf.params
      );

      console.log(`Turia: Found ${turiaMonthly.length} monthly totals to sync to dashboard_actuals`);

      let syncedCount = 0;
      for (const row of turiaMonthly) {
        if (!row.month) continue;
        console.log(`Turia:   month=${row.month}, total=${row.total}`);
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Consultancy Revenue', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total, branchId, consultStreamId
        );
        syncedCount++;
      }
      console.log(`Turia: Synced ${syncedCount} months to dashboard_actuals`);

      // Verify the data was actually saved
      const verifyCount = db.get(
        `SELECT COUNT(*) as cnt FROM dashboard_actuals WHERE scenario_id = ? AND item_name = 'Consultancy Revenue'`,
        activeScenario.id
      );
      console.log(`Turia: Verification — ${verifyCount?.cnt || 0} Consultancy Revenue rows in dashboard_actuals`);
    } else {
      console.error('Turia: WARNING — No scenario found at all! Data saved to turia_invoices but NOT synced to dashboard_actuals.');
      console.error('Turia: Create a scenario in the Forecast module to enable automatic actuals sync.');
    }

    // Keep file for download from Import History

    // Count how many rows are in turia_invoices and dashboard_actuals for reporting
    const totalTuriaRows = db.get('SELECT COUNT(*) as cnt FROM turia_invoices')?.cnt || 0;
    const totalActualRows = db.get(
      `SELECT COUNT(*) as cnt FROM dashboard_actuals WHERE item_name = 'Consultancy Revenue'`
    )?.cnt || 0;

    state.progress = {
      step: 'complete',
      message: `Turia sync completed — ${rows.length} invoices imported, ${totalActualRows} monthly actuals synced`,
      pct: 100,
      result: {
        importId: turiaImportId,
        ...summary,
      },
    };
  } catch (err: any) {
    console.error('Turia sync error:', err.message, err.stack);
    state.progress = {
      step: 'error',
      message: err.message || 'Sync failed',
      pct: 0,
      error: err.message || 'Sync failed',
    };
    state.activeSyncId = null;
    state.otpResolver = null;
  } finally {
    if (state.progress?.step === 'complete') {
      setTimeout(() => {
        if (state.activeSyncId === syncId) {
          state.activeSyncId = null;
          state.progress = null;
          state.otpResolver = null;
        }
      }, 60_000);
    }
  }
});

// ─── Turia OTP Submission ────────────────────────────────────────────────────

router.post('/turia/otp', requireRole('admin', 'operational_head'), requireIntegration('turia'), async (req: Request, res: Response) => {
  const { otp } = req.body;
  if (!otp || typeof otp !== 'string' || otp.length < 4) {
    return res.status(400).json({ error: 'Please provide a valid OTP (at least 4 digits)' });
  }

  const state = getTuriaState(req.tenantSlug!);
  if (!state.activeSyncId) {
    return res.status(400).json({ error: 'No active Turia sync in progress' });
  }
  if (!state.otpResolver) {
    return res.status(400).json({ error: 'Sync is not waiting for OTP' });
  }

  state.otpResolver(otp);
  state.otpResolver = null;
  res.json({ ok: true });
});

// ─── Turia Progress Polling ──────────────────────────────────────────────────

router.get('/turia/status', (_req: Request, res: Response) => {
  const state = getTuriaState(_req.tenantSlug!);
  if (!state.activeSyncId && !state.progress) {
    return res.json({ status: 'idle' });
  }
  res.json({
    syncId: state.activeSyncId,
    status: state.progress?.step === 'complete' ? 'complete'
          : state.progress?.step === 'error' ? 'error'
          : state.progress?.step === 'waiting_otp' ? 'waiting_otp'
          : 'running',
    ...state.progress,
  });
});

// ─── Turia Reset ─────────────────────────────────────────────────────────────

router.post('/turia/reset', (_req: Request, res: Response) => {
  const state = getTuriaState(_req.tenantSlug!);
  state.activeSyncId = null;
  state.progress = null;
  state.otpResolver = null;
  res.json({ ok: true });
});

// ─── Debug Screenshots ──────────────────────────────────────────────────────

const persistentDir = process.env.DATA_DIR || (isProd ? '/data' : '.');

router.get('/debug/screenshots', (_req: Request, res: Response) => {
  const debugDir = path.join(persistentDir, 'uploads', 'debug');
  if (!fs.existsSync(debugDir)) {
    return res.json({ screenshots: [] });
  }
  const files = fs.readdirSync(debugDir)
    .filter(f => f.endsWith('.png') || f.endsWith('.html'))
    .sort();
  res.json({
    screenshots: files.map(f => ({
      name: f,
      url: `/api/sync/debug/screenshots/${f}`,
    })),
  });
});

router.get('/debug/screenshots/:filename', (req: Request, res: Response) => {
  const filename = req.params.filename;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const debugDir = path.join(persistentDir, 'uploads', 'debug');
  const filePath = path.join(debugDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(filePath);
});

export default router;
