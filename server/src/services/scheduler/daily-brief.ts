// Daily Brief at 8 AM IST + Weekly Pulse at 7:30 AM IST every Monday.
//
// Walks every active tenant + branch with at least one active recipient
// for the relevant cadence, gathers data, renders, and sends via the
// configured Office 365 SMTP transport.
//
// Daily: main at 08:00, catchup at 09:00. Weekly: main Mon 07:30, catchup
// Mon 08:30. Catchup runs short-circuit on alreadyRanForDate() so
// successful branches aren't re-sent.

import cron from 'node-cron';
import { getPlatformHelper } from '../../db/platform-connection.js';
import { getClientHelper } from '../../db/connection.js';
import { todayIst, yesterdayIst } from '../../utils/ist-date.js';
import type { BranchContext } from '../../utils/branch.js';
import { runDailyBriefSend, alreadyRanForDate, type SendTrigger, type Cadence } from '../daily-brief/send.js';
import { getMailerConfig } from '../daily-brief/mailer.js';

const TZ = 'Asia/Kolkata';
const DAILY_CRON = '0 8 * * *';
const DAILY_RETRY_CRON = '0 9 * * *';
// Weekly fires on Monday only (cron weekday 1 = Monday).
const WEEKLY_CRON = '30 7 * * 1';
const WEEKLY_RETRY_CRON = '30 8 * * 1';

let dailyTask: ReturnType<typeof cron.schedule> | null = null;
let dailyRetryTask: ReturnType<typeof cron.schedule> | null = null;
let weeklyTask: ReturnType<typeof cron.schedule> | null = null;
let weeklyRetryTask: ReturnType<typeof cron.schedule> | null = null;
let isTickRunning = false;

interface Target {
  clientId: number;
  slug: string;
  branchId: number | null;
  isMultiBranch: boolean;
}

async function enumerateTargets(cadence: Cadence): Promise<Target[]> {
  const platformDb = await getPlatformHelper();
  const targets: Target[] = [];
  const clients: Array<{ id: number; slug: string; is_multi_branch?: number }> =
    platformDb.all('SELECT id, slug, is_multi_branch FROM clients WHERE is_active = 1');

  for (const client of clients) {
    const isMultiBranch = !!client.is_multi_branch;
    const tenantDb = await getClientHelper(client.slug);

    // Pull every branch_id the recipients table refers to FOR THIS CADENCE.
    // 'both' rows count for either cadence; daily/weekly rows only for
    // their own. NULL = consolidated subscriber set; specific ids fan out
    // per branch.
    const recipientBranchIds: Array<{ branch_id: number | null }> = tenantDb.all(
      `SELECT DISTINCT branch_id FROM daily_brief_recipients
        WHERE is_active = 1 AND (cadence = ? OR cadence = 'both')`,
      cadence
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

// Compute the just-past Sunday's date (YYYY-MM-DD) given today's date.
// Used by the weekly tick to know which week is being summarised.
function previousSundayIst(today: string): string {
  const [yy, mm, dd] = today.split('-').map(Number);
  const d = new Date(yy, mm - 1, dd);
  const dayOfWeek = d.getDay();             // 0=Sun, 1=Mon, …
  const daysSinceSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
  d.setDate(d.getDate() - daysSinceSunday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function tick(cadence: Cadence, trigger: SendTrigger) {
  const tag = `[${cadence}]`;
  if (isTickRunning) {
    console.log(`${tag} tick already running — skipping`);
    return;
  }
  if (!getMailerConfig()) {
    console.warn(`${tag} SMTP not configured (SMTP_USER / SMTP_PASS missing) — skipping tick`);
    return;
  }
  isTickRunning = true;
  const todayDate = todayIst();
  // Daily reports on yesterday-IST; weekly reports on the just-past Sunday.
  const reportDate = cadence === 'weekly' ? previousSundayIst(todayDate) : yesterdayIst();
  const filedAtLabel = cadence === 'weekly' ? '7:30 AM' : '8:00 AM';
  const startedAt = Date.now();
  try {
    const targets = await enumerateTargets(cadence);
    console.log(`${tag} ${trigger} tick — ${targets.length} target(s) for ${reportDate}`);
    for (const target of targets) {
      const tenantDb = await getClientHelper(target.slug);
      if (trigger === 'catchup' && alreadyRanForDate(tenantDb, reportDate, target.branchId, cadence)) {
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
          cadence,
          filedAtLabel,
        });
        console.log(`${tag} ${target.slug} branch=${target.branchId ?? 'null'} → ${result.status} (${result.recipientCount} recipients)${result.error ? ' · ' + result.error : ''}`);
      } catch (err: any) {
        console.error(`${tag} ${target.slug} branch=${target.branchId ?? 'null'} threw:`, err?.message || err);
      }
    }
  } finally {
    isTickRunning = false;
    console.log(`${tag} tick done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
}

export function registerDailyBrief() {
  if (dailyTask || dailyRetryTask || weeklyTask || weeklyRetryTask) {
    console.log('[daily-brief] already registered, skipping re-registration');
    return;
  }
  dailyTask      = cron.schedule(DAILY_CRON,        () => { tick('daily', 'schedule'); }, { timezone: TZ });
  dailyRetryTask = cron.schedule(DAILY_RETRY_CRON,  () => { tick('daily', 'catchup');  }, { timezone: TZ });
  weeklyTask     = cron.schedule(WEEKLY_CRON,       () => { tick('weekly', 'schedule'); }, { timezone: TZ });
  weeklyRetryTask= cron.schedule(WEEKLY_RETRY_CRON, () => { tick('weekly', 'catchup');  }, { timezone: TZ });
  console.log(`[daily-brief] cron registered — daily ${DAILY_CRON} / ${DAILY_RETRY_CRON} ${TZ}; weekly ${WEEKLY_CRON} / ${WEEKLY_RETRY_CRON} ${TZ}`);
}

// Manual trigger for the "Run now" admin action — currently only wired
// internally; routes that need it can import directly. Returns nothing
// (results are visible in daily_brief_sends).
export async function runDailyBriefNow(cadence: Cadence = 'daily'): Promise<void> {
  await tick(cadence, 'manual_test');
}
