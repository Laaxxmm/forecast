import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import path from 'path';
import { getClientHelper } from './db/connection.js';
import { initializeSchema } from './db/schema.js';
import { seedDatabase } from './db/seed.js';
import { getPlatformHelper } from './db/platform-connection.js';
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
        clientInfo.push({ slug: c.slug, tables });
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

  // 2. Initialize existing client databases (ensure schemas are up to date)
  const clients = platformDb.all('SELECT slug FROM clients WHERE is_active = 1');
  for (const client of clients) {
    try {
      const clientDb = await getClientHelper(client.slug);
      initializeSchema(clientDb);
      console.log(`Client DB "${client.slug}" schema verified`);
    } catch (e) {
      console.error(`Failed to init client DB "${client.slug}":`, e);
    }
  }

  console.log('Database initialized and seeded');
  app.listen(PORT, () => {
    console.log(`Magna Tracker server running on port ${PORT}`);
  });
}

start().catch(console.error);
