import { DbHelper } from './connection.js';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { initializeSchema } from './schema.js';
import { seedDatabase } from './seed.js';
import { getClientHelper, getClientsDir } from './connection.js';

/**
 * Seed the platform database with:
 * 1. Default super admin (your team)
 * 2. Magnacode as the first client (migrate existing data)
 */
export async function seedPlatformDatabase(platformDb: DbHelper) {
  // 1. Create default super admin
  const superUser = process.env.SUPER_ADMIN_USERNAME || 'superadmin';
  const superPass = process.env.SUPER_ADMIN_PASSWORD || 'super123';
  const superName = process.env.SUPER_ADMIN_DISPLAY_NAME || 'Super Admin';

  const existingSuperAdmin = platformDb.get('SELECT id FROM team_members WHERE username = ?', superUser);
  if (!existingSuperAdmin) {
    const hash = await bcrypt.hash(superPass, 12);
    platformDb.run(
      'INSERT INTO team_members (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
      [superUser, hash, superName, 'super_admin']
    );
    console.log(`[Platform Seed] Super admin "${superUser}" created`);
  }

  // 2. Create default client (magnacode) if none exists
  const clientCount = platformDb.get('SELECT COUNT(*) as cnt FROM clients');
  if (clientCount.cnt === 0) {
    const slug = 'magnacode';
    const dbFilename = `${slug}.db`;

    platformDb.run(
      'INSERT INTO clients (slug, name, db_filename) VALUES (?, ?, ?)',
      [slug, 'MagnaCode Healthcare', dbFilename]
    );
    const client = platformDb.get('SELECT id FROM clients WHERE slug = ?', slug);

    // Create default client user (migrate from existing admin)
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const adminName = process.env.ADMIN_DISPLAY_NAME || 'Administrator';
    const adminHash = await bcrypt.hash(adminPass, 12);

    platformDb.run(
      'INSERT INTO client_users (client_id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)',
      [client.id, adminUser, adminHash, adminName, 'admin']
    );

    // Enable integrations for magnacode
    platformDb.run(
      'INSERT INTO client_integrations (client_id, integration_key, is_enabled) VALUES (?, ?, ?)',
      [client.id, 'healthplix', 1]
    );
    platformDb.run(
      'INSERT INTO client_integrations (client_id, integration_key, is_enabled) VALUES (?, ?, ?)',
      [client.id, 'oneglance', 1]
    );

    console.log(`[Platform Seed] Client "${slug}" created with user "${adminUser}"`);

    // 3. Initialize client DB if it doesn't exist
    const clientsDir = getClientsDir();
    const clientDbPath = path.join(clientsDir, dbFilename);
    if (!fs.existsSync(clientDbPath)) {
      // Check if there's an existing magna_tracker.db to migrate
      const isProd = process.env.NODE_ENV === 'production';
      const dataDir = process.env.DATA_DIR || (isProd ? '/data' : path.join(__dirname, '..', '..', '..', 'data'));
      const oldDbPath = path.join(dataDir, 'magna_tracker.db');

      if (fs.existsSync(oldDbPath)) {
        // Migrate: copy existing DB to client folder
        fs.copyFileSync(oldDbPath, clientDbPath);
        console.log(`[Platform Seed] Migrated existing DB to ${clientDbPath}`);
      } else {
        // Fresh client: initialize schema + seed
        const clientDb = await getClientHelper(slug);
        initializeSchema(clientDb);
        await seedDatabase(clientDb);
        console.log(`[Platform Seed] Initialized fresh DB for "${slug}"`);
      }
    }
  }
}
