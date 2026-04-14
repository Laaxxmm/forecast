/**
 * TallyVision - Per-client (tenant) context (unified-DB architecture, Step 4)
 *
 * After DB unification, each Magna_Tracker client's VCFO data lives in the
 * same SQLite file as its forecast data:
 *
 *   <repo>/data/platform.db        — truly-global VCFO tables (vcfo_*)
 *   <repo>/data/clients/{slug}.db  — per-client VCFO + forecast tables
 *
 * The slug is the unit of multi-tenancy. This module carries the active
 * slug through each request via AsyncLocalStorage, so any code downstream
 * (even through async/await) sees the correct tenant.
 *
 * `getDbManagerForCurrentTenant()` returns a cached `DbManager` keyed by
 * slug. All slugs share the same `platform.db` connection; each slug has
 * its own `clients/{slug}.db` connection.
 */

const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs = require('fs');

// Lazy require to avoid circular deps (db-manager.js also pulls from setup.js)
let _DbManager = null;
function _getDbManagerCtor() {
    if (!_DbManager) _DbManager = require('./db-manager').DbManager;
    return _DbManager;
}

const DEFAULT_SLUG = '_default';

/**
 * Repo-root data directory. VCFO_DATA_ROOT can override for tests, but
 * the default is the Magna_Tracker monorepo's top-level data/.
 *
 * Layout:
 *   <root>/platform.db
 *   <root>/clients/{slug}.db
 */
function getDataRoot() {
    // Walk up from backend/db/ to the repo root (4 levels: db -> backend
    // -> src -> TallyVision_2.0 -> Vcfo-app -> <repo>).
    return (
        process.env.VCFO_DATA_ROOT ||
        path.resolve(__dirname, '..', '..', '..', '..', '..', 'data')
    );
}

function getPlatformDbPath() {
    return path.join(getDataRoot(), 'platform.db');
}

function getClientsDir() {
    const dir = path.join(getDataRoot(), 'clients');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getClientDbPath(slug) {
    return path.join(getClientsDir(), `${normalizeSlug(slug)}.db`);
}

// Per-request context. The store shape is:
//   { slug: string, activeClientDb: Database|null }
const requestContext = new AsyncLocalStorage();

// Per-slug DbManager cache. One `DbManager` per tenant, lives for the
// process's lifetime. Each manages its own per-client DB connection.
const _dbManagerBySlug = new Map();

/** Validate and normalize a tenant slug. */
function normalizeSlug(slug) {
    if (!slug) return DEFAULT_SLUG;
    const s = String(slug).trim().toLowerCase();
    // Allow only safe filesystem chars. Anything else → default.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) return DEFAULT_SLUG;
    return s;
}

/** Get (or create) the DbManager for a specific slug. */
function getDbManagerForSlug(slug) {
    const safe = normalizeSlug(slug);
    if (_dbManagerBySlug.has(safe)) return _dbManagerBySlug.get(safe);
    const Ctor = _getDbManagerCtor();
    const mgr = new Ctor({
        slug: safe,
        platformDbPath: getPlatformDbPath(),
        clientDbPath: getClientDbPath(safe),
    });
    _dbManagerBySlug.set(safe, mgr);
    return mgr;
}

/** Current slug for this request (or `_default` outside a request). */
function getCurrentSlug() {
    const store = requestContext.getStore();
    return store?.slug || DEFAULT_SLUG;
}

/** DbManager for the current request's tenant. */
function getDbManagerForCurrentTenant() {
    return getDbManagerForSlug(getCurrentSlug());
}

/** Platform (global) DB for the current request's tenant. */
function getMasterDbForCurrentTenant() {
    return getDbManagerForCurrentTenant().getMasterDb();
}

/** Read/write the per-request "active client DB" pointer. */
function getActiveClientDb() {
    const store = requestContext.getStore();
    return store ? store.activeClientDb : null;
}
function setActiveClientDb(db) {
    const store = requestContext.getStore();
    if (store) store.activeClientDb = db;
}

/**
 * Run `fn` inside a tenant context. Used by the TallyVision request
 * middleware to bind a slug to the whole async call chain.
 */
function withTenant(slug, fn) {
    const store = { slug: normalizeSlug(slug), activeClientDb: null };
    return requestContext.run(store, fn);
}

/** Close every cached tenant's connections (graceful shutdown). */
function closeAllTenants() {
    for (const [, mgr] of _dbManagerBySlug) {
        try { mgr.closeAll(); } catch (e) { /* ignore */ }
    }
    _dbManagerBySlug.clear();
    try { require('./db-manager').closePlatformDb(); } catch (e) { /* ignore */ }
}

module.exports = {
    DEFAULT_SLUG,
    getDataRoot,
    getPlatformDbPath,
    getClientsDir,
    getClientDbPath,
    normalizeSlug,
    requestContext,
    withTenant,
    getCurrentSlug,
    getDbManagerForSlug,
    getDbManagerForCurrentTenant,
    getMasterDbForCurrentTenant,
    getActiveClientDb,
    setActiveClientDb,
    closeAllTenants,
};
