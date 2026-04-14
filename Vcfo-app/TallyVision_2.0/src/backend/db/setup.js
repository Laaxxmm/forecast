/**
 * TallyVision - SQLite Database Setup & Migration
 * Supports per-client database architecture:
 *   master.db  — global tables (settings, companies, groups, users)
 *   clients/   — per-group or per-standalone-company databases
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.TALLYVISION_DATA || path.join(__dirname, '..', '..', '..', 'data');

function getDbPath() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    return path.join(DB_DIR, 'tallyvision.db');
}

function getMasterDbPath() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    return path.join(DB_DIR, 'master.db');
}

function getClientDbDir() {
    const dir = path.join(DB_DIR, 'clients');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Open a SQLite DB with standard performance pragmas */
function openDb(dbPath) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return db;
}

// ─────────────────────────────────────────────────────────
//  MASTER DATABASE (global tables only)
// ─────────────────────────────────────────────────────────

function createMasterSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS license (
            id INTEGER PRIMARY KEY DEFAULT 1,
            license_key TEXT,
            max_companies INTEGER DEFAULT 1,
            valid_until DATE,
            activated_at DATETIME,
            CHECK (id = 1)
        );
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            guid TEXT,
            fy_start_month INTEGER DEFAULT 4,
            fy_from DATE,
            fy_to DATE,
            tally_version TEXT,
            last_full_sync_at DATETIME,
            last_incremental_sync_at DATETIME,
            sync_from_date DATE,
            sync_to_date DATE,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS company_groups (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            description TEXT DEFAULT '',
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS company_group_members (
            group_id   INTEGER NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
            company_id INTEGER NOT NULL REFERENCES companies(id)      ON DELETE CASCADE,
            PRIMARY KEY (group_id, company_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cgm_group   ON company_group_members(group_id);
        CREATE INDEX IF NOT EXISTS idx_cgm_company ON company_group_members(company_id);

        CREATE TABLE IF NOT EXISTS client_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT DEFAULT '',
            is_active INTEGER DEFAULT 1,
            features TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS client_company_access (
            client_id INTEGER NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
            company_id INTEGER NOT NULL,
            PRIMARY KEY (client_id, company_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cca_client ON client_company_access(client_id);

        CREATE TABLE IF NOT EXISTS writeoff_rules (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id         INTEGER NOT NULL REFERENCES company_groups(id) ON DELETE CASCADE,
            rule_name        TEXT NOT NULL,
            rule_type        TEXT NOT NULL CHECK (rule_type IN ('expense_addback', 'income_deduction')),
            company_ids      TEXT NOT NULL DEFAULT '[]',
            ledger_names     TEXT NOT NULL DEFAULT '[]',
            config           TEXT NOT NULL DEFAULT '{}',
            affects_dashboard INTEGER DEFAULT 1,
            is_active        INTEGER DEFAULT 1,
            sort_order       INTEGER DEFAULT 0,
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_writeoff_group ON writeoff_rules(group_id, is_active);

        CREATE TABLE IF NOT EXISTS vcfo_tracker_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            tracker_type TEXT NOT NULL CHECK (tracker_type IN ('compliance','accounting','internal_control')),
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT '',
            frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly','quarterly','half_yearly','annual','one_time')),
            default_due_day INTEGER DEFAULT 0,
            is_prebuilt INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            config TEXT NOT NULL DEFAULT '{}',
            created_at DATETIME DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vcfo_items_uniq ON vcfo_tracker_items(group_id, tracker_type, name);

        CREATE TABLE IF NOT EXISTS vcfo_tracker_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL REFERENCES vcfo_tracker_items(id) ON DELETE CASCADE,
            company_id INTEGER NOT NULL,
            period_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','overdue','not_applicable')),
            due_date DATE,
            completion_date DATE,
            assigned_to TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            updated_at DATETIME DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vcfo_status_uniq ON vcfo_tracker_status(item_id, company_id, period_key);

        CREATE TABLE IF NOT EXISTS audit_milestones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_prebuilt INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_milestones_uniq ON audit_milestones(group_id, name);

        CREATE TABLE IF NOT EXISTS audit_milestone_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            milestone_id INTEGER NOT NULL REFERENCES audit_milestones(id) ON DELETE CASCADE,
            company_id INTEGER NOT NULL,
            fy_year INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
            due_date DATE,
            completion_date DATE,
            assigned_to TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            updated_at DATETIME DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_ms_uniq ON audit_milestone_status(milestone_id, company_id, fy_year);

        CREATE TABLE IF NOT EXISTS audit_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            company_id INTEGER,
            fy_year INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('high','medium','low')),
            category TEXT DEFAULT '',
            recommendation TEXT DEFAULT '',
            mgmt_response TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
            assigned_to TEXT DEFAULT '',
            due_date DATE,
            resolution_date DATE,
            created_at DATETIME DEFAULT (datetime('now')),
            updated_at DATETIME DEFAULT (datetime('now'))
        );
    `);

    // Upload categories (global config — lives in master, not client DBs)
    db.exec(`
        CREATE TABLE IF NOT EXISTS upload_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            description TEXT,
            expected_columns TEXT DEFAULT '[]',
            is_active INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Insert default settings
    const insertSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
    const defaults = {
        'tally_host': 'localhost', 'tally_port': '9000', 'sync_interval_minutes': '60',
        'auto_sync': 'true', 'dashboard_port': '3456', 'dashboard_password': '',
        'lan_access': 'false', 'theme': 'dark', 'active_company_group': '',
        'modules_toggle': 'off', 'location_tag_toggle': 'off'
    };
    for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);

    // Seed upload categories
    const hasCats = db.prepare("SELECT COUNT(*) as n FROM upload_categories").get().n;
    if (!hasCats) {
        const insertCat = db.prepare('INSERT OR IGNORE INTO upload_categories (slug, display_name, description, expected_columns, sort_order) VALUES (?, ?, ?, ?, ?)');
        const categories = [
            ['revenue', 'Revenue', 'Bill-wise revenue', '["Date","Bill No","Patient Name","Doctor","Department","Amount","Payment Mode"]', 1],
            ['direct_income', 'Direct Income', 'Direct income breakdowns', '["Date","Description","Amount","Source"]', 2],
            ['purchase', 'Purchases', 'Purchase details', '["Date","Invoice No","Supplier","Item","Quantity","Amount"]', 3],
            ['direct_expenses', 'Direct Expenses', 'Direct costs', '["Date","Doctor Name","Department","Consultations","Amount"]', 4],
            ['indirect_expenses', 'Indirect Expenses', 'Overhead expenses', '["Date","Description","Category","Amount"]', 5],
            ['indirect_income', 'Indirect Income', 'Other income', '["Date","Description","Amount","Source"]', 6],
            ['opening_stock', 'Opening Stock', 'Opening stock', '["Item Name","Stock Group","Quantity","Value"]', 7],
            ['closing_stock', 'Closing Stock', 'Closing stock', '["Item Name","Stock Group","Quantity","Value"]', 8],
            ['loans', 'Loans', 'Loan details', '["Lender","Loan Type","Outstanding","EMI","Due Date"]', 9],
            ['custom', 'Custom Data', 'Supplementary data', '[]', 99],
        ];
        for (const c of categories) insertCat.run(...c);
    }
}

function runMasterMigrations(db) {
    // M3: sync_modules on companies
    const cols = db.pragma('table_info(companies)').map(c => c.name);
    if (!cols.includes('sync_modules'))  db.exec("ALTER TABLE companies ADD COLUMN sync_modules TEXT DEFAULT '{}'");
    // M4: Geographic metadata
    if (!cols.includes('state'))         db.exec("ALTER TABLE companies ADD COLUMN state TEXT DEFAULT ''");
    if (!cols.includes('city'))          db.exec("ALTER TABLE companies ADD COLUMN city TEXT DEFAULT ''");
    if (!cols.includes('location'))      db.exec("ALTER TABLE companies ADD COLUMN location TEXT DEFAULT ''");
    if (!cols.includes('entity_type'))   db.exec("ALTER TABLE companies ADD COLUMN entity_type TEXT DEFAULT ''");

    // M5: upload_categories moved from client to master DB
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upload_categories'").all();
    if (!tables.length) {
        createMasterSchema(db); // Re-run schema (all IF NOT EXISTS, safe) to create upload_categories + seed
    }
}

function initMasterDatabase(dbPath) {
    const db = openDb(dbPath || getMasterDbPath());
    createMasterSchema(db);
    runMasterMigrations(db);
    console.log('Master database initialized successfully');
    return db;
}

// ─────────────────────────────────────────────────────────
//  CLIENT DATABASE (per-group / per-standalone-company)
// ─────────────────────────────────────────────────────────

function createClientSchema(db) {
    db.exec(`
        -- Chart of accounts
        CREATE TABLE IF NOT EXISTS account_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            group_name TEXT NOT NULL,
            parent_group TEXT,
            bs_pl TEXT CHECK (bs_pl IN ('BS', 'PL')),
            dr_cr TEXT CHECK (dr_cr IN ('D', 'C')),
            affects_gross_profit TEXT CHECK (affects_gross_profit IN ('Y', 'N')),
            UNIQUE(company_id, group_name)
        );

        CREATE TABLE IF NOT EXISTS ledgers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            group_name TEXT,
            parent_group TEXT,
            UNIQUE(company_id, name)
        );

        -- Trial Balance
        CREATE TABLE IF NOT EXISTS trial_balance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            period_from DATE NOT NULL,
            period_to DATE NOT NULL,
            ledger_name TEXT NOT NULL,
            group_name TEXT,
            opening_balance REAL DEFAULT 0,
            net_debit REAL DEFAULT 0,
            net_credit REAL DEFAULT 0,
            closing_balance REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, period_from, period_to, ledger_name)
        );
        CREATE INDEX IF NOT EXISTS idx_tb_company_period ON trial_balance(company_id, period_from, period_to);
        CREATE INDEX IF NOT EXISTS idx_tb_company_ledger_period ON trial_balance(company_id, ledger_name, period_from, period_to);
        CREATE INDEX IF NOT EXISTS idx_tb_group ON trial_balance(group_name);

        -- Profit & Loss
        CREATE TABLE IF NOT EXISTS profit_loss (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            period_from DATE NOT NULL,
            period_to DATE NOT NULL,
            ledger_name TEXT NOT NULL,
            group_name TEXT,
            amount REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, period_from, period_to, ledger_name)
        );
        CREATE INDEX IF NOT EXISTS idx_pl_company_period ON profit_loss(company_id, period_from, period_to);
        CREATE INDEX IF NOT EXISTS idx_pl_group ON profit_loss(group_name);

        -- Balance Sheet
        CREATE TABLE IF NOT EXISTS balance_sheet (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            as_on_date DATE NOT NULL,
            ledger_name TEXT NOT NULL,
            group_name TEXT,
            closing_balance REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, as_on_date, ledger_name)
        );
        CREATE INDEX IF NOT EXISTS idx_bs_company_date ON balance_sheet(company_id, as_on_date);

        -- Vouchers
        CREATE TABLE IF NOT EXISTS vouchers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            date DATE NOT NULL,
            voucher_type TEXT NOT NULL,
            voucher_number TEXT,
            ledger_name TEXT,
            amount REAL NOT NULL,
            party_name TEXT,
            narration TEXT,
            sync_month TEXT,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_vch_company_date ON vouchers(company_id, date);
        CREATE INDEX IF NOT EXISTS idx_vch_type ON vouchers(voucher_type);
        CREATE INDEX IF NOT EXISTS idx_vch_ledger ON vouchers(ledger_name);
        CREATE INDEX IF NOT EXISTS idx_vch_sync_month ON vouchers(sync_month);

        -- Stock Summary
        CREATE TABLE IF NOT EXISTS stock_summary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            period_from DATE NOT NULL,
            period_to DATE NOT NULL,
            item_name TEXT NOT NULL,
            stock_group TEXT,
            opening_qty REAL DEFAULT 0, opening_value REAL DEFAULT 0,
            inward_qty REAL DEFAULT 0,  inward_value REAL DEFAULT 0,
            outward_qty REAL DEFAULT 0, outward_value REAL DEFAULT 0,
            closing_qty REAL DEFAULT 0, closing_value REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, period_from, period_to, item_name)
        );

        -- Bills Outstanding
        CREATE TABLE IF NOT EXISTS bills_outstanding (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            as_on_date DATE NOT NULL,
            nature TEXT CHECK (nature IN ('receivable', 'payable')),
            bill_date DATE,
            reference_number TEXT,
            outstanding_amount REAL DEFAULT 0,
            party_name TEXT,
            overdue_days INTEGER DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_bills_company ON bills_outstanding(company_id, as_on_date, nature);

        -- Cost Centres
        CREATE TABLE IF NOT EXISTS cost_centres (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            parent TEXT,
            category TEXT,
            UNIQUE(company_id, name)
        );

        -- Cost Allocations
        CREATE TABLE IF NOT EXISTS cost_allocations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            date DATE NOT NULL,
            voucher_type TEXT NOT NULL DEFAULT '',
            voucher_number TEXT NOT NULL DEFAULT '',
            ledger_name TEXT NOT NULL DEFAULT '',
            cost_centre TEXT NOT NULL DEFAULT '',
            amount REAL DEFAULT 0,
            sync_month TEXT,
            UNIQUE(company_id, date, voucher_type, voucher_number, ledger_name, cost_centre)
        );
        CREATE INDEX IF NOT EXISTS idx_costalloc_company ON cost_allocations(company_id, date);

        -- GST Entries
        CREATE TABLE IF NOT EXISTS gst_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            date DATE NOT NULL,
            voucher_type TEXT NOT NULL DEFAULT '',
            voucher_number TEXT NOT NULL DEFAULT '',
            party_name TEXT NOT NULL DEFAULT '',
            gstin TEXT,
            supply_type TEXT,
            hsn_sac TEXT,
            taxable_value REAL DEFAULT 0,
            igst REAL DEFAULT 0, cgst REAL DEFAULT 0, sgst REAL DEFAULT 0, cess REAL DEFAULT 0,
            sync_month TEXT,
            UNIQUE(company_id, date, voucher_number, party_name)
        );
        CREATE INDEX IF NOT EXISTS idx_gst_company ON gst_entries(company_id, date);

        -- Payroll Entries
        CREATE TABLE IF NOT EXISTS payroll_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            date DATE NOT NULL,
            voucher_number TEXT NOT NULL DEFAULT '',
            employee_name TEXT NOT NULL DEFAULT '',
            employee_group TEXT,
            pay_head TEXT NOT NULL DEFAULT '',
            amount REAL DEFAULT 0,
            sync_month TEXT,
            UNIQUE(company_id, date, voucher_number, employee_name, pay_head)
        );
        CREATE INDEX IF NOT EXISTS idx_payroll_company ON payroll_entries(company_id, date);

        -- Stock Item Ledger
        CREATE TABLE IF NOT EXISTS stock_item_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            date DATE NOT NULL,
            item_name TEXT NOT NULL DEFAULT '',
            voucher_type TEXT NOT NULL DEFAULT '',
            voucher_number TEXT NOT NULL DEFAULT '',
            party_name TEXT,
            quantity REAL DEFAULT 0,
            amount REAL DEFAULT 0,
            sync_month TEXT,
            UNIQUE(company_id, item_name, date, voucher_type, voucher_number)
        );
        CREATE INDEX IF NOT EXISTS idx_stockledger_item ON stock_item_ledger(company_id, item_name, date);

        -- Sync Log
        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            report_type TEXT NOT NULL,
            period_from DATE,
            period_to DATE,
            row_count INTEGER DEFAULT 0,
            status TEXT CHECK (status IN ('running', 'success', 'error', 'partial')),
            error_message TEXT,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_sync_log_company ON sync_log(company_id, report_type);

        -- Excel Uploads
        CREATE TABLE IF NOT EXISTS upload_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            description TEXT,
            expected_columns TEXT DEFAULT '[]',
            is_active INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS excel_uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            category TEXT NOT NULL,
            period_month TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            stored_filename TEXT NOT NULL,
            file_size INTEGER DEFAULT 0,
            sheet_name TEXT,
            row_count INTEGER DEFAULT 0,
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_excel_uploads_slot
            ON excel_uploads(COALESCE(company_id, 0), category, period_month);
        CREATE INDEX IF NOT EXISTS idx_excel_uploads_company
            ON excel_uploads(company_id, category, period_month);
        CREATE TABLE IF NOT EXISTS excel_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            upload_id INTEGER NOT NULL REFERENCES excel_uploads(id) ON DELETE CASCADE,
            company_id INTEGER,
            period_month TEXT NOT NULL,
            category TEXT NOT NULL,
            row_num INTEGER NOT NULL,
            row_data TEXT NOT NULL,
            UNIQUE(upload_id, row_num)
        );
        CREATE INDEX IF NOT EXISTS idx_excel_data_lookup ON excel_data(company_id, category, period_month);
        CREATE INDEX IF NOT EXISTS idx_excel_data_upload ON excel_data(upload_id);

        -- Budgets
        CREATE TABLE IF NOT EXISTS budgets (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id    INTEGER NOT NULL,
            company_id  INTEGER,
            period_month TEXT NOT NULL,
            line_item   TEXT NOT NULL,
            amount      REAL DEFAULT 0,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, company_id, period_month, line_item)
        );
        CREATE INDEX IF NOT EXISTS idx_budget_group ON budgets(group_id, period_month);

        -- Allocation Rules
        CREATE TABLE IF NOT EXISTS allocation_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id    INTEGER NOT NULL,
            rule_name   TEXT NOT NULL,
            rule_type   TEXT NOT NULL CHECK (rule_type IN ('ratio', 'fixed', 'percent_income')),
            config      TEXT NOT NULL DEFAULT '{}',
            is_active   INTEGER DEFAULT 1,
            sort_order  INTEGER DEFAULT 0,
            affects_dashboard INTEGER DEFAULT 0,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_alloc_group ON allocation_rules(group_id, is_active);

    `);

    // Seed upload categories
    const hasCats = db.prepare("SELECT COUNT(*) as n FROM upload_categories").get().n;
    if (!hasCats) {
        const insertCat = db.prepare('INSERT OR IGNORE INTO upload_categories (slug, display_name, description, expected_columns, sort_order) VALUES (?, ?, ?, ?, ?)');
        const categories = [
            ['revenue', 'Revenue', 'Bill-wise revenue', '["Date","Bill No","Patient Name","Doctor","Department","Amount","Payment Mode"]', 1],
            ['direct_income', 'Direct Income', 'Direct income breakdowns', '["Date","Description","Amount","Source"]', 2],
            ['purchase', 'Purchases', 'Purchase details', '["Date","Invoice No","Supplier","Item","Quantity","Amount"]', 3],
            ['direct_expenses', 'Direct Expenses', 'Direct costs', '["Date","Doctor Name","Department","Consultations","Amount"]', 4],
            ['indirect_expenses', 'Indirect Expenses', 'Overhead expenses', '["Date","Description","Category","Amount"]', 5],
            ['indirect_income', 'Indirect Income', 'Other income', '["Date","Description","Amount","Source"]', 6],
            ['opening_stock', 'Opening Stock', 'Opening stock', '["Item Name","Stock Group","Quantity","Value"]', 7],
            ['closing_stock', 'Closing Stock', 'Closing stock', '["Item Name","Stock Group","Quantity","Value"]', 8],
            ['loans', 'Loans', 'Loan details', '["Lender","Loan Type","Outstanding","EMI","Due Date"]', 9],
            ['custom', 'Custom Data', 'Supplementary data', '[]', 99],
        ];
        for (const c of categories) insertCat.run(...c);
    }
}

function runClientMigrations(db) {
    // M1: Deduplicate vouchers (keep lowest rowid per unique entry)
    try {
        const dupeCount = db.prepare(
            "SELECT COUNT(*) as n FROM vouchers WHERE rowid NOT IN (SELECT MIN(rowid) FROM vouchers GROUP BY company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)"
        ).get().n;
        if (dupeCount > 0) {
            db.prepare(
                "DELETE FROM vouchers WHERE rowid NOT IN (SELECT MIN(rowid) FROM vouchers GROUP BY company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)"
            ).run();
            console.log(`[Client Migration M1] Removed ${dupeCount} duplicate voucher rows.`);
        }
    } catch (e) { /* vouchers may be empty */ }

    // M2: Unique index on vouchers
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vch_unique
        ON vouchers(company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)
    `);

    // M24: UNIQUE constraints on balance_sheet and bills_outstanding to prevent sync duplication
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bs_unique
        ON balance_sheet(company_id, as_on_date, ledger_name);
    `);
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_unique
        ON bills_outstanding(company_id, as_on_date, nature, party_name, COALESCE(reference_number,''));
    `);
}

function initClientDatabase(dbPath) {
    const db = openDb(dbPath);
    createClientSchema(db);
    runClientMigrations(db);
    return db;
}

// ─────────────────────────────────────────────────────────
//  LEGACY: Single-DB mode (backward compatibility)
// ─────────────────────────────────────────────────────────

function initDatabase(dbPath) {
    const db = openDb(dbPath || getDbPath());
    createMasterSchema(db);
    createClientSchema(db);
    runMasterMigrations(db);
    runClientMigrations(db);
    console.log('Database schema initialized successfully');
    return db;
}

module.exports = {
    initDatabase,
    initMasterDatabase,
    initClientDatabase,
    createMasterSchema,
    createClientSchema,
    runMasterMigrations,
    runClientMigrations,
    openDb,
    getDbPath,
    getMasterDbPath,
    getClientDbDir,
    DB_DIR
};
