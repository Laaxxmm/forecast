import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { createRequire } from 'module';
import { validatePassword } from '../middleware/auth.js';
import { getPlatformHelper } from '../db/platform-connection.js';
import { getClientHelper, getClientsDir } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { seedDatabase } from '../db/seed.js';
import { INDUSTRY_TEMPLATES } from '../config/industry-templates.js';
import { logoUpload, getLogosDir, getClientLogosDir } from '../middleware/upload.js';
import path from 'path';
import fs from 'fs';

const router = Router();

// ─── VCFO auto-provisioning (Step 6) ────────────────────────────────────────
// Bridge from our ESM server into TallyVision's CJS db/tenant.js so a brand-
// new Magna_Tracker client gets its vcfo_* schema + a default vcfo_companies
// row seeded in the same per-client DB that holds its forecast_* tables.
// Loaded lazily and wrapped in try/catch so a missing VCFO sub-app doesn't
// break client creation.
const requireCJS = createRequire(import.meta.url);
export function ensureVcfoForSlug(slug: string, clientName: string): void {
  try {
    const vcfoTenant = requireCJS(
      '../../../Vcfo-app/TallyVision_2.0/src/backend/db/tenant.js'
    );
    // getClientDb() applies ensureClientSchema (idempotent CREATE TABLE IF
    // NOT EXISTS for every vcfo_* table) and runs tenant-level migrations.
    const mgr = vcfoTenant.getDbManagerForSlug(slug);
    const db = mgr.getClientDb();
    // Seed a default vcfo_companies row if the tenant has none — otherwise
    // the VCFO dashboard is blank on first visit for a fresh client. Name
    // mirrors the Magna_Tracker client name; user can rename later.
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM vcfo_companies')
      .get() as { n: number };
    if (count.n === 0) {
      db.prepare('INSERT INTO vcfo_companies (name, is_active) VALUES (?, 1)')
        .run(clientName);
    }
  } catch (err: any) {
    console.warn(
      `[Admin] VCFO auto-provision skipped for "${slug}":`,
      err?.message || err
    );
  }
}

// Helper: check if a non-owner admin is assigned to a client
async function requireClientAssignment(req: Request, res: Response, clientSlug: string): Promise<boolean> {
  if (req.isOwner) return true;
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', clientSlug);
  if (!client) { res.status(404).json({ error: 'Client not found' }); return false; }
  const assignment = db.get(
    'SELECT id FROM team_member_clients WHERE team_member_id = ? AND client_id = ?',
    [req.session.userId, client.id]
  );
  if (!assignment) { res.status(403).json({ error: 'Not assigned to this client' }); return false; }
  return true;
}

// ─── Industry Templates ────────────────────────────────────────────────────

router.get('/industries', (_req: Request, res: Response) => {
  res.json(INDUSTRY_TEMPLATES);
});

// ─── Client Management ──────────────────────────────────────────────────────

router.get('/clients', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();

  // Non-owner admins only see assigned clients
  if (!req.isOwner) {
    const clients = db.all(`
      SELECT c.*,
        (SELECT COUNT(*) FROM client_users WHERE client_id = c.id) as user_count,
        (SELECT GROUP_CONCAT(integration_key) FROM client_integrations WHERE client_id = c.id AND is_enabled = 1) as integrations
      FROM clients c
      JOIN team_member_clients tmc ON tmc.client_id = c.id
      WHERE tmc.team_member_id = ?
      ORDER BY c.name
    `, req.session.userId);
    return res.json(clients);
  }

  const clients = db.all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM client_users WHERE client_id = c.id) as user_count,
      (SELECT GROUP_CONCAT(integration_key) FROM client_integrations WHERE client_id = c.id AND is_enabled = 1) as integrations
    FROM clients c
    ORDER BY c.name
  `);
  res.json(clients);
});

router.get('/clients/:slug', async (req: Request, res: Response) => {
  if (!(await requireClientAssignment(req, res, req.params.slug))) return;
  const db = await getPlatformHelper();
  const client = db.get('SELECT * FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const users = db.all('SELECT id, username, display_name, role, is_active, created_at FROM client_users WHERE client_id = ?', client.id);
  const integrations = db.all('SELECT * FROM client_integrations WHERE client_id = ?', client.id);
  const streams = db.all('SELECT * FROM business_streams WHERE client_id = ? ORDER BY sort_order, id', client.id);
  const branches = db.all('SELECT * FROM branches WHERE client_id = ? ORDER BY sort_order, name', client.id);
  const modules = db.all('SELECT module_key, is_enabled FROM client_modules WHERE client_id = ?', client.id);

  res.json({ ...client, users, integrations, streams, branches, modules });
});

router.post('/clients', async (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can create clients' });
  const db = await getPlatformHelper();
  const { slug, name } = req.body;

  if (!slug || !name) {
    return res.status(400).json({ error: 'slug and name are required' });
  }

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Slug must contain only lowercase letters, numbers, and hyphens' });
  }

  // Check uniqueness
  const existing = db.get('SELECT id FROM clients WHERE slug = ?', slug);
  if (existing) return res.status(409).json({ error: 'Client slug already exists' });

  const dbFilename = `${slug}.db`;

  // Create client record
  const result = db.run(
    'INSERT INTO clients (slug, name, db_filename) VALUES (?, ?, ?)',
    [slug, name, dbFilename]
  );
  const clientId = result.lastInsertRowid;

  // Create default admin user with a random password (returned once in the response)
  const defaultPassword = req.body.admin_password || crypto.randomBytes(12).toString('base64url');
  const pwError = validatePassword(defaultPassword);
  if (pwError) return res.status(400).json({ error: `Admin password: ${pwError}` });
  const adminHash = await bcrypt.hash(defaultPassword, 12);
  db.run(
    'INSERT INTO client_users (client_id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
    [clientId, 'admin', adminHash, `${name} Admin`, 'admin']
  );

  // Save industry
  const industry = req.body.industry || 'custom';
  db.run('UPDATE clients SET industry = ? WHERE id = ?', [industry, clientId]);

  // Create default streams from industry template
  const template = INDUSTRY_TEMPLATES.find(t => t.key === industry);
  if (template) {
    template.streams.forEach((stream, idx) => {
      db.run(
        'INSERT INTO business_streams (client_id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)',
        [clientId, stream.name, stream.icon, stream.color, idx]
      );
    });
  }

  // Create dashboard cards: Total Revenue + one per stream
  db.run('INSERT INTO dashboard_cards (client_id, card_type, title, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [clientId, 'total', 'Total Revenue', 'IndianRupee', 'accent', 0]);
  const newStreams = db.all('SELECT * FROM business_streams WHERE client_id = ? ORDER BY sort_order', clientId);
  newStreams.forEach((s: any, i: number) => {
    db.run('INSERT INTO dashboard_cards (client_id, card_type, stream_id, title, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [clientId, 'stream', s.id, s.name, s.icon, s.color, i + 1]);
  });

  // Enable default settings based on industry
  const defaultSettings: { key: string; on: boolean }[] = [
    { key: 'financial_years', on: true },
    { key: 'manual_upload', on: true },
    { key: 'tally', on: false },
    { key: 'zoho_books', on: false },
  ];
  if (industry === 'healthcare') {
    defaultSettings.push({ key: 'doctors', on: true }, { key: 'healthplix', on: false }, { key: 'oneglance', on: false });
  }
  if (industry === 'consultancy') {
    defaultSettings.push({ key: 'turia', on: false });
  }
  for (const s of defaultSettings) {
    db.run(
      'INSERT INTO client_integrations (client_id, integration_key, is_enabled) VALUES (?, ?, ?)',
      [clientId, s.key, s.on ? 1 : 0]
    );
  }

  // Create default modules (forecast_ops enabled by default)
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'forecast_ops', 1]);
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'vcfo_portal', 0]);
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'audit_view', 0]);
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'litigation_tool', 0]);
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'user_analysis', 1]);
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'user_insights', 1]);

  // Assign team members to this client
  const teamMemberIds: number[] = req.body.team_member_ids || [];
  for (const tmId of teamMemberIds) {
    const member = db.get('SELECT id, is_owner FROM team_members WHERE id = ?', tmId);
    if (member && !member.is_owner) {
      db.run(
        'INSERT OR IGNORE INTO team_member_clients (team_member_id, client_id) VALUES (?, ?)',
        [tmId, clientId]
      );
    }
  }

  // Initialize client database
  const clientDb = await getClientHelper(slug);
  initializeSchema(clientDb);
  await seedDatabase(clientDb);

  // Auto-provision VCFO workspace in the same per-client DB — creates
  // vcfo_* tables alongside forecast_* and seeds a default company row.
  ensureVcfoForSlug(slug, name);

  console.log(`[Admin] Created client "${slug}" with DB ${dbFilename}, assigned ${teamMemberIds.length} team members`);

  res.status(201).json({
    id: clientId,
    slug,
    name,
    industry,
    db_filename: dbFilename,
    message: `Client created. Default login: admin / ${defaultPassword}`,
    defaultPassword,
  });
});

router.put('/clients/:slug', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { name, is_active, industry } = req.body;

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (name !== undefined) {
    db.run('UPDATE clients SET name = ?, updated_at = datetime(\'now\') WHERE id = ?', [name, client.id]);
  }
  if (is_active !== undefined) {
    db.run('UPDATE clients SET is_active = ?, updated_at = datetime(\'now\') WHERE id = ?', [is_active ? 1 : 0, client.id]);
  }
  if (industry !== undefined) {
    db.run('UPDATE clients SET industry = ?, updated_at = datetime(\'now\') WHERE id = ?', [industry, client.id]);
  }

  res.json({ ok: true });
});

// ─── Delete Client (owner only — removes all data) ─────────────────────────

router.delete('/clients/:slug', async (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can delete clients' });
  const db = await getPlatformHelper();
  const client = db.get('SELECT id, db_filename FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Delete all related platform data
  db.run('DELETE FROM user_branch_stream_access WHERE user_id IN (SELECT id FROM client_users WHERE client_id = ?)', client.id);
  db.run('DELETE FROM user_branch_access WHERE user_id IN (SELECT id FROM client_users WHERE client_id = ?)', client.id);
  db.run('DELETE FROM team_member_clients WHERE client_id = ?', client.id);
  db.run('DELETE FROM branch_streams WHERE branch_id IN (SELECT id FROM branches WHERE client_id = ?)', client.id);
  db.run('DELETE FROM client_users WHERE client_id = ?', client.id);
  db.run('DELETE FROM client_integrations WHERE client_id = ?', client.id);
  db.run('DELETE FROM business_streams WHERE client_id = ?', client.id);
  db.run('DELETE FROM branches WHERE client_id = ?', client.id);
  db.run('DELETE FROM client_modules WHERE client_id = ?', client.id);
  db.run('DELETE FROM clients WHERE id = ?', client.id);

  // Delete the client database file
  try {
    const dbPath = path.join(getClientsDir(), client.db_filename);
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log(`[Admin] Deleted client DB file: ${dbPath}`);
    }
  } catch (err) {
    console.error('[Admin] Failed to delete DB file:', err);
  }

  console.log(`[Admin] Deleted client "${req.params.slug}" and all associated data`);
  res.json({ ok: true, message: `Client "${req.params.slug}" deleted` });
});

// ─── Delete Client User ────────────────────────────────────────────────────

router.delete('/clients/:slug/users/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const userId = parseInt(req.params.id);

  // Clean up access records
  db.run('DELETE FROM user_branch_stream_access WHERE user_id = ?', userId);
  db.run('DELETE FROM user_branch_access WHERE user_id = ?', userId);
  db.run('DELETE FROM client_users WHERE id = ? AND client_id = ?', [userId, client.id]);

  res.json({ ok: true });
});

// ─── Client Modules ─────────────────────────────────────────────────────────

router.get('/clients/:slug/modules', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Ensure all 3 module rows exist (for existing clients created before this feature)
  const defaultModules = [
    { key: 'forecast_ops', enabled: 1 },
    { key: 'vcfo_portal', enabled: 0 },
    { key: 'audit_view', enabled: 0 },
    { key: 'litigation_tool', enabled: 0 },
    { key: 'user_analysis', enabled: 1 },
    { key: 'user_insights', enabled: 1 },
  ];
  for (const m of defaultModules) {
    db.run(
      'INSERT OR IGNORE INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)',
      [client.id, m.key, m.enabled]
    );
  }

  const modules = db.all('SELECT module_key, is_enabled FROM client_modules WHERE client_id = ?', client.id);
  res.json(modules);
});

router.put('/clients/:slug/modules/:moduleKey', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { is_enabled } = req.body;
  const moduleKey = req.params.moduleKey as string;
  const validModules = ['forecast_ops', 'vcfo_portal', 'audit_view', 'litigation_tool', 'user_analysis', 'user_insights'];
  if (!validModules.includes(moduleKey)) {
    return res.status(400).json({ error: 'Invalid module key' });
  }

  db.run(
    'INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?) ON CONFLICT(client_id, module_key) DO UPDATE SET is_enabled = ?',
    [client.id, moduleKey, is_enabled ? 1 : 0, is_enabled ? 1 : 0]
  );

  res.json({ ok: true });
});

// ─── Client User Management ─────────────────────────────────────────────────

router.get('/clients/:slug/users', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const users = db.all(
    'SELECT id, username, display_name, role, is_active, created_at FROM client_users WHERE client_id = ?',
    client.id
  );
  res.json(users);
});

router.post('/clients/:slug/users', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { username, password, display_name, role } = req.body;

  if (!username || !password || !display_name) {
    return res.status(400).json({ error: 'username, password, and display_name required' });
  }

  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const existing = db.get(
    'SELECT id FROM client_users WHERE client_id = ? AND username = ?',
    [client.id, username]
  );
  if (existing) return res.status(409).json({ error: 'Username already exists for this client' });

  const hash = await bcrypt.hash(password, 12);
  const userRole = role || 'user';
  db.run(
    'INSERT INTO client_users (client_id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
    [client.id, username, hash, display_name, userRole]
  );
  const inserted = db.get('SELECT id FROM client_users WHERE client_id = ? AND username = ?', [client.id, username]);
  const newUserId = inserted.id;

  // Auto-grant access to all active branches for non-admin users
  if (userRole !== 'admin') {
    const activeBranches = db.all(
      'SELECT id FROM branches WHERE client_id = ? AND is_active = 1', [client.id]
    );
    for (const branch of activeBranches) {
      db.run('INSERT OR IGNORE INTO user_branch_access (user_id, branch_id, can_view_consolidated) VALUES (?, ?, 1)',
        [newUserId, branch.id]);
      const branchStreams = db.all('SELECT stream_id FROM branch_streams WHERE branch_id = ?', [branch.id]);
      for (const bs of branchStreams) {
        db.run('INSERT OR IGNORE INTO user_branch_stream_access (user_id, branch_id, stream_id, can_view_consolidated) VALUES (?, ?, ?, 1)',
          [newUserId, branch.id, bs.stream_id]);
      }
    }
  }

  res.status(201).json({ id: newUserId, username, display_name, role: userRole });
});

router.put('/clients/:slug/users/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { display_name, role, is_active, password } = req.body;
  const userId = parseInt(req.params.id);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (display_name) db.run('UPDATE client_users SET display_name = ? WHERE id = ? AND client_id = ?', [display_name, userId, client.id]);
  if (role) db.run('UPDATE client_users SET role = ? WHERE id = ? AND client_id = ?', [role, userId, client.id]);
  if (is_active !== undefined) db.run('UPDATE client_users SET is_active = ? WHERE id = ? AND client_id = ?', [is_active ? 1 : 0, userId, client.id]);
  if (password) {
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    const hash = await bcrypt.hash(password, 12);
    db.run('UPDATE client_users SET password_hash = ? WHERE id = ? AND client_id = ?', [hash, userId, client.id]);
  }

  res.json({ ok: true });
});

// ─── Client Integration Management ──────────────────────────────────────────

router.get('/clients/:slug/integrations', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id, industry FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Full settings catalog — core settings + integrations, filtered by industry
  // industries: null = common (all industries), defaultOn: auto-enabled for new/existing clients
  const fullCatalog = [
    // Core settings
    { key: 'financial_years', name: 'Financial Years', description: 'Manage financial year periods', industries: null, group: 'core', defaultOn: true },
    { key: 'doctors', name: 'Doctors', description: 'Manage doctor records for clinic billing', industries: ['healthcare'], group: 'core', defaultOn: true },
    // Integrations
    { key: 'manual_upload', name: 'Manual Upload', description: 'Upload Excel/CSV files manually', industries: null, group: 'integration', defaultOn: true },
    { key: 'tally', name: 'Tally Sync', description: 'Sync from Tally accounting software (coming soon)', industries: null, group: 'integration', defaultOn: false },
    { key: 'zoho_books', name: 'Zoho Books', description: 'Sync from Zoho Books (coming soon)', industries: null, group: 'integration', defaultOn: false },
    { key: 'healthplix', name: 'HealthPlix Sync', description: 'Auto-sync clinic data from HealthPlix EMR', industries: ['healthcare'], group: 'integration', defaultOn: false },
    { key: 'oneglance', name: 'OneGlance Sync', description: 'Auto-sync pharmacy data from OneGlance', industries: ['healthcare'], group: 'integration', defaultOn: false },
    { key: 'turia', name: 'Turia', description: 'Sync data from Turia platform', industries: ['consultancy'], group: 'integration', defaultOn: false },
  ];

  const clientIndustry = client.industry || 'custom';
  const catalog = fullCatalog.filter(c => !c.industries || c.industries.includes(clientIndustry));

  // Auto-create missing rows for catalog items (ensures existing clients get new settings)
  const existingKeys = new Set(
    db.all('SELECT integration_key FROM client_integrations WHERE client_id = ?', client.id)
      .map((i: any) => i.integration_key)
  );
  for (const item of catalog) {
    if (!existingKeys.has(item.key)) {
      db.run(
        'INSERT INTO client_integrations (client_id, integration_key, is_enabled) VALUES (?, ?, ?)',
        [client.id, item.key, item.defaultOn ? 1 : 0]
      );
    }
  }

  const integrations = db.all('SELECT * FROM client_integrations WHERE client_id = ?', client.id);

  res.json({
    enabled: integrations,
    catalog: catalog.map(c => ({
      ...c,
      enabled: integrations.some((i: any) => i.integration_key === c.key && i.is_enabled),
    })),
  });
});

router.put('/clients/:slug/integrations/:key', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { is_enabled, config } = req.body;

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const existing = db.get(
    'SELECT id FROM client_integrations WHERE client_id = ? AND integration_key = ?',
    [client.id, req.params.key]
  );

  if (existing) {
    if (is_enabled !== undefined) {
      db.run('UPDATE client_integrations SET is_enabled = ? WHERE id = ?', [is_enabled ? 1 : 0, existing.id]);
    }
    if (config !== undefined) {
      db.run('UPDATE client_integrations SET config = ? WHERE id = ?', [JSON.stringify(config), existing.id]);
    }
  } else {
    db.run(
      'INSERT INTO client_integrations (client_id, integration_key, is_enabled, config) VALUES (?, ?, ?, ?)',
      [client.id, req.params.key, is_enabled ? 1 : 0, config ? JSON.stringify(config) : null]
    );
  }

  res.json({ ok: true });
});

// ─── Business Stream Management ────────────────────────────────────────────

router.get('/clients/:slug/streams', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const streams = db.all('SELECT * FROM business_streams WHERE client_id = ? ORDER BY sort_order, id', client.id);
  res.json(streams);
});

router.post('/clients/:slug/streams', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { name, icon, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const maxOrder = db.get('SELECT MAX(sort_order) as max_order FROM business_streams WHERE client_id = ?', client.id);
  const sortOrder = (maxOrder?.max_order || 0) + 1;

  const result = db.run(
    'INSERT INTO business_streams (client_id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)',
    [client.id, name, icon || 'BarChart3', color || 'accent', sortOrder]
  );
  // Auto-create dashboard card for this stream
  const maxCardOrder = db.get('SELECT MAX(sort_order) as m FROM dashboard_cards WHERE client_id = ?', client.id);
  db.run('INSERT OR IGNORE INTO dashboard_cards (client_id, card_type, stream_id, title, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [client.id, 'stream', result.lastInsertRowid, name, icon || 'BarChart3', color || 'accent', (maxCardOrder?.m || 0) + 1]);

  res.status(201).json({ id: result.lastInsertRowid, name, icon: icon || 'BarChart3', color: color || 'accent', sort_order: sortOrder });
});

router.put('/clients/:slug/streams/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { name, icon, color, sort_order, is_active } = req.body;
  const streamId = parseInt(req.params.id);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (name !== undefined) db.run('UPDATE business_streams SET name = ? WHERE id = ? AND client_id = ?', [name, streamId, client.id]);
  if (icon !== undefined) db.run('UPDATE business_streams SET icon = ? WHERE id = ? AND client_id = ?', [icon, streamId, client.id]);
  if (color !== undefined) db.run('UPDATE business_streams SET color = ? WHERE id = ? AND client_id = ?', [color, streamId, client.id]);
  if (sort_order !== undefined) db.run('UPDATE business_streams SET sort_order = ? WHERE id = ? AND client_id = ?', [sort_order, streamId, client.id]);
  if (is_active !== undefined) db.run('UPDATE business_streams SET is_active = ? WHERE id = ? AND client_id = ?', [is_active ? 1 : 0, streamId, client.id]);
  // Sync dashboard card
  if (name !== undefined) db.run('UPDATE dashboard_cards SET title = ? WHERE stream_id = ? AND client_id = ?', [name, streamId, client.id]);
  if (icon !== undefined) db.run('UPDATE dashboard_cards SET icon = ? WHERE stream_id = ? AND client_id = ?', [icon, streamId, client.id]);
  if (color !== undefined) db.run('UPDATE dashboard_cards SET color = ? WHERE stream_id = ? AND client_id = ?', [color, streamId, client.id]);

  res.json({ ok: true });
});

router.delete('/clients/:slug/streams/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const streamId = parseInt(req.params.id);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  db.run('DELETE FROM business_streams WHERE id = ? AND client_id = ?', [streamId, client.id]);
  res.json({ ok: true });
});

// ─── Dashboard Cards Management ──────────────────────────────────────────────

router.get('/clients/:slug/dashboard-cards', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const cards = db.all('SELECT * FROM dashboard_cards WHERE client_id = ? ORDER BY sort_order, id', client.id);
  res.json(cards);
});

router.post('/clients/:slug/dashboard-cards', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { title, category, icon, color } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const maxOrder = db.get('SELECT MAX(sort_order) as m FROM dashboard_cards WHERE client_id = ?', client.id);
  const result = db.run(
    'INSERT INTO dashboard_cards (client_id, card_type, title, category, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [client.id, 'custom', title, category || 'revenue', icon || 'BarChart3', color || 'accent', (maxOrder?.m || 0) + 1]
  );
  res.status(201).json({ id: result.lastInsertRowid, title, card_type: 'custom' });
});

router.put('/clients/:slug/dashboard-cards/reorder', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { card_ids } = req.body;
  if (!Array.isArray(card_ids)) return res.status(400).json({ error: 'card_ids array required' });

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  card_ids.forEach((id: number, idx: number) => {
    db.run('UPDATE dashboard_cards SET sort_order = ? WHERE id = ? AND client_id = ?', [idx, id, client.id]);
  });
  res.json({ ok: true });
});

router.put('/clients/:slug/dashboard-cards/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const cardId = parseInt(req.params.id);
  const { is_visible, title, icon, color } = req.body;

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const card = db.get('SELECT * FROM dashboard_cards WHERE id = ? AND client_id = ?', [cardId, client.id]);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  if (is_visible !== undefined) db.run('UPDATE dashboard_cards SET is_visible = ? WHERE id = ?', [is_visible ? 1 : 0, cardId]);
  if (title !== undefined && card.card_type === 'custom') db.run('UPDATE dashboard_cards SET title = ? WHERE id = ?', [title, cardId]);
  if (icon !== undefined) db.run('UPDATE dashboard_cards SET icon = ? WHERE id = ?', [icon, cardId]);
  if (color !== undefined) db.run('UPDATE dashboard_cards SET color = ? WHERE id = ?', [color, cardId]);

  res.json({ ok: true });
});

router.delete('/clients/:slug/dashboard-cards/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const cardId = parseInt(req.params.id);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const card = db.get('SELECT * FROM dashboard_cards WHERE id = ? AND client_id = ?', [cardId, client.id]);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (card.card_type !== 'custom') return res.status(400).json({ error: 'Only custom cards can be deleted' });

  db.run('DELETE FROM dashboard_cards WHERE id = ?', cardId);
  res.json({ ok: true });
});

// ─── Dashboard Visibility (Charts/Tables) ───────────────────────────────────

router.get('/clients/:slug/dashboard-visibility', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const cards = db.all('SELECT * FROM dashboard_cards WHERE client_id = ? ORDER BY sort_order, id', client.id);
  const chartElements = db.all('SELECT * FROM dashboard_chart_visibility WHERE client_id = ? ORDER BY sort_order, id', client.id);
  const streams = db.all('SELECT id, name FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order', client.id);

  // Build scoped response
  const scopes: Record<string, { cards: any[]; charts: any[]; tables: any[] }> = {};

  // Total scope
  scopes['total'] = {
    cards: cards.filter(c => c.card_type === 'total' || c.card_type === 'custom'),
    charts: chartElements.filter(e => e.scope === 'total' && e.section === 'charts'),
    tables: chartElements.filter(e => e.scope === 'total' && e.section === 'tables'),
  };

  // Per-stream scopes
  for (const stream of streams) {
    const sid = String(stream.id);
    // Merge dashboard_cards (stream card) + dashboard_chart_visibility cards
    const streamCards: any[] = cards
      .filter(c => c.card_type === 'stream' && c.stream_id === stream.id)
      .map(c => ({ ...c, _source: 'dashboard_cards' }));
    const visCards = chartElements
      .filter(e => e.scope === sid && e.section === 'cards')
      .map(e => ({ ...e, _source: 'chart_visibility' }));
    scopes[sid] = {
      cards: [...streamCards, ...visCards],
      charts: chartElements.filter(e => e.scope === sid && e.section === 'charts'),
      tables: chartElements.filter(e => e.scope === sid && e.section === 'tables'),
    };
  }

  res.json({ scopes, streams });
});

router.put('/clients/:slug/dashboard-visibility/charts/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const elementId = parseInt(req.params.id);
  const { is_visible } = req.body;

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const element = db.get('SELECT * FROM dashboard_chart_visibility WHERE id = ? AND client_id = ?', [elementId, client.id]);
  if (!element) return res.status(404).json({ error: 'Element not found' });

  db.run('UPDATE dashboard_chart_visibility SET is_visible = ? WHERE id = ?', [is_visible ? 1 : 0, elementId]);
  res.json({ ok: true });
});

// ─── Branch Management ────────────────────────────────────────────────────────

router.get('/clients/:slug/branches', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const branches = db.all('SELECT * FROM branches WHERE client_id = ? ORDER BY sort_order, name', client.id);
  res.json(branches);
});

router.post('/clients/:slug/branches', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { name, code, city, manager_name, state } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Validate code format
  if (!/^[a-z0-9-]+$/.test(code)) {
    return res.status(400).json({ error: 'Branch code must be lowercase letters, numbers, and hyphens' });
  }

  const existing = db.get('SELECT id FROM branches WHERE client_id = ? AND code = ?', [client.id, code]);
  if (existing) return res.status(409).json({ error: 'Branch code already exists for this client' });

  const maxOrder = db.get('SELECT MAX(sort_order) as max_order FROM branches WHERE client_id = ?', client.id);
  const sortOrder = (maxOrder?.max_order || 0) + 1;

  const result = db.run(
    'INSERT INTO branches (client_id, name, code, city, manager_name, state, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [client.id, name, code, city || null, manager_name || null, state || '', sortOrder]
  );

  // If stream_ids provided, create branch_streams mappings
  const streamIds: number[] = req.body.stream_ids || [];
  for (const sid of streamIds) {
    db.run('INSERT OR IGNORE INTO branch_streams (branch_id, stream_id) VALUES (?, ?)', [result.lastInsertRowid, sid]);
  }

  res.status(201).json({ id: result.lastInsertRowid, name, code, city, state: state || '', manager_name, sort_order: sortOrder });
});

router.put('/clients/:slug/branches/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { name, code, city, manager_name, state, sort_order, is_active } = req.body;
  const branchId = parseInt(req.params.id as string);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (name !== undefined) db.run('UPDATE branches SET name = ? WHERE id = ? AND client_id = ?', [name, branchId, client.id]);
  if (code !== undefined) db.run('UPDATE branches SET code = ? WHERE id = ? AND client_id = ?', [code, branchId, client.id]);
  if (city !== undefined) db.run('UPDATE branches SET city = ? WHERE id = ? AND client_id = ?', [city, branchId, client.id]);
  if (manager_name !== undefined) db.run('UPDATE branches SET manager_name = ? WHERE id = ? AND client_id = ?', [manager_name, branchId, client.id]);
  if (state !== undefined) db.run('UPDATE branches SET state = ? WHERE id = ? AND client_id = ?', [state, branchId, client.id]);
  if (sort_order !== undefined) db.run('UPDATE branches SET sort_order = ? WHERE id = ? AND client_id = ?', [sort_order, branchId, client.id]);
  if (is_active !== undefined) db.run('UPDATE branches SET is_active = ? WHERE id = ? AND client_id = ?', [is_active ? 1 : 0, branchId, client.id]);

  res.json({ ok: true });
});

router.delete('/clients/:slug/branches/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const branchId = parseInt(req.params.id as string);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const branch = db.get('SELECT id FROM branches WHERE id = ? AND client_id = ?', [branchId, client.id]);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });

  // Hard delete — remove branch and all related records
  db.run('DELETE FROM user_branch_stream_access WHERE branch_id = ?', branchId);
  db.run('DELETE FROM user_branch_access WHERE branch_id = ?', branchId);
  db.run('DELETE FROM branch_streams WHERE branch_id = ?', branchId);
  db.run('DELETE FROM branches WHERE id = ? AND client_id = ?', [branchId, client.id]);
  res.json({ ok: true });
});

// ─── Branch-Stream Mapping ─────────────────────────────────────────────────

router.get('/clients/:slug/branches/:branchId/streams', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const branchId = parseInt(req.params.branchId as string);

  const streams = db.all(
    `SELECT bs.id, bs.name, bs.icon, bs.color,
            CASE WHEN bst.id IS NOT NULL THEN 1 ELSE 0 END as assigned
     FROM business_streams bs
     LEFT JOIN branch_streams bst ON bst.stream_id = bs.id AND bst.branch_id = ?
     WHERE bs.client_id = ? AND bs.is_active = 1
     ORDER BY bs.sort_order, bs.name`,
    branchId, client.id
  );
  res.json(streams);
});

router.put('/clients/:slug/branches/:branchId/streams', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const branchId = parseInt(req.params.branchId as string);
  const { stream_ids } = req.body;
  if (!Array.isArray(stream_ids)) return res.status(400).json({ error: 'stream_ids must be an array' });

  db.run('DELETE FROM branch_streams WHERE branch_id = ?', branchId);
  for (const sid of stream_ids) {
    db.run('INSERT INTO branch_streams (branch_id, stream_id) VALUES (?, ?)', [branchId, sid]);
  }
  res.json({ ok: true, count: stream_ids.length });
});

// ─── Per-Branch User Access ─────────────────────────────────────────────────

router.get('/clients/:slug/branches/:branchId/users', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const branchId = parseInt(req.params.branchId as string);

  const nonAdminUsers = db.all(
    `SELECT id FROM client_users WHERE client_id = ? AND role != 'admin' AND is_active = 1`,
    [client.id]
  );
  const total = nonAdminUsers.length;

  // Get streams linked to this branch
  const branchStreams = db.all(
    `SELECT bs.stream_id, s.name as stream_name
     FROM branch_streams bs
     JOIN business_streams s ON bs.stream_id = s.id
     WHERE bs.branch_id = ? AND s.is_active = 1
     ORDER BY s.name`,
    [branchId]
  );

  // Get per-stream user assignments
  const streamAccess = db.all(
    `SELECT ubsa.stream_id, ubsa.user_id
     FROM user_branch_stream_access ubsa
     JOIN branches b ON ubsa.branch_id = b.id
     WHERE ubsa.branch_id = ? AND b.client_id = ?`,
    [branchId, client.id]
  );

  // Build per-stream user map
  const streamUserMap: Record<number, number[]> = {};
  for (const sa of streamAccess) {
    if (!streamUserMap[sa.stream_id]) streamUserMap[sa.stream_id] = [];
    streamUserMap[sa.stream_id].push(sa.user_id);
  }

  const streams = branchStreams.map((bs: any) => ({
    id: bs.stream_id,
    name: bs.stream_name,
    user_ids: streamUserMap[bs.stream_id] || [],
  }));

  // Branch-level user access (for the toggle state)
  const branchUsers = db.all(
    `SELECT uba.user_id FROM user_branch_access uba
     JOIN branches b ON uba.branch_id = b.id
     WHERE uba.branch_id = ? AND b.client_id = ?`,
    [branchId, client.id]
  );
  const userIds = branchUsers.map((r: any) => r.user_id);
  const isRestricted = userIds.length < total;

  res.json({ user_ids: userIds, streams, total_non_admin_users: total, is_restricted: isRestricted });
});

router.put('/clients/:slug/branches/:branchId/users', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const branchId = parseInt(req.params.branchId as string);

  const branch = db.get('SELECT id FROM branches WHERE id = ? AND client_id = ?', [branchId, client.id]);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });

  const { restrict_access, stream_users } = req.body;

  // Get streams linked to this branch
  const branchStreams = db.all('SELECT stream_id FROM branch_streams WHERE branch_id = ?', [branchId]);
  const streamIds = branchStreams.map((r: any) => r.stream_id);

  // Clear existing access for this branch
  db.run('DELETE FROM user_branch_access WHERE branch_id = ?', [branchId]);
  db.run('DELETE FROM user_branch_stream_access WHERE branch_id = ?', [branchId]);

  if (!restrict_access) {
    // Grant all non-admin users access to all streams
    const allUsers = db.all(
      `SELECT id FROM client_users WHERE client_id = ? AND role != 'admin' AND is_active = 1`,
      [client.id]
    );
    for (const user of allUsers) {
      db.run('INSERT OR IGNORE INTO user_branch_access (user_id, branch_id, can_view_consolidated) VALUES (?, ?, 1)', [user.id, branchId]);
      for (const sid of streamIds) {
        db.run('INSERT OR IGNORE INTO user_branch_stream_access (user_id, branch_id, stream_id, can_view_consolidated) VALUES (?, ?, ?, 1)', [user.id, branchId, sid]);
      }
    }
    return res.json({ ok: true });
  }

  // Restricted: per-stream user assignments
  // stream_users: [{ stream_id: number, user_ids: number[] }]
  const perStreamUsers: { stream_id: number; user_ids: number[] }[] = Array.isArray(stream_users) ? stream_users : [];

  // Collect all unique user IDs across all streams for branch-level access
  const allUserIds = new Set<number>();
  for (const su of perStreamUsers) {
    for (const uid of su.user_ids) allUserIds.add(uid);
  }

  // Insert branch-level access for all users who have at least one stream
  for (const uid of allUserIds) {
    db.run('INSERT OR IGNORE INTO user_branch_access (user_id, branch_id, can_view_consolidated) VALUES (?, ?, 1)', [uid, branchId]);
  }

  // Insert per-stream access
  for (const su of perStreamUsers) {
    for (const uid of su.user_ids) {
      db.run('INSERT OR IGNORE INTO user_branch_stream_access (user_id, branch_id, stream_id, can_view_consolidated) VALUES (?, ?, ?, 1)', [uid, branchId, su.stream_id]);
    }
  }

  res.json({ ok: true });
});

// ─── User Branch+Stream Access ─────────────────────────────────────────────

router.get('/clients/:slug/users/:userId/access', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const userId = parseInt(req.params.userId as string);

  const access = db.all(
    `SELECT ubsa.branch_id, ubsa.stream_id, ubsa.can_view_consolidated,
            b.name as branch_name, b.code as branch_code, b.state,
            bs.name as stream_name
     FROM user_branch_stream_access ubsa
     JOIN branches b ON ubsa.branch_id = b.id
     JOIN business_streams bs ON ubsa.stream_id = bs.id
     WHERE ubsa.user_id = ? AND b.client_id = ?
     ORDER BY b.name, bs.name`,
    userId, client.id
  );
  res.json(access);
});

router.put('/clients/:slug/users/:userId/access', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const userId = parseInt(req.params.userId as string);
  const { access } = req.body;
  if (!Array.isArray(access)) return res.status(400).json({ error: 'access must be an array' });

  // Clear existing access for this user's client branches
  db.run(
    `DELETE FROM user_branch_stream_access WHERE user_id = ? AND branch_id IN (
      SELECT id FROM branches WHERE client_id = ?
    )`,
    userId, client.id
  );

  // Also sync user_branch_access (legacy table) — clear and rebuild from unique branches
  db.run(
    `DELETE FROM user_branch_access WHERE user_id = ? AND branch_id IN (
      SELECT id FROM branches WHERE client_id = ?
    )`,
    userId, client.id
  );

  const branchSet = new Set<number>();
  for (const entry of access) {
    const { branch_id, stream_id, can_view_consolidated } = entry;
    db.run(
      'INSERT OR IGNORE INTO user_branch_stream_access (user_id, branch_id, stream_id, can_view_consolidated) VALUES (?, ?, ?, ?)',
      [userId, branch_id, stream_id, can_view_consolidated ? 1 : 0]
    );
    branchSet.add(branch_id);
  }
  // Keep legacy user_branch_access in sync
  for (const bid of branchSet) {
    db.run(
      'INSERT OR IGNORE INTO user_branch_access (user_id, branch_id, can_view_consolidated) VALUES (?, ?, ?)',
      [userId, bid, access.some((a: any) => a.branch_id === bid && a.can_view_consolidated) ? 1 : 0]
    );
  }

  res.json({ ok: true, count: access.length });
});

// Enable multi-branch for a client (migrates existing data to a default branch)
router.post('/clients/:slug/enable-multi-branch', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id, is_multi_branch FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (client.is_multi_branch) {
    return res.status(400).json({ error: 'Client is already multi-branch' });
  }

  const { default_branch_name, default_branch_code } = req.body;
  if (!default_branch_name || !default_branch_code) {
    return res.status(400).json({ error: 'default_branch_name and default_branch_code required' });
  }

  // Create the default branch
  const result = db.run(
    'INSERT INTO branches (client_id, name, code, sort_order) VALUES (?, ?, ?, 1)',
    [client.id, default_branch_name, default_branch_code]
  );
  const defaultBranchId = result.lastInsertRowid;

  // Enable multi-branch flag
  db.run("UPDATE clients SET is_multi_branch = 1, updated_at = datetime('now') WHERE id = ?", [client.id]);

  // Migrate existing data in the client DB to the default branch
  try {
    const { getClientHelper } = await import('../db/connection.js');
    const clientDb = await getClientHelper(req.params.slug as string);
    const tables = ['clinic_actuals', 'pharmacy_sales_actuals', 'pharmacy_purchase_actuals', 'import_logs', 'scenarios', 'dashboard_actuals', 'budgets'];
    for (const table of tables) {
      try {
        clientDb.run(`UPDATE ${table} SET branch_id = ? WHERE branch_id IS NULL`, [defaultBranchId]);
      } catch { /* table might not have data */ }
    }
    console.log(`[Admin] Migrated existing data for "${req.params.slug}" to default branch ${defaultBranchId}`);
  } catch (err) {
    console.error('[Admin] Data migration error:', err);
  }

  // Assign all existing users to the default branch with consolidated access
  const users = db.all('SELECT id FROM client_users WHERE client_id = ?', client.id);
  for (const user of users) {
    db.run(
      'INSERT OR IGNORE INTO user_branch_access (user_id, branch_id, can_view_consolidated) VALUES (?, ?, 1)',
      [user.id, defaultBranchId]
    );
  }

  // Link all client streams to the default branch
  const clientStreams = db.all('SELECT id FROM business_streams WHERE client_id = ? AND is_active = 1', client.id);
  for (const stream of clientStreams) {
    db.run('INSERT OR IGNORE INTO branch_streams (branch_id, stream_id) VALUES (?, ?)', [defaultBranchId, stream.id]);
    // Also give all users stream-level access
    for (const user of users) {
      db.run(
        'INSERT OR IGNORE INTO user_branch_stream_access (user_id, branch_id, stream_id, can_view_consolidated) VALUES (?, ?, ?, 1)',
        [user.id, defaultBranchId, stream.id]
      );
    }
  }

  res.json({ ok: true, defaultBranchId, message: 'Multi-branch enabled. Existing data migrated to default branch.' });
});

// ─── User-Branch Access Management ──────────────────────────────────────────

router.get('/clients/:slug/users/:id/branches', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const userId = parseInt(req.params.id as string);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const access = db.all(
    `SELECT uba.branch_id, uba.can_view_consolidated, b.name, b.code
     FROM user_branch_access uba
     JOIN branches b ON uba.branch_id = b.id
     WHERE uba.user_id = ? AND b.client_id = ?`,
    [userId, client.id]
  );
  res.json(access);
});

router.put('/clients/:slug/users/:id/branches', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const userId = parseInt(req.params.id as string);
  const { branch_ids, can_view_consolidated } = req.body;

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (!Array.isArray(branch_ids)) {
    return res.status(400).json({ error: 'branch_ids must be an array' });
  }

  // Validate all branch_ids belong to this client
  for (const branchId of branch_ids) {
    const branch = db.get('SELECT id FROM branches WHERE id = ? AND client_id = ?', [branchId, client.id]);
    if (!branch) {
      return res.status(400).json({ error: `Branch ${branchId} does not belong to this client` });
    }
  }

  // Clear existing assignments for this client's branches
  db.run(
    `DELETE FROM user_branch_access WHERE user_id = ? AND branch_id IN (
      SELECT id FROM branches WHERE client_id = ?
    )`,
    [userId, client.id]
  );

  // Insert new assignments
  for (const branchId of branch_ids) {
    db.run(
      'INSERT INTO user_branch_access (user_id, branch_id, can_view_consolidated) VALUES (?, ?, ?)',
      [userId, branchId, can_view_consolidated ? 1 : 0]
    );
  }

  res.json({ ok: true });
});

// ─── Team Member Management ─────────────────────────────────────────────────

router.get('/team', async (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can manage team members' });
  const db = await getPlatformHelper();
  const team = db.all('SELECT id, username, display_name, role, is_active, is_owner, created_at FROM team_members ORDER BY display_name');
  // Attach assigned client count to each member
  const result = team.map((m: any) => ({
    ...m,
    assigned_client_count: m.is_owner
      ? db.all('SELECT id FROM clients WHERE is_active = 1').length
      : db.all('SELECT id FROM team_member_clients WHERE team_member_id = ?', m.id).length,
  }));
  res.json(result);
});

router.post('/team', async (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can add team members' });
  const db = await getPlatformHelper();
  const { username, password, display_name, role } = req.body;

  if (!username || !password || !display_name) {
    return res.status(400).json({ error: 'username, password, and display_name required' });
  }

  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  const existing = db.get('SELECT id FROM team_members WHERE username = ?', username);
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const hash = await bcrypt.hash(password, 12);
  const result = db.run(
    'INSERT INTO team_members (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
    [username, hash, display_name, role || 'super_admin']
  );

  res.status(201).json({ id: result.lastInsertRowid, username, display_name, role: role || 'super_admin' });
});

router.put('/team/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { display_name, role, is_active, password } = req.body;
  const id = parseInt(req.params.id);

  if (display_name) db.run('UPDATE team_members SET display_name = ? WHERE id = ?', [display_name, id]);
  if (role) db.run('UPDATE team_members SET role = ? WHERE id = ?', [role, id]);
  if (is_active !== undefined) db.run('UPDATE team_members SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
  if (password) {
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    const hash = await bcrypt.hash(password, 12);
    db.run('UPDATE team_members SET password_hash = ? WHERE id = ?', [hash, id]);
  }

  res.json({ ok: true });
});

// ─── Team Member Client Assignments ────────────────────────────────────────

router.get('/team/:id/clients', async (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can view assignments' });
  const db = await getPlatformHelper();
  const teamId = parseInt(req.params.id);
  const assigned = db.all(
    `SELECT c.id, c.slug, c.name, c.is_active, tmc.assigned_at
     FROM team_member_clients tmc
     JOIN clients c ON tmc.client_id = c.id
     WHERE tmc.team_member_id = ?
     ORDER BY c.name`,
    teamId
  );
  res.json(assigned);
});

router.put('/team/:id/clients', async (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can assign clients' });
  const db = await getPlatformHelper();
  const teamId = parseInt(req.params.id);
  const { client_ids } = req.body;

  if (!Array.isArray(client_ids)) {
    return res.status(400).json({ error: 'client_ids must be an array' });
  }

  // Don't allow assigning clients to the owner
  const member = db.get('SELECT is_owner FROM team_members WHERE id = ?', teamId);
  if (member?.is_owner) {
    return res.status(400).json({ error: 'Owner has access to all clients automatically' });
  }

  // Clear existing assignments and set new ones
  db.run('DELETE FROM team_member_clients WHERE team_member_id = ?', teamId);
  for (const clientId of client_ids) {
    db.run(
      'INSERT INTO team_member_clients (team_member_id, client_id) VALUES (?, ?)',
      [teamId, clientId]
    );
  }

  res.json({ ok: true, count: client_ids.length });
});

// ─── Client → Team Member Assignments (from client side) ───────────────────

router.get('/clients/:slug/team', async (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can view team assignments' });
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const assigned = db.all(
    `SELECT tm.id, tm.username, tm.display_name, tm.is_owner, tm.is_active, tmc.assigned_at
     FROM team_member_clients tmc
     JOIN team_members tm ON tmc.team_member_id = tm.id
     WHERE tmc.client_id = ?
     ORDER BY tm.display_name`,
    client.id
  );
  res.json(assigned);
});

router.put('/clients/:slug/team', async (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can assign team members' });
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { team_member_ids } = req.body;
  if (!Array.isArray(team_member_ids)) {
    return res.status(400).json({ error: 'team_member_ids must be an array' });
  }

  // Clear existing assignments for this client and set new ones
  db.run('DELETE FROM team_member_clients WHERE client_id = ?', client.id);
  for (const tmId of team_member_ids) {
    const member = db.get('SELECT id, is_owner FROM team_members WHERE id = ?', tmId);
    if (member && !member.is_owner) {
      db.run(
        'INSERT INTO team_member_clients (team_member_id, client_id) VALUES (?, ?)',
        [tmId, client.id]
      );
    }
  }

  res.json({ ok: true, count: team_member_ids.length });
});

// ─── Logo Management ──────────────────────────────────────────────────────────

// Helper: find logo file by prefix in a directory
function findLogoFile(dir: string, prefix: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix + '.') && !f.startsWith('temp-'));
  return files.length > 0 ? files[0] : null;
}

// Platform logo
router.post('/logo/platform', logoUpload.single('logo'), (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can manage platform logo' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const logosDir = getLogosDir();
  // Delete existing platform logos
  const existing = fs.readdirSync(logosDir).filter(f => f.startsWith('platform-logo.'));
  for (const f of existing) fs.unlinkSync(path.join(logosDir, f));

  // Rename temp file to platform-logo.{ext}
  const ext = path.extname(req.file.originalname).toLowerCase();
  const newName = `platform-logo${ext}`;
  fs.renameSync(req.file.path, path.join(logosDir, newName));

  res.json({ url: `/api/logos/${newName}` });
});

router.delete('/logo/platform', (req: Request, res: Response) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Only the owner can manage platform logo' });

  const logosDir = getLogosDir();
  const existing = fs.readdirSync(logosDir).filter(f => f.startsWith('platform-logo.'));
  for (const f of existing) fs.unlinkSync(path.join(logosDir, f));

  res.json({ ok: true });
});

// Client logo
router.post('/logo/client/:slug', logoUpload.single('logo'), async (req: Request, res: Response) => {
  const { slug } = req.params;
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const clientLogosDir = getClientLogosDir();
  // Delete existing client logos
  const existing = fs.readdirSync(clientLogosDir).filter(f => f.startsWith(`${slug}.`));
  for (const f of existing) fs.unlinkSync(path.join(clientLogosDir, f));

  // Rename temp file to {slug}.{ext}
  const ext = path.extname(req.file.originalname).toLowerCase();
  const newName = `${slug}${ext}`;
  fs.renameSync(req.file.path, path.join(clientLogosDir, newName));

  res.json({ url: `/api/logos/clients/${newName}` });
});

router.delete('/logo/client/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  const clientLogosDir = getClientLogosDir();
  const existing = fs.readdirSync(clientLogosDir).filter(f => f.startsWith(`${slug}.`));
  for (const f of existing) fs.unlinkSync(path.join(clientLogosDir, f));

  res.json({ ok: true });
});

export default router;
