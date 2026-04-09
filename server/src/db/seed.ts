import { DbHelper } from './connection.js';
import bcrypt from 'bcryptjs';

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
}
