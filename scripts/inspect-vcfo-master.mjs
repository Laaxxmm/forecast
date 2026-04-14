#!/usr/bin/env node
/**
 * Dump the contents of both VCFO master.db files (top-level + _default/) so
 * we can decide what the source-of-truth is for Step 3's data copy.
 *
 * Read-only.
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

const TV_ROOT =
  process.env.TALLYVISION_DATA ||
  path.join(ROOT, 'Vcfo-app', 'TallyVision_2.0', 'data');

const files = [
  { label: 'top-level master.db', p: path.join(TV_ROOT, 'master.db') },
  { label: '_default/master.db', p: path.join(TV_ROOT, '_default', 'master.db') },
];

for (const { label, p } of files) {
  console.log(`\n=== ${label} ===`);
  console.log(`    ${p}`);
  if (!fs.existsSync(p)) { console.log('  (missing)'); continue; }

  const db = new Database(p, { readonly: true });
  try {
    const tables = ['companies', 'company_groups', 'company_group_members', 'client_users', 'client_company_access', 'app_settings'];
    for (const t of tables) {
      try {
        const rows = db.prepare(`SELECT * FROM "${t}"`).all();
        console.log(`\n  ${t} (${rows.length}):`);
        for (const r of rows) {
          const short = JSON.stringify(r).replace(/"password_hash":"[^"]+"/, '"password_hash":"<redacted>"');
          console.log(`    ${short.slice(0, 200)}${short.length > 200 ? '…' : ''}`);
        }
      } catch (e) {
        console.log(`  ${t}: <error: ${e.message}>`);
      }
    }
  } finally {
    db.close();
  }
}
