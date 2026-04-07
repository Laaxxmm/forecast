import initSqlJs, { Database } from 'sql.js';
import path from 'path';
import fs from 'fs';

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'magna_tracker.db');

let db: Database;

export async function getDb(): Promise<Database> {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

export function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Helper to run queries similar to better-sqlite3 API
export class DbHelper {
  constructor(private db: Database) {}

  run(sql: string, ...params: any[]) {
    const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    this.db.run(sql, flat);
    saveDb();
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
    saveDb();
  }
}

let helper: DbHelper;

export async function getHelper(): Promise<DbHelper> {
  if (helper) return helper;
  const database = await getDb();
  helper = new DbHelper(database);
  return helper;
}
