#!/usr/bin/env node
/**
 * Step 3 of the DB unification migration.
 *
 * Copies every TallyVision table into the per-client Magna_Tracker DB
 * (with a `vcfo_` prefix so nothing collides with existing forecast_* tables)
 * and the truly-global TV tables into data/platform.db (also with `vcfo_`).
 *
 * Source layout on disk (what the TallyVision server writes today):
 *
 *   TALLYVISION_DATA/
 *     master.db                  ← global settings + metadata (the TRUE one)
 *     clients/
 *       group_{N}.db             ← per-group synced data (ledgers, TB, P&L, …)
 *     _default/
 *       master.db                ← multi-tenant bootstrap, mostly empty
 *       clients/                 ← only populated once multi-tenant mode activates
 *
 * This script auto-detects which clients/ directory has the real .db files
 * (legacy top-level vs new per-tenant _default/) and uses that one.
 *
 * Target layout after this script:
 *
 *   data/platform.db             ← gets vcfo_app_settings, vcfo_client_users, …
 *   data/clients/{slug}.db       ← gets vcfo_ledgers, vcfo_trial_balance, …
 *
 * Mapping is provided via JSON:
 *
 *     {
 *       "2": "magnacode"   // key = group_id, value = Magna_Tracker slug
 *     }
 *
 * Step 3 is **copy-only** — it does NOT rewrite any TallyVision code to
 * point at the new location. VCFO keeps reading its old DBs. Step 4 flips
 * the routing. That way this script is safely re-runnable and a failure
 * doesn't take VCFO down.
 *
 * Usage:
 *   node scripts/migrate-vcfo-to-unified.mjs --mapping scripts/vcfo-group-mapping.json
 *   node scripts/migrate-vcfo-to-unified.mjs --mapping scripts/vcfo-group-mapping.json --dry-run
 *   node scripts/migrate-vcfo-to-unified.mjs --schema-only                 # create empty vcfo_* tables only
 *   node scripts/migrate-vcfo-to-unified.mjs --mapping … --force           # drop vcfo_* tables in targets before copying
 */

import { createRequire } from 'node:module';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const serverPkgJson = path.join(ROOT, 'server', 'package.json');
const requireFromServer = createRequire(serverPkgJson);
let Database;
try {
  Database = requireFromServer('better-sqlite3');
} catch (err) {
  console.error('Failed to load better-sqlite3 from server/node_modules.');
  console.error('Run `cd server && npm install` first.');
  process.exit(1);
}

// ─── CLI flags ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getFlag(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}
const DRY_RUN = !!getFlag('--dry-run');
const SCHEMA_ONLY = !!getFlag('--schema-only');
const FORCE = !!getFlag('--force');
const CLEAN = !!getFlag('--clean');   // drop every vcfo_* table in targets before migrating
const MAPPING_PATH = typeof getFlag('--mapping') === 'string' ? getFlag('--mapping') : null;

// ─── Paths ──────────────────────────────────────────────────────────────────

const TV_ROOT =
  process.env.TALLYVISION_DATA ||
  path.join(ROOT, 'Vcfo-app', 'TallyVision_2.0', 'data');

const TV_MASTER_TOP = path.join(TV_ROOT, 'master.db');           // authoritative
const TV_MASTER_DEFAULT = path.join(TV_ROOT, '_default', 'master.db'); // bootstrap

// Pick the clients/ directory that actually contains group_*.db files.
// Legacy single-tenant: TV_ROOT/clients/. Per-tenant _default mode: TV_ROOT/_default/clients/.
function pickClientsDir() {
  const candidates = [
    path.join(TV_ROOT, 'clients'),
    path.join(TV_ROOT, '_default', 'clients'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const dbs = fs.readdirSync(dir).filter((f) => /^group_\d+\.db$/.test(f));
    if (dbs.length) return { dir, dbs };
  }
  // Fall back to legacy path so a meaningful error surfaces downstream.
  return { dir: candidates[0], dbs: [] };
}
const { dir: TV_CLIENTS_DIR, dbs: TV_GROUP_DBS } = pickClientsDir();

const PLATFORM_DB = path.join(ROOT, 'data', 'platform.db');
const CLIENTS_DIR = path.join(ROOT, 'data', 'clients');

// ─── Table plan ─────────────────────────────────────────────────────────────
//
// GLOBAL = goes into data/platform.db with a vcfo_ prefix. One copy per DB.
// PER_CLIENT_FROM_MASTER = lives in TV master.db but scoped by group_id
//                          (so becomes per-client on the Magna_Tracker side).
// PER_CLIENT_FROM_GROUP = lives in TV clients/group_{N}.db (already per-group).

const GLOBAL_TABLES = [
  // TV master.db tables that stay truly global after the merge.
  'app_settings',
  'license',
  'client_users',
  'client_company_access',
  'upload_categories',
  // Kept for data preservation — plan deprecates the concept of groups but
  // the rows are tiny and might be useful during Step 4 verification.
  'company_groups',
  'company_group_members',
];

const PER_CLIENT_FROM_MASTER = [
  // Filtered by group_id — only rows belonging to this tenant get copied.
  { name: 'companies', filter: (gid) => `id IN (SELECT company_id FROM company_group_members WHERE group_id = ${gid})` },
  { name: 'writeoff_rules', filter: (gid) => `group_id = ${gid}` },
  { name: 'vcfo_tracker_items', filter: (gid) => `group_id = ${gid}` },
  // tracker_status is scoped via its item_id FK, not a direct group_id column.
  { name: 'vcfo_tracker_status', filter: (gid) => `item_id IN (SELECT id FROM vcfo_tracker_items WHERE group_id = ${gid})` },
  { name: 'audit_milestones', filter: (gid) => `group_id = ${gid}` },
  { name: 'audit_milestone_status', filter: (gid) => `milestone_id IN (SELECT id FROM audit_milestones WHERE group_id = ${gid})` },
  { name: 'audit_observations', filter: (gid) => `group_id = ${gid}` },
];

const PER_CLIENT_FROM_GROUP = [
  // Entire table copied verbatim from clients/group_{N}.db.
  'account_groups', 'ledgers',
  'trial_balance', 'profit_loss', 'balance_sheet',
  'vouchers', 'stock_summary', 'bills_outstanding',
  'cost_centres', 'cost_allocations',
  'gst_entries', 'payroll_entries',
  'stock_item_ledger', 'sync_log',
  'excel_uploads', 'excel_data',
  'budgets', 'allocation_rules',
  // `upload_categories` already comes via GLOBAL → don't re-duplicate per-client.
  // `forecast_*` leftovers in group_2.db are stale TV-side forecast tables —
  // NEVER copy them, they would collide with Magna_Tracker's live forecast_items.
];

// Tables that are explicitly NOT copied (collisions or deprecated).
const SKIP_TABLES = new Set([
  'forecast_items', 'forecast_values', 'forecast_scenarios', 'forecast_item_details',
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function targetName(srcName) {
  // vcfo_tracker_items is already prefixed in the source; don't double-prefix.
  return srcName.startsWith('vcfo_') ? srcName : 'vcfo_' + srcName;
}

/**
 * Drop every vcfo_* table + index in a DB. Called per-target when --clean is
 * set so we don't leave partial tables behind from an earlier aborted run.
 */
function dropAllVcfoTables(db) {
  const rows = db.prepare(
    `SELECT type, name FROM sqlite_master
     WHERE name LIKE 'vcfo_%'
       AND type IN ('table', 'index')
       AND sql IS NOT NULL
     ORDER BY type DESC` // indexes first (they depend on tables)
  ).all();
  let dropped = 0;
  for (const r of rows) {
    if (r.type === 'table') {
      db.exec(`DROP TABLE IF EXISTS "${r.name}"`);
      dropped++;
    } else if (r.type === 'index') {
      // Index is auto-dropped with the table; swallow any "no such index".
      try { db.exec(`DROP INDEX IF EXISTS "${r.name}"`); } catch {}
    }
  }
  return dropped;
}

async function isServerRunning(port = 3000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1', timeout: 400 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

function tableExists(db, name, alias) {
  const prefix = alias ? `${alias}.` : '';
  return !!db.prepare(`SELECT 1 FROM ${prefix}sqlite_master WHERE type='table' AND name = ?`).get(name);
}

function rowCount(db, name, alias) {
  if (!tableExists(db, name, alias)) return 0;
  const prefix = alias ? `${alias}.` : '';
  return db.prepare(`SELECT COUNT(*) AS n FROM ${prefix}"${name}"`).get().n;
}

function getTableDDL(db, name, alias) {
  // Returns the CREATE TABLE statement + any index DDLs.
  const prefix = alias ? `${alias}.` : '';
  const rows = db.prepare(
    `SELECT type, name, tbl_name, sql FROM ${prefix}sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL`
  ).all(name);
  return rows;
}

/**
 * Checkpoint and close any lingering WAL on a source DB file. We briefly
 * open writable, truncate the WAL, and close. This keeps later ATTACHes
 * from hitting "database is locked" if the TV server was killed hard.
 */
function quiesceWal(dbPath) {
  if (!fs.existsSync(dbPath)) return;
  try {
    const h = new Database(dbPath);
    try {
      h.pragma('journal_mode = WAL');
      h.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      h.close();
    }
  } catch (e) {
    console.warn(`  [warn] could not quiesce WAL for ${path.basename(dbPath)}: ${e.message}`);
  }
}

/**
 * Rewrite a CREATE TABLE / CREATE INDEX statement to use a new table name.
 * Also renames the index itself so we don't hit UNIQUE name collisions in
 * the target DB.
 */
function rewriteDDL(ddl, srcTableName, tgtTableName) {
  const { type, name, sql } = ddl;
  if (type === 'table') {
    // Replace the first occurrence of the table name following CREATE TABLE.
    // sqlite quotes are optional; handle both `srcName` and "srcName".
    let out = sql.replace(
      /^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(["`]?)(\w+)(["`]?)/i,
      (_m, pre, q1, _n, q2) => `${pre}IF NOT EXISTS ${q1}${tgtTableName}${q2}`
    );
    // Strip FK references — the referenced tables exist only in the source DB,
    // not in our target (platform.db / per-client.db). Since we're bulk-copying
    // with foreign_keys = OFF, the constraints would be dead weight anyway.
    out = out.replace(/\s+REFERENCES\s+\w+\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+\w+(\s+\w+)?)*/gi, '');
    return out;
  }
  if (type === 'index') {
    // Rewrite ON srcTable → ON tgtTable and rename the index to vcfo_idx_<orig>.
    const newIndexName = name.startsWith('vcfo_') ? name : 'vcfo_' + name;
    return sql
      .replace(
        new RegExp(`\\b${name}\\b`),
        newIndexName
      )
      .replace(
        new RegExp(`\\bON\\s+(["\`]?)${srcTableName}(["\`]?)`, 'i'),
        `ON $1${tgtTableName}$2`
      )
      .replace(
        /^(CREATE\s+(UNIQUE\s+)?INDEX\s+)/i,
        '$1IF NOT EXISTS '
      );
  }
  return null;
}

/**
 * Create the prefixed table + indexes in the target, idempotent.
 * Uses the target connection + attached source alias — no separate handle on
 * the source, which would race against the ATTACH lock.
 */
function ensureTargetSchema(tgtDb, srcAlias, srcName, tgtName) {
  const ddls = getTableDDL(tgtDb, srcName, srcAlias);
  if (!ddls.length) return false;
  const tableDdl = ddls.find((d) => d.type === 'table');
  if (!tableDdl) return false;

  if (FORCE && tableExists(tgtDb, tgtName)) {
    tgtDb.exec(`DROP TABLE IF EXISTS "${tgtName}"`);
  }
  const tableSql = rewriteDDL(tableDdl, srcName, tgtName);
  tgtDb.exec(tableSql);

  for (const d of ddls) {
    if (d.type !== 'index') continue;
    // Skip auto-indexes created for UNIQUE constraints (sqlite_autoindex_*).
    if (d.name.startsWith('sqlite_autoindex_')) continue;
    const rewritten = rewriteDDL(d, srcName, tgtName);
    if (rewritten) {
      try {
        tgtDb.exec(rewritten);
      } catch (e) {
        console.warn(`    [warn] failed to create index for ${tgtName}: ${e.message}`);
      }
    }
  }
  return true;
}

/**
 * Copy rows from the attached source into the target table.
 * `whereClause`, if given, is applied at the source.
 */
function copyRows(tgtDb, srcAlias, srcTable, tgtTable, whereClause = '') {
  const tgtCols = tgtDb.prepare(`PRAGMA table_info("${tgtTable}")`).all().map((c) => c.name);
  const srcCols = tgtDb.prepare(`PRAGMA ${srcAlias}.table_info("${srcTable}")`).all().map((c) => c.name);
  const common = tgtCols.filter((c) => srcCols.includes(c));
  const colList = common.map((c) => `"${c}"`).join(', ');
  const where = whereClause ? ` WHERE ${whereClause}` : '';
  const sql = `INSERT INTO "${tgtTable}" (${colList}) SELECT ${colList} FROM ${srcAlias}."${srcTable}"${where}`;
  const info = tgtDb.prepare(sql).run();
  return info.changes;
}

// ─── Main per-group migration ───────────────────────────────────────────────

function migrateGlobalTables(platformDb, masterPath) {
  console.log(`\n── Global tables → data/platform.db (from ${path.relative(ROOT, masterPath)}) ──`);
  if (CLEAN) {
    const n = dropAllVcfoTables(platformDb);
    console.log(`  [clean] dropped ${n} vcfo_* table(s) from platform.db`);
  }
  const alias = `_tv_master`;
  const escaped = masterPath.replace(/'/g, "''");
  platformDb.exec(`ATTACH DATABASE '${escaped}' AS ${alias}`);
  try {
    for (const t of GLOBAL_TABLES) {
      if (!tableExists(platformDb, t, alias)) {
        console.log(`  ${t.padEnd(30)}  (missing in source — skipped)`);
        continue;
      }
      const tgt = targetName(t);
      const created = ensureTargetSchema(platformDb, alias, t, tgt);
      if (!created) {
        console.log(`  ${t.padEnd(30)} → ${tgt}  (no DDL found)`);
        continue;
      }
      if (SCHEMA_ONLY) {
        console.log(`  ${t.padEnd(30)} → ${tgt}  (schema only)`);
        continue;
      }
      const before = rowCount(platformDb, tgt);
      if (before > 0 && !FORCE) {
        console.log(`  ${t.padEnd(30)} → ${tgt}  (target has ${before} rows already — skipped; use --force to overwrite)`);
        continue;
      }
      const srcCount = rowCount(platformDb, t, alias);
      const copied = copyRows(platformDb, alias, t, tgt);
      const after = rowCount(platformDb, tgt);
      const match = srcCount === after ? 'OK' : `MISMATCH src=${srcCount} tgt=${after}`;
      console.log(`  ${t.padEnd(30)} → ${tgt}  copied=${copied} src=${srcCount} tgt=${after} [${match}]`);
    }
  } finally {
    platformDb.exec(`DETACH DATABASE ${alias}`);
  }
}

function migrateGroupToClient(groupId, slug, masterPath, groupPath) {
  const liveTargetPath = path.join(CLIENTS_DIR, `${slug}.db`);
  if (!fs.existsSync(liveTargetPath)) {
    throw new Error(`target client DB not found: ${liveTargetPath}`);
  }
  if (!fs.existsSync(masterPath)) {
    throw new Error(`TV master.db not found: ${masterPath}`);
  }
  if (!fs.existsSync(groupPath)) {
    throw new Error(`TV group DB not found: ${groupPath}`);
  }

  // DRY_RUN safety: clone the live target to a throwaway copy, run the whole
  // migration against it, verify, delete. Guarantees zero side-effects on live.
  let targetDbPath = liveTargetPath;
  if (DRY_RUN) {
    targetDbPath = liveTargetPath + '.dryrun';
    if (fs.existsSync(targetDbPath)) fs.unlinkSync(targetDbPath);
    // Use VACUUM INTO for a consistent, rollback-free snapshot.
    const clone = new Database(liveTargetPath, { readonly: true });
    try { clone.prepare(`VACUUM INTO ?`).run(targetDbPath); } finally { clone.close(); }
  }

  console.log(`\n══ group_id=${groupId} → client "${slug}"${DRY_RUN ? ' (dry-run clone)' : ''} ══`);
  console.log(`   master : ${path.relative(ROOT, masterPath)}`);
  console.log(`   group  : ${path.relative(ROOT, groupPath)}`);
  console.log(`   target : ${path.relative(ROOT, targetDbPath)}`);

  const tgt = new Database(targetDbPath);
  tgt.pragma('journal_mode = WAL');
  tgt.pragma('foreign_keys = OFF'); // we're copying data that may have FK refs; keep off during bulk load

  const mismatches = [];
  const escapedMaster = masterPath.replace(/'/g, "''");
  const escapedGroup = groupPath.replace(/'/g, "''");

  if (CLEAN) {
    const n = dropAllVcfoTables(tgt);
    console.log(`  [clean] dropped ${n} vcfo_* table(s) from ${slug}.db`);
  }

  try {
    // ── PER_CLIENT_FROM_MASTER: rows from TV master.db scoped by group_id
    //
    // NOTE: ATTACH is deliberately OUTSIDE any outer transaction. ATTACH
    // inside BEGIN…COMMIT holds the attached file's lock until the tx ends,
    // which makes the matching DETACH fail with "database is locked".
    // Each CREATE/INSERT/DROP runs in its own implicit transaction.
    const masterAlias = '_tv_master';
    tgt.exec(`ATTACH DATABASE '${escapedMaster}' AS ${masterAlias}`);
    try {
      console.log(`\n  ── Master-scoped tables (group_id=${groupId}) ──`);
      for (const { name: t, filter } of PER_CLIENT_FROM_MASTER) {
        if (!tableExists(tgt, t, masterAlias)) {
          console.log(`    ${t.padEnd(30)}  (missing in source — skipped)`);
          continue;
        }
        const tgtName = targetName(t);
        const ok = ensureTargetSchema(tgt, masterAlias, t, tgtName);
        if (!ok) {
          console.log(`    ${t.padEnd(30)} → ${tgtName}  (no DDL found)`);
          continue;
        }
        if (SCHEMA_ONLY) {
          console.log(`    ${t.padEnd(30)} → ${tgtName}  (schema only)`);
          continue;
        }
        const before = rowCount(tgt, tgtName);
        if (before > 0 && !FORCE) {
          console.log(`    ${t.padEnd(30)} → ${tgtName}  (target has ${before} rows — skipped; --force to overwrite)`);
          continue;
        }
        const whereClause = filter(groupId);
        const srcFiltered = tgt.prepare(`SELECT COUNT(*) AS n FROM ${masterAlias}."${t}" WHERE ${whereClause}`).get().n;
        const copied = copyRows(tgt, masterAlias, t, tgtName, whereClause);
        const tgtAfter = rowCount(tgt, tgtName);
        const match = srcFiltered === tgtAfter;
        console.log(`    ${t.padEnd(30)} → ${tgtName}  copied=${copied} srcFiltered=${srcFiltered} tgt=${tgtAfter} [${match ? 'OK' : 'MISMATCH'}]`);
        if (!match) mismatches.push({ table: t, srcFiltered, tgtAfter });
      }
    } finally {
      tgt.exec(`DETACH DATABASE ${masterAlias}`);
    }

    // ── PER_CLIENT_FROM_GROUP: rows from clients/group_{N}.db (verbatim)
    const groupAlias = '_tv_group';
    tgt.exec(`ATTACH DATABASE '${escapedGroup}' AS ${groupAlias}`);
    try {
      console.log(`\n  ── Group-scoped tables (from group_${groupId}.db) ──`);
      for (const t of PER_CLIENT_FROM_GROUP) {
        if (SKIP_TABLES.has(t)) continue;
        if (!tableExists(tgt, t, groupAlias)) {
          console.log(`    ${t.padEnd(30)}  (missing in source — skipped)`);
          continue;
        }
        const tgtName = targetName(t);
        const ok = ensureTargetSchema(tgt, groupAlias, t, tgtName);
        if (!ok) {
          console.log(`    ${t.padEnd(30)} → ${tgtName}  (no DDL found)`);
          continue;
        }
        if (SCHEMA_ONLY) {
          console.log(`    ${t.padEnd(30)} → ${tgtName}  (schema only)`);
          continue;
        }
        const before = rowCount(tgt, tgtName);
        if (before > 0 && !FORCE) {
          console.log(`    ${t.padEnd(30)} → ${tgtName}  (target has ${before} rows — skipped; --force to overwrite)`);
          continue;
        }
        const srcCount = rowCount(tgt, t, groupAlias);
        const copied = copyRows(tgt, groupAlias, t, tgtName);
        const tgtAfter = rowCount(tgt, tgtName);
        const match = srcCount === tgtAfter;
        console.log(`    ${t.padEnd(30)} → ${tgtName}  copied=${copied} src=${srcCount} tgt=${tgtAfter} [${match ? 'OK' : 'MISMATCH'}]`);
        if (!match) mismatches.push({ table: t, srcCount, tgtAfter });
      }
    } finally {
      tgt.exec(`DETACH DATABASE ${groupAlias}`);
    }
  } catch (e) {
    tgt.close();
    if (DRY_RUN && fs.existsSync(targetDbPath)) {
      try { fs.unlinkSync(targetDbPath); } catch {}
      for (const sib of ['-wal', '-shm']) {
        const p = targetDbPath + sib;
        if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
      }
    }
    throw e;
  }

  // Integrity check on the (live or cloned) target.
  const ic = tgt.pragma('integrity_check', { simple: true });
  console.log(`\n  integrity_check: ${ic}`);
  if (ic !== 'ok') mismatches.push({ table: '<integrity>', result: ic });
  tgt.close();

  // Clean up the dry-run clone.
  if (DRY_RUN) {
    try { fs.unlinkSync(targetDbPath); } catch {}
    for (const sib of ['-wal', '-shm']) {
      const p = targetDbPath + sib;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }
    console.log(`  [dry-run] discarded clone: ${path.basename(targetDbPath)}`);
  }

  return { mismatches };
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== Merge TallyVision tables → per-client Magna_Tracker DBs ===`);
  console.log(`Mode: ${SCHEMA_ONLY ? 'SCHEMA ONLY' : (DRY_RUN ? 'DRY RUN' : 'LIVE')}${FORCE ? ' (FORCE)' : ''}`);

  if (await isServerRunning()) {
    console.error(`\n✗ Dev server is still on :3000. Stop it before running this migration.`);
    process.exit(1);
  }

  if (!fs.existsSync(PLATFORM_DB)) {
    console.error(`\n✗ Magna_Tracker platform.db not found at ${PLATFORM_DB}`);
    process.exit(1);
  }

  console.log(`\nSource VCFO data:`);
  console.log(`  master   : ${path.relative(ROOT, TV_MASTER_TOP)}${fs.existsSync(TV_MASTER_TOP) ? '' : ' (missing)'}`);
  console.log(`  clients/ : ${path.relative(ROOT, TV_CLIENTS_DIR)}  [${TV_GROUP_DBS.length} group DB(s)]`);

  // Make sure every source DB has a clean WAL so later ATTACHes don't fail
  // with "database is locked". This is cheap and idempotent.
  console.log('\nQuiescing source WALs…');
  for (const p of [TV_MASTER_TOP, TV_MASTER_DEFAULT]) {
    if (fs.existsSync(p)) { quiesceWal(p); console.log(`  ${path.relative(ROOT, p)}`); }
  }
  if (fs.existsSync(TV_CLIENTS_DIR)) {
    for (const f of fs.readdirSync(TV_CLIENTS_DIR)) {
      if (!f.endsWith('.db')) continue;
      if (!/^group_\d+\.db$/.test(f)) continue; // skip -wal/-shm & random .db files
      const p = path.join(TV_CLIENTS_DIR, f);
      quiesceWal(p);
      console.log(`  ${path.relative(ROOT, p)}`);
    }
  }

  // Parse mapping
  let mapping = {};
  if (MAPPING_PATH) {
    const raw = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue; // skip _comment keys
      const gid = Number(k);
      if (!Number.isInteger(gid) || gid <= 0) {
        console.error(`✗ mapping key must be a positive integer: got ${JSON.stringify(k)}`);
        process.exit(1);
      }
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(v)) {
        console.error(`✗ mapping value "${v}" is not a valid slug`);
        process.exit(1);
      }
      mapping[gid] = String(v);
    }
    console.log(`\nMapping: ${JSON.stringify(mapping)}`);
  } else if (!SCHEMA_ONLY) {
    console.error(`\n✗ No --mapping provided. Either supply one or use --schema-only.`);
    process.exit(1);
  }

  // ─ 1. Global tables → platform.db ─
  // No outer transaction here: ATTACH inside BEGIN…COMMIT holds file locks
  // until the transaction ends, which then makes DETACH fail with
  // "database is locked". Each CREATE/INSERT acts in its own implicit tx.
  //
  // DRY_RUN safety: clone platform.db to a throwaway file and migrate there.
  let platformDbPath = PLATFORM_DB;
  if (DRY_RUN) {
    platformDbPath = PLATFORM_DB + '.dryrun';
    if (fs.existsSync(platformDbPath)) fs.unlinkSync(platformDbPath);
    const clone = new Database(PLATFORM_DB, { readonly: true });
    try { clone.prepare(`VACUUM INTO ?`).run(platformDbPath); } finally { clone.close(); }
  }

  const platformDb = new Database(platformDbPath);
  platformDb.pragma('journal_mode = WAL');
  try {
    const masterForSchema = fs.existsSync(TV_MASTER_TOP) ? TV_MASTER_TOP : TV_MASTER_DEFAULT;
    if (!fs.existsSync(masterForSchema)) {
      console.warn(`  (no TV master.db found — skipping global tables)`);
    } else {
      migrateGlobalTables(platformDb, masterForSchema);
    }

    const ic = platformDb.pragma('integrity_check', { simple: true });
    console.log(`  ${DRY_RUN ? '[dry-run clone] ' : ''}platform.db integrity_check: ${ic}`);
  } catch (e) {
    platformDb.close();
    console.error(`\n✗ Global-table migration failed: ${e.message}`);
    if (DRY_RUN) {
      try { fs.unlinkSync(platformDbPath); } catch {}
      for (const sib of ['-wal', '-shm']) { try { fs.unlinkSync(platformDbPath + sib); } catch {} }
    }
    process.exit(1);
  }
  platformDb.close();

  if (DRY_RUN) {
    try { fs.unlinkSync(platformDbPath); } catch {}
    for (const sib of ['-wal', '-shm']) { try { fs.unlinkSync(platformDbPath + sib); } catch {} }
    console.log(`  [dry-run] discarded clone: ${path.basename(platformDbPath)}`);
  }

  // ─ 2. Per-group tables → per-client DBs ─
  const allMismatches = [];
  for (const [groupId, slug] of Object.entries(mapping)) {
    const groupPath = path.join(TV_CLIENTS_DIR, `group_${groupId}.db`);
    try {
      const { mismatches } = migrateGroupToClient(
        Number(groupId),
        slug,
        TV_MASTER_TOP,
        groupPath
      );
      if (mismatches.length) allMismatches.push({ groupId, slug, mismatches });
    } catch (e) {
      console.error(`\n✗ group ${groupId} → ${slug} failed: ${e.message}`);
      allMismatches.push({ groupId, slug, error: e.message });
    }
  }

  // ─ 3. Summary ─
  console.log(`\n=== Summary ===`);
  if (SCHEMA_ONLY) {
    console.log(`Schema created in all targets. No data copied.`);
  } else if (DRY_RUN) {
    console.log(`Dry run complete. All target writes rolled back.`);
  } else {
    console.log(`Migration complete.`);
  }
  if (allMismatches.length) {
    console.log(`\n⚠ Issues:`);
    for (const m of allMismatches) {
      console.log(`  group ${m.groupId} (${m.slug}):`, JSON.stringify(m.mismatches || m.error));
    }
    process.exit(1);
  }
  if (!SCHEMA_ONLY && !DRY_RUN) {
    console.log(`\nOriginal TallyVision DB files are untouched. VCFO will continue`);
    console.log(`reading from them until Step 4 flips its routing to per-client DBs.`);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
