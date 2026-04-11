import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
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
import adminRoutes from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import importRoutes from './routes/import.js';
import actualsRoutes from './routes/actuals.js';
import budgetRoutes from './routes/budget.js';
import forecastRoutes from './routes/forecast.js';
import dashboardRoutes from './routes/dashboard.js';
import forecastModuleRoutes from './routes/forecast-module.js';
import dashboardActualsRoutes from './routes/dashboard-actuals.js';
import syncRoutes from './routes/sync.js';
import dbViewerRoutes from './routes/db-viewer.js';
import vcfoTallySyncRoutes from './routes/vcfo/tally-sync.js';
import vcfoDashboardRoutes from './routes/vcfo/dashboard.js';
import vcfoCompanyRoutes from './routes/vcfo/companies.js';
import vcfoReportsRoutes from './routes/vcfo/reports.js';
import vcfoTrackerRoutes from './routes/vcfo/tracker.js';
import vcfoAuditRoutes from './routes/vcfo/audit.js';
import vcfoCompanyGroupRoutes from './routes/vcfo/company-groups.js';
import vcfoFilterRoutes from './routes/vcfo/filters.js';
import vcfoSettingsRoutes from './routes/vcfo/vcfo-settings.js';
import vcfoAllocationRuleRoutes from './routes/vcfo/allocation-rules.js';
import vcfoWriteoffRuleRoutes from './routes/vcfo/writeoff-rules.js';
import vcfoLedgerRoutes from './routes/vcfo/ledgers.js';
import vcfoBudgetRoutes from './routes/vcfo/budgets.js';
import vcfoUploadRoutes from './routes/vcfo/uploads.js';
import vcfoForecastViewRoutes from './routes/vcfo/forecast-view.js';

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const sessionSecret = process.env.SESSION_SECRET || (isProd ? (() => { throw new Error('SESSION_SECRET must be set in production'); })() : 'dev-only-secret-change-me');

const allowedOrigins = isProd
  ? ['https://vision.indefine.in', 'https://api-vision.indefine.in']
  : ['http://localhost:5173', 'http://localhost:5174'];

console.log('CORS allowed origins:', allowedOrigins);

app.set('trust proxy', 1);
app.use(helmet());
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
        clientInfo.push({ slug: c.slug, tables, imports, salesMonths, clinicMonths, activeFy });
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
    const futureData = mcDb.get("SELECT COUNT(*) as n FROM pharmacy_sales_actuals WHERE bill_month > ?", currentMonth)?.n || 0;
    const pharmaSales = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_sales_actuals')?.n || 0;
    const pharmaDash = mcDb.get("SELECT COUNT(*) as n FROM dashboard_actuals WHERE item_name LIKE 'Pharmacy%'")?.n || 0;

    if (futureData > 0) {
      mcDb.run('DELETE FROM pharmacy_sales_actuals');
      mcDb.run('DELETE FROM pharmacy_purchase_actuals');
      mcDb.run('DELETE FROM pharmacy_stock_actuals');
      mcDb.run("DELETE FROM dashboard_actuals WHERE item_name LIKE 'Pharmacy%'");
      mcDb.run("DELETE FROM import_logs WHERE source LIKE 'ONEGLANCE%'");

      const platformDb = await getPlatformHelper();
      const clientRow = platformDb.get("SELECT id FROM clients WHERE slug = 'magnacode'");
      if (clientRow) {
        const pharmaStream = platformDb.get(
          "SELECT id FROM business_streams WHERE client_id = ? AND LOWER(name) LIKE '%pharma%' LIMIT 1",
          clientRow.id
        );
        if (pharmaStream) mcDb.run('DELETE FROM dashboard_actuals WHERE stream_id = ?', pharmaStream.id);
      }
      // Purge .bak
      const bakPath = path.join(process.env.DATA_DIR || '/data', 'clients', 'magnacode.db.bak');
      if (fs.existsSync(bakPath)) try { fs.unlinkSync(bakPath); } catch {}

      res.json({ cleaned: true, futureData, pharmaSales, pharmaDash });
    } else {
      res.json({ cleaned: false, message: 'No phantom data found', futureData, pharmaSales, pharmaDash });
    }
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
app.use('/api/db', requireAuth, resolveTenant, resolveBranch, requireAdmin, dbViewerRoutes);

// ─── VCFO Portal routes ───────────────────────────────────────────────────────
const vcfoModule = [requireAuth, resolveTenant, resolveBranch, requireModule('vcfo_portal')];
app.use('/api/vcfo/tally', ...vcfoModule, requireAdmin, vcfoTallySyncRoutes);
app.use('/api/vcfo/dashboard', ...vcfoModule, vcfoDashboardRoutes);
app.use('/api/vcfo/companies', ...vcfoModule, vcfoCompanyRoutes);
app.use('/api/vcfo/reports', ...vcfoModule, vcfoReportsRoutes);
app.use('/api/vcfo/tracker', ...vcfoModule, vcfoTrackerRoutes);
app.use('/api/vcfo/audit', ...vcfoModule, vcfoAuditRoutes);
app.use('/api/vcfo/groups', ...vcfoModule, vcfoCompanyGroupRoutes);
app.use('/api/vcfo/filters', ...vcfoModule, vcfoFilterRoutes);
app.use('/api/vcfo/settings', ...vcfoModule, requireAdmin, vcfoSettingsRoutes);
app.use('/api/vcfo/allocation-rules', ...vcfoModule, requireAdmin, vcfoAllocationRuleRoutes);
app.use('/api/vcfo/writeoff-rules', ...vcfoModule, requireAdmin, vcfoWriteoffRuleRoutes);
app.use('/api/vcfo/ledgers', ...vcfoModule, vcfoLedgerRoutes);
app.use('/api/vcfo/budgets', ...vcfoModule, vcfoBudgetRoutes);
app.use('/api/vcfo/uploads', ...vcfoModule, vcfoUploadRoutes);
app.use('/api/vcfo/forecast-view', ...vcfoModule, vcfoForecastViewRoutes);

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

  // ── One-time actuals reset (clean slate) ──
  // Wipes all imported actuals, import logs, and dashboard actuals for magnacode.
  // Preserves: users, passwords, settings, integrations, scenarios, FY, dashboard cards.
  try {
    const mcDb = await getClientHelper('magnacode');
    const resetDone = mcDb.get("SELECT value FROM app_settings WHERE key = 'actuals_reset_v2'");
    if (!resetDone) {
      console.log('[Actuals Reset] Running one-time clean slate for magnacode...');
      mcDb.run('DELETE FROM clinic_actuals');
      mcDb.run('DELETE FROM pharmacy_sales_actuals');
      mcDb.run('DELETE FROM pharmacy_purchase_actuals');
      mcDb.run('DELETE FROM pharmacy_stock_actuals');
      mcDb.run('DELETE FROM turia_invoices');
      mcDb.run('DELETE FROM dashboard_actuals');
      mcDb.run('DELETE FROM import_logs');
      mcDb.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('actuals_reset_v2', '1')");
      // Also purge .bak to prevent crash recovery from restoring old data
      const bakPath = path.join(process.env.DATA_DIR || '/data', 'clients', 'magnacode.db.bak');
      if (fs.existsSync(bakPath)) {
        try { fs.unlinkSync(bakPath); } catch {}
      }
      console.log('[Actuals Reset] All actuals wiped. Settings/config preserved.');
    }
  } catch (e) {
    console.error('[Actuals Reset] Failed:', e);
  }

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
  const clients = platformDb.all('SELECT slug FROM clients WHERE is_active = 1');
  for (const client of clients) {
    try {
      const clientDb = await getClientHelper(client.slug);
      initializeSchema(clientDb);
      await seedDatabase(clientDb);

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
                   ON CONFLICT(scenario_id, category, item_name, month)
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
                   ON CONFLICT(scenario_id, category, item_name, month)
                   DO UPDATE SET amount = excluded.amount, stream_id = excluded.stream_id`,
                  scenario.id, row.month, row.total, pharmaStream?.id || null
                );
              }
              if (pharmaMonthly.length > 0) console.log(`  Synced ${pharmaMonthly.length} pharmacy months to dashboard_actuals`);
            } catch {}
          }
        }
      }

      console.log(`Client DB "${client.slug}" schema + seed verified`);
    } catch (e) {
      console.error(`Failed to init client DB "${client.slug}":`, e);
    }
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
