import initSqlJs, { Database } from 'sql.js';
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

let platformDb: Database;
let platformHelper: DbHelper;

export function savePlatformDb() {
  if (!platformDb) return;
  const data = platformDb.export();
  const tmpPath = platformDbPath + '.tmp';
  const bakPath = platformDbPath + '.bak';

  // Atomic write: temp → rename (prevents corruption if process killed mid-write)
  fs.writeFileSync(tmpPath, Buffer.from(data));
  if (fs.existsSync(platformDbPath)) {
    try { fs.renameSync(platformDbPath, bakPath); } catch {}
  }
  fs.renameSync(tmpPath, platformDbPath);
}

export async function getPlatformDb(): Promise<Database> {
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

  const SQL = await initSqlJs();
  if (fs.existsSync(platformDbPath) && fs.statSync(platformDbPath).size > 0) {
    const buffer = fs.readFileSync(platformDbPath);
    platformDb = new SQL.Database(buffer);
  } else {
    platformDb = new SQL.Database();
  }
  platformDb.run('PRAGMA foreign_keys = ON');
  return platformDb;
}

export async function getPlatformHelper(): Promise<DbHelper> {
  if (platformHelper) return platformHelper;
  const db = await getPlatformDb();
  // Create a DbHelper that saves to the platform DB path
  platformHelper = new DbHelper(db, savePlatformDb);
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
      .filter(f => f.startsWith('platform.db.'))
      .sort();
    for (const old of backups.slice(0, -3)) {
      try { fs.unlinkSync(path.join(backupDir, old)); } catch {}
    }
  }
}
