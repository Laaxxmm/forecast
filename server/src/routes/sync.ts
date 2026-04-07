import { Router, type Request, type Response } from 'express';
import { encrypt, decrypt } from '../utils/crypto.js';
import { parseHealthplix } from '../services/parsers/healthplix.js';
import { parseOneglanceSales } from '../services/parsers/oneglance-sales.js';
import { parseOneglancePurchase } from '../services/parsers/oneglance-purchase.js';
// Lazy-import Playwright sync modules (not available on cloud hosts)
const loadSyncHealthplix = () => import('../services/sync/healthplix-sync.js').then(m => m.syncHealthplix);
const loadSyncOneglance = () => import('../services/sync/oneglance-sync.js').then(m => m.syncOneglance);
import fs from 'fs';
import path from 'path';

const router = Router();

const isProd = process.env.NODE_ENV === 'production';

// Per-tenant sync state for progress tracking
interface SyncState {
  activeSyncId: string | null;
  progress: { step: string; message: string; pct: number; error?: string; result?: any } | null;
}

const hpSyncStates = new Map<string, SyncState>();
const ogSyncStates = new Map<string, SyncState>();

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

// ─── Credential Management ───────────────────────────────────────────────────

router.get('/credentials/healthplix', async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const username = db.get("SELECT value FROM app_settings WHERE key = 'healthplix_username'");
  const clinic = db.get("SELECT value FROM app_settings WHERE key = 'healthplix_clinic'");
  const hasPassword = db.get("SELECT value FROM app_settings WHERE key = 'healthplix_password'");

  res.json({
    username: username?.value || '',
    clinicName: clinic?.value || '',
    hasPassword: !!hasPassword?.value,
  });
});

router.put('/credentials/healthplix', async (req: Request, res: Response) => {
  const { username, password, clinicName } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const db = req.tenantDb!;

  db.run(`INSERT INTO app_settings (key, value) VALUES ('healthplix_username', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, username);

  db.run(`INSERT INTO app_settings (key, value) VALUES ('healthplix_clinic', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, clinicName || '');

  if (password) {
    const encrypted = encrypt(password);
    db.run(`INSERT INTO app_settings (key, value) VALUES ('healthplix_password', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, encrypted);
  }

  res.json({ ok: true });
});

router.delete('/credentials/healthplix', async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  db.run("DELETE FROM app_settings WHERE key LIKE 'healthplix_%'");
  res.json({ ok: true });
});

// ─── Sync Trigger ─────────────────────────────────────────────────────────────

router.post('/healthplix', async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.body;

  if (!fromDate || !toDate) {
    return res.status(400).json({ error: 'fromDate and toDate are required (YYYY-MM-DD)' });
  }

  const tenantSlug = req.tenantSlug!;
  const state = getHpState(tenantSlug);

  if (state.activeSyncId) {
    return res.status(409).json({ error: 'A sync is already in progress' });
  }

  // Load credentials
  const db = req.tenantDb!;
  const usernameRow = db.get("SELECT value FROM app_settings WHERE key = 'healthplix_username'");
  const passwordRow = db.get("SELECT value FROM app_settings WHERE key = 'healthplix_password'");
  const clinicRow = db.get("SELECT value FROM app_settings WHERE key = 'healthplix_clinic'");

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
      `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'HEALTHPLIX_SYNC', result.filename, rows.length,
      summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed'
    );

    for (const r of rows) {
      db.run(
        `INSERT INTO clinic_actuals (import_id, bill_date, bill_month, patient_id, patient_name, order_number,
          billed, paid, discount, tax, refund, due, addl_disc, item_price, item_disc,
          department, service_name, billed_doctor, service_owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importLog.lastInsertRowid, r.bill_date, r.bill_month, r.patient_id, r.patient_name,
        r.order_number, r.billed, r.paid, r.discount, r.tax, r.refund, r.due,
        r.addl_disc, r.item_price, r.item_disc, r.department, r.service_name,
        r.billed_doctor, r.service_owner
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
      // Aggregate clinic revenue into dashboard_actuals
      const clinicMonthly = db.all(
        `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
         FROM clinic_actuals WHERE bill_month IS NOT NULL AND bill_month != '' GROUP BY bill_month`
      );
      for (const row of clinicMonthly) {
        if (!row.month) continue;
        db.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, updated_at)
           VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month)
           DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
          activeScenario.id, row.month, row.total
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

router.get('/credentials/oneglance', async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const username = db.get("SELECT value FROM app_settings WHERE key = 'oneglance_username'");
  const hasPassword = db.get("SELECT value FROM app_settings WHERE key = 'oneglance_password'");

  res.json({
    username: username?.value || '',
    hasPassword: !!hasPassword?.value,
  });
});

router.put('/credentials/oneglance', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  const db = req.tenantDb!;
  db.run(`INSERT INTO app_settings (key, value) VALUES ('oneglance_username', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, username);

  if (password) {
    const encrypted = encrypt(password);
    db.run(`INSERT INTO app_settings (key, value) VALUES ('oneglance_password', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, encrypted);
  }

  res.json({ ok: true });
});

router.delete('/credentials/oneglance', async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  db.run("DELETE FROM app_settings WHERE key LIKE 'oneglance_%'");
  res.json({ ok: true });
});

// ─── Oneglance Sync ──────────────────────────────────────────────────────────

router.post('/oneglance', async (req: Request, res: Response) => {
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
  const usernameRow = db.get("SELECT value FROM app_settings WHERE key = 'oneglance_username'");
  const passwordRow = db.get("SELECT value FROM app_settings WHERE key = 'oneglance_password'");

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
        `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'ONEGLANCE_SALES_SYNC', result.salesFile.filename, rows.length,
        summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed'
      );

      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_sales_actuals (import_id, bill_no, bill_date, bill_month, drug_name, batch_no,
            hsn_code, tax_pct, patient_id, patient_name, referred_by, qty, sales_amount,
            purchase_amount, purchase_tax, sales_tax, profit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importLog.lastInsertRowid, r.bill_no, r.bill_date, r.bill_month, r.drug_name, r.batch_no,
          r.hsn_code, r.tax_pct, r.patient_id, r.patient_name, r.referred_by, r.qty,
          r.sales_amount, r.purchase_amount, r.purchase_tax, r.sales_tax, r.profit
        );
      }
      totalRows += rows.length;

      // Auto-sync pharmacy revenue to dashboard_actuals
      const activeScenario = db.get(
        `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
         WHERE fy.is_active = 1 AND s.is_default = 1 LIMIT 1`
      );
      if (activeScenario) {
        const pharmaMonthly = db.all(
          `SELECT bill_month as month, COALESCE(SUM(sales_amount), 0) as revenue,
                  COALESCE(SUM(purchase_amount), 0) as cogs
           FROM pharmacy_sales_actuals
           WHERE bill_month IS NOT NULL AND bill_month != ''
           GROUP BY bill_month`
        );
        for (const row of pharmaMonthly) {
          if (!row.month) continue;
          db.run(
            `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, updated_at)
             VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, datetime('now'))
             ON CONFLICT(scenario_id, category, item_name, month)
             DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
            activeScenario.id, row.month, row.revenue
          );
          db.run(
            `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, updated_at)
             VALUES (?, 'direct_costs', 'Pharmacy COGS', ?, ?, datetime('now'))
             ON CONFLICT(scenario_id, category, item_name, month)
             DO UPDATE SET amount = excluded.amount, updated_at = datetime('now')`,
            activeScenario.id, row.month, row.cogs
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
        `INSERT INTO import_logs (source, filename, rows_imported, date_range_start, date_range_end, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'ONEGLANCE_PURCHASE_SYNC', result.purchaseFile.filename, rows.length,
        summary.dateRange?.start || null, summary.dateRange?.end || null, 'completed'
      );

      for (const r of rows) {
        db.run(
          `INSERT INTO pharmacy_purchase_actuals (import_id, invoice_no, invoice_date, invoice_month,
            stockiest_name, mfg_name, drug_name, batch_no, hsn_code, batch_qty, free_qty, mrp, rate,
            discount_amount, net_purchase_value, net_sales_value, tax_pct, tax_amount,
            purchase_qty, purchase_value, sales_value, profit, profit_pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          importLog.lastInsertRowid, r.invoice_no, r.invoice_date, r.invoice_month,
          r.stockiest_name, r.mfg_name, r.drug_name, r.batch_no, r.hsn_code,
          r.batch_qty, r.free_qty, r.mrp, r.rate, r.discount_amount,
          r.net_purchase_value, r.net_sales_value, r.tax_pct, r.tax_amount,
          r.purchase_qty, r.purchase_value, r.sales_value, r.profit, r.profit_pct
        );
      }
      totalRows += rows.length;

      try { fs.unlinkSync(result.purchaseFile.filePath); } catch {}
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
