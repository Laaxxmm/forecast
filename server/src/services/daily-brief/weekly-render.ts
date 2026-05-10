// Weekly Pulse renderer — sister to render.ts but built around the
// weekly template + data shape. Reuses the same logo cache, escape
// helper, and Playwright launch path so we don't double-up on Chromium.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WeeklyPulseData, WeeklyDayPoint, WeeklyStream } from './weekly-data.js';
import { formatINR, formatIndian } from './data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Cached template + logo data URIs (read once) ──
let templateCache: string | null = null;
let clientLogoCache: string | null = null;
let indefineLogoCache: string | null = null;

function loadTemplate(): string {
  if (templateCache) return templateCache;
  templateCache = fs.readFileSync(path.join(__dirname, 'weekly-template.html'), 'utf-8');
  return templateCache;
}
function loadLogoDataUri(filename: string, mime: string): string {
  const buf = fs.readFileSync(path.join(__dirname, 'assets', filename));
  return `data:${mime};base64,${buf.toString('base64')}`;
}
function getClientLogo(): string {
  if (!clientLogoCache) clientLogoCache = loadLogoDataUri('magnacode-logo.png', 'image/png');
  return clientLogoCache;
}
function getIndefineLogo(): string {
  if (!indefineLogoCache) indefineLogoCache = loadLogoDataUri('indefine-logo.jpg', 'image/jpeg');
  return indefineLogoCache;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function replaceTokens(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => (key in tokens ? String(tokens[key]) : ''));
}

// ── Section renderers ──
function renderChartRows(data: WeeklyPulseData): string {
  const max = Math.max(...data.chart.days.map(d => d.revenue), 1);
  const scale = Math.max(max * 1.05, 1);
  return data.chart.days.map(d => {
    const widthPct = scale > 0 ? Math.min(100, (d.revenue / scale) * 100) : 0;
    const dateLabel = `${parseInt(d.date.split('-')[2], 10)} ${monthShort(d.date)}`;
    const cls = d.isBest ? 'bar best' : (d.isWorst || d.isClosed ? 'bar worst' : 'bar');
    const visitsLabel = d.visits > 0 ? `${formatIndian(d.visits)} visits` : (d.isClosed ? '' : '');
    const pillBest = d.isBest ? `<span class="pill best">Best</span>` : '';
    const pillWorst = d.isClosed
      ? `<span class="pill worst">Closed-ish</span>`
      : (d.isWorst ? `<span class="pill worst">Worst</span>` : '');
    return `
      <div class="row">
        <div class="day"><b>${escape(d.weekday)}</b><span class="d">${escape(dateLabel)}</span></div>
        <div class="bar-wrap">
          <div class="${cls}" style="width:${widthPct.toFixed(1)}%"></div>
          <div class="target-line" style="left:${data.chart.targetLinePct}%"></div>
        </div>
        <div class="v">${formatINR(d.revenue)}${pillBest}${pillWorst}${visitsLabel ? `<span class="ppl">${escape(visitsLabel)}</span>` : ''}</div>
      </div>`;
  }).join('\n');
}

function monthShort(ymd: string): string {
  const m = parseInt(ymd.split('-')[1], 10) - 1;
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m];
}

function renderStreams(data: WeeklyPulseData): string {
  if (data.streams.length === 0) {
    return `<div class="area"><div class="head">No streams configured</div></div>`;
  }
  return data.streams.map(s => {
    const cls = s.status === 'ok' ? '' : s.status;
    const wowDir = s.wowDelta >= 0 ? 'up' : 'down';
    const wowArrow = s.wowDelta >= 0 ? '▲' : '▼';
    const wowSign = s.wowDelta >= 0 ? '+' : '';
    const headsLine = s.unitsCount != null
      ? `<b>${formatIndian(s.unitsCount)}</b> ${escape(s.unitsLabel || 'sales')}`
      : '';
    return `
      <div class="area${cls ? ' ' + cls : ''}">
        <div class="head">${escape(s.label)} <span class="pill">${escape(s.statusLabel)}</span></div>
        <div class="name">${escape(friendlyStreamName(s.label))}</div>
        <div class="yest-lbl">Earned this week</div>
        <div class="yest">${formatINR(s.weekRevenue)}</div>
        ${headsLine ? `<div class="heads">${headsLine}</div>` : ''}
        <div class="meta">
          <span><b>${s.weekShare}%</b> of week</span>
          <span class="${wowDir}">${wowArrow} ${wowSign}${s.wowDelta}% WoW</span>
        </div>
        <div class="target-row">
          <span class="k">Next week target</span>
          <span class="v">${formatINR(s.nextWeekTarget)}</span>
        </div>
      </div>`;
  }).join('\n');
}

function friendlyStreamName(label: string): string {
  if (label === 'Consultations') return 'Doctor visits';
  if (label === 'Diagnostics') return 'Lab tests';
  if (label === 'Other Revenue') return 'Procedures & packages';
  if (label === 'Pharmacy') return 'Counter sales';
  return label;
}

function renderPerStream(data: WeeklyPulseData): string {
  if (data.prescription.perStream.length === 0) return '';
  return data.prescription.perStream.map(p => {
    const unitsHtml = p.units && p.units.count > 0
      ? `<span class="vh">~${formatIndian(p.units.count)} ${escape(p.units.label)}</span>`
      : '';
    return `
      <div class="row">
        <span class="k">${escape(p.label)}</span>
        <span class="v">${formatINR(p.target)}${unitsHtml}</span>
      </div>`;
  }).join('\n');
}

function renderTopDoctors(data: WeeklyPulseData): string {
  if (data.topDoctors.length === 0) {
    return `<div style="padding:18px 4px;text-align:center;font-family:var(--serif);font-style:italic;color:var(--muted);font-size:13px">No doctor billed across the week.</div>`;
  }
  return data.topDoctors.map(d => {
    const delta = d.weekRevenue - d.typicalWeekRevenue;
    const dir = delta >= 0 ? 'up' : 'down';
    const arrow = delta >= 0 ? '▲' : '▼';
    const sign = delta >= 0 ? '+' : '−';
    const visits = d.weekVisits > 0 ? `${formatIndian(d.weekVisits)} patients · ` : '';
    const typicalVisits = d.typicalWeekVisits > 0 ? ` · ${formatIndian(d.typicalWeekVisits)} pts` : '';
    return `
      <div class="doc">
        <span class="rk">${d.rank}</span>
        <span class="who"><span class="n">${escape(d.name)}</span><span class="m">${visits}Typical week · ${formatINR(d.typicalWeekRevenue)}${typicalVisits}</span></span>
        <span class="amt"><span class="a">${formatINR(d.weekRevenue)}</span><span class="d ${dir}">${arrow} ${sign}${formatINR(Math.abs(delta))} vs. usual</span></span>
      </div>`;
  }).join('\n');
}

function renderSilentDoctors(data: WeeklyPulseData): string {
  if (data.silentDoctors.length === 0) {
    return `<div class="empty">Every regular billed at least one day this week — nothing to chase.</div>`;
  }
  const rows = data.silentDoctors.map(d => `
    <div class="doc">
      <span class="rk">·</span>
      <span class="who">
        <span class="n">${escape(d.name)}</span>
        <span class="m">0 days billed · normally ${d.typicalDaysPerWeek}/week · ${formatINR(d.typicalDayRevenue)}/day</span>
      </span>
      <span class="badge">All week</span>
    </div>`).join('\n');
  return rows + `
    <div class="nudge">
      When regulars miss an entire week, it's usually scheduling, not departure — a Monday call resets the calendar before the pattern hardens.
    </div>`;
}

function renderWatchlist(data: WeeklyPulseData): string {
  if (data.watchlist.length === 0) {
    return `<div class="empty">A clean week — nothing on the watchlist ✓</div>`;
  }
  const iconFor = (t: string) =>
    t === 'stock_expiry' ? '℞'
    : t === 'discount_drift' ? '%'
    : t === 'margin_drift' ? '▾'
    : t === 'refund_concentration' ? '↩'
    : t === 'unmapped_doctor' ? '⚲'
    : '!';
  return data.watchlist.map(w => `
    <div class="row${w.tone === 'red' ? ' red' : w.tone === 'blue' ? ' blue' : ''}">
      <span class="icn" aria-hidden="true">${iconFor(w.type)}</span>
      <div class="body">
        <span class="t">${escape(w.title)}</span>
        <span class="s">${escape(w.subtitle)}</span>
      </div>
      <span class="right">${escape(w.rightValue)}<span class="sub">${escape(w.rightSub)}</span></span>
    </div>`).join('\n');
}

// ── Public renderer ──
export function renderWeeklyPulseHtml(data: WeeklyPulseData): string {
  const template = loadTemplate();

  const wRevDir = data.week.revenueWoWPct >= 0 ? 'up' : 'down';
  const wRevArrow = data.week.revenueWoWPct >= 0 ? '▲' : '▼';
  const wRevText = data.week.revenueWoWPct >= 0
    ? `+${data.week.revenueWoWPct.toFixed(1)}% vs. last week`
    : `${data.week.revenueWoWPct.toFixed(1)}% vs. last week`;

  const wVisitsDir = data.week.visitsWoWDelta >= 0 ? 'up' : 'down';
  const wVisitsArrow = data.week.visitsWoWDelta >= 0 ? '▲' : '▼';
  const wVisitsText = data.week.visitsWoWDelta >= 0
    ? `+${data.week.visitsWoWDelta} vs. last week`
    : `${data.week.visitsWoWDelta} vs. last week`;

  const targetFootnote = data.week.target > 0
    ? `Target was ${formatINR(data.week.target)} · ${data.week.revenue >= data.week.target ? 'beat by' : 'missed by'} ${formatINR(Math.abs(data.week.revenue - data.week.target))}`
    : 'No weekly target set';

  const tokens: Record<string, string> = {
    BRANCH_NAME: data.meta.branchName,
    BRANCH_NAME_UPPER: data.meta.branchName.toUpperCase(),
    CLIENT_NAME: data.meta.clientName,
    ISSUE_NUMBER: String(data.meta.issueNumber).padStart(2, '0'),
    WEEK_NUMBER: String(data.meta.weekNumber).padStart(2, '0'),
    YEAR: String(data.meta.year),
    FILED_AT_LABEL: data.meta.filedAtLabel,
    FILED_DATE_LABEL: data.meta.todayLabelLong,
    TODAY_WEEKDAY: data.meta.todayWeekday,
    TODAY_DATE_LONG: data.meta.todayLabelLong.split(', ').slice(1).join(', '),
    DAY_OF_MONTH: String(data.meta.dayOfMonth),
    DAYS_IN_MONTH: String(data.meta.daysInMonth),
    DAYS_REMAINING: String(data.meta.daysRemaining),
    MONTH_PCT: String(data.meta.monthPct),
    SYNCED_AT: data.meta.syncedAtLabel,
    GENERATED_AT_LABEL: data.meta.generatedAtLabel,
    PROGRESS_FILL_PCT: String(data.meta.progressFillPct),
    PROGRESS_WEEK_SLOT_PCT: String(data.meta.progressWeekSlotPct),
    PROGRESS_PACE_PCT: String(data.meta.progressPacePct),
    DAILY_TARGET: data.meta.dailyTargetLabel,
    WEEK_RANGE: data.meta.weekRangeShort,
    WEEK_RANGE_LONG: data.meta.weekRangeLong,
    NEXT_WEEK_RANGE: data.meta.nextWeekRangeShort,
    WORKING_DAYS_REMAINING: String(data.meta.workingDaysRemainingThisWeek),

    CLIENT_LOGO_DATAURI: getClientLogo(),
    INDEFINE_LOGO_DATAURI: getIndefineLogo(),

    STATUS_TONE_CLASS: data.status.tone === 'ok' ? '' : data.status.tone,
    STATUS_HEADLINE: escape(data.status.headline),
    STATUS_SYSTEMS: escape(data.status.systems),

    W_REVENUE: formatINR(data.week.revenue),
    W_REVENUE_DELTA_DIR: wRevDir,
    W_REVENUE_DELTA_ARROW: wRevArrow,
    W_REVENUE_DELTA_TEXT: wRevText,
    W_TARGET_FOOTNOTE: targetFootnote,
    W_VISITS: formatIndian(data.week.visits),
    W_VISITS_DELTA_DIR: wVisitsDir,
    W_VISITS_DELTA_ARROW: wVisitsArrow,
    W_VISITS_DELTA_TEXT: wVisitsText,
    W_VISITS_AVG: formatIndian(data.week.visitsTrailingAvg),
    W_DAYS_HIT: String(data.week.daysHit),
    W_WORKING_DAYS: String(data.week.workingDays),
    W_DAYS_HIT_NAMES: escape(data.week.daysHitNames),

    REQUIRED_RUPEE: formatIndian(data.prescription.requiredRevenue),
    MTD_REVENUE: formatINR(data.prescription.mtdRevenue),
    MONTHLY_GOAL: formatINR(data.prescription.monthlyGoal),

    CHART_ROWS_HTML: renderChartRows(data),
    CHART_SUMMARY_HTML: data.chart.summary,
    STREAMS_HTML: renderStreams(data),
    TODAY_PER_STREAM_HTML: renderPerStream(data),
    TOP_DOCS_HTML: renderTopDoctors(data),
    TOP_DOCS_COUNT: String(data.topDoctors.length || 10),
    SILENT_DOCS_HTML: renderSilentDoctors(data),

    PATTERN_LABEL: escape(data.pattern.label),
    // pattern text intentionally NOT escaped — the data layer renders <b>…</b>
    // for the highlighted phrase. The label IS escaped above.
    PATTERN_TEXT: data.pattern.text,

    WATCHLIST_HTML: renderWatchlist(data),
    WATCHLIST_STAMP: data.watchlist.length === 0 ? 'All clear' : `${data.watchlist.length} item${data.watchlist.length === 1 ? '' : 's'} this week`,
  };

  return replaceTokens(template, tokens);
}

// PDF render via Playwright. Same launch strategy as render.ts so we
// share the system chromium binary on prod.
import { resolveChromiumExecutablePath } from './render.js';

export async function renderWeeklyPulsePdf(data: WeeklyPulseData): Promise<Buffer> {
  const html = renderWeeklyPulseHtml(data);
  const { chromium } = await import('playwright');
  const executablePath = resolveChromiumExecutablePath();
  const browser = await chromium.launch(
    executablePath ? { executablePath, headless: true } : { headless: true }
  );
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const buf = await page.pdf({
      format: 'A4',
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
      printBackground: true,
    });
    return buf;
  } finally {
    await browser.close();
  }
}

export function weeklyPulseFilename(data: WeeklyPulseData): string {
  const slug = (data.meta.branchName || 'all').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  return `WeeklyPulse_${slug}_${data.meta.year}-W${String(data.meta.weekNumber).padStart(2, '0')}.pdf`;
}
