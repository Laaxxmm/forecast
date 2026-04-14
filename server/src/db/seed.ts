import { DbHelper } from './connection.js';
import bcrypt from 'bcryptjs';

function seedRevenueSharing(db: DbHelper) {
  // ── Service categories ──
  const categories = [
    { name: 'Consultation', source: 'clinic', dept: 'APPOINTMENT', kw: null, mode: 'exact', priority: 100 },
    { name: 'Lab Packages', source: 'clinic', dept: 'LAB TEST', kw: 'package', mode: 'contains', priority: 90 },
    { name: '365 Away', source: 'clinic', dept: null, kw: '365,away', mode: 'and_contains', priority: 85 },
    { name: '365 Full Year', source: 'clinic', dept: null, kw: '365,full', mode: 'and_contains', priority: 85 },
    { name: 'Lab Subscription', source: 'clinic', dept: null, kw: 'subscription', mode: 'contains', priority: 80 },
    { name: 'Diet', source: 'clinic', dept: null, kw: 'diet', mode: 'contains', priority: 80 },
    { name: 'Individual Lab', source: 'clinic', dept: 'LAB TEST', kw: null, mode: 'exact', priority: 10 },
    { name: 'Pharmacy', source: 'pharmacy', dept: null, kw: null, mode: 'exact', priority: 100 },
  ];
  for (const c of categories) {
    db.run(
      `INSERT OR IGNORE INTO revenue_sharing_categories (name, source, match_department, match_keyword, match_mode, priority) VALUES (?, ?, ?, ?, ?, ?)`,
      c.name, c.source, c.dept, c.kw, c.mode, c.priority
    );
  }

  // ── Ensure doctors exist ──
  const doctorNames = [
    'Dr Varun Suryadevara', 'Dr Harshitha B', 'Diya S Sirrkay',
    'Dr Athira Ramakrishnan', 'Dr Gajanan Kulkarni',
  ];
  for (const d of doctorNames) {
    db.run('INSERT OR IGNORE INTO doctors (name) VALUES (?)', d);
  }

  // Helper to get IDs
  const catId = (name: string) => db.get('SELECT id FROM revenue_sharing_categories WHERE name = ?', name)?.id;
  const docId = (name: string) => db.get('SELECT id FROM doctors WHERE name = ?', name)?.id;

  // ── Sharing rules ──
  const upsertRule = (doctor: string, category: string, docPct: number) => {
    const dId = docId(doctor);
    const cId = catId(category);
    if (!dId || !cId) return;
    db.run(
      `INSERT OR IGNORE INTO revenue_sharing_rules (doctor_id, category_id, doctor_pct, magna_pct) VALUES (?, ?, ?, ?)`,
      dId, cId, docPct, 100 - docPct
    );
  };

  // Dr Varun & Dr Harshitha — full 8-category split
  for (const doc of ['Dr Varun Suryadevara', 'Dr Harshitha B']) {
    upsertRule(doc, 'Consultation', 80);
    upsertRule(doc, 'Lab Packages', 25);
    upsertRule(doc, 'Individual Lab', 40);
    upsertRule(doc, '365 Away', 50);
    upsertRule(doc, '365 Full Year', 42);
    upsertRule(doc, 'Lab Subscription', 36);
    upsertRule(doc, 'Diet', 40);
    upsertRule(doc, 'Pharmacy', 40);
  }

  // Diya S Sirrkay — 80% consultation, 60% lab referrals
  upsertRule('Diya S Sirrkay', 'Consultation', 80);
  upsertRule('Diya S Sirrkay', 'Lab Packages', 60);
  upsertRule('Diya S Sirrkay', 'Individual Lab', 60);

  // Dr Athira — 80% consultation only
  upsertRule('Dr Athira Ramakrishnan', 'Consultation', 80);

  // Dr Gajanan — 85% consultation, 20% lab referrals
  upsertRule('Dr Gajanan Kulkarni', 'Consultation', 85);
  upsertRule('Dr Gajanan Kulkarni', 'Lab Packages', 20);
  upsertRule('Dr Gajanan Kulkarni', 'Individual Lab', 20);

  console.log('[Seed] Revenue sharing categories & rules verified');
}

export async function seedDatabase(db: DbHelper) {
  // Departments are now industry-specific and created via admin panel.
  // Legacy healthcare departments are kept for backward compatibility if they already exist.

  // Seed default FYs
  const fyCount = db.get('SELECT COUNT(*) as cnt FROM financial_years');
  if (fyCount.cnt === 0) {
    db.run('INSERT INTO financial_years (label, start_date, end_date, is_active) VALUES (?, ?, ?, ?)',
      'FY 2025-26', '2025-04-01', '2026-03-31', 0);
    db.run('INSERT INTO financial_years (label, start_date, end_date, is_active) VALUES (?, ?, ?, ?)',
      'FY 2026-27', '2026-04-01', '2027-03-31', 1);
  }

  // Seed admin user — always ensure it exists (env vars or defaults)
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const adminName = process.env.ADMIN_DISPLAY_NAME || 'Administrator';

  const existingAdmin = db.get('SELECT id FROM users WHERE username = ?', adminUser);
  if (!existingAdmin) {
    const hash = await bcrypt.hash(adminPass, 12);
    db.run('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
      adminUser, hash, adminName, 'admin');
    console.log(`[Seed] Admin user "${adminUser}" created`);
  } else {
    // Update password in case env var changed
    const hash = await bcrypt.hash(adminPass, 12);
    db.run('UPDATE users SET password_hash = ? WHERE username = ?', hash, adminUser);
    console.log(`[Seed] Admin user "${adminUser}" verified`);
  }

  seedRevenueSharing(db);
  seedCategoryMapping(db);
}

/**
 * Seed default forecast category ↔ Tally group mappings if the table is
 * empty. Idempotent — safe to re-run on every boot. Back-fills existing
 * clients that pre-date Step 7 without a separate migration.
 */
function seedCategoryMapping(db: DbHelper) {
  const mappingCount = db.get('SELECT COUNT(*) as cnt FROM forecast_category_mapping');
  if (mappingCount.cnt > 0) return;

  const defaults: { category: string; group: string; filter: string | null }[] = [
    { category: 'revenue', group: 'Sales Accounts', filter: null },
    { category: 'revenue', group: 'Direct Incomes', filter: null },
    { category: 'revenue', group: 'Indirect Incomes', filter: null },
    { category: 'direct_costs', group: 'Purchase Accounts', filter: null },
    { category: 'direct_costs', group: 'Direct Expenses', filter: null },
    { category: 'personnel', group: 'Indirect Expenses', filter: 'Salary%,Wages%' },
    { category: 'expenses', group: 'Indirect Expenses', filter: null },
    { category: 'assets', group: 'Fixed Assets', filter: null },
  ];
  for (const m of defaults) {
    db.run(
      'INSERT OR IGNORE INTO forecast_category_mapping (forecast_category, tally_group_name, ledger_filter) VALUES (?, ?, ?)',
      m.category, m.group, m.filter
    );
  }
  console.log('[Seed] Forecast category ↔ Tally group mapping seeded');
}
