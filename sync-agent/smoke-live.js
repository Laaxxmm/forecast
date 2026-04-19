// ─────────────────────────────────────────────────────────────────────────────
// smoke-live.js — drives the real agent pipeline (connector + extractors + api
// client) against a live Tally on localhost:9000 and a running server. No GUI
// required. Run with: node smoke-live.js
// ─────────────────────────────────────────────────────────────────────────────

const { TallyConnector } = require('./dist-electron/lib/tally/connector');
const {
    extractCompanies, extractLedgers, extractVouchers,
} = require('./dist-electron/lib/tally/extractors');
const { ApiClient } = require('./dist-electron/lib/api-client');

const SERVER = process.env.SERVER_URL || 'http://localhost:3001';
const KEY    = process.env.AGENT_KEY  || 'vcfo_live_bc6efcedc029aed904c8d702cc5c5d706b2c6f44';
const FROM   = process.env.FROM_DATE  || '2025-04-01'; // a year back so we catch something
const TO     = process.env.TO_DATE    || new Date().toISOString().slice(0, 10);

function line(s = '') { console.log(s); }

(async () => {
    const conn = new TallyConnector({ host: 'localhost', port: 9000 });
    const api  = new ApiClient(SERVER, KEY);

    line('=== 0. Preflight ===');
    const tallyUp  = await conn.ping();
    line('Tally TCP ping: ' + (tallyUp ? 'ok' : 'FAIL'));
    if (!tallyUp) process.exit(1);
    const version = await conn.detectVersion();
    line('Tally version: ' + version);
    const serverUp = await api.ping();
    line('Server ping:   ' + (serverUp ? 'ok' : 'FAIL'));
    if (!serverUp) process.exit(1);

    line('');
    line('=== 1. Companies ===');
    const companies = await extractCompanies(conn);
    line('Found ' + companies.length + ' company(ies): ' + companies.map((c) => c.name).join(', '));
    if (companies.length === 0) {
        line('No companies returned by Tally — open a company in Tally and retry.');
        process.exit(1);
    }
    const target = companies[0].name;
    const r1 = await api.ingestBatch({ kind: 'companies', rows: companies });
    line('POST companies: accepted=' + r1.rowsAccepted + '/' + r1.rowsReceived);

    line('');
    line('=== 2. Ledgers for "' + target + '" ===');
    const ledgers = await extractLedgers(conn, target);
    line('Extracted ' + ledgers.length + ' ledgers. First 5:');
    for (const l of ledgers.slice(0, 5)) line('  - ' + l.name + ' (' + l.group + ')');
    if (ledgers.length > 0) {
        const r2 = await api.ingestBatch({ kind: 'ledgers', companyName: target, rows: ledgers });
        line('POST ledgers: accepted=' + r2.rowsAccepted + '/' + r2.rowsReceived);
    }

    line('');
    line('=== 3. Vouchers window ' + FROM + ' → ' + TO + ' ===');
    const t0 = Date.now();
    const vouchers = await extractVouchers(conn, target, FROM, TO);
    line('Extracted ' + vouchers.length + ' voucher-rows in ' + (Date.now() - t0) + 'ms');
    if (vouchers.length > 0) {
        line('First 3:');
        for (const v of vouchers.slice(0, 3)) {
            line('  ' + v.date + ' ' + v.voucherType + ' #' + v.voucherNumber
                + '  ' + v.ledgerName + '  ' + v.amount);
        }
        const r3 = await api.ingestBatch({ kind: 'vouchers', companyName: target, rows: vouchers });
        line('POST vouchers: accepted=' + r3.rowsAccepted + '/' + r3.rowsReceived);
    }

    line('');
    line('=== Done. Open magnacode.db and query vcfo_companies / vcfo_ledgers / vcfo_vouchers to verify. ===');
    process.exit(0);
})().catch((err) => {
    console.error('SMOKE-LIVE FAILED:', err);
    process.exit(2);
});
