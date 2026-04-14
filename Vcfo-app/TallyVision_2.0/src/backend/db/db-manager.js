/**
 * TallyVision - Database Manager (unified-DB architecture, Step 4)
 *
 * After the DB unification migration:
 *   <repo>/data/platform.db        — truly-global VCFO state (shared)
 *   <repo>/data/clients/{slug}.db  — per-client VCFO + Magna_Tracker data
 *
 * One `DbManager` per slug. The slug is the unit of multi-tenancy; the old
 * per-group / per-standalone DB routing is gone.
 *
 * The `getClientDb()` / `getStandaloneDb()` / `resolveDbForCompany()` methods
 * all resolve to the same underlying per-slug DB. The arg is kept for
 * backwards compat with the hundreds of call sites that still pass a
 * `groupId` or `companyId` — the arg is ignored, since every row in the
 * per-client DB already belongs to this slug.
 */

const fs = require('fs');
const path = require('path');
const {
    initPlatformDatabase,
    initClientDatabase,
    ensureClientSchema,
    createPlatformSchema,
    openDb,
} = require('./setup');

// Shared across all slugs — the platform DB is the same file for everyone.
let _platformDb = null;

function getPlatformDb(platformDbPath) {
    if (_platformDb) return _platformDb;
    if (fs.existsSync(platformDbPath)) {
        _platformDb = openDb(platformDbPath);
        // Idempotent: (re)apply platform schema on every open so newly-added
        // tables and one-off DROPs (e.g. the vcfo_upload_categories move to
        // per-client in Step 4) actually land on existing deployments.
        createPlatformSchema(_platformDb);
    } else {
        _platformDb = initPlatformDatabase(platformDbPath);
    }
    return _platformDb;
}

class DbManager {
    /**
     * @param {object} opts
     * @param {string} opts.slug - Magna_Tracker client slug.
     * @param {string} opts.platformDbPath - absolute path to data/platform.db.
     * @param {string} opts.clientDbPath  - absolute path to data/clients/{slug}.db.
     */
    constructor(opts) {
        if (!opts || !opts.slug) throw new Error('DbManager requires opts.slug');
        this.slug = opts.slug;
        this.platformDbPath = opts.platformDbPath;
        this.clientDbPath = opts.clientDbPath;

        // Platform DB is shared and cached at module level.
        this.masterDb = getPlatformDb(this.platformDbPath);

        // Client DB: opened lazily, cached here.
        this._clientDb = null;

        // One-off tenant migrations (idempotent).
        this._runLegacyDataMigrations();
    }

    /**
     * Idempotent, per-tenant historical data migrations. Safe to re-run —
     * each migration checks a sentinel before mutating.
     */
    _runLegacyDataMigrations() {
        try {
            const cdb = this.getClientDb();
            // Convert allocation_rules fixed amounts from annual → monthly.
            // Originally global, then per-tenant by group_id; now scoped by
            // the slug's per-client DB. Still gated by _migrated_monthly.
            const fixedRules = cdb
                .prepare("SELECT id, config FROM vcfo_allocation_rules WHERE rule_type = 'fixed'")
                .all();
            for (const r of fixedRules) {
                const cfg = JSON.parse(r.config || '{}');
                if (cfg.amount && !cfg._migrated_monthly) {
                    cfg.amount = cfg.amount / 12;
                    cfg._migrated_monthly = true;
                    cdb.prepare("UPDATE vcfo_allocation_rules SET config = ? WHERE id = ?")
                        .run(JSON.stringify(cfg), r.id);
                    console.log(`  Migrated fixed rule ${r.id}: annual → monthly`);
                }
            }
        } catch (e) {
            // Table may not exist yet (brand-new slug) — ensureClientSchema
            // will create it on first getClientDb() call below.
        }
    }

    /** Get the platform (global) DB. Aliased as "master" for backwards compat. */
    getMasterDb() {
        return this.masterDb;
    }

    /**
     * Get the per-client DB for this slug. The `_unusedId` arg is ignored —
     * kept for backwards compatibility with legacy group/standalone call
     * sites that still pass a group id or company id.
     */
    getClientDb(_unusedId) {
        if (this._clientDb) return this._clientDb;
        if (fs.existsSync(this.clientDbPath)) {
            this._clientDb = openDb(this.clientDbPath);
            // Layer VCFO schema on top of Magna_Tracker's forecast_* tables.
            ensureClientSchema(this._clientDb);
        } else {
            // Fresh client — create the full schema. (In practice the
            // Magna_Tracker admin create flow should have seeded forecast_*
            // first, but this path is safe either way since every CREATE is
            // IF NOT EXISTS.)
            this._clientDb = initClientDatabase(this.clientDbPath);
        }
        return this._clientDb;
    }

    /** Legacy alias. Same DB as getClientDb — standalone groups no longer exist. */
    getStandaloneDb(_unusedId) {
        return this.getClientDb();
    }

    /** Legacy alias. Same DB — company->group mapping no longer needed. */
    resolveDbForCompany(_unusedCompanyId) {
        return this.getClientDb();
    }

    /** Legacy alias. */
    resolveDbForGroup(_unusedGroupId) {
        return this.getClientDb();
    }

    /** Close cached connections for this tenant. Platform DB stays open. */
    closeAll() {
        if (this._clientDb) {
            try { this._clientDb.close(); } catch (e) { /* ignore */ }
            this._clientDb = null;
        }
    }
}

/** Close the shared platform DB (graceful shutdown). */
function closePlatformDb() {
    if (_platformDb) {
        try { _platformDb.close(); } catch (e) { /* ignore */ }
        _platformDb = null;
    }
}

module.exports = { DbManager, getPlatformDb, closePlatformDb };
