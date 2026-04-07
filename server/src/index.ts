import express from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import { getHelper } from './db/connection.js';
import { initializeSchema } from './db/schema.js';
import { seedDatabase } from './db/seed.js';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import settingsRoutes from './routes/settings.js';
import importRoutes from './routes/import.js';
import actualsRoutes from './routes/actuals.js';
import budgetRoutes from './routes/budget.js';
import forecastRoutes from './routes/forecast.js';
import dashboardRoutes from './routes/dashboard.js';
import forecastModuleRoutes from './routes/forecast-module.js';
import dashboardActualsRoutes from './routes/dashboard-actuals.js';
import syncRoutes from './routes/sync.js';

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const allowedOrigins = [
  'http://localhost:5173',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

console.log('CORS allowed origins:', allowedOrigins);

app.set('trust proxy', 1);
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return cb(null, true);
    // Check if origin matches any allowed origin (exact or startsWith for subpaths)
    if (allowedOrigins.some(o => origin === o || origin.startsWith(o))) return cb(null, true);
    // Also allow any vercel.app subdomain for preview deploys
    if (origin.endsWith('.vercel.app')) return cb(null, true);
    console.log('CORS blocked origin:', origin);
    cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'magna-tracker-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: isProd ? 'none' : 'lax',
  },
}));

app.use('/api/auth', authRoutes);
app.use('/api/settings', requireAuth, settingsRoutes);
app.use('/api/import', requireAuth, importRoutes);
app.use('/api/actuals', requireAuth, actualsRoutes);
app.use('/api/budgets', requireAuth, budgetRoutes);
app.use('/api/forecasts', requireAuth, forecastRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/forecast-module', requireAuth, forecastModuleRoutes);
app.use('/api/dashboard-actuals', requireAuth, dashboardActualsRoutes);
app.use('/api/sync', requireAuth, syncRoutes);

const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

async function start() {
  const db = await getHelper();
  initializeSchema(db);
  await seedDatabase(db);
  console.log('Database initialized and seeded');
  app.listen(PORT, () => {
    console.log(`Magna Tracker server running on port ${PORT}`);
  });
}

start().catch(console.error);
