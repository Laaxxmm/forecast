import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DbHelper } from './connection.js';

const isProd = process.env.NODE_ENV === 'production';
const dataDir = process.env.DATA_DIR || (isProd ? '/data' : path.join(__dirname, '..', '..', '..', 'data'));

try {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
} catch (e) {
  console.error(`[Platform DB] Failed to create data dir ${dataDir}`);
}

const platformDbPath = path.join(dataDir, 'platform.db');
console.log(`[Platform DB] Path: ${platformDbPath}`);

let platformDb: Database.Database | null = null;
let platformHelper: DbHelper | null = null;

export function savePlatformDb() {
  // Legacy no-op — better-sqlite3 writes directly to disk
}

export async function getPlatformDb(): Promise<Database.Database> {
  if (platformDb) return platformDb;

  const bakPath = platformDbPath + '.bak';
  const tmpPath = platformDbPath + '.tmp';

  // Recovery: if main DB is missing or empty, restore from backup
  const mainExists = fs.existsSync(platformDbPath);
  const mainSize = mainExists ? fs.statSync(platformDbPath).size : 0;
  if (!mainExists || mainSize === 0) {
    if (fs.existsSync(bakPath) && fs.statSync(bakPath).size > 0) {
      console.log(`[Platform DB] ⚠ Recovering from backup (main DB ${mainExists ? 'empty' : 'missing'})...`);
      fs.copyFileSync(bakPath, platformDbPath);
    } else if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
      console.log(`[Platform DB] ⚠ Recovering from temp file...`);
      fs.copyFileSync(tmpPath, platformDbPath);
    }
  }

  platformDb = new Database(platformDbPath);
  platformDb.pragma('journal_mode = WAL');
  platformDb.pragma('foreign_keys = ON');
  return platformDb;
}

export async function getPlatformHelper(): Promise<DbHelper> {
  if (platformHelper) return platformHelper;
  const db = await getPlatformDb();
  platformHelper = new DbHelper(db);
  return platformHelper;
}

/** Create daily backup of the platform database (call on startup) */
export function createPlatformBackup() {
  if (!fs.existsSync(platformDbPath) || fs.statSync(platformDbPath).size === 0) return;

  const backupDir = path.join(dataDir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(backupDir, `platform.db.${today}`);

  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(platformDbPath, backupPath);
    console.log(`[Platform DB] Daily backup: platform.db.${today}`);

    // Keep last 3 daily backups
    const backups = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('platform.db.'))
      .sort();
    for (const old of backups.slice(0, -3)) {
      try { fs.unlinkSync(path.join(backupDir, old)); } catch {}
    }
  }
}
