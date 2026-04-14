/**
 * TallyVision - Database Manager
 * Routes queries to the correct per-client database.
 *
 * Architecture:
 *   data/master.db           — global tables (settings, companies, groups, users)
 *   data/clients/group_{id}.db       — data for all companies in a group
 *   data/clients/standalone_{id}.db  — data for an ungrouped company
 */

const path = require('path');
const fs = require('fs');
const {
    initMasterDatabase,
    initClientDatabase,
    openDb,
    getDbPath,
    getMasterDbPath,
    getClientDbDir,
} = require('./setup');

// Tables that live in client DBs (used during migration)
const CLIENT_TABLES = [
    'account_groups', 'ledgers', 'trial_balance', 'profit_loss', 'balance_sheet',
    'vouchers', 'stock_summary', 'stock_item_ledger', 'bills_outstanding',
    'cost_centres', 'cost_allocations', 'gst_entries', 'payroll_entries', 'sync_log',
    'excel_uploads', 'excel_data',
    'budgets', 'allocation_rules',
];

// Tables with company_id column (subset of CLIENT_TABLES used in per-company copy)
const COMPANY_SCOPED_TABLES = [
    'account_groups', 'ledgers', 'trial_balance', 'profit_loss', 'balance_sheet',
    'vouchers', 'stock_summary', 'stock_item_ledger', 'bills_outstanding',
    'cost_centres', 'cost_allocations', 'gst_entries', 'payroll_entries', 'sync_log',
    'excel_uploads', 'excel_data',
];

// Tables scoped by group_id (copied once per group, not per company)
const GROUP_SCOPED_TABLES = [
    'budgets', 'allocation_rules',
];

class DbManager {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.clientDir = getClientDbDir();
        this._cache = new Map(); // path → Database connection

        // Auto-migrate if needed
        this._autoMigrate();

        // Open master DB and ensure schema is up to date
        this.masterDb = this._openCached(getMasterDbPath(), 'master');
        this._ensureMasterSchema();
    }

    /** Ensure master DB has all tables (handles upgrades to existing DBs) */
    _ensureMasterSchema() {
        const tables = this.masterDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        if (!tables.includes('upload_categories')) {
            this.masterDb.exec(`
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
            // Seed default categories
            const insertCat = this.masterDb.prepare('INSERT OR IGNORE INTO upload_categories (slug, display_name, description, expected_columns, sort_order) VALUES (?, ?, ?, ?, ?)');
            [
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
            ].forEach(c => insertCat.run(...c));
            console.log('  Migrated upload_categories to master DB');
        }
    }

    /** Get the master database connection */
    getMasterDb() {
        return this.masterDb;
    }

    /** Get client DB for a company group */
    getClientDb(groupId) {
        const dbPath = path.join(this.clientDir, `group_${groupId}.db`);
        if (!fs.existsSync(dbPath)) {
            // Create on demand
            const db = initClientDatabase(dbPath);
            this._cache.set(dbPath, db);
            return db;
        }
        return this._openCached(dbPath, `group_${groupId}`);
    }

    /** Get client DB for a standalone (ungrouped) company */
    getStandaloneDb(companyId) {
        const dbPath = path.join(this.clientDir, `standalone_${companyId}.db`);
        if (!fs.existsSync(dbPath)) {
            const db = initClientDatabase(dbPath);
            this._cache.set(dbPath, db);
            return db;
        }
        return this._openCached(dbPath, `standalone_${companyId}`);
    }

    /** Resolve which client DB holds data for a given company_id */
    resolveDbForCompany(companyId) {
        // Check if company belongs to any group
        const row = this.masterDb.prepare(
            'SELECT group_id FROM company_group_members WHERE company_id = ? LIMIT 1'
        ).get(companyId);
        if (row) return this.getClientDb(row.group_id);
        return this.getStandaloneDb(companyId);
    }

    /** Resolve client DB for a group (alias) */
    resolveDbForGroup(groupId) {
        return this.getClientDb(groupId);
    }

    /**
     * Move a company's data from one client DB to another.
     * Used when adding/removing companies from groups.
     */
    moveCompanyData(companyId, sourceDb, targetDb) {
        // Use a transaction on target for atomicity
        const copyTx = targetDb.transaction(() => {
            for (const table of COMPANY_SCOPED_TABLES) {
                try {
                    const rows = sourceDb.prepare(`SELECT * FROM ${table} WHERE company_id = ?`).all(companyId);
                    if (!rows.length) continue;
                    const cols = Object.keys(rows[0]).filter(c => c !== 'id');
                    const placeholders = cols.map(() => '?').join(',');
                    const ins = targetDb.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
                    for (const row of rows) ins.run(...cols.map(c => row[c]));
                } catch (e) {
                    // Table may not have data, skip
                }
            }
        });
        copyTx();

        // Delete from source
        const delTx = sourceDb.transaction(() => {
            for (const table of COMPANY_SCOPED_TABLES) {
                try {
                    sourceDb.prepare(`DELETE FROM ${table} WHERE company_id = ?`).run(companyId);
                } catch (e) { /* skip */ }
            }
        });
        delTx();
    }

    /**
     * Copy group-scoped data (budgets, allocations) from source to target.
     * Used during migration when a group's data lives in the old monolithic DB.
     */
    copyGroupData(groupId, sourceDb, targetDb) {
        const tx = targetDb.transaction(() => {
            for (const table of GROUP_SCOPED_TABLES) {
                try {
                    const cols = sourceDb.pragma(`table_info(${table})`).map(c => c.name);
                    if (cols.includes('group_id')) {
                        const rows = sourceDb.prepare(`SELECT * FROM ${table} WHERE group_id = ?`).all(groupId);
                        if (!rows.length) continue;
                        const insertCols = cols.filter(c => c !== 'id');
                        const ph = insertCols.map(() => '?').join(',');
                        const ins = targetDb.prepare(`INSERT OR IGNORE INTO ${table} (${insertCols.join(',')}) VALUES (${ph})`);
                        for (const row of rows) ins.run(...insertCols.map(c => row[c]));
                    }
                } catch (e) {
                    // Table may not exist in source or be empty
                }
            }
        });
        tx();
    }

    /** Close all cached connections */
    closeAll() {
        for (const [, db] of this._cache) {
            try { db.close(); } catch (e) { /* ignore */ }
        }
        this._cache.clear();
    }

    // ── Private helpers ──

    _openCached(dbPath, label) {
        if (this._cache.has(dbPath)) return this._cache.get(dbPath);
        const db = openDb(dbPath);
        this._cache.set(dbPath, db);
        return db;
    }

    /**
     * Auto-migrate from single tallyvision.db to per-client architecture.
     * Runs once on first startup when master.db doesn't exist but tallyvision.db does.
     */
    _autoMigrate() {
        const masterPath = getMasterDbPath();
        const legacyPath = getDbPath();

        // Already migrated
        if (fs.existsSync(masterPath)) return;

        // No legacy DB either — fresh install
        if (!fs.existsSync(legacyPath)) {
            initMasterDatabase(masterPath);
            return;
        }

        console.log('=== Auto-migrating from single DB to per-client architecture ===');
        const startTime = Date.now();

        // Step 1: Open legacy DB
        const legacyDb = openDb(legacyPath);

        // Step 2: Create master.db with master schema
        const masterDb = initMasterDatabase(masterPath);

        // Step 3: Copy master-only tables from legacy to master
        const masterTables = [
            'app_settings', 'license', 'companies', 'company_groups', 'company_group_members',
            'client_users', 'client_company_access', 'writeoff_rules',
            'vcfo_tracker_items', 'vcfo_tracker_status',
            'audit_milestones', 'audit_milestone_status', 'audit_observations',
        ];

        for (const table of masterTables) {
            try {
                const exists = legacyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
                if (!exists) continue;
                const rows = legacyDb.prepare(`SELECT * FROM ${table}`).all();
                if (!rows.length) continue;
                const cols = Object.keys(rows[0]);
                const ph = cols.map(() => '?').join(',');
                const ins = masterDb.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${ph})`);
                const tx = masterDb.transaction(() => {
                    for (const row of rows) ins.run(...cols.map(c => row[c]));
                });
                tx();
                console.log(`  Copied ${rows.length} rows to master.${table}`);
            } catch (e) {
                console.log(`  Skip master.${table}: ${e.message}`);
            }
        }

        // Step 4: Get all groups and their members
        const groups = masterDb.prepare('SELECT id, name FROM company_groups').all();
        const allGroupedCompanyIds = new Set();

        for (const group of groups) {
            const memberIds = masterDb.prepare(
                'SELECT company_id FROM company_group_members WHERE group_id = ?'
            ).all(group.id).map(r => r.company_id);

            if (!memberIds.length) continue;
            memberIds.forEach(id => allGroupedCompanyIds.add(id));

            // Create client DB for this group
            const clientPath = path.join(this.clientDir, `group_${group.id}.db`);
            const clientDb = initClientDatabase(clientPath);

            // Copy company-scoped data for each member
            for (const companyId of memberIds) {
                for (const table of COMPANY_SCOPED_TABLES) {
                    try {
                        const exists = legacyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
                        if (!exists) continue;
                        const rows = legacyDb.prepare(`SELECT * FROM ${table} WHERE company_id = ?`).all(companyId);
                        if (!rows.length) continue;
                        const cols = Object.keys(rows[0]).filter(c => c !== 'id');
                        const ph = cols.map(() => '?').join(',');
                        const ins = clientDb.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${ph})`);
                        const tx = clientDb.transaction(() => {
                            for (const row of rows) ins.run(...cols.map(c => row[c]));
                        });
                        tx();
                    } catch (e) { /* skip */ }
                }
            }

            // Copy group-scoped data (budgets, allocations)
            this.copyGroupData(group.id, legacyDb, clientDb);

            clientDb.close();
            console.log(`  Created group_${group.id}.db (${group.name}) with ${memberIds.length} companies`);
        }

        // Step 5: Handle ungrouped companies
        const allCompanies = masterDb.prepare('SELECT id, name FROM companies').all();
        for (const company of allCompanies) {
            if (allGroupedCompanyIds.has(company.id)) continue;

            const clientPath = path.join(this.clientDir, `standalone_${company.id}.db`);
            const clientDb = initClientDatabase(clientPath);

            for (const table of COMPANY_SCOPED_TABLES) {
                try {
                    const exists = legacyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
                    if (!exists) continue;
                    const rows = legacyDb.prepare(`SELECT * FROM ${table} WHERE company_id = ?`).all(company.id);
                    if (!rows.length) continue;
                    const cols = Object.keys(rows[0]).filter(c => c !== 'id');
                    const ph = cols.map(() => '?').join(',');
                    const ins = clientDb.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${ph})`);
                    const tx = clientDb.transaction(() => {
                        for (const row of rows) ins.run(...cols.map(c => row[c]));
                    });
                    tx();
                } catch (e) { /* skip */ }
            }

            clientDb.close();
            console.log(`  Created standalone_${company.id}.db (${company.name})`);
        }

        // Step 6: Mark migration complete
        masterDb.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('db_architecture', 'per_client')").run();

        // Step 7: Backup legacy DB
        legacyDb.close();
        masterDb.close();
        const backupPath = legacyPath.replace('.db', '_backup.db');
        fs.renameSync(legacyPath, backupPath);
        console.log(`  Legacy DB backed up to: ${path.basename(backupPath)}`);
        console.log(`=== Migration complete in ${Date.now() - startTime}ms ===`);
    }
}

module.exports = { DbManager, CLIENT_TABLES, COMPANY_SCOPED_TABLES, GROUP_SCOPED_TABLES };
