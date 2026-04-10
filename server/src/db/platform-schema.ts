import { DbHelper } from './connection.js';

export function initializePlatformSchema(db: DbHelper) {
  db.exec(`
    -- Super admins (your team)
    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'super_admin',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Client organizations
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      db_filename TEXT NOT NULL,
      config TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Client users (login for client staff)
    CREATE TABLE IF NOT EXISTS client_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, username)
    );

    -- Integration plugins enabled per client
    CREATE TABLE IF NOT EXISTS client_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      integration_key TEXT NOT NULL,
      is_enabled INTEGER DEFAULT 1,
      config TEXT,
      UNIQUE(client_id, integration_key)
    );

    -- Business streams (revenue sources) per client
    CREATE TABLE IF NOT EXISTS business_streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      name TEXT NOT NULL,
      icon TEXT DEFAULT 'BarChart3',
      color TEXT DEFAULT 'accent',
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, name)
    );

    -- Branches (locations/units) per client
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      city TEXT,
      manager_name TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, code)
    );

    -- User-branch access mapping
    CREATE TABLE IF NOT EXISTS user_branch_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES client_users(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      can_view_consolidated INTEGER DEFAULT 0,
      UNIQUE(user_id, branch_id)
    );

    -- Modules enabled per client (super admin controls)
    CREATE TABLE IF NOT EXISTS client_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      module_key TEXT NOT NULL,
      is_enabled INTEGER DEFAULT 0,
      UNIQUE(client_id, module_key)
    );

    -- Team member → client assignments (scoped access for non-owner admins)
    CREATE TABLE IF NOT EXISTS team_member_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_member_id INTEGER NOT NULL REFERENCES team_members(id),
      client_id INTEGER NOT NULL REFERENCES clients(id),
      assigned_at TEXT DEFAULT (datetime('now')),
      UNIQUE(team_member_id, client_id)
    );

    -- Branch → stream mapping (which streams a branch operates)
    CREATE TABLE IF NOT EXISTS branch_streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      stream_id INTEGER NOT NULL REFERENCES business_streams(id) ON DELETE CASCADE,
      is_active INTEGER DEFAULT 1,
      UNIQUE(branch_id, stream_id)
    );

    -- User branch+stream access (fine-grained per-stream control)
    CREATE TABLE IF NOT EXISTS user_branch_stream_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      stream_id INTEGER NOT NULL REFERENCES business_streams(id) ON DELETE CASCADE,
      can_view_consolidated INTEGER DEFAULT 0,
      UNIQUE(user_id, branch_id, stream_id)
    );

    -- Dashboard KPI cards per client
    CREATE TABLE IF NOT EXISTS dashboard_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      card_type TEXT NOT NULL DEFAULT 'stream',
      stream_id INTEGER REFERENCES business_streams(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT DEFAULT 'revenue',
      icon TEXT DEFAULT 'BarChart3',
      color TEXT DEFAULT 'accent',
      is_visible INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, card_type, stream_id)
    );

    -- Dashboard chart/table visibility per client
    CREATE TABLE IF NOT EXISTS dashboard_chart_visibility (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      scope TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT 'charts',
      element_key TEXT NOT NULL,
      element_label TEXT NOT NULL,
      is_visible INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(client_id, scope, section, element_key)
    );
  `);

  // Safe migrations for existing DBs
  const migrations = [
    "ALTER TABLE clients ADD COLUMN industry TEXT DEFAULT 'custom'",
    "ALTER TABLE clients ADD COLUMN is_multi_branch INTEGER DEFAULT 0",
    "ALTER TABLE client_integrations ADD COLUMN branch_id INTEGER REFERENCES branches(id)",
    "ALTER TABLE team_members ADD COLUMN is_owner INTEGER DEFAULT 0",
    "ALTER TABLE branches ADD COLUMN state TEXT DEFAULT ''",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // Auto-promote the first team member to owner if none exist
  const ownerExists = db.get('SELECT id FROM team_members WHERE is_owner = 1');
  if (!ownerExists) {
    const first = db.get('SELECT id FROM team_members ORDER BY id LIMIT 1');
    if (first) {
      db.run('UPDATE team_members SET is_owner = 1 WHERE id = ?', first.id);
    }
  }

  // Backfill dashboard_cards for existing clients that have streams but no cards
  const clientsNeedingCards = db.all(
    `SELECT DISTINCT client_id FROM business_streams
     WHERE client_id NOT IN (SELECT DISTINCT client_id FROM dashboard_cards)`
  );
  for (const c of clientsNeedingCards) {
    db.run('INSERT OR IGNORE INTO dashboard_cards (client_id, card_type, title, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [c.client_id, 'total', 'Total Revenue', 'IndianRupee', 'accent', 0]);
    const streams = db.all('SELECT * FROM business_streams WHERE client_id = ? ORDER BY sort_order', c.client_id);
    streams.forEach((s: any, i: number) => {
      db.run('INSERT OR IGNORE INTO dashboard_cards (client_id, card_type, stream_id, title, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [c.client_id, 'stream', s.id, s.name, s.icon, s.color, i + 1]);
    });
  }

  // Backfill dashboard_chart_visibility for existing clients
  const allClients = db.all('SELECT id FROM clients');
  for (const c of allClients) {
    // Total scope charts
    db.run('INSERT OR IGNORE INTO dashboard_chart_visibility (client_id, scope, section, element_key, element_label, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [c.id, 'total', 'charts', 'monthly_revenue_trend', 'Monthly Revenue Trend', 0]);
    db.run('INSERT OR IGNORE INTO dashboard_chart_visibility (client_id, scope, section, element_key, element_label, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [c.id, 'total', 'charts', 'revenue_split', 'Revenue Split', 1]);
    // Per-stream charts
    const streams = db.all('SELECT * FROM business_streams WHERE client_id = ? ORDER BY sort_order', c.id);
    streams.forEach((s: any, i: number) => {
      db.run('INSERT OR IGNORE INTO dashboard_chart_visibility (client_id, scope, section, element_key, element_label, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        [c.id, String(s.id), 'charts', 'stream_in_trend', `${s.name} in Trend Chart`, i]);
    });
  }
}
