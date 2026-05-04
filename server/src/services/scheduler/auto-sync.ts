// End-of-day auto-sync scheduler.
//
// One node-cron job fires at 23:00 Asia/Kolkata. Each tick walks every
// active tenant + branch with the per-branch opt-in flag set, then calls
// the existing runner for HealthPlix and OneGlance. Manual-run locks in
// routes/sync.ts are honoured — auto runs that would clash record a
// 'skipped' row and exit instead of starting a second Chromium.

import cron from 'node-cron';
import { getPlatformHelper } from '../../db/platform-connection.js';
import { getClientHelper } from '../../db/connection.js';
import { todayIst, yesterdayIst, istHourPassed } from '../../utils/ist-date.js';
import { branchSettingsKey, type BranchContext } from '../../utils/branch.js';
import { runHealthplixSync } from '../sync/healthplix-runner.js';
import { runOneglanceSync } from '../sync/oneglance-runner.js';
import { getHpState, getOgState } from '../../routes/sync.js';

const SCHEDULE_HOUR = 23;
const SCHEDULE_CRON = `0 ${SCHEDULE_HOUR} * * *`;
const TZ = 'Asia/Kolkata';

type Source = 'healthplix' | 'oneglance';
type Trigger = 'schedule' | 'catchup' | 'manual_test';

let isTickRunning = false;
let registeredTask: ReturnType<typeof cron.schedule> | null = null;

interface Target {
  clientId: number;
  slug: string;
  branchId: number | null;
  isMultiBranch: boolean;
  source: Source;
}

/**
 * Build the BranchContext shape expected by the runner. branchMode is
 * 'specific' for multi-branch targets so dashboard rollup writes get
 * scoped correctly; 'single' for single-branch tenants.
 */
function ctxFor(target: Target): BranchContext {
  return {
    isMultiBranch: target.isMultiBranch,
    branchId: target.branchId,
    branchMode: target.isMultiBranch ? 'specific' : 'single',
    allowedBranchIds: target.branchId ? [target.branchId] : [],
    streamMode: 'none',
    streamId: null,
  };
}

async function enumerateTargets(): Promise<Target[]> {
  const platformDb = await getPlatformHelper();
  const targets: Target[] = [];

  const clients: Array<{ id: number; slug: string; is_multi_branch?: number }> =
    platformDb.all('SELECT id, slug, is_multi_branch FROM clients WHERE is_active = 1');

  for (const client of clients) {
    const isMultiBranch = !!client.is_multi_branch;
    const branchRows: Array<{ id: number }> = isMultiBranch
      ? platformDb.all('SELECT id FROM branches WHERE client_id = ? AND is_active = 1', client.id)
      : [];
    const branchIds: (number | null)[] = isMultiBranch
      ? branchRows.map(b => b.id)
      : [null];

    // Per-source: must be enabled in client_integrations
    const enabledSources: Source[] = [];
    for (const src of ['healthplix', 'oneglance'] as Source[]) {
      const row = platformDb.get(
        'SELECT is_enabled FROM client_integrations WHERE client_id = ? AND integration_key = ?',
        client.id, src
      );
      if (row?.is_enabled) enabledSources.push(src);
    }
    if (enabledSources.length === 0) continue;

    // Per-branch: must have the opt-in flag in tenant DB's app_settings
    const tenantDb = await getClientHelper(client.slug);
    for (const branchId of branchIds) {
      const ctx: BranchContext = {
        isMultiBranch,
        branchId,
        branchMode: isMultiBranch ? 'specific' : 'single',
        allowedBranchIds: branchId ? [branchId] : [],
      };
      for (const src of enabledSources) {
        const flagKey = branchSettingsKey(`auto_sync_${src}_enabled`, ctx);
        const flagRow = tenantDb.get('SELECT value FROM app_settings WHERE key = ?', flagKey);
        if (flagRow?.value !== '1') continue;
        targets.push({ clientId: client.id, slug: client.slug, branchId, isMultiBranch, source: src });
      }
    }
  }

  return targets;
}

function isLocked(slug: string, source: Source): boolean {
  const state = source === 'healthplix' ? getHpState(slug) : getOgState(slug);
  return !!state.activeSyncId;
}

/** Set a syncing lock + reset progress. Returns the syncId so callers can release it. */
function acquireLock(slug: string, source: Source): string {
  const state = source === 'healthplix' ? getHpState(slug) : getOgState(slug);
  const syncId = `auto-${Date.now()}`;
  state.activeSyncId = syncId;
  state.progress = { step: 'starting', message: 'Auto-sync starting...', pct: 0 };
  return syncId;
}

function releaseLockOnError(slug: string, source: Source, syncId: string, errMsg: string) {
  const state = source === 'healthplix' ? getHpState(slug) : getOgState(slug);
  if (state.activeSyncId === syncId) {
    state.progress = { step: 'error', message: errMsg, pct: 0, error: errMsg };
    state.activeSyncId = null;
  }
}

function releaseLockOnComplete(slug: string, source: Source, syncId: string, message: string, result: any) {
  const state = source === 'healthplix' ? getHpState(slug) : getOgState(slug);
  state.progress = { step: 'complete', message, pct: 100, result };
  setTimeout(() => {
    if (state.activeSyncId === syncId) {
      state.activeSyncId = null;
      state.progress = null;
    }
  }, 60_000);
}

async function alreadyRanToday(
  slug: string, runDate: string, branchId: number | null, source: Source
): Promise<boolean> {
  const db = await getClientHelper(slug);
  const row = db.get(
    `SELECT 1 FROM auto_sync_runs
     WHERE run_date_ist = ? AND branch_id IS ? AND source = ?
       AND status IN ('success','running')`,
    runDate, branchId, source
  );
  return !!row;
}

/** Run a single (tenant, branch, source) target. */
export async function runAutoSyncForTarget(target: Target, trigger: Trigger): Promise<void> {
  const { slug, clientId, branchId, source } = target;
  const today = todayIst();
  const yesterday = yesterdayIst();
  const ctx = ctxFor(target);

  const tenantDb = await getClientHelper(slug);
  const startedAt = new Date().toISOString();

  // Insert a 'running' row up front so a concurrent boot/cron can see it.
  // INSERT OR REPLACE on (date, branch, source, trigger) — if a previous
  // run for this same key exists (e.g. error retry), overwrite it.
  tenantDb.run(
    `INSERT OR REPLACE INTO auto_sync_runs
     (run_date_ist, branch_id, source, trigger, status, started_at)
     VALUES (?, ?, ?, ?, 'running', ?)`,
    today, branchId, source, trigger, startedAt
  );
  const runRow = tenantDb.get(
    `SELECT id FROM auto_sync_runs WHERE run_date_ist = ? AND branch_id IS ? AND source = ? AND trigger = ?`,
    today, branchId, source, trigger
  );
  const runId = runRow?.id || 0;

  const logTag = `[auto-sync][tenant=${slug} branch=${branchId} source=${source} trigger=${trigger}]`;
  console.log(`${logTag} starting (window ${yesterday}..${today})`);

  if (isLocked(slug, source)) {
    const msg = 'manual run in progress';
    console.log(`${logTag} skipped — ${msg}`);
    tenantDb.run(
      `UPDATE auto_sync_runs SET status = 'skipped', finished_at = ?, error = ? WHERE id = ?`,
      new Date().toISOString(), msg, runId
    );
    return;
  }

  const syncId = acquireLock(slug, source);
  try {
    if (source === 'healthplix') {
      const res = await runHealthplixSync({
        tenantSlug: slug, clientId, ctx, branchId,
        fromDate: yesterday, toDate: today,
        trigger: trigger === 'schedule' ? 'auto-schedule' : trigger === 'catchup' ? 'auto-catchup' : 'auto-test',
        onProgress: (step, message, pct) => {
          const state = getHpState(slug);
          state.progress = { step, message, pct };
        },
      });
      tenantDb.run(
        `UPDATE auto_sync_runs SET status = 'success', finished_at = ?, rows_imported = ?, import_id = ? WHERE id = ?`,
        new Date().toISOString(), res.rowsImported, res.importId, runId
      );
      console.log(`${logTag} success — ${res.rowsImported} rows`);
      releaseLockOnComplete(slug, source, syncId, `Auto-sync completed — ${res.rowsImported} rows`, { importId: res.importId });
    } else {
      const res = await runOneglanceSync({
        tenantSlug: slug, clientId, ctx, branchId,
        fromDate: yesterday, toDate: today,
        reportType: 'all',
        trigger: trigger === 'schedule' ? 'auto-schedule' : trigger === 'catchup' ? 'auto-catchup' : 'auto-test',
        onProgress: (step, message, pct) => {
          const state = getOgState(slug);
          state.progress = { step, message, pct };
        },
      });
      const firstImportId = res.importIds.sales || res.importIds.purchase || res.importIds.stock || res.importIds.transfer || 0;
      tenantDb.run(
        `UPDATE auto_sync_runs SET status = 'success', finished_at = ?, rows_imported = ?, import_id = ? WHERE id = ?`,
        new Date().toISOString(), res.totalRows, firstImportId, runId
      );
      console.log(`${logTag} success — ${res.totalRows} rows`);
      releaseLockOnComplete(slug, source, syncId, `Auto-sync completed — ${res.totalRows} rows`, { totalRows: res.totalRows });
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`${logTag} failed: ${msg}`);
    tenantDb.run(
      `UPDATE auto_sync_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
      new Date().toISOString(), msg, runId
    );
    releaseLockOnError(slug, source, syncId, msg);
  }
}

/** Run all eligible targets sequentially. Used by both the scheduled tick and the boot-time catchup. */
export async function runAutoSyncTick(trigger: Trigger): Promise<void> {
  if (isTickRunning) {
    console.log('[auto-sync] tick already running — skipping re-entry');
    return;
  }
  isTickRunning = true;
  const startedAt = Date.now();

  try {
    const targets = await enumerateTargets();
    console.log(`[auto-sync] tick=${trigger} targets=${targets.length}`);

    for (const target of targets) {
      // For catchup, skip targets that already ran successfully today.
      if (trigger === 'catchup') {
        const ranAlready = await alreadyRanToday(target.slug, todayIst(), target.branchId, target.source);
        if (ranAlready) {
          console.log(`[auto-sync][tenant=${target.slug} branch=${target.branchId} source=${target.source}] catchup skip — already ran today`);
          continue;
        }
      }
      try {
        await runAutoSyncForTarget(target, trigger);
      } catch (err: any) {
        console.error(`[auto-sync] unexpected error for tenant=${target.slug} branch=${target.branchId} source=${target.source}:`, err?.message || err);
      }
    }
  } finally {
    isTickRunning = false;
    console.log(`[auto-sync] tick=${trigger} finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
}

/**
 * Manual entry point used by POST /api/sync/auto/run-now. Runs a single
 * (tenant, branch, source) target with trigger='manual_test' so the audit
 * row is distinguishable from the scheduled run for the same date.
 */
export async function runAutoSyncOneOff(opts: {
  clientId: number;
  slug: string;
  branchId: number | null;
  isMultiBranch: boolean;
  source: Source;
}): Promise<void> {
  await runAutoSyncForTarget(
    {
      clientId: opts.clientId,
      slug: opts.slug,
      branchId: opts.branchId,
      isMultiBranch: opts.isMultiBranch,
      source: opts.source,
    },
    'manual_test'
  );
}

/**
 * Register the cron job. Idempotent — calling twice replaces the prior task.
 * Honours AUTO_SYNC_ENABLED env flag — off by default so dev servers don't
 * launch Chromium at 23:00 IST.
 */
export function registerAutoSync(): void {
  if (process.env.AUTO_SYNC_ENABLED !== 'true') {
    console.log('[auto-sync] disabled (set AUTO_SYNC_ENABLED=true to enable)');
    return;
  }

  // Stop any previously registered task (defensive — node-cron handles this
  // fine but we want explicit cleanup if registerAutoSync is ever called twice).
  if (registeredTask) {
    try { registeredTask.stop(); } catch {}
    registeredTask = null;
  }

  registeredTask = cron.schedule(
    SCHEDULE_CRON,
    () => { runAutoSyncTick('schedule').catch(err => console.error('[auto-sync] tick error:', err)); },
    { timezone: TZ }
  );
  console.log(`[auto-sync] registered: ${SCHEDULE_CRON} ${TZ}`);
}

/**
 * Boot-time catch-up — if we're past 23:00 IST and today's tick hasn't run
 * yet for some target, run it now.
 */
export function scheduleCatchup(): void {
  if (process.env.AUTO_SYNC_ENABLED !== 'true') return;
  if (!istHourPassed(SCHEDULE_HOUR)) {
    console.log('[auto-sync] catchup skipped — before scheduled time today');
    return;
  }
  setImmediate(() => {
    runAutoSyncTick('catchup').catch(err => console.error('[auto-sync] catchup error:', err));
  });
}
