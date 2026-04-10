import { Router, type Request, type Response } from 'express';
import { requireAdmin, requireIntegration } from '../middleware/auth.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { branchFilter, getBranchIdForInsert, branchSettingsKey } from '../utils/branch.js';
import { getPlatformHelper } from '../db/platform-connection.js';
import { parseHealthplix } from '../services/parsers/healthplix.js';
import { parseOneglanceSales } from '../services/parsers/oneglance-sales.js';
import { parseOneglancePurchase } from '../services/parsers/oneglance-purchase.js';
import { parseOneglanceStock } from '../services/parsers/oneglance-stock.js';
import { parseTuriaInvoices } from '../services/parsers/turia.js';
// Lazy-import Playwright sync modules (not available on cloud hosts)
const loadSyncHealthplix = () => import('../services/sync/healthplix-sync.js').then(m => m.syncHealthplix);
const loadSyncOneglance = () => import('../services/sync/oneglance-sync.js').then(m => m.syncOneglance);
const loadSyncTuria = () => import('../services/sync/turia-sync.js').then(m => m.syncTuria);
import fs from 'fs';
import path from 'path';

const router = Router();

const isProd = process.env.NODE_ENV === 'production';

// Per-tenant sync state for progress tracking
interface SyncState {
  activeSyncId: string | null;
  progress: { step: string; message: string; pct: number; error?: string; result?: any } | null;
}

// Turia sync state includes OTP callback
interface TuriaSyncState extends SyncState {
  otpResolver: ((otp: string) => void) | null;
}

const hpSyncStates = new Map<string, SyncState>();
const ogSyncStates = new Map<string, SyncState>();
const turiaSyncStates = new Map<string, TuriaSyncState>();

function getHpState(slug: string): SyncState {
  if (!hpSyncStates.has(slug)) {
    hpSyncStates.set(slug, { activeSyncId: null, progress: null });
  }
  return hpSyncStates.get(slug)!;
}

function getOgState(slug: string): SyncState {
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

router.put('/credentials/healthplix', requireAdmin, requireIntegration('healthplix'), async (req: Request, res: Response) => {
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

router.delete('/credentials/healthplix', requireAdmin, requireIntegration('healthplix'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const prefix = branchSettingsKey('healthplix_', _req);
  db.run("DELETE FROM app_settings WHERE key LIKE ?", prefix + '%');
  res.json({ ok: true });
});

// ─── Sync Trigger ─────────────────────────────────────────────────────────────

router.post('/healthplix', requireAdmin, requireIntegration('healthplix'), async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.body;

  if (!fromDate || !toDate) {
    return res.status(400).json({ error: 'fromDate and toDate are required (YYYY-MM-DD)' });
  }

  const tenantSlug = req.tenantSlug!;
  const state = getHpState(tenantSlug);

  if (state.activeSyncId) {
    return res.status(409).json({ error: 'A sync is already in progress' });
  }

  // Load credentials (branch-scoped)
  const db = req.tenantDb!;
  const branchId = getBranchIdForInsert(req);
  const usernameRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_username', req));
  const passwordRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_password', req));
  const clinicRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('healthplix_clinic', req));

  if (!usernameRow?.value || !passwordRow?.value) {
    return res.status(400).json({ error: 'Healthplix credentials not configured. Go to Settings to set them up.' });
  }

  const username = usernameRow.value;
  const password = decrypt(passwordRow.value);
  const clinicName = clinicRow?.value || 'MagnaCode Bangalore';

  // Start sync
  const syncId = Date.now().toString();
  state.activeSyncId = syncId;
  state.progress = { step: 'starting', message: 'Initializing...', pct: 0 };

  // Run sync in background, respond immediately with syncId
  res.json({ syncId, status: 'started' });

  try {
    const syncHealthplix = await loadSyncHealthplix();
    const result = await syncHealthplix({
      username,
      password,
      clinicName,
      fromDate,
      toDate,
      headless: true,
      onProgress: (step, message, pct) => {
        state.progress = { step, message, pct };
      },
    });

    // Parse the downloaded file through existing parser
    state.progress = { step: 'parsing', message: 'Parsing downloaded report...', pct: 92 };

    const { rows, summary } = parseHealthplix(result.filePath);

    state.progress = { step: 'saving', message: `Saving ${rows.length} rows to database...`, pct: 95 };

    // Insert into DB (same logic as import.ts)
    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'HEALTHPLIX_SYNC', result.filename, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO clinic_actuals (import_id, bill_date, bill_month, patient_id, patient_name, order_number,
          billed, paid, discount, tax, refund, due, addl_disc, item_price, item_disc,
          department, service_name, billed_doctor, service_owner, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, r.bill_date, r.bill_month, r.patient_id, r.patient_name,
        r.order_number, r.billed, r.paid, r.discount, r.tax, r.refund, r.due,
        r.addl_disc, r.item_price, r.item_disc, r.department, r.service_name,
        r.billed_doctor, r.service_owner, branchId
      );
    }

    // Auto-add doctors
    const doctors = [...new Set(rows.map((r: any) => r.billed_doctor).filter((d: any) => d && d !== '-'))];
    for (const d of doctors) {
      db.run('INSERT OR IGNORE INTO doctors (name) VALUES (?)', d);
    }

    // Auto-sync actuals to dashboard for the active scenario
    const activeScenario = db.get(
      `SELECT s.id FROM scenarios s
       JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND s.is_default = 1
       LIMIT 1`
    );
    if (activeScenario) {
      // Aggregate clinic revenue into dashboard_actuals (branch-scoped)
      const bf = branchFilter(req);
      // Look up the clinic stream_id to tag dashboard entries
      const platformDb = await getPlatformHelper();
      const clinicStream = req.clientId ? platformDb.get(
        "SELECT id FROM business_streams WHERE client_id = ? AND (LOWER(name) LIKE '%clinic%' OR LOWER(name) LIKE '%health%') AND is_active = 1 LIMIT 1",
        req.clientId
      ) : null;
      const clinicStreamId = clinicStream?.id || null;
      // Clear old Clinic Revenue entries before re-syncing (prevents stale month data)
      db.run(
        `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Clinic Revenue'${bf.where}`,
        activeScenario.id, ...bf.params
      );
      const clinicMonthly = db.all(
        `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
         FROM clinic_actuals WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where} GROUP BY bill_month`,
        ...bf.params
      );
      for (const row of clinicMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
           VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total, branchId, clinicStreamId
        );
      }
    }

    // Clean up downloaded file
    try { fs.unlinkSync(result.filePath); } catch {}

    state.progress = {
      step: 'complete',
      message: 'Sync completed successfully',
      pct: 100,
      result: {
        importId: importLog.lastInsertRowid,
        ...summary,
      },
    };
  } catch (err: any) {
    state.progress = {
      step: 'error',
      message: isProd ? 'Sync failed' : (err.message || 'Sync failed'),
      pct: 0,
      error: isProd ? 'Sync failed' : err.message,
    };
    // Clear lock immediately on error so user can retry
    state.activeSyncId = null;
  } finally {
    // Clear completed sync state after a delay so status can be polled
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

router.put('/credentials/oneglance', requireAdmin, requireIntegration('oneglance'), async (req: Request, res: Response) => {
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

router.delete('/credentials/oneglance', requireAdmin, requireIntegration('oneglance'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const prefix = branchSettingsKey('oneglance_', _req);
  db.run("DELETE FROM app_settings WHERE key LIKE ?", prefix + '%');
  res.json({ ok: true });
});

// ─── Oneglance Sync ──────────────────────────────────────────────────────────

router.post('/oneglance', requireAdmin, requireIntegration('oneglance'), async (req: Request, res: Response) => {
  const { fromDate, toDate, reportType } = req.body;

  if (!fromDate || !toDate) {
    return res.status(400).json({ error: 'fromDate and toDate are required (YYYY-MM-DD)' });
  }

  const tenantSlug = req.tenantSlug!;
  const ogState = getOgState(tenantSlug);

  if (ogState.activeSyncId) {
    return res.status(409).json({ error: 'An Oneglance sync is already in progress' });
  }

  const db = req.tenantDb!;
  const branchId = getBranchIdForInsert(req);
  const usernameRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('oneglance_username', req));
  const passwordRow = db.get("SELECT value FROM app_settings WHERE key = ?", branchSettingsKey('oneglance_password', req));

  if (!usernameRow?.value || !passwordRow?.value) {
    return res.status(400).json({ error: 'Oneglance credentials not configured. Go to Settings to set them up.' });
  }

  const username = usernameRow.value;
  const password = decrypt(passwordRow.value);

  const syncId = Date.now().toString();
  ogState.activeSyncId = syncId;
  ogState.progress = { step: 'starting', message: 'Initializing...', pct: 0 };

  res.json({ syncId, status: 'started' });

  try {
    const syncOneglance = await loadSyncOneglance();
    const result = await syncOneglance({
      username,
      password,
      fromDate,
      toDate,
      reportType: reportType || 'both',
      onProgress: (step, message, pct) => {
        ogState.progress = { step, message, pct };
      },
    });

    ogState.progress = { step: 'parsing', message: 'Parsing downloaded reports...', pct: 85 };

    let totalRows = 0;

    // Parse and save Sales report
    if (result.salesFile) {
      ogState.progress = { step: 'parsing', message: 'Parsing sales report...', pct: 87 };
      const { rows, summary } = parseOneglanceSales(result.salesFile.filePath);

      const importLog = db.run(
        `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'ONEGLANCE_SALES_SYNC', result.salesFile.filename, rows.length,
        summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId
      );

      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_sales_actuals (import_id, bill_no, bill_date, bill_month, drug_name, batch_no,
            hsn_code, tax_pct, patient_id, patient_name, referred_by, qty, sales_amount,
            purchase_amount, purchase_tax, sales_tax, profit, branch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importLog.lastInsertRowid, r.bill_no, r.bill_date, r.bill_month, r.drug_name, r.batch_no,
          r.hsn_code, r.tax_pct, r.patient_id, r.patient_name, r.referred_by, r.qty,
          r.sales_amount, r.purchase_amount, r.purchase_tax, r.sales_tax, r.profit, branchId
        );
      }
      totalRows += rows.length;

      // Auto-sync pharmacy revenue to dashboard_actuals (branch-scoped)
      const bf = branchFilter(req);
      const activeScenario = db.get(
        `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
         WHERE fy.is_active = 1 AND s.is_default = 1 LIMIT 1`
      );
      if (activeScenario) {
        // Look up the pharmacy stream_id to tag dashboard entries
        const platformDb = await getPlatformHelper();
        const pharmaStream = req.clientId ? platformDb.get(
          "SELECT id FROM business_streams WHERE client_id = ? AND LOWER(name) LIKE '%pharma%' AND is_active = 1 LIMIT 1",
          req.clientId
        ) : null;
        const pharmaStreamId = pharmaStream?.id || null;
        // Clear old Pharmacy Revenue/COGS entries before re-syncing (prevents stale month data)
        db.run(
          `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Pharmacy Revenue'${bf.where}`,
          activeScenario.id, ...bf.params
        );
        db.run(
          `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'direct_costs' AND item_name = 'Pharmacy COGS'${bf.where}`,
          activeScenario.id, ...bf.params
        );
        const pharmaMonthly = db.all(
          `SELECT bill_month as month, COALESCE(SUM(sales_amount), 0) as revenue,
                  COALESCE(SUM(purchase_amount), 0) as cogs
           FROM pharmacy_sales_actuals
           WHERE bill_month IS NOT NULL AND bill_month != ''${bf.where}
           GROUP BY bill_month`,
          ...bf.params
        );
        for (const row of pharmaMonthly) {
          if (!row.month) continue;
          db.run(
            `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
             VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(scenario_id, category, item_name, month)
             DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
            activeScenario.id, row.month, row.revenue, branchId, pharmaStreamId
          );
          db.run(
            `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
             VALUES (?, 'direct_costs', 'Pharmacy COGS', ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(scenario_id, category, item_name, month)
             DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
            activeScenario.id, row.month, row.cogs, branchId, pharmaStreamId
          );
        }
      }

      try { fs.unlinkSync(result.salesFile.filePath); } catch {}
    }

    // Parse and save Purchase report
    if (result.purchaseFile) {
      ogState.progress = { step: 'parsing', message: 'Parsing purchase report...', pct: 92 };
      const { rows, summary } = parseOneglancePurchase(result.purchaseFile.filePath);

      const importLog = db.run(
        `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'ONEGLANCE_PURCHASE_SYNC', result.purchaseFile.filename, rows.length,
        summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId
      );

      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_purchase_actuals (import_id, invoice_no, invoice_date, invoice_month,
            stockiest_name, mfg_name, drug_name, batch_no, hsn_code, batch_qty, free_qty, mrp, rate,
            discount_amount, net_purchase_value, net_sales_value, tax_pct, tax_amount,
            purchase_qty, purchase_value, sales_value, profit, profit_pct, branch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importLog.lastInsertRowid, r.invoice_no, r.invoice_date, r.invoice_month,
          r.stockiest_name, r.mfg_name, r.drug_name, r.batch_no, r.hsn_code,
          r.batch_qty, r.free_qty, r.mrp, r.rate, r.discount_amount,
          r.net_purchase_value, r.net_sales_value, r.tax_pct, r.tax_amount,
          r.purchase_qty, r.purchase_value, r.sales_value, r.profit, r.profit_pct, branchId
        );
      }
      totalRows += rows.length;

      try { fs.unlinkSync(result.purchaseFile.filePath); } catch {}
    }

    // Parse and save Stock report
    if (result.stockFile) {
      ogState.progress = { step: 'parsing', message: 'Parsing stock report...', pct: 94 };
      const { rows, summary } = parseOneglanceStock(result.stockFile.filePath);
      const snapshotDate = new Date().toISOString().slice(0, 10);

      // Replace existing snapshot for the same date & branch
      db.run('DELETE FROM pharmacy_stock_actuals WHERE snapshot_date = ? AND branch_id IS ?',
        snapshotDate, branchId);

      const importLog = db.run(
        `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'ONEGLANCE_STOCK_SYNC', result.stockFile.filename, rows.length,
        snapshotDate, snapshotDate, 'completed', branchId
      );

      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_stock_actuals (import_id, snapshot_date, drug_name, batch_no,
            received_date, expiry_date, avl_qty, strips, purchase_price, purchase_tax,
            purchase_value, stock_value, branch_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importLog.lastInsertRowid, snapshotDate, r.drug_name, r.batch_no,
          r.received_date, r.expiry_date, r.avl_qty, r.strips,
          r.purchase_price, r.purchase_tax, r.purchase_value, r.stock_value, branchId
        );
      }
      totalRows += rows.length;

      try { fs.unlinkSync(result.stockFile.filePath); } catch {}
    }

    ogState.progress = {
      step: 'complete',
      message: `Sync completed — ${totalRows} rows imported`,
      pct: 100,
      result: { totalRows },
    };
  } catch (err: any) {
    ogState.progress = {
      step: 'error',
      message: isProd ? 'Sync failed' : (err.message || 'Sync failed'),
      pct: 0,
      error: isProd ? 'Sync failed' : err.message,
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

router.put('/credentials/turia', requireAdmin, requireIntegration('turia'), async (req: Request, res: Response) => {
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

router.delete('/credentials/turia', requireAdmin, requireIntegration('turia'), async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const prefix = branchSettingsKey('turia_', _req);
  db.run("DELETE FROM app_settings WHERE key LIKE ?", prefix + '%');
  res.json({ ok: true });
});

// ─── Turia Sync Trigger ─────────────────────────────────────────────────────

router.post('/turia', requireAdmin, requireIntegration('turia'), async (req: Request, res: Response) => {
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

    const importLog = db.run(
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'TURIA_SYNC', result.filename, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed', branchId
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO turia_invoices (import_id, invoice_id, billing_org, client_name, gstin, service,
          sac_code, invoice_date, invoice_month, due_date, total_amount, status, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, r.invoice_id, r.billing_org, r.client_name, r.gstin,
        r.service, r.sac_code, r.invoice_date, r.invoice_month, r.due_date,
        r.total_amount, r.status, branchId
      );
    }

    // Auto-sync consultancy revenue to dashboard_actuals
    // First try: active scenario in active FY
    let activeScenario = db.get(
      `SELECT s.id, s.name, fy.label as fy_label FROM scenarios s
       JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND s.is_default = 1 LIMIT 1`
    );

    // Fallback: any default scenario if no active FY found
    if (!activeScenario) {
      activeScenario = db.get(
        `SELECT s.id, s.name FROM scenarios s WHERE s.is_default = 1 LIMIT 1`
      );
      console.log('Turia: No active FY found, using fallback scenario:', activeScenario?.id || 'NONE');
    }

    // Last resort: any scenario at all
    if (!activeScenario) {
      activeScenario = db.get('SELECT id, name FROM scenarios LIMIT 1');
      console.log('Turia: No default scenario, using any scenario:', activeScenario?.id || 'NONE');
    }

    if (activeScenario) {
      console.log(`Turia: Using scenario ${activeScenario.id} (${activeScenario.name}) for dashboard_actuals`);

      // Aggregate ALL turia_invoices (not just current import) by month
      // Use branch filter only if multi-branch mode is active
      const bf = branchFilter(req);
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
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, updated_at)
           VALUES (?, 'revenue', 'Consultancy Revenue', ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total, branchId
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

    try { fs.unlinkSync(result.filePath); } catch {}

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
        importId: importLog.lastInsertRowid,
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

router.post('/turia/otp', requireAdmin, requireIntegration('turia'), async (req: Request, res: Response) => {
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
    .filter(f => f.endsWith('.png'))
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
