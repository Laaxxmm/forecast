// ─────────────────────────────────────────────────────────────────────────────
// Task-7 smoke test — rolling NDJSON logger. Pure local, no network.
//
// Checks:
//   1. write/read round-trip — info/warn/error land as valid NDJSON
//   2. level filtering respects minLevel
//   3. errCtx captures Error.message + name + stack
//   4. rotation: writes past maxBytes rename active → .1, keep .1..maxFiles
//   5. oldest rotation is deleted when rotation count exceeds maxFiles
//   6. tail(n) returns newest-last parsed objects and skips malformed lines
//   7. corruption-safe: writing to a read-only dir must NOT throw
//
// Usage:
//   node scripts/smoke-task7.js
// ─────────────────────────────────────────────────────────────────────────────

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DIST = path.join(__dirname, '..', 'dist-electron', 'lib');
const { Logger, errCtx } = require(path.join(DIST, 'logger.js'));

function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(1, 70 - title.length)));
}
function ok(msg)  { console.log('  ✓ ' + msg); }
function fail(msg){ console.log('  ✗ ' + msg); process.exitCode = 1; }
function info(msg){ console.log('    ' + msg); }

// Each test uses a fresh tmp dir so they don't interfere.
function freshDir(tag) {
  const d = path.join(os.tmpdir(), `vcfo-smoke-task7-${tag}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function rmdirSafe(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

function readNdjson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  });
}

(function () {
  console.log('VCFO task-7 smoke — logger round-trips, rotation, tail');

  // ── 1. Round-trip ────────────────────────────────────────────────────────
  section('1. Write / read round-trip');
  {
    const d = freshDir('roundtrip');
    const log = new Logger({ dir: d, mirrorConsole: false });
    log.info('hello', { foo: 1, bar: 'baz' });
    log.warn('careful');
    log.error('boom', errCtx(new Error('oops')));
    const file = path.join(d, 'agent.log');
    if (!fs.existsSync(file)) { fail('active log file not created'); rmdirSafe(d); return; }
    const rows = readNdjson(file).filter(Boolean);
    if (rows.length !== 3) { fail(`expected 3 lines, got ${rows.length}`); rmdirSafe(d); return; }
    const [r0, r1, r2] = rows;
    if (r0.level !== 'info' || r0.msg !== 'hello' || r0.foo !== 1 || r0.bar !== 'baz') {
      fail('info record missing fields: ' + JSON.stringify(r0));
    } else ok('info line parsed with ctx merged');
    if (r1.level !== 'warn' || r1.msg !== 'careful') fail('warn line shape wrong');
    else ok('warn line parsed');
    if (r2.level !== 'error' || r2.msg !== 'boom' || !r2.err || !r2.stack) fail('errCtx not captured: ' + JSON.stringify(r2));
    else ok('error line captured err.message + stack via errCtx');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(String(r0.ts))) fail('ts not ISO-8601: ' + r0.ts);
    else ok('ts is ISO-8601');
    rmdirSafe(d);
  }

  // ── 2. Level filtering ───────────────────────────────────────────────────
  section('2. Level filtering');
  {
    const d = freshDir('levels');
    const log = new Logger({ dir: d, mirrorConsole: false, minLevel: 'warn' });
    log.debug('dropped');
    log.info('dropped');
    log.warn('kept');
    log.error('kept');
    const rows = readNdjson(path.join(d, 'agent.log')).filter(Boolean);
    if (rows.length !== 2) fail(`expected 2 lines after minLevel=warn, got ${rows.length}`);
    else if (rows[0].msg !== 'kept' || rows[1].msg !== 'kept') fail('wrong lines kept');
    else ok('debug/info filtered below minLevel=warn');
    rmdirSafe(d);
  }

  // ── 3. Rotation by size ──────────────────────────────────────────────────
  section('3. Rotation by size');
  {
    const d = freshDir('rotate');
    // Force a tiny maxBytes so even a handful of lines triggers rotation.
    const log = new Logger({ dir: d, mirrorConsole: false, maxBytes: 64 * 1024, maxFiles: 3 });
    // Write ~1500 bytes per line, want > 64 KB → ~45 lines.
    const payload = 'x'.repeat(1200);
    for (let i = 0; i < 200; i += 1) log.info('filler', { i, payload });
    const files = fs.readdirSync(d).sort();
    const rotated = files.filter((f) => /^agent\.log\.\d+$/.test(f));
    if (rotated.length < 1 || rotated.length > 3) {
      fail(`expected 1..3 rotated files, got ${rotated.length}: ${files.join(', ')}`);
    } else {
      ok(`rotation produced ${rotated.length} rotated file(s): ${rotated.join(', ')}`);
    }
    // Active file should be smaller than maxBytes now (just the lines written
    // since the last rotation).
    const activeSize = fs.statSync(path.join(d, 'agent.log')).size;
    if (activeSize > 64 * 1024) {
      fail(`active file exceeds maxBytes: ${activeSize}`);
    } else {
      ok(`active file size = ${activeSize} B (< maxBytes)`);
    }
    // maxFiles=3 → agent.log.4 must never exist.
    if (fs.existsSync(path.join(d, 'agent.log.4'))) {
      fail('agent.log.4 present despite maxFiles=3');
    } else {
      ok('maxFiles=3 respected (no agent.log.4)');
    }
    rmdirSafe(d);
  }

  // ── 4. Tail with malformed line ──────────────────────────────────────────
  section('4. tail() returns parsed rows, skips malformed');
  {
    const d = freshDir('tail');
    const log = new Logger({ dir: d, mirrorConsole: false });
    for (let i = 0; i < 5; i += 1) log.info('row', { i });
    // Inject a garbage line manually to test resilience.
    fs.appendFileSync(path.join(d, 'agent.log'), 'this is not json\n', 'utf8');
    log.info('last', { tag: 'z' });
    const t3 = log.tail(3);
    if (t3.length !== 3) fail(`tail(3) returned ${t3.length} rows, expected 3`);
    else if (t3[t3.length - 1].msg !== 'last') fail('tail not newest-last');
    else ok('tail returned 3 newest-last rows; malformed line skipped');
    rmdirSafe(d);
  }

  // ── 5. Disk-unwritable directory must not throw ──────────────────────────
  section('5. Disk errors are swallowed');
  {
    // Point at a path that can never be created (nul is a reserved Windows
    // device name; on POSIX /dev/null is a file not a dir so mkdirSync throws).
    // Either way, the Logger must NOT throw to callers.
    const badDir = process.platform === 'win32'
      ? 'Z:\\definitely-not-a-drive-' + Date.now()
      : '/proc/definitely-not-a-dir-' + Date.now();
    const log = new Logger({ dir: badDir, mirrorConsole: false });
    let threw = false;
    try {
      log.info('should not throw');
      log.error('also should not throw', { x: 1 });
    } catch (e) {
      threw = true;
      fail('logger threw on unwritable dir: ' + e.message);
    }
    if (!threw) ok('writes to unwritable dir swallowed silently');
  }

  // ── 6. errCtx on non-Error values ────────────────────────────────────────
  section('6. errCtx resilient to non-Error inputs');
  {
    const a = errCtx('plain string');
    const b = errCtx({ some: 'object' });
    const c = errCtx(null);
    const d = errCtx(undefined);
    if (!a.err || !b.err || !c.err || !d.err) fail('errCtx should always return .err');
    else ok('errCtx stringifies non-Error inputs');
  }

  console.log('\n── Summary ───────────────────────────────────────────────────────────────');
  if (process.exitCode === 1) {
    console.log('  ✗ Smoke test FAILED — see above');
  } else {
    console.log('  ✓ All checks passed');
  }
})();
