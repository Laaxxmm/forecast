import { DbHelper } from './connection.js';
import bcrypt from 'bcryptjs';

export async function seedDatabase(db: DbHelper) {
  // Seed departments
  db.run('INSERT OR IGNORE INTO departments (name, display_name, business_unit, sort_order) VALUES (?, ?, ?, ?)', 'APPOINTMENT', 'Appointments', 'CLINIC', 1);
  db.run('INSERT OR IGNORE INTO departments (name, display_name, business_unit, sort_order) VALUES (?, ?, ?, ?)', 'LAB TEST', 'Lab Tests', 'CLINIC', 2);
  db.run('INSERT OR IGNORE INTO departments (name, display_name, business_unit, sort_order) VALUES (?, ?, ?, ?)', 'OTHER SERVICES', 'Other Services', 'CLINIC', 3);

  // Seed default FYs
  const fyCount = db.get('SELECT COUNT(*) as cnt FROM financial_years');
  if (fyCount.cnt === 0) {
    db.run('INSERT INTO financial_years (label, start_date, end_date, is_active) VALUES (?, ?, ?, ?)',
      'FY 2025-26', '2025-04-01', '2026-03-31', 0);
    db.run('INSERT INTO financial_years (label, start_date, end_date, is_active) VALUES (?, ?, ?, ?)',
      'FY 2026-27', '2026-04-01', '2027-03-31', 1);
  }

  // Seed default admin user
  const userCount = db.get('SELECT COUNT(*) as cnt FROM users');
  if (userCount.cnt === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    db.run('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
      'admin', hash, 'Administrator', 'admin');
  }
}
