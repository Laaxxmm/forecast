import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { getClientHelper, createDailyBackups } from './db/connection.js';
import { initializeSchema } from './db/schema.js';
import { seedDatabase } from './db/seed.js';
import { getPlatformHelper, createPlatformBackup } from './db/platform-connection.js';
import { initializePlatformSchema } from './db/platform-schema.js';
import { seedPlatformDatabase } from './db/platform-seed.js';
import { requireAuth, requireSuperAdmin, requireAdmin, requireModule } from './middleware/auth.js';
import { resolveTenant } from './middleware/tenant.js';
import { resolveBranch } from './middleware/branch.js';
import authRoutes from './routes/auth.js';
import adminRoutes, { ensureVcfoForSlug } from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import importRoutes from './routes/import.js';
import actualsRoutes from './routes/actuals.js';
import budgetRoutes from './routes/budget.js';
import forecastRoutes from './routes/forecast.js';
import dashboardRoutes from './routes/dashboard.js';
import forecastModuleRoutes from './routes/forecast-module.js';
import dashboardActualsRoutes from './routes/dashboard-actuals.js';
import syncRoutes from './routes/sync.js';
import revenueSharingRoutes from './routes/revenue-sharing.js';
import dbViewerRoutes from './routes/db-viewer.js';

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const sessionSecret = process.env.SESSION_SECRET || (isProd ? (() => { throw new Error('SESSION_SECRET must be set in production'); })() : 'dev-only-secret-change-me');

const allowedOrigins = isProd
  ? ['https://vision.indefine.in', 'https://api-vision.indefine.in']
  : ['http://localhost:5173', 'http://localhost:5174'];

console.log('CORS allowed origins:', allowedOrigins);

app.set('trust proxy', 1);
// TallyVision (mounted at /vcfo) relies on inline <script> and onclick handlers,
// which strict CSP blocks. Apply relaxed helmet (CSP disabled) for /vcfo/* only;
// all other routes keep the full strict helmet defaults.
const strictHelmet = helmet();
const relaxedHelmet = helmet({ contentSecurityPolicy: false });
app.use((req, res, next) => {
  if (req.path === '/vcfo' || req.path.startsWith('/vcfo/')) {
    return relaxedHelmet(req, res, next);
  }
  return strictHelmet(req, res, next);
});
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, false);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    console.log('CORS blocked origin:', origin);
    cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: isProd ? 'none' : 'lax',
  },
}));

// ─── Health check (no auth, always responds) ──────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    const platformDb = await getPlatformHelper();
    const clients = platformDb.all('SELECT slug FROM clients WHERE is_active = 1');
    const clientInfo: any[] = [];
    for (const c of clients) {
      try {
        const db = await getClientHelper(c.slug);
        const tables: Record<string, number> = {};
        for (const t of ['financial_years','scenarios','budgets','forecast_items','import_logs','dashboard_actuals','clinic_actuals','pharmacy_sales_actuals','pharmacy_purchase_actuals','pharmacy_stock_actuals']) {
          try { tables[t] = db.all(`SELECT COUNT(*) as n FROM ${t}`)[0]?.n || 0; } catch { tables[t] = -1; }
        }
        // Diagnostic: show import history and data months
        let imports: any[] = [];
        let salesMonths: string[] = [];
        let clinicMonths: string[] = [];
        let activeFy: any = null;
        try { imports = db.all('SELECT id, source, filename, rows_imported, date_range_start, date_range_end, created_at FROM import_logs ORDER BY id'); } catch {}
        try { salesMonths = db.all('SELECT DISTINCT bill_month FROM pharmacy_sales_actuals ORDER BY bill_month').map((r: any) => r.bill_month); } catch {}
        try { clinicMonths = db.all('SELECT DISTINCT bill_month FROM clinic_actuals ORDER BY bill_month').map((r: any) => r.bill_month); } catch {}
        try { activeFy = db.get('SELECT * FROM financial_years WHERE is_active = 1'); } catch {}
        let dashActuals: any[] = [];
        let scenarios: any[] = [];
        let clinicRevSum: any = null;
        try { dashActuals = db.all('SELECT scenario_id, category, item_name, month, amount, stream_id FROM dashboard_actuals ORDER BY item_name, month'); } catch {}
        try { scenarios = db.all('SELECT s.id, s.name, s.stream_id, s.is_default, s.fy_id FROM scenarios s'); } catch {}
        try { clinicRevSum = db.get('SELECT SUM(item_price) as total, COUNT(*) as rows FROM clinic_actuals'); } catch {}
        clientInfo.push({ slug: c.slug, tables, imports, salesMonths, clinicMonths, activeFy, dashActuals, scenarios, clinicRevSum });
      } catch (e: any) {
        clientInfo.push({ slug: c.slug, error: e.message });
      }
    }
    res.json({
      ok: true, uptime: process.uptime(), ts: new Date().toISOString(),
      dataDir: process.env.DATA_DIR || '/data',
      clients: clientInfo,
    });
  } catch (e: any) {
    res.json({ ok: false, error: e.message, uptime: process.uptime() });
  }
});

// ─── Phantom data cleanup (callable anytime, no auth — idempotent) ──────────
app.post('/api/cleanup-pharmacy', async (_req, res) => {
  try {
    const mcDb = await getClientHelper('magnacode');
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Check for phantom past months (e.g. Jan-Mar from date format bug)
    const activeFy = mcDb.get('SELECT start_date FROM financial_years WHERE is_active = 1');
    const fyStart = activeFy?.start_date?.slice(0, 7) || currentMonth;

    const futureData = mcDb.get("SELECT COUNT(*) as n FROM pharmacy_sales_actuals WHERE bill_month > ?", currentMonth)?.n || 0;
    const phantomPastMonths = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_sales_actuals WHERE bill_month < ?', fyStart)?.n || 0;
    const pharmaSales = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_sales_actuals')?.n || 0;
    const pharmaPurchase = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_purchase_actuals')?.n || 0;
    const pharmaStock = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_stock_actuals')?.n || 0;
    const pharmaDash = mcDb.get("SELECT COUNT(*) as n FROM dashboard_actuals WHERE item_name LIKE 'Pharmacy%'")?.n || 0;

    if (futureData > 0 || phantomPastMonths > 0) {
      // Surgical cleanup: remove phantom/future sales + purchase only.
      // Stock data is preserved — it's a point-in-time snapshot not affected by the date bug.
      mcDb.run('DELETE FROM pharmacy_sales_actuals WHERE bill_month < ? OR bill_month > ?', fyStart, currentMonth);
      mcDb.run('DELETE FROM pharmacy_purchase_actuals WHERE invoice_month < ? OR invoice_month > ?', fyStart, currentMonth);

      // Wipe stale dashboard actuals for pharmacy (will be rebuilt on next sync)
      mcDb.run("DELETE FROM dashboard_actuals WHERE item_name LIKE 'Pharmacy%'");
      const platformDb = await getPlatformHelper();
      const clientRow = platformDb.get("SELECT id FROM clients WHERE slug = 'magnacode'");
      if (clientRow) {
        const pharmaStream = platformDb.get(
          "SELECT id FROM business_streams WHERE client_id = ? AND LOWER(name) LIKE '%pharma%' LIMIT 1",
          clientRow.id
        );
        if (pharmaStream) mcDb.run('DELETE FROM dashboard_actuals WHERE stream_id = ?', pharmaStream.id);
      }

      // Remove bad import_logs for sales/purchase (stock log kept)
      mcDb.run("DELETE FROM import_logs WHERE source IN ('ONEGLANCE_SALES_SYNC','ONEGLANCE_PURCHASE_SYNC','OG_SALES','OG_PURCHASE','ONEGLANCE_SALES','ONEGLANCE_PURCHASE')");

      // Purge .bak so the clean state doesn't get rolled back
      const bakPath = path.join(process.env.DATA_DIR || '/data', 'clients', 'magnacode.db.bak');
      if (fs.existsSync(bakPath)) try { fs.unlinkSync(bakPath); } catch {}

      res.json({
        cleaned: true, futureData, phantomPastMonths,
        deleted: { sales: pharmaSales, purchase: pharmaPurchase },
        preserved: { stock: pharmaStock },
        pharmaDash,
      });
    } else {
      res.json({ cleaned: false, message: 'No phantom data found', futureData, phantomPastMonths, pharmaSales, pharmaDash });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Clinic dedup cleanup (wipe duplicated clinic rows, keep one copy) ───────
app.post('/api/cleanup-clinic', async (_req, res) => {
  try {
    const mcDb = await getClientHelper('magnacode');
    const before = mcDb.get('SELECT COUNT(*) as n FROM clinic_actuals')?.n || 0;
    // Keep only the latest import's rows; remove rows from older imports for the same months
    const latestImport = mcDb.get(
      "SELECT id FROM import_logs WHERE source IN ('HEALTHPLIX_SYNC','HEALTHPLIX') ORDER BY id DESC LIMIT 1"
    );
    if (latestImport) {
      mcDb.run('DELETE FROM clinic_actuals WHERE import_id != ?', latestImport.id);
      // Clean old import logs too
      mcDb.run("DELETE FROM import_logs WHERE source IN ('HEALTHPLIX_SYNC','HEALTHPLIX') AND id != ?", latestImport.id);
    }
    const after = mcDb.get('SELECT COUNT(*) as n FROM clinic_actuals')?.n || 0;

    // Also clear and rebuild clinic dashboard_actuals from the de-duped data
    mcDb.run("DELETE FROM dashboard_actuals WHERE item_name LIKE 'Clinic%'");
    const platformDb = await getPlatformHelper();
    const clientRow = platformDb.get("SELECT id FROM clients WHERE slug = 'magnacode'");
    let clinicStreamId: number | null = null;
    let scenarioId: number | null = null;
    if (clientRow) {
      const clinicStream = platformDb.get(
        "SELECT id FROM business_streams WHERE client_id = ? AND (LOWER(name) LIKE '%clinic%' OR LOWER(name) LIKE '%health%') LIMIT 1",
        clientRow.id
      );
      clinicStreamId = clinicStream?.id || null;
    }
    const scenario = mcDb.get(
      `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
       WHERE fy.is_active = 1 AND (s.stream_id = ? OR s.is_default = 1)
       ORDER BY CASE WHEN s.stream_id = ? THEN 0 ELSE 1 END, s.id LIMIT 1`,
      clinicStreamId, clinicStreamId
    );
    scenarioId = scenario?.id || null;
    if (scenarioId) {
      const months = mcDb.all(
        `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
         FROM clinic_actuals WHERE bill_month IS NOT NULL GROUP BY bill_month`
      );
      for (const row of months) {
        mcDb.run(
          `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, stream_id, updated_at)
           VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, ?, datetime('now'))
           ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
           DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
          scenarioId, row.month, row.total, clinicStreamId
        );
      }
    }
    res.json({ before, after, removed: before - after, scenarioId, clinicStreamId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Auth (no tenant needed — login determines tenant) ──────────────────────
app.use('/api/auth', authRoutes);

// ─── Admin routes (super admin only, no tenant context) ─────────────────────
app.use('/api/admin', requireAuth, requireSuperAdmin, adminRoutes);

// ─── Client-scoped routes (require auth + tenant + branch + module) ────────
const forecastOps = [requireAuth, resolveTenant, resolveBranch, requireModule('forecast_ops')];
app.use('/api/settings', requireAuth, resolveTenant, resolveBranch, requireAdmin, settingsRoutes);
app.use('/api/import', ...forecastOps, requireAdmin, importRoutes);
app.use('/api/actuals', ...forecastOps, actualsRoutes);
app.use('/api/budgets', ...forecastOps, budgetRoutes);
app.use('/api/forecasts', ...forecastOps, forecastRoutes);
app.use('/api/dashboard', ...forecastOps, dashboardRoutes);
app.use('/api/forecast-module', ...forecastOps, forecastModuleRoutes);
app.use('/api/dashboard-actuals', ...forecastOps, dashboardActualsRoutes);
app.use('/api/sync', ...forecastOps, requireAdmin, syncRoutes);
app.use('/api/revenue-sharing', ...forecastOps, revenueSharingRoutes);
app.use('/api/db', requireAuth, resolveTenant, resolveBranch, requireAdmin, dbViewerRoutes);

// ─── VCFO sub-app: TallyVision (CommonJS) mounted under /vcfo ────────────────
// TallyVision is loaded via createRequire because our server is ESM.
// It brings its own express-session, better-sqlite3 DB and static assets;
// the sub-app does not run app.listen() when required (guarded in server.js).
//
// SSO bridge: /api/vcfo/sso-token mints a short-lived HMAC-signed token, and
// the browser redirects to /vcfo/sso?token=... — TallyVision verifies the
// signature and seeds its own session. The shared secret lives in the sso
// module, which Node caches by absolute path — both sides get the same value.
const requireCJS = createRequire(import.meta.url);
let vcfoSso: { sign: (payload: any, ttlSec?: number) => string } | null = null;
try {
  // Path resolves from the compiled dist/ output at runtime; src/index.ts → ../../Vcfo-app/...
  const vcfoApp = requireCJS('../../Vcfo-app/TallyVision_2.0/src/backend/server.js');
  vcfoSso = requireCJS('../../Vcfo-app/TallyVision_2.0/src/backend/sso.js');
  app.use('/vcfo', vcfoApp);
  console.log('✓ TallyVision sub-app mounted at /vcfo');
} catch (err: any) {
  console.warn('⚠ TallyVision sub-app not mounted:', err?.message || err);
}

// ─── SSO token mint: called by ModuleSelectPage before redirecting to /vcfo/sso
// Auth-gated + tenant-resolved, so the token is bound to the authenticated
// user's current client slug. TallyVision verifies + auto-seeds its session.
app.post('/api/vcfo/sso-token', requireAuth, resolveTenant, async (req, res) => {
  if (!vcfoSso) {
    return res.status(503).json({ error: 'VCFO sub-app not available' });
  }
  if (!req.tenantSlug) {
    return res.status(400).json({ error: 'No active client' });
  }

  // Post-unification (Step 6): company scoping is per-tenant inside the
  // client DB (vcfo_companies), not a cross-cutting SSO claim. The SSO
  // token carries only tenant + identity + role.
  const token = vcfoSso.sign({
    slug: req.tenantSlug,
    userId: req.session.userId,
    username: req.session.username,
    displayName: req.session.displayName,
    userType: req.userType,
    role: req.session.role,
    isOwner: req.isOwner,
    clientId: req.clientId,
    clientName: req.clientName,
  });
  res.json({ token });
});

// ─── Client modules & integrations (for module selection page) ──────────────
app.get('/api/client-modules', requireAuth, resolveTenant, async (req, res) => {
  const platformDb = await getPlatformHelper();
  const modules = platformDb.all(
    'SELECT module_key, is_enabled FROM client_modules WHERE client_id = ?',
    req.clientId
  );
  const integrations = platformDb.all(
    'SELECT integration_key FROM client_integrations WHERE client_id = ? AND is_enabled = 1',
    req.clientId
  );
  res.json({
    enabledModules: modules.filter((m: any) => m.is_enabled).map((m: any) => m.module_key),
    enabledIntegrations: integrations.map((i: any) => i.integration_key),
  });
});

// ─── Client streams (accessible to all authenticated users for their tenant) ─
app.get('/api/streams', requireAuth, resolveTenant, async (req, res) => {
  const platformDb = await getPlatformHelper();
  const streams = platformDb.all(
    'SELECT id, name, icon, color, sort_order FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order, id',
    (req as any).clientId
  );
  res.json(streams);
});

// ─── Client branches (returns branches the current user can access) ─────────
app.get('/api/branches', requireAuth, resolveTenant, resolveBranch, async (req, res) => {
  const platformDb = await getPlatformHelper();
  const client = platformDb.get('SELECT is_multi_branch FROM clients WHERE id = ?', req.clientId);

  if (!client?.is_multi_branch) {
    return res.json({ isMultiBranch: false, branches: [] });
  }

  // For super admins and client admins, return all branches
  // For regular users, return only their assigned branches
  let branches;
  if (req.userType === 'super_admin' || req.session?.role === 'admin') {
    branches = platformDb.all(
      'SELECT id, name, code, city, manager_name, sort_order FROM branches WHERE client_id = ? AND is_active = 1 ORDER BY sort_order, name',
      req.clientId
    );
  } else {
    branches = platformDb.all(
      `SELECT b.id, b.name, b.code, b.city, b.manager_name, b.sort_order, uba.can_view_consolidated
       FROM branches b
       JOIN user_branch_access uba ON uba.branch_id = b.id
       WHERE b.client_id = ? AND b.is_active = 1 AND uba.user_id = ?
       ORDER BY b.sort_order, b.name`,
      req.clientId, req.session?.userId
    );
  }

  const canViewConsolidated = req.userType === 'super_admin' || req.session?.role === 'admin'
    || branches.some((b: any) => b.can_view_consolidated);

  res.json({ isMultiBranch: true, branches, canViewConsolidated });
});

// ─── Debug screenshots (for diagnosing sync issues) ─────────────────────────
const isProdEnv = process.env.NODE_ENV === 'production';
const debugDir = path.join(process.env.DATA_DIR || (isProdEnv ? '/data' : '.'), 'uploads', 'debug');
app.get('/api/debug/screenshots', (_req, res) => {
  if (!fs.existsSync(debugDir)) return res.json([]);
  const files = fs.readdirSync(debugDir).filter(f => f.endsWith('.png')).sort();
  res.json(files);
});
app.get('/api/debug/screenshots/:name', (req, res) => {
  const safe = path.basename(req.params.name); // prevent path traversal
  const filePath = path.join(debugDir, safe);
  if (!fs.existsSync(filePath) || !safe.endsWith('.png')) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ─── Debug: DB table status (for diagnosing data loss) ──────────────────────
app.get('/api/debug/db-status', async (_req, res) => {
  try {
    const mcDb = await getClientHelper('magnacode');
    const tables = ['clinic_actuals', 'pharmacy_sales_actuals', 'pharmacy_purchase_actuals',
      'pharmacy_stock_actuals', 'dashboard_actuals', 'import_logs', 'turia_invoices'];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      try { counts[t] = mcDb.get(`SELECT COUNT(*) as n FROM ${t}`)?.n || 0; } catch { counts[t] = -1; }
    }
    const recentImports = mcDb.all(
      "SELECT id, source, rows_imported, date_range_start, date_range_end, status, created_at FROM import_logs ORDER BY id DESC LIMIT 10"
    );
    const dashClinic = mcDb.get("SELECT COUNT(*) as n, COALESCE(SUM(amount),0) as total FROM dashboard_actuals WHERE item_name = 'Clinic Revenue'");
    const resetFlag = mcDb.get("SELECT value FROM app_settings WHERE key = 'actuals_reset_v2'");
    res.json({ counts, recentImports, dashClinic, resetFlag: resetFlag?.value || null });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Static files ───────────────────────────────────────────────────────────
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
  // 1. Initialize platform database
  const platformDb = await getPlatformHelper();
  initializePlatformSchema(platformDb);
  await seedPlatformDatabase(platformDb);
  console.log('Platform database initialized');

  // ── Permanent pharmacy data guard ──
  // Runs EVERY startup. Detects phantom pharmacy data from crash recovery
  // and wipes it. Two detection methods:
  //   1) pharmacy data exists but no OG import logs → stale data
  //   2) pharmacy_sales has data for FUTURE months → phantom data from old .bak
  // Also deletes OG import_logs during cleanup so crash recovery can't
  // re-introduce stale import records that bypass check #1.
  try {
    const mcDb = await getClientHelper('magnacode');
    const ogImports = mcDb.get("SELECT COUNT(*) as n FROM import_logs WHERE source LIKE 'ONEGLANCE%'")?.n || 0;
    const pharmaSales = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_sales_actuals')?.n || 0;
    const pharmaDash = mcDb.get("SELECT COUNT(*) as n FROM dashboard_actuals WHERE item_name LIKE 'Pharmacy%'")?.n || 0;
    const currentMonth = new Date().toISOString().slice(0, 7); // e.g. "2026-04"
    const futureData = mcDb.get(
      "SELECT COUNT(*) as n FROM pharmacy_sales_actuals WHERE bill_month > ?",
      currentMonth
    )?.n || 0;

    const noImportsButData = ogImports === 0 && (pharmaSales > 0 || pharmaDash > 0);
    const hasFuturePhantom = futureData > 0;

    if (noImportsButData || hasFuturePhantom) {
      console.log(`[Pharmacy Guard] Phantom data detected — sales=${pharmaSales}, dashboard=${pharmaDash}, ogImports=${ogImports}, futureRows=${futureData} — wiping`);
      mcDb.run('DELETE FROM pharmacy_sales_actuals');
      mcDb.run('DELETE FROM pharmacy_purchase_actuals');
      mcDb.run('DELETE FROM pharmacy_stock_actuals');
      mcDb.run("DELETE FROM dashboard_actuals WHERE item_name LIKE 'Pharmacy%'");
      // Delete OG import_logs so crash recovery can't re-bypass this guard
      mcDb.run("DELETE FROM import_logs WHERE source LIKE 'ONEGLANCE%'");
      // Also catch entries with pharmacy stream_id
      const clientRow = platformDb.get("SELECT id FROM clients WHERE slug = 'magnacode'");
      if (clientRow) {
        const pharmaStream = platformDb.get(
          "SELECT id FROM business_streams WHERE client_id = ? AND LOWER(name) LIKE '%pharma%' LIMIT 1",
          clientRow.id
        );
        if (pharmaStream) {
          mcDb.run('DELETE FROM dashboard_actuals WHERE stream_id = ?', pharmaStream.id);
        }
      }
      // Delete .bak file so crash recovery can't restore phantom data again
      const bakPath = path.join(process.env.DATA_DIR || '/data', 'clients', 'magnacode.db.bak');
      if (fs.existsSync(bakPath)) {
        try { fs.unlinkSync(bakPath); console.log('[Pharmacy Guard] Deleted stale .bak file'); } catch {}
      }
      console.log('[Pharmacy Guard] All phantom pharmacy data + stale import logs removed');
    }
  } catch (e) {
    console.error('[Pharmacy Guard] Failed:', e);
  }

  // NOTE: One-time actuals_reset_v2 has already run. Code removed to prevent
  // accidental re-execution after crash recovery loads a backup without the flag.
  // The flag remains in app_settings as a historical marker.

  // ── One-time forecast migration: magna_tracker.db → magnacode.db ──
  // Copies forecast scenario + items + values from legacy single-tenant DB into
  // the multi-tenant magnacode.db (Clinic stream, branch=Head Office).
  try {
    const mcDb = await getClientHelper('magnacode');
    const migDone = mcDb.get("SELECT value FROM app_settings WHERE key = 'forecast_migrate_v1'");
    if (!migDone) {
      const dataDir = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : path.join(__dirname, '..', '..', 'data'));
      const legacyPath = path.join(dataDir, 'magna_tracker.db');
      if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).size > 0) {
        console.log('[Forecast Migrate] Found legacy magna_tracker.db — migrating forecast data...');
        const initSqlJs = (await import('sql.js')).default;
        const SQL = await initSqlJs();
        const legacyBuf = fs.readFileSync(legacyPath);
        const legacyDb = new SQL.Database(legacyBuf);

        // Check legacy DB has forecast_items
        const legacyTables = legacyDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='forecast_items'");
        const hasItems = legacyTables[0]?.values?.length > 0;

        if (hasItems) {
          const legacyItemsRes = legacyDb.exec('SELECT * FROM forecast_items WHERE scenario_id = 1 ORDER BY sort_order, id');
          const legacyItems = (legacyItemsRes[0]?.values || []).map((r: any[]) => {
            const obj: any = {};
            (legacyItemsRes[0]!.columns as string[]).forEach((c, i) => obj[c] = r[i]);
            return obj;
          });

          if (legacyItems.length > 0) {
            // Find or create Clinic scenario in current DB (branch_id=1, stream_id from platform)
            const clientRow = platformDb.get("SELECT id FROM clients WHERE slug = 'magnacode'");
            const clinicStreamRow = clientRow ? platformDb.get(
              "SELECT id FROM business_streams WHERE client_id = ? AND (LOWER(name) LIKE '%clinic%' OR LOWER(name) LIKE '%health%') LIMIT 1",
              clientRow.id
            ) : null;
            const branchRow = clientRow ? platformDb.get(
              "SELECT id FROM branches WHERE client_id = ? ORDER BY sort_order LIMIT 1",
              clientRow.id
            ) : null;

            const activeFy = mcDb.get('SELECT id FROM financial_years WHERE is_active = 1');
            if (activeFy) {
              const clinicStreamId = clinicStreamRow?.id || null;
              const branchId = branchRow?.id || null;

              // Find or create the Clinic scenario
              let targetScenario = mcDb.get(
                'SELECT id FROM scenarios WHERE fy_id = ? AND stream_id = ? AND branch_id IS NOT NULL LIMIT 1',
                activeFy.id, clinicStreamId
              );
              if (!targetScenario) {
                mcDb.run(
                  'INSERT INTO scenarios (fy_id, name, is_default, branch_id, stream_id) VALUES (?, ?, 1, ?, ?)',
                  activeFy.id, 'Original Scenario', branchId, clinicStreamId
                );
                const newScId = mcDb.get('SELECT last_insert_rowid() as id')?.id;
                targetScenario = { id: newScId };
              }

              const targetScenarioId = targetScenario.id;

              // Remove any placeholder/test items in target scenario
              mcDb.run('DELETE FROM forecast_items WHERE scenario_id = ? AND name IN (?, ?)', targetScenarioId, 'Test Revenue', 'New Item');

              // Insert items, build ID mapping
              const idMap: Record<number, number> = {};
              mcDb.beginBatch();
              for (const item of legacyItems) {
                mcDb.run(
                  `INSERT INTO forecast_items
                   (scenario_id, category, name, item_type, entry_mode, constant_amount, constant_period,
                    start_month, annual_raise_pct, tax_rate_pct, sort_order, parent_id, meta, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  targetScenarioId, item.category, item.name, item.item_type, item.entry_mode,
                  item.constant_amount || 0, item.constant_period || 'month', item.start_month || '2026-04',
                  item.annual_raise_pct || 0, item.tax_rate_pct || 0, item.sort_order || 0,
                  null, item.meta || null, item.created_at
                );
                const newId = mcDb.get('SELECT last_insert_rowid() as id')?.id;
                idMap[item.id] = newId;
              }
              mcDb.endBatch();

              // Fix linked_revenue_id in meta JSON
              for (const [oldId, newId] of Object.entries(idMap)) {
                const row = mcDb.get('SELECT meta FROM forecast_items WHERE id = ?', newId);
                if (!row?.meta) continue;
                try {
                  const parsed = JSON.parse(row.meta);
                  let changed = false;
                  if (parsed.linked_revenue_id && idMap[parsed.linked_revenue_id]) {
                    parsed.linked_revenue_id = idMap[parsed.linked_revenue_id]; changed = true;
                  }
                  if (changed) mcDb.run('UPDATE forecast_items SET meta = ? WHERE id = ?', JSON.stringify(parsed), newId);
                } catch {}
              }

              // Insert values with remapped item IDs
              const legacyValsRes = legacyDb.exec(
                'SELECT fv.* FROM forecast_values fv JOIN forecast_items fi ON fv.item_id = fi.id WHERE fi.scenario_id = 1 ORDER BY fv.item_id, fv.month'
              );
              const legacyVals = (legacyValsRes[0]?.values || []).map((r: any[]) => {
                const obj: any = {};
                (legacyValsRes[0]!.columns as string[]).forEach((c, i) => obj[c] = r[i]);
                return obj;
              });

              mcDb.beginBatch();
              for (const val of legacyVals) {
                const newItemId = idMap[val.item_id];
                if (!newItemId) continue;
                mcDb.run('INSERT OR REPLACE INTO forecast_values (item_id, month, amount) VALUES (?, ?, ?)', newItemId, val.month, val.amount);
              }
              mcDb.endBatch();

              console.log(`[Forecast Migrate] ✅ Migrated ${legacyItems.length} items + ${legacyVals.length} values into scenario ${targetScenarioId}`);
            }
          } else {
            console.log('[Forecast Migrate] Legacy DB has no forecast items — skipping');
          }
        }
        legacyDb.close();
      } else {
        console.log('[Forecast Migrate] No legacy magna_tracker.db found — skipping');
      }
      // Mark done regardless (avoid re-running on each restart)
      mcDb.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('forecast_migrate_v1', '1')");
    }
  } catch (e) {
    console.error('[Forecast Migrate] Failed:', e);
  }

  // 2. Initialize existing client databases (ensure schemas + seed data are up to date)
  const clients = platformDb.all('SELECT slug, name FROM clients WHERE is_active = 1');
  for (const client of clients) {
    try {
      const clientDb = await getClientHelper(client.slug);
      initializeSchema(clientDb);
      await seedDatabase(clientDb);

      // Idempotent VCFO top-up (Step 6): applies vcfo_* schema on every
      // boot so pre-Step-6 clients gain it without a manual migration,
      // and seeds a default vcfo_companies row for clients that never
      // had one (zero-row tenants would see a blank VCFO dashboard).
      ensureVcfoForSlug(client.slug, client.name);

      // Auto-create default scenario if FY exists but no scenario does
      const activeFy = clientDb.get('SELECT id FROM financial_years WHERE is_active = 1');
      if (activeFy) {
        const hasScenario = clientDb.get('SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1', activeFy.id);
        if (!hasScenario) {
          clientDb.run('INSERT INTO scenarios (fy_id, name, is_default) VALUES (?, ?, 1)', activeFy.id, 'Default');
          console.log(`  Auto-created default scenario for FY ${activeFy.id}`);
        }

        // Auto-sync imported data to dashboard_actuals if empty
        const scenario = clientDb.get('SELECT id FROM scenarios WHERE fy_id = ? AND is_default = 1', activeFy.id);
        const fy = clientDb.get('SELECT * FROM financial_years WHERE id = ?', activeFy.id);
        if (scenario && fy) {
          const actualsCount = clientDb.get('SELECT COUNT(*) as n FROM dashboard_actuals WHERE scenario_id = ?', scenario.id);
          if ((actualsCount?.n || 0) === 0) {
            const startMonth = fy.start_date.slice(0, 7);
            const endMonth = fy.end_date.slice(0, 7);

            // Find stream IDs for tagging
            const clientRow = platformDb.get('SELECT id FROM clients WHERE slug = ?', client.slug);
            const clinicStream = clientRow ? platformDb.get(
              "SELECT id FROM business_streams WHERE client_id = ? AND (LOWER(name) LIKE '%clinic%' OR LOWER(name) LIKE '%health%') AND is_active = 1 LIMIT 1",
              clientRow.id
            ) : null;
            const pharmaStream = clientRow ? platformDb.get(
              "SELECT id FROM business_streams WHERE client_id = ? AND LOWER(name) LIKE '%pharma%' AND is_active = 1 LIMIT 1",
              clientRow.id
            ) : null;

            // Sync clinic_actuals → dashboard_actuals
            try {
              const clinicMonthly = clientDb.all(
                `SELECT bill_month as month, COALESCE(SUM(item_price), 0) as total
                 FROM clinic_actuals WHERE bill_month >= ? AND bill_month <= ? GROUP BY bill_month`,
                startMonth, endMonth
              );
              for (const row of clinicMonthly) {
                if (!row.month) continue;
                clientDb.run(
                  `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, stream_id)
                   VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, ?)
                   ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
                   DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id`,
                  scenario.id, row.month, row.total, clinicStream?.id || null
                );
              }
              if (clinicMonthly.length > 0) console.log(`  Synced ${clinicMonthly.length} clinic months to dashboard_actuals`);
            } catch {}

            // Sync pharmacy_sales_actuals → dashboard_actuals
            try {
              const pharmaMonthly = clientDb.all(
                `SELECT bill_month as month, COALESCE(SUM(sales_amount), 0) as total
                 FROM pharmacy_sales_actuals WHERE bill_month >= ? AND bill_month <= ? GROUP BY bill_month`,
                startMonth, endMonth
              );
              for (const row of pharmaMonthly) {
                if (!row.month) continue;
                clientDb.run(
                  `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, stream_id)
                   VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, ?)
                   ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
                   DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id`,
                  scenario.id, row.month, row.total, pharmaStream?.id || null
                );
              }
              if (pharmaMonthly.length > 0) console.log(`  Synced ${pharmaMonthly.length} pharmacy months to dashboard_actuals`);
            } catch {}
          }
        }
      }

      // ── Per-branch dashboard_actuals rebuild (one-time reconciliation) ──
      // The previous UNIQUE constraint on dashboard_actuals didn't include
      // branch_id, so multi-branch clients ended up with per-(scenario,cat,
      // item,month) rollup rows that belonged to whichever branch last
      // synced — other branches' rollups were silently overwritten. The
      // schema migration above fixes the constraint; this block rebuilds
      // the auto-synced rollup rows from the (still-intact) source tables
      // so existing data shows up correctly for every branch.
      //
      // Scope: only the rows that are auto-populated by import/sync — Clinic
      // Revenue, Pharmacy Revenue, Pharmacy COGS, Consultancy Revenue.
      // Manually-entered rows (everything else) are left alone.
      //
      // Flag: dashboard_actuals_branch_rebuild_v1 in app_settings.
      try {
        const clientDb = await getClientHelper(client.slug);
        const already = clientDb.get(
          "SELECT value FROM app_settings WHERE key = 'dashboard_actuals_branch_rebuild_v1'"
        );
        if (!already) {
          const platformDb2 = await getPlatformHelper();
          const clientRow = platformDb2.get('SELECT id FROM clients WHERE slug = ?', client.slug);
          const clinicStream = clientRow ? platformDb2.get(
            "SELECT id FROM business_streams WHERE client_id = ? AND (LOWER(name) LIKE '%clinic%' OR LOWER(name) LIKE '%health%') AND is_active = 1 LIMIT 1",
            clientRow.id
          ) : null;
          const pharmaStream = clientRow ? platformDb2.get(
            "SELECT id FROM business_streams WHERE client_id = ? AND LOWER(name) LIKE '%pharma%' AND is_active = 1 LIMIT 1",
            clientRow.id
          ) : null;

          // Pick the scenario tied to each stream (fall back to default).
          const pickScenario = (streamId: number | null) => clientDb.get(
            `SELECT s.id FROM scenarios s JOIN financial_years fy ON s.fy_id = fy.id
             WHERE fy.is_active = 1 AND (s.stream_id = ? OR s.is_default = 1)
             ORDER BY CASE WHEN s.stream_id = ? THEN 0 ELSE 1 END, s.id LIMIT 1`,
            streamId, streamId
          );
          const clinicScenario = pickScenario(clinicStream?.id || null);
          const pharmaScenario = pickScenario(pharmaStream?.id || null);

          let rebuilt = 0;

          // Clinic Revenue — per (branch_id, month) from clinic_actuals
          if (clinicScenario) {
            clientDb.run(
              `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Clinic Revenue'`,
              clinicScenario.id
            );
            const rows = clientDb.all(
              `SELECT branch_id, bill_month as month, COALESCE(SUM(item_price), 0) as total
               FROM clinic_actuals
               WHERE bill_month IS NOT NULL AND bill_month != ''
               GROUP BY branch_id, bill_month`
            );
            for (const r of rows) {
              if (!r.month) continue;
              clientDb.run(
                `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
                 VALUES (?, 'revenue', 'Clinic Revenue', ?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
                 DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
                clinicScenario.id, r.month, r.total, r.branch_id, clinicStream?.id || null
              );
              rebuilt++;
            }
          }

          // Pharmacy Revenue + COGS — per (branch_id, month) from pharmacy_sales_actuals
          if (pharmaScenario) {
            clientDb.run(
              `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'revenue' AND item_name = 'Pharmacy Revenue'`,
              pharmaScenario.id
            );
            clientDb.run(
              `DELETE FROM dashboard_actuals WHERE scenario_id = ? AND category = 'direct_costs' AND item_name = 'Pharmacy COGS'`,
              pharmaScenario.id
            );
            const rows = clientDb.all(
              `SELECT branch_id, bill_month as month,
                      COALESCE(SUM(sales_amount), 0) as revenue,
                      COALESCE(SUM(purchase_amount), 0) as cogs
               FROM pharmacy_sales_actuals
               WHERE bill_month IS NOT NULL AND bill_month != ''
               GROUP BY branch_id, bill_month`
            );
            for (const r of rows) {
              if (!r.month) continue;
              clientDb.run(
                `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
                 VALUES (?, 'revenue', 'Pharmacy Revenue', ?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
                 DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
                pharmaScenario.id, r.month, r.revenue, r.branch_id, pharmaStream?.id || null
              );
              clientDb.run(
                `INSERT INTO dashboard_actuals (scenario_id, category, item_name, month, amount, branch_id, stream_id, updated_at)
                 VALUES (?, 'direct_costs', 'Pharmacy COGS', ?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(scenario_id, category, item_name, month, COALESCE(branch_id, 0))
                 DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id, updated_at = datetime('now')`,
                pharmaScenario.id, r.month, r.cogs, r.branch_id, pharmaStream?.id || null
              );
              rebuilt += 2;
            }
          }

          clientDb.run(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('dashboard_actuals_branch_rebuild_v1', '1')"
          );
          console.log(`  [branch-rebuild] "${client.slug}": rebuilt ${rebuilt} dashboard_actuals rows from source tables`);
        }
      } catch (e) {
        console.error(`  [branch-rebuild] "${client.slug}" failed:`, (e as Error).message);
      }

      // ── Cleanup: remove orphan empty scenarios ──
      // When a branch-specific user hit /scenarios/ensure with the old code
      // (before the branchFilter NULL fix), empty scenarios were auto-created
      // for their specific branch_id.  These orphans have zero forecast_items
      // and shadow the admin's populated NULL-branch scenario.  Delete them.
      try {
        const clientDb3 = await getClientHelper(client.slug);
        const orphans = clientDb3.all(
          `SELECT s.id, s.fy_id, s.branch_id, s.stream_id FROM scenarios s
           WHERE s.branch_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM forecast_items fi WHERE fi.scenario_id = s.id)
             AND EXISTS (
               SELECT 1 FROM scenarios s2
               WHERE s2.fy_id = s.fy_id AND s2.branch_id IS NULL AND s2.is_default = 1
             )`
        );
        if (orphans.length > 0) {
          for (const o of orphans) {
            clientDb3.run('DELETE FROM forecast_values WHERE scenario_id = ?', o.id);
            clientDb3.run('DELETE FROM forecast_settings WHERE scenario_id = ?', o.id);
            clientDb3.run('DELETE FROM scenarios WHERE id = ?', o.id);
          }
          console.log(`  [orphan-cleanup] "${client.slug}": removed ${orphans.length} empty branch-specific scenario(s)`);
        }
      } catch (e) {
        // Non-fatal — cleanup is best-effort
      }

      console.log(`Client DB "${client.slug}" schema + seed verified`);
    } catch (e) {
      console.error(`Failed to init client DB "${client.slug}":`, e);
    }
  }

  // ── Startup diagnostics: log table row counts so data loss is immediately visible ──
  try {
    const mcDb = await getClientHelper('magnacode');
    const counts = {
      clinic: mcDb.get('SELECT COUNT(*) as n FROM clinic_actuals')?.n || 0,
      pharmaSales: mcDb.get('SELECT COUNT(*) as n FROM pharmacy_sales_actuals')?.n || 0,
      pharmaPurchase: mcDb.get('SELECT COUNT(*) as n FROM pharmacy_purchase_actuals')?.n || 0,
      pharmaStock: mcDb.get('SELECT COUNT(*) as n FROM pharmacy_stock_actuals')?.n || 0,
      dashboard: mcDb.get('SELECT COUNT(*) as n FROM dashboard_actuals')?.n || 0,
      importLogs: mcDb.get('SELECT COUNT(*) as n FROM import_logs')?.n || 0,
    };
    console.log(`[Startup Diagnostics] Table row counts: clinic=${counts.clinic}, pharmaSales=${counts.pharmaSales}, pharmaPurchase=${counts.pharmaPurchase}, pharmaStock=${counts.pharmaStock}, dashboard=${counts.dashboard}, importLogs=${counts.importLogs}`);
    if (counts.clinic === 0 && counts.dashboard > 0) {
      console.warn('[Startup Diagnostics] ⚠ clinic_actuals is EMPTY but dashboard_actuals has data — clinic analytics will be blank until next HP sync');
    }
  } catch (e) {
    console.error('[Startup Diagnostics] Failed:', e);
  }

  // 3. Create daily backups (keeps last 3 days)
  try {
    createPlatformBackup();
    createDailyBackups();
    console.log('Daily backups checked');
  } catch (e) {
    console.error('Backup creation failed:', e);
  }

  // ── One-time forecast data restore endpoint ──────────────────────────────────
  // Call: POST /api/internal/inject-forecast  with header X-Token: magna-restore-2026
  // Can be called multiple times safely (idempotent via INSERT OR REPLACE).
  // Remove this endpoint after successful restore.
  app.post('/api/internal/inject-forecast', async (req: any, res: any) => {
    if (req.headers['x-token'] !== 'magna-restore-2026') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const mcDb = await getClientHelper('magnacode');

      // Find Clinic stream ID from platform DB (by name, not hard-coded stream_id)
      const platformDb = await getPlatformHelper();
      const clientRow = platformDb.get("SELECT id FROM clients WHERE slug = 'magnacode'");
      const clinicStreamRow = clientRow ? platformDb.get(
        "SELECT id FROM business_streams WHERE client_id = ? AND (LOWER(name) LIKE '%clinic%' OR LOWER(name) LIKE '%health%') ORDER BY id LIMIT 1",
        clientRow.id
      ) : null;

      // Diagnostic: show all scenarios and streams
      const allScenarios = mcDb.all('SELECT id, name, branch_id, stream_id, is_default FROM scenarios ORDER BY id');
      const allStreams = clientRow ? platformDb.all('SELECT id, name FROM business_streams WHERE client_id = ? ORDER BY id', clientRow.id) : [];

      const clinicStreamId = clinicStreamRow?.id;
      // Find scenario matching clinic stream
      let scenario = clinicStreamId
        ? mcDb.get('SELECT id FROM scenarios WHERE stream_id = ? LIMIT 1', clinicStreamId)
        : mcDb.get('SELECT id FROM scenarios WHERE stream_id IS NOT NULL ORDER BY id LIMIT 1');
      if (!scenario) scenario = mcDb.get('SELECT id FROM scenarios ORDER BY id LIMIT 1');
      if (!scenario) return res.status(404).json({ error: 'No scenario found', allScenarios, allStreams });

      const scenarioId = scenario.id;

      // Clear any existing items in this scenario (clean slate for restore)
      mcDb.run('DELETE FROM forecast_items WHERE scenario_id = ?', scenarioId);

      // Define items to restore (from magna_tracker.db legacy export)
      const ITEMS = [
        { category: 'revenue', name: 'Consultation Revenue', item_type: 'unit_sales', entry_mode: 'varying', sort_order: 1,
          meta: JSON.stringify({stepValues:{units:{"2026-04":1147,"2026-05":1191,"2026-06":1009,"2026-07":1372,"2026-08":1148,"2026-09":1020,"2026-10":1178,"2026-11":1231,"2026-12":1178,"2027-01":1142,"2027-02":1165,"2027-03":1162},prices:{"2026-04":901,"2026-05":901,"2026-06":901,"2026-07":901,"2026-08":901,"2026-09":901,"2026-10":901,"2026-11":901,"2026-12":901,"2027-01":901,"2027-02":901,"2027-03":901}},stepEntryModes:{units:"varying",prices:"constant"},stepConstants:{units:{amount:0,period:"month",startMonth:"2026-04"},prices:{amount:901,period:"month",startMonth:"2026-04"}}}) },
        { category: 'revenue', name: 'Diagnostics Revenue', item_type: 'unit_sales', entry_mode: 'varying', sort_order: 2,
          meta: JSON.stringify({stepValues:{units:{"2026-04":1032,"2026-05":845,"2026-06":689,"2026-07":970,"2026-08":909,"2026-09":744,"2026-10":960,"2026-11":1071,"2026-12":881,"2027-01":917,"2027-02":788,"2027-03":891},prices:{"2026-04":2087,"2026-05":2087,"2026-06":2087,"2026-07":2087,"2026-08":2087,"2026-09":2087,"2026-10":2087,"2026-11":2087,"2026-12":2087,"2027-01":2087,"2027-02":2087,"2027-03":2087}},stepEntryModes:{units:"varying",prices:"constant"},stepConstants:{units:{amount:0,period:"month",startMonth:"2026-04"},prices:{amount:2087,period:"month",startMonth:"2026-04"}}}) },
        { category: 'revenue', name: 'New Patient-based Revenue', item_type: 'unit_sales', entry_mode: 'varying', sort_order: 3, meta: null },
        { category: 'direct_costs', name: 'Directors Remuneration', item_type: 'general_cost', entry_mode: 'constant', sort_order: 1,
          meta: JSON.stringify({stepValues:{cost:{"2026-04":350000,"2026-05":350000,"2026-06":350000,"2026-07":350000,"2026-08":350000,"2026-09":350000,"2026-10":350000,"2026-11":350000,"2026-12":350000,"2027-01":350000,"2027-02":350000,"2027-03":350000}},stepEntryModes:{cost:"constant"},stepConstants:{cost:{amount:350000,period:"month",startMonth:"2026-04"}},linkedRevenueId:null,percentOfStream:0,percentStartMonth:"2026-04"}) },
        { category: 'direct_costs', name: 'New Specific Cost', item_type: 'specific_cost', entry_mode: 'varying', sort_order: 2, meta: null },
        { category: 'expenses', name: 'New Expense', item_type: 'other', entry_mode: 'varying', sort_order: 1,
          meta: JSON.stringify({stepValues:{amount:{"2026-04":50000}},stepEntryModes:{amount:"varying"},stepConstants:{amount:{amount:0,period:"month",startMonth:"2026-04"}},linkedRevenueId:null,percentOfStream:0,percentStartMonth:"2026-04",labor_type:"regular_labor",staffing_type:"on_staff",annual_raise_pct:0,percent_of_revenue:0,pct_revenue_start_month:"2026-04",linked_revenue_id:null,oneTimeMonth:"2026-04",oneTimeAmount:0}) },
        { category: 'expenses', name: 'New Expense 2', item_type: 'other', entry_mode: 'varying', sort_order: 2, meta: null },
      ];

      // Insert items and build id map — use SELECT after INSERT (lastInsertRowid unreliable in sql.js)
      const newIds: Record<string, number> = {};
      for (const item of ITEMS) {
        mcDb.run(
          `INSERT INTO forecast_items (scenario_id, category, name, item_type, entry_mode, constant_amount, constant_period, start_month, annual_raise_pct, tax_rate_pct, sort_order, parent_id, meta)
           VALUES (?, ?, ?, ?, ?, 0, 'month', '2026-04', 0, 0, ?, null, ?)`,
          scenarioId, item.category, item.name, item.item_type, item.entry_mode, item.sort_order, item.meta || null
        );
        const inserted = mcDb.get('SELECT id FROM forecast_items WHERE scenario_id = ? AND name = ? ORDER BY id DESC LIMIT 1', scenarioId, item.name);
        newIds[item.name] = inserted?.id;
      }

      // Insert Consultation share personnel — linked to Consultation Revenue
      const consultRevId = newIds['Consultation Revenue'];
      const consultShareMeta = JSON.stringify({stepValues:{headcount:{"2026-04":5,"2026-05":5,"2026-06":5,"2026-07":5,"2026-08":5,"2026-09":5,"2026-10":5,"2026-11":5,"2026-12":5,"2027-01":5,"2027-02":5,"2027-03":5},salary_per:{"2026-04":310034,"2026-05":321927,"2026-06":272733,"2026-07":370852,"2026-08":310304,"2026-09":275706,"2026-10":318413,"2026-11":332739,"2026-12":318413,"2027-01":308683,"2027-02":314900,"2027-03":314089}},stepEntryModes:{headcount:"constant",salary_per:"pct_specific"},stepConstants:{headcount:{amount:5,period:"month",startMonth:"2026-04"},salary_per:{amount:0,period:"month",startMonth:"2026-04"}},linkedRevenueId:consultRevId,percentOfStream:0,percentStartMonth:"2026-04",labor_type:"direct_labor",staffing_type:"contract",annual_raise_pct:0,percent_of_revenue:30,pct_revenue_start_month:"2026-04",linked_revenue_id:consultRevId});
      mcDb.run(
        `INSERT INTO forecast_items (scenario_id, category, name, item_type, entry_mode, constant_amount, constant_period, start_month, annual_raise_pct, tax_rate_pct, sort_order, parent_id, meta)
         VALUES (?, 'personnel', 'Consultation Share', 'group', 'varying', 0, 'month', '2026-04', 0, 0, 1, null, ?)`,
        scenarioId, consultShareMeta
      );
      const consultShareRow = mcDb.get('SELECT id FROM forecast_items WHERE scenario_id = ? AND name = ? ORDER BY id DESC LIMIT 1', scenarioId, 'Consultation Share');
      const consultShareId = consultShareRow?.id;
      mcDb.run(
        `INSERT INTO forecast_items (scenario_id, category, name, item_type, entry_mode, constant_amount, constant_period, start_month, annual_raise_pct, tax_rate_pct, sort_order, parent_id, meta)
         VALUES (?, 'personnel', 'New Employee', 'group', 'varying', 0, 'month', '2026-04', 0, 0, 2, null, ?)`,
        scenarioId, JSON.stringify({labor_type:"regular_labor",staffing_type:"on_staff"})
      );

      // Insert forecast_values
      const MONTHS = ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
      const CONSULT_REV = [1033447,1073091,909109,1236172,1034348,919020,1061378,1109131,1061378,1028942,1049665,1046962];
      const DIAG_REV    = [2153784,1763515,1437943,2024390,1897083,1552728,2003520,2235177,1838647,1913779,1644556,1859517];
      const DIR_REM     = [350000,350000,350000,350000,350000,350000,350000,350000,350000,350000,350000,350000];
      const CONSULT_SHR = [1550170,1609635,1363665,1854260,1551520,1378530,1592065,1663695,1592065,1543415,1574500,1570445];
      const EXPENSE_1   = [50000,0,0,0,0,0,0,0,0,0,0,0];

      mcDb.beginBatch();
      for (let i = 0; i < 12; i++) {
        const m = MONTHS[i];
        mcDb.run('INSERT OR REPLACE INTO forecast_values (item_id, month, amount) VALUES (?,?,?)', newIds['Consultation Revenue'], m, CONSULT_REV[i]);
        mcDb.run('INSERT OR REPLACE INTO forecast_values (item_id, month, amount) VALUES (?,?,?)', newIds['Diagnostics Revenue'], m, DIAG_REV[i]);
        mcDb.run('INSERT OR REPLACE INTO forecast_values (item_id, month, amount) VALUES (?,?,?)', newIds['Directors Remuneration'], m, DIR_REM[i]);
        mcDb.run('INSERT OR REPLACE INTO forecast_values (item_id, month, amount) VALUES (?,?,?)', consultShareId, m, CONSULT_SHR[i]);
        mcDb.run('INSERT OR REPLACE INTO forecast_values (item_id, month, amount) VALUES (?,?,?)', newIds['New Expense'], m, EXPENSE_1[i]);
      }
      mcDb.endBatch();

      const itemCount = mcDb.get('SELECT COUNT(*) as n FROM forecast_items WHERE scenario_id = ?', scenarioId)?.n;
      const valCount  = mcDb.get('SELECT COUNT(*) as n FROM forecast_values fv JOIN forecast_items fi ON fv.item_id = fi.id WHERE fi.scenario_id = ?', scenarioId)?.n;
      // Clean up any forecast items that landed in wrong (non-clinic) scenarios from earlier failed attempts
      const wrongItems = mcDb.all('SELECT DISTINCT scenario_id FROM forecast_items WHERE scenario_id != ?', scenarioId);
      for (const w of wrongItems) {
        // Only clean if it's a stream-specific scenario (not the default no-stream one)
        const wrongScenario = mcDb.get('SELECT stream_id FROM scenarios WHERE id = ?', w.scenario_id);
        if (wrongScenario?.stream_id) {
          mcDb.run('DELETE FROM forecast_items WHERE scenario_id = ?', w.scenario_id);
          console.log(`[Inject Forecast] Cleaned up wrong forecast items from scenario ${w.scenario_id}`);
        }
      }

      const allItems = mcDb.all('SELECT id, scenario_id, category, name FROM forecast_items WHERE scenario_id = ?', scenarioId);
      console.log(`[Inject Forecast] ✅ Restored ${itemCount} items + ${valCount} values into scenario ${scenarioId}`);
      res.json({ ok: true, scenarioId, items: itemCount, values: valCount, clinicStreamId, allScenarios, allStreams, newIds, insertedItems: allItems });
    } catch (e: any) {
      console.error('[Inject Forecast] Error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  console.log('Database initialized and seeded');
  app.listen(PORT, () => {
    console.log(`Magna Tracker server running on port ${PORT}`);
  });
}

start().catch(console.error);
