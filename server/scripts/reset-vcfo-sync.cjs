// ─────────────────────────────────────────────────────────────────────────────
// Dev-only utility: wipe the sync-agent-populated vcfo_* tables for a tenant
// so the next full sync starts from a clean slate.
//
// Usage (from repo root):
//   node server/scripts/reset-vcfo-sync.cjs magnacode
//
// Does NOT touch:
//   - platform.db (agent keys, company mappings, clients, etc.)
//   - Any non-vcfo_* table (forecast, budgets, dashboard_actuals stay intact)
//
// Does touch (DELETE FROM):
//   - vcfo_companies
//   - vcfo_ledgers
//   - vcfo_account_groups
//   - vcfo_vouchers
//   - vcfo_stock_summary
//   - vcfo_trial_balance
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: node server/scripts/reset-vcfo-sync.cjs <client-slug>');
  process.exit(1);
}

const dbPath = path.resolve(__dirname, '../../data/clients', `${slug}.db`);
if (!fs.existsSync(dbPath)) {
  console.error(`[reset-vcfo] DB not found at ${dbPath}`);
  process.exit(1);
}

console.log(`[reset-vcfo] Opening ${dbPath}`);
const db = new Database(dbPath);

const tables = [
  'vcfo_trial_balance',
  'vcfo_stock_summary',
  'vcfo_vouchers',
  'vcfo_account_groups',
  'vcfo_ledgers',
  'vcfo_companies', // delete this last — FKs point at it from the others
];

function countRows(name) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get();
    return row.n;
  } catch (e) {
    return -1; // table doesn't exist
  }
}

console.log('\n[reset-vcfo] Before:');
for (const t of tables) {
  const n = countRows(t);
  console.log(`  ${t.padEnd(25)} ${n >= 0 ? n.toString().padStart(8) + ' rows' : '(table missing)'}`);
}

db.prepare('PRAGMA foreign_keys = OFF').run();
const tx = db.transaction(() => {
  for (const t of tables) {
    try {
      const res = db.prepare(`DELETE FROM ${t}`).run();
      console.log(`[reset-vcfo] Cleared ${t}: ${res.changes} rows removed`);
    } catch (e) {
      console.log(`[reset-vcfo] Skipped ${t}: ${e.message}`);
    }
  }
});
tx();
db.prepare('PRAGMA foreign_keys = ON').run();

// Reclaim the freed pages so the file actually shrinks (96MB → smaller)
console.log('\n[reset-vcfo] Running VACUUM…');
db.exec('VACUUM');

console.log('\n[reset-vcfo] After:');
for (const t of tables) {
  const n = countRows(t);
  console.log(`  ${t.padEnd(25)} ${n >= 0 ? n.toString().padStart(8) + ' rows' : '(table missing)'}`);
}

db.close();
console.log('\n[reset-vcfo] Done. Run Sync Now in the desktop agent to repopulate.');
