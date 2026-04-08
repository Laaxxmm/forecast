/**
 * TallyVision - REST API Server (v4 - Dynamic TB, Optimized)
 * In-memory ledger→group mapping for fast voucher aggregation
 */

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { initDatabase, getDbPath, DB_DIR } = require('./db/setup');
const { DbManager } = require('./db/db-manager');
const { TallyConnector } = require('./tally-connector');
const { DataExtractor } = require('./extractors/data-extractor');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
    secret: uuidv4(), // random per server start; fine for small scale
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 } // 24h
}));

// ===== AUTH HELPERS =====
function isClientSession(req) {
    return !!(req.session && req.session.clientUser);
}

function adminOnly(req, res, next) {
    if (isClientSession(req)) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// Serve frontend — admin view
const FRONTEND_DIR = path.join(__dirname, 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'dashboard.html'));
});

// ===== CLIENT LOGIN ROUTES =====
app.get('/client/login', (req, res) => {
    if (isClientSession(req)) return res.redirect('/client');
    res.sendFile(path.join(FRONTEND_DIR, 'client-login.html'));
});

app.post('/client/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    try {
        const user = db.prepare('SELECT * FROM client_users WHERE username = ? AND is_active = 1').get(username);
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const companyIds = db.prepare('SELECT company_id FROM client_company_access WHERE client_id = ?')
            .all(user.id).map(r => r.company_id);
        const features = JSON.parse(user.features || '{}');
        req.session.clientUser = { id: user.id, username: user.username, displayName: user.display_name, companyIds, features };
        res.json({ success: true, displayName: user.display_name || user.username });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.all('/client/logout', (req, res) => {
    req.session.destroy();
    if (req.method === 'POST') return res.json({ success: true });
    res.redirect('/client/login');
});

app.get('/client', (req, res) => {
    if (!isClientSession(req)) return res.redirect('/client/login');
    // Serve same dashboard.html with role injection
    const html = fs.readFileSync(path.join(FRONTEND_DIR, 'dashboard.html'), 'utf-8');
    const clientData = req.session.clientUser;
    const inject = `<script>window.TV_ROLE='client';window.TV_CLIENT_COMPANIES=${JSON.stringify(clientData.companyIds)};window.TV_CLIENT_NAME=${JSON.stringify(clientData.displayName || clientData.username)};window.TV_CLIENT_FEATURES=${JSON.stringify(clientData.features || {})};</script>`;
    res.send(html.replace('<!-- TV_ROLE_INJECT -->', inject));
});

// Block all write API calls from client sessions
app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && isClientSession(req)) {
        return res.status(403).json({ error: 'Read-only access' });
    }
    next();
});

// Initialize database — per-client architecture
const dbManager = new DbManager(DB_DIR);
const masterDb = dbManager.getMasterDb();

/**
 * Request-local client DB. Set by middleware before each handler.
 * All existing `db.prepare(...)` calls are routed through a Proxy that
 * sends client-table queries to _activeClientDb and master-table queries to masterDb.
 * Since Node.js is single-threaded and better-sqlite3 is synchronous, this is safe.
 */
let _activeClientDb = null;

// Tables that live in client DBs (used for query routing)
const CLIENT_TABLE_NAMES = new Set([
    'account_groups', 'ledgers', 'trial_balance', 'profit_loss', 'balance_sheet',
    'vouchers', 'stock_summary', 'stock_item_ledger', 'bills_outstanding',
    'cost_centres', 'cost_allocations', 'gst_entries', 'payroll_entries', 'sync_log',
    'excel_uploads', 'excel_data', 'upload_categories',
    'budgets', 'allocation_rules',
]);

/** Check if a SQL query targets a client table */
function _isClientQuery(sql) {
    const normalized = sql.toLowerCase().replace(/[\r\n]+/g, ' ');
    for (const t of CLIENT_TABLE_NAMES) {
        // Match table name after FROM, INTO, UPDATE, JOIN, or table name at start
        if (normalized.includes(t)) return true;
    }
    return false;
}

/**
 * Smart DB proxy: routes queries to masterDb or _activeClientDb based on table names.
 * This allows ALL existing `db.prepare(...)` calls to work unchanged.
 */
const db = new Proxy(masterDb, {
    get(target, prop) {
        if (prop === 'prepare') {
            return function(sql) {
                const useClient = _isClientQuery(sql) && _activeClientDb;
                return useClient ? _activeClientDb.prepare(sql) : masterDb.prepare(sql);
            };
        }
        if (prop === 'exec') {
            return function(sql) {
                const useClient = _isClientQuery(sql) && _activeClientDb;
                return useClient ? _activeClientDb.exec(sql) : masterDb.exec(sql);
            };
        }
        if (prop === 'transaction') {
            return function(fn) {
                // Transactions go to the active client DB if one is set
                const target = _activeClientDb || masterDb;
                return target.transaction(fn);
            };
        }
        if (prop === 'pragma') {
            return function(...args) { return masterDb.pragma(...args); };
        }
        // For any other property, return from masterDb
        const val = masterDb[prop];
        return typeof val === 'function' ? val.bind(masterDb) : val;
    }
});

/**
 * Middleware: resolve and set the active client DB for each API request.
 * Must run BEFORE any handler that touches client data.
 */
app.use('/api', (req, res, next) => {
    _activeClientDb = null; // reset
    const groupId = Number(req.query.groupId || req.body?.groupId);
    if (groupId) {
        _activeClientDb = dbManager.getClientDb(groupId);
        return next();
    }
    const companyId = Number(req.query.companyId || req.body?.companyId);
    if (companyId) {
        _activeClientDb = dbManager.resolveDbForCompany(companyId);
        return next();
    }
    const csvIds = req.query.companyIds || req.body?.companyIds;
    if (csvIds) {
        const first = Number(String(csvIds).split(',')[0]);
        if (first) _activeClientDb = dbManager.resolveDbForCompany(first);
    }
    next();
});

/**
 * Get the correct client DB for a request (explicit, for cases like sync).
 */
function getClientDb(req) {
    const groupId = Number(req.query.groupId || req.body?.groupId);
    if (groupId) return dbManager.getClientDb(groupId);
    const companyId = Number(req.query.companyId || req.body?.companyId);
    if (companyId) return dbManager.resolveDbForCompany(companyId);
    return _activeClientDb || masterDb;
}

function getClientDbForGroup(groupId) {
    return dbManager.getClientDb(groupId);
}

// File upload setup
const UPLOAD_DIR = path.join(DB_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const uploadTemp = path.join(UPLOAD_DIR, '_temp');
if (!fs.existsSync(uploadTemp)) fs.mkdirSync(uploadTemp, { recursive: true });
const upload = multer({
    dest: uploadTemp,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.xlsx', '.xls'].includes(ext)) cb(null, true);
        else cb(new Error('Only .xlsx and .xls files are allowed'));
    }
});

// State
let syncInProgress = false;
let syncProgress = null;

// Helper: get/set setting
function getSetting(key) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : null;
}
function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, new Date().toISOString());
}

// ============================================================
//  DYNAMIC TB ENGINE (Optimized - in-memory lookups)
// ============================================================

// ============================================================
//  MULTI-COMPANY ID HELPERS
// ============================================================

/** Build SQL placeholder string for an array of IDs: [1,2,3] → "?,?,?" */
function idPh(ids) { return ids.map(() => '?').join(','); }

/**
 * Resolve company IDs from geographic filters.
 * Any omitted/empty filter is treated as "All" for that dimension.
 * Optional allowedIds: pre-filter to intersect with (used for group+geo intersection).
 */
function resolveCompanyIds(state, city, location, type, allowedIds = null) {
    let q = 'SELECT id FROM companies WHERE is_active = 1';
    const params = [];
    if (allowedIds?.length) {
        q += ` AND id IN (${allowedIds.map(() => '?').join(',')})`;
        params.push(...allowedIds);
    }
    if (state)    { q += ' AND state = ?';       params.push(state); }
    if (city)     { q += ' AND city = ?';        params.push(city); }
    if (location) { q += ' AND location = ?';    params.push(location); }
    if (type && type !== 'All') { q += ' AND entity_type = ?'; params.push(type); }
    return db.prepare(q).all(...params).map(r => r.id);
}

/**
 * Resolve active company IDs belonging to a group.
 * Returns array of IDs or null if group doesn't exist / has no active members.
 */
function resolveGroupMemberIds(groupId) {
    const rows = db.prepare(
        `SELECT cgm.company_id FROM company_group_members cgm
         JOIN companies c ON c.id = cgm.company_id
         WHERE cgm.group_id = ? AND c.is_active = 1`
    ).all(groupId);
    return rows.length ? rows.map(r => r.company_id) : null;
}

/**
 * Extract array of company IDs from a request.
 * Priority: groupId (+ optional geo intersection) > companyIds (CSV) > companyId > geographic filters
 * Returns null if no usable filter found.
 */
function resolveIds(req) {
    const { groupId, companyId, companyIds, state, city, location, type } = req.query;

    let ids = null;
    if (groupId) {
        const groupMemberIds = resolveGroupMemberIds(Number(groupId));
        if (!groupMemberIds) return null;
        const hasActiveGeoFilter = (state && state !== '') || (city && city !== '') || (location && location !== '') || (type && type !== 'All' && type !== '');
        if (hasActiveGeoFilter) {
            const filtered = resolveCompanyIds(state || '', city || '', location || '', type || 'All', groupMemberIds);
            ids = filtered.length ? filtered : [-1]; // -1 = no match → empty results (don't fall back to all)
        } else {
            ids = groupMemberIds;
        }
    } else if (companyIds) {
        ids = companyIds.split(',').map(Number).filter(Boolean);
    } else if (companyId) {
        ids = [Number(companyId)];
    } else if (state !== undefined || city !== undefined || location !== undefined || type !== undefined) {
        const resolved = resolveCompanyIds(state || '', city || '', location || '', type || 'All');
        ids = resolved.length ? resolved : null;
    }

    // Client access control: intersect with allowed company IDs
    if (ids && req && req.session && req.session.clientUser) {
        const allowed = new Set(req.session.clientUser.companyIds);
        ids = ids.filter(id => allowed.has(id));
        if (!ids.length) return null;
    }

    return ids;
}

// ============================================================
//  DYNAMIC TB ENGINE (Optimized - in-memory lookups)
// ============================================================

// ── Date helpers for CFO Insights ──
function startOfMonth(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function endOfMonth(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
function subtractMonth(dateStr, n) {
    const [y, m] = dateStr.split('-').map(Number);
    let nm = m - n;
    let ny = y;
    while (nm < 1) { nm += 12; ny--; }
    while (nm > 12) { nm -= 12; ny++; }
    return `${ny}-${String(nm).padStart(2, '0')}-01`;
}
function subtractYear(dateStr, n) {
    const [y, m, d] = dateStr.split('-');
    return `${Number(y) - n}-${m}-${d}`;
}
function getYTDStart(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const m = d.getMonth(); // 0-based
    const y = m >= 3 ? d.getFullYear() : d.getFullYear() - 1; // FY starts April
    return `${y}-04-01`;
}

function monthLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/**
 * Get all child groups of a parent (recursive tree walk)
 */
function getGroupTree(ids, parentName) {
    const allGroups = db.prepare(`SELECT DISTINCT group_name, parent_group FROM account_groups WHERE company_id IN (${idPh(ids)})`).all(...ids);
    const result = new Set([parentName]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const g of allGroups) {
            if (result.has(g.parent_group) && !result.has(g.group_name)) {
                result.add(g.group_name);
                changed = true;
            }
        }
    }
    return [...result];
}

/**
 * Build ledger_name → group_name map from trial_balance (fast, ~8ms)
 */
function buildLedgerGroupMap(ids) {
    const rows = db.prepare(`SELECT DISTINCT company_id, ledger_name, group_name FROM trial_balance WHERE company_id IN (${idPh(ids)})`).all(...ids);
    const map = {};
    rows.forEach(r => { map[`${r.company_id}|${r.ledger_name}`] = r.group_name; });
    return map;
}

/**
 * Build P&L group sets using account_groups metadata fields.
 * Catches ALL groups including custom ones not descended from standard Tally names.
 * directCredit  = (PL, C, Y) → Sales Accounts + Direct Incomes + custom
 * directDebit   = (PL, D, Y) → Purchase Accounts + Direct Expenses + custom
 * indirectCredit= (PL, C, N) → Indirect Incomes + custom
 * indirectDebit = (PL, D, N) → Indirect Expenses + custom
 */
function buildPLGroupSets(ids) {
    // FIX: Use majority-vote to resolve conflicts when the same group_name has
    // different (dr_cr, affects_gross_profit) across companies — prevents double-counting
    const groups = db.prepare(
        `SELECT group_name, dr_cr, affects_gross_profit, COUNT(*) as cnt
         FROM account_groups WHERE company_id IN (${idPh(ids)}) AND bs_pl = 'PL'
         GROUP BY group_name, dr_cr, affects_gross_profit`
    ).all(...ids);
    // For each group_name, pick the classification with the highest company count
    const best = {};
    for (const g of groups) {
        if (!best[g.group_name] || g.cnt > best[g.group_name].cnt) {
            best[g.group_name] = g;
        }
    }
    const sets = { directCredit: new Set(), indirectCredit: new Set(), directDebit: new Set(), indirectDebit: new Set() };
    for (const g of Object.values(best)) {
        if      (g.dr_cr === 'C' && g.affects_gross_profit === 'Y') sets.directCredit.add(g.group_name);
        else if (g.dr_cr === 'C' && g.affects_gross_profit === 'N') sets.indirectCredit.add(g.group_name);
        else if (g.dr_cr === 'D' && g.affects_gross_profit === 'Y') sets.directDebit.add(g.group_name);
        else if (g.dr_cr === 'D' && g.affects_gross_profit === 'N') sets.indirectDebit.add(g.group_name);
    }
    return sets;
}

/**
 * FIX-19/FIX-20: TB supplement for P&L ledgers.
 * Returns rows { ledger_name, group_name, net_debit, net_credit } for ALL P&L ledgers
 * found in the trial_balance for [from, to].
 *
 * Caller uses these rows to compute top-up adjustments:
 *   - For zero-voucher ledgers: full TB net is added
 *   - For with-voucher ledgers: only the gap (TB net − voucher contribution) is added
 *   See the TB top-up loop in the KPI handler (/api/dashboard/kpi) for the hybrid formula.
 *
 * FIX-20: April-anomaly guard — if the DB still has stale April data (full-year values
 * FIX-20: TB extraction now uses monthly chunks (generateMonthChunks) with blanket
 * DELETE on force resync, so April data is always correct per-month values.
 * The old isFullFY guard has been removed — all date ranges are safe post-resync.
 */
function getTBSupplement(ids, from, to) {
    // FIX-MULTI: include company_id in GROUP BY so colliding ledger names across companies
    // each retain their own group classification — no resultMap collapse needed.
    return db.prepare(`
        SELECT company_id, ledger_name, group_name,
               SUM(net_debit)  AS net_debit,
               SUM(net_credit) AS net_credit
        FROM trial_balance t
        WHERE company_id IN (${idPh(ids)})
          AND period_from >= ?
          AND period_to   <= ?
          AND group_name IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
        GROUP BY company_id, ledger_name, group_name
    `).all(...ids, from, to);
}

/**
 * FIX-PL: Fallback to profit_loss table when voucher+TB yields near-zero P&L.
 * The profit_loss table is synced directly from Tally's P&L report and contains
 * ledger-level data. Sign convention: positive = credit (revenue), negative = debit (expense).
 * NOTE: The table may also contain BS items — caller must filter by P&L group sets.
 */
function getPLFallback(ids, from, to) {
    return db.prepare(`
        SELECT company_id, ledger_name, group_name, SUM(amount) as amount
        FROM profit_loss
        WHERE company_id IN (${idPh(ids)})
          AND period_from >= ?
          AND period_to   <= ?
          AND group_name IS NOT NULL
        GROUP BY company_id, ledger_name, group_name
    `).all(...ids, from, to);
}

/**
 * Get voucher totals grouped by ledger for a date range (fast, ~15ms, no JOINs)
 */
function getVouchersByLedger(ids, fromDate, toDate) {
    return db.prepare(`
        SELECT company_id, ledger_name, SUM(amount) as total
        FROM vouchers
        WHERE company_id IN (${idPh(ids)}) AND date >= ? AND date <= ? AND ledger_name != ''
        GROUP BY company_id, ledger_name
    `).all(...ids, fromDate, toDate);
}

/**
 * TB-based ledger flows: complete data for ALL companies including those
 * where vouchers only record party/bank side (e.g. Pharma).
 * Returns same format as getVouchersByLedger for drop-in use in charts.
 */
function getLedgerFlowsTB(ids, fromDate, toDate) {
    return db.prepare(`
        SELECT company_id, ledger_name,
               SUM(net_credit) - SUM(net_debit) as total
        FROM trial_balance t
        WHERE company_id IN (${idPh(ids)})
          AND period_from >= ? AND period_to <= ?
          AND group_name IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
        GROUP BY company_id, ledger_name
    `).all(...ids, fromDate, toDate);
}

/**
 * P&L Flow: Sum voucher amounts for ledgers belonging to target groups
 * Uses in-memory map instead of SQL JOIN
 */
function computePLFlow(vouchersByLedger, lgMap, groupSet) {
    let total = 0;
    for (const row of vouchersByLedger) {
        const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
        if (grp && groupSet.has(grp)) {
            total += row.total;
        }
    }
    return total;
}

/**
 * BS Closing Balance: TB opening + voucher movements up to asOfDate
 * Uses in-memory map, no JOINs
 */
function computeBSClosing(ids, asOfDate, groupNames, balanceFilter, lgMap) {
    if (!groupNames.length) return 0;
    const groupSet = new Set(groupNames);
    const grPh = groupNames.map(() => '?').join(',');

    // Find the TB month containing/preceding asOfDate (across all selected companies)
    const tbMonth = db.prepare(`
        SELECT DISTINCT period_from, period_to FROM trial_balance
        WHERE company_id IN (${idPh(ids)}) AND period_from <= ?
        ORDER BY period_from DESC LIMIT 1
    `).get(...ids, asOfDate);

    if (!tbMonth) return 0;

    // Get TB opening balances for target groups
    const tbRows = db.prepare(`
        SELECT ledger_name, SUM(opening_balance) as opening_balance FROM trial_balance
        WHERE company_id IN (${idPh(ids)}) AND period_from = ? AND group_name IN (${grPh})
        GROUP BY ledger_name
    `).all(...ids, tbMonth.period_from, ...groupNames);

    // Get voucher movements (no JOIN - simple query)
    const vRows = db.prepare(`
        SELECT company_id, ledger_name, SUM(amount) as movement
        FROM vouchers
        WHERE company_id IN (${idPh(ids)}) AND date >= ? AND date <= ? AND ledger_name != ''
        GROUP BY company_id, ledger_name
    `).all(...ids, tbMonth.period_from, asOfDate);

    // Filter voucher rows to target groups using in-memory map (company-aware key)
    // movementMap stays ledger_name-keyed to match tbRows GROUP BY ledger_name
    const movementMap = {};
    for (const r of vRows) {
        const grp = lgMap[`${r.company_id}|${r.ledger_name}`];
        if (grp && groupSet.has(grp)) {
            movementMap[r.ledger_name] = (movementMap[r.ledger_name] || 0) + r.movement;
        }
    }

    // Compute per-ledger closing
    let total = 0;
    const ledgersSeen = new Set();

    for (const r of tbRows) {
        ledgersSeen.add(r.ledger_name);
        const closing = r.opening_balance + (movementMap[r.ledger_name] || 0);
        if (balanceFilter === 'debit' && closing < 0) total += closing;
        else if (balanceFilter === 'credit' && closing > 0) total += closing;
        else if (!balanceFilter) total += closing;
    }

    // Voucher-only ledgers (in target groups but no TB row)
    for (const [ledger, movement] of Object.entries(movementMap)) {
        if (!ledgersSeen.has(ledger)) {
            if (balanceFilter === 'debit' && movement < 0) total += movement;
            else if (balanceFilter === 'credit' && movement > 0) total += movement;
            else if (!balanceFilter) total += movement;
        }
    }

    return total;
}

/**
 * Get top ledgers by amount for specific groups (for bar charts)
 */
function getTopLedgers(vouchersByLedger, lgMap, groupSet, limit, negate) {
    // Aggregate across companies by exact ledger_name + same group
    const merged = {};
    for (const row of vouchersByLedger) {
        const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
        if (grp && groupSet.has(grp)) {
            const val = negate ? -row.total : row.total;
            if (val > 0) {
                const key = `${grp}||${row.ledger_name}`;
                if (!merged[key]) {
                    merged[key] = { ledger_name: row.ledger_name, group_name: grp, total: 0 };
                }
                merged[key].total += val;
            }
        }
    }
    const results = Object.values(merged);
    results.sort((a, b) => b.total - a.total);
    return results.slice(0, limit || 10);
}

/**
 * Get totals by group (for pie charts)
 */
function getTotalsByGroup(vouchersByLedger, lgMap, groupSet, negate) {
    const groupTotals = {};
    for (const row of vouchersByLedger) {
        const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
        if (grp && groupSet.has(grp)) {
            groupTotals[grp] = (groupTotals[grp] || 0) + row.total;
        }
    }
    const results = [];
    for (const [category, total] of Object.entries(groupTotals)) {
        const val = negate ? -total : total;
        if (val > 0) results.push({ category, total: val });
    }
    results.sort((a, b) => b.total - a.total);
    return results;
}

/**
 * Get monthly breakdown from vouchers (for trend charts)
 */
function getMonthlyVouchers(ids, fromDate, toDate) {
    return db.prepare(`
        SELECT company_id, strftime('%Y-%m-01', date) as month, ledger_name, SUM(amount) as total
        FROM vouchers
        WHERE company_id IN (${idPh(ids)}) AND date >= ? AND date <= ? AND ledger_name != ''
        GROUP BY company_id, strftime('%Y-%m', date), ledger_name
    `).all(...ids, fromDate, toDate);
}

/**
 * TB-based monthly breakdown: complete data for ALL companies.
 * Returns same format as getMonthlyVouchers for drop-in use in KPI card trends.
 */
function getMonthlyFlowsTB(ids, fromDate, toDate) {
    return db.prepare(`
        SELECT company_id, period_from as month, ledger_name,
               SUM(net_credit) - SUM(net_debit) as total
        FROM trial_balance t
        WHERE company_id IN (${idPh(ids)})
          AND period_from >= ? AND period_to <= ?
          AND group_name IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
        GROUP BY company_id, period_from, ledger_name
    `).all(...ids, fromDate, toDate);
}


// ===== HEALTH & STATUS =====

app.get('/api/status', async (req, res) => {
    const host = getSetting('tally_host') || 'localhost';
    const port = parseInt(getSetting('tally_port') || '9000');
    const tally = new TallyConnector({ host, port });
    const health = await tally.healthCheck();
    const companies = db.prepare('SELECT * FROM companies WHERE is_active = 1 ORDER BY last_full_sync_at DESC').all();
    res.json({
        tally: health,
        database: { path: getDbPath(), companies },
        sync: { inProgress: syncInProgress, progress: syncProgress }
    });
});

// ===== TALLY CONNECTION =====

app.post('/api/tally/connect', async (req, res) => {
    const { host, port } = req.body;
    if (host) setSetting('tally_host', host);
    if (port) setSetting('tally_port', String(port));
    const tally = new TallyConnector({ host: host || getSetting('tally_host'), port: port || parseInt(getSetting('tally_port')) });
    const health = await tally.healthCheck();
    res.json(health);
});

app.get('/api/tally/companies', async (req, res) => {
    try {
        const host = getSetting('tally_host') || 'localhost';
        const port = parseInt(getSetting('tally_port') || '9000');
        const tally = new TallyConnector({ host, port });
        const companies = await tally.getCompanies();
        res.json({ companies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Enriched companies: Tally list cross-referenced with DB sync status
app.get('/api/tally/companies-enriched', async (req, res) => {
    try {
        const host = getSetting('tally_host') || 'localhost';
        const port = parseInt(getSetting('tally_port') || '9000');
        const tally = new TallyConnector({ host, port });
        const tallyCompanies = await tally.getCompanies();

        // Build a map of DB companies by name
        const dbRows = db.prepare('SELECT id, name, last_full_sync_at, sync_from_date, sync_to_date, state, city, location, entity_type FROM companies WHERE is_active=1').all();
        const dbMap = new Map();
        for (const r of dbRows) dbMap.set(r.name, r);

        const enriched = tallyCompanies.map(tc => {
            const dbRec = dbMap.get(tc.name) || {};
            return {
                name: tc.name,
                fyFrom: tc.fyFrom,
                fyTo: tc.fyTo,
                dbCompanyId: dbRec.id || null,
                lastFullSyncAt: dbRec.last_full_sync_at || null,
                syncFromDate: dbRec.sync_from_date || null,
                syncToDate: dbRec.sync_to_date || null,
                state: dbRec.state || '',
                city: dbRec.city || '',
                location: dbRec.location || '',
                entity_type: dbRec.entity_type || ''
            };
        });
        res.json({ companies: enriched });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== SYNC MANAGEMENT =====

app.post('/api/sync/start', async (req, res) => {
    if (syncInProgress) return res.status(409).json({ error: 'Sync already in progress' });

    const { companyName, fromDate, toDate, forceResync, state, city, location, entity_type } = req.body;
    if (!companyName || !fromDate || !toDate) {
        return res.status(400).json({ error: 'companyName, fromDate, toDate required' });
    }

    db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)').run(companyName);
    // Save geographic metadata — only overwrite non-empty values; preserve existing when blank/missing
    const existing = db.prepare('SELECT state, city, location, entity_type FROM companies WHERE name=?').get(companyName) || {};
    db.prepare('UPDATE companies SET state=?, city=?, location=?, entity_type=? WHERE name=?')
        .run(state || existing.state || '', city || existing.city || '', location || existing.location || '', entity_type || existing.entity_type || '', companyName);
    const company = db.prepare('SELECT * FROM companies WHERE name = ?').get(companyName);

    syncInProgress = true;
    syncProgress = { step: 'init', status: 'running', message: 'Starting...' };

    const host = getSetting('tally_host') || 'localhost';
    const port = parseInt(getSetting('tally_port') || '9000');

    // Pass the actual client DB (not the Proxy) to DataExtractor.
    // This avoids async routing issues — _activeClientDb could change during await.
    const clientDb = dbManager.resolveDbForCompany(company.id);
    const extractor = new DataExtractor(clientDb, {
        host, port,
        onProgress: (p) => { syncProgress = p; }
    });

    // Pre-flight check — fail fast if Tally is not reachable
    const alive = await extractor.tally.ping();
    if (!alive) {
        syncInProgress = false;
        return res.status(503).json({
            error: `Tally is not reachable at ${host}:${port}. Please open Tally Prime and try again.`
        });
    }

    // Read per-company sync modules (optional features)
    const syncModules = JSON.parse(company.sync_modules || '{}');

    extractor.runFullSync(company.id, companyName, fromDate, toDate, { forceResync: !!forceResync, syncModules })
        .then(results => {
            // Update companies table in masterDb (not clientDb — companies is a master table)
            if (results.success) {
                masterDb.prepare('UPDATE companies SET last_full_sync_at=?, sync_from_date=?, sync_to_date=? WHERE id=?')
                    .run(new Date().toISOString(), fromDate, toDate, company.id);
            }
            syncInProgress = false;
            syncProgress = { step: 'complete', status: 'done', results };
        })
        .catch(err => {
            syncInProgress = false;
            syncProgress = { step: 'error', status: 'error', message: err.message };
        });

    res.json({ message: 'Sync started', companyId: company.id });
});

app.get('/api/sync/progress', (req, res) => {
    res.json({ inProgress: syncInProgress, progress: syncProgress });
});

app.get('/api/sync/log', (req, res) => {
    const companyId = req.query.companyId || 1;
    const logs = db.prepare('SELECT * FROM sync_log WHERE company_id = ? ORDER BY id DESC LIMIT 100').all(companyId);
    res.json(logs);
});

// ===== DASHBOARD DATA API =====

app.get('/api/companies', (req, res) => {
    const companies = db.prepare('SELECT * FROM companies WHERE is_active = 1 ORDER BY last_full_sync_at DESC').all();
    res.json(companies);
});

// ===== GEOGRAPHIC FILTER DISCOVERY =====

app.get('/api/filters/states', (req, res) => {
    const { groupId } = req.query;
    const groupIds = groupId ? resolveGroupMemberIds(Number(groupId)) : null;
    let q = "SELECT DISTINCT state FROM companies WHERE is_active = 1 AND state != ''";
    const params = [];
    if (groupIds?.length) { q += ` AND id IN (${groupIds.map(() => '?').join(',')})`; params.push(...groupIds); }
    q += ' ORDER BY state';
    res.json(db.prepare(q).all(...params).map(r => r.state));
});

app.get('/api/filters/cities', (req, res) => {
    const { state, groupId } = req.query;
    const groupIds = groupId ? resolveGroupMemberIds(Number(groupId)) : null;
    let q = "SELECT DISTINCT city FROM companies WHERE is_active = 1 AND city != ''";
    const params = [];
    if (groupIds?.length) { q += ` AND id IN (${groupIds.map(() => '?').join(',')})`; params.push(...groupIds); }
    if (state) { q += ' AND state = ?'; params.push(state); }
    q += ' ORDER BY city';
    res.json(db.prepare(q).all(...params).map(r => r.city));
});

app.get('/api/filters/locations', (req, res) => {
    const { state, city, groupId } = req.query;
    const groupIds = groupId ? resolveGroupMemberIds(Number(groupId)) : null;
    let q = "SELECT DISTINCT location FROM companies WHERE is_active = 1 AND location != ''";
    const params = [];
    if (groupIds?.length) { q += ` AND id IN (${groupIds.map(() => '?').join(',')})`; params.push(...groupIds); }
    if (state) { q += ' AND state = ?'; params.push(state); }
    if (city)  { q += ' AND city = ?';  params.push(city); }
    q += ' ORDER BY location';
    res.json(db.prepare(q).all(...params).map(r => r.location));
});

app.get('/api/filters/types', (req, res) => {
    const { state, city, location, groupId } = req.query;
    const groupIds = groupId ? resolveGroupMemberIds(Number(groupId)) : null;
    let q = "SELECT DISTINCT entity_type FROM companies WHERE is_active = 1 AND entity_type != ''";
    const params = [];
    if (groupIds?.length) { q += ` AND id IN (${groupIds.map(() => '?').join(',')})`; params.push(...groupIds); }
    if (state)    { q += ' AND state = ?';    params.push(state); }
    if (city)     { q += ' AND city = ?';     params.push(city); }
    if (location) { q += ' AND location = ?'; params.push(location); }
    q += ' ORDER BY entity_type';
    res.json(db.prepare(q).all(...params).map(r => r.entity_type));
});

// ===== SHARED KPI COMPUTATION =====
function computeKPIData(ids, from, to) {
    // Build in-memory lookups
    const lgMap = buildLedgerGroupMap(ids);
    const vByLedger = getVouchersByLedger(ids, from, to);

    // Metadata-based sets: catch ALL P&L groups including custom ones (FIX-18)
    const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(ids);
    // Standard reserved groups for individual card display
    const salesSet    = new Set(getGroupTree(ids, 'Sales Accounts'));
    const purchaseSet = new Set(getGroupTree(ids, 'Purchase Accounts'));

    // Primary: voucher-based P&L flows (trusted, no anomalies)
    const salesFlow    = computePLFlow(vByLedger, lgMap, salesSet);
    const purchaseFlow = computePLFlow(vByLedger, lgMap, purchaseSet);
    let allDCFlow      = computePLFlow(vByLedger, lgMap, directCredit);
    let allDDFlow      = computePLFlow(vByLedger, lgMap, directDebit);
    let allICFlow      = computePLFlow(vByLedger, lgMap, indirectCredit);
    let allIDFlow      = computePLFlow(vByLedger, lgMap, indirectDebit);

    // FIX-19: Hybrid TB top-up
    const voucherMap = new Map(vByLedger.map(r => [`${r.company_id}|${r.ledger_name}`, r.total]));
    const tbSupp = getTBSupplement(ids, from, to);
    for (const r of tbSupp) {
        if (!r.group_name) continue;
        const dr = r.net_debit  || 0;
        const cr = r.net_credit || 0;
        const vs = voucherMap.get(`${r.company_id}|${r.ledger_name}`) || 0;
        if      (directDebit.has(r.group_name))    allDDFlow -= Math.max(0, (dr - cr) + vs);
        else if (directCredit.has(r.group_name))   allDCFlow += Math.max(0, (cr - dr) - vs);
        else if (indirectDebit.has(r.group_name))  allIDFlow -= Math.max(0, (dr - cr) + vs);
        else if (indirectCredit.has(r.group_name)) allICFlow += Math.max(0, (cr - dr) - vs);
    }

    // FIX-PL: Fallback to profit_loss table when TB supplement has no P&L data.
    // This handles companies where:
    //   - Vouchers only capture party-side ledgers (Sundry Debtors), not P&L (GST SALES)
    //   - Trial balance wasn't synced for the requested date range (e.g. multi-FY data loss)
    // Trigger: TB supplement returned 0 rows classified as P&L groups.
    // Partial voucher data (e.g. Sales Returns mapped via lgMap) gives a misleading non-zero
    // totalPLFlow, so we check TB supplement emptiness instead.
    let usedPLFallback = false;
    const tbSuppPLCount = tbSupp.filter(r => directCredit.has(r.group_name) || directDebit.has(r.group_name) ||
                                              indirectCredit.has(r.group_name) || indirectDebit.has(r.group_name)).length;
    if (tbSuppPLCount === 0) {
        const plRows = getPLFallback(ids, from, to);
        // Only use fallback if profit_loss has P&L-classified rows
        const plPLRows = plRows.filter(r => directCredit.has(r.group_name) || directDebit.has(r.group_name) ||
                                              indirectCredit.has(r.group_name) || indirectDebit.has(r.group_name));
        if (plPLRows.length > 0) {
            usedPLFallback = true;
            allDCFlow = 0; allDDFlow = 0; allICFlow = 0; allIDFlow = 0;
            for (const r of plPLRows) {
                const amt = r.amount || 0;
                // profit_loss sign: positive = credit (revenue/income), negative = debit (expense/purchase)
                if      (directCredit.has(r.group_name))   allDCFlow += amt;
                else if (directDebit.has(r.group_name))    allDDFlow += amt;
                else if (indirectCredit.has(r.group_name)) allICFlow += amt;
                else if (indirectDebit.has(r.group_name))  allIDFlow += amt;
            }
        }
    }

    // COGS FIX: Include stock movement in Gross Profit
    // FIX: Per-company aggregation — each company may have different TB sync dates;
    // a single MAX(period_to) across all companies can miss companies at earlier dates.
    const stockGroups = getGroupTree(ids, 'Stock-in-Hand');
    let openingStock = 0, closingStock = 0;

    if (stockGroups.length > 0) {
        const stockPh = stockGroups.map(() => '?').join(',');

        for (const cid of ids) {
            const firstPF = db.prepare(
                `SELECT MIN(period_from) as pf FROM trial_balance
                 WHERE company_id = ? AND group_name IN (${stockPh}) AND period_from >= ?`
            ).get(cid, ...stockGroups, from)?.pf;
            if (firstPF) {
                openingStock += db.prepare(
                    `SELECT SUM(opening_balance) as val FROM trial_balance
                     WHERE company_id = ? AND group_name IN (${stockPh}) AND period_from = ?`
                ).get(cid, ...stockGroups, firstPF)?.val || 0;
            }

            const lastPT = db.prepare(
                `SELECT MAX(period_to) as pt FROM trial_balance
                 WHERE company_id = ? AND group_name IN (${stockPh}) AND period_to <= ?`
            ).get(cid, ...stockGroups, to)?.pt;
            if (lastPT) {
                closingStock += db.prepare(
                    `SELECT SUM(closing_balance) as val FROM trial_balance
                     WHERE company_id = ? AND group_name IN (${stockPh}) AND period_to = ?`
                ).get(cid, ...stockGroups, lastPT)?.val || 0;
            }
        }
    }

    const stockAdjustment = openingStock - closingStock;
    const grossProfit = allDCFlow + allDDFlow + stockAdjustment;
    const netProfit   = grossProfit + allICFlow + allIDFlow;

    // TB-corrected salesFlow / purchaseFlow for individual card display
    let salesFlowFull    = salesFlow;
    let purchaseFlowFull = purchaseFlow;

    if (usedPLFallback) {
        // When using P&L fallback, derive sales/purchase from allDCFlow/allDDFlow
        salesFlowFull = 0; purchaseFlowFull = 0;
        const plRows = getPLFallback(ids, from, to);
        for (const r of plRows) {
            const amt = r.amount || 0;
            if (salesSet.has(r.group_name))    salesFlowFull += amt;
            else if (purchaseSet.has(r.group_name)) purchaseFlowFull += amt;
        }
    } else {
        for (const r of tbSupp) {
            if (!r.group_name) continue;
            const dr = r.net_debit  || 0;
            const cr = r.net_credit || 0;
            const vs = voucherMap.get(`${r.company_id}|${r.ledger_name}`) || 0;
            if (salesSet.has(r.group_name)) {
                salesFlowFull += Math.max(0, (cr - dr) - vs);
                salesFlowFull -= Math.max(0, (dr - cr) + vs);
            } else if (purchaseSet.has(r.group_name)) {
                purchaseFlowFull -= Math.max(0, (dr - cr) + vs);
                purchaseFlowFull += Math.max(0, (cr - dr) - vs);
            }
        }
    }

    // Card display values (positive amounts)
    const rev            = salesFlowFull;
    const purchaseVal    = -purchaseFlowFull;
    const directExpVal   = -(allDDFlow - purchaseFlowFull);
    const indirectExpVal = -allIDFlow;
    const indirectIncVal = allICFlow;
    const directIncVal   = allDCFlow - salesFlowFull;

    // BS KPIs (closing balance as of toDate)
    const sdGroups       = getGroupTree(ids, 'Sundry Debtors');
    const scGroups       = getGroupTree(ids, 'Sundry Creditors');
    const cashGroups     = getGroupTree(ids, 'Cash-in-Hand');
    const bankGroups     = getGroupTree(ids, 'Bank Accounts');
    const securedGroups  = getGroupTree(ids, 'Secured Loans');
    const unsecuredGroups= getGroupTree(ids, 'Unsecured Loans');

    const sdDebit = computeBSClosing(ids, to, sdGroups, 'debit', lgMap);
    const scDebit = computeBSClosing(ids, to, scGroups, 'debit', lgMap);
    const receivables = -(sdDebit + scDebit);

    const sdCredit = computeBSClosing(ids, to, sdGroups, 'credit', lgMap);
    const scCredit = computeBSClosing(ids, to, scGroups, 'credit', lgMap);
    const payables = sdCredit + scCredit;

    const cashBal = computeBSClosing(ids, to, cashGroups, null, lgMap);
    const bankBal = computeBSClosing(ids, to, bankGroups, null, lgMap);
    const cashBankBalance = -(cashBal + bankBal);

    const securedBal   = computeBSClosing(ids, to, securedGroups, null, lgMap);
    const unsecuredBal = computeBSClosing(ids, to, unsecuredGroups, null, lgMap);
    const loans = securedBal + unsecuredBal;

    return {
        revenue: rev,
        directIncome: directIncVal,
        purchase: purchaseVal,
        directExpenses: directExpVal,
        indirectExpenses: indirectExpVal,
        indirectIncome: indirectIncVal,
        openingStock: Math.abs(openingStock),
        closingStock: Math.abs(closingStock),
        grossProfit,
        netProfit,
        receivables,
        payables,
        cashBankBalance,
        loans,
        period: { from, to }
    };
}

// ===== ALLOCATION-ADJUSTED KPI =====
// Computes per-company KPIs, applies dashboard-affecting allocation rules,
// then re-consolidates into a single KPI object.
function applyDashboardAllocations(ids, groupId, from, to) {
    // Check if any dashboard-affecting rules exist for this group
    let dashRules;
    try {
        dashRules = db.prepare(
            'SELECT * FROM allocation_rules WHERE group_id = ? AND is_active = 1 AND affects_dashboard = 1 ORDER BY sort_order'
        ).all(groupId);
    } catch (e) { return null; } // column may not exist yet

    if (!dashRules || !dashRules.length) return null;

    // Compute per-company KPIs
    const units = ids.map(cid => {
        const kpi = computeKPIData([cid], from, to);
        return { companyId: cid, ...kpi };
    });

    // Apply each dashboard-affecting rule (effective period + amount handled inside)
    for (const rule of dashRules) {
        const config = JSON.parse(rule.config || '{}');
        applyAllocationRule(units, rule.rule_type, config, from, to);
    }

    // Allocations only affect indirectExpenses/indirectIncome — GP is unchanged
    units.forEach(u => {
        u.netProfit = (u.grossProfit || 0) + (u.indirectIncome || 0) - (u.indirectExpenses || 0);
    });

    // Consolidate
    const sum = (key) => units.reduce((s, u) => s + (u[key] || 0), 0);
    return {
        revenue: sum('revenue'),
        directIncome: sum('directIncome'),
        purchase: sum('purchase'),
        directExpenses: sum('directExpenses'),
        indirectExpenses: sum('indirectExpenses'),
        indirectIncome: sum('indirectIncome'),
        openingStock: sum('openingStock'),
        closingStock: sum('closingStock'),
        grossProfit: sum('grossProfit'),
        netProfit: sum('netProfit'),
        receivables: sum('receivables'),
        payables: sum('payables'),
        cashBankBalance: sum('cashBankBalance'),
        loans: sum('loans'),
        period: units[0]?.period,
        _allocationsApplied: true,
    };
}

// Helper: get active dashboard-affecting allocation rules for a group
function getDashboardAllocRules(groupId) {
    try {
        const rules = db.prepare(
            'SELECT * FROM allocation_rules WHERE group_id = ? AND is_active = 1 AND affects_dashboard = 1 ORDER BY sort_order'
        ).all(groupId);
        return (rules && rules.length) ? rules : null;
    } catch (e) { return null; }
}

// Helper: get active dashboard-affecting writeoff rules for a group
function getDashboardWriteoffRules(groupId) {
    try {
        const rules = db.prepare(
            'SELECT * FROM writeoff_rules WHERE group_id = ? AND is_active = 1 AND affects_dashboard = 1 ORDER BY sort_order'
        ).all(groupId);
        return (rules && rules.length) ? rules : null;
    } catch (e) { return null; }
}

// Resolve the effective writeoff amount for a rule + company + date range
function resolveWriteoffAmount(rule, companyId, ledgerNames, from, to) {
    const config = JSON.parse(rule.config || '{}');
    const mode = config.amount_mode || 'full';

    if (mode === 'fixed') {
        let amt, freq, effectiveConfig;

        // Per-company overrides
        if (config.company_overrides) {
            const ov = config.company_overrides[String(companyId)];
            if (!ov) return 0; // Company not in overrides
            amt = Number(ov.amount) || 0;
            freq = config.fixed_freq || 'total';
            effectiveConfig = { effective_from: ov.effective_from || '', effective_to: ov.effective_to || '' };
        } else {
            // Uniform / legacy
            amt = Number(config.fixed_amount) || 0;
            freq = config.fixed_freq || 'total';
            effectiveConfig = config;
        }

        // Check effective period overlap
        if (effectiveConfig.effective_from || effectiveConfig.effective_to) {
            const overlap = getEffectiveOverlap(effectiveConfig, from, to);
            if (!overlap.overlaps) return 0;
            return freq === 'per_month' ? amt * overlap.monthCount : amt;
        }

        // No effective period constraint
        if (freq === 'per_month') {
            const d1 = new Date(from), d2 = new Date(to);
            const months = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()) + 1;
            return amt * months;
        }
        return amt;
    }

    // Check effective period for non-fixed modes
    if (config.effective_from || config.effective_to) {
        const overlap = getEffectiveOverlap(config, from, to);
        if (!overlap.overlaps) return 0;
    }

    // For 'full' and 'percentage' modes, get the ledger balance first
    const ledgerAmt = Math.abs(getLedgerAmountMulti(companyId, ledgerNames, from, to));

    if (mode === 'percentage') {
        const pct = (Number(config.percentage) || 0) / 100;
        return ledgerAmt * pct;
    }

    // mode === 'full'
    return ledgerAmt;
}

// Apply writeoff rules to per-company KPI units
function applyWriteoffRulesToUnits(units, rules, from, to) {
    for (const rule of rules) {
        const ledgerNames = JSON.parse(rule.ledger_names || '[]');
        if (!ledgerNames.length) continue;
        const companyIds = JSON.parse(rule.company_ids || '[]');
        // Backward compat: old single company_id
        const targetIds = companyIds.length ? companyIds : (rule.company_id ? [rule.company_id] : []);

        for (const cid of targetIds) {
            const unit = units.find(u => u.companyId === cid);
            if (!unit) continue;

            const amt = resolveWriteoffAmount(rule, cid, ledgerNames, from, to);

            if (rule.rule_type === 'expense_addback') {
                unit.indirectExpenses = (unit.indirectExpenses || 0) - amt;
            } else if (rule.rule_type === 'income_deduction') {
                unit.indirectIncome = (unit.indirectIncome || 0) - amt;
            }
        }
    }
    // Recompute NP
    units.forEach(u => {
        u.netProfit = (u.grossProfit || 0) + (u.indirectIncome || 0) - (u.indirectExpenses || 0);
    });
}

// ===== KPI SUMMARY (Dynamic TB - Optimized) =====
app.get('/api/dashboard/kpi', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId, companyIds, or geographic filters required' });

    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    const kpi = computeKPIData(ids, from, to);

    // Apply dashboard-affecting allocation rules if a group is selected
    const groupId = Number(req.query.groupId);
    if (groupId && ids.length > 1) {
        const adjusted = applyDashboardAllocations(ids, groupId, from, to);
        if (adjusted) Object.assign(kpi, adjusted);
    }

    // Apply dashboard-affecting writeoff rules if a group is selected
    if (groupId) {
        const woRules = getDashboardWriteoffRules(groupId);
        if (woRules) {
            const units = ids.map(cid => {
                const k = computeKPIData([cid], from, to);
                return { companyId: cid, ...k };
            });
            // Apply allocations first if they exist (to get the same base as KPI)
            if (groupId && ids.length > 1) {
                const allocRules = getDashboardAllocRules(groupId);
                if (allocRules) applyAllocRulesToUnits(units, allocRules, from, to);
            }
            applyWriteoffRulesToUnits(units, woRules, from, to);
            const sum = (key) => units.reduce((s, u) => s + (u[key] || 0), 0);
            Object.assign(kpi, {
                indirectExpenses: sum('indirectExpenses'),
                indirectIncome: sum('indirectIncome'),
                netProfit: sum('netProfit'),
                _writeoffsApplied: true,
            });
        }
    }

    res.json(kpi);
});

// ===== Helper: apply allocations to a set of per-company units =====
function applyAllocRulesToUnits(units, rules, from, to) {
    for (const rule of rules) {
        const config = JSON.parse(rule.config || '{}');
        applyAllocationRule(units, rule.rule_type, config, from, to);
    }
    // Allocations only affect indirectExpenses/indirectIncome — GP is unchanged
    // Only recompute NP from the (unchanged) GP + adjusted indirect items
    units.forEach(u => {
        u.netProfit = (u.grossProfit || 0) + (u.indirectIncome || 0) - (u.indirectExpenses || 0);
    });
}

// ===== MONTHLY TREND (Optimized — uses shared computation) =====
app.get('/api/dashboard/monthly-trend', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId, companyIds, or geographic filters required' });

    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    const trend = computeMonthlyTrendData(ids, from, to);

    // Apply dashboard-affecting allocation rules per month
    const groupId = Number(req.query.groupId);
    if (groupId && ids.length > 1) {
        const rules = getDashboardAllocRules(groupId);
        if (rules) {
            for (const monthData of trend) {
                const mFrom = monthData.month;
                // Compute end of month (use local date parts to avoid UTC timezone shift)
                const d = new Date(mFrom + 'T00:00:00');
                const eom = new Date(d.getFullYear(), d.getMonth() + 1, 0);
                const mTo = `${eom.getFullYear()}-${String(eom.getMonth() + 1).padStart(2, '0')}-${String(eom.getDate()).padStart(2, '0')}`;

                // Build per-company KPIs for this single month
                const units = ids.map(cid => {
                    const kpi = computeKPIData([cid], mFrom, mTo);
                    return { companyId: cid, ...kpi };
                });

                // Snapshot pre-allocation totals
                const sumPre = (key) => units.reduce((s, u) => s + (u[key] || 0), 0);
                const preIndExp = sumPre('indirectExpenses');
                const preIndInc = sumPre('indirectIncome');

                applyAllocRulesToUnits(units, rules, mFrom, mTo);

                // Compute delta from allocations and apply to original trend data
                const postIndExp = sumPre('indirectExpenses');
                const postIndInc = sumPre('indirectIncome');
                const deltaExp = postIndExp - preIndExp;
                const deltaInc = postIndInc - preIndInc;

                monthData.indirectExpenses += deltaExp;
                monthData.indirectIncome += deltaInc;
                monthData.netProfit = monthData.grossProfit + monthData.indirectIncome - monthData.indirectExpenses;
            }
        }
    }

    res.json(trend);
});

// ===== TOP 10 EXPENSES (TB-based for full company coverage) =====
app.get('/api/dashboard/top-expenses', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    const lgMap = buildLedgerGroupMap(ids);
    const tbLedgers = getLedgerFlowsTB(ids, from, to);
    const expSet = new Set([
        ...getGroupTree(ids, 'Purchase Accounts'),
        ...getGroupTree(ids, 'Direct Expenses'),
        ...getGroupTree(ids, 'Indirect Expenses')
    ]);

    res.json(getTopLedgers(tbLedgers, lgMap, expSet, 10, true));
});

// ===== TOP 10 DIRECT EXPENSES (by group, TB-based) =====
app.get('/api/dashboard/top-direct-expenses', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    const lgMap = buildLedgerGroupMap(ids);
    const tbLedgers = getLedgerFlowsTB(ids, from, to);
    const { directDebit } = buildPLGroupSets(ids);

    res.json(getTotalsByGroup(tbLedgers, lgMap, directDebit, true).slice(0, 10));
});

// ===== TOP 10 INDIRECT EXPENSES (by group, TB-based) =====
app.get('/api/dashboard/top-indirect-expenses', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    const lgMap = buildLedgerGroupMap(ids);
    const tbLedgers = getLedgerFlowsTB(ids, from, to);
    const { indirectDebit } = buildPLGroupSets(ids);

    const results = getTotalsByGroup(tbLedgers, lgMap, indirectDebit, true);

    // Inject allocation synthetic entries
    const groupId = Number(req.query.groupId);
    if (groupId && ids.length > 1) {
        const rules = getDashboardAllocRules(groupId);
        if (rules) {
            // Compute per-company for allocation calculations
            const units = ids.map(cid => {
                const kpi = computeKPIData([cid], from, to);
                return { companyId: cid, ...kpi };
            });
            for (const rule of rules) {
                const config = JSON.parse(rule.config || '{}');
                if (rule.rule_type === 'percent_income') {
                    const pct = (Number(config.percentage) || 0) / 100;
                    const sourceIds = config.source_company_ids || [];
                    let totalCharge = 0;
                    for (const sid of sourceIds) {
                        const src = units.find(u => u.companyId === sid);
                        if (src) totalCharge += (src.directIncome || src.revenue || 0) * pct;
                    }
                    // Net effect on consolidated indirect expenses = 0 (charge at source, but income at target)
                    // But show the gross charge as a line item since it redistributes
                    if (totalCharge > 0) {
                        results.push({ category: config.expense_label || 'HO Charges', total: totalCharge, _allocation: true });
                    }
                } else if (rule.rule_type === 'fixed') {
                    // Fixed transfers are zero-sum at consolidated level, but show for visibility
                    const overlap = getEffectiveOverlap(config, from, to);
                    if (overlap.overlaps) {
                        results.push({ category: `Alloc: ${rule.rule_name}`, total: 0, _allocation: true, _note: 'Internal transfer (net zero)' });
                    }
                }
            }
        }
    }

    res.json(results.sort((a, b) => b.total - a.total).slice(0, 10));
});

// ===== TOP 10 REVENUE (TB-based, includes Sales + Direct Income) =====
app.get('/api/dashboard/top-revenue', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    const lgMap = buildLedgerGroupMap(ids);
    const tbLedgers = getLedgerFlowsTB(ids, from, to);
    const { directCredit } = buildPLGroupSets(ids);

    const results = getTopLedgers(tbLedgers, lgMap, directCredit, 10, false);

    // Inject allocation income entries (e.g., Franchise Income from percent_income rules)
    const groupId = Number(req.query.groupId);
    if (groupId && ids.length > 1) {
        const rules = getDashboardAllocRules(groupId);
        if (rules) {
            const units = ids.map(cid => {
                const kpi = computeKPIData([cid], from, to);
                return { companyId: cid, ...kpi };
            });
            for (const rule of rules) {
                const config = JSON.parse(rule.config || '{}');
                if (rule.rule_type === 'percent_income') {
                    const pct = (Number(config.percentage) || 0) / 100;
                    const sourceIds = config.source_company_ids || [];
                    let totalIncome = 0;
                    for (const sid of sourceIds) {
                        const src = units.find(u => u.companyId === sid);
                        if (src) totalIncome += (src.directIncome || src.revenue || 0) * pct;
                    }
                    if (totalIncome > 0) {
                        results.push({
                            ledger_name: config.income_label || 'Franchise Income',
                            group_name: 'Indirect Income (Allocation)',
                            total: totalIncome,
                            _allocation: true
                        });
                    }
                }
            }
        }
    }

    res.json(results.sort((a, b) => b.total - a.total).slice(0, 10));
});

// ===== EXPENSE CATEGORIES (TB-based) =====
app.get('/api/dashboard/expense-categories', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    const lgMap = buildLedgerGroupMap(ids);
    const tbLedgers = getLedgerFlowsTB(ids, from, to);
    const expSet = new Set([
        ...getGroupTree(ids, 'Purchase Accounts'),
        ...getGroupTree(ids, 'Direct Expenses'),
        ...getGroupTree(ids, 'Indirect Expenses')
    ]);

    res.json(getTotalsByGroup(tbLedgers, lgMap, expSet, true));
});

// ===== REVENUE CATEGORIES (TB-based, includes Sales + Direct Income) =====
app.get('/api/dashboard/revenue-categories', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    const lgMap = buildLedgerGroupMap(ids);
    const tbLedgers = getLedgerFlowsTB(ids, from, to);
    const { directCredit } = buildPLGroupSets(ids);

    res.json(getTotalsByGroup(tbLedgers, lgMap, directCredit, false));
});

// ===== LEDGER BREAKDOWN (drill-down analysis) =====
app.get('/api/dashboard/ledger-breakdown', (req, res) => {
    const ids = resolveIds(req);
    const { fromDate, toDate, groupRoot, mode, classType } = req.query;
    if (!ids || (!groupRoot && !classType)) return res.status(400).json({ error: 'companyId/filters and groupRoot or classType required' });

    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    const lgMap = buildLedgerGroupMap(ids);

    let groupSet;
    if (classType) {
        const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(ids);
        const salesGroupSet    = new Set(getGroupTree(ids, 'Sales Accounts'));
        const purchaseGroupSet = new Set(getGroupTree(ids, 'Purchase Accounts'));
        const directExpOnly = new Set(directDebit); purchaseGroupSet.forEach(g => directExpOnly.delete(g));
        const directIncOnly = new Set(directCredit); salesGroupSet.forEach(g => directIncOnly.delete(g));
        const classMap = {
            revenue:     salesGroupSet,
            purchase:    purchaseGroupSet,
            directexp:   directExpOnly,
            indirectexp: indirectDebit,
            directinc:   directIncOnly,
            indirectinc: indirectCredit,
        };
        groupSet = classMap[classType] || new Set();
    } else {
        const roots = groupRoot.split(',');
        groupSet = new Set(roots.flatMap(r => getGroupTree(ids, r.trim())));
    }

    if (mode === 'balance') {
        const latestTB = db.prepare(
            `SELECT DISTINCT period_from FROM trial_balance WHERE company_id IN (${idPh(ids)}) AND period_from <= ? ORDER BY period_from DESC LIMIT 1`
        ).get(...ids, to);
        if (!latestTB) return res.json([]);
        const rows = db.prepare(
            `SELECT ledger_name, group_name, SUM(closing_balance) as closing_balance FROM trial_balance WHERE company_id IN (${idPh(ids)}) AND period_from = ? GROUP BY ledger_name, group_name`
        ).all(...ids, latestTB.period_from);
        const result = rows
            .filter(r => groupSet.has(r.group_name) && r.closing_balance !== 0)
            .map(r => ({ ledger_name: r.ledger_name, group_name: r.group_name, amount: Math.abs(r.closing_balance) }))
            .sort((a, b) => b.amount - a.amount);
        return res.json(result);
    }

    // Aggregate same-named ledgers across companies into one entry per (ledger, group)
    const tbSupp = getTBSupplement(ids, from, to);
    const ledgerAgg = {};
    for (const r of tbSupp) {
        if (!r.group_name || !groupSet.has(r.group_name)) continue;
        const amount = Math.abs((r.net_debit || 0) - (r.net_credit || 0));
        if (amount > 0) {
            const key = `${r.group_name}|${r.ledger_name}`;
            ledgerAgg[key] = (ledgerAgg[key] || { ledger_name: r.ledger_name, group_name: r.group_name, amount: 0 });
            ledgerAgg[key].amount += amount;
        }
    }
    const result = Object.values(ledgerAgg).sort((a, b) => b.amount - a.amount);
    res.json(result);
});

// ===== GROUP BREAKDOWN (Tally-style hierarchical drill-down) =====
app.get('/api/dashboard/group-breakdown', (req, res) => {
    const ids = resolveIds(req);
    const { fromDate, toDate, groupRoot, mode, classType, parentGroup } = req.query;
    if (!ids || (!groupRoot && !classType)) return res.status(400).json({ error: 'companyId/filters and groupRoot or classType required' });

    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    // 1. Resolve groupSet
    let groupSet;
    if (classType) {
        const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(ids);
        const salesGroupSet    = new Set(getGroupTree(ids, 'Sales Accounts'));
        const purchaseGroupSet = new Set(getGroupTree(ids, 'Purchase Accounts'));
        const directExpOnly = new Set(directDebit); purchaseGroupSet.forEach(g => directExpOnly.delete(g));
        const directIncOnly = new Set(directCredit); salesGroupSet.forEach(g => directIncOnly.delete(g));
        const classMap = {
            revenue:     salesGroupSet,
            purchase:    purchaseGroupSet,
            directexp:   directExpOnly,
            indirectexp: indirectDebit,
            directinc:   directIncOnly,
            indirectinc: indirectCredit,
        };
        groupSet = classMap[classType] || new Set();
    } else {
        const roots = groupRoot.split(',');
        groupSet = new Set(roots.flatMap(r => getGroupTree(ids, r.trim())));
    }

    // 2. Get all ledger amounts
    let ledgerRows = [];
    if (mode === 'balance') {
        const latestTB = db.prepare(
            `SELECT DISTINCT period_from FROM trial_balance WHERE company_id IN (${idPh(ids)}) AND period_from <= ? ORDER BY period_from DESC LIMIT 1`
        ).get(...ids, to);
        if (!latestTB) return res.json({ parentGroup: parentGroup || null, children: [] });
        const rows = db.prepare(
            `SELECT ledger_name, group_name, SUM(closing_balance) as closing_balance FROM trial_balance WHERE company_id IN (${idPh(ids)}) AND period_from = ? GROUP BY ledger_name, group_name`
        ).all(...ids, latestTB.period_from);
        ledgerRows = rows
            .filter(r => groupSet.has(r.group_name) && r.closing_balance !== 0)
            .map(r => ({ ledger_name: r.ledger_name, group_name: r.group_name, amount: Math.abs(r.closing_balance) }));
    } else {
        // Aggregate same-named ledgers across companies into one entry per (ledger, group)
        const ledgerAgg = {};
        const tbSupp = getTBSupplement(ids, from, to);
        for (const r of tbSupp) {
            if (!r.group_name || !groupSet.has(r.group_name)) continue;
            const amount = Math.abs((r.net_debit || 0) - (r.net_credit || 0));
            if (amount > 0) {
                const key = `${r.group_name}|${r.ledger_name}`;
                ledgerAgg[key] = (ledgerAgg[key] || { ledger_name: r.ledger_name, group_name: r.group_name, amount: 0 });
                ledgerAgg[key].amount += amount;
            }
        }
        ledgerRows = Object.values(ledgerAgg);
    }

    // 3. Fetch group hierarchy and build maps
    const allGroups = db.prepare(`SELECT DISTINCT group_name, parent_group FROM account_groups WHERE company_id IN (${idPh(ids)})`).all(...ids);
    const parentMap = {};   // group_name → parent_group
    const childrenMap = {}; // parent → [child group names]
    const seenChild = new Set();
    allGroups.forEach(g => {
        parentMap[g.group_name] = g.parent_group;
        // Deduplicate: same group can appear under same parent from multiple companies
        const key = `${g.parent_group}|${g.group_name}`;
        if (seenChild.has(key)) return;
        seenChild.add(key);
        if (!childrenMap[g.parent_group]) childrenMap[g.parent_group] = [];
        childrenMap[g.parent_group].push(g.group_name);
    });

    // Group ledgers by their immediate parent group
    const ledgersByGroup = {};
    ledgerRows.forEach(l => {
        if (!ledgersByGroup[l.group_name]) ledgersByGroup[l.group_name] = [];
        ledgersByGroup[l.group_name].push(l);
    });

    // 4. Recursive sum of all descendant ledger amounts within groupSet
    const sumCache = {};
    function sumDescendants(groupName) {
        if (sumCache[groupName] !== undefined) return sumCache[groupName];
        let total = (ledgersByGroup[groupName] || []).reduce((s, l) => s + l.amount, 0);
        (childrenMap[groupName] || []).forEach(child => {
            if (groupSet.has(child)) total += sumDescendants(child);
        });
        sumCache[groupName] = total;
        return total;
    }

    // 5. Determine target parent
    let targetParent;
    if (parentGroup) {
        targetParent = parentGroup;
    } else {
        // Find root(s): groups in groupSet whose parent is NOT in groupSet
        const roots = [...groupSet].filter(g => !groupSet.has(parentMap[g]));
        if (roots.length === 1) {
            targetParent = roots[0];
        } else {
            // Multiple roots — show them as top-level items
            const children = roots
                .map(r => ({ type: 'group', name: r, amount: sumDescendants(r) }))
                .filter(c => c.amount > 0)
                .sort((a, b) => b.amount - a.amount);
            return res.json({ parentGroup: null, children });
        }
    }

    // 6. Build children list for targetParent
    const children = [];

    // Child groups (sub-groups within groupSet)
    (childrenMap[targetParent] || []).forEach(childGroup => {
        if (!groupSet.has(childGroup)) return;
        const amount = sumDescendants(childGroup);
        if (amount > 0) children.push({ type: 'group', name: childGroup, amount });
    });

    // Direct ledgers under this group
    (ledgersByGroup[targetParent] || []).forEach(l => {
        children.push({ type: 'ledger', name: l.ledger_name, amount: l.amount });
    });

    children.sort((a, b) => b.amount - a.amount);
    res.json({ parentGroup: targetParent, children });
});

// ===== ITEM MONTHLY TREND (per-group or per-ledger YTD trend) =====
app.get('/api/dashboard/item-monthly-trend', (req, res) => {
    const ids = resolveIds(req);
    const { fromDate, toDate, groupRoot, mode, classType, parentGroup, ledgerName } = req.query;
    if (!ids || (!groupRoot && !classType)) return res.status(400).json({ error: 'companyId/filters and groupRoot or classType required' });

    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    // 1. Resolve groupSet
    let groupSet;
    if (classType) {
        const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(ids);
        const salesGroupSet    = new Set(getGroupTree(ids, 'Sales Accounts'));
        const purchaseGroupSet = new Set(getGroupTree(ids, 'Purchase Accounts'));
        const directExpOnly = new Set(directDebit); purchaseGroupSet.forEach(g => directExpOnly.delete(g));
        const directIncOnly = new Set(directCredit); salesGroupSet.forEach(g => directIncOnly.delete(g));
        const classMap = {
            revenue: salesGroupSet, purchase: purchaseGroupSet,
            directexp: directExpOnly, indirectexp: indirectDebit,
            directinc: directIncOnly, indirectinc: indirectCredit,
        };
        groupSet = classMap[classType] || new Set();
    } else {
        const roots = groupRoot.split(',');
        groupSet = new Set(roots.flatMap(r => getGroupTree(ids, r.trim())));
    }

    // 2. If parentGroup specified, narrow groupSet to descendants of that group
    if (parentGroup) {
        const descendants = new Set(getGroupTree(ids, parentGroup));
        const narrowed = new Set();
        descendants.forEach(g => { if (groupSet.has(g)) narrowed.add(g); });
        groupSet = narrowed;
    }

    const lgMap = buildLedgerGroupMap(ids);

    // 3. Get monthly data and aggregate
    if (mode === 'balance') {
        const tbRows = db.prepare(
            `SELECT period_from as month, ledger_name, group_name, SUM(closing_balance) as closing_balance
             FROM trial_balance WHERE company_id IN (${idPh(ids)}) AND period_from >= ? AND period_from <= ?
             GROUP BY period_from, ledger_name, group_name ORDER BY period_from`
        ).all(...ids, from, to);

        const months = {};
        for (const r of tbRows) {
            if (!r.group_name || !groupSet.has(r.group_name)) continue;
            if (ledgerName && r.ledger_name !== ledgerName) continue;
            if (!months[r.month]) months[r.month] = 0;
            months[r.month] += Math.abs(r.closing_balance || 0);
        }

        const result = Object.entries(months)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([month, amount]) => ({ month, amount }));
        return res.json(result);
    }

    // P&L items: use TB-based monthly flows (complete for all companies)
    const monthlyRows = getMonthlyFlowsTB(ids, from, to);
    const months = {};
    for (const row of monthlyRows) {
        if (ledgerName) {
            // Single ledger filter
            if (row.ledger_name !== ledgerName) continue;
            const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
            if (!grp || !groupSet.has(grp)) continue;
        } else {
            const grp = lgMap[`${row.company_id}|${row.ledger_name}`];
            if (!grp || !groupSet.has(grp)) continue;
        }
        if (!months[row.month]) months[row.month] = 0;
        months[row.month] += Math.abs(row.total);
    }

    const result = Object.entries(months)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, amount]) => ({ month, amount }));
    res.json(result);
});

// ===== RECEIVABLE AGEING =====
app.get('/api/dashboard/receivable-ageing', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const rows = db.prepare(`
        SELECT party_name,
            SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
            SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
            SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
            SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
            SUM(ABS(outstanding_amount)) as total
        FROM bills_outstanding WHERE company_id IN (${idPh(ids)}) AND nature = 'receivable'
        GROUP BY party_name ORDER BY total DESC LIMIT 15
    `).all(...ids);
    res.json(rows);
});

// ===== PAYABLE AGEING =====
app.get('/api/dashboard/payable-ageing', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const rows = db.prepare(`
        SELECT party_name,
            SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
            SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
            SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
            SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
            SUM(ABS(outstanding_amount)) as total
        FROM bills_outstanding WHERE company_id IN (${idPh(ids)}) AND nature = 'payable'
        GROUP BY party_name ORDER BY total DESC LIMIT 15
    `).all(...ids);
    res.json(rows);
});

// ===== STOCK SUMMARY =====
app.get('/api/dashboard/stock-summary', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const rows = db.prepare(`
        SELECT item_name, stock_group, SUM(closing_qty) as closing_qty, SUM(closing_value) as closing_value
        FROM stock_summary WHERE company_id IN (${idPh(ids)}) AND period_to = (SELECT MAX(period_to) FROM stock_summary WHERE company_id IN (${idPh(ids)}))
        GROUP BY item_name, stock_group ORDER BY closing_value DESC LIMIT 20
    `).all(...ids, ...ids);
    res.json(rows);
});

// ===== TRIAL BALANCE =====
app.get('/api/dashboard/trial-balance', (req, res) => {
    const ids = resolveIds(req);
    const { fromDate, toDate } = req.query;
    if (!ids) return res.status(400).json({ error: 'companyId or geographic filters required' });
    const rows = db.prepare(`
        SELECT ledger_name, group_name, SUM(opening_balance) as opening, SUM(net_debit) as debit, SUM(net_credit) as credit, SUM(closing_balance) as closing
        FROM trial_balance WHERE company_id IN (${idPh(ids)}) AND period_from <= ? AND period_to >= ?
        GROUP BY ledger_name, group_name ORDER BY ABS(SUM(closing_balance)) DESC
    `).all(...ids, toDate || '2025-03-31', fromDate || '2024-04-01');
    res.json(rows);
});

// ===== COMPANY GROUPS =====

app.get('/api/company-groups', (req, res) => {
    const groups = db.prepare(
        'SELECT id, name, description, created_at FROM company_groups ORDER BY name'
    ).all();
    const members = db.prepare(
        `SELECT cgm.group_id, cgm.company_id, c.name AS company_name,
                c.state, c.city, c.location, c.entity_type
         FROM company_group_members cgm
         JOIN companies c ON c.id = cgm.company_id
         WHERE c.is_active = 1`
    ).all();
    const memberMap = {};
    for (const m of members) {
        if (!memberMap[m.group_id]) memberMap[m.group_id] = [];
        memberMap[m.group_id].push({
            id: m.company_id, name: m.company_name,
            state: m.state || '', city: m.city || '',
            location: m.location || '', entity_type: m.entity_type || ''
        });
    }
    res.json(groups.map(g => ({ ...g, companies: memberMap[g.id] || [] })));
});

app.post('/api/company-groups', (req, res) => {
    const { name, description, companyIds } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (!Array.isArray(companyIds) || companyIds.length === 0)
        return res.status(400).json({ error: 'companyIds array is required and must be non-empty' });
    if (db.prepare('SELECT id FROM company_groups WHERE name = ?').get(name.trim()))
        return res.status(409).json({ error: `A group named "${name.trim()}" already exists` });

    try {
        const groupId = masterDb.transaction(() => {
            const info = masterDb.prepare('INSERT INTO company_groups (name, description) VALUES (?, ?)').run(name.trim(), description || '');
            const ins = masterDb.prepare('INSERT OR IGNORE INTO company_group_members (group_id, company_id) VALUES (?, ?)');
            for (const cid of companyIds) ins.run(info.lastInsertRowid, cid);
            return info.lastInsertRowid;
        })();
        // Migrate each company's data into the new group DB
        const targetDb = dbManager.getClientDb(groupId);
        for (const cid of companyIds) {
            const sourceDb = dbManager.getStandaloneDb(cid);
            dbManager.moveCompanyData(cid, sourceDb, targetDb);
        }
        res.status(201).json({ id: groupId, name: name.trim() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/company-groups/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM company_groups WHERE id = ?').get(id))
        return res.status(404).json({ error: 'Group not found' });
    const { name, description } = req.body;
    if (!name && description === undefined) return res.status(400).json({ error: 'Provide name or description to update' });
    if (name && db.prepare('SELECT id FROM company_groups WHERE name = ? AND id != ?').get(name.trim(), id))
        return res.status(409).json({ error: `Another group named "${name.trim()}" already exists` });
    const fields = [], params = [];
    if (name) { fields.push('name = ?'); params.push(name.trim()); }
    if (description !== undefined) { fields.push('description = ?'); params.push(description); }
    fields.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    db.prepare(`UPDATE company_groups SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
});

app.delete('/api/company-groups/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM company_groups WHERE id = ?').get(id))
        return res.status(404).json({ error: 'Group not found' });
    // Move all member data to standalone DBs before deleting the group
    const memberIds = masterDb.prepare('SELECT company_id FROM company_group_members WHERE group_id = ?').all(id).map(r => r.company_id);
    const sourceDb = dbManager.getClientDb(id);
    for (const cid of memberIds) {
        const targetDb = dbManager.getStandaloneDb(cid);
        dbManager.moveCompanyData(cid, sourceDb, targetDb);
    }
    db.prepare('DELETE FROM company_groups WHERE id = ?').run(id);
    res.json({ success: true });
});

app.put('/api/company-groups/:id/members', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM company_groups WHERE id = ?').get(id))
        return res.status(404).json({ error: 'Group not found' });
    const { companyIds } = req.body;
    if (!Array.isArray(companyIds) || companyIds.length === 0)
        return res.status(400).json({ error: 'companyIds array must be non-empty' });
    try {
        const newSet = new Set(companyIds.map(Number));
        const oldIds = masterDb.prepare('SELECT company_id FROM company_group_members WHERE group_id = ?').all(id).map(r => r.company_id);
        const oldSet = new Set(oldIds);
        const groupDb = dbManager.getClientDb(id);

        // Companies removed from group → move data to standalone
        for (const cid of oldIds) {
            if (!newSet.has(cid)) {
                const standaloneDb = dbManager.getStandaloneDb(cid);
                dbManager.moveCompanyData(cid, groupDb, standaloneDb);
            }
        }
        // Companies added to group → move data from standalone (or other group)
        for (const cid of companyIds) {
            if (!oldSet.has(cid)) {
                const sourceDb = dbManager.resolveDbForCompany(cid);
                dbManager.moveCompanyData(cid, sourceDb, groupDb);
            }
        }

        masterDb.transaction(() => {
            masterDb.prepare('DELETE FROM company_group_members WHERE group_id = ?').run(id);
            const ins = masterDb.prepare('INSERT OR IGNORE INTO company_group_members (group_id, company_id) VALUES (?, ?)');
            for (const cid of companyIds) ins.run(id, cid);
            masterDb.prepare("UPDATE company_groups SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
        })();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/company-groups/:id/members/add', (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM company_groups WHERE id = ?').get(id))
        return res.status(404).json({ error: 'Group not found' });
    const { companyId } = req.body;
    if (!companyId) return res.status(400).json({ error: 'companyId is required' });
    // Move company data from its current DB to the group DB
    const sourceDb = dbManager.resolveDbForCompany(companyId);
    const targetDb = dbManager.getClientDb(id);
    dbManager.moveCompanyData(companyId, sourceDb, targetDb);
    masterDb.prepare('INSERT OR IGNORE INTO company_group_members (group_id, company_id) VALUES (?, ?)').run(id, companyId);
    masterDb.prepare("UPDATE company_groups SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    res.json({ success: true });
});

// Remove a company from ALL groups (make it standalone)
app.delete('/api/company-groups/members/company/:companyId', (req, res) => {
    const companyId = Number(req.params.companyId);
    if (!companyId) return res.status(400).json({ error: 'Invalid companyId' });
    // Find which group this company belongs to and move its data to standalone
    const membership = masterDb.prepare('SELECT group_id FROM company_group_members WHERE company_id = ?').get(companyId);
    if (membership) {
        const sourceDb = dbManager.getClientDb(membership.group_id);
        const targetDb = dbManager.getStandaloneDb(companyId);
        dbManager.moveCompanyData(companyId, sourceDb, targetDb);
    }
    const result = masterDb.prepare('DELETE FROM company_group_members WHERE company_id = ?').run(companyId);
    res.json({ success: true, removed: result.changes });
});

// ===== ALLOCATION RULES =====

// List allocation rules for a group
app.get('/api/allocation-rules', (req, res) => {
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.json([]);
    const rows = db.prepare(
        'SELECT * FROM allocation_rules WHERE group_id = ? ORDER BY sort_order, id'
    ).all(groupId);
    res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })));
});

// Create allocation rule
app.post('/api/allocation-rules', (req, res) => {
    const { groupId, rule_name, rule_type, config, affects_dashboard } = req.body;
    if (!groupId || !rule_name || !rule_type || !config) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['ratio', 'fixed', 'percent_income'].includes(rule_type)) {
        return res.status(400).json({ error: 'Invalid rule_type' });
    }
    const maxOrder = db.prepare(
        'SELECT MAX(sort_order) as mx FROM allocation_rules WHERE group_id = ?'
    ).get(groupId);
    const sortOrder = (maxOrder?.mx ?? -1) + 1;
    const result = db.prepare(
        `INSERT INTO allocation_rules (group_id, rule_name, rule_type, config, sort_order, affects_dashboard)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(groupId, rule_name, rule_type, JSON.stringify(config), sortOrder, affects_dashboard ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

// Update allocation rule
app.put('/api/allocation-rules/:id', (req, res) => {
    const id = Number(req.params.id);
    const { rule_name, rule_type, config, is_active, sort_order, affects_dashboard } = req.body;
    const existing = db.prepare('SELECT * FROM allocation_rules WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    db.prepare(
        `UPDATE allocation_rules SET
            rule_name = ?, rule_type = ?, config = ?, is_active = ?, sort_order = ?,
            affects_dashboard = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
    ).run(
        rule_name ?? existing.rule_name,
        rule_type ?? existing.rule_type,
        config ? JSON.stringify(config) : existing.config,
        is_active ?? existing.is_active,
        sort_order ?? existing.sort_order,
        affects_dashboard != null ? (affects_dashboard ? 1 : 0) : (existing.affects_dashboard ?? 0),
        id
    );
    res.json({ success: true });
});

// Toggle allocation rule active/inactive
app.put('/api/allocation-rules/:id/toggle', (req, res) => {
    const id = Number(req.params.id);
    const { is_active } = req.body;
    db.prepare('UPDATE allocation_rules SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(is_active ? 1 : 0, id);
    res.json({ success: true });
});

// Delete allocation rule
app.delete('/api/allocation-rules/:id', (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM allocation_rules WHERE id = ?').run(id);
    res.json({ success: true });
});

// ===== WRITEOFF / ADD-BACK RULES =====

// List writeoff rules for a group
app.get('/api/writeoff-rules', (req, res) => {
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.json([]);
    const rows = db.prepare(
        'SELECT * FROM writeoff_rules WHERE group_id = ? ORDER BY sort_order, id'
    ).all(groupId);
    res.json(rows.map(r => ({
        ...r,
        ledger_names: JSON.parse(r.ledger_names || '[]'),
        company_ids: JSON.parse(r.company_ids || '[]'),
        config: JSON.parse(r.config || '{}'),
        // Backward compat: if old single company_id exists and company_ids is empty
        ...(r.company_id && !JSON.parse(r.company_ids || '[]').length ? { company_ids: [r.company_id] } : {}),
    })));
});

// Create writeoff rule
app.post('/api/writeoff-rules', (req, res) => {
    const { groupId, rule_name, rule_type, company_ids, ledger_names, config, affects_dashboard } = req.body;
    if (!groupId || !rule_name || !rule_type || !company_ids?.length || !ledger_names?.length) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['expense_addback', 'income_deduction'].includes(rule_type)) {
        return res.status(400).json({ error: 'Invalid rule_type' });
    }
    const maxOrder = db.prepare(
        'SELECT MAX(sort_order) as mx FROM writeoff_rules WHERE group_id = ?'
    ).get(groupId);
    const sortOrder = (maxOrder?.mx ?? -1) + 1;
    // Include company_id for backward compat with old schema (NOT NULL column)
    const primaryCompanyId = company_ids[0] || 0;
    const result = db.prepare(
        `INSERT INTO writeoff_rules (group_id, rule_name, rule_type, company_id, company_ids, ledger_names, config, sort_order, affects_dashboard)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(groupId, rule_name, rule_type, primaryCompanyId, JSON.stringify(company_ids), JSON.stringify(ledger_names),
        JSON.stringify(config || {}), sortOrder, affects_dashboard ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

// Update writeoff rule
app.put('/api/writeoff-rules/:id', (req, res) => {
    const id = Number(req.params.id);
    const { rule_name, rule_type, company_ids, ledger_names, config, is_active, sort_order, affects_dashboard } = req.body;
    const existing = db.prepare('SELECT * FROM writeoff_rules WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    db.prepare(
        `UPDATE writeoff_rules SET
            rule_name = ?, rule_type = ?, company_ids = ?, ledger_names = ?, config = ?, is_active = ?, sort_order = ?,
            affects_dashboard = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
    ).run(
        rule_name ?? existing.rule_name,
        rule_type ?? existing.rule_type,
        company_ids ? JSON.stringify(company_ids) : existing.company_ids,
        ledger_names ? JSON.stringify(ledger_names) : existing.ledger_names,
        config ? JSON.stringify(config) : (existing.config || '{}'),
        is_active ?? existing.is_active,
        sort_order ?? existing.sort_order,
        affects_dashboard != null ? (affects_dashboard ? 1 : 0) : (existing.affects_dashboard ?? 0),
        id
    );
    res.json({ success: true });
});

// Toggle writeoff rule active/inactive
app.put('/api/writeoff-rules/:id/toggle', (req, res) => {
    const id = Number(req.params.id);
    const { is_active } = req.body;
    db.prepare('UPDATE writeoff_rules SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(is_active ? 1 : 0, id);
    res.json({ success: true });
});

// Delete writeoff rule
app.delete('/api/writeoff-rules/:id', (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM writeoff_rules WHERE id = ?').run(id);
    res.json({ success: true });
});

// Ledgers for writeoff rule form (filtered by company + expense/income type)
app.get('/api/ledgers/for-writeoff', (req, res) => {
    const companyIds = (req.query.companyIds || req.query.companyId || '').split(',').map(Number).filter(Boolean);
    const ruleType = req.query.ruleType || '';
    if (!companyIds.length || !ruleType) return res.json([]);

    try {
        const sets = buildPLGroupSets(companyIds);
        let groupSet;
        if (ruleType === 'expense_addback') {
            groupSet = new Set([...sets.indirectDebit, ...sets.directDebit]);
        } else {
            groupSet = new Set([...sets.indirectCredit, ...sets.directCredit]);
        }

        if (!groupSet.size) return res.json([]);
        const groupNames = [...groupSet];
        const gph = groupNames.map(() => '?').join(',');
        const cph = companyIds.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT DISTINCT l.name FROM ledgers l
             WHERE l.company_id IN (${cph}) AND (l.group_name IN (${gph}) OR l.parent_group IN (${gph}))
             ORDER BY l.name`
        ).all(...companyIds, ...groupNames, ...groupNames);
        res.json(rows.map(r => r.name));
    } catch (err) {
        console.error('Ledger for-writeoff error:', err);
        res.json([]);
    }
});

// Ledger name search (autocomplete) within a company group
app.get('/api/ledgers/search', (req, res) => {
    const q = (req.query.q || '').trim();
    const groupId = Number(req.query.groupId);
    if (!q || q.length < 2 || !groupId) return res.json([]);
    const memberIds = db.prepare(
        'SELECT company_id FROM company_group_members WHERE group_id = ?'
    ).all(groupId).map(r => r.company_id);
    if (!memberIds.length) return res.json([]);
    const placeholders = memberIds.map(() => '?').join(',');
    const rows = db.prepare(
        `SELECT DISTINCT name FROM ledgers
         WHERE company_id IN (${placeholders}) AND name LIKE ?
         ORDER BY name LIMIT 15`
    ).all(...memberIds, `%${q}%`);
    res.json(rows.map(r => r.name));
});

// Ledgers filtered by P&L category for allocation rule form
app.get('/api/ledgers/by-category', (req, res) => {
    const companyIds = (req.query.companyIds || '').split(',').map(Number).filter(Boolean);
    const category = req.query.category || '';
    if (!companyIds.length || !category) return res.json([]);

    try {
        // Map category to the right group set
        const sets = buildPLGroupSets(companyIds);
        let groupSet;
        if (category === 'direct_income')     groupSet = sets.directCredit;
        else if (category === 'indirect_income')  groupSet = sets.indirectCredit;
        else if (category === 'direct_expense')   groupSet = sets.directDebit;
        else if (category === 'indirect_expense') groupSet = sets.indirectDebit;
        else return res.json([]);

        if (!groupSet || !groupSet.size) return res.json([]);

        const groupNames = [...groupSet];
        const gPh = groupNames.map(() => '?').join(',');
        const cPh = companyIds.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT DISTINCT ledger_name FROM trial_balance
             WHERE company_id IN (${cPh}) AND group_name IN (${gPh})
             ORDER BY ledger_name`
        ).all(...companyIds, ...groupNames);
        res.json(rows.map(r => r.ledger_name));
    } catch (err) {
        console.error('ledgers/by-category error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ===== CLIENT USER MANAGEMENT (Admin only) =====
app.get('/api/admin/clients', adminOnly, (req, res) => {
    try {
        const clients = db.prepare('SELECT id, username, display_name, is_active, created_at FROM client_users ORDER BY username').all();
        for (const c of clients) {
            c.companies = db.prepare(`
                SELECT ca.company_id as id, co.name
                FROM client_company_access ca
                LEFT JOIN companies co ON co.id = ca.company_id
                WHERE ca.client_id = ?
            `).all(c.id);
            c.company_ids = c.companies.map(co => co.id);
            c.features = JSON.parse(c.features || '{}');
        }
        res.json(clients);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clients', adminOnly, (req, res) => {
    const { username, password, display_name, company_ids, features } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    try {
        const hash = bcrypt.hashSync(password, 10);
        const featuresJson = JSON.stringify(features || {});
        const result = db.prepare('INSERT INTO client_users (username, password_hash, display_name, features) VALUES (?, ?, ?, ?)').run(username, hash, display_name || '', featuresJson);
        const clientId = result.lastInsertRowid;
        if (company_ids && company_ids.length) {
            const ins = db.prepare('INSERT INTO client_company_access (client_id, company_id) VALUES (?, ?)');
            for (const cid of company_ids) ins.run(clientId, cid);
        }
        res.json({ success: true, id: clientId });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/clients/:id', adminOnly, (req, res) => {
    const id = Number(req.params.id);
    const { password, display_name, company_ids, is_active, features } = req.body;
    try {
        if (password) {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare('UPDATE client_users SET password_hash = ? WHERE id = ?').run(hash, id);
        }
        if (display_name !== undefined) db.prepare('UPDATE client_users SET display_name = ? WHERE id = ?').run(display_name, id);
        if (is_active !== undefined) db.prepare('UPDATE client_users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);
        if (features !== undefined) db.prepare('UPDATE client_users SET features = ? WHERE id = ?').run(JSON.stringify(features), id);
        if (company_ids !== undefined) {
            db.prepare('DELETE FROM client_company_access WHERE client_id = ?').run(id);
            const ins = db.prepare('INSERT INTO client_company_access (client_id, company_id) VALUES (?, ?)');
            for (const cid of company_ids) ins.run(id, cid);
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/clients/:id', adminOnly, (req, res) => {
    try {
        db.prepare('DELETE FROM client_users WHERE id = ?').run(Number(req.params.id));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a company and all its data
app.delete('/api/companies/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid company id' });
    const company = masterDb.prepare('SELECT id, name FROM companies WHERE id = ?').get(id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    // Delete company data from its client DB
    const { COMPANY_SCOPED_TABLES } = require('./db/db-manager');
    const clientDb = dbManager.resolveDbForCompany(id);
    for (const table of COMPANY_SCOPED_TABLES) {
        try { clientDb.prepare(`DELETE FROM ${table} WHERE company_id = ?`).run(id); } catch (e) { /* skip */ }
    }
    // Remove group memberships, then delete the company from master
    masterDb.prepare('DELETE FROM company_group_members WHERE company_id = ?').run(id);
    masterDb.prepare('DELETE FROM companies WHERE id = ?').run(id);
    res.json({ success: true, deleted: company.name });
});

// ===== SETTINGS =====

app.get('/api/settings', (req, res) => {
    const settings = db.prepare('SELECT key, value FROM app_settings').all();
    const obj = {};
    settings.forEach(s => obj[s.key] = s.value);
    res.json(obj);
});

app.post('/api/settings', (req, res) => {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
        setSetting(key, String(value));
    }
    res.json({ success: true });
});

// ===== OPTIONAL MODULE MANAGEMENT =====

app.get('/api/companies/:id/modules', (req, res) => {
    const company = db.prepare('SELECT sync_modules FROM companies WHERE id = ?').get(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(JSON.parse(company.sync_modules || '{}'));
});

app.post('/api/companies/:id/modules', (req, res) => {
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    db.prepare('UPDATE companies SET sync_modules = ? WHERE id = ?').run(JSON.stringify(req.body), req.params.id);
    res.json({ success: true });
});

// ===== OPTIONAL MODULE REPORTS =====

app.get('/api/dashboard/gst-summary', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const rows = db.prepare(`
        SELECT voucher_type, COUNT(*) as count, SUM(taxable_value) as taxable,
               SUM(igst) as igst, SUM(cgst) as cgst, SUM(sgst) as sgst, SUM(cess) as cess
        FROM gst_entries
        WHERE company_id = ? AND date >= ? AND date <= ?
        GROUP BY voucher_type
        ORDER BY taxable DESC
    `).all(companyId, from, to);

    const monthly = db.prepare(`
        SELECT substr(date,1,7) as month, SUM(taxable_value) as taxable,
               SUM(igst+cgst+sgst+cess) as total_tax, COUNT(*) as count
        FROM gst_entries
        WHERE company_id = ? AND date >= ? AND date <= ?
        GROUP BY month ORDER BY month
    `).all(companyId, from, to);

    res.json({ byType: rows, monthly });
});

app.get('/api/dashboard/cost-centre-analysis', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    // Cost centre vs expense ledgers (amounts where cost centre allocation exists)
    const byCentre = db.prepare(`
        SELECT cost_centre, SUM(ABS(amount)) as total_amount, COUNT(DISTINCT ledger_name) as ledger_count
        FROM cost_allocations
        WHERE company_id = ? AND date >= ? AND date <= ?
        GROUP BY cost_centre ORDER BY total_amount DESC
    `).all(companyId, from, to);

    const centres = db.prepare('SELECT name, parent, category FROM cost_centres WHERE company_id = ?').all(companyId);

    res.json({ byCentre, centres });
});

app.get('/api/dashboard/payroll-summary', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const byEmployee = db.prepare(`
        SELECT employee_name, SUM(ABS(amount)) as total, COUNT(DISTINCT date) as payslips
        FROM payroll_entries
        WHERE company_id = ? AND date >= ? AND date <= ? AND employee_name != ''
        GROUP BY employee_name ORDER BY total DESC LIMIT 50
    `).all(companyId, from, to);

    const byPayHead = db.prepare(`
        SELECT pay_head, SUM(ABS(amount)) as total
        FROM payroll_entries
        WHERE company_id = ? AND date >= ? AND date <= ? AND pay_head != ''
        GROUP BY pay_head ORDER BY total DESC
    `).all(companyId, from, to);

    const monthly = db.prepare(`
        SELECT substr(date,1,7) as month, SUM(ABS(amount)) as total
        FROM payroll_entries
        WHERE company_id = ? AND date >= ? AND date <= ?
        GROUP BY month ORDER BY month
    `).all(companyId, from, to);

    res.json({ byEmployee, byPayHead, monthly });
});

// On-demand stock item ledger extraction + retrieval
app.post('/api/sync/stock-item-ledger', async (req, res) => {
    const { companyId, companyName, itemName, fromDate, toDate } = req.body;
    if (!companyId || !itemName || !fromDate || !toDate) {
        return res.status(400).json({ error: 'companyId, itemName, fromDate, toDate required' });
    }
    const host = getSetting('tally_host') || 'localhost';
    const port = parseInt(getSetting('tally_port') || '9000');
    const clientDb = dbManager.resolveDbForCompany(Number(companyId));
    const extractor = new DataExtractor(clientDb, { host, port });
    try {
        const count = await extractor.extractStockItemLedger(companyId, companyName, itemName, fromDate, toDate);
        res.json({ success: true, rowCount: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/dashboard/stock-item-ledger', (req, res) => {
    const { companyId, itemName, fromDate, toDate } = req.query;
    if (!companyId || !itemName) return res.status(400).json({ error: 'companyId and itemName required' });
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const rows = db.prepare(`
        SELECT date, voucher_type, voucher_number, party_name, quantity, amount
        FROM stock_item_ledger
        WHERE company_id = ? AND item_name = ? AND date >= ? AND date <= ?
        ORDER BY date
    `).all(companyId, itemName, from, to);

    // Running balance
    let runningQty = 0;
    const enriched = rows.map(r => {
        runningQty += r.quantity;
        return { ...r, running_qty: runningQty };
    });

    res.json(enriched);
});

// ===== REPORT DOWNLOAD =====
const { generatePDF, generateExcel, fmtINR, fmtLakhs } = require('./report-generator');
const { generateDocx } = require('./docx-generator');
const { generateCFOReviewDocx } = require('./cfo-review-generator');

const PL_LINES = [
    { key: 'revenue',          label: 'Revenue (Sales)',   bold: false },
    { key: 'directIncome',     label: 'Direct Income',     bold: false },
    { key: 'purchase',         label: 'COGS (Purchase)',   bold: false },
    { key: 'directExpenses',   label: 'Direct Expenses',   bold: false },
    { key: 'openingStock',     label: 'Opening Stock',     bold: false },
    { key: 'closingStock',     label: 'Closing Stock',     bold: false },
    { key: 'grossProfit',      label: 'GROSS PROFIT',      bold: true,  line: 'top' },
    { key: 'indirectExpenses', label: 'Indirect Expenses', bold: false },
    { key: 'indirectIncome',   label: 'Indirect Income',   bold: false },
    { key: 'netProfit',        label: 'NET PROFIT',        bold: true,  line: 'both' },
];

function buildFilterLabel(query) {
    const parts = [];
    if (query.groupId) {
        const grp = db.prepare('SELECT name FROM company_groups WHERE id = ?').get(Number(query.groupId));
        if (grp) parts.push(grp.name);
    }
    const geoParts = [query.state, query.city, query.location,
                      (query.type && query.type !== 'All') ? query.type : '']
        .filter(v => v && v.trim());
    parts.push(...geoParts);
    return parts.length ? parts.join(' > ') : 'All Companies';
}

function buildReportFilename(query, format) {
    const prefix = format === 'docx' ? 'CFO_Insights' : 'TallyVision_Report';
    const parts = [prefix];
    if (query.groupId) {
        const grp = db.prepare('SELECT name FROM company_groups WHERE id = ?').get(Number(query.groupId));
        if (grp) parts.push(grp.name.replace(/\s+/g, '-'));
    }
    const filters = [query.state, query.city, query.location,
                     (query.type && query.type !== 'All') ? query.type : '']
        .filter(v => v && v.trim())
        .map(v => v.replace(/\s+/g, '-'));
    if (!query.groupId && filters.length === 0) filters.push('All');
    parts.push(...filters);
    if (query.fromDate) parts.push(query.fromDate);
    if (query.toDate) parts.push(query.toDate);
    const extMap = { pdf: 'pdf', xlsx: 'xlsx', docx: 'docx' };
    return parts.join('_') + '.' + (extMap[format] || format);
}

/**
 * Build a columnar P&L statement with up to three header levels.
 *
 * Header levels (built dynamically based on what's in the selection):
 *   Level 1 (top):  City          — shown when multiple cities
 *   Level 2 (mid):  Location      — shown when any city has multiple locations
 *   Level 3 (bot):  Stream type   — shown when All Types selected & multiple types exist
 *
 * Scenarios:
 *   A. Multi-city + multi-location + All Types → City > Location > Stream  (3-level)
 *   B. Multi-city + single-loc-each + All Types → City > Stream            (2-level)
 *   C. Single city + multi-location + All Types → Location > Stream        (2-level)
 *   D. Single city + single-loc + All Types     → Stream only              (1-level)
 *   E. Specific type + multi-city/location        → City > Location columns  (1-level or 2-level, no stream sub-level)
 *   F. Specific type + single city + single loc   → Single column
 */
function buildPLStatement(req, ids, from, to) {
    const type = req.query.type || 'All';

    // Fetch company metadata for the matched IDs
    const companies = db.prepare(
        `SELECT id, city, location, entity_type FROM companies
         WHERE id IN (${idPh(ids)}) AND is_active = 1`
    ).all(...ids);

    const cities    = [...new Set(companies.filter(c => c.city).map(c => c.city))].sort();
    const locations = [...new Set(companies.filter(c => c.location).map(c => c.location))].sort();
    const types     = [...new Set(companies.filter(c => c.entity_type).map(c => c.entity_type))].sort();

    const multiCity = cities.length > 1;
    const multiLoc  = locations.length > 1;
    const multiType = (!type || type === 'All') && types.length > 1;

    // Check if any city has multiple locations
    const anyMultiLoc = cities.some(city => {
        const locs = [...new Set(companies.filter(c => c.city === city && c.location).map(c => c.location))];
        return locs.length > 1;
    });

    if (multiType && (multiCity || multiLoc)) {
        // ── Columnar with grouping ──
        const columns = [];
        // Level 1 groups: cities (only when multiple cities)
        const level1 = multiCity ? [] : null;
        // Level 2 groups: locations (only when any city has multiple locations)
        const level2 = anyMultiLoc ? [] : null;

        for (const city of cities) {
            const cityLocs = [...new Set(
                companies.filter(c => c.city === city && c.location).map(c => c.location)
            )].sort();

            let citySpan = 0;

            for (const loc of cityLocs) {
                const locTypes = [...new Set(
                    companies.filter(c => c.city === city && c.location === loc && c.entity_type).map(c => c.entity_type)
                )].sort();

                if (level2) {
                    level2.push({ label: loc, span: locTypes.length });
                }

                for (const et of locTypes) {
                    const etIds = companies.filter(c => c.city === city && c.location === loc && c.entity_type === et).map(c => c.id);
                    if (etIds.length > 0) {
                        columns.push({ name: et, data: computeKPIData(etIds, from, to), _ids: etIds });
                        citySpan++;
                    }
                }
            }

            if (level1) {
                level1.push({ label: city, span: citySpan });
            }
        }

        // Total column
        if (level1) level1.push({ label: 'Total', span: 1 });
        if (level2) level2.push({ label: '', span: 1 });
        columns.push({ name: 'Total', data: computeKPIData(ids, from, to), _ids: ids });

        return { columnar: true, level1, level2, columns, lines: PL_LINES };

    } else if (multiType) {
        // ── One-level: Stream only (single city, single location) ──
        const columns = [];
        for (const et of types) {
            const etIds = companies.filter(c => c.entity_type === et).map(c => c.id);
            if (etIds.length > 0) {
                columns.push({ name: et, data: computeKPIData(etIds, from, to), _ids: etIds });
            }
        }
        columns.push({ name: 'Total', data: computeKPIData(ids, from, to), _ids: ids });
        return { columnar: true, level1: null, level2: null, columns, lines: PL_LINES };

    } else if (multiCity || multiLoc) {
        // ── Specific type selected but multiple cities/locations → City > Location columns ──
        const columns = [];
        const level1 = multiCity ? [] : null;

        for (const city of cities) {
            const cityLocs = [...new Set(
                companies.filter(c => c.city === city && c.location).map(c => c.location)
            )].sort();

            let citySpan = 0;

            for (const loc of cityLocs) {
                const locIds = companies.filter(c => c.city === city && c.location === loc).map(c => c.id);
                if (locIds.length > 0) {
                    columns.push({ name: loc, data: computeKPIData(locIds, from, to), _ids: locIds });
                    citySpan++;
                }
            }

            if (level1) {
                level1.push({ label: city, span: citySpan });
            }
        }

        // Total column
        if (level1) level1.push({ label: 'Total', span: 1 });
        columns.push({ name: 'Total', data: computeKPIData(ids, from, to), _ids: ids });

        return { columnar: true, level1, level2: null, columns, lines: PL_LINES };

    } else {
        // ── Single column (single city, single location, specific type) ──
        const label = type !== 'All' ? type : (types[0] || 'All');
        return { columnar: false, level1: null, level2: null, columns: [{ name: label, data: computeKPIData(ids, from, to), _ids: ids }], lines: PL_LINES };
    }
}

function computeMonthlyTrendData(ids, from, to) {
    const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(ids);
    const salesSet    = new Set(getGroupTree(ids, 'Sales Accounts'));
    const purchaseSet = new Set(getGroupTree(ids, 'Purchase Accounts'));

    const tbRows = db.prepare(`
        SELECT period_from as month, group_name,
               SUM(net_debit) as net_debit, SUM(net_credit) as net_credit
        FROM trial_balance t
        WHERE company_id IN (${idPh(ids)})
          AND period_from >= ? AND period_to <= ?
          AND group_name IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
        GROUP BY period_from, group_name
    `).all(...ids, from, to);

    const months = {};
    for (const row of tbRows) {
        const grp = row.group_name;
        if (!months[row.month]) months[row.month] = { sales: 0, directInc: 0, purchase: 0, directExp: 0, indirectInc: 0, indirectExp: 0 };
        const m = months[row.month];
        const dr = row.net_debit  || 0;
        const cr = row.net_credit || 0;
        if (salesSet.has(grp))              m.sales      += (cr - dr);
        else if (directCredit.has(grp))     m.directInc  += (cr - dr);
        if (purchaseSet.has(grp))           m.purchase   -= (dr - cr);
        else if (directDebit.has(grp))      m.directExp  -= (dr - cr);
        if (indirectCredit.has(grp))        m.indirectInc += (cr - dr);
        if (indirectDebit.has(grp))         m.indirectExp -= (dr - cr);
    }

    return Object.entries(months)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, d]) => {
            const allDC = d.sales + d.directInc;
            const allDD = d.purchase + d.directExp;
            const grossProfit = allDC + allDD;
            const netProfit   = grossProfit + d.indirectInc + d.indirectExp;
            return {
                month,
                revenue: allDC,
                sales: d.sales,
                directIncome: d.directInc,
                purchase: -d.purchase,
                directExpenses: -d.directExp,
                indirectExpenses: -d.indirectExp,
                indirectIncome: d.indirectInc,
                grossProfit,
                netProfit
            };
        });
}

// ===== CFO INSIGHTS DATA ASSEMBLY =====

function pctChange(current, prior) {
    if (!prior || prior === 0) return current > 0 ? 100 : (current < 0 ? -100 : 0);
    return ((current - prior) / Math.abs(prior)) * 100;
}

function generateNarrativeBullets(cur, prior, ytd, arAgeing, closingStockInsights, pharmaInsights) {
    const bullets = [];
    const revChange = pctChange(cur.revenue, prior.revenue);
    const dir = revChange >= 0 ? 'grew' : 'declined';
    bullets.push(`Revenue ${dir} ${Math.abs(revChange).toFixed(1)}% MoM to ${fmtINR(cur.revenue)}.`);

    const curNPM = cur.revenue ? (cur.netProfit / cur.revenue * 100) : 0;
    const priorNPM = prior.revenue ? (prior.netProfit / prior.revenue * 100) : 0;
    const npmDir = curNPM >= priorNPM ? 'improved' : 'fell';
    bullets.push(`Net Profit margin ${npmDir} from ${priorNPM.toFixed(1)}% to ${curNPM.toFixed(1)}%.`);

    const cashChg = pctChange(cur.cashBankBalance, prior.cashBankBalance);
    const cashDir = cashChg >= 0 ? 'rose' : 'dipped';
    bullets.push(`Cash reserves ${cashDir} ${Math.abs(cashChg).toFixed(1)}% to ${fmtINR(cur.cashBankBalance)}.`);

    if (arAgeing && arAgeing.length > 0) {
        const totalAR = arAgeing.reduce((s, r) => s + (r.total || 0), 0);
        const over90 = arAgeing.reduce((s, r) => s + (r['90_plus'] || 0), 0);
        const pct90 = totalAR > 0 ? (over90 / totalAR * 100).toFixed(0) : 0;
        bullets.push(`Outstanding receivables at ${fmtINR(totalAR)} with ${pct90}% beyond 90 days.`);
    }

    // Supplementary data bullets
    if (closingStockInsights) {
        const k = closingStockInsights.kpis;
        bullets.push(`Closing stock valued at ${fmtLakhs(k.totalStockValue)} L (MRP) with ${k.marginPct}% margin over purchase cost.`);
        if (k.expiredBatchCount > 0) {
            bullets.push(`Expired stock alert: ${fmtLakhs(k.expiredStockValue)} L across ${k.expiredBatchCount} batches — write-off review recommended.`);
        }
        if (k.nearExpiryBatchCount > 0) {
            bullets.push(`Near-expiry warning: ${fmtLakhs(k.nearExpiryStockValue)} L in stock expiring within 3 months (${k.nearExpiryBatchCount} batches).`);
        }
    }

    if (pharmaInsights) {
        const p = pharmaInsights.kpis;
        bullets.push(`Pharma sales: ${fmtLakhs(p.totalSalesAmount)} L across ${p.uniqueBills.toLocaleString('en-IN')} bills (avg bill value: ${fmtINR(p.avgBillValue)}).`);
    }

    return bullets;
}

// ── Supplementary Data Helpers for CFO Report ──

/**
 * Build supplementary Direct Income analytics from uploaded Excel files.
 * Returns KPIs, department breakdown, doctor revenue, weekly trend — or null.
 */
function buildDirectIncomeSupplementary(companyIds, from, to) {
    const periodMonths = [];
    const startD = new Date(from + 'T00:00:00');
    const endD = new Date(to + 'T00:00:00');
    let cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
    while (cur <= endD) {
        periodMonths.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
    }
    if (!periodMonths.length) return null;

    const monthPh = periodMonths.map(() => '?').join(',');
    const cPh = companyIds.map(() => '?').join(',');
    const q = `SELECT row_data FROM excel_data WHERE category = 'direct_income' AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
    const rawRows = db.prepare(q).all(...periodMonths, ...companyIds);
    if (!rawRows.length) return null;

    const rows = rawRows.map(r => JSON.parse(r.row_data));
    const num = (v) => {
        if (v === null || v === undefined || v === '') return 0;
        if (typeof v === 'object' && v.formula) return Number(v.result) || 0;
        return Number(v) || 0;
    };

    // Order-level rows (have Bill Date)
    const orderRows = rows.filter(r => {
        const bd = r['Bill Date'];
        return bd && bd !== '' && typeof bd !== 'object';
    });

    // KPIs
    let totalBilled = 0, totalCollections = 0, totalRefunds = 0, totalReturns = 0;
    const patientNames = new Set();
    for (const r of orderRows) {
        totalBilled += num(r['Billed']);
        totalCollections += num(r['Paid']);
        const refund = num(r['Refund']);
        totalRefunds += refund;
        if (refund > 0) totalReturns++;
        const name = (r['Name'] || '').toString().trim();
        if (name) patientNames.add(name.toLowerCase());
    }
    const totalOrders = orderRows.length;
    const uniquePatients = patientNames.size;
    const avgBillingValue = totalOrders ? totalBilled / totalOrders : 0;
    const collectionRate = totalBilled ? (totalCollections / totalBilled) * 100 : 0;

    // Department-wise
    const deptMap = {};
    for (const r of rows) {
        const dept = (r['Dept.'] || r['Dept'] || '').toString().trim();
        if (!dept) continue;
        const price = num(r['Item Price']);
        if (!deptMap[dept]) deptMap[dept] = { total: 0, count: 0 };
        deptMap[dept].total += price;
        deptMap[dept].count++;
    }
    const departments = Object.entries(deptMap)
        .map(([name, d]) => ({ name, total: d.total, count: d.count }))
        .sort((a, b) => b.total - a.total).slice(0, 15);

    // Weekly Billing Trend
    function parseDate(val) {
        if (!val) return null;
        if (val instanceof Date) return val;
        const s = String(val).trim();
        const dmyMatch = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
        if (dmyMatch) return new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1]));
        const isoMatch = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
        if (isoMatch) return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    }
    const weekMap = {};
    for (const r of orderRows) {
        const d = parseDate(r['Bill Date']);
        if (!d) continue;
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const weekStart = new Date(d);
        weekStart.setDate(diff);
        const wsKey = weekStart.toISOString().slice(0, 10);
        const wsDay = String(weekStart.getDate()).padStart(2, '0');
        const wsMonth = weekStart.toLocaleString('en-IN', { month: 'short' });
        const label = `${wsDay} ${wsMonth}`;
        if (!weekMap[wsKey]) weekMap[wsKey] = { label, weekStart: wsKey, billed: 0, collected: 0 };
        weekMap[wsKey].billed += num(r['Billed']);
        weekMap[wsKey].collected += num(r['Paid']);
    }
    const weeklyTrend = Object.values(weekMap).sort((a, b) => a.weekStart.localeCompare(b.weekStart));

    // Doctor-wise Revenue
    const docMap = {};
    for (const r of rows) {
        const doc = (r['Billed Doctor'] || '').toString().trim();
        if (!doc) continue;
        const price = num(r['Item Price']);
        if (!docMap[doc]) docMap[doc] = { total: 0, count: 0 };
        docMap[doc].total += price;
        docMap[doc].count++;
    }
    const doctors = Object.entries(docMap)
        .map(([name, d]) => ({ name, total: d.total, itemCount: d.count }))
        .sort((a, b) => b.total - a.total);

    return {
        kpis: {
            totalBilled: Math.round(totalBilled),
            totalCollections: Math.round(totalCollections),
            collectionRate: Math.round(collectionRate * 10) / 10,
            totalOrders,
            uniquePatients,
            avgBillingValue: Math.round(avgBillingValue),
            totalReturns,
            totalRefunds: Math.round(totalRefunds),
        },
        departments,
        weeklyTrend,
        doctors,
    };
}

function buildPharmaInsightsData(companyIds, from, to) {
    const periodMonths = [];
    const startD = new Date(from + 'T00:00:00');
    const endD = new Date(to + 'T00:00:00');
    let cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
    while (cur <= endD) {
        periodMonths.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
    }
    if (!periodMonths.length) return null;

    const monthPh = periodMonths.map(() => '?').join(',');
    let q, params;
    if (companyIds && companyIds.length) {
        const cPh = companyIds.map(() => '?').join(',');
        q = `SELECT period_month, row_data FROM excel_data WHERE category = 'revenue' AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
        params = [...periodMonths, ...companyIds];
    } else {
        q = `SELECT period_month, row_data FROM excel_data WHERE category = 'revenue' AND period_month IN (${monthPh})`;
        params = [...periodMonths];
    }
    const rawRows = db.prepare(q).all(...params);
    if (!rawRows.length) return null;

    const num = (v) => {
        if (v === null || v === undefined || v === '') return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'object' && v.formula) return Number(v.result) || 0;
        return Number(v) || 0;
    };

    function normalizePharmaRow(row) {
        if ('Sales Amount' in row) {
            return {
                drugName: String(row['Drug Name'] || ''),
                qty: num(row['Qty']),
                salesAmount: num(row['Sales Amount']),
                purchaseAmount: num(row['Purchase Amount']),
                referredBy: (row['Referred by'] || '').toString().trim(),
                billNo: String(row['Bill No'] || '')
            };
        }
        if ('col_3' in row && typeof row.col_9 === 'number') {
            const keys = Object.keys(row);
            return {
                drugName: String(row.col_3 || ''),
                qty: num(row.col_6),
                salesAmount: num(row.col_9),
                purchaseAmount: num(row.col_13),
                referredBy: '',
                billNo: String(row[keys[0]] || '')
            };
        }
        return null;
    }

    let totalSalesAmount = 0, totalPurchaseAmount = 0, totalQty = 0;
    const billSet = new Set();
    const drugRevMap = {};
    const drugProfMap = {};
    const docMap = {};

    for (const raw of rawRows) {
        const row = JSON.parse(raw.row_data);
        const n = normalizePharmaRow(row);
        if (!n || !n.drugName || n.salesAmount === 0) continue;

        totalSalesAmount += n.salesAmount;
        totalPurchaseAmount += n.purchaseAmount;
        totalQty += n.qty;
        if (n.billNo) billSet.add(n.billNo);

        // Drug revenue
        if (!drugRevMap[n.drugName]) drugRevMap[n.drugName] = { total: 0, qty: 0 };
        drugRevMap[n.drugName].total += n.salesAmount;
        drugRevMap[n.drugName].qty += n.qty;

        // Drug profit
        const profit = n.salesAmount - n.purchaseAmount;
        if (!drugProfMap[n.drugName]) drugProfMap[n.drugName] = { profit: 0, sales: 0, purchase: 0 };
        drugProfMap[n.drugName].profit += profit;
        drugProfMap[n.drugName].sales += n.salesAmount;
        drugProfMap[n.drugName].purchase += n.purchaseAmount;

        // Doctor
        if (n.referredBy) {
            if (!docMap[n.referredBy]) docMap[n.referredBy] = { total: 0, billCount: 0 };
            docMap[n.referredBy].total += n.salesAmount;
            docMap[n.referredBy].billCount++;
        }
    }

    const computedGrossProfit = totalSalesAmount - totalPurchaseAmount;
    const profitMarginPct = totalSalesAmount > 0 ? (computedGrossProfit / totalSalesAmount * 100) : 0;
    const uniqueBills = billSet.size;
    const avgBillValue = uniqueBills > 0 ? Math.round(totalSalesAmount / uniqueBills) : 0;

    const topDrugsByRevenue = Object.entries(drugRevMap)
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    const topDrugsByProfit = Object.entries(drugProfMap)
        .map(([name, v]) => ({ name, ...v, marginPct: v.sales > 0 ? (v.profit / v.sales * 100) : 0 }))
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 10);

    const doctorRevenue = Object.entries(docMap)
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);

    return {
        kpis: {
            totalSalesAmount: Math.round(totalSalesAmount),
            computedGrossProfit: Math.round(computedGrossProfit),
            profitMarginPct: Math.round(profitMarginPct * 10) / 10,
            totalQtySold: totalQty,
            uniqueBills,
            avgBillValue
        },
        topDrugsByRevenue,
        topDrugsByProfit,
        doctorRevenue
    };
}

function buildClosingStockInsightsData(companyIds, from, to) {
    const periodMonths = [];
    const startD = new Date(from + 'T00:00:00');
    const endD = new Date(to + 'T00:00:00');
    let cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
    while (cur <= endD) {
        periodMonths.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
    }
    if (!periodMonths.length) return null;

    const monthPh = periodMonths.map(() => '?').join(',');
    let q, params;
    if (companyIds && companyIds.length) {
        const cPh = companyIds.map(() => '?').join(',');
        q = `SELECT period_month, row_data FROM excel_data WHERE category = 'closing_stock' AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
        params = [...periodMonths, ...companyIds];
    } else {
        q = `SELECT period_month, row_data FROM excel_data WHERE category = 'closing_stock' AND period_month IN (${monthPh})`;
        params = [...periodMonths];
    }
    const rawRows = db.prepare(q).all(...params);
    if (!rawRows.length) return null;

    // Find latest month (snapshot)
    const actualMonths = [...new Set(rawRows.map(r => r.period_month))].sort();
    const latestMonth = actualMonths[actualMonths.length - 1];
    const latestRows = rawRows.filter(r => r.period_month === latestMonth);

    const num = (v) => {
        if (v === null || v === undefined || v === '') return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'object' && v.formula) return Number(v.result) || 0;
        return Number(v) || 0;
    };

    const today = new Date();
    const threeMonthsFromNow = new Date(today);
    threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    function parseDate(str) {
        if (!str) return null;
        const s = String(str).trim();
        const parts = s.split('/');
        if (parts.length === 3) {
            const d = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10) - 1;
            const y = parseInt(parts[2], 10);
            if (!isNaN(d) && !isNaN(m) && !isNaN(y)) return new Date(y, m, d);
        }
        const dt = new Date(s);
        return isNaN(dt.getTime()) ? null : dt;
    }

    let totalStockValue = 0, totalPurchaseValue = 0, activeSKUs = new Set(), totalBatches = 0;
    let expiredStockValue = 0, expiredBatchCount = 0;
    let nearExpiryStockValue = 0, nearExpiryBatchCount = 0;
    let slowMovingValue = 0, slowMovingBatchCount = 0;
    const stockistMap = {}, mfgMap = {};
    const expiredItems = [], nearExpiryItems = [], slowMovingItems = [];

    for (const raw of latestRows) {
        const row = JSON.parse(raw.row_data);
        const keys = Object.keys(row);
        const productName = (row[keys[0]] || '').toString().trim();
        if (!productName || productName.length < 2) continue;
        if (/^(period|page|printed|address|report|sl\.?\s*no|sr\.?\s*no|s\.no|product)/i.test(productName)) continue;

        const avlQty = num(row.col_8);
        if (avlQty <= 0) continue;

        const manufacturer = (row.col_3 || '').toString().trim();
        const stockist = (row.col_4 || '').toString().trim();
        const batchNo = (row.col_5 || '').toString().trim();
        const receivedDateStr = (row.col_6 || '').toString().trim();
        const expiryDateStr = (row.col_7 || '').toString().trim();
        const purchaseValue = num(row.col_12);
        const stockValue = num(row.col_13);
        const expiryDate = parseDate(expiryDateStr);
        const receivedDate = parseDate(receivedDateStr);

        totalStockValue += stockValue;
        totalPurchaseValue += purchaseValue;
        activeSKUs.add(productName);
        totalBatches++;

        const isExpired = expiryDate && expiryDate < today;
        const isNearExpiry = expiryDate && !isExpired && expiryDate <= threeMonthsFromNow;

        if (isExpired) {
            expiredStockValue += stockValue;
            expiredBatchCount++;
            expiredItems.push({ product: productName, manufacturer, batchNo, expiryDate: expiryDateStr, avlQty, stockValue });
        }
        if (isNearExpiry) {
            nearExpiryStockValue += stockValue;
            nearExpiryBatchCount++;
            nearExpiryItems.push({ product: productName, manufacturer, batchNo, expiryDate: expiryDateStr, avlQty, stockValue, expiryDt: expiryDate });
        }
        if (receivedDate && receivedDate < oneYearAgo) {
            slowMovingValue += stockValue;
            slowMovingBatchCount++;
            slowMovingItems.push({ product: productName, manufacturer, receivedDate: receivedDateStr, avlQty, stockValue });
        }
        if (stockist) {
            if (!stockistMap[stockist]) stockistMap[stockist] = { stockValue: 0, batchCount: 0 };
            stockistMap[stockist].stockValue += stockValue;
            stockistMap[stockist].batchCount++;
        }
        if (manufacturer) {
            if (!mfgMap[manufacturer]) mfgMap[manufacturer] = { stockValue: 0, batchCount: 0 };
            mfgMap[manufacturer].stockValue += stockValue;
            mfgMap[manufacturer].batchCount++;
        }
    }

    expiredItems.sort((a, b) => b.stockValue - a.stockValue);
    nearExpiryItems.sort((a, b) => (a.expiryDt?.getTime() || 0) - (b.expiryDt?.getTime() || 0));
    slowMovingItems.sort((a, b) => b.stockValue - a.stockValue);

    const marginPct = totalStockValue > 0 ? ((totalStockValue - totalPurchaseValue) / totalStockValue) * 100 : 0;
    const safeStockValue = totalStockValue - expiredStockValue - nearExpiryStockValue;

    return {
        latestMonth,
        kpis: {
            totalStockValue: Math.round(totalStockValue),
            totalPurchaseValue: Math.round(totalPurchaseValue),
            marginPct: Math.round(marginPct * 10) / 10,
            activeSKUs: activeSKUs.size,
            totalBatches,
            expiredStockValue: Math.round(expiredStockValue),
            expiredBatchCount,
            nearExpiryStockValue: Math.round(nearExpiryStockValue),
            nearExpiryBatchCount,
            slowMovingValue: Math.round(slowMovingValue),
            slowMovingBatchCount,
            safeStockValue: Math.round(safeStockValue)
        },
        topStockists: Object.entries(stockistMap).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.stockValue - a.stockValue).slice(0, 10),
        topManufacturers: Object.entries(mfgMap).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.stockValue - a.stockValue).slice(0, 10),
        expiredItems: expiredItems.slice(0, 15),
        nearExpiryItems: nearExpiryItems.slice(0, 10).map(({ expiryDt, ...rest }) => rest),
        slowMovingItems: slowMovingItems.slice(0, 10)
    };
}

function buildCFOActionItems(arAgeing, closingStockInsights, pharmaInsights) {
    const items = [];

    if (closingStockInsights) {
        const k = closingStockInsights.kpis;
        if (k.expiredBatchCount > 0) {
            items.push({ priority: 'high', category: 'Inventory', description: `Review ${fmtLakhs(k.expiredStockValue)} L of expired inventory (${k.expiredBatchCount} batches) for potential write-off.` });
        }
        if (k.nearExpiryBatchCount > 0) {
            items.push({ priority: 'high', category: 'Inventory', description: `${fmtLakhs(k.nearExpiryStockValue)} L of stock expiring within 3 months (${k.nearExpiryBatchCount} batches) — consider clearance pricing or returns.` });
        }
        if (k.slowMovingBatchCount > 0) {
            items.push({ priority: 'medium', category: 'Inventory', description: `${fmtLakhs(k.slowMovingValue)} L in slow-moving stock (received >1 year ago, ${k.slowMovingBatchCount} batches) — evaluate for liquidation.` });
        }
        // Supplier concentration
        if (closingStockInsights.topStockists.length > 0 && k.totalStockValue > 0) {
            const topPct = (closingStockInsights.topStockists[0].stockValue / k.totalStockValue * 100).toFixed(0);
            if (topPct > 35) {
                items.push({ priority: 'medium', category: 'Supply Chain', description: `Top stockist "${closingStockInsights.topStockists[0].name}" holds ${topPct}% of total stock value — evaluate supplier diversification.` });
            }
        }
    }

    if (arAgeing && arAgeing.length > 0) {
        const over90 = arAgeing.reduce((s, r) => s + (r['90_plus'] || 0), 0);
        const partiesOver90 = arAgeing.filter(r => (r['90_plus'] || 0) > 0).length;
        if (over90 > 0) {
            items.push({ priority: 'high', category: 'Collections', description: `${fmtLakhs(over90)} L in receivables beyond 90 days from ${partiesOver90} parties — escalate recovery efforts.` });
        }
    }

    return items;
}

function buildCFOInsightsData(req, ids, from, to) {
    // ── Derive date periods ──
    const curMonthEnd = to;
    const curMonthStart = startOfMonth(to);
    const priorEnd = endOfMonth(subtractMonth(to, 1));
    const priorStart = startOfMonth(priorEnd);
    const smlyEnd = endOfMonth(subtractYear(curMonthEnd, 1));
    const smlyStart = startOfMonth(smlyEnd);
    const sixMAgo = startOfMonth(subtractMonth(to, 5));

    // ── Section 1: Executive Summary ──
    const currentKPI  = computeKPIData(ids, curMonthStart, curMonthEnd);
    const priorKPI    = computeKPIData(ids, priorStart, priorEnd);
    const ytdKPI      = computeKPIData(ids, from, to);

    // ── Section 2: P&L Comparison ──
    const smlyKPI     = computeKPIData(ids, smlyStart, smlyEnd);
    const plComparison = {
        currentLabel: monthLabel(curMonthStart),
        priorLabel:   monthLabel(priorStart),
        smlyLabel:    monthLabel(smlyStart),
        current: currentKPI, prior: priorKPI, smly: smlyKPI
    };

    // Columnar P&L (geographic)
    const plStatement = buildPLStatement(req, ids, from, to);
    const isConsolidated = plStatement.columnar && plStatement.columns.length > 2;

    // Revenue Concentration (Top 5, YTD)
    const lgMap = buildLedgerGroupMap(ids);
    const { directCredit, directDebit, indirectDebit } = buildPLGroupSets(ids);
    const tbLedgers = getLedgerFlowsTB(ids, from, to);
    // FIX: Use Sales groups only (not all directCredit) and guard against zero revenue
    const salesGroupSet = new Set(getGroupTree(ids, 'Sales Accounts'));
    const topRevenue = getTopLedgers(tbLedgers, lgMap, salesGroupSet, 5, false);
    const totalRevForConc = Math.abs(ytdKPI.revenue) || 0;
    const revenueConcentration = totalRevForConc === 0 ? [] : topRevenue.map(r => ({
        name: r.ledger_name, amount: r.total,
        pct: Math.min(100, (r.total / totalRevForConc * 100)).toFixed(1)
    }));

    // Direct Income Breakdown (directCredit minus Sales groups — salesGroupSet already computed above)
    const directIncOnly = new Set(directCredit);
    salesGroupSet.forEach(g => directIncOnly.delete(g));
    const directIncByLedger = getTopLedgers(tbLedgers, lgMap, directIncOnly, 10, false);
    const totalDirectInc = directIncByLedger.reduce((s, r) => s + r.total, 0) || 1;
    const directIncomeBreakdown = directIncByLedger.map(r => ({
        name: r.ledger_name, amount: r.total,
        pct: (r.total / totalDirectInc * 100).toFixed(1)
    }));

    // Expense Breakdown by Group (for CFO report)
    const directExpByGroup = getTotalsByGroup(tbLedgers, lgMap, directDebit, true);
    const totalDirectExp = directExpByGroup.reduce((s, r) => s + r.total, 0) || 1;
    const directExpenseBreakdown = directExpByGroup.slice(0, 10).map(r => ({
        name: r.category, amount: r.total,
        pct: (r.total / totalDirectExp * 100).toFixed(1)
    }));

    const indirectExpByGroup = getTotalsByGroup(tbLedgers, lgMap, indirectDebit, true);
    const totalIndirectExp = indirectExpByGroup.reduce((s, r) => s + r.total, 0) || 1;
    const indirectExpenseBreakdown = indirectExpByGroup.slice(0, 10).map(r => ({
        name: r.category, amount: r.total,
        pct: (r.total / totalIndirectExp * 100).toFixed(1)
    }));

    // OpEx Trends (last 6 months × top 3 indirect expense groups)
    const trendData = computeMonthlyTrendData(ids, sixMAgo, to);
    // Build per-group monthly breakdown for indirect expenses
    const indDebitSet = indirectDebit;
    const monthlyTBRows = db.prepare(`
        SELECT period_from as month, group_name,
               SUM(net_debit) - SUM(net_credit) as total
        FROM trial_balance t
        WHERE company_id IN (${idPh(ids)})
          AND period_from >= ? AND period_to <= ?
          AND group_name IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
        GROUP BY period_from, group_name
    `).all(...ids, sixMAgo, to);

    // Aggregate by indirect expense group
    const groupTotals = {};
    const groupMonthly = {};
    for (const row of monthlyTBRows) {
        if (!indDebitSet.has(row.group_name)) continue;
        const g = row.group_name;
        groupTotals[g] = (groupTotals[g] || 0) + Math.abs(row.total);
        if (!groupMonthly[g]) groupMonthly[g] = {};
        groupMonthly[g][row.month] = Math.abs(row.total);
    }
    const top3Groups = Object.entries(groupTotals).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    const trendMonths = [...new Set(monthlyTBRows.map(r => r.month))].sort();
    const opexTrend = {
        months: trendMonths.map(m => monthLabel(m)),
        groups: top3Groups.map(g => ({
            name: g,
            values: trendMonths.map(m => groupMonthly[g]?.[m] || 0)
        }))
    };

    // ── Section 3: Liquidity & Working Capital ──
    const cashGroups = getGroupTree(ids, 'Cash-in-Hand');
    const bankGroups = getGroupTree(ids, 'Bank Accounts');
    const openingCash = -(computeBSClosing(ids, subtractMonth(curMonthStart, 0), [...cashGroups, ...bankGroups], null, lgMap));
    // Use prior month end as opening = start of current month
    const priorCashBal = -(computeBSClosing(ids, priorEnd, [...cashGroups, ...bankGroups], null, lgMap));
    const cashPosition = {
        opening: priorCashBal,
        closing: currentKPI.cashBankBalance,
        netChange: currentKPI.cashBankBalance - priorCashBal
    };

    // AR Ageing
    const arAgeing = db.prepare(`
        SELECT party_name,
            SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
            SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
            SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
            SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
            SUM(ABS(outstanding_amount)) as total
        FROM bills_outstanding WHERE company_id IN (${idPh(ids)}) AND nature = 'receivable'
        GROUP BY party_name ORDER BY total DESC LIMIT 15
    `).all(...ids);

    // AP Ageing
    const apAgeing = db.prepare(`
        SELECT party_name,
            SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
            SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
            SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
            SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
            SUM(ABS(outstanding_amount)) as total
        FROM bills_outstanding WHERE company_id IN (${idPh(ids)}) AND nature = 'payable'
        GROUP BY party_name ORDER BY total DESC LIMIT 15
    `).all(...ids);

    // ── Section 4: Statutory & Tax ──
    let gstSummary = null;
    try {
        const gstRows = db.prepare(`
            SELECT voucher_type, COUNT(*) as count, SUM(taxable_value) as taxable,
                   SUM(igst) as igst, SUM(cgst) as cgst, SUM(sgst) as sgst, SUM(cess) as cess
            FROM gst_entries WHERE company_id IN (${idPh(ids)}) AND date >= ? AND date <= ?
            GROUP BY voucher_type ORDER BY taxable DESC
        `).all(...ids, from, to);
        if (gstRows.length > 0) gstSummary = gstRows;
    } catch (e) { /* GST module not synced */ }

    // Indian tax compliance calendar (static, next 60 days from report date)
    const complianceCalendar = buildComplianceCalendar();

    // ── Supplementary Data (from uploaded Excel files) ──
    let pharmaInsights = null;
    let closingStockInsights = null;
    let directIncomeSupp = null;

    try {
        pharmaInsights = buildPharmaInsightsData(ids, from, to);
    } catch (e) { /* no pharma data — skip */ }

    try {
        closingStockInsights = buildClosingStockInsightsData(ids, from, to);
    } catch (e) { /* no stock data — skip */ }

    try {
        directIncomeSupp = buildDirectIncomeSupplementary(ids, from, to);
    } catch (e) { /* no direct income supplementary data — skip */ }

    // ── Action Items ──
    const actionItems = buildCFOActionItems(arAgeing, closingStockInsights, pharmaInsights);

    // ── Narrative ──
    const narrative = generateNarrativeBullets(currentKPI, priorKPI, ytdKPI, arAgeing, closingStockInsights, pharmaInsights);

    return {
        title: 'CFO Insights Report',
        filterLabel: buildFilterLabel(req.query),
        period: { from, to },
        generatedAt: new Date().toISOString(),
        isConsolidated,
        narrative,
        plComparison,
        plStatement,
        revenueConcentration,
        directIncomeBreakdown,
        directIncomeSupp,
        directExpenseBreakdown,
        indirectExpenseBreakdown,
        opexTrend,
        trendData,
        cashPosition,
        arAgeing,
        apAgeing,
        gstSummary,
        complianceCalendar,
        pharmaInsights,
        closingStockInsights,
        actionItems,
    };
}

function buildComplianceCalendar() {
    const now = new Date();
    const items = [
        { day: 7,  desc: 'TDS/TCS deposit for previous month' },
        { day: 11, desc: 'GSTR-1 filing (monthly filers)' },
        { day: 13, desc: 'GSTR-1 filing (QRMP scheme)' },
        { day: 15, desc: 'Advance Tax installment (Jun 15, Sep 15, Dec 15, Mar 15)' },
        { day: 20, desc: 'GSTR-3B filing (monthly filers)' },
        { day: 25, desc: 'GSTR-3B filing (QRMP scheme)' },
        { day: 30, desc: 'TDS return (Form 24Q/26Q) — quarterly' },
    ];
    const calendar = [];
    for (let m = 0; m < 2; m++) {
        const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
        const mLabel = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        for (const item of items) {
            const dt = new Date(d.getFullYear(), d.getMonth(), item.day);
            if (dt >= now && dt <= new Date(now.getTime() + 60 * 86400000)) {
                calendar.push({
                    date: dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
                    description: item.desc
                });
            }
        }
    }
    return calendar;
}

// ===== CFO PERFORMANCE REVIEW (per-unit breakdown) =====

function buildCFOReviewData(req, ids, groupId, from, to) {
    const curMonthEnd   = to;
    const curMonthStart = startOfMonth(to);
    const priorEnd      = endOfMonth(subtractMonth(to, 1));
    const priorStart    = startOfMonth(priorEnd);

    // Get company details for filtered units (ids already resolved with geo filters)
    const idPh = ids.map(() => '?').join(',');
    const companyRows = db.prepare(
        `SELECT c.id, c.name, c.city, c.location, c.entity_type, c.state
         FROM companies c
         WHERE c.id IN (${idPh}) AND c.is_active = 1
         ORDER BY c.entity_type, c.location, c.name`
    ).all(...ids);

    // Compute KPI per company (current month)
    const units = companyRows.map(comp => {
        const kpi = computeKPIData([comp.id], curMonthStart, curMonthEnd);
        const totalIncome = (kpi.revenue || 0) + (kpi.directIncome || 0);
        const totalExpenses = (kpi.purchase || 0) + (kpi.directExpenses || 0) + (kpi.indirectExpenses || 0);
        const gpPct = totalIncome ? (kpi.grossProfit / totalIncome * 100) : 0;
        const npPct = totalIncome ? (kpi.netProfit / totalIncome * 100) : 0;

        let status = 'Healthy';
        if (kpi.netProfit < -50000) status = 'Critical';
        else if (kpi.netProfit < 0) status = 'Attention';

        return {
            companyId: comp.id,
            name: comp.name,
            city: comp.city,
            location: comp.location,
            entityType: comp.entity_type,
            revenue: kpi.revenue || 0,
            directIncome: kpi.directIncome || 0,
            purchase: kpi.purchase || 0,
            directExpenses: kpi.directExpenses || 0,
            indirectExpenses: kpi.indirectExpenses || 0,
            indirectIncome: kpi.indirectIncome || 0,
            openingStock: kpi.openingStock || 0,
            closingStock: kpi.closingStock || 0,
            grossProfit: kpi.grossProfit || 0,
            netProfit: kpi.netProfit || 0,
            cashBankBalance: kpi.cashBankBalance || 0,
            totalExpenses,
            gpPct,
            npPct,
            status,
        };
    });

    // Apply allocation rules
    const allocRules = db.prepare(
        'SELECT * FROM allocation_rules WHERE group_id = ? AND is_active = 1 ORDER BY sort_order'
    ).all(groupId);

    for (const rule of allocRules) {
        const config = JSON.parse(rule.config || '{}');
        applyAllocationRule(units, rule.rule_type, config, from, to);
    }

    // Recompute GP/NP/status after allocations
    units.forEach(u => {
        const totalIncome = (u.revenue || 0) + (u.directIncome || 0);
        // GP unchanged by allocations; only NP recalculated
        u.netProfit = (u.grossProfit || 0) + (u.indirectIncome || 0) - (u.indirectExpenses || 0);
        u.totalExpenses = (u.purchase || 0) + (u.directExpenses || 0) + (u.indirectExpenses || 0);
        u.gpPct = totalIncome ? (u.grossProfit / totalIncome * 100) : 0;
        u.npPct = totalIncome ? (u.netProfit / totalIncome * 100) : 0;
        if (u.netProfit < -50000) u.status = 'Critical';
        else if (u.netProfit < 0) u.status = 'Attention';
        else u.status = 'Healthy';
    });

    // Consolidated KPI
    const consolidated = computeKPIData(ids, curMonthStart, curMonthEnd);
    const priorConsolidated = computeKPIData(ids, priorStart, priorEnd);

    // Stock per company
    const stockByUnit = [];
    for (const comp of companyRows) {
        const stockRow = db.prepare(`
            SELECT SUM(closing_value) as cv
            FROM stock_summary
            WHERE company_id = ?
              AND period_to = (SELECT MAX(period_to) FROM stock_summary WHERE company_id = ? AND period_to <= ?)
        `).get(comp.id, comp.id, curMonthEnd);
        if (stockRow && stockRow.cv) {
            stockByUnit.push({ companyId: comp.id, companyName: comp.name, closingValue: Math.abs(stockRow.cv) });
        }
    }
    stockByUnit.sort((a, b) => b.closingValue - a.closingValue);

    // Group info
    const groupInfo = db.prepare('SELECT name FROM company_groups WHERE id = ?').get(groupId);
    const groupName = groupInfo?.name || 'Company Group';

    // City label (most common city)
    const cities = [...new Set(companyRows.map(c => c.city).filter(Boolean))];
    const cityLabel = cities.length === 1 ? `${cities[0]} Network` : `${cities.length}-City Network`;

    // Auto-generate narrative
    const narrative = [];
    const totalRev = consolidated.revenue + consolidated.directIncome;
    const priorRev = priorConsolidated.revenue + priorConsolidated.directIncome;
    const revGrowth = priorRev ? ((totalRev - priorRev) / Math.abs(priorRev) * 100) : 0;

    if (revGrowth) narrative.push(`Total Operating Income: ${fmtLakhs(totalRev)}L (${revGrowth >= 0 ? '+' : ''}${revGrowth.toFixed(1)}% MoM)`);

    const gpPctCons = totalRev ? (consolidated.grossProfit / totalRev * 100) : 0;
    narrative.push(`GP Margin: ${gpPctCons.toFixed(1)}%`);

    const npGrowth = priorConsolidated.netProfit ? ((consolidated.netProfit - priorConsolidated.netProfit) / Math.abs(priorConsolidated.netProfit) * 100) : 0;
    narrative.push(`Net Profit: ${fmtLakhs(consolidated.netProfit)}L${npGrowth ? ` (${npGrowth >= 0 ? '+' : ''}${npGrowth.toFixed(1)}% MoM)` : ''}`);
    narrative.push(`Cash & Bank: ${fmtLakhs(consolidated.cashBankBalance)}L`);

    const lossMaking = units.filter(u => u.netProfit < 0);
    if (lossMaking.length) {
        narrative.push(`${lossMaking.length} loss-making unit(s): ${lossMaking.map(u => u.name.split(':').pop().split('-')[0].trim()).join(', ')}`);
    }

    // Auto-generate action items
    const actionItems = [];
    lossMaking.forEach(u => {
        actionItems.push(`${u.name.split(':').pop().split('-')[0].trim()}: Develop turnaround plan. Current NP: ${fmtLakhs(u.netProfit)}L`);
    });
    const highExpUnits = units.filter(u => {
        const income = u.revenue + u.directIncome;
        return income > 0 && ((u.directExpenses + u.purchase) / income * 100) > 70;
    });
    highExpUnits.forEach(u => {
        actionItems.push(`${u.name.split(':').pop().split('-')[0].trim()}: Direct expense ratio exceeds 70% — review and rationalize.`);
    });
    if (stockByUnit.length) {
        actionItems.push('Conduct stock audit across all sub-units. Implement monthly stock-day reporting.');
    }
    actionItems.push(`Network Net Profit target for next month: ${fmtLakhs(Math.max(consolidated.netProfit * 1.2, 1000000))}L minimum.`);

    // Auto-generate rating
    const profitableCount = units.filter(u => u.netProfit > 0).length;
    const profitablePct = units.length ? (profitableCount / units.length * 100) : 0;
    const npMargin = totalRev ? (consolidated.netProfit / totalRev * 100) : 0;
    let rating = 'Needs Attention';
    if (profitablePct >= 90 && npMargin >= 10) rating = 'Excellent';
    else if (profitablePct >= 75 && npMargin >= 5) rating = 'Good';
    else if (profitablePct >= 50 && npMargin >= 0) rating = 'Fair';

    // Auto-generate commentary
    const commentary = [
        `Revenue momentum is ${revGrowth > 5 ? 'strong' : revGrowth > 0 ? 'moderate' : 'weak'} with ${fmtPctS(revGrowth)} MoM growth.`,
        `${profitableCount} of ${units.length} units are profitable this period.`,
        lossMaking.length ? `${lossMaking.length} unit(s) are loss-making and require immediate attention.` : 'All units are profitable.',
        `Network-level GP margin stands at ${gpPctCons.toFixed(1)}%.`,
        npMargin >= 5 ? 'Net profitability is healthy.' : npMargin >= 0 ? 'Net profitability is thin — cost discipline needed.' : 'Network is operating at a net loss.',
    ].join('\n');

    return {
        groupName,
        cityLabel,
        filterLabel: buildFilterLabel(req.query),
        period: { from: curMonthStart, to: curMonthEnd },
        generatedAt: new Date().toISOString(),
        rating,
        adjustmentNotes: '',
        commentary,
        narrative,
        actionItems,
        units,
        consolidated,
        priorConsolidated,
        stockByUnit,
        allocationsApplied: allocRules.length > 0,
    };
}

function fmtPctS(num) { return `${num >= 0 ? '+' : ''}${Number(num).toFixed(1)}%`; }

// Look up a specific ledger's net debit flow for a company in a date range
function getLedgerAmount(companyId, ledgerName, from, to) {
    const row = db.prepare(`
        SELECT SUM(net_debit) - SUM(net_credit) as total
        FROM trial_balance t
        WHERE company_id = ? AND ledger_name = ?
          AND period_from >= ? AND period_to <= ?
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
    `).get(companyId, ledgerName, from, to);
    return row?.total || 0;
}

// Look up multiple ledgers' combined net debit flow (for multi-select ledger names)
function getLedgerAmountMulti(companyId, ledgerNames, from, to) {
    if (!ledgerNames || !ledgerNames.length) return 0;
    const ph = ledgerNames.map(() => '?').join(',');
    const row = db.prepare(`
        SELECT SUM(net_debit) - SUM(net_credit) as total
        FROM trial_balance t
        WHERE company_id = ? AND ledger_name IN (${ph})
          AND period_from >= ? AND period_to <= ?
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
    `).get(companyId, ...ledgerNames, from, to);
    return row?.total || 0;
}

// Resolve ledger_names from config (supports both legacy single and new multi-select)
function resolveLedgerNames(config) {
    if (config.ledger_names && config.ledger_names.length) return config.ledger_names;
    if (config.ledger_name) return [config.ledger_name];
    return [];
}

// Returns overlapping months between rule's effective period and the query range
function getEffectiveOverlap(config, fromDate, toDate) {
    // Parse query range
    const qStart = fromDate ? new Date(fromDate + 'T00:00:00') : new Date('2000-01-01');
    const qEnd = toDate ? new Date(toDate + 'T00:00:00') : new Date('2099-12-31');

    // Parse effective period (YYYY-MM format); absent = unbounded
    let eStart = new Date('2000-01-01');
    if (config.effective_from) {
        const [y, m] = config.effective_from.split('-').map(Number);
        eStart = new Date(y, m - 1, 1);
    }
    let eEnd = new Date('2099-12-31');
    if (config.effective_to) {
        const [y, m] = config.effective_to.split('-').map(Number);
        eEnd = new Date(y, m, 0); // last day of that month
    }

    // Overlap range
    const overlapStart = new Date(Math.max(qStart.getTime(), eStart.getTime()));
    const overlapEnd = new Date(Math.min(qEnd.getTime(), eEnd.getTime()));

    if (overlapStart > overlapEnd) return { overlaps: false, months: [], monthCount: 0 };

    // Enumerate months in overlap
    const months = [];
    let cur = new Date(overlapStart.getFullYear(), overlapStart.getMonth(), 1);
    const lastMonth = new Date(overlapEnd.getFullYear(), overlapEnd.getMonth(), 1);
    while (cur <= lastMonth) {
        months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
        cur.setMonth(cur.getMonth() + 1);
    }
    return { overlaps: true, months, monthCount: months.length };
}

// Resolve the total fixed amount for the given months
function resolveFixedAmount(config, months) {
    if (config.monthly_amounts && typeof config.monthly_amounts === 'object') {
        // Month-wise mode: sum amounts for matching months
        return months.reduce((sum, m) => sum + (Number(config.monthly_amounts[m]) || 0), 0);
    }
    // Uniform mode: amount is per-month, multiply by month count
    return (Number(config.amount) || 0) * months.length;
}

function applyAllocationRule(units, ruleType, config, from, to) {
    // Check effective period overlap
    const overlap = getEffectiveOverlap(config, from, to);
    if (!overlap.overlaps) return;

    const findUnit = (id) => units.find(u => u.companyId === id);

    if (ruleType === 'fixed') {
        const source = findUnit(config.source_company_id);
        const target = findUnit(config.target_company_id);
        if (!source || !target) return;
        const amount = resolveFixedAmount(config, overlap.months);
        // Deduct from source indirect expenses, add to target
        source.indirectExpenses = (source.indirectExpenses || 0) - amount;
        target.indirectExpenses = (target.indirectExpenses || 0) + amount;
    }

    if (ruleType === 'ratio') {
        const source = findUnit(config.source_company_id);
        if (!source) return;
        const targets = config.targets || [];
        const totalRatio = targets.reduce((s, t) => s + (Number(t.ratio) || 0), 0);
        if (!totalRatio) return;

        // Look up the SPECIFIC ledger's amount (not entire indirect expenses)
        const ledgerNms = resolveLedgerNames(config);
        const ledgerAmount = (from && to && ledgerNms.length)
            ? getLedgerAmountMulti(config.source_company_id, ledgerNms, from, to)
            : (source.indirectExpenses || 0);

        // Source's own ratio share
        const sourceTarget = targets.find(t => t.company_id === config.source_company_id);
        const sourceRatio = sourceTarget ? Number(sourceTarget.ratio) : 0;
        const sourceShare = (sourceRatio / totalRatio) * ledgerAmount;

        // Amount redistributed away from source
        const redistributed = ledgerAmount - sourceShare;

        // Reduce source's indirect expenses by the amount redistributed away
        source.indirectExpenses = (source.indirectExpenses || 0) - redistributed;

        // Distribute to other targets
        const otherTargets = targets.filter(t => t.company_id !== config.source_company_id);
        for (const t of otherTargets) {
            const targetUnit = findUnit(t.company_id);
            if (!targetUnit) continue;
            const share = (Number(t.ratio) / totalRatio) * ledgerAmount;
            targetUnit.indirectExpenses = (targetUnit.indirectExpenses || 0) + share;
        }
    }

    if (ruleType === 'percent_income') {
        const target = findUnit(config.target_company_id);
        if (!target) return;
        const pct = (Number(config.percentage) || 0) / 100;
        const sourceIds = config.source_company_ids || [];

        // If specific ledger(s) are named, use their balance; otherwise use directIncome/revenue
        const ledgerNms = resolveLedgerNames(config);
        for (const sid of sourceIds) {
            const source = findUnit(sid);
            if (!source) continue;
            let incomeBase;
            if (from && to && ledgerNms.length) {
                incomeBase = Math.abs(getLedgerAmountMulti(sid, ledgerNms, from, to));
            } else {
                incomeBase = source.directIncome || source.revenue || 0;
            }
            const chargeAmount = incomeBase * pct;

            // Source gets an expense (HO charges)
            source.indirectExpenses = (source.indirectExpenses || 0) + chargeAmount;

            // Target gets income
            target.indirectIncome = (target.indirectIncome || 0) + chargeAmount;
        }
    }
}

// CFO Review preview (returns JSON for edit modal)
// CFO Review preview (returns JSON for edit modal) — respects geo filters
app.get('/api/reports/cfo-review/preview', (req, res) => {
    try {
        const groupId = Number(req.query.groupId);
        if (!groupId) return res.status(400).json({ error: 'groupId required (CFO Review works with company groups)' });

        // Use resolveIds which intersects group members with geo filters
        const ids = resolveIds(req);
        if (!ids || !ids.length) return res.status(400).json({ error: 'No active companies match the current filters' });

        const from = req.query.fromDate || '2024-04-01';
        const to   = req.query.toDate   || '2025-03-31';

        const data = buildCFOReviewData(req, ids, groupId, from, to);
        res.json(data);
    } catch (err) {
        console.error('CFO Review preview error:', err);
        res.status(500).json({ error: err.message });
    }
});

// CFO Review download (accepts user edits, generates Word doc) — respects geo filters
app.post('/api/reports/cfo-review/download', async (req, res) => {
    try {
        const groupId = Number(req.query.groupId || req.body.groupId);
        if (!groupId) return res.status(400).json({ error: 'groupId required' });

        // Use resolveIds which intersects group members with geo filters
        const ids = resolveIds(req);
        if (!ids || !ids.length) return res.status(400).json({ error: 'No active companies match the current filters' });

        const from = req.query.fromDate || req.body.fromDate || '2024-04-01';
        const to   = req.query.toDate   || req.body.toDate   || '2025-03-31';

        const data = buildCFOReviewData(req, ids, groupId, from, to);

        // Apply user edits from request body
        if (req.body.rating) data.rating = req.body.rating;
        if (req.body.commentary) data.commentary = req.body.commentary;
        if (req.body.adjustmentNotes != null) data.adjustmentNotes = req.body.adjustmentNotes;
        if (req.body.actionItems) data.actionItems = req.body.actionItems;

        const groupInfo = db.prepare('SELECT name FROM company_groups WHERE id = ?').get(groupId);
        const groupName = (groupInfo?.name || 'Group').replace(/\s+/g, '_');
        const filterParts = [req.query.state, req.query.city, req.query.location,
            (req.query.type && req.query.type !== 'All') ? req.query.type : ''].filter(v => v && v.trim()).map(v => v.replace(/\s+/g, '_'));
        const monthStr = monthLabel(to).replace(/\s+/g, '_');
        const filename = `CFO_Review_${groupName}${filterParts.length ? '_' + filterParts.join('_') : ''}_${monthStr}.docx`;

        await generateCFOReviewDocx(data, res, filename);
    } catch (err) {
        console.error('CFO Review download error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

// ===== TABLE VIEW ENDPOINTS =====

// P&L Statement (columnar, for table view)
app.get('/api/reports/profit-loss', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'No companies selected' });
    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';
    try {
        const pl = buildPLStatement(req, ids, from, to);

        // Inject allocation adjustment rows if dashboard-affecting rules exist
        const groupId = Number(req.query.groupId);
        if (groupId && ids.length > 1 && pl.columns) {
            const rules = getDashboardAllocRules(groupId);
            if (rules) {
                // Build per-company KPIs once (all companies in the group)
                const allUnits = ids.map(cid => {
                    const kpi = computeKPIData([cid], from, to);
                    return { companyId: cid, ...kpi };
                });

                // Snapshot pre-allocation values per company
                const preAlloc = {};
                allUnits.forEach(u => {
                    preAlloc[u.companyId] = {
                        revenue: u.revenue || 0,
                        directIncome: u.directIncome || 0,
                        indirectExpenses: u.indirectExpenses || 0,
                        indirectIncome: u.indirectIncome || 0,
                        grossProfit: u.grossProfit || 0,
                        netProfit: u.netProfit || 0,
                    };
                });

                // Apply all rules (effective period + amount handled inside)
                applyAllocRulesToUnits(allUnits, rules, from, to);

                // Build per-rule adjustment lines with per-column amounts
                const adjustmentLines = [];
                for (const rule of rules) {
                    const config = JSON.parse(rule.config || '{}');
                    const lineKey = `alloc_${rule.id}`;

                    if (rule.rule_type === 'fixed') {
                        const overlap = getEffectiveOverlap(config, from, to);
                        const amt = overlap.overlaps ? resolveFixedAmount(config, overlap.months) : 0;
                        const colAmounts = {};
                        pl.columns.forEach((col, ci) => {
                            const colIds = col._ids || [];
                            const hasSource = colIds.includes(config.source_company_id);
                            const hasTarget = colIds.includes(config.target_company_id);
                            // Source: expense goes down (negative = good for NP)
                            // Target: expense goes up (positive = bad for NP)
                            if (hasSource && hasTarget) colAmounts[ci] = 0;
                            else if (hasSource) colAmounts[ci] = -amt;
                            else if (hasTarget) colAmounts[ci] = amt;
                            else colAmounts[ci] = 0;
                        });
                        adjustmentLines.push({ key: lineKey, label: `Alloc: ${rule.rule_name}`, _allocation: true, _colAmounts: colAmounts });

                    } else if (rule.rule_type === 'ratio') {
                        // Look up the specific ledger amount from source
                        const ledgerNms = resolveLedgerNames(config);
                        const ledgerAmt = ledgerNms.length
                            ? getLedgerAmountMulti(config.source_company_id, ledgerNms, from, to)
                            : 0;
                        const targets = config.targets || [];
                        const totalRatio = targets.reduce((s, t) => s + (Number(t.ratio) || 0), 0);
                        const sourceTarget = targets.find(t => t.company_id === config.source_company_id);
                        const sourceRatio = sourceTarget ? Number(sourceTarget.ratio) : 0;
                        const redistributed = ledgerAmt - (sourceRatio / totalRatio * ledgerAmt);

                        const colAmounts = {};
                        pl.columns.forEach((col, ci) => {
                            const colIds = col._ids || [];
                            let colDelta = 0;
                            // Source loses redistributed amount
                            if (colIds.includes(config.source_company_id)) colDelta -= redistributed;
                            // Each target gains its ratio share
                            for (const t of targets) {
                                if (t.company_id === config.source_company_id) continue;
                                if (colIds.includes(t.company_id)) {
                                    colDelta += (Number(t.ratio) / totalRatio) * ledgerAmt;
                                }
                            }
                            colAmounts[ci] = colDelta;
                        });
                        adjustmentLines.push({ key: lineKey, label: `Alloc: ${rule.rule_name}`, _allocation: true, _colAmounts: colAmounts });

                    } else if (rule.rule_type === 'percent_income') {
                        const colAmounts = {};
                        const pct = (Number(config.percentage) || 0) / 100;
                        const sourceIds = config.source_company_ids || [];
                        const targetId = config.target_company_id;

                        // Compute income base per source using the specific ledger(s) if named
                        const ledgerNms = resolveLedgerNames(config);
                        const srcIncomeBases = {};
                        for (const sid of sourceIds) {
                            if (ledgerNms.length) {
                                srcIncomeBases[sid] = Math.abs(getLedgerAmountMulti(sid, ledgerNms, from, to));
                            } else {
                                const pre = preAlloc[sid];
                                srcIncomeBases[sid] = (pre?.directIncome || pre?.revenue || 0);
                            }
                        }

                        pl.columns.forEach((col, ci) => {
                            const colIds = col._ids || [];
                            let delta = 0;
                            // Source companies: show as negative (expense added)
                            for (const sid of sourceIds) {
                                if (colIds.includes(sid)) {
                                    delta -= (srcIncomeBases[sid] || 0) * pct;
                                }
                            }
                            // Target company: show as positive (income received)
                            if (colIds.includes(targetId)) {
                                delta += sourceIds.reduce((s, sid) => s + (srcIncomeBases[sid] || 0) * pct, 0);
                            }
                            colAmounts[ci] = delta;
                        });
                        adjustmentLines.push({ key: lineKey, label: `Alloc: ${rule.rule_name}`, _allocation: true, _colAmounts: colAmounts });
                    }
                }

                // Adjusted net profit per column = original NP + sum of all allocation deltas
                const adjustedNP = {};
                pl.columns.forEach((col, ci) => {
                    const colIds = col._ids || [];
                    // Start with original (pre-allocation) net profit
                    const originalNP = colIds.reduce((s, cid) => {
                        return s + (preAlloc[cid]?.netProfit || 0);
                    }, 0);
                    // Add all allocation adjustment deltas for this column
                    const allocDelta = adjustmentLines.reduce((s, line) => {
                        return s + (line._colAmounts[ci] || 0);
                    }, 0);
                    adjustedNP[ci] = originalNP + allocDelta;
                });

                pl._allocations = {
                    applied: true,
                    adjustmentLines,
                    adjustedNP,
                };
            }
        }

        // Inject writeoff adjustment rows if dashboard-affecting writeoff rules exist
        if (groupId && pl.columns) {
            const woRules = getDashboardWriteoffRules(groupId);
            if (woRules) {
                const woLines = [];
                for (const rule of woRules) {
                    const ledgerNames = JSON.parse(rule.ledger_names || '[]');
                    if (!ledgerNames.length) continue;
                    const companyIds = JSON.parse(rule.company_ids || '[]');
                    const targetIds = companyIds.length ? companyIds : (rule.company_id ? [rule.company_id] : []);

                    const colAmounts = {};
                    pl.columns.forEach((col, ci) => {
                        const colIds = col._ids || [];
                        let delta = 0;
                        for (const cid of targetIds) {
                            if (colIds.includes(cid)) {
                                const amt = resolveWriteoffAmount(rule, cid, ledgerNames, from, to);
                                delta += rule.rule_type === 'expense_addback' ? amt : -amt;
                            }
                        }
                        colAmounts[ci] = delta;
                    });
                    const typeLabel = rule.rule_type === 'expense_addback' ? 'Add-back' : 'Deduction';
                    woLines.push({
                        key: `wo_${rule.id}`,
                        label: `${typeLabel}: ${rule.rule_name}`,
                        _writeoff: true,
                        _colAmounts: colAmounts,
                    });
                }

                if (woLines.length) {
                    // Compute writeoff-adjusted NP (stacks on top of allocation adjustments if present)
                    const baseNP = pl._allocations?.adjustedNP || {};
                    const woAdjustedNP = {};
                    pl.columns.forEach((col, ci) => {
                        const colIds = col._ids || [];
                        // Start from allocation-adjusted NP if available, otherwise original NP
                        let npBase;
                        if (baseNP[ci] !== undefined) {
                            npBase = baseNP[ci];
                        } else {
                            npBase = colIds.reduce((s, cid) => {
                                const colData = col.data || {};
                                return s + (colData.netProfit || 0);
                            }, 0);
                            // Fallback: compute from column data
                            if (col.data) npBase = col.data.netProfit || 0;
                        }
                        const woDelta = woLines.reduce((s, line) => s + (line._colAmounts[ci] || 0), 0);
                        woAdjustedNP[ci] = npBase + woDelta;
                    });

                    pl._writeoffs = {
                        applied: true,
                        adjustmentLines: woLines,
                        adjustedNP: woAdjustedNP,
                    };
                }
            }
        }

        res.json(pl);
    } catch (err) {
        console.error('P&L error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Balance Sheet (grouped by primary BS groups)
app.get('/api/reports/balance-sheet', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'No companies selected' });
    const to = req.query.toDate || '2025-03-31';
    try {
        const lgMap = buildLedgerGroupMap(ids);

        // Get all BS groups with their hierarchy
        const bsGroups = db.prepare(
            `SELECT DISTINCT group_name, parent_group, dr_cr
             FROM account_groups WHERE company_id IN (${idPh(ids)}) AND bs_pl = 'BS'`
        ).all(...ids);

        // Standard Tally BS primary groups
        const BS_SECTIONS = [
            { key: 'capital',       label: 'Capital Account',     parent: 'Capital Account',       side: 'liability' },
            { key: 'reserves',      label: 'Reserves & Surplus',  parent: 'Reserves & Surplus',    side: 'liability' },
            { key: 'currentLiab',   label: 'Current Liabilities', parent: 'Current Liabilities',   side: 'liability' },
            { key: 'securedLoans',  label: 'Secured Loans',       parent: 'Secured Loans',         side: 'liability' },
            { key: 'unsecuredLoans',label: 'Unsecured Loans',     parent: 'Unsecured Loans',       side: 'liability' },
            { key: 'fixedAssets',   label: 'Fixed Assets',        parent: 'Fixed Assets',          side: 'asset' },
            { key: 'investments',   label: 'Investments',         parent: 'Investments',           side: 'asset' },
            { key: 'currentAssets', label: 'Current Assets',      parent: 'Current Assets',        side: 'asset' },
            { key: 'cashInHand',    label: 'Cash-in-Hand',        parent: 'Cash-in-Hand',          side: 'asset' },
            { key: 'bankAccounts',  label: 'Bank Accounts',       parent: 'Bank Accounts',         side: 'asset' },
            { key: 'sundryDebtors', label: 'Sundry Debtors',      parent: 'Sundry Debtors',        side: 'asset' },
            { key: 'sundryCreditors',label: 'Sundry Creditors',   parent: 'Sundry Creditors',      side: 'liability' },
            { key: 'stockInHand',   label: 'Stock-in-Hand',       parent: 'Stock-in-Hand',         side: 'asset' },
        ];

        const sections = [];
        let totalAssets = 0, totalLiabilities = 0;

        for (const sec of BS_SECTIONS) {
            const groups = getGroupTree(ids, sec.parent);
            if (!groups.length) continue;
            const closing = computeBSClosing(ids, to, groups, null, lgMap);
            // BS convention: assets are debit (negative in Tally), liabilities are credit (positive)
            const amount = sec.side === 'asset' ? -closing : closing;
            if (Math.abs(amount) < 0.01) continue; // skip zero sections
            sections.push({ label: sec.label, amount, side: sec.side, key: sec.key });
            if (sec.side === 'asset') totalAssets += amount;
            else totalLiabilities += amount;
        }

        // Add P&L (Profit) to liabilities side
        const kpi = computeKPIData(ids, getYTDStart(to), to);
        if (Math.abs(kpi.netProfit) > 0.01) {
            sections.push({ label: 'Profit & Loss A/c', amount: kpi.netProfit, side: 'liability', key: 'pnl' });
            totalLiabilities += kpi.netProfit;
        }

        res.json({
            asOfDate: to,
            sections,
            totalAssets,
            totalLiabilities,
        });
    } catch (err) {
        console.error('BS error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Cash Flow Statement (indirect method)
app.get('/api/reports/cash-flow', (req, res) => {
    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'No companies selected' });
    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';
    try {
        const lgMap = buildLedgerGroupMap(ids);
        const kpi = computeKPIData(ids, from, to);

        // Opening & closing cash/bank
        const cashGroups = getGroupTree(ids, 'Cash-in-Hand');
        const bankGroups = getGroupTree(ids, 'Bank Accounts');
        const allCashGroups = [...cashGroups, ...bankGroups];

        const closingCash = kpi.cashBankBalance;

        // Compute opening cash (as of from date - 1 day)
        const fromDate = new Date(from + 'T00:00:00');
        fromDate.setDate(fromDate.getDate() - 1);
        const openingDate = fromDate.toISOString().split('T')[0];
        const openingCashRaw = computeBSClosing(ids, openingDate, allCashGroups, null, lgMap);
        const openingCash = -openingCashRaw;

        // Operating Activities (indirect method)
        const operating = [
            { label: 'Net Profit', amount: kpi.netProfit },
            { label: 'Add: Depreciation (non-cash)', amount: 0 }, // placeholder
        ];

        // Working capital changes
        const sdGroups = getGroupTree(ids, 'Sundry Debtors');
        const scGroups = getGroupTree(ids, 'Sundry Creditors');
        const stockGroups = getGroupTree(ids, 'Stock-in-Hand');

        const closingDebtors = -(computeBSClosing(ids, to, sdGroups, null, lgMap));
        const openingDebtors = -(computeBSClosing(ids, openingDate, sdGroups, null, lgMap));
        const closingCreditors = computeBSClosing(ids, to, scGroups, null, lgMap);
        const openingCreditors = computeBSClosing(ids, openingDate, scGroups, null, lgMap);
        const closingStockBal = -(computeBSClosing(ids, to, stockGroups, null, lgMap));
        const openingStockBal = -(computeBSClosing(ids, openingDate, stockGroups, null, lgMap));

        operating.push({ label: '(Inc)/Dec in Sundry Debtors', amount: openingDebtors - closingDebtors });
        operating.push({ label: 'Inc/(Dec) in Sundry Creditors', amount: closingCreditors - openingCreditors });
        operating.push({ label: '(Inc)/Dec in Stock', amount: openingStockBal - closingStockBal });

        const operatingTotal = operating.reduce((s, r) => s + r.amount, 0);

        // Investing Activities
        const faGroups = getGroupTree(ids, 'Fixed Assets');
        const invGroups = getGroupTree(ids, 'Investments');
        const closingFA = -(computeBSClosing(ids, to, faGroups, null, lgMap));
        const openingFA = -(computeBSClosing(ids, openingDate, faGroups, null, lgMap));
        const closingInv = -(computeBSClosing(ids, to, invGroups, null, lgMap));
        const openingInv = -(computeBSClosing(ids, openingDate, invGroups, null, lgMap));

        const investing = [
            { label: '(Purchase)/Sale of Fixed Assets', amount: openingFA - closingFA },
            { label: '(Purchase)/Sale of Investments', amount: openingInv - closingInv },
        ];
        const investingTotal = investing.reduce((s, r) => s + r.amount, 0);

        // Financing Activities
        const slGroups = getGroupTree(ids, 'Secured Loans');
        const ulGroups = getGroupTree(ids, 'Unsecured Loans');
        const capGroups = getGroupTree(ids, 'Capital Account');

        const closingSL = computeBSClosing(ids, to, slGroups, null, lgMap);
        const openingSL = computeBSClosing(ids, openingDate, slGroups, null, lgMap);
        const closingUL = computeBSClosing(ids, to, ulGroups, null, lgMap);
        const openingUL = computeBSClosing(ids, openingDate, ulGroups, null, lgMap);
        const closingCap = computeBSClosing(ids, to, capGroups, null, lgMap);
        const openingCap = computeBSClosing(ids, openingDate, capGroups, null, lgMap);

        const financing = [
            { label: 'Inc/(Dec) in Secured Loans', amount: closingSL - openingSL },
            { label: 'Inc/(Dec) in Unsecured Loans', amount: closingUL - openingUL },
            { label: 'Inc/(Dec) in Capital', amount: closingCap - openingCap },
        ];
        const financingTotal = financing.reduce((s, r) => s + r.amount, 0);

        const netChange = operatingTotal + investingTotal + financingTotal;

        res.json({
            period: { from, to },
            operating, operatingTotal,
            investing, investingTotal,
            financing, financingTotal,
            netChange,
            openingCash,
            closingCash,
        });
    } catch (err) {
        console.error('CF error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ===== BUDGET ENDPOINTS =====

const BUDGET_LINES = [
    { key: 'revenue', label: 'Revenue (Sales)' },
    { key: 'directIncome', label: 'Direct Income' },
    { key: 'purchase', label: 'Purchase / COGS' },
    { key: 'directExpenses', label: 'Direct Expenses' },
    { key: 'indirectExpenses', label: 'Indirect Expenses' },
    { key: 'indirectIncome', label: 'Indirect Income' },
];

// Get budget data for a group + fiscal year
app.get('/api/budgets', (req, res) => {
    const groupId = Number(req.query.groupId);
    const year = req.query.year; // FY start year e.g. '2025' for FY 2025-26
    if (!groupId) return res.json([]);
    const fromMonth = `${year}-04`;
    const toMonth = `${Number(year) + 1}-03`;
    const rows = db.prepare(
        `SELECT * FROM budgets WHERE group_id = ? AND period_month >= ? AND period_month <= ? AND company_id IS NULL ORDER BY period_month, line_item`
    ).all(groupId, fromMonth, toMonth);
    res.json(rows);
});

// Save/update budget entries (upsert)
app.post('/api/budgets', (req, res) => {
    const { groupId, entries } = req.body; // entries: [{ period_month, line_item, amount }]
    if (!groupId || !entries || !entries.length) return res.status(400).json({ error: 'groupId and entries required' });

    const upsert = db.prepare(`
        INSERT INTO budgets (group_id, company_id, period_month, line_item, amount)
        VALUES (?, NULL, ?, ?, ?)
        ON CONFLICT(group_id, company_id, period_month, line_item)
        DO UPDATE SET amount = excluded.amount, updated_at = CURRENT_TIMESTAMP
    `);

    const tx = db.transaction(() => {
        for (const e of entries) {
            upsert.run(groupId, e.period_month, e.line_item, Number(e.amount) || 0);
        }
    });
    tx();
    res.json({ success: true, count: entries.length });
});

// Budget vs Actual variance
app.get('/api/budgets/variance', (req, res) => {
    const groupId = Number(req.query.groupId);
    const from = req.query.fromDate || '2025-04-01';
    const to   = req.query.toDate   || '2026-03-31';
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const ids = resolveGroupMemberIds(groupId);
    if (!ids || !ids.length) return res.json({ lines: [] });

    // Get actual KPIs for the period
    const actual = computeKPIData(ids, from, to);

    // Get budget totals for the period
    const fromMonth = from.substring(0, 7);
    const toMonth = to.substring(0, 7);
    const budgetRows = db.prepare(
        `SELECT line_item, SUM(amount) as total FROM budgets
         WHERE group_id = ? AND company_id IS NULL AND period_month >= ? AND period_month <= ?
         GROUP BY line_item`
    ).all(groupId, fromMonth, toMonth);
    const budgetMap = {};
    budgetRows.forEach(r => { budgetMap[r.line_item] = r.total; });

    const lines = BUDGET_LINES.map(bl => {
        const actualVal = actual[bl.key] || 0;
        const budgetVal = budgetMap[bl.key] || 0;
        const variance = actualVal - budgetVal;
        const variancePct = budgetVal ? (variance / Math.abs(budgetVal) * 100) : 0;
        // For expenses, negative variance (actual < budget) is favorable
        const isExpense = ['purchase', 'directExpenses', 'indirectExpenses'].includes(bl.key);
        const favorable = isExpense ? variance <= 0 : variance >= 0;
        return { key: bl.key, label: bl.label, actual: actualVal, budget: budgetVal, variance, variancePct, favorable };
    });

    // Add computed lines
    const actGP = (actual.revenue || 0) + (actual.directIncome || 0) - (actual.purchase || 0) - (actual.directExpenses || 0);
    const budGP = (budgetMap.revenue || 0) + (budgetMap.directIncome || 0) - (budgetMap.purchase || 0) - (budgetMap.directExpenses || 0);
    lines.push({ key: 'grossProfit', label: 'Gross Profit', actual: actGP, budget: budGP, variance: actGP - budGP, variancePct: budGP ? ((actGP - budGP) / Math.abs(budGP) * 100) : 0, favorable: actGP >= budGP, bold: true });

    const actNP = actual.netProfit || 0;
    const budNP = budGP + (budgetMap.indirectIncome || 0) - (budgetMap.indirectExpenses || 0);
    lines.push({ key: 'netProfit', label: 'Net Profit', actual: actNP, budget: budNP, variance: actNP - budNP, variancePct: budNP ? ((actNP - budNP) / Math.abs(budNP) * 100) : 0, favorable: actNP >= budNP, bold: true });

    res.json({ period: { from, to }, lines });
});

// Download budget Excel template
app.get('/api/budgets/template', async (req, res) => {
    const groupId = Number(req.query.groupId);
    const year = req.query.year || '2025';
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Budget');

    // Header row
    const months = [];
    for (let m = 4; m <= 12; m++) months.push(`${year}-${String(m).padStart(2, '0')}`);
    for (let m = 1; m <= 3; m++) months.push(`${Number(year) + 1}-${String(m).padStart(2, '0')}`);

    ws.addRow(['Line Item', ...months.map(m => { const d = new Date(m + '-01'); return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); })]);
    ws.getRow(1).font = { bold: true };

    BUDGET_LINES.forEach(bl => {
        ws.addRow([bl.label, ...months.map(() => 0)]);
    });

    // Add a hidden row with keys for import
    const keyRow = ws.addRow(['^KEYS^', ...months]);
    keyRow.hidden = true;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Budget_Template_FY${year}-${(Number(year)+1).toString().slice(-2)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
});

// Upload budget Excel
app.post('/api/budgets/upload', multer({ storage: multer.memoryStorage() }).single('file'), async (req, res) => {
    const groupId = Number(req.body.groupId);
    if (!groupId || !req.file) return res.status(400).json({ error: 'groupId and file required' });

    try {
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(req.file.buffer);
        const ws = wb.worksheets[0];

        // Find months from header row
        const headerRow = ws.getRow(1);
        const months = [];
        for (let c = 2; c <= headerRow.cellCount; c++) {
            const v = headerRow.getCell(c).value;
            if (v) months.push(String(v));
        }

        // Find keys row or use BUDGET_LINES order
        let keyMap = BUDGET_LINES.map(bl => bl.key);
        const lastRow = ws.getRow(ws.rowCount);
        if (lastRow.getCell(1).value === '^KEYS^') {
            // Template has hidden keys row - get months from it
            months.length = 0;
            for (let c = 2; c <= lastRow.cellCount; c++) {
                const v = lastRow.getCell(c).value;
                if (v) months.push(String(v));
            }
        }

        // Parse data rows (skip header, skip keys row)
        const entries = [];
        const dataRowCount = lastRow.getCell(1).value === '^KEYS^' ? ws.rowCount - 1 : ws.rowCount;
        for (let r = 2; r <= dataRowCount && r <= BUDGET_LINES.length + 1; r++) {
            const row = ws.getRow(r);
            const lineKey = keyMap[r - 2];
            if (!lineKey) continue;
            for (let c = 0; c < months.length; c++) {
                const amount = Number(row.getCell(c + 2).value) || 0;
                if (amount !== 0) {
                    entries.push({ period_month: months[c], line_item: lineKey, amount });
                }
            }
        }

        if (!entries.length) return res.json({ success: true, count: 0, message: 'No budget data found in file' });

        const upsert = db.prepare(`
            INSERT INTO budgets (group_id, company_id, period_month, line_item, amount)
            VALUES (?, NULL, ?, ?, ?)
            ON CONFLICT(group_id, company_id, period_month, line_item)
            DO UPDATE SET amount = excluded.amount, updated_at = CURRENT_TIMESTAMP
        `);
        const tx = db.transaction(() => { for (const e of entries) upsert.run(groupId, e.period_month, e.line_item, e.amount); });
        tx();

        res.json({ success: true, count: entries.length });
    } catch (err) {
        console.error('Budget upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/download', async (req, res) => {
    const format = req.query.format;
    if (!format || !['pdf', 'xlsx', 'docx'].includes(format)) {
        return res.status(400).json({ error: 'format must be pdf, xlsx, or docx' });
    }

    const ids = resolveIds(req);
    if (!ids) return res.status(400).json({ error: 'Geographic filters required' });

    const from = req.query.fromDate || '2024-04-01';
    const to   = req.query.toDate   || '2025-03-31';

    try {
        // Build columnar P&L statement (computes KPI per entity type + total)
        const plStatement = buildPLStatement(req, ids, from, to);

        // Assemble report data
        const reportData = {
            title: 'TallyVision MIS Report',
            filterLabel: buildFilterLabel(req.query),
            period: { from, to },
            generatedAt: new Date().toISOString(),
            plStatement,
        };

        const filename = buildReportFilename(req.query, format);

        if (format === 'docx') {
            const cfoData = buildCFOInsightsData(req, ids, from, to);
            await generateDocx(cfoData, res, filename);
        } else if (format === 'pdf') {
            generatePDF(reportData, res, filename);
        } else {
            await generateExcel(reportData, res, filename);
        }
    } catch (err) {
        console.error('Report generation error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to generate report: ' + err.message });
        }
    }
});

// ===== EXCEL UPLOAD ENDPOINTS =====

// List upload categories
app.get('/api/upload/categories', (req, res) => {
    const cats = db.prepare(
        'SELECT slug, display_name, description, expected_columns FROM upload_categories WHERE is_active = 1 ORDER BY sort_order'
    ).all();
    res.json(cats.map(c => ({ ...c, expected_columns: JSON.parse(c.expected_columns || '[]') })));
});

// Upload an Excel file
app.post('/api/upload/excel', upload.single('file'), async (req, res) => {
    try {
        const { category, periodMonth } = req.body;
        const companyId = req.body.companyId && req.body.companyId !== '' && req.body.companyId !== '0'
            ? Number(req.body.companyId) : null;
        if (!category || !periodMonth || !req.file) {
            if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'category, periodMonth, and file are required' });
        }

        // Validate category
        const cat = db.prepare('SELECT slug FROM upload_categories WHERE slug = ?').get(category);
        if (!cat) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Invalid category' });
        }

        // Parse Excel using ExcelJS
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const worksheet = workbook.worksheets[0];
        if (!worksheet || worksheet.rowCount < 2) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Excel file is empty or has no data rows' });
        }

        // Extract headers from row 1
        const headers = [];
        worksheet.getRow(1).eachCell((cell, colNum) => {
            headers[colNum - 1] = String(cell.value && cell.value.richText
                ? cell.value.richText.map(r => r.text).join('')
                : (cell.value || '')).trim();
        });

        // Extract data rows (row 2+)
        const rows = [];
        worksheet.eachRow((row, rowNum) => {
            if (rowNum === 1) return;
            const rowObj = {};
            row.eachCell((cell, colNum) => {
                const key = headers[colNum - 1] || `col_${colNum}`;
                if (cell.type === 4 /* Date */) {
                    rowObj[key] = cell.value instanceof Date
                        ? cell.value.toISOString().slice(0, 10) : cell.value;
                } else if (cell.value && cell.value.richText) {
                    rowObj[key] = cell.value.richText.map(r => r.text).join('');
                } else {
                    rowObj[key] = cell.value;
                }
            });
            if (Object.values(rowObj).some(v => v !== null && v !== undefined && v !== '')) {
                rows.push(rowObj);
            }
        });

        // Move file to permanent location
        const storedFilename = `${uuidv4()}_${req.file.originalname}`;
        const subDir = companyId ? String(companyId) : '_all';
        const companyDir = path.join(UPLOAD_DIR, subDir, category);
        fs.mkdirSync(companyDir, { recursive: true });
        const finalPath = path.join(companyDir, storedFilename);
        fs.renameSync(req.file.path, finalPath);

        // Replace: delete old upload for same company+category+month
        const existing = db.prepare(
            companyId
                ? 'SELECT id, stored_filename FROM excel_uploads WHERE company_id = ? AND category = ? AND period_month = ?'
                : 'SELECT id, stored_filename FROM excel_uploads WHERE company_id IS NULL AND category = ? AND period_month = ?'
        ).get(...(companyId ? [companyId, category, periodMonth] : [category, periodMonth]));

        const replaceTransaction = db.transaction(() => {
            if (existing) {
                db.prepare('DELETE FROM excel_data WHERE upload_id = ?').run(existing.id);
                db.prepare('DELETE FROM excel_uploads WHERE id = ?').run(existing.id);
                const oldPath = path.join(UPLOAD_DIR, subDir, category, existing.stored_filename);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }

            const result = db.prepare(`
                INSERT INTO excel_uploads (company_id, category, period_month, original_filename, stored_filename, file_size, sheet_name, row_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(companyId, category, periodMonth, req.file.originalname, storedFilename,
                   req.file.size, worksheet.name, rows.length);

            const uploadId = result.lastInsertRowid;
            const insertRow = db.prepare(
                'INSERT INTO excel_data (upload_id, company_id, period_month, category, row_num, row_data) VALUES (?, ?, ?, ?, ?, ?)'
            );
            rows.forEach((row, idx) => {
                insertRow.run(uploadId, companyId, periodMonth, category, idx + 1, JSON.stringify(row));
            });
            return uploadId;
        });

        const uploadId = replaceTransaction();

        res.json({
            success: true, uploadId,
            filename: req.file.originalname,
            rowCount: rows.length, headers,
            sheetName: worksheet.name,
            replaced: !!existing
        });
    } catch (err) {
        if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
});

// List uploads (filterable)
app.get('/api/upload/list', (req, res) => {
    const { companyId, category, periodMonth } = req.query;
    let q = `SELECT u.*, c.name as company_name, uc.display_name as category_name
             FROM excel_uploads u
             LEFT JOIN companies c ON c.id = u.company_id
             JOIN upload_categories uc ON uc.slug = u.category
             WHERE 1=1`;
    const params = [];
    if (companyId) { q += ' AND u.company_id = ?'; params.push(companyId); }
    if (category)  { q += ' AND u.category = ?';   params.push(category); }
    if (periodMonth) { q += ' AND u.period_month = ?'; params.push(periodMonth); }
    q += ' ORDER BY u.period_month DESC, u.uploaded_at DESC';
    res.json(db.prepare(q).all(...params));
});

// Grid status: upload status for all months of a category + company
app.get('/api/upload/grid', (req, res) => {
    const { category, companyId } = req.query;
    if (!category) return res.status(400).json({ error: 'category is required' });

    let q, params;
    if (companyId) {
        q = `SELECT id, period_month, original_filename, file_size, row_count, uploaded_at
             FROM excel_uploads WHERE category = ? AND company_id = ?
             ORDER BY period_month`;
        params = [category, Number(companyId)];
    } else {
        q = `SELECT id, period_month, original_filename, file_size, row_count, uploaded_at
             FROM excel_uploads WHERE category = ? AND company_id IS NULL
             ORDER BY period_month`;
        params = [category];
    }
    const rows = db.prepare(q).all(...params);
    const grid = {};
    for (const r of rows) {
        grid[r.period_month] = {
            id: r.id,
            filename: r.original_filename,
            size: r.file_size,
            rowCount: r.row_count,
            uploadedAt: r.uploaded_at
        };
    }
    res.json(grid);
});

// Get parsed data for an upload
app.get('/api/upload/data/:uploadId', (req, res) => {
    const upl = db.prepare('SELECT * FROM excel_uploads WHERE id = ?').get(req.params.uploadId);
    if (!upl) return res.status(404).json({ error: 'Upload not found' });
    const rows = db.prepare('SELECT row_num, row_data FROM excel_data WHERE upload_id = ? ORDER BY row_num').all(upl.id);
    res.json({ upload: upl, data: rows.map(r => ({ row_num: r.row_num, ...JSON.parse(r.row_data) })) });
});

// Delete an upload
app.delete('/api/upload/:uploadId', (req, res) => {
    const upl = db.prepare('SELECT * FROM excel_uploads WHERE id = ?').get(req.params.uploadId);
    if (!upl) return res.status(404).json({ error: 'Upload not found' });
    db.transaction(() => {
        db.prepare('DELETE FROM excel_data WHERE upload_id = ?').run(upl.id);
        db.prepare('DELETE FROM excel_uploads WHERE id = ?').run(upl.id);
    })();
    const subDir = upl.company_id ? String(upl.company_id) : '_all';
    const filePath = path.join(UPLOAD_DIR, subDir, upl.category, upl.stored_filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ success: true });
});

// Analytics from uploaded Excel data
app.get('/api/upload/analytics', (req, res) => {
    try {
        const { category, fromDate, toDate } = req.query;
        if (!category || !fromDate || !toDate) {
            return res.status(400).json({ error: 'category, fromDate, toDate required' });
        }

        // Resolve company IDs from geo filters
        const companyIds = resolveIds(req);

        // Build list of period months between fromDate and toDate
        const periodMonths = [];
        const startD = new Date(fromDate + 'T00:00:00');
        const endD = new Date(toDate + 'T00:00:00');
        let cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
        while (cur <= endD) {
            periodMonths.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
            cur.setMonth(cur.getMonth() + 1);
        }
        if (!periodMonths.length) return res.json({ hasData: false });

        // Query excel_data rows for matching category + period months + companies
        const monthPh = periodMonths.map(() => '?').join(',');
        let q, params;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            q = `SELECT row_data FROM excel_data WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
            params = [category, ...periodMonths, ...companyIds];
        } else {
            q = `SELECT row_data FROM excel_data WHERE category = ? AND period_month IN (${monthPh})`;
            params = [category, ...periodMonths];
        }
        const rawRows = db.prepare(q).all(...params);
        if (!rawRows.length) return res.json({ hasData: false });

        // Count uploads
        let uq, uParams;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            uq = `SELECT COUNT(*) as cnt FROM excel_uploads WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
            uParams = [category, ...periodMonths, ...companyIds];
        } else {
            uq = `SELECT COUNT(*) as cnt FROM excel_uploads WHERE category = ? AND period_month IN (${monthPh})`;
            uParams = [category, ...periodMonths];
        }
        const uploadCount = db.prepare(uq).get(...uParams).cnt;

        // Get actual period months that have uploads
        let amq, amParams;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            amq = `SELECT DISTINCT period_month FROM excel_uploads WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL) ORDER BY period_month`;
            amParams = [category, ...periodMonths, ...companyIds];
        } else {
            amq = `SELECT DISTINCT period_month FROM excel_uploads WHERE category = ? AND period_month IN (${monthPh}) ORDER BY period_month`;
            amParams = [category, ...periodMonths];
        }
        const actualMonths = db.prepare(amq).all(...amParams).map(r => r.period_month);

        // Parse all rows
        const rows = rawRows.map(r => JSON.parse(r.row_data));

        // Helper: get numeric value, skip formula objects
        const num = (v) => {
            if (v === null || v === undefined || v === '') return 0;
            if (typeof v === 'object' && v.formula) return Number(v.result) || 0;
            return Number(v) || 0;
        };

        // Separate order-level rows (have Bill Date) vs line-item rows
        const orderRows = rows.filter(r => {
            const bd = r['Bill Date'];
            return bd && bd !== '' && typeof bd !== 'object';
        });

        // KPI computations (from order-level rows)
        let totalBilled = 0, totalCollections = 0, totalRefunds = 0, totalReturns = 0;
        const patientNames = new Set();

        for (const r of orderRows) {
            totalBilled += num(r['Billed']);
            totalCollections += num(r['Paid']);
            const refund = num(r['Refund']);
            totalRefunds += refund;
            if (refund > 0) totalReturns++;
            const name = (r['Name'] || '').toString().trim();
            if (name) patientNames.add(name.toLowerCase());
        }

        const totalOrders = orderRows.length;
        const uniquePatients = patientNames.size;
        const avgBillingValue = totalOrders ? totalBilled / totalOrders : 0;
        const collectionRate = totalBilled ? (totalCollections / totalBilled) * 100 : 0;

        // Department-wise Performance (from ALL rows including line items)
        const deptMap = {};
        for (const r of rows) {
            const dept = (r['Dept.'] || r['Dept'] || '').toString().trim();
            if (!dept) continue;
            const price = num(r['Item Price']);
            if (!deptMap[dept]) deptMap[dept] = { total: 0, count: 0 };
            deptMap[dept].total += price;
            deptMap[dept].count++;
        }
        const departments = Object.entries(deptMap)
            .map(([name, d]) => ({ name, total: d.total, count: d.count }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 15);

        // Helper: parse date from DD-MM-YYYY or YYYY-MM-DD or Date object
        function parseDate(val) {
            if (!val) return null;
            if (val instanceof Date) return val;
            const s = String(val).trim();
            // DD-MM-YYYY or DD/MM/YYYY
            const dmyMatch = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
            if (dmyMatch) return new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1]));
            // YYYY-MM-DD
            const isoMatch = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
            if (isoMatch) return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
            const d = new Date(s);
            return isNaN(d.getTime()) ? null : d;
        }

        // Weekly Billing Trend (from order-level rows)
        const weekMap = {};
        for (const r of orderRows) {
            let bd = r['Bill Date'];
            if (!bd) continue;
            const d = parseDate(bd);
            if (!d) continue;

            // Get ISO week start (Monday)
            const day = d.getDay();
            const diff = d.getDate() - day + (day === 0 ? -6 : 1);
            const weekStart = new Date(d);
            weekStart.setDate(diff);
            const wsKey = weekStart.toISOString().slice(0, 10);

            // Week label based on week-start date: "30 Dec", "06 Jan" etc.
            const wsDay = String(weekStart.getDate()).padStart(2, '0');
            const wsMonth = weekStart.toLocaleString('en-IN', { month: 'short' });
            const label = `${wsDay} ${wsMonth}`;

            if (!weekMap[wsKey]) weekMap[wsKey] = { label, weekStart: wsKey, billed: 0, collected: 0 };
            weekMap[wsKey].billed += num(r['Billed']);
            weekMap[wsKey].collected += num(r['Paid']);
        }
        const weeklyTrend = Object.values(weekMap).sort((a, b) => a.weekStart.localeCompare(b.weekStart));

        // Doctor-wise Revenue (from ALL rows)
        const docMap = {};
        for (const r of rows) {
            const doc = (r['Billed Doctor'] || '').toString().trim();
            if (!doc) continue;
            const price = num(r['Item Price']);
            if (!docMap[doc]) docMap[doc] = { total: 0, count: 0 };
            docMap[doc].total += price;
            docMap[doc].count++;
        }
        const doctors = Object.entries(docMap)
            .map(([name, d]) => ({ name, total: d.total, itemCount: d.count }))
            .sort((a, b) => b.total - a.total);

        res.json({
            hasData: true,
            periodMonths: actualMonths,
            uploadCount,
            kpis: {
                totalBilled: Math.round(totalBilled),
                totalCollections: Math.round(totalCollections),
                collectionRate: Math.round(collectionRate * 10) / 10,
                totalOrders,
                uniquePatients,
                avgBillingValue: Math.round(avgBillingValue),
                totalReturns,
                totalRefunds: Math.round(totalRefunds)
            },
            departments,
            weeklyTrend,
            doctors
        });
    } catch (err) {
        console.error('Upload analytics error:', err);
        res.status(500).json({ error: 'Analytics failed: ' + err.message });
    }
});

// ===== CLOSING STOCK ANALYTICS =====
app.get('/api/upload/closing-stock-analytics', (req, res) => {
    try {
        const { fromDate, toDate } = req.query;
        if (!fromDate || !toDate) {
            return res.status(400).json({ error: 'fromDate, toDate required' });
        }
        const companyIds = resolveIds(req);

        // Build period months
        const periodMonths = [];
        const startD = new Date(fromDate + 'T00:00:00');
        const endD = new Date(toDate + 'T00:00:00');
        let cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
        while (cur <= endD) {
            periodMonths.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
            cur.setMonth(cur.getMonth() + 1);
        }
        if (!periodMonths.length) return res.json({ hasData: false });

        const monthPh = periodMonths.map(() => '?').join(',');
        let q, params;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            q = `SELECT period_month, row_data FROM excel_data WHERE category = 'closing_stock' AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
            params = [...periodMonths, ...companyIds];
        } else {
            q = `SELECT period_month, row_data FROM excel_data WHERE category = 'closing_stock' AND period_month IN (${monthPh})`;
            params = [...periodMonths];
        }
        const rawRows = db.prepare(q).all(...params);
        if (!rawRows.length) return res.json({ hasData: false });

        // Upload count
        let uq, uParams;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            uq = `SELECT COUNT(*) as cnt FROM excel_uploads WHERE category = 'closing_stock' AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
            uParams = [...periodMonths, ...companyIds];
        } else {
            uq = `SELECT COUNT(*) as cnt FROM excel_uploads WHERE category = 'closing_stock' AND period_month IN (${monthPh})`;
            uParams = [...periodMonths];
        }
        const uploadCount = db.prepare(uq).get(...uParams).cnt;

        // Actual months present
        let amq, amParams;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            amq = `SELECT DISTINCT period_month FROM excel_uploads WHERE category = 'closing_stock' AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL) ORDER BY period_month`;
            amParams = [...periodMonths, ...companyIds];
        } else {
            amq = `SELECT DISTINCT period_month FROM excel_uploads WHERE category = 'closing_stock' AND period_month IN (${monthPh}) ORDER BY period_month`;
            amParams = [...periodMonths];
        }
        const actualMonths = db.prepare(amq).all(...amParams).map(r => r.period_month);

        const num = (v) => {
            if (v === null || v === undefined || v === '') return 0;
            if (typeof v === 'number') return v;
            if (typeof v === 'object' && v.formula) return Number(v.result) || 0;
            return Number(v) || 0;
        };

        const today = new Date();
        const threeMonthsFromNow = new Date(today);
        threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);

        // Parse expiry date (DD/MM/YYYY or YYYY-MM-DD or similar)
        function parseDate(str) {
            if (!str) return null;
            const s = String(str).trim();
            // DD/MM/YYYY
            const parts = s.split('/');
            if (parts.length === 3) {
                const d = parseInt(parts[0], 10);
                const m = parseInt(parts[1], 10) - 1;
                const y = parseInt(parts[2], 10);
                if (!isNaN(d) && !isNaN(m) && !isNaN(y)) return new Date(y, m, d);
            }
            // Fallback
            const dt = new Date(s);
            return isNaN(dt.getTime()) ? null : dt;
        }

        // Category detection from product name
        const categoryRegex = /^(TAB|CAP|INJ|SYP|CRM|GEL|DRP|OIN|LOT|PWD|SUP|LIQ|SOL|SUS|SPR|IHL|SAC|PAS|GRN|EYE|EAR|NAS|TUB|BAG|KIT|STR|BAR|WAX|POW|AMP|VIA|PEN|DEV|BND|RSP|NEB|ADS|SHP|FMW|ORS|LOZ|CHW|GUM)/i;

        // Helper: parse one raw row into a normalized object (or null to skip)
        function parseStockRow(raw) {
            const row = JSON.parse(raw.row_data);
            const keys = Object.keys(row);
            const productName = (row[keys[0]] || '').toString().trim();
            if (!productName || productName.length < 2) return null;
            if (/^(period|page|printed|address|report|sl\.?\s*no|sr\.?\s*no|s\.no|product)/i.test(productName)) return null;
            const avlQty = num(row.col_8);
            if (avlQty <= 0) return null;
            return {
                productName,
                manufacturer: (row.col_3 || '').toString().trim(),
                stockist: (row.col_4 || '').toString().trim(),
                batchNo: (row.col_5 || '').toString().trim(),
                receivedDateStr: (row.col_6 || '').toString().trim(),
                expiryDateStr: (row.col_7 || '').toString().trim(),
                avlQty,
                purchaseValue: num(row.col_12),
                stockValue: num(row.col_13),
                periodMonth: raw.period_month
            };
        }

        // ── Closing stock is a SNAPSHOT, not cumulative.
        //    KPIs / charts / tables use ONLY the latest month's data.
        //    Monthly comparison processes each month independently.

        // Determine the latest available month (closest to toDate)
        const latestMonth = actualMonths[actualMonths.length - 1];

        // ── 1. Build monthly comparison (each month processed independently)
        const monthlyMap = {};
        for (const raw of rawRows) {
            const r = parseStockRow(raw);
            if (!r) continue;
            const pm = r.periodMonth;
            if (!monthlyMap[pm]) monthlyMap[pm] = { totalStockValue: 0, totalPurchaseValue: 0, activeBatches: 0, activeSKUs: new Set() };
            monthlyMap[pm].totalStockValue += r.stockValue;
            monthlyMap[pm].totalPurchaseValue += r.purchaseValue;
            monthlyMap[pm].activeBatches++;
            monthlyMap[pm].activeSKUs.add(r.productName);
        }

        // ── 2. Filter to ONLY the latest month for main analysis
        const latestRows = rawRows.filter(r => r.period_month === latestMonth);

        // Aggregation (latest month only)
        let totalStockValue = 0, totalPurchaseValue = 0, activeSKUs = new Set(), totalBatches = 0;
        let expiredStockValue = 0, expiredBatchCount = 0;
        let nearExpiryStockValue = 0, nearExpiryBatchCount = 0;
        let slowMovingValue = 0, slowMovingBatchCount = 0;
        const oneYearAgo = new Date(today);
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        const stockistMap = {};
        const mfgMap = {};
        const categoryMap = {};
        const expiredItems = [];
        const nearExpiryItems = [];
        const slowMovingItems = [];

        for (const raw of latestRows) {
            const r = parseStockRow(raw);
            if (!r) continue;

            const expiryDate = parseDate(r.expiryDateStr);
            const receivedDate = parseDate(r.receivedDateStr);

            totalStockValue += r.stockValue;
            totalPurchaseValue += r.purchaseValue;
            activeSKUs.add(r.productName);
            totalBatches++;

            // Expired
            const isExpired = expiryDate && expiryDate < today;
            const isNearExpiry = expiryDate && !isExpired && expiryDate <= threeMonthsFromNow;

            if (isExpired) {
                expiredStockValue += r.stockValue;
                expiredBatchCount++;
                expiredItems.push({ product: r.productName, manufacturer: r.manufacturer, batchNo: r.batchNo, expiryDate: r.expiryDateStr, avlQty: r.avlQty, stockValue: r.stockValue });
            }
            if (isNearExpiry) {
                nearExpiryStockValue += r.stockValue;
                nearExpiryBatchCount++;
                nearExpiryItems.push({ product: r.productName, manufacturer: r.manufacturer, batchNo: r.batchNo, expiryDate: r.expiryDateStr, avlQty: r.avlQty, stockValue: r.stockValue, expiryDt: expiryDate });
            }

            // Slow-moving (received > 1 year ago)
            if (receivedDate && receivedDate < oneYearAgo) {
                slowMovingValue += r.stockValue;
                slowMovingBatchCount++;
                slowMovingItems.push({ product: r.productName, manufacturer: r.manufacturer, receivedDate: r.receivedDateStr, avlQty: r.avlQty, stockValue: r.stockValue });
            }

            // Stockist
            if (r.stockist) {
                if (!stockistMap[r.stockist]) stockistMap[r.stockist] = { stockValue: 0, batchCount: 0 };
                stockistMap[r.stockist].stockValue += r.stockValue;
                stockistMap[r.stockist].batchCount++;
            }

            // Manufacturer
            if (r.manufacturer) {
                if (!mfgMap[r.manufacturer]) mfgMap[r.manufacturer] = { stockValue: 0, batchCount: 0 };
                mfgMap[r.manufacturer].stockValue += r.stockValue;
                mfgMap[r.manufacturer].batchCount++;
            }

            // Product category
            const catMatch = r.productName.match(categoryRegex);
            const cat = catMatch ? catMatch[1].toUpperCase() : 'OTHER';
            if (!categoryMap[cat]) categoryMap[cat] = { stockValue: 0, count: 0 };
            categoryMap[cat].stockValue += r.stockValue;
            categoryMap[cat].count++;
        }

        // Sort and limit
        const topStockists = Object.entries(stockistMap)
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.stockValue - a.stockValue)
            .slice(0, 15);

        const topManufacturers = Object.entries(mfgMap)
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.stockValue - a.stockValue)
            .slice(0, 15);

        const categoryBreakdown = Object.entries(categoryMap)
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.stockValue - a.stockValue);

        // Top expired items by stockValue
        expiredItems.sort((a, b) => b.stockValue - a.stockValue);
        const topExpired = expiredItems.slice(0, 30);

        // Near-expiry items sorted by soonest
        nearExpiryItems.sort((a, b) => (a.expiryDt?.getTime() || 0) - (b.expiryDt?.getTime() || 0));
        const topNearExpiry = nearExpiryItems.slice(0, 30).map(({ expiryDt, ...rest }) => rest);

        // Slow-moving by stockValue
        slowMovingItems.sort((a, b) => b.stockValue - a.stockValue);
        const topSlowMoving = slowMovingItems.slice(0, 30);

        // Monthly comparison sorted (each month independent)
        const monthlyComparison = Object.entries(monthlyMap)
            .map(([month, v]) => ({ month, totalStockValue: v.totalStockValue, totalPurchaseValue: v.totalPurchaseValue, activeBatches: v.activeBatches, activeSKUs: v.activeSKUs.size }))
            .sort((a, b) => a.month.localeCompare(b.month));

        const marginPct = totalStockValue > 0 ? ((totalStockValue - totalPurchaseValue) / totalStockValue) * 100 : 0;
        const safeStockValue = totalStockValue - expiredStockValue - nearExpiryStockValue;

        res.json({
            hasData: true,
            periodMonths: actualMonths,
            latestMonth,
            uploadCount,
            kpis: {
                totalStockValue: Math.round(totalStockValue),
                totalPurchaseValue: Math.round(totalPurchaseValue),
                marginPct: Math.round(marginPct * 10) / 10,
                activeSKUs: activeSKUs.size,
                totalBatches,
                expiredStockValue: Math.round(expiredStockValue),
                expiredBatchCount,
                nearExpiryStockValue: Math.round(nearExpiryStockValue),
                nearExpiryBatchCount,
                slowMovingValue: Math.round(slowMovingValue),
                slowMovingBatchCount,
                safeStockValue: Math.round(safeStockValue)
            },
            topStockists,
            topManufacturers,
            categoryBreakdown,
            expiredItems: topExpired,
            nearExpiryItems: topNearExpiry,
            slowMovingItems: topSlowMoving,
            monthlyComparison
        });
    } catch (err) {
        console.error('Closing stock analytics error:', err);
        res.status(500).json({ error: 'Analytics failed: ' + err.message });
    }
});

// ===== PHARMA ANALYTICS =====
app.get('/api/upload/pharma-analytics', (req, res) => {
    try {
        const { category, fromDate, toDate } = req.query;
        if (!category || !fromDate || !toDate) {
            return res.status(400).json({ error: 'category, fromDate, toDate required' });
        }
        const companyIds = resolveIds(req);

        // Build period months
        const periodMonths = [];
        const startD = new Date(fromDate + 'T00:00:00');
        const endD = new Date(toDate + 'T00:00:00');
        let cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
        while (cur <= endD) {
            periodMonths.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
            cur.setMonth(cur.getMonth() + 1);
        }
        if (!periodMonths.length) return res.json({ hasData: false });

        const monthPh = periodMonths.map(() => '?').join(',');
        let q, params;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            q = `SELECT period_month, row_data FROM excel_data WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
            params = [category, ...periodMonths, ...companyIds];
        } else {
            q = `SELECT period_month, row_data FROM excel_data WHERE category = ? AND period_month IN (${monthPh})`;
            params = [category, ...periodMonths];
        }
        const rawRows = db.prepare(q).all(...params);
        if (!rawRows.length) return res.json({ hasData: false });

        // Upload count + actual months
        let uq, uParams;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            uq = `SELECT COUNT(*) as cnt FROM excel_uploads WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL)`;
            uParams = [category, ...periodMonths, ...companyIds];
        } else {
            uq = `SELECT COUNT(*) as cnt FROM excel_uploads WHERE category = ? AND period_month IN (${monthPh})`;
            uParams = [category, ...periodMonths];
        }
        const uploadCount = db.prepare(uq).get(...uParams).cnt;

        let amq, amParams;
        if (companyIds && companyIds.length) {
            const cPh = companyIds.map(() => '?').join(',');
            amq = `SELECT DISTINCT period_month FROM excel_uploads WHERE category = ? AND period_month IN (${monthPh}) AND (company_id IN (${cPh}) OR company_id IS NULL) ORDER BY period_month`;
            amParams = [category, ...periodMonths, ...companyIds];
        } else {
            amq = `SELECT DISTINCT period_month FROM excel_uploads WHERE category = ? AND period_month IN (${monthPh}) ORDER BY period_month`;
            amParams = [category, ...periodMonths];
        }
        const actualMonths = db.prepare(amq).all(...amParams).map(r => r.period_month);

        // Normalize pharma rows - handle clean and messy formats
        const num = (v) => {
            if (v === null || v === undefined || v === '') return 0;
            if (typeof v === 'number') return v;
            if (typeof v === 'object' && v.formula) return Number(v.result) || 0;
            return Number(v) || 0;
        };

        function normalizePharmaRow(row) {
            if ('Sales Amount' in row) {
                // Clean format (Bangalore/Chennai)
                return {
                    billNo: String(row['Bill No'] || ''),
                    billDate: String(row['Bill Date'] || ''),
                    drugName: String(row['Drug Name'] || ''),
                    qty: num(row['Qty']),
                    salesAmount: num(row['Sales Amount']),
                    purchaseAmount: num(row['Purchase Amount']),
                    referredBy: (row['Referred by'] || '').toString().trim()
                };
            }
            if ('col_3' in row && typeof row.col_9 === 'number') {
                // Messy format (Hyderabad) - data row
                const keys = Object.keys(row);
                return {
                    billNo: String(row[keys[0]] || ''),
                    billDate: String(row[keys[1]] || ''),
                    drugName: String(row.col_3 || ''),
                    qty: num(row.col_6),
                    salesAmount: num(row.col_9),
                    purchaseAmount: num(row.col_13),
                    referredBy: ''
                };
            }
            return null; // Skip header/info rows
        }

        // Process all rows
        let totalSalesAmount = 0, totalGrossProfit = 0, totalQty = 0;
        const billSet = new Set();
        const monthMap = {};   // period_month → { sales, profit }
        const drugRevMap = {}; // drugName → { total, qty }
        const drugProfMap = {}; // drugName → { profit, sales, purchase }
        const docMap = {};     // referredBy → { total, billCount }

        for (const raw of rawRows) {
            const row = JSON.parse(raw.row_data);
            const n = normalizePharmaRow(row);
            if (!n) continue;

            const sales = n.salesAmount;
            const purchase = n.purchaseAmount;
            const gp = sales - purchase;

            totalSalesAmount += sales;
            totalGrossProfit += gp;
            totalQty += n.qty;

            if (n.billNo) billSet.add(`${n.billNo}|${n.billDate}`);

            // Monthly trend
            const pm = raw.period_month;
            if (!monthMap[pm]) monthMap[pm] = { sales: 0, profit: 0 };
            monthMap[pm].sales += sales;
            monthMap[pm].profit += gp;

            // Drug revenue
            if (n.drugName) {
                if (!drugRevMap[n.drugName]) drugRevMap[n.drugName] = { total: 0, qty: 0 };
                drugRevMap[n.drugName].total += sales;
                drugRevMap[n.drugName].qty += n.qty;

                if (!drugProfMap[n.drugName]) drugProfMap[n.drugName] = { profit: 0, sales: 0, purchase: 0 };
                drugProfMap[n.drugName].profit += gp;
                drugProfMap[n.drugName].sales += sales;
                drugProfMap[n.drugName].purchase += purchase;
            }

            // Doctor revenue
            if (n.referredBy) {
                if (!docMap[n.referredBy]) docMap[n.referredBy] = { total: 0, billCount: 0 };
                docMap[n.referredBy].total += sales;
                docMap[n.referredBy].billCount++;
            }
        }

        const uniqueBills = billSet.size;
        const avgBillValue = uniqueBills ? totalSalesAmount / uniqueBills : 0;
        const profitMarginPct = totalSalesAmount ? (totalGrossProfit / totalSalesAmount) * 100 : 0;

        const monthlyTrend = actualMonths.map(m => ({
            month: m,
            sales: Math.round((monthMap[m]?.sales || 0) * 100) / 100,
            profit: Math.round((monthMap[m]?.profit || 0) * 100) / 100
        }));

        const topDrugsByRevenue = Object.entries(drugRevMap)
            .map(([name, d]) => ({ name, total: Math.round(d.total * 100) / 100, qty: d.qty }))
            .sort((a, b) => b.total - a.total).slice(0, 20);

        const topDrugsByProfit = Object.entries(drugProfMap)
            .map(([name, d]) => ({ name, profit: Math.round(d.profit * 100) / 100, sales: Math.round(d.sales * 100) / 100, purchase: Math.round(d.purchase * 100) / 100 }))
            .sort((a, b) => b.profit - a.profit).slice(0, 20);

        const doctorRevenue = Object.entries(docMap)
            .map(([name, d]) => ({ name, total: Math.round(d.total * 100) / 100, billCount: d.billCount }))
            .sort((a, b) => b.total - a.total).slice(0, 20);

        res.json({
            hasData: true,
            periodMonths: actualMonths,
            uploadCount,
            kpis: {
                totalSalesAmount: Math.round(totalSalesAmount),
                computedGrossProfit: Math.round(totalGrossProfit),
                profitMarginPct: Math.round(profitMarginPct * 10) / 10,
                totalQtySold: totalQty,
                avgBillValue: Math.round(avgBillValue),
                uniqueBills
            },
            monthlyTrend,
            topDrugsByRevenue,
            topDrugsByProfit,
            doctorRevenue
        });
    } catch (err) {
        console.error('Pharma analytics error:', err);
        res.status(500).json({ error: 'Pharma analytics failed: ' + err.message });
    }
});

// ===== MIGRATIONS =====
// One-time: convert fixed allocation amounts from annual to monthly (runs across all client DBs)
try {
    const groups = masterDb.prepare('SELECT id FROM company_groups').all();
    for (const g of groups) {
        const cdb = dbManager.getClientDb(g.id);
        const fixedRules = cdb.prepare("SELECT id, config FROM allocation_rules WHERE rule_type = 'fixed'").all();
        for (const r of fixedRules) {
            const cfg = JSON.parse(r.config || '{}');
            if (cfg.amount && !cfg._migrated_monthly) {
                cfg.amount = cfg.amount / 12;
                cfg._migrated_monthly = true;
                cdb.prepare("UPDATE allocation_rules SET config = ? WHERE id = ?").run(JSON.stringify(cfg), r.id);
                console.log(`  Migrated fixed rule ${r.id}: annual ${cfg.amount * 12} → monthly ${cfg.amount}`);
            }
        }
    }
} catch (e) { console.error('Migration error:', e.message); }

// ===== CLOUD PUBLISH =====
// Streams local SQLite data to the cloud PostgreSQL instance
app.post('/api/cloud/publish', async (req, res) => {
    const { cloudUrl, apiKey, companyIds } = req.body;
    if (!cloudUrl || !apiKey || !companyIds || !companyIds.length) {
        return res.status(400).json({ error: 'cloudUrl, apiKey, and companyIds are required' });
    }

    // Stream progress updates via newline-delimited JSON
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    function send(obj) { res.write(JSON.stringify(obj) + '\n'); }

    const TABLES_TO_PUSH = [
        'companies', 'account_groups', 'ledgers', 'trial_balance', 'profit_loss',
        'balance_sheet', 'vouchers', 'stock_summary', 'stock_item_ledger',
        'bills_outstanding', 'cost_centres', 'cost_allocations', 'gst_entries',
        'payroll_entries', 'company_groups', 'company_group_members',
        'allocation_rules', 'writeoff_rules', 'budgets', 'client_users',
        'client_company_access', 'app_settings'
    ];

    // Tables that have company_id column
    const COMPANY_SCOPED = new Set([
        'account_groups', 'ledgers', 'trial_balance', 'profit_loss', 'balance_sheet',
        'vouchers', 'stock_summary', 'stock_item_ledger', 'bills_outstanding',
        'cost_centres', 'cost_allocations', 'gst_entries', 'payroll_entries'
    ]);

    try {
        // Step 1: Start push session
        send({ progress: 0, message: 'Starting push session...' });

        const startRes = await fetch(`${cloudUrl}/api/push/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            body: JSON.stringify({ companies: companyIds, admin_user: 'local-app' })
        });
        if (!startRes.ok) {
            const err = await startRes.json().catch(() => ({}));
            send({ error: err.error || `Push start failed (${startRes.status})` });
            return res.end();
        }
        const { pushId } = await startRes.json();
        send({ progress: 5, message: `Push session #${pushId} started` });

        // Step 2: Push each table
        const totalTables = TABLES_TO_PUSH.length;
        for (let i = 0; i < totalTables; i++) {
            const table = TABLES_TO_PUSH[i];
            const pct = Math.round(5 + (i / totalTables) * 90);
            send({ progress: pct, message: `Pushing ${table}...` });

            let rows;
            try {
                if (COMPANY_SCOPED.has(table)) {
                    const ph = companyIds.map(() => '?').join(',');
                    rows = db.prepare(`SELECT * FROM ${table} WHERE company_id IN (${ph})`).all(...companyIds);
                } else if (table === 'companies') {
                    const ph = companyIds.map(() => '?').join(',');
                    rows = db.prepare(`SELECT * FROM companies WHERE id IN (${ph})`).all(...companyIds);
                } else if (table === 'company_group_members') {
                    const ph = companyIds.map(() => '?').join(',');
                    rows = db.prepare(`SELECT * FROM company_group_members WHERE company_id IN (${ph})`).all(...companyIds);
                } else if (table === 'client_company_access') {
                    const ph = companyIds.map(() => '?').join(',');
                    rows = db.prepare(`SELECT * FROM client_company_access WHERE company_id IN (${ph})`).all(...companyIds);
                } else {
                    rows = db.prepare(`SELECT * FROM ${table}`).all();
                }
            } catch (e) {
                send({ progress: pct, message: `Skipping ${table} (${e.message})` });
                continue;
            }

            if (!rows || !rows.length) {
                send({ progress: pct, message: `${table}: 0 rows (skipped)` });
                continue;
            }

            // Push in chunks of 500
            const CHUNK = 500;
            for (let c = 0; c < rows.length; c += CHUNK) {
                const chunk = rows.slice(c, c + CHUNK);
                // Remove local 'id' column (cloud will auto-generate)
                const cleaned = chunk.map(r => {
                    const { id, ...rest } = r;
                    return rest;
                });

                const tableRes = await fetch(`${cloudUrl}/api/push/${pushId}/table`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                    body: JSON.stringify({
                        table,
                        rows: cleaned,
                        clear_existing: c === 0,
                        company_ids: COMPANY_SCOPED.has(table) ? companyIds : undefined
                    })
                });
                if (!tableRes.ok) {
                    const err = await tableRes.json().catch(() => ({}));
                    send({ progress: pct, message: `Warning: ${table} chunk failed — ${err.error || tableRes.status}` });
                }
            }
            send({ progress: pct, message: `${table}: ${rows.length} rows pushed` });
        }

        // Step 3: Complete push
        await fetch(`${cloudUrl}/api/push/${pushId}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey }
        });
        send({ progress: 100, complete: true, message: `Published ${companyIds.length} companies to cloud successfully!` });
    } catch (err) {
        send({ error: err.message });
    }
    res.end();
});

// ===== VCFO TRACKER =====

const VCFO_SEED_DATA = {
    compliance: [
        { name: 'GSTR-1 Filing', category: 'GST', frequency: 'monthly', default_due_day: 11, sort_order: 1 },
        { name: 'GSTR-3B Filing', category: 'GST', frequency: 'monthly', default_due_day: 20, sort_order: 2 },
        { name: 'GSTR-9 Annual Return', category: 'GST', frequency: 'annual', default_due_day: 31, sort_order: 3 },
        { name: 'GSTR-9C Reconciliation', category: 'GST', frequency: 'annual', default_due_day: 31, sort_order: 4 },
        { name: 'ITC Reconciliation', category: 'GST', frequency: 'monthly', default_due_day: 28, sort_order: 5 },
        { name: 'E-Way Bill Reconciliation', category: 'GST', frequency: 'monthly', default_due_day: 28, sort_order: 6 },
        { name: 'TDS Payment', category: 'TDS', frequency: 'monthly', default_due_day: 7, sort_order: 7 },
        { name: 'TDS Return - 24Q (Salary)', category: 'TDS', frequency: 'quarterly', default_due_day: 31, sort_order: 8 },
        { name: 'TDS Return - 26Q (Non-Salary)', category: 'TDS', frequency: 'quarterly', default_due_day: 31, sort_order: 9 },
        { name: 'TDS Return - 27Q (NRI)', category: 'TDS', frequency: 'quarterly', default_due_day: 31, sort_order: 10 },
        { name: 'TDS Return - 27EQ (TCS)', category: 'TDS', frequency: 'quarterly', default_due_day: 31, sort_order: 11 },
        { name: 'Form 16 / 16A Issuance', category: 'TDS', frequency: 'annual', default_due_day: 15, sort_order: 12 },
        { name: 'Advance Tax - Q1', category: 'Income Tax', frequency: 'quarterly', default_due_day: 15, sort_order: 13 },
        { name: 'Advance Tax - Q2', category: 'Income Tax', frequency: 'quarterly', default_due_day: 15, sort_order: 14 },
        { name: 'Advance Tax - Q3', category: 'Income Tax', frequency: 'quarterly', default_due_day: 15, sort_order: 15 },
        { name: 'Advance Tax - Q4', category: 'Income Tax', frequency: 'quarterly', default_due_day: 15, sort_order: 16 },
        { name: 'Income Tax Return Filing', category: 'Income Tax', frequency: 'annual', default_due_day: 31, sort_order: 17 },
        { name: 'Tax Audit (Section 44AB)', category: 'Income Tax', frequency: 'annual', default_due_day: 30, sort_order: 18 },
        { name: 'Transfer Pricing Report', category: 'Income Tax', frequency: 'annual', default_due_day: 30, sort_order: 19 },
        { name: 'AOC-4 Filing', category: 'ROC/MCA', frequency: 'annual', default_due_day: 30, sort_order: 20 },
        { name: 'MGT-7 Annual Return', category: 'ROC/MCA', frequency: 'annual', default_due_day: 28, sort_order: 21 },
        { name: 'DIR-3 KYC', category: 'ROC/MCA', frequency: 'annual', default_due_day: 30, sort_order: 22 },
        { name: 'ADT-1 (Auditor Appointment)', category: 'ROC/MCA', frequency: 'annual', default_due_day: 15, sort_order: 23 },
        { name: 'DPT-3 (Deposit Return)', category: 'ROC/MCA', frequency: 'half_yearly', default_due_day: 30, sort_order: 24 },
        { name: 'MSME-1 Filing', category: 'ROC/MCA', frequency: 'half_yearly', default_due_day: 31, sort_order: 25 },
        { name: 'Board Meeting Minutes', category: 'ROC/MCA', frequency: 'quarterly', default_due_day: 30, sort_order: 26 },
        { name: 'PF Payment', category: 'PF/ESI', frequency: 'monthly', default_due_day: 15, sort_order: 27 },
        { name: 'PF Return (ECR)', category: 'PF/ESI', frequency: 'monthly', default_due_day: 25, sort_order: 28 },
        { name: 'ESI Payment', category: 'PF/ESI', frequency: 'monthly', default_due_day: 15, sort_order: 29 },
        { name: 'ESI Return', category: 'PF/ESI', frequency: 'monthly', default_due_day: 15, sort_order: 30 },
        { name: 'Professional Tax Payment', category: 'PF/ESI', frequency: 'monthly', default_due_day: 30, sort_order: 31 },
        { name: 'PF Annual Return', category: 'PF/ESI', frequency: 'annual', default_due_day: 25, sort_order: 32 },
        { name: 'Gratuity Valuation', category: 'PF/ESI', frequency: 'annual', default_due_day: 31, sort_order: 33 },
        { name: 'Labour Welfare Fund', category: 'PF/ESI', frequency: 'half_yearly', default_due_day: 15, sort_order: 34 },
        { name: 'Shops & Establishment Renewal', category: 'PF/ESI', frequency: 'annual', default_due_day: 31, sort_order: 35 },
    ],
    accounting: [
        { name: 'Bank Reconciliation', category: 'Reconciliation', frequency: 'monthly', default_due_day: 5, sort_order: 1 },
        { name: 'Cash Verification', category: 'Verification', frequency: 'monthly', default_due_day: 1, sort_order: 2 },
        { name: 'Petty Cash Review', category: 'Verification', frequency: 'monthly', default_due_day: 5, sort_order: 3 },
        { name: 'Debtors Reconciliation', category: 'Reconciliation', frequency: 'monthly', default_due_day: 10, sort_order: 4 },
        { name: 'Creditors Reconciliation', category: 'Reconciliation', frequency: 'monthly', default_due_day: 10, sort_order: 5 },
        { name: 'Stock Verification', category: 'Verification', frequency: 'quarterly', default_due_day: 15, sort_order: 6 },
        { name: 'Fixed Asset Register Update', category: 'Assets', frequency: 'quarterly', default_due_day: 15, sort_order: 7 },
        { name: 'Depreciation Journal Entries', category: 'Journal Entries', frequency: 'monthly', default_due_day: 28, sort_order: 8 },
        { name: 'Provisions Review', category: 'Journal Entries', frequency: 'monthly', default_due_day: 28, sort_order: 9 },
        { name: 'Prepaid Expense Amortization', category: 'Journal Entries', frequency: 'monthly', default_due_day: 28, sort_order: 10 },
        { name: 'Inter-Company Reconciliation', category: 'Reconciliation', frequency: 'monthly', default_due_day: 15, sort_order: 11 },
        { name: 'Journal Entry Review', category: 'Review', frequency: 'monthly', default_due_day: 30, sort_order: 12 },
        { name: 'Loan Schedule Reconciliation', category: 'Reconciliation', frequency: 'quarterly', default_due_day: 15, sort_order: 13 },
        { name: 'Statutory Dues Reconciliation', category: 'Reconciliation', frequency: 'monthly', default_due_day: 20, sort_order: 14 },
        { name: 'Month-end Close Checklist', category: 'Review', frequency: 'monthly', default_due_day: 30, sort_order: 15 },
        { name: 'Revenue Recognition Review', category: 'Review', frequency: 'monthly', default_due_day: 30, sort_order: 16 },
    ],
    internal_control: [
        { name: 'PO Approval Compliance Check', category: 'Procurement', frequency: 'monthly', default_due_day: 15, sort_order: 1 },
        { name: 'Vendor Master Data Review', category: 'Procurement', frequency: 'quarterly', default_due_day: 15, sort_order: 2 },
        { name: 'Payment Authorization Verification', category: 'Finance', frequency: 'monthly', default_due_day: 15, sort_order: 3 },
        { name: 'Bank Signatory Verification', category: 'Finance', frequency: 'quarterly', default_due_day: 15, sort_order: 4 },
        { name: 'Access Control Review', category: 'IT Controls', frequency: 'quarterly', default_due_day: 15, sort_order: 5 },
        { name: 'Segregation of Duties Audit', category: 'Governance', frequency: 'quarterly', default_due_day: 15, sort_order: 6 },
        { name: 'Related Party Transaction Review', category: 'Governance', frequency: 'quarterly', default_due_day: 30, sort_order: 7 },
        { name: 'Expense Reimbursement Audit', category: 'Finance', frequency: 'monthly', default_due_day: 20, sort_order: 8 },
        { name: 'Inventory Access Control Check', category: 'Operations', frequency: 'quarterly', default_due_day: 15, sort_order: 9 },
        { name: 'Document Retention Compliance', category: 'Governance', frequency: 'annual', default_due_day: 31, sort_order: 10 },
        { name: 'Insurance Policy Review', category: 'Risk', frequency: 'annual', default_due_day: 31, sort_order: 11 },
        { name: 'Credit Limit Monitoring', category: 'Finance', frequency: 'monthly', default_due_day: 10, sort_order: 12 },
        { name: 'Budget vs Actual Review', category: 'Finance', frequency: 'monthly', default_due_day: 10, sort_order: 13 },
    ]
};

const AUDIT_MILESTONE_SEEDS = [
    { name: 'Engagement Letter & Planning', sort_order: 1 },
    { name: 'Document Collection', sort_order: 2 },
    { name: 'Vouching & Verification', sort_order: 3 },
    { name: 'Bank Reconciliation Review', sort_order: 4 },
    { name: 'Stock Verification', sort_order: 5 },
    { name: 'Fixed Asset Verification', sort_order: 6 },
    { name: 'Debtors/Creditors Confirmation', sort_order: 7 },
    { name: 'Tax Computation Review', sort_order: 8 },
    { name: 'Draft Financial Statements', sort_order: 9 },
    { name: 'Draft Audit Report', sort_order: 10 },
    { name: 'Management Discussion & Review', sort_order: 11 },
    { name: 'Final Audit Report', sort_order: 12 },
    { name: 'CARO Report', sort_order: 13 },
    { name: 'Tax Audit Report (3CA/3CB-3CD)', sort_order: 14 },
    { name: 'ROC Filing (AOC-4)', sort_order: 15 },
];

// ── VCFO: Seed pre-built items ──
app.post('/api/vcfo/seed', (req, res) => {
    const groupId = Number(req.query.groupId || req.body.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const ins = db.prepare(`INSERT OR IGNORE INTO vcfo_tracker_items (group_id, tracker_type, name, category, frequency, default_due_day, is_prebuilt, sort_order) VALUES (?,?,?,?,?,?,1,?)`);
    let count = 0;
    db.transaction(() => {
        for (const [type, items] of Object.entries(VCFO_SEED_DATA)) {
            for (const it of items) {
                const r = ins.run(groupId, type, it.name, it.category, it.frequency, it.default_due_day, it.sort_order);
                if (r.changes) count++;
            }
        }
    })();
    res.json({ seeded: count });
});

// ── VCFO: List items ──
app.get('/api/vcfo/items', (req, res) => {
    const groupId = Number(req.query.groupId);
    const type = req.query.type || 'compliance';
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const rows = db.prepare('SELECT * FROM vcfo_tracker_items WHERE group_id=? AND tracker_type=? AND is_active=1 ORDER BY sort_order, id').all(groupId, type);
    res.json(rows);
});

// ── VCFO: Create item ──
app.post('/api/vcfo/items', (req, res) => {
    const { groupId, tracker_type, name, category, frequency, default_due_day } = req.body;
    if (!groupId || !name || !tracker_type) return res.status(400).json({ error: 'groupId, tracker_type, name required' });
    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM vcfo_tracker_items WHERE group_id=? AND tracker_type=?').get(groupId, tracker_type)?.m || 0;
    const r = db.prepare('INSERT INTO vcfo_tracker_items (group_id, tracker_type, name, category, frequency, default_due_day, is_prebuilt, sort_order) VALUES (?,?,?,?,?,?,0,?)')
        .run(groupId, tracker_type, name, category || '', frequency || 'monthly', default_due_day || 0, maxSort + 1);
    res.json({ id: r.lastInsertRowid });
});

// ── VCFO: Update item ──
app.put('/api/vcfo/items/:id', (req, res) => {
    const { name, category, frequency, default_due_day } = req.body;
    db.prepare('UPDATE vcfo_tracker_items SET name=?, category=?, frequency=?, default_due_day=? WHERE id=?')
        .run(name, category || '', frequency || 'monthly', default_due_day || 0, req.params.id);
    res.json({ ok: true });
});

// ── VCFO: Delete item ──
app.delete('/api/vcfo/items/:id', (req, res) => {
    db.prepare('UPDATE vcfo_tracker_items SET is_active=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
});

// ── VCFO: Get status matrix ──
app.get('/api/vcfo/status', (req, res) => {
    const groupId = Number(req.query.groupId);
    const type = req.query.type || 'compliance';
    const period = req.query.period; // e.g. '2025-04' or '2025-Q1' or '2025'
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const items = db.prepare('SELECT * FROM vcfo_tracker_items WHERE group_id=? AND tracker_type=? AND is_active=1 ORDER BY sort_order, id').all(groupId, type);
    const memberIds = db.prepare('SELECT cgm.company_id FROM company_group_members cgm JOIN companies c ON c.id=cgm.company_id WHERE cgm.group_id=? AND c.is_active=1').all(groupId).map(r => r.company_id);
    const companies = memberIds.length ? db.prepare(`SELECT id, name, entity_type, city, location FROM companies WHERE id IN (${memberIds.join(',')})`).all() : [];

    let statusRows = [];
    if (period && items.length && memberIds.length) {
        const itemIds = items.map(i => i.id);
        statusRows = db.prepare(`SELECT * FROM vcfo_tracker_status WHERE item_id IN (${itemIds.join(',')}) AND company_id IN (${memberIds.join(',')}) AND period_key=?`).all(period);
    }
    // Build lookup: item_id -> company_id -> status row
    const statusMap = {};
    for (const s of statusRows) {
        if (!statusMap[s.item_id]) statusMap[s.item_id] = {};
        statusMap[s.item_id][s.company_id] = s;
    }
    res.json({ items, companies, statusMap });
});

// ── VCFO: Update single status ──
app.put('/api/vcfo/status', (req, res) => {
    const { item_id, company_id, period_key, status, due_date, completion_date, assigned_to, notes } = req.body;
    if (!item_id || !company_id || !period_key) return res.status(400).json({ error: 'item_id, company_id, period_key required' });
    db.prepare(`INSERT INTO vcfo_tracker_status (item_id, company_id, period_key, status, due_date, completion_date, assigned_to, notes, updated_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(item_id, company_id, period_key) DO UPDATE SET status=excluded.status, due_date=excluded.due_date, completion_date=excluded.completion_date, assigned_to=excluded.assigned_to, notes=excluded.notes, updated_at=datetime('now')`)
        .run(item_id, company_id, period_key, status || 'pending', due_date || null, completion_date || null, assigned_to || '', notes || '');
    res.json({ ok: true });
});

// ── VCFO: Bulk upsert status ──
app.post('/api/vcfo/status/bulk', (req, res) => {
    const { updates } = req.body; // [{item_id, company_id, period_key, status, ...}]
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
    const stmt = db.prepare(`INSERT INTO vcfo_tracker_status (item_id, company_id, period_key, status, due_date, completion_date, assigned_to, notes, updated_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(item_id, company_id, period_key) DO UPDATE SET status=excluded.status, due_date=excluded.due_date, completion_date=excluded.completion_date, assigned_to=excluded.assigned_to, notes=excluded.notes, updated_at=datetime('now')`);
    db.transaction(() => {
        for (const u of updates) {
            stmt.run(u.item_id, u.company_id, u.period_key, u.status || 'pending', u.due_date || null, u.completion_date || null, u.assigned_to || '', u.notes || '');
        }
    })();
    res.json({ ok: true, count: updates.length });
});

// ── VCFO: Summary counts ──
app.get('/api/vcfo/summary', (req, res) => {
    const groupId = Number(req.query.groupId);
    const type = req.query.type || 'compliance';
    const period = req.query.period;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const items = db.prepare('SELECT id FROM vcfo_tracker_items WHERE group_id=? AND tracker_type=? AND is_active=1').all(groupId, type);
    const memberIds = db.prepare('SELECT cgm.company_id FROM company_group_members cgm JOIN companies c ON c.id=cgm.company_id WHERE cgm.group_id=? AND c.is_active=1').all(groupId).map(r => r.company_id);
    const totalCells = items.length * memberIds.length;

    if (!period || !totalCells) return res.json({ total: totalCells, completed: 0, pending: totalCells, overdue: 0, in_progress: 0 });

    const itemIds = items.map(i => i.id);
    const counts = db.prepare(`SELECT status, COUNT(*) as cnt FROM vcfo_tracker_status WHERE item_id IN (${itemIds.join(',')}) AND company_id IN (${memberIds.join(',')}) AND period_key=? GROUP BY status`).all(period);
    const map = {};
    for (const c of counts) map[c.status] = c.cnt;
    const filled = Object.values(map).reduce((a, b) => a + b, 0);
    res.json({
        total: totalCells,
        completed: map.completed || 0,
        in_progress: map.in_progress || 0,
        overdue: map.overdue || 0,
        pending: (map.pending || 0) + (totalCells - filled),
        not_applicable: map.not_applicable || 0
    });
});

// ===== AUDIT TRACKER =====

// ── Audit: Seed milestones ──
app.post('/api/audit/milestones/seed', (req, res) => {
    const groupId = Number(req.query.groupId || req.body.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    const ins = db.prepare('INSERT OR IGNORE INTO audit_milestones (group_id, name, sort_order, is_prebuilt) VALUES (?,?,?,1)');
    let count = 0;
    db.transaction(() => {
        for (const m of AUDIT_MILESTONE_SEEDS) {
            const r = ins.run(groupId, m.name, m.sort_order);
            if (r.changes) count++;
        }
    })();
    res.json({ seeded: count });
});

// ── Audit: List milestones ──
app.get('/api/audit/milestones', (req, res) => {
    const groupId = Number(req.query.groupId);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    res.json(db.prepare('SELECT * FROM audit_milestones WHERE group_id=? AND is_active=1 ORDER BY sort_order, id').all(groupId));
});

// ── Audit: Create milestone ──
app.post('/api/audit/milestones', (req, res) => {
    const { groupId, name } = req.body;
    if (!groupId || !name) return res.status(400).json({ error: 'groupId, name required' });
    const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM audit_milestones WHERE group_id=?').get(groupId)?.m || 0;
    const r = db.prepare('INSERT INTO audit_milestones (group_id, name, sort_order, is_prebuilt) VALUES (?,?,?,0)').run(groupId, name, maxSort + 1);
    res.json({ id: r.lastInsertRowid });
});

// ── Audit: Update milestone ──
app.put('/api/audit/milestones/:id', (req, res) => {
    db.prepare('UPDATE audit_milestones SET name=? WHERE id=?').run(req.body.name, req.params.id);
    res.json({ ok: true });
});

// ── Audit: Delete milestone ──
app.delete('/api/audit/milestones/:id', (req, res) => {
    db.prepare('UPDATE audit_milestones SET is_active=0 WHERE id=?').run(req.params.id);
    res.json({ ok: true });
});

// ── Audit: Milestone status matrix ──
app.get('/api/audit/milestone-status', (req, res) => {
    const groupId = Number(req.query.groupId);
    const fy = Number(req.query.fy);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const milestones = db.prepare('SELECT * FROM audit_milestones WHERE group_id=? AND is_active=1 ORDER BY sort_order, id').all(groupId);
    const memberIds = db.prepare('SELECT cgm.company_id FROM company_group_members cgm JOIN companies c ON c.id=cgm.company_id WHERE cgm.group_id=? AND c.is_active=1').all(groupId).map(r => r.company_id);
    const companies = memberIds.length ? db.prepare(`SELECT id, name, entity_type, city, location FROM companies WHERE id IN (${memberIds.join(',')})`).all() : [];

    let statusRows = [];
    if (fy && milestones.length && memberIds.length) {
        const mIds = milestones.map(m => m.id);
        statusRows = db.prepare(`SELECT * FROM audit_milestone_status WHERE milestone_id IN (${mIds.join(',')}) AND company_id IN (${memberIds.join(',')}) AND fy_year=?`).all(fy);
    }
    const statusMap = {};
    for (const s of statusRows) {
        if (!statusMap[s.milestone_id]) statusMap[s.milestone_id] = {};
        statusMap[s.milestone_id][s.company_id] = s;
    }
    res.json({ milestones, companies, statusMap });
});

// ── Audit: Update milestone status ──
app.put('/api/audit/milestone-status', (req, res) => {
    const { milestone_id, company_id, fy_year, status, due_date, completion_date, assigned_to, notes } = req.body;
    if (!milestone_id || !company_id || !fy_year) return res.status(400).json({ error: 'milestone_id, company_id, fy_year required' });
    db.prepare(`INSERT INTO audit_milestone_status (milestone_id, company_id, fy_year, status, due_date, completion_date, assigned_to, notes, updated_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(milestone_id, company_id, fy_year) DO UPDATE SET status=excluded.status, due_date=excluded.due_date, completion_date=excluded.completion_date, assigned_to=excluded.assigned_to, notes=excluded.notes, updated_at=datetime('now')`)
        .run(milestone_id, company_id, fy_year, status || 'pending', due_date || null, completion_date || null, assigned_to || '', notes || '');
    res.json({ ok: true });
});

// ── Audit: Observations CRUD ──
app.get('/api/audit/observations', (req, res) => {
    const groupId = Number(req.query.groupId);
    const fy = Number(req.query.fy);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    let q = 'SELECT o.*, c.name as company_name FROM audit_observations o LEFT JOIN companies c ON c.id=o.company_id WHERE o.group_id=?';
    const params = [groupId];
    if (fy) { q += ' AND o.fy_year=?'; params.push(fy); }
    if (req.query.severity) { q += ' AND o.severity=?'; params.push(req.query.severity); }
    if (req.query.status) { q += ' AND o.status=?'; params.push(req.query.status); }
    if (req.query.company_id) { q += ' AND o.company_id=?'; params.push(Number(req.query.company_id)); }
    q += ' ORDER BY o.id DESC';
    res.json(db.prepare(q).all(...params));
});

app.post('/api/audit/observations', (req, res) => {
    const { groupId, company_id, fy_year, title, description, severity, category, recommendation, mgmt_response, status, assigned_to, due_date } = req.body;
    if (!groupId || !title || !fy_year) return res.status(400).json({ error: 'groupId, title, fy_year required' });
    const r = db.prepare(`INSERT INTO audit_observations (group_id, company_id, fy_year, title, description, severity, category, recommendation, mgmt_response, status, assigned_to, due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(groupId, company_id || null, fy_year, title, description || '', severity || 'medium', category || '', recommendation || '', mgmt_response || '', status || 'open', assigned_to || '', due_date || null);
    res.json({ id: r.lastInsertRowid });
});

app.put('/api/audit/observations/:id', (req, res) => {
    const { title, description, severity, category, recommendation, mgmt_response, status, assigned_to, due_date, resolution_date, company_id } = req.body;
    db.prepare(`UPDATE audit_observations SET title=?, description=?, severity=?, category=?, recommendation=?, mgmt_response=?, status=?, assigned_to=?, due_date=?, resolution_date=?, company_id=?, updated_at=datetime('now') WHERE id=?`)
        .run(title, description || '', severity || 'medium', category || '', recommendation || '', mgmt_response || '', status || 'open', assigned_to || '', due_date || null, resolution_date || null, company_id || null, req.params.id);
    res.json({ ok: true });
});

app.delete('/api/audit/observations/:id', (req, res) => {
    db.prepare('DELETE FROM audit_observations WHERE id=?').run(req.params.id);
    res.json({ ok: true });
});

// ── Audit: Summary ──
app.get('/api/audit/summary', (req, res) => {
    const groupId = Number(req.query.groupId);
    const fy = Number(req.query.fy);
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const milestones = db.prepare('SELECT id FROM audit_milestones WHERE group_id=? AND is_active=1').all(groupId);
    const memberIds = db.prepare('SELECT cgm.company_id FROM company_group_members cgm JOIN companies c ON c.id=cgm.company_id WHERE cgm.group_id=? AND c.is_active=1').all(groupId).map(r => r.company_id);
    const totalCells = milestones.length * memberIds.length;

    let msCompleted = 0, msInProgress = 0;
    if (fy && milestones.length && memberIds.length) {
        const mIds = milestones.map(m => m.id);
        const counts = db.prepare(`SELECT status, COUNT(*) as cnt FROM audit_milestone_status WHERE milestone_id IN (${mIds.join(',')}) AND company_id IN (${memberIds.join(',')}) AND fy_year=? GROUP BY status`).all(fy);
        for (const c of counts) { if (c.status === 'completed') msCompleted = c.cnt; if (c.status === 'in_progress') msInProgress = c.cnt; }
    }

    let obsOpen = 0, obsInProgress = 0, obsResolved = 0, obsClosed = 0;
    if (fy) {
        const obsCounts = db.prepare('SELECT status, COUNT(*) as cnt FROM audit_observations WHERE group_id=? AND fy_year=? GROUP BY status').all(groupId, fy);
        for (const c of obsCounts) {
            if (c.status === 'open') obsOpen = c.cnt;
            if (c.status === 'in_progress') obsInProgress = c.cnt;
            if (c.status === 'resolved') obsResolved = c.cnt;
            if (c.status === 'closed') obsClosed = c.cnt;
        }
    }

    res.json({
        milestones: { total: totalCells, completed: msCompleted, in_progress: msInProgress, pending: totalCells - msCompleted - msInProgress },
        observations: { open: obsOpen, in_progress: obsInProgress, resolved: obsResolved, closed: obsClosed, total: obsOpen + obsInProgress + obsResolved + obsClosed }
    });
});

// ===== START SERVER =====
const PORT = parseInt(getSetting('dashboard_port') || process.env.PORT || '3456');
app.listen(PORT, () => {
    console.log(`\n  TallyVision API Server (v4 - Per-Client DB Architecture)`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Master DB: ${require('./db/setup').getMasterDbPath()}`);
    console.log(`  Client DBs: ${require('./db/setup').getClientDbDir()}\n`);
});

// Graceful shutdown — close all cached DB connections
process.on('SIGINT', () => { dbManager.closeAll(); process.exit(0); });
process.on('SIGTERM', () => { dbManager.closeAll(); process.exit(0); });

module.exports = app;