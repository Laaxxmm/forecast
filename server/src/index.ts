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
import { requireAuth, requireSuperAdmin, requireAdmin } from './middleware/auth.js';
import { resolveTenant } from './middleware/tenant.js';
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

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const sessionSecret = process.env.SESSION_SECRET || (isProd ? (() => { throw new Error('SESSION_SECRET must be set in production'); })() : 'dev-only-secret-change-me');

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://vision.indefine.in',
  'https://api-vision.indefine.in',
].filter(Boolean) as string[];

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
app.use(express.json({ limit: '50mb' }));
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

// ─── Auth (no tenant needed — login determines tenant) ──────────────────────
app.use('/api/auth', authRoutes);

// ─── Admin routes (super admin only, no tenant context) ─────────────────────
app.use('/api/admin', requireAuth, requireSuperAdmin, adminRoutes);

// ─── Client-scoped routes (require auth + tenant resolution) ────────────────
app.use('/api/settings', requireAuth, resolveTenant, requireAdmin, settingsRoutes);
app.use('/api/import', requireAuth, resolveTenant, importRoutes);
app.use('/api/actuals', requireAuth, resolveTenant, actualsRoutes);
app.use('/api/budgets', requireAuth, resolveTenant, budgetRoutes);
app.use('/api/forecasts', requireAuth, resolveTenant, forecastRoutes);
app.use('/api/dashboard', requireAuth, resolveTenant, dashboardRoutes);
app.use('/api/forecast-module', requireAuth, resolveTenant, forecastModuleRoutes);
app.use('/api/dashboard-actuals', requireAuth, resolveTenant, dashboardActualsRoutes);
app.use('/api/sync', requireAuth, resolveTenant, syncRoutes);
app.use('/api/db', requireAuth, resolveTenant, requireAdmin, dbViewerRoutes);

// ─── Client streams (accessible to all authenticated users for their tenant) ─
app.get('/api/streams', requireAuth, resolveTenant, async (req, res) => {
  const platformDb = await getPlatformHelper();
  const streams = platformDb.all(
    'SELECT id, name, icon, color, sort_order FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order, id',
    (req as any).clientId
  );
  res.json(streams);
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
