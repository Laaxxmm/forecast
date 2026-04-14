#!/usr/bin/env node
/**
 * Read-only inspection: what VCFO data exists today?
 *
 * Walks the TallyVision data root (TALLYVISION_DATA env var, or the local
 * dev default) and reports per-file table/row counts so we know what Step 3
 * of the DB unification migration actually has to move.
 */

import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const serverPkgJson = path.join(ROOT, 'server', 'package.json');
const requireFromServer = createRequire(serverPkgJson);
const Database = requireFromServer('better-sqlite3');

// Match the TallyVision setup.js default.
const TV_ROOT =
  process.env.TALLYVISION_DATA ||
  path.join(ROOT, 'Vcfo-app', 'TallyVision_2.0', 'data');

function tablesWithCounts(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map(r => r.name);

    const out = {};
    for (const t of tables) {
      try {
        out[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      } catch (e) {
        out[t] = `<error: ${e.message}>`;
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function walk(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        // Skip uploads/ and backups/ — big, irrelevant to schema inspection
        if (/^(uploads|backups|node_modules)$/i.test(entry.name)) continue;
        stack.push(p);
      } else if (entry.name.endsWith('.db') && !/-(wal|shm)$/.test(entry.name)) {
        found.push(p);
      }
    }
  }
  return found;
}

function main() {
  console.log(`\nVCFO data root: ${TV_ROOT}`);
  if (!fs.existsSync(TV_ROOT)) {
    console.log('  (does not exist — nothing to migrate)');
    process.exit(0);
  }

  const dbs = walk(TV_ROOT);
  if (!dbs.length) {
    console.log('  (no .db files found)');
    process.exit(0);
  }

  for (const dbPath of dbs) {
    const rel = path.relative(TV_ROOT, dbPath);
    const size = fs.statSync(dbPath).size;
    console.log(`\n── ${rel}  (${(size / 1024).toFixed(0)} KB) ──`);

    let counts;
    try {
      counts = tablesWithCounts(dbPath);
    } catch (e) {
      console.log(`  [error opening: ${e.message}]`);
      continue;
    }

    const entries = Object.entries(counts).filter(([, n]) => typeof n !== 'number' || n > 0);
    if (!entries.length) {
      console.log(`  ${Object.keys(counts).length} tables, all empty`);
      continue;
    }

    console.log(`  ${Object.keys(counts).length} tables (${entries.length} non-empty):`);
    for (const [t, n] of entries.sort((a, b) => (b[1] | 0) - (a[1] | 0))) {
      console.log(`    ${t.padEnd(32)} ${n}`);
    }
  }
}

main();
