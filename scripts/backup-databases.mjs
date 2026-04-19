#!/usr/bin/env node
/**
 * Magna_Tracker full-database backup script.
 *
 * Usage (from repo root):
 *   node scripts/backup-databases.mjs
 *
 * What it does
 * ------------
 *   1. Creates `backups/{YYYY-MM-DD_HH-MM-SS}/` under the repo root.
 *   2. Finds every *.db file (+ its sibling *.db-shm / *.db-wal for WAL-mode DBs)
 *      under `data/` (platform.db and data/clients/*.db).
 *   3. Copies them to the backup dir preserving their relative paths.
 *   4. Computes sha256 of source and destination; aborts on mismatch.
 *   5. Opens each copied *.db file with better-sqlite3 (read-only) and runs
 *      `PRAGMA integrity_check`; aborts on any failure.
 *   6. Writes `manifest.json` with timestamp, file list, sizes, hashes, and
 *      integrity-check results.
 *
 * Pre-flight: STOP the dev server before running. A running server may be
 * mid-write; copying while open can capture a partial page. (WAL+SHM files
 * are also copied for extra safety, but a stopped server is the cleanest
 * state.)
 *
 * Exit code 0 = backup is complete and verified.
 * Exit code 1 = something failed; inspect the output before proceeding.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// better-sqlite3 is installed in the server workspace's node_modules.
const serverPkgJson = path.join(repoRoot, 'server', 'package.json');
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

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'backups', 'dist', 'build']);

function findDbFiles(searchRoots) {
  const results = new Set();
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.db')) {
        const st = statSync(full);
        if (st.size === 0) {
          console.log(`  [skip empty] ${path.relative(repoRoot, full)}`);
          continue;
        }
        results.add(full);
      }
    }
  }
  for (const root of searchRoots) walk(root);
  return [...results].sort();
}

// For each .db file, also copy its sibling .db-shm / .db-wal if they exist.
function walSiblings(dbPath) {
  const siblings = [];
  for (const suffix of ['-shm', '-wal']) {
    const p = dbPath + suffix;
    try {
      statSync(p);
      siblings.push(p);
    } catch {
      // doesn't exist, skip
    }
  }
  return siblings;
}

async function copyFileStrict(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function main() {
  const ts = timestamp();
  const backupDir = path.join(repoRoot, 'backups', ts);
  await fs.mkdir(backupDir, { recursive: true });
  console.log(`\nBackup directory: ${backupDir}\n`);

  const searchRoots = [
    path.join(repoRoot, 'data'),
  ];

  console.log('Scanning for .db files under:');
  for (const r of searchRoots) console.log(`  ${path.relative(repoRoot, r) || '.'}`);

  const dbFiles = findDbFiles(searchRoots);
  console.log(`\nFound ${dbFiles.length} non-empty .db file(s).\n`);

  const manifest = {
    timestamp: ts,
    repo_root: repoRoot,
    source_paths: dbFiles.map((f) => path.relative(repoRoot, f)),
    files: {}, // keyed by relative path
  };

  let anyFailed = false;

  for (const src of dbFiles) {
    const rel = path.relative(repoRoot, src);
    const dest = path.join(backupDir, rel);
    console.log(`[${rel}]`);

    try {
      // Copy main .db file
      await copyFileStrict(src, dest);

      // Copy sibling WAL/SHM files if present
      const siblings = walSiblings(src);
      for (const sib of siblings) {
        const sibRel = path.relative(repoRoot, sib);
        const sibDest = path.join(backupDir, sibRel);
        await copyFileStrict(sib, sibDest);
        console.log(`  +sibling: ${path.basename(sib)}`);
      }

      // Verify sizes + sha256 for main file
      const srcSize = (await fs.stat(src)).size;
      const destSize = (await fs.stat(dest)).size;
      if (srcSize !== destSize) {
        throw new Error(`size mismatch: src=${srcSize} dest=${destSize}`);
      }
      const srcHash = await sha256File(src);
      const destHash = await sha256File(dest);
      if (srcHash !== destHash) {
        throw new Error(`sha256 mismatch:\n    src:  ${srcHash}\n    dest: ${destHash}`);
      }

      // Also hash siblings
      const siblingHashes = {};
      for (const sib of siblings) {
        const sibRel = path.relative(repoRoot, sib);
        const sibDest = path.join(backupDir, sibRel);
        const sSrc = (await fs.stat(sib)).size;
        const sDest = (await fs.stat(sibDest)).size;
        if (sSrc !== sDest) {
          throw new Error(`sibling size mismatch for ${path.basename(sib)}: src=${sSrc} dest=${sDest}`);
        }
        const sSrcHash = await sha256File(sib);
        const sDestHash = await sha256File(sibDest);
        if (sSrcHash !== sDestHash) {
          throw new Error(`sibling sha256 mismatch for ${path.basename(sib)}`);
        }
        siblingHashes[path.basename(sib)] = sSrcHash;
      }

      // Integrity check by opening the copied DB read-only
      let integrity;
      try {
        const db = new Database(dest, { readonly: true, fileMustExist: true });
        const rows = db.pragma('integrity_check');
        db.close();
        const ok =
          Array.isArray(rows) && rows.length === 1 && rows[0].integrity_check === 'ok';
        integrity = ok ? 'ok' : JSON.stringify(rows);
      } catch (err) {
        integrity = `ERROR: ${err.message}`;
      }

      manifest.files[rel] = {
        size: srcSize,
        sha256: srcHash,
        siblings: siblingHashes,
        integrity_check: integrity,
      };

      console.log(`  size: ${srcSize} bytes`);
      console.log(`  sha256: ${srcHash}`);
      console.log(`  integrity_check: ${integrity}`);

      if (integrity !== 'ok') {
        anyFailed = true;
        console.error('  ** INTEGRITY FAILURE **');
      }
      console.log();
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`);
      manifest.files[rel] = { error: err.message };
      anyFailed = true;
    }
  }

  // Write manifest
  const manifestPath = path.join(backupDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // Summary
  const total = dbFiles.length;
  const okCount = Object.values(manifest.files).filter(
    (f) => f.integrity_check === 'ok'
  ).length;
  const totalSize = Object.values(manifest.files).reduce(
    (acc, f) => acc + (f.size || 0),
    0
  );
  console.log('=== SUMMARY ===');
  console.log(`Files backed up:  ${total}`);
  console.log(`Integrity OK:     ${okCount}`);
  console.log(`Integrity failed: ${total - okCount}`);
  console.log(`Total size:       ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Manifest:         ${path.relative(repoRoot, manifestPath)}`);

  if (anyFailed) {
    console.error(
      '\nBACKUP COMPLETED WITH ERRORS — DO NOT PROCEED to later steps until resolved.'
    );
    process.exit(1);
  } else {
    console.log('\nBACKUP COMPLETE AND VERIFIED. Safe to proceed.');
  }
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
