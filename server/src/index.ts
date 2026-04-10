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

  // ── One-time cleanup v2: wipe ALL pharmacy data for magnacode + purge backups ──
  // v2 needed because v1 missed 'Pharmacy COGS' in dashboard_actuals AND
  // the OOM crash restored old data from .bak files
  try {
    const mcDb = await getClientHelper('magnacode');
    const alreadyCleaned = mcDb.get("SELECT value FROM app_settings WHERE key = 'og_cleanup_v2_20260411'");
    if (!alreadyCleaned) {
      const salesCount = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_sales_actuals')?.n || 0;
      const purchaseCount = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_purchase_actuals')?.n || 0;
      const stockCount = mcDb.get('SELECT COUNT(*) as n FROM pharmacy_stock_actuals')?.n || 0;

      // Wipe all pharmacy raw data
      mcDb.run('DELETE FROM pharmacy_sales_actuals');
      mcDb.run('DELETE FROM pharmacy_purchase_actuals');
      mcDb.run('DELETE FROM pharmacy_stock_actuals');
      mcDb.run("DELETE FROM import_logs WHERE source LIKE 'ONEGLANCE%'");

      // Wipe ALL pharmacy-related dashboard_actuals (Revenue + COGS + by stream_id)
      mcDb.run("DELETE FROM dashboard_actuals WHERE item_name LIKE 'Pharmacy%'");
      // Also delete by pharmacy stream_id from platform DB
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

      mcDb.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('og_cleanup_v2_20260411', '1')");
      console.log(`[Cleanup v2] Wiped ALL pharmacy data for magnacode: ${salesCount} sales, ${purchaseCount} purchases, ${stockCount} stock rows`);

      // Purge .bak and daily backup files so recovery can't restore old data
      const isProd = process.env.NODE_ENV === 'production';
      const dataDir = process.env.DATA_DIR || (isProd ? '/data' : '.');
      const clientsDir = path.join(dataDir, 'clients');
      const bakPath = path.join(clientsDir, 'magnacode.db.bak');
      const backupDir = path.join(clientsDir, 'backups');
      try {
        if (fs.existsSync(bakPath)) { fs.unlinkSync(bakPath); console.log('[Cleanup v2] Deleted magnacode.db.bak'); }
      } catch {}
      try {
        if (fs.existsSync(backupDir)) {
          for (const f of fs.readdirSync(backupDir)) {
            if (f.startsWith('magnacode.db.')) {
              fs.unlinkSync(path.join(backupDir, f));
              console.log(`[Cleanup v2] Deleted backup: ${f}`);
            }
          }
        }
      } catch {}
    }
  } catch (e) {
    console.error('[Cleanup v2] magnacode pharmacy wipe failed:', e);
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

  console.log('Database initialized and seeded');
  app.listen(PORT, () => {
    console.log(`Magna Tracker server running on port ${PORT}`);
  });
}

start().catch(console.error);
