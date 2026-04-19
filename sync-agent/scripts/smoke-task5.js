// ─────────────────────────────────────────────────────────────────────────────
// Task-5 smoke test — exercises the new extractors against live Tally + live
// VCFO server. Produces a compact pass/fail report. Does NOT touch any
// production data paths beyond the /api/ingest/batch endpoint (which is
// already idempotent via UNIQUE+REPLACE).
//
// Usage:
//   node scripts/smoke-task5.js <apiKey>   (slug defaults to magnacode)
// ─────────────────────────────────────────────────────────────────────────────

const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist-electron', 'lib');
const { TallyConnector } = require(path.join(DIST, 'tally', 'connector.js'));
const {
  extractCompanies,
  extractLedgers,
  extractGroups,
  extractStockSummary,
  quarterChunks,
} = require(path.join(DIST, 'tally', 'extractors.js'));
const { ApiClient } = require(path.join(DIST, 'api-client.js'));

const API_KEY = process.argv[2];
const SLUG = process.argv[3] || 'magnacode';
const SERVER_URL = process.env.VCFO_SERVER_URL || 'http://localhost:3001';
const TALLY_HOST = process.env.TALLY_HOST || 'localhost';
const TALLY_PORT = parseInt(process.env.TALLY_PORT || '9000', 10);

if (!API_KEY) {
  console.error('usage: node scripts/smoke-task5.js <apiKey> [clientSlug]');
  process.exit(2);
}

function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(1, 70 - title.length)));
}

function ok(msg)  { console.log('  ✓ ' + msg); }
function fail(msg){ console.log('  ✗ ' + msg); process.exitCode = 1; }
function info(msg){ console.log('    ' + msg); }

(async () => {
  console.log('VCFO task-5 smoke — server=' + SERVER_URL + ' tally=' + TALLY_HOST + ':' + TALLY_PORT + ' slug=' + SLUG);

  const conn = new TallyConnector({ host: TALLY_HOST, port: TALLY_PORT });
  // ApiClient appends `/api/ingest/...` itself — pass the bare origin only.
  const client = new ApiClient(SERVER_URL, API_KEY);

  // 1. Tally + server reachability ----------------------------------------
  section('1. Reachability');
  const tallyAlive = await conn.ping();
  tallyAlive ? ok('Tally reachable') : fail('Tally NOT reachable');
  if (!tallyAlive) return;

  const serverAlive = await client.ping();
  serverAlive ? ok('Server reachable') : fail('Server NOT reachable (check /api/ingest/ping)');
  if (!serverAlive) return;

  // 2. Which company to use ------------------------------------------------
  section('2. Target company');
  const companies = await extractCompanies(conn);
  if (companies.length === 0) return fail('No companies loaded in Tally');
  const target = companies[0].name;
  ok('Target = "' + target + '" (' + companies.length + ' loaded)');

  // 3. quarterChunks sanity (pure function, no Tally call) -----------------
  section('3. quarterChunks unit check');
  try {
    const chunks = quarterChunks('2026-02-15', '2026-05-15');
    // Expect: Q4 2025-26 (Jan-Mar) + Q1 2026-27 (Apr-Jun), both with full
    // canonical boundaries, queryTo clipped to 2026-05-15 on the second.
    if (chunks.length !== 2) return fail('quarterChunks: expected 2 chunks, got ' + chunks.length);
    if (chunks[0].periodFrom !== '2026-01-01' || chunks[0].periodTo !== '2026-03-31') {
      return fail('quarterChunks[0] boundaries wrong: ' + JSON.stringify(chunks[0]));
    }
    if (chunks[1].periodFrom !== '2026-04-01' || chunks[1].periodTo !== '2026-06-30') {
      return fail('quarterChunks[1] boundaries wrong: ' + JSON.stringify(chunks[1]));
    }
    if (chunks[1].queryTo !== '2026-05-15') {
      return fail('quarterChunks[1].queryTo should clip to toDate, got ' + chunks[1].queryTo);
    }
    ok('Boundaries canonical; queryTo clips correctly');
    info('chunks = ' + JSON.stringify(chunks));
  } catch (e) {
    return fail('quarterChunks threw: ' + e.message);
  }

  // 4. extractGroups --------------------------------------------------------
  section('4. extractGroups');
  let groupRows;
  try {
    const t0 = Date.now();
    groupRows = await extractGroups(conn, target);
    ok('Fetched ' + groupRows.length + ' groups in ' + (Date.now() - t0) + 'ms');
  } catch (e) { return fail('extractGroups threw: ' + e.message); }

  if (groupRows.length === 0) {
    fail('extractGroups returned 0 rows — is Tally actually showing a company?');
  } else {
    const sample = groupRows.slice(0, 3).map(r => r.name + ' [' + (r.bsPl || '?') + '/' + (r.drCr || '?') + '/' + (r.affectsGrossProfit || '?') + ']').join('; ');
    info('sample: ' + sample);
    const bs = groupRows.filter(r => r.bsPl === 'BS').length;
    const pl = groupRows.filter(r => r.bsPl === 'PL').length;
    const classified = bs + pl;
    if (classified === 0) {
      fail('No group was classified BS or PL — TDL formulas likely not evaluating');
    } else {
      ok('BS=' + bs + ' PL=' + pl + ' (' + Math.round(100 * classified / groupRows.length) + '% classified)');
    }
  }

  // 5. extractStockSummary (narrow 1-quarter window to keep it fast) -------
  section('5. extractStockSummary');
  // Use current FY's in-progress quarter only — this is the realistic case
  // and exercises the "queryTo clipped to today" path.
  const today = new Date().toISOString().slice(0, 10);
  const quarterStart = (() => {
    const d = new Date(today + 'T00:00:00Z');
    const m = d.getUTCMonth();
    const q = m >= 3 && m <= 5 ? 3 : m >= 6 && m <= 8 ? 6 : m >= 9 ? 9 : 0;
    return d.getUTCFullYear() + '-' + String(q + 1).padStart(2, '0') + '-01';
  })();
  let stockRows;
  try {
    const t0 = Date.now();
    stockRows = await extractStockSummary(conn, target, quarterStart, today);
    ok('Fetched ' + stockRows.length + ' stock rows over [' + quarterStart + '..' + today + '] in ' + (Date.now() - t0) + 'ms');
  } catch (e) { return fail('extractStockSummary threw: ' + e.message); }

  if (stockRows.length > 0) {
    const withMovement = stockRows.filter(r => r.inwardQty !== 0 || r.outwardQty !== 0).length;
    const s = stockRows[0];
    info('sample: ' + s.itemName + ' — period ' + s.periodFrom + '..' + s.periodTo
       + ' opening=' + s.openingQty + ' closing=' + s.closingQty);
    ok(withMovement + '/' + stockRows.length + ' items had movement in this window');
    // Verify canonical quarter boundary is stored (not today!) so DB key is stable
    if (s.periodTo === today) {
      fail('periodTo should be canonical quarter-end, not today — Bug Detector finding #1 regression');
    } else {
      ok('periodTo = ' + s.periodTo + ' (canonical quarter boundary, stable DB key)');
    }
  } else {
    info('(no stock items — if this is a services-only company, that is expected)');
  }

  // 6. Server ingest: groups ------------------------------------------------
  section('6. Ingest: groups → /api/ingest/batch');
  if (!groupRows || groupRows.length === 0) {
    info('skipped (no rows to send)');
  } else {
    try {
      const res = await client.ingestBatch({ kind: 'groups', companyName: target, rows: groupRows });
      if (res.ok && res.rowsAccepted === groupRows.length) {
        ok('Server accepted ' + res.rowsAccepted + '/' + res.rowsReceived + ' group rows');
      } else {
        fail('Server reported partial accept: ' + JSON.stringify(res));
      }
    } catch (e) { fail('ingestBatch groups threw: ' + e.message); }
  }

  // 7. Server ingest: stockSummary -----------------------------------------
  section('7. Ingest: stockSummary → /api/ingest/batch');
  if (!stockRows || stockRows.length === 0) {
    info('skipped (no rows to send)');
  } else {
    try {
      const res = await client.ingestBatch({ kind: 'stockSummary', companyName: target, rows: stockRows });
      if (res.ok && res.rowsAccepted === stockRows.length) {
        ok('Server accepted ' + res.rowsAccepted + '/' + res.rowsReceived + ' stock rows');
      } else {
        fail('Server reported partial accept: ' + JSON.stringify(res));
      }
    } catch (e) { fail('ingestBatch stockSummary threw: ' + e.message); }
  }

  // 8. Idempotency: re-push the same groups payload, expect same count -----
  section('8. Idempotency re-push (groups)');
  if (groupRows && groupRows.length > 0) {
    try {
      const res = await client.ingestBatch({ kind: 'groups', companyName: target, rows: groupRows });
      if (res.ok && res.rowsAccepted === groupRows.length) {
        ok('Re-push accepted same count (' + res.rowsAccepted + ') — REPLACE is idempotent');
      } else {
        fail('Re-push returned unexpected counts: ' + JSON.stringify(res));
      }
    } catch (e) { fail('re-push groups threw: ' + e.message); }
  } else { info('skipped'); }

  section('Summary');
  if (process.exitCode === 1) {
    console.log('  ✗ Smoke test FAILED — see above');
  } else {
    console.log('  ✓ All checks passed');
  }
})().catch((e) => {
  console.error('\nUNCAUGHT:', e);
  process.exit(3);
});
