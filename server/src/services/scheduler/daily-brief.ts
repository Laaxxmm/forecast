// 8 AM IST cron that emails the Daily Brief to every active recipient.
//
// Walks every active tenant + branch with at least one active recipient,
// gathers data for yesterday-IST, renders, and sends via the configured
// Office 365 SMTP transport.
//
// One main fire at 08:00 plus a single retry at 09:00 — the retry is
// short-circuited by alreadyRanForDate() so successful branches aren't
// re-sent. Mirrors the conservative pattern in auto-sync.ts.

import cron from 'node-cron';
import { getPlatformHelper } from '../../db/platform-connection.js';
import { getClientHelper } from '../../db/connection.js';
import { todayIst, yesterdayIst } from '../../utils/ist-date.js';
import type { BranchContext } from '../../utils/branch.js';
import { runDailyBriefSend, alreadyRanForDate, type SendTrigger } from '../daily-brief/send.js';
import { getMailerConfig } from '../daily-brief/mailer.js';

const TZ = 'Asia/Kolkata';
const SCHEDULE_CRON = '0 8 * * *';
const RETRY_CRON = '0 9 * * *';

let mainTask: ReturnType<typeof cron.schedule> | null = null;
let retryTask: ReturnType<typeof cron.schedule> | null = null;
let isTickRunning = false;

interface Target {
  clientId: number;
  slug: string;
  branchId: number | null;
  isMultiBranch: boolean;
}

async function enumerateTargets(): Promise<Target[]> {
  const platformDb = await getPlatformHelper();
  const targets: Target[] = [];
  const clients: Array<{ id: number; slug: string; is_multi_branch?: number }> =
    platformDb.all('SELECT id, slug, is_multi_branch FROM clients WHERE is_active = 1');

  for (const client of clients) {
    const isMultiBranch = !!client.is_multi_branch;
    const tenantDb = await getClientHelper(client.slug);

    // Pull every branch_id the recipients table refers to. NULL is the
    // consolidated subscriber set; specific ids fan out per branch.
    const recipientBranchIds: Array<{ branch_id: number | null }> = tenantDb.all(
      `SELECT DISTINCT branch_id FROM daily_brief_recipients WHERE is_active = 1`
    );
    if (recipientBranchIds.length === 0) continue;

    if (!isMultiBranch) {
      targets.push({ clientId: client.id, slug: client.slug, branchId: null, isMultiBranch });
      continue;
    }

    // Multi-branch: send one brief per branch that has recipients (either
    // explicitly subscribed to that branch OR via the NULL/consolidated
    // bucket — the runner unions the two for branch-specific sends).
    const branchRows: Array<{ id: number }> = platformDb.all(
      'SELECT id FROM branches WHERE client_id = ? AND is_active = 1',
      client.id
    );
    const explicitBranches = recipientBranchIds.filter(r => r.branch_id !== null).map(r => r.branch_id!);
    const hasConsolidated = recipientBranchIds.some(r => r.branch_id === null);
    const branchesToSend = hasConsolidated
      ? branchRows.map(b => b.id)
      : branchRows.map(b => b.id).filter(id => explicitBranches.includes(id));

    for (const branchId of branchesToSend) {
      targets.push({ clientId: client.id, slug: client.slug, branchId, isMultiBranch });
    }
  }
  return targets;
}

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

async function tick(trigger: SendTrigger) {
  if (isTickRunning) {
    console.log('[daily-brief] tick already running — skipping');
    return;
  }
  if (!getMailerConfig()) {
    console.warn('[daily-brief] SMTP not configured (SMTP_USER / SMTP_PASS missing) — skipping tick');
    return;
  }
  isTickRunning = true;
  const reportDate = yesterdayIst();
  const todayDate = todayIst();
  const startedAt = Date.now();
  try {
    const targets = await enumerateTargets();
    console.log(`[daily-brief] ${trigger} tick — ${targets.length} target(s) for ${reportDate}`);
    for (const target of targets) {
      const tenantDb = await getClientHelper(target.slug);
      // Catchup runs skip branches that already succeeded today.
      if (trigger === 'catchup' && alreadyRanForDate(tenantDb, reportDate, target.branchId)) {
        continue;
      }
      try {
        const result = await runDailyBriefSend({
          db: tenantDb,
          ctx: ctxFor(target),
          clientId: target.clientId,
          branchId: target.branchId,
          reportDate,
          todayDate,
          trigger,
          filedAtLabel: '8:00 AM',
        });
        console.log(`[daily-brief] ${target.slug} branch=${target.branchId ?? 'null'} → ${result.status} (${result.recipientCount} recipients)${result.error ? ' · ' + result.error : ''}`);
      } catch (err: any) {
        console.error(`[daily-brief] ${target.slug} branch=${target.branchId ?? 'null'} threw:`, err?.message || err);
      }
    }
  } finally {
    isTickRunning = false;
    console.log(`[daily-brief] tick done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
}

export function registerDailyBrief() {
  if (mainTask || retryTask) {
    console.log('[daily-brief] already registered, skipping re-registration');
    return;
  }
  mainTask = cron.schedule(SCHEDULE_CRON, () => { tick('schedule'); }, { timezone: TZ });
  retryTask = cron.schedule(RETRY_CRON, () => { tick('catchup'); }, { timezone: TZ });
  console.log(`[daily-brief] cron registered — main ${SCHEDULE_CRON} ${TZ}, retry ${RETRY_CRON} ${TZ}`);
}

// Manual trigger for the "Run now" admin action — currently only wired
// internally; routes that need it can import directly. Returns nothing
// (results are visible in daily_brief_sends).
export async function runDailyBriefNow(): Promise<void> {
  await tick('manual_test');
}
