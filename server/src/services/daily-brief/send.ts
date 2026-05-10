// High-level "send the Daily Brief for branch X on date Y" orchestrator.
//
// Used by both the cron (services/scheduler/daily-brief.ts) and the manual
// "Send test" endpoint. Looks up recipients, gathers data, renders HTML +
// PDF, hands off to mailer, and writes a daily_brief_sends row for audit.

import type { DbHelper } from '../../db/connection.js';
import type { BranchContext } from '../../utils/branch.js';
import { getPlatformHelper } from '../../db/platform-connection.js';
import { buildDailyBriefData } from './data.js';
import { buildWeeklyPulseData } from './weekly-data.js';
import { renderDailyBriefHtml, renderDailyBriefPdf, dailyBriefFilename } from './render.js';
import { renderWeeklyPulseHtml, renderWeeklyPulsePdf, weeklyPulseFilename } from './weekly-render.js';
import { sendMail } from './mailer.js';

export type Cadence = 'daily' | 'weekly';

export type SendTrigger = 'schedule' | 'manual_test' | 'catchup';

// Process-level mutex shared by the cron tick AND the manual /send-test
// endpoint. Playwright's chromium.launch() costs ~150 MB resident; running
// two simultaneously on a small dyno (256-512 MB) OOMs. Serialising means
// an admin who clicks "Send test" while the 8 AM cron is mid-tick simply
// waits for the cron to finish.
let renderMutex: Promise<void> = Promise.resolve();
function withRenderLock<T>(work: () => Promise<T>): Promise<T> {
  const next = renderMutex.then(work, work);
  // The "release" links to a void chain so the next caller waits for THIS
  // work, regardless of success or failure.
  renderMutex = next.then(() => undefined, () => undefined);
  return next;
}

export interface SendOutcome {
  status: 'success' | 'failed' | 'skipped';
  recipientCount: number;
  accepted: string[];
  rejected: string[];
  error?: string;
}

interface RunOptions {
  db: DbHelper;
  ctx: BranchContext;
  clientId: number;
  branchId: number | null;       // null = consolidated
  reportDate: string;            // YYYY-MM-DD — yesterday in IST (daily) OR Sunday of prior week (weekly)
  todayDate: string;             // YYYY-MM-DD — today in IST (daily) OR Monday issue date (weekly)
  trigger: SendTrigger;
  cadence?: Cadence;             // 'daily' (default) or 'weekly'
  // Override the recipient list. Used by "Send test now" with a single
  // tester. When omitted, recipients are loaded from daily_brief_recipients
  // for this branch + cadence (plus consolidated rows when branch is specific).
  overrideRecipients?: string[];
  syncedAtLabel?: string;
  filedAtLabel?: string;
}

export async function runDailyBriefSend(opts: RunOptions): Promise<SendOutcome> {
  const { db, ctx, clientId, branchId, reportDate, todayDate, trigger } = opts;
  const cadence: Cadence = opts.cadence || 'daily';
  const startedAt = new Date().toISOString();

  // 1. Resolve recipients (cadence-scoped — daily-only subscribers don't
  // get the weekly mail and vice versa; 'both' rows are included for
  // either cadence).
  const recipients = opts.overrideRecipients ?? loadActiveRecipients(db, branchId, cadence);
  if (recipients.length === 0) {
    writeAuditRow(db, {
      runDate: reportDate,
      branchId,
      cadence,
      trigger,
      status: 'skipped',
      recipientCount: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: 'No active recipients',
    });
    return { status: 'skipped', recipientCount: 0, accepted: [], rejected: [], error: 'No active recipients' };
  }

  // 2. Resolve labels + streams (same lookups the preview route does)
  const platformDb = await getPlatformHelper();
  const client = platformDb.get('SELECT name FROM clients WHERE id = ?', clientId);
  const clientName = client?.name || '';
  let branchName = 'All branches';
  if (branchId) {
    const b = platformDb.get('SELECT name FROM branches WHERE id = ?', branchId);
    if (b?.name) branchName = b.name;
  }
  const streams = platformDb.all(
    'SELECT id, name FROM business_streams WHERE client_id = ? AND is_active = 1 ORDER BY sort_order',
    clientId
  );

  // Mark as running so a concurrent re-fire (catchup) skips this branch
  // until the row finalises.
  upsertRunning(db, { runDate: reportDate, branchId, cadence, trigger, startedAt, recipientCount: recipients.length });

  // 3. Gather data + render — serialised through renderMutex so a manual
  // test send during the cron doesn't double-launch Chromium. Picks the
  // right gatherer + renderer based on cadence.
  let html: string;
  let pdf: Buffer;
  let pdfName: string;
  try {
    const rendered = await withRenderLock(async () => {
      if (cadence === 'weekly') {
        const data = buildWeeklyPulseData(db, ctx, {
          clientName,
          branchName,
          branchId,
          streams,
          today: todayDate,
          weekEnd: reportDate,
          syncedAtLabel: opts.syncedAtLabel,
          filedAtLabel: opts.filedAtLabel || '7:30 AM',
        });
        return {
          // Email body uses the table-based, Outlook-safe template; PDF
          // attachment uses the regular template (renders fine through
          // Playwright with the print CSS).
          html: renderWeeklyPulseHtml(data, true),
          pdf: await renderWeeklyPulsePdf(data),
          pdfName: weeklyPulseFilename(data),
        };
      }
      const data = buildDailyBriefData(db, ctx, {
        clientName,
        branchName,
        branchId,
        streams,
        today: todayDate,
        yesterday: reportDate,
        syncedAtLabel: opts.syncedAtLabel,
        filedAtLabel: opts.filedAtLabel || '8:00 AM',
      });
      return {
        html: renderDailyBriefHtml(data, true),
        pdf: await renderDailyBriefPdf(data),
        pdfName: dailyBriefFilename(data),
      };
    });
    html = rendered.html;
    pdf = rendered.pdf;
    pdfName = rendered.pdfName;
  } catch (err: any) {
    const finishedAt = new Date().toISOString();
    const error = `Render failed: ${err?.message || String(err)}`;
    writeAuditRow(db, {
      runDate: reportDate,
      branchId,
      cadence,
      trigger,
      status: 'failed',
      recipientCount: recipients.length,
      startedAt,
      finishedAt,
      error,
    });
    return { status: 'failed', recipientCount: recipients.length, accepted: [], rejected: [], error };
  }

  // 4. Send
  const subject = cadence === 'weekly'
    ? `Weekly Pulse · ${branchName} · Week of ${formatSubjectDate(reportDate)}`
    : `Daily Brief · ${branchName} · ${formatSubjectDate(reportDate)}`;
  const result = await sendMail({
    to: recipients,
    subject,
    html,
    attachments: [{ filename: pdfName, content: pdf, contentType: 'application/pdf' }],
  });

  // 5. Audit
  const finishedAt = new Date().toISOString();
  if (result.ok) {
    writeAuditRow(db, {
      runDate: reportDate,
      branchId,
      cadence,
      trigger,
      status: 'success',
      recipientCount: recipients.length,
      startedAt,
      finishedAt,
    });
    return { status: 'success', recipientCount: recipients.length, accepted: result.accepted || [], rejected: result.rejected || [] };
  }
  writeAuditRow(db, {
    runDate: reportDate,
    branchId,
    cadence,
    trigger,
    status: 'failed',
    recipientCount: recipients.length,
    startedAt,
    finishedAt,
    error: result.error || 'Send failed',
  });
  return { status: 'failed', recipientCount: recipients.length, accepted: [], rejected: [], error: result.error || 'Send failed' };
}

// ── Internal helpers ──
function loadActiveRecipients(db: DbHelper, branchId: number | null, cadence: Cadence): string[] {
  // For a branch-specific send: include both this-branch recipients AND
  // consolidated (branch_id IS NULL) recipients so the owner who's
  // subscribed to "All branches" still gets each branch's mail. The
  // cadence filter accepts the requested cadence OR 'both'.
  const cadenceClause = `(cadence = ? OR cadence = 'both')`;
  const rows = branchId
    ? db.all(
        `SELECT email FROM daily_brief_recipients
          WHERE is_active = 1 AND ${cadenceClause}
            AND (branch_id = ? OR branch_id IS NULL)
          ORDER BY email`,
        cadence, branchId
      )
    : db.all(
        `SELECT email FROM daily_brief_recipients
          WHERE is_active = 1 AND ${cadenceClause}
            AND branch_id IS NULL
          ORDER BY email`,
        cadence
      );
  // Lowercase before deduping so `Alice@x.com` and `alice@x.com` collapse —
  // the POST /recipients route already lowercases, but legacy / override
  // addresses (from /send-test) might not be normalised.
  return [...new Set((rows as any[]).map(r => (r.email || '').toLowerCase()).filter(Boolean))];
}

// SQLite treats UNIQUE(branch_id, …) as allowing multiple NULLs (NULLs are
// "distinct" for unique-constraint purposes), which makes ON CONFLICT a
// no-op for consolidated/single-branch rows and would accumulate stale
// `running` audits on every retry. Explicit lookup-then-insert/update
// covers both the NULL and non-NULL paths uniformly.
function findExistingRun(db: DbHelper, runDate: string, branchId: number | null, cadence: Cadence, trigger: SendTrigger): { id: number } | null {
  const row = db.get(
    `SELECT id FROM daily_brief_sends
      WHERE run_date_ist = ? AND trigger = ? AND cadence = ?
        AND ${branchId === null ? 'branch_id IS NULL' : 'branch_id = ?'}
      LIMIT 1`,
    ...(branchId === null ? [runDate, trigger, cadence] : [runDate, trigger, cadence, branchId])
  );
  return row || null;
}

function upsertRunning(db: DbHelper, row: { runDate: string; branchId: number | null; cadence: Cadence; trigger: SendTrigger; startedAt: string; recipientCount: number }) {
  const existing = findExistingRun(db, row.runDate, row.branchId, row.cadence, row.trigger);
  if (existing) {
    db.run(
      `UPDATE daily_brief_sends
          SET status = 'running',
              recipient_count = ?,
              started_at = ?,
              finished_at = NULL,
              error = NULL
        WHERE id = ?`,
      row.recipientCount, row.startedAt, existing.id
    );
    return;
  }
  db.run(
    `INSERT INTO daily_brief_sends (run_date_ist, branch_id, cadence, trigger, status, recipient_count, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    row.runDate, row.branchId, row.cadence, row.trigger, row.recipientCount, row.startedAt
  );
}

function writeAuditRow(db: DbHelper, row: {
  runDate: string;
  branchId: number | null;
  cadence: Cadence;
  trigger: SendTrigger;
  status: 'success' | 'failed' | 'skipped';
  recipientCount: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
}) {
  const existing = findExistingRun(db, row.runDate, row.branchId, row.cadence, row.trigger);
  if (existing) {
    db.run(
      `UPDATE daily_brief_sends
          SET status = ?, recipient_count = ?, finished_at = ?, error = ?
        WHERE id = ?`,
      row.status, row.recipientCount, row.finishedAt, row.error || null, existing.id
    );
    return;
  }
  db.run(
    `INSERT INTO daily_brief_sends (run_date_ist, branch_id, cadence, trigger, status, recipient_count, started_at, finished_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.runDate, row.branchId, row.cadence, row.trigger, row.status, row.recipientCount,
    row.startedAt, row.finishedAt, row.error || null
  );
}

// Returns true if a successful or in-progress run already exists for this
// (date, branch, cadence). The cron's catchup retry uses this to avoid
// double-sending.
export function alreadyRanForDate(db: DbHelper, runDate: string, branchId: number | null, cadence: Cadence = 'daily'): boolean {
  const row = db.get(
    `SELECT 1 FROM daily_brief_sends
      WHERE run_date_ist = ? AND cadence = ?
        AND ${branchId === null ? 'branch_id IS NULL' : 'branch_id = ?'}
        AND status IN ('success', 'running')
      LIMIT 1`,
    ...(branchId === null ? [runDate, cadence] : [runDate, cadence, branchId])
  );
  return !!row;
}

function formatSubjectDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${days[dt.getDay()]} ${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear()}`;
}
