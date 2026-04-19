// ─────────────────────────────────────────────────────────────────────────────
// Task-8 smoke test — desktop notifier. Pure local, no Electron host,
// no network. We inject a mock Notification constructor so the Notifier
// class can be exercised fully outside an Electron main process.
//
// Checks:
//   1. enabled=false → never fires, logs notify.skip(disabled)
//   2. enabled=true + supported → first fire works
//   3. Same channel, within cooldown → skipped with reason=cooldown
//   4. bypassCooldown=true → fires even within cooldown window
//   5. Different channels are independent (one's cooldown doesn't suppress the other)
//   6. resetCooldown(ch) lets the next fire go through
//   7. onClick handler is attached and fires when the mock emits 'click'
//   8. Notification throw is caught and logged as notify.error
//   9. isSupported()=false → skipped with reason=unsupported
//
// Usage: node scripts/smoke-task8.js
// ─────────────────────────────────────────────────────────────────────────────

const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist-electron', 'lib');
const { Notifier } = require(path.join(DIST, 'notifier.js'));

function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(1, 70 - title.length)));
}
function ok(msg)  { console.log('  ✓ ' + msg); }
function fail(msg){ console.log('  ✗ ' + msg); process.exitCode = 1; }

// Mock Notification that records every call and lets us invoke the click
// handler on demand. Mirrors the minimal Electron Notification contract:
//   new Notification(opts) → { show(), on(event, cb) }
function makeMockNotification(options = {}) {
  const shown = [];
  const clickHandlers = [];
  class MockNotification {
    constructor(opts) {
      this.opts = opts;
      shown.push(opts);
      if (options.shouldThrowOnShow) this._throwOnShow = true;
      if (options.shouldThrowOnNew) throw new Error('mock throw on construct');
    }
    show() {
      if (this._throwOnShow) throw new Error('mock throw on show');
    }
    on(evt, cb) {
      if (evt === 'click') clickHandlers.push(cb);
    }
  }
  return { MockNotification, shown, fireClick: () => clickHandlers.forEach((cb) => cb()) };
}

// Small helper: capture the messages the logger callback receives.
function makeCapLogger() {
  const events = [];
  const fn = (msg, ctx) => events.push({ msg, ctx });
  return { fn, events };
}

(function () {
  console.log('VCFO task-8 smoke — notifier cooldowns, transitions, click');

  // 1. Disabled → no fires ───────────────────────────────────────────────────
  section('1. enabled=false → always skipped');
  {
    const { MockNotification, shown } = makeMockNotification();
    const { fn: log, events } = makeCapLogger();
    const n = new Notifier(() => false, { NotificationCtor: MockNotification, isSupported: () => true, cooldownMs: 1000 });
    n.setLogger(log);
    const fired = n.fire('sync_fail', 'X', 'Y');
    if (fired) fail('fire returned true despite enabled=false');
    else if (shown.length !== 0) fail('Notification was constructed despite enabled=false');
    else if (!events.some((e) => e.msg === 'notify.skip' && e.ctx.reason === 'disabled')) fail('expected notify.skip/disabled log');
    else ok('skipped with reason=disabled, no ctor call');
  }

  // 2. Happy path ────────────────────────────────────────────────────────────
  section('2. enabled+supported → fire() returns true, ctor called');
  {
    const { MockNotification, shown } = makeMockNotification();
    const { fn: log, events } = makeCapLogger();
    const n = new Notifier(() => true, { NotificationCtor: MockNotification, isSupported: () => true, cooldownMs: 60_000 });
    n.setLogger(log);
    const fired = n.fire('sync_fail', 'Sync failed', 'body');
    if (!fired) fail('fire returned false on happy path');
    else if (shown.length !== 1) fail(`expected 1 Notification ctor call, got ${shown.length}`);
    else if (shown[0].title !== 'Sync failed' || shown[0].body !== 'body') fail('title/body not forwarded');
    else if (!events.some((e) => e.msg === 'notify.fired')) fail('expected notify.fired log');
    else ok('ctor called, notify.fired logged');
  }

  // 3. Cooldown suppression ──────────────────────────────────────────────────
  section('3. Same channel within cooldown → skipped');
  {
    const { MockNotification, shown } = makeMockNotification();
    const n = new Notifier(() => true, { NotificationCtor: MockNotification, isSupported: () => true, cooldownMs: 60_000 });
    const a = n.fire('sync_fail', 'A', 'a');
    const b = n.fire('sync_fail', 'B', 'b');
    if (!a) fail('first fire suppressed');
    else if (b) fail('second fire within cooldown should be suppressed');
    else if (shown.length !== 1) fail(`expected 1 ctor call, got ${shown.length}`);
    else ok('first fires; second within 60s cooldown is suppressed');
  }

  // 4. bypassCooldown ────────────────────────────────────────────────────────
  section('4. bypassCooldown=true fires anyway');
  {
    const { MockNotification, shown } = makeMockNotification();
    const n = new Notifier(() => true, { NotificationCtor: MockNotification, isSupported: () => true, cooldownMs: 60_000 });
    n.fire('sync_fail', 'A', 'a');
    const b = n.fire('sync_fail', 'B', 'b', { bypassCooldown: true });
    if (!b) fail('bypassCooldown=true did not fire');
    else if (shown.length !== 2) fail(`expected 2 ctor calls, got ${shown.length}`);
    else ok('bypassCooldown forces fire through cooldown');
  }

  // 5. Independent channels ──────────────────────────────────────────────────
  section('5. Different channels are independent');
  {
    const { MockNotification, shown } = makeMockNotification();
    const n = new Notifier(() => true, { NotificationCtor: MockNotification, isSupported: () => true, cooldownMs: 60_000 });
    n.fire('sync_fail', 'F', 'f');
    const b = n.fire('sync_recovered', 'R', 'r');
    const c = n.fire('queue_deadletter', 'D', 'd');
    if (!b || !c) fail('different channels should each fire');
    else if (shown.length !== 3) fail(`expected 3 ctor calls, got ${shown.length}`);
    else ok('sync_fail, sync_recovered, queue_deadletter fire independently');
  }

  // 6. resetCooldown ─────────────────────────────────────────────────────────
  section('6. resetCooldown clears state');
  {
    const { MockNotification, shown } = makeMockNotification();
    const n = new Notifier(() => true, { NotificationCtor: MockNotification, isSupported: () => true, cooldownMs: 60_000 });
    n.fire('sync_fail', 'A', 'a');
    const beforeReset = n.fire('sync_fail', 'B', 'b');
    n.resetCooldown('sync_fail');
    const afterReset = n.fire('sync_fail', 'C', 'c');
    if (beforeReset) fail('fire before reset should be suppressed by cooldown');
    else if (!afterReset) fail('fire after reset should go through');
    else if (shown.length !== 2) fail(`expected 2 ctor calls, got ${shown.length}`);
    else ok('resetCooldown(channel) re-enables the next fire');

    // Also test resetCooldown() with no arg clears all channels
    n.fire('other', 'X', 'x');
    n.resetCooldown();
    const againA = n.fire('sync_fail', 'Y', 'y');
    const againO = n.fire('other', 'Z', 'z');
    if (!againA || !againO) fail('resetCooldown() should clear all channels');
    else ok('resetCooldown() with no arg clears all channels');
  }

  // 7. onClick wiring ────────────────────────────────────────────────────────
  section('7. onClick handler fires when user clicks');
  {
    const { MockNotification, fireClick } = makeMockNotification();
    let clicks = 0;
    const n = new Notifier(() => true, {
      NotificationCtor: MockNotification,
      isSupported: () => true,
      cooldownMs: 0,
      onClick: () => { clicks += 1; },
    });
    n.fire('sync_fail', 'A', 'a');
    fireClick();
    if (clicks !== 1) fail(`expected 1 click, got ${clicks}`);
    else ok('onClick invoked exactly once on notification click');
  }

  // 8. Notification throw caught ─────────────────────────────────────────────
  section('8. Notification constructor throw is caught');
  {
    const { MockNotification } = makeMockNotification({ shouldThrowOnNew: true });
    const { fn: log, events } = makeCapLogger();
    const n = new Notifier(() => true, { NotificationCtor: MockNotification, isSupported: () => true, cooldownMs: 0 });
    n.setLogger(log);
    let threw = false;
    let result;
    try { result = n.fire('sync_fail', 'A', 'a'); } catch { threw = true; }
    if (threw) fail('fire() propagated the ctor throw instead of catching it');
    else if (result !== false) fail('fire() should return false on ctor throw');
    else if (!events.some((e) => e.msg === 'notify.error')) fail('expected notify.error log');
    else ok('ctor throw caught; notify.error logged; fire returns false');
  }

  // 9. isSupported=false → skipped ───────────────────────────────────────────
  section('9. isSupported=false → skipped');
  {
    const { MockNotification, shown } = makeMockNotification();
    const { fn: log, events } = makeCapLogger();
    const n = new Notifier(() => true, { NotificationCtor: MockNotification, isSupported: () => false, cooldownMs: 0 });
    n.setLogger(log);
    const fired = n.fire('sync_fail', 'A', 'a');
    if (fired) fail('fire returned true on unsupported platform');
    else if (shown.length !== 0) fail('ctor called despite unsupported platform');
    else if (!events.some((e) => e.msg === 'notify.skip' && e.ctx.reason === 'unsupported')) fail('expected notify.skip/unsupported');
    else ok('skipped with reason=unsupported');
  }

  // Transition simulation — drive the sync-fail / sync-recovered logic the
  // way main.ts does. This protects against future refactors that
  // re-introduce duplicate fires or miss the recovery event.
  section('10. Transition simulation — fail → fail → recover');
  {
    const { MockNotification, shown } = makeMockNotification();
    const n = new Notifier(() => true, { NotificationCtor: MockNotification, isSupported: () => true, cooldownMs: 60_000 });

    // Reproduce the main.ts finishSync transition logic exactly.
    function onFinish(prev, result) {
      if (!result.ok && (prev === null || prev.ok)) {
        n.fire('sync_fail', 'Sync failed', result.error || 'err', { urgent: true });
      } else if (result.ok && prev && !prev.ok) {
        n.fire('sync_recovered', 'Sync restored', 'back up', { bypassCooldown: true });
      }
    }

    onFinish(null,                  { ok: true, error: undefined });  // ok → no fire
    onFinish({ ok: true },          { ok: false, error: 'boom' });    // transition → sync_fail
    onFinish({ ok: false },         { ok: false, error: 'still' });   // still failing → no fire (no transition)
    onFinish({ ok: false },         { ok: false, error: 'still2' });  // still failing → no fire
    onFinish({ ok: false },         { ok: true });                    // transition → sync_recovered
    onFinish({ ok: true },          { ok: true });                    // ok again → no fire

    const titles = shown.map((s) => s.title);
    const expected = ['Sync failed', 'Sync restored'];
    if (JSON.stringify(titles) !== JSON.stringify(expected)) {
      fail('expected 2 fires [fail, restored], got ' + JSON.stringify(titles));
    } else {
      ok('fail→fail→recover sequence produced exactly one "failed" + one "restored"');
    }
  }

  console.log('\n── Summary ───────────────────────────────────────────────────────────────');
  if (process.exitCode === 1) {
    console.log('  ✗ Smoke test FAILED — see above');
  } else {
    console.log('  ✓ All checks passed');
  }
})();
