// Quick read-only peek at what's currently in the vcfo_* tables.
const path = require('path');
const Database = require('better-sqlite3');

const slug = process.argv[2] || 'magnacode';
const dbPath = path.resolve(__dirname, '../../data/clients', `${slug}.db`);
const db = new Database(dbPath, { readonly: true });

const tables = [
  'vcfo_companies',
  'vcfo_ledgers',
  'vcfo_account_groups',
  'vcfo_vouchers',
  'vcfo_stock_summary',
  'vcfo_trial_balance',
];

console.log(`\n[peek] ${dbPath}\n`);
for (const t of tables) {
  try {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    console.log(`  ${t.padEnd(25)} ${n.toString().padStart(8)} rows`);
  } catch (e) {
    console.log(`  ${t.padEnd(25)} (missing)`);
  }
}

console.log('\n[peek] vcfo_companies contents:');
try {
  const rows = db.prepare(
    'SELECT id, name, last_full_sync_at FROM vcfo_companies ORDER BY last_full_sync_at DESC NULLS LAST, name'
  ).all();
  for (const r of rows) {
    console.log(`  id=${String(r.id).padStart(3)} ${r.name.padEnd(45)} synced=${r.last_full_sync_at || '(never)'}`);
  }
} catch (e) {
  console.log('  (table missing)');
}

db.close();
