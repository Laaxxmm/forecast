/**
 * TallyVision - SQLite Database Setup & Migration (unified-DB architecture)
 *
 * After Step 4 of the DB unification, TallyVision no longer owns its own
 * data/ directory. All VCFO tables live alongside Magna_Tracker's:
 *
 *   <repo>/data/platform.db        — truly global TV state (vcfo_app_settings,
 *                                    vcfo_license, vcfo_client_users, …)
 *   <repo>/data/clients/{slug}.db  — per-client TV data (vcfo_ledgers,
 *                                    vcfo_trial_balance, …) shared with
 *                                    Magna_Tracker's forecast_* tables
 *
 * Every VCFO table name carries a `vcfo_` prefix so it cannot collide with
 * Magna_Tracker's forecast_* schema.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
//  PLATFORM DATABASE (truly-global VCFO state)
// ─────────────────────────────────────────────────────────

function createPlatformSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS vcfo_app_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS vcfo_license (
            id INTEGER PRIMARY KEY DEFAULT 1,
            license_key TEXT,
            max_companies INTEGER DEFAULT 1,
            valid_until DATE,
            activated_at DATETIME,
            CHECK (id = 1)
        );
        CREATE TABLE IF NOT EXISTS vcfo_client_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT DEFAULT '',
            is_active INTEGER DEFAULT 1,
            features TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS vcfo_client_company_access (
            client_id INTEGER NOT NULL,
            company_id INTEGER NOT NULL,
            PRIMARY KEY (client_id, company_id)
        );
        CREATE INDEX IF NOT EXISTS vcfo_idx_cca_client ON vcfo_client_company_access(client_id);
    `);

    // vcfo_upload_categories moved from platform -> per-client in Step 4 fix.
    // Drop any orphaned copy left over in platform.db from the earlier
    // placement. Idempotent: no-op on fresh installs.
    db.exec('DROP TABLE IF EXISTS vcfo_upload_categories;');

    // Insert default settings
    const insertSetting = db.prepare('INSERT OR IGNORE INTO vcfo_app_settings (key, value) VALUES (?, ?)');
    const defaults = {
        'tally_host': 'localhost', 'tally_port': '9000', 'sync_interval_minutes': '60',
        'auto_sync': 'true', 'dashboard_port': '3456', 'dashboard_password': '',
        'lan_access': 'false', 'theme': 'dark', 'active_company_group': '',
        'modules_toggle': 'off', 'location_tag_toggle': 'off'
    };
    for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);
}

function initPlatformDatabase(dbPath) {
    const db = openDb(dbPath);
    createPlatformSchema(db);
    return db;
}

// ─────────────────────────────────────────────────────────
//  CLIENT DATABASE (per-slug — data/clients/{slug}.db)
//  Shared with Magna_Tracker's forecast_* tables in the same file.
// ─────────────────────────────────────────────────────────

function createClientSchema(db) {
    db.exec(`
        -- Companies (formerly in master DB; now one set per slug)
        CREATE TABLE IF NOT EXISTS vcfo_companies (
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
            sync_modules TEXT DEFAULT '{}',
            state TEXT DEFAULT '',
            city TEXT DEFAULT '',
            location TEXT DEFAULT '',
            entity_type TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Chart of accounts
        CREATE TABLE IF NOT EXISTS vcfo_account_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            group_name TEXT NOT NULL,
            parent_group TEXT,
            bs_pl TEXT CHECK (bs_pl IN ('BS', 'PL')),
            dr_cr TEXT CHECK (dr_cr IN ('D', 'C')),
            affects_gross_profit TEXT CHECK (affects_gross_profit IN ('Y', 'N')),
            UNIQUE(company_id, group_name)
        );

        CREATE TABLE IF NOT EXISTS vcfo_ledgers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            group_name TEXT,
            parent_group TEXT,
            UNIQUE(company_id, name)
        );

        -- Trial Balance
        CREATE TABLE IF NOT EXISTS vcfo_trial_balance (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_tb_company_period ON vcfo_trial_balance(company_id, period_from, period_to);
        CREATE INDEX IF NOT EXISTS vcfo_idx_tb_company_ledger_period ON vcfo_trial_balance(company_id, ledger_name, period_from, period_to);
        CREATE INDEX IF NOT EXISTS vcfo_idx_tb_group ON vcfo_trial_balance(group_name);

        -- Profit & Loss
        CREATE TABLE IF NOT EXISTS vcfo_profit_loss (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_pl_company_period ON vcfo_profit_loss(company_id, period_from, period_to);
        CREATE INDEX IF NOT EXISTS vcfo_idx_pl_group ON vcfo_profit_loss(group_name);

        -- Balance Sheet
        CREATE TABLE IF NOT EXISTS vcfo_balance_sheet (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            as_on_date DATE NOT NULL,
            ledger_name TEXT NOT NULL,
            group_name TEXT,
            closing_balance REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, as_on_date, ledger_name)
        );
        CREATE INDEX IF NOT EXISTS vcfo_idx_bs_company_date ON vcfo_balance_sheet(company_id, as_on_date);

        -- Vouchers
        CREATE TABLE IF NOT EXISTS vcfo_vouchers (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_vch_company_date ON vcfo_vouchers(company_id, date);
        CREATE INDEX IF NOT EXISTS vcfo_idx_vch_type ON vcfo_vouchers(voucher_type);
        CREATE INDEX IF NOT EXISTS vcfo_idx_vch_ledger ON vcfo_vouchers(ledger_name);
        CREATE INDEX IF NOT EXISTS vcfo_idx_vch_sync_month ON vcfo_vouchers(sync_month);

        -- Stock Summary
        CREATE TABLE IF NOT EXISTS vcfo_stock_summary (
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
        CREATE TABLE IF NOT EXISTS vcfo_bills_outstanding (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_bills_company ON vcfo_bills_outstanding(company_id, as_on_date, nature);

        -- Cost Centres
        CREATE TABLE IF NOT EXISTS vcfo_cost_centres (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            parent TEXT,
            category TEXT,
            UNIQUE(company_id, name)
        );

        -- Cost Allocations
        CREATE TABLE IF NOT EXISTS vcfo_cost_allocations (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_costalloc_company ON vcfo_cost_allocations(company_id, date);

        -- GST Entries
        CREATE TABLE IF NOT EXISTS vcfo_gst_entries (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_gst_company ON vcfo_gst_entries(company_id, date);

        -- Payroll Entries
        CREATE TABLE IF NOT EXISTS vcfo_payroll_entries (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_payroll_company ON vcfo_payroll_entries(company_id, date);

        -- Stock Item Ledger
        CREATE TABLE IF NOT EXISTS vcfo_stock_item_ledger (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_stockledger_item ON vcfo_stock_item_ledger(company_id, item_name, date);

        -- Sync Log
        CREATE TABLE IF NOT EXISTS vcfo_sync_log (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_sync_log_company ON vcfo_sync_log(company_id, report_type);

        -- Excel Uploads
        CREATE TABLE IF NOT EXISTS vcfo_excel_uploads (
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
        CREATE UNIQUE INDEX IF NOT EXISTS vcfo_idx_excel_uploads_slot
            ON vcfo_excel_uploads(COALESCE(company_id, 0), category, period_month);
        CREATE INDEX IF NOT EXISTS vcfo_idx_excel_uploads_company
            ON vcfo_excel_uploads(company_id, category, period_month);
        CREATE TABLE IF NOT EXISTS vcfo_excel_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            upload_id INTEGER NOT NULL,
            company_id INTEGER,
            period_month TEXT NOT NULL,
            category TEXT NOT NULL,
            row_num INTEGER NOT NULL,
            row_data TEXT NOT NULL,
            UNIQUE(upload_id, row_num)
        );
        CREATE INDEX IF NOT EXISTS vcfo_idx_excel_data_lookup ON vcfo_excel_data(company_id, category, period_month);
        CREATE INDEX IF NOT EXISTS vcfo_idx_excel_data_upload ON vcfo_excel_data(upload_id);

        -- Budgets (group_id column retained but semantics are per-slug; one logical group per client)
        CREATE TABLE IF NOT EXISTS vcfo_budgets (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_budget_group ON vcfo_budgets(group_id, period_month);

        -- Allocation Rules
        CREATE TABLE IF NOT EXISTS vcfo_allocation_rules (
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_alloc_group ON vcfo_allocation_rules(group_id, is_active);

        -- Writeoff Rules (moved from master)
        CREATE TABLE IF NOT EXISTS vcfo_writeoff_rules (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id         INTEGER NOT NULL,
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
        CREATE INDEX IF NOT EXISTS vcfo_idx_writeoff_group ON vcfo_writeoff_rules(group_id, is_active);

        -- Tracker items (pre-existing vcfo_ prefix from master — now per-client)
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
        CREATE UNIQUE INDEX IF NOT EXISTS vcfo_idx_tracker_items_uniq ON vcfo_tracker_items(group_id, tracker_type, name);

        CREATE TABLE IF NOT EXISTS vcfo_tracker_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER NOT NULL,
            company_id INTEGER NOT NULL,
            period_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','overdue','not_applicable')),
            due_date DATE,
            completion_date DATE,
            assigned_to TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            updated_at DATETIME DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS vcfo_idx_tracker_status_uniq ON vcfo_tracker_status(item_id, company_id, period_key);

        -- Audit
        CREATE TABLE IF NOT EXISTS vcfo_audit_milestones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_prebuilt INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS vcfo_idx_audit_milestones_uniq ON vcfo_audit_milestones(group_id, name);

        CREATE TABLE IF NOT EXISTS vcfo_audit_milestone_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            milestone_id INTEGER NOT NULL,
            company_id INTEGER NOT NULL,
            fy_year INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
            due_date DATE,
            completion_date DATE,
            assigned_to TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            updated_at DATETIME DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS vcfo_idx_audit_ms_uniq ON vcfo_audit_milestone_status(milestone_id, company_id, fy_year);

        CREATE TABLE IF NOT EXISTS vcfo_audit_observations (
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

        -- Upload categories (Excel upload workflow config). Moved from
        -- platform.db to per-client in Step 4 fix so /api/upload/list's
        -- JOIN with vcfo_excel_uploads resolves in one DB.
        CREATE TABLE IF NOT EXISTS vcfo_upload_categories (
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

    // Seed upload categories (10 fixed rows). Idempotent via INSERT OR IGNORE
    // on the UNIQUE(slug) constraint.
    const hasCats = db.prepare("SELECT COUNT(*) as n FROM vcfo_upload_categories").get().n;
    if (!hasCats) {
        const insertCat = db.prepare('INSERT OR IGNORE INTO vcfo_upload_categories (slug, display_name, description, expected_columns, sort_order) VALUES (?, ?, ?, ?, ?)');
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
            "SELECT COUNT(*) as n FROM vcfo_vouchers WHERE rowid NOT IN (SELECT MIN(rowid) FROM vcfo_vouchers GROUP BY company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)"
        ).get().n;
        if (dupeCount > 0) {
            db.prepare(
                "DELETE FROM vcfo_vouchers WHERE rowid NOT IN (SELECT MIN(rowid) FROM vcfo_vouchers GROUP BY company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)"
            ).run();
            console.log(`[Client Migration M1] Removed ${dupeCount} duplicate voucher rows.`);
        }
    } catch (e) { /* vouchers may be empty */ }

    // M2: Unique index on vouchers
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS vcfo_idx_vch_unique
        ON vcfo_vouchers(company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)
    `);

    // M24: UNIQUE constraints on balance_sheet and bills_outstanding to prevent sync duplication
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS vcfo_idx_bs_unique
        ON vcfo_balance_sheet(company_id, as_on_date, ledger_name);
    `);
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS vcfo_idx_bills_unique
        ON vcfo_bills_outstanding(company_id, as_on_date, nature, party_name, COALESCE(reference_number,''));
    `);
}

function initClientDatabase(dbPath) {
    const db = openDb(dbPath);
    createClientSchema(db);
    runClientMigrations(db);
    return db;
}

/**
 * Ensure vcfo_* schema exists on a DB that Magna_Tracker already opened.
 * Used by the auto-provision path when a brand-new client is created: the
 * forecast_* tables are set up first, then VCFO layers its schema on top.
 */
function ensureClientSchema(db) {
    createClientSchema(db);
    runClientMigrations(db);
}

module.exports = {
    initPlatformDatabase,
    initClientDatabase,
    ensureClientSchema,
    createPlatformSchema,
    createClientSchema,
    runClientMigrations,
    openDb,
};
