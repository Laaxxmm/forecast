import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { getPlatformHelper } from '../db/platform-connection.js';
import { getClientHelper, getClientsDir } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { seedDatabase } from '../db/seed.js';
import path from 'path';
import fs from 'fs';

const router = Router();

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

  res.json({ ...client, users, integrations });
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

  // Enable manual upload by default
  db.run(
    'INSERT INTO client_integrations (client_id, integration_key, is_enabled) VALUES (?, ?, ?)',
    [clientId, 'manual_upload', 1]
  );

  // Initialize client database
  const clientDb = await getClientHelper(slug);
  initializeSchema(clientDb);
  await seedDatabase(clientDb);

  console.log(`[Admin] Created client "${slug}" with DB ${dbFilename}`);

  res.status(201).json({
    id: clientId,
    slug,
    name,
    db_filename: dbFilename,
    message: `Client created. Default login: admin / admin123`,
  });
});

router.put('/clients/:slug', async (req: Request, res: Response) => {
  const db = await getPlatformHelper();
  const { name, is_active } = req.body;

  const client = db.get('SELECT id FROM clients WHERE slug = ?', req.params.slug);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  if (name !== undefined) {
    db.run('UPDATE clients SET name = ?, updated_at = datetime(\'now\') WHERE id = ?', [name, client.id]);
  }
  if (is_active !== undefined) {
    db.run('UPDATE clients SET is_active = ?, updated_at = datetime(\'now\') WHERE id = ?', [is_active ? 1 : 0, client.id]);
  }

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
