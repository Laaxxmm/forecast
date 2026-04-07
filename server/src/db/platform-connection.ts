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
  fs.writeFileSync(platformDbPath, Buffer.from(data));
}

export async function getPlatformDb(): Promise<Database> {
  if (platformDb) return platformDb;
  const SQL = await initSqlJs();
  if (fs.existsSync(platformDbPath)) {
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
