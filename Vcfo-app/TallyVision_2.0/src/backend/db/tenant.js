/**
 * TallyVision - Per-client (tenant) context
 *
 * Each Magna_Tracker client gets its own isolated TallyVision workspace:
 *
 *   TALLYVISION_DATA/
 *     _default/               ← used when no slug is set (local dev, legacy)
 *       master.db
 *       clients/group_*.db
 *     magnacode/
 *       master.db
 *       clients/group_*.db
 *     indefine/
 *       master.db
 *       clients/group_*.db
 *
 * A request's active slug is carried in Node's AsyncLocalStorage. The
 * TallyVision middleware wraps each request in `requestContext.run(...)`,
 * so any code downstream (even through async/await) sees the correct slug.
 *
 * `getDbManagerForCurrentTenant()` returns a cached `DbManager` keyed by
 * slug. `getMasterDbForCurrentTenant()` delegates to it. Both are safe to
 * call outside a request (returns the `_default` tenant).
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

// Root directory on disk that holds ALL tenants.
// Falls back to the legacy single-tenant path for backward compatibility.
function getTenantRoot() {
    return process.env.TALLYVISION_DATA || path.join(__dirname, '..', '..', '..', 'data');
}

// Per-request context. The store shape is:
//   { slug: string, activeClientDb: Database|null }
const requestContext = new AsyncLocalStorage();

// Per-slug DbManager cache. One `DbManager` per tenant, lives for the
// process's lifetime. Each manages its own better-sqlite3 connections.
const _dbManagerBySlug = new Map();

/** Validate and normalize a tenant slug. */
function normalizeSlug(slug) {
    if (!slug) return DEFAULT_SLUG;
    const s = String(slug).trim().toLowerCase();
    // Allow only safe filesystem chars. Anything else → default.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) return DEFAULT_SLUG;
    return s;
}

/** Absolute path for a given tenant's data directory. */
function getTenantDir(slug) {
    const safe = normalizeSlug(slug);
    const dir = path.join(getTenantRoot(), safe);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Get (or create) the DbManager for a specific tenant. */
function getDbManagerForSlug(slug) {
    const safe = normalizeSlug(slug);
    if (_dbManagerBySlug.has(safe)) return _dbManagerBySlug.get(safe);
    const Ctor = _getDbManagerCtor();
    const mgr = new Ctor(getTenantDir(safe));
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

/** Master DB for the current request's tenant. */
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
    // If called outside a request, silently drop — the proxies fall back
    // to master anyway.
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
}

module.exports = {
    DEFAULT_SLUG,
    getTenantRoot,
    getTenantDir,
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
