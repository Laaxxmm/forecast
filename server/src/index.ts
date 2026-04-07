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

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'magna-tracker-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 },
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
  app.listen(PORT, () => {
    console.log(`Magna Tracker server running on http://localhost:${PORT}`);
  });
}

start().catch(console.error);
