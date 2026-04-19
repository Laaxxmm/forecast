// ─────────────────────────────────────────────────────────────────────────────
// Task-6 smoke test — offline retry queue.
//
// Part A: pure-function checks of OfflineQueue + isRetryableError (no network).
// Part B: end-to-end round-trip
//   1. Instantiate ApiClient against a DEAD server URL (bogus port).
//   2. Call tryPush-equivalent flow → verify it enqueues on failure.
//   3. Swap the ApiClient to the real live server + drain the queue.
//   4. Verify the queue empties and the server accepted the replayed batch.
//
// Usage:
//   node scripts/smoke-task6.js <apiKey>   (slug defaults to magnacode)
// Env overrides:
//   VCFO_SERVER_URL   — default http://localhost:3000
// ─────────────────────────────────────────────────────────────────────────────

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DIST = path.join(__dirname, '..', 'dist-electron', 'lib');
const { OfflineQueue, isRetryableError } = require(path.join(DIST, 'offline-queue.js'));
const { ApiClient } = require(path.join(DIST, 'api-client.js'));

const API_KEY = process.argv[2];
const SLUG = process.argv[3] || 'magnacode';
const SERVER_URL = process.env.VCFO_SERVER_URL || 'http://localhost:3000';
const DEAD_URL = 'http://127.0.0.1:1';  // port 1 — guaranteed refused

if (!API_KEY) {
  console.error('usage: node scripts/smoke-task6.js <apiKey> [clientSlug]');
  process.exit(2);
}

function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(1, 70 - title.length)));
}
function ok(msg)  { console.log('  ✓ ' + msg); }
function fail(msg){ console.log('  ✗ ' + msg); process.exitCode = 1; }
function info(msg){ console.log('    ' + msg); }

// A minimal valid group payload so the server will actually accept the replay
// once we point at the live server. Using `(Part A Smoke)` as a company name
// that almost certainly doesn't exist — but since we send `groups` without
// companyName it's for the `(masters)` case; actually groups REQUIRES
// companyName. Use a real company identifier the server already knows about.
// To keep the smoke self-contained we use a companyName that we'll accept
// whatever the server does with it — the point here is end-to-end queueing.
const SMOKE_COMPANY = process.env.VCFO_SMOKE_COMPANY || 'Magnacode Healthcare Pvt Ltd';

// Build a tiny but valid groups payload.
function makeGroupRows() {
  return [{
    name: '_SMOKE_TASK6_PROBE',
    parent: 'Primary',
    reservedName: '',
    primary: 'Yes',
    bsPl: 'BS',
    drCr: 'D',
    affectsGrossProfit: 'N',
  }];
}

// Replicate tryPush semantics from electron/main.ts for the smoke test.
async function tryPush(client, queue, payload) {
  try {
    return await client.ingestBatch(payload);
  } catch (err) {
    if (isRetryableError(err)) {
      queue.enqueue(payload);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg} (queued for retry)`);
    }
    throw err;
  }
}

// Replicate drainQueue semantics.
async function drainQueue(client, queue) {
  const drained = [];
  const budget = queue.size() + 1;
  let iter = 0;
  while (queue.size() > 0 && iter < budget) {
    iter += 1;
    const head = queue.peek();
    if (!head) break;
    try {
      const res = await client.ingestBatch(head.payload);
      queue.pop();
      drained.push({ ok: true, kind: head.payload.kind, rowsAccepted: res.rowsAccepted });
    } catch (err) {
      if (isRetryableError(err)) {
        queue.recordFailure(err.message);
        drained.push({ ok: false, kind: head.payload.kind, error: err.message, retryable: true });
        break;
      } else {
        queue.pop();
        drained.push({ ok: false, kind: head.payload.kind, error: err.message, retryable: false });
      }
    }
  }
  return drained;
}

(async () => {
  console.log('VCFO task-6 smoke — server=' + SERVER_URL + ' dead=' + DEAD_URL);

  // ── Part A: OfflineQueue pure-function checks ─────────────────────────────
  section('A1. isRetryableError classification');
  const retryableCases = [
    'Server rejected ingest/batch vouchers (500): boom',
    'Server rejected ingest/batch groups (502): Bad Gateway',
    'Server rejected ingest/batch ledgers (503): unavailable',
    'Server rejected ingest/batch groups (408): request timeout',
    'Server rejected ingest/batch groups (429): rate-limited',
    'fetch failed',
    'ECONNREFUSED 127.0.0.1:1',
    'network timeout',
  ];
  const nonRetryableCases = [
    'Server rejected ingest/batch vouchers (400): Bad Request',
    'Server rejected ingest/batch ledgers (401): Unauthorized',
    'Server rejected ingest/batch groups (404): Not Found',
    'Invalid apiKey',
    'Expected rows to be an array',
    'Missing companyName',
    'Unknown kind: cowabunga',
  ];
  let classifyOk = true;
  for (const m of retryableCases) {
    if (!isRetryableError(new Error(m))) { fail('should be retryable: ' + m); classifyOk = false; }
  }
  for (const m of nonRetryableCases) {
    if (isRetryableError(new Error(m))) { fail('should NOT be retryable: ' + m); classifyOk = false; }
  }
  if (classifyOk) ok(`Classified ${retryableCases.length + nonRetryableCases.length} error shapes correctly`);

  section('A2. OfflineQueue bounded eviction');
  {
    const tmp = path.join(os.tmpdir(), 'vcfo-smoke-q-' + Date.now() + '.json');
    const q = new OfflineQueue(tmp, { maxItems: 3 });
    for (let i = 0; i < 5; i += 1) {
      q.enqueue({ kind: 'groups', companyName: 'X' + i, rows: [{ name: 'r' + i }] });
    }
    const sz = q.size();
    if (sz !== 3) fail(`expected size 3 after 5 enqueues with cap 3, got ${sz}`);
    const heads = q.snapshot().map((it) => it.payload.companyName);
    const expected = ['X2', 'X3', 'X4']; // oldest evicted first
    if (JSON.stringify(heads) !== JSON.stringify(expected)) {
      fail(`expected head sequence ${JSON.stringify(expected)}, got ${JSON.stringify(heads)}`);
    } else {
      ok('Cap enforced; FIFO order preserved (' + heads.join(',') + ')');
    }
    // Persistence round-trip
    const q2 = new OfflineQueue(tmp, { maxItems: 3 });
    if (q2.size() !== 3) fail(`reloaded queue size ${q2.size()}, expected 3`);
    else ok('Reloaded from disk with same 3 items');
    fs.unlinkSync(tmp);
  }

  section('A3. OfflineQueue recordFailure → dead-letter after maxAttempts');
  {
    const tmp = path.join(os.tmpdir(), 'vcfo-smoke-q2-' + Date.now() + '.json');
    const q = new OfflineQueue(tmp, { maxItems: 10, maxAttempts: 3 });
    q.enqueue({ kind: 'groups', companyName: 'Y', rows: [{ name: 'y' }] });
    const r1 = q.recordFailure('boom 1');
    const r2 = q.recordFailure('boom 2');
    if (r1.dropped || r2.dropped) fail('dropped too early');
    const r3 = q.recordFailure('boom 3');
    if (!r3.dropped) fail('expected dead-letter at attempt 3, got dropped=' + r3.dropped);
    else if (q.size() !== 0) fail('queue should be empty after dead-letter, got size=' + q.size());
    else ok('Dead-lettered after 3rd failure');
    fs.unlinkSync(tmp);
  }

  section('A4. Corruption-safe load');
  {
    const tmp = path.join(os.tmpdir(), 'vcfo-smoke-q3-' + Date.now() + '.json');
    fs.writeFileSync(tmp, '{not valid json::', 'utf8');
    const q = new OfflineQueue(tmp);
    if (q.size() !== 0) fail('bad JSON should yield empty queue, got size=' + q.size());
    else ok('Malformed JSON → empty queue (no crash)');
    fs.unlinkSync(tmp);
  }

  // ── Part B: end-to-end enqueue-then-drain ────────────────────────────────
  section('B1. Enqueue on dead server');
  // Use a real /tmp queue file for this run so we can inspect it.
  const smokeQueuePath = path.join(os.tmpdir(), 'vcfo-smoke-e2e-' + Date.now() + '.json');
  const queue = new OfflineQueue(smokeQueuePath);

  const deadClient = new ApiClient(DEAD_URL, API_KEY);
  const payload = { kind: 'groups', companyName: SMOKE_COMPANY, rows: makeGroupRows() };
  let sawQueuedError = false;
  try {
    await tryPush(deadClient, queue, payload);
    fail('tryPush against dead server should have thrown');
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('(queued for retry)')) {
      sawQueuedError = true;
      ok('tryPush threw with "(queued for retry)" suffix');
    } else {
      fail('unexpected error shape: ' + msg);
    }
  }

  if (queue.size() !== 1) fail('queue size after enqueue should be 1, got ' + queue.size());
  else ok('Queue size = 1 after offline failure');

  // Verify on-disk persistence
  if (!fs.existsSync(smokeQueuePath)) {
    fail('queue file not written to disk');
  } else {
    const raw = JSON.parse(fs.readFileSync(smokeQueuePath, 'utf8'));
    if (!Array.isArray(raw) || raw.length !== 1) {
      fail('disk file shape wrong: ' + JSON.stringify(raw).slice(0, 120));
    } else {
      ok('Queue persisted to disk at ' + smokeQueuePath);
      info('on-disk item: kind=' + raw[0].payload.kind + ' attempts=' + raw[0].attempts);
    }
  }

  // ── B2. Swap to live server and drain ────────────────────────────────────
  section('B2. Drain against live server');
  const liveClient = new ApiClient(SERVER_URL, API_KEY);
  const serverAlive = await liveClient.ping();
  if (!serverAlive) {
    fail('Live server at ' + SERVER_URL + ' is not reachable; cannot drain');
    return;
  }
  ok('Live server reachable');

  const drained = await drainQueue(liveClient, queue);
  if (drained.length === 0) fail('drain produced no results');
  else info('drain log: ' + JSON.stringify(drained));

  const successDrains = drained.filter((d) => d.ok);
  if (successDrains.length !== 1) fail('expected 1 successful drain, got ' + successDrains.length);
  else ok('Drain replayed 1 queued batch successfully (server accepted ' + successDrains[0].rowsAccepted + ')');

  if (queue.size() !== 0) fail('queue should be empty after successful drain, got ' + queue.size());
  else ok('Queue drained to 0');

  // Clean up the disk file
  try { fs.unlinkSync(smokeQueuePath); } catch { /* ignore */ }

  // ── B3. Non-retryable error skips the queue ─────────────────────────────
  section('B3. Non-retryable errors bypass queue');
  const queue2 = new OfflineQueue(path.join(os.tmpdir(), 'vcfo-smoke-e2e2-' + Date.now() + '.json'));
  // Malformed payload — server returns 400. isRetryableError should see (400)
  // and NOT enqueue.
  const badClient = new ApiClient(SERVER_URL, API_KEY);
  const badPayload = { kind: 'groups', companyName: SMOKE_COMPANY, rows: [{ /* missing required name */ }] };
  try {
    await tryPush(badClient, queue2, badPayload);
    // Server may or may not reject a row missing `name` (depends on
    // validation strictness). If it accepts, that's fine — the point of this
    // check is the negative case (400 → no enqueue). So we only fail if it
    // DID enqueue.
    info('server accepted the malformed payload (validation may be lenient) — non-enqueue check still valid since no throw');
  } catch (err) {
    // Expected path for strict servers.
    if (err.message.includes('(queued for retry)')) {
      fail('non-retryable error should not have been queued: ' + err.message);
    } else {
      ok('Non-retryable error passed through without queueing');
    }
  }
  if (queue2.size() !== 0) fail('queue2 should still be empty, got size=' + queue2.size());
  else ok('Queue stayed empty on non-retryable path');
  try { fs.unlinkSync(queue2.filePath ?? ''); } catch { /* ignore */ }

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
