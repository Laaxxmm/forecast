#!/usr/bin/env node
/**
 * Step 2 of the DB unification migration.
 *
 * Round-trips every existing .db file through `VACUUM INTO`, which is a
 * single-SQL operation executed by better-sqlite3 that:
 *   1. reads every page / btree of the source DB, and
 *   2. writes a fresh destination file using better-sqlite3's own engine.
 *
 * The output is a DB file that is guaranteed to be in native
 * better-sqlite3 format — no quirks that might have been left behind by
 * sql.js's "flush whole buffer" save pattern.
 *
 * We verify the new file (integrity_check + per-table row counts) before
 * we atomically rename:
 *
 *   {name}.db       → {name}.sqljs.bak    (kept as rollback trail)
 *   {name}.new.db   → {name}.db           (the native file)
 *
 * Run the dev server BEFORE starting (the script refuses otherwise). This
 * prevents interleaving writes with the server's open handles.
 *
 * Usage:
 *   node scripts/migrate-sqljs-to-bettersqlite.mjs              # live run
 *   node scripts/migrate-sqljs-to-bettersqlite.mjs --dry-run    # build + verify, skip rename
 */

import { createRequire } from 'node:module';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// better-sqlite3 is installed in server/node_modules (native binding).
// Resolve it from there so the scripts dir doesn't need its own install.
const serverPkgJson = path.join(ROOT, 'server', 'package.json');
const requireFromServer = createRequire(serverPkgJson);
let Database;
try {
  Database = requireFromServer('better-sqlite3');
} catch (err) {
  console.error('Failed to load better-sqlite3 from server/node_modules.');
  console.error('Run `cd server && npm install` first.');
  console.error('Underlying error:', err.message);
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

/** Find every main .db file under data/ that belongs to Magna_Tracker. */
function discoverDbs() {
  const list = [];
  const platform = path.join(ROOT, 'data', 'platform.db');
  if (fs.existsSync(platform)) list.push(platform);

  const clientsDir = path.join(ROOT, 'data', 'clients');
  if (fs.existsSync(clientsDir)) {
    for (const f of fs.readdirSync(clientsDir)) {
      if (!f.endsWith('.db')) continue;
      // Skip backup/temp/new artifacts — we only migrate live main files.
      if (/\.(bak|tmp|new|sqljs)(\.|$)/.test(f)) continue;
      list.push(path.join(clientsDir, f));
    }
  }

  // Older deployments may have left a magna_tracker.db at the top level; include it.
  const legacy = path.join(ROOT, 'data', 'magna_tracker.db');
  if (fs.existsSync(legacy)) list.push(legacy);

  return list;
}

/** Collect {tableName → rowCount} for every user table (sqlite_% excluded). */
function tableRowCounts(db) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map(r => r.name);
  const counts = {};
  for (const t of tables) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get();
    counts[t] = n;
  }
  return counts;
}

/** Probe port 3000 — refuse to run if the dev server is still up. */
async function isServerRunning(port = 3000) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: '127.0.0.1', timeout: 400 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

function migrateOne(dbPath) {
  const rel = path.relative(ROOT, dbPath);
  console.log(`\n── ${rel} ──`);

  const srcSize = fs.statSync(dbPath).size;
  const walPath = dbPath + '-wal';
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  console.log(`  main=${srcSize}B  wal=${walSize}B`);

  // Open source, checkpoint any pending WAL into main, verify integrity, count rows.
  const src = new Database(dbPath);
  src.pragma('journal_mode = WAL');
  src.pragma('wal_checkpoint(TRUNCATE)');

  const srcIntegrity = src.pragma('integrity_check', { simple: true });
  if (srcIntegrity !== 'ok') {
    src.close();
    throw new Error(`source integrity_check: ${srcIntegrity}`);
  }
  const srcCounts = tableRowCounts(src);
  const srcPageSize = src.pragma('page_size', { simple: true });
  const tableCount = Object.keys(srcCounts).length;
  const totalRows = Object.values(srcCounts).reduce((a, b) => a + b, 0);
  console.log(`  src : ${tableCount} tables, ${totalRows} rows, page_size=${srcPageSize}, integrity=ok`);

  // VACUUM INTO a fresh path — btrees rebuilt, written entirely by better-sqlite3.
  const newPath = dbPath + '.new';
  if (fs.existsSync(newPath)) fs.unlinkSync(newPath);

  src.prepare(`VACUUM INTO ?`).run(newPath);
  src.close();

  // Verify the new file.
  const dst = new Database(newPath);
  const dstIntegrity = dst.pragma('integrity_check', { simple: true });
  if (dstIntegrity !== 'ok') {
    dst.close();
    try { fs.unlinkSync(newPath); } catch {}
    throw new Error(`new file integrity_check: ${dstIntegrity}`);
  }
  const dstCounts = tableRowCounts(dst);
  const dstPageSize = dst.pragma('page_size', { simple: true });
  dst.close();

  const mismatches = [];
  for (const t of Object.keys(srcCounts)) {
    if (srcCounts[t] !== dstCounts[t]) {
      mismatches.push(`${t}: src=${srcCounts[t]} dst=${dstCounts[t] ?? 'MISSING'}`);
    }
  }
  for (const t of Object.keys(dstCounts)) {
    if (srcCounts[t] === undefined) mismatches.push(`${t}: exists in dst but not src`);
  }
  if (mismatches.length) {
    try { fs.unlinkSync(newPath); } catch {}
    throw new Error(`row count mismatch:\n    ${mismatches.join('\n    ')}`);
  }
  console.log(`  dst : ${Object.keys(dstCounts).length} tables, ${Object.values(dstCounts).reduce((a,b)=>a+b,0)} rows, page_size=${dstPageSize}, integrity=ok`);

  if (DRY_RUN) {
    fs.unlinkSync(newPath);
    console.log(`  [dry-run] would swap ${path.basename(dbPath)} → .sqljs.bak, .new → live`);
    return { ok: true, dryRun: true };
  }

  // Atomic swap.
  const bakPath = dbPath + '.sqljs.bak';
  if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
  fs.renameSync(dbPath, bakPath);
  fs.renameSync(newPath, dbPath);

  // Old -wal / -shm belong to the original file; drop them so SQLite recreates clean siblings.
  for (const sib of [dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(sib)) { try { fs.unlinkSync(sib); } catch {} }
  }

  console.log(`  ✓ swapped: original → ${path.basename(bakPath)}, new → ${path.basename(dbPath)}`);
  return { ok: true };
}

async function main() {
  console.log(`=== Migrate sql.js-era DB files → native better-sqlite3 format ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (verify only, no rename)' : 'LIVE (will replace files)'}`);

  if (await isServerRunning()) {
    console.error(`\n✗ Dev server is still listening on :3000. Stop it before running this migration.`);
    console.error(`  (The server holds cached DB handles; migrating under a live server risks data drift.)`);
    process.exit(1);
  }

  const files = discoverDbs();
  if (!files.length) {
    console.log('No .db files found under data/. Nothing to migrate.');
    process.exit(0);
  }
  console.log(`\nFiles discovered: ${files.length}`);
  for (const f of files) console.log(`  ${path.relative(ROOT, f)}`);

  let ok = 0;
  const failures = [];
  for (const f of files) {
    try {
      migrateOne(f);
      ok++;
    } catch (e) {
      console.error(`  ✗ FAILED: ${e.message}`);
      failures.push({ file: path.relative(ROOT, f), error: e.message });
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Succeeded: ${ok}/${files.length}`);
  if (failures.length) {
    console.log(`Failed: ${failures.length}`);
    for (const f of failures) console.log(`  ${f.file}: ${f.error}`);
    process.exit(1);
  }
  if (DRY_RUN) {
    console.log(`\nDry run complete. No files were renamed. Re-run without --dry-run to apply.`);
  } else {
    console.log(`\nLive migration complete. Original files kept as .sqljs.bak — keep them until Step 5 cleanup.`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
