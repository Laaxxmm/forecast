import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { getPlatformHelper } from '../db/platform-connection.js';
import { getClientHelper, getClientsDir } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { seedDatabase } from '../db/seed.js';
import { INDUSTRY_TEMPLATES } from '../config/industry-templates.js';
import path from 'path';
import fs from 'fs';

const router = Router();

// ─── Industry Templates ────────────────────────────────────────────────────

router.get('/industries', (_req: Request, res: Response) => {
  res.json(INDUSTRY_TEMPLATES);
});

// ─── Client Management ──────────────────────────────────────────────────────

router.get('/clients', async (_req: Request, res: Response) => {
  const db = await getPlatformHelper();
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

  // Create default admin user for this client
  const adminHash = await bcrypt.hash('admin123', 12);
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

  // Enable manual upload by default
  db.run(
    'INSERT INTO client_integrations (client_id, integration_key, is_enabled) VALUES (?, ?, ?)',
    [clientId, 'manual_upload', 1]
  );

  // Create default modules (forecast_ops enabled by default)
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'forecast_ops', 1]);
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'vcfo_portal', 0]);
  db.run('INSERT INTO client_modules (client_id, module_key, is_enabled) VALUES (?, ?, ?)', [clientId, 'audit_view', 0]);

  // Initialize client database
  const clientDb = await getClientHelper(slug);
  initializeSchema(clientDb);
  await seedDatabase(clientDb);

  console.log(`[Admin] Created client "${slug}" with DB ${dbFilename}`);

  res.status(201).json({
    id: clientId,
    slug,
    name,
    industry,
    db_filename: dbFilename,
    message: `Client created. Default login: admin / admin123`,
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
  const validModules = ['forecast_ops', 'vcfo_portal', 'audit_view'];
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

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const existing = db.get(
    'SELECT id FROM client_users WHERE client_id = ? AND username = ?',
    [client.id, username]
  );
  if (existing) return res.status(409).json({ error: 'Username already exists for this client' });

  const hash = await bcrypt.hash(password, 12);
  const result = db.run(
    'INSERT INTO client_users (client_id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
    [client.id, username, hash, display_name, role || 'user']
  );

  res.status(201).json({ id: result.lastInsertRowid, username, display_name, role: role || 'user' });
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
    const hash = await bcrypt.hash(password, 12);
    db.run('UPDATE client_users SET password_hash = ? WHERE id = ? AND client_id = ?', [hash, userId, client.id]);
  }

  res.json({ ok: true });
});

// ─── Client Integration Management ──────────────────────────────────────────

router.get('/clients/:slug/integrations', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const integrations = db.all('SELECT * FROM client_integrations WHERE client_id = ?', client.id);

  // Available integrations catalog
  const catalog = [
    { key: 'healthplix', name: 'HealthPlix Sync', description: 'Auto-sync clinic data from HealthPlix EMR' },
    { key: 'oneglance', name: 'OneGlance Sync', description: 'Auto-sync pharmacy data from OneGlance' },
    { key: 'manual_upload', name: 'Manual Upload', description: 'Upload Excel/CSV files manually' },
    { key: 'tally', name: 'Tally Sync', description: 'Sync from Tally accounting software (coming soon)' },
    { key: 'zoho_books', name: 'Zoho Books', description: 'Sync from Zoho Books (coming soon)' },
  ];

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
  const { name, code, city, manager_name } = req.body;
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
    'INSERT INTO branches (client_id, name, code, city, manager_name, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [client.id, name, code, city || null, manager_name || null, sortOrder]
  );

  res.status(201).json({ id: result.lastInsertRowid, name, code, city, manager_name, sort_order: sortOrder });
});

router.put('/clients/:slug/branches/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { name, code, city, manager_name, sort_order, is_active } = req.body;
  const branchId = parseInt(req.params.id as string);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (name !== undefined) db.run('UPDATE branches SET name = ? WHERE id = ? AND client_id = ?', [name, branchId, client.id]);
  if (code !== undefined) db.run('UPDATE branches SET code = ? WHERE id = ? AND client_id = ?', [code, branchId, client.id]);
  if (city !== undefined) db.run('UPDATE branches SET city = ? WHERE id = ? AND client_id = ?', [city, branchId, client.id]);
  if (manager_name !== undefined) db.run('UPDATE branches SET manager_name = ? WHERE id = ? AND client_id = ?', [manager_name, branchId, client.id]);
  if (sort_order !== undefined) db.run('UPDATE branches SET sort_order = ? WHERE id = ? AND client_id = ?', [sort_order, branchId, client.id]);
  if (is_active !== undefined) db.run('UPDATE branches SET is_active = ? WHERE id = ? AND client_id = ?', [is_active ? 1 : 0, branchId, client.id]);

  res.json({ ok: true });
});

router.delete('/clients/:slug/branches/:id', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const branchId = parseInt(req.params.id as string);

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Soft delete — deactivate instead of removing
  db.run('UPDATE branches SET is_active = 0 WHERE id = ? AND client_id = ?', [branchId, client.id]);
  res.json({ ok: true });
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

router.get('/team', async (_req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const team = db.all('SELECT id, username, display_name, role, is_active, created_at FROM team_members ORDER BY display_name');
  res.json(team);
});

router.post('/team', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { username, password, display_name, role } = req.body;

  if (!username || !password || !display_name) {
    return res.status(400).json({ error: 'username, password, and display_name required' });
  }

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
    const hash = await bcrypt.hash(password, 12);
    db.run('UPDATE team_members SET password_hash = ? WHERE id = ?', [hash, id]);
  }

  res.json({ ok: true });
});

export default router;
