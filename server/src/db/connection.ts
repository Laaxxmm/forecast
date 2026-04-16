import Database from 'better-sqlite3';
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
//
// Thin wrapper around better-sqlite3 that preserves the async-shaped API used
// across every route file (`req.tenantDb.run/get/all/exec/beginBatch/...`).
// All operations are synchronous under the hood — we just keep the existing
// call sites working unchanged.
//
// sql.js quirk preserved: callers that pass `undefined` as a bind value get
// NULL (better-sqlite3 throws on undefined by default).

function coerceUndefinedToNull(params: any[]): any[] {
  return params.map((v) => (v === undefined ? null : v));
}

export class DbHelper {
  private _batchMode = false;
  constructor(private db: Database.Database) {}

  /** Start batch mode — wraps the following writes in a SQL transaction. */
  beginBatch() {
    if (this._batchMode) return;
    this.db.exec('BEGIN');
    this._batchMode = true;
  }

  /** End batch mode — commits the transaction. */
  endBatch() {
    if (!this._batchMode) return;
    this.db.exec('COMMIT');
    this._batchMode = false;
  }

  /** Rollback batch on error. */
  rollbackBatch() {
    if (!this._batchMode) return;
    try { this.db.exec('ROLLBACK'); } catch {}
    this._batchMode = false;
  }

  run(sql: string, ...params: any[]) {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const bound = coerceUndefinedToNull(flat);
    const result = this.db.prepare(sql).run(...bound);
    return {
      lastInsertRowid: Number(result.lastInsertRowid),
      changes: result.changes,
    };
  }

  get(sql: string, ...params: any[]): any {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const bound = coerceUndefinedToNull(flat);
    const row = this.db.prepare(sql).get(...bound);
    return row ?? null;
  }

  all(sql: string, ...params: any[]): any[] {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const bound = coerceUndefinedToNull(flat);
    return this.db.prepare(sql).all(...bound) as any[];
  }

  exec(sql: string) {
    this.db.exec(sql);
  }
}

// ── Client DB Connection Pool ───────────────────────────────────────────────

const clientDbCache = new Map<string, { db: Database.Database; helper: DbHelper }>();

export async function getClientHelper(slug: string): Promise<DbHelper> {
  const cached = clientDbCache.get(slug);
  if (cached) return cached.helper;

  const dbPath = path.join(clientsDir, `${slug}.db`);
  const bakPath = dbPath + '.bak';
  const tmpPath = dbPath + '.tmp';

  // Recovery: if main DB is missing or empty, restore from the most recent
  // intact copy. (Legacy sql.js could leave a 0-byte main file on a crash
  // during export. Kept for safety while migrated files still might predate
  // better-sqlite3.)
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

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const helper = new DbHelper(db);
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
    const db = new Database(oldDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    legacyHelper = new DbHelper(db);
    return legacyHelper;
  }

  // Fall back to magnacode client DB
  legacyHelper = await getClientHelper('magnacode');
  return legacyHelper;
}

export function saveDb() {
  // Legacy no-op — better-sqlite3 writes directly to disk
}

export async function getDb(): Promise<Database.Database> {
  // Legacy wrapper
  const helper = await getHelper();
  return (helper as any).db;
}

/** Checkpoint WAL and close all cached client DB handles. */
export function closeAll() {
  for (const [slug, { db }] of clientDbCache) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.log(`[DB] Closed client DB: ${slug}`);
    } catch (e) {
      console.error(`[DB] Error closing ${slug}:`, e);
    }
  }
  clientDbCache.clear();
}

process.on('SIGTERM', () => {
  console.log('[DB] SIGTERM received — closing all client databases');
  closeAll();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[DB] SIGINT received — closing all client databases');
  closeAll();
  process.exit(0);
});

/** Create daily backups for all client databases (call on startup). */
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
