import initSqlJs, { Database } from 'sql.js';
import path from 'path';
import fs from 'fs';

// Use Railway Volume (/data) in production, or local data/ folder
const isProd = process.env.NODE_ENV === 'production';
const dataDir = process.env.DATA_DIR || (isProd ? '/data' : path.join(__dirname, '..', '..', '..', 'data'));
const clientsDir = path.join(dataDir, 'clients');

try {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(clientsDir)) fs.mkdirSync(clientsDir, { recursive: true });
} catch (e) {
  console.error(`[DB] Failed to create directories`);
}

export function getClientsDir(): string {
  return clientsDir;
}

// ── DbHelper ────────────────────────────────────────────────────────────────

export class DbHelper {
  constructor(private db: Database, private saveFn?: () => void) {}

  private save() {
    this.saveFn?.();
  }

  run(sql: string, ...params: any[]) {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    this.db.run(sql, flat);
    this.save();
    return {
      lastInsertRowid: (this.db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0] as number) || 0,
      changes: this.db.getRowsModified(),
    };
  }

  get(sql: string, ...params: any[]): any {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const stmt = this.db.prepare(sql);
    stmt.bind(flat);
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      stmt.free();
      const row: any = {};
      cols.forEach((c, i) => row[c] = vals[i]);
      return row;
    }
    stmt.free();
    return null;
  }

  all(sql: string, ...params: any[]): any[] {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const stmt = this.db.prepare(sql);
    stmt.bind(flat);
    const results: any[] = [];
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const row: any = {};
      cols.forEach((c, i) => row[c] = vals[i]);
      results.push(row);
    }
    stmt.free();
    return results;
  }

  exec(sql: string) {
    this.db.run(sql);
    this.save();
  }
}

// ── Client DB Connection Pool ───────────────────────────────────────────────

const clientDbCache = new Map<string, { db: Database; helper: DbHelper }>();

function saveClientDb(slug: string) {
  const entry = clientDbCache.get(slug);
  if (!entry) return;
  const data = entry.db.export();
  const dbPath = path.join(clientsDir, `${slug}.db`);
  const tmpPath = dbPath + '.tmp';
  const bakPath = dbPath + '.bak';

  // Atomic write: temp → rename (prevents corruption if process killed mid-write)
  fs.writeFileSync(tmpPath, Buffer.from(data));
  if (fs.existsSync(dbPath)) {
    try { fs.renameSync(dbPath, bakPath); } catch {}
  }
  fs.renameSync(tmpPath, dbPath);
}

export async function getClientHelper(slug: string): Promise<DbHelper> {
  const cached = clientDbCache.get(slug);
  if (cached) return cached.helper;

  const dbPath = path.join(clientsDir, `${slug}.db`);
  const bakPath = dbPath + '.bak';
  const tmpPath = dbPath + '.tmp';

  // Recovery: if main DB is missing or empty (corrupted write), restore from backup
  const mainExists = fs.existsSync(dbPath);
  const mainSize = mainExists ? fs.statSync(dbPath).size : 0;
  if (!mainExists || mainSize === 0) {
    if (fs.existsSync(bakPath) && fs.statSync(bakPath).size > 0) {
      console.log(`[DB] ⚠ Recovering "${slug}" from backup (main DB ${mainExists ? 'empty' : 'missing'})...`);
      fs.copyFileSync(bakPath, dbPath);
    } else if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
      console.log(`[DB] ⚠ Recovering "${slug}" from temp file...`);
      fs.copyFileSync(tmpPath, dbPath);
    }
  }

  const SQL = await initSqlJs();

  let db: Database;
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');

  const helper = new DbHelper(db, () => saveClientDb(slug));
  clientDbCache.set(slug, { db, helper });

  console.log(`[DB] Loaded client DB: ${slug} (${dbPath})`);
  return helper;
}

// ── Legacy support (backwards compatibility during migration) ───────────────

// The old singleton pattern — now points to the default client (magnacode)
// TODO: Remove once all routes use req.tenantDb
let legacyHelper: DbHelper | null = null;

export async function getHelper(): Promise<DbHelper> {
  if (legacyHelper) return legacyHelper;

  // Try loading the old magna_tracker.db for backward compat
  const oldDbPath = path.join(dataDir, 'magna_tracker.db');
  if (fs.existsSync(oldDbPath)) {
    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(oldDbPath);
    const db = new SQL.Database(buffer);
    db.run('PRAGMA foreign_keys = ON');
    legacyHelper = new DbHelper(db, () => {
      const data = db.export();
      fs.writeFileSync(oldDbPath, Buffer.from(data));
    });
    return legacyHelper;
  }

  // Fall back to magnacode client DB
  legacyHelper = await getClientHelper('magnacode');
  return legacyHelper;
}

export function saveDb() {
  // Legacy: save the old DB if it exists, otherwise no-op
  // Client DBs auto-save via their DbHelper saveFn
}

export async function getDb(): Promise<Database> {
  // Legacy wrapper
  const helper = await getHelper();
  return (helper as any).db;
}

/** Create daily backups for all loaded client databases (call on startup) */
export function createDailyBackups() {
  const backupDir = path.join(clientsDir, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);

  // Backup all .db files in the clients directory
  for (const file of fs.readdirSync(clientsDir)) {
    if (!file.endsWith('.db')) continue;
    const dbPath = path.join(clientsDir, file);
    if (fs.statSync(dbPath).size === 0) continue; // skip empty DBs

    const backupName = `${file}.${today}`;
    const backupPath = path.join(backupDir, backupName);

    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(dbPath, backupPath);
      console.log(`[DB] Daily backup: ${backupName}`);
    }
  }

  // Clean old backups — keep last 3 per database
  const backups = fs.readdirSync(backupDir).sort();
  const grouped = new Map<string, string[]>();
  for (const f of backups) {
    const base = f.replace(/\.\d{4}-\d{2}-\d{2}$/, '');
    if (!grouped.has(base)) grouped.set(base, []);
    grouped.get(base)!.push(f);
  }
  for (const [, files] of grouped) {
    for (const old of files.slice(0, -3)) {
      try { fs.unlinkSync(path.join(backupDir, old)); } catch {}
    }
  }
}
