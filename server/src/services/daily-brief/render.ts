// Renders DailyBriefData into HTML (for in-browser preview / email body)
// and PDF (for the email attachment). The template lives in template.html
// next to this file; tokens of the form {{TOKEN}} are replaced with values
// derived from the data object.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DailyBriefData } from './data.js';
import { formatINR, formatIndian } from './data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Cached template + logo data URIs (read once, served on every render) ──
let templateCache: string | null = null;
let clientLogoCache: string | null = null;
let indefineLogoCache: string | null = null;

function loadTemplate(): string {
  if (templateCache) return templateCache;
  templateCache = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf-8');
  return templateCache;
}

function loadLogoDataUri(filename: string, mime: string): string {
  const buf = fs.readFileSync(path.join(__dirname, 'assets', filename));
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function getClientLogo(): string {
  // For v1 only the MagnaCode logo is bundled. When other tenants come on
  // board this will switch on req.client / branding settings.
  if (!clientLogoCache) clientLogoCache = loadLogoDataUri('magnacode-logo.png', 'image/png');
  return clientLogoCache;
}

function getIndefineLogo(): string {
  if (!indefineLogoCache) indefineLogoCache = loadLogoDataUri('indefine-logo.jpg', 'image/jpeg');
  return indefineLogoCache;
}

// ── Tiny token replacer ──
// The template only uses simple {{TOKEN}} substitution — no loops, no
// conditionals. List-shaped sections (streams, doctors, watchlist) are
// rendered to HTML strings here and slotted in as a single token each.
function replaceTokens(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    return key in tokens ? String(tokens[key]) : '';
  });
}

// ── Section renderers ──
function renderStreams(data: DailyBriefData): string {
  if (data.streams.length === 0) {
    return `<div class="area"><div class="head">No streams configured</div></div>`;
  }
  return data.streams.map(s => {
    const cls = s.status === 'ok' ? '' : s.status;
    return `
      <div class="area${cls ? ' ' + cls : ''}">
        <div class="head">${escape(s.label)} <span class="pill">${escape(s.statusLabel)}</span></div>
        <div class="name">${friendlyName(s.label)}</div>
        <div class="yest-lbl">Earned yesterday</div>
        <div class="yest">${formatINR(s.yesterdayRevenue)}</div>
        <div class="take">${escape(s.takeaway)}</div>
        <div class="target-row">
          <span class="k">Today's target</span>
          <span class="v">${formatINR(s.todayTarget)}</span>
        </div>
      </div>`;
  }).join('\n');
}

// Sub-label inside the card. The card title is the friendly category
// (Consultations / Diagnostics / Other Revenue / Pharmacy); the sub-name
// is the operational hint underneath ("Doctor visits", "Lab tests", …).
function friendlyName(label: string): string {
  if (label === 'Consultations') return 'Doctor visits';
  if (label === 'Diagnostics') return 'Lab tests';
  if (label === 'Other Revenue') return 'Procedures &amp; packages';
  if (label === 'Pharmacy') return 'Counter sales';
  return label;
}

function renderTodayPerStream(data: DailyBriefData): string {
  if (data.today.perStream.length === 0) return '';
  return data.today.perStream.map(p => `
    <div class="row">
      <span class="k">${escape(p.label)}</span>
      <span class="v">${formatINR(p.target)}</span>
    </div>`).join('\n');
}

function renderTopDoctors(data: DailyBriefData): string {
  if (data.topDoctors.length === 0) {
    return `<div class="empty" style="padding:18px 4px;text-align:center;font-family:var(--serif);font-style:italic;color:var(--muted);font-size:13px">No billing yesterday.</div>`;
  }
  return data.topDoctors.map((d, i) => {
    const delta = d.yesterdayRevenue - d.typicalDayRevenue;
    const dir = delta >= 0 ? 'up' : 'down';
    const arrow = delta >= 0 ? '▲' : '▼';
    const sign = delta >= 0 ? '+' : '−';
    return `
      <div class="doc">
        <span class="rk">${i + 1}</span>
        <span class="who">
          <span class="n">${escape(d.name)}</span>
          <span class="m">Typical day · ${formatINR(d.typicalDayRevenue)}</span>
        </span>
        <span class="amt">
          <span class="a">${formatINR(d.yesterdayRevenue)}</span>
          <span class="d ${dir}">${arrow} ${sign}${formatINR(Math.abs(delta)).replace('₹','₹')} vs. usual</span>
        </span>
      </div>`;
  }).join('\n');
}

function renderSilentDoctors(data: DailyBriefData): string {
  if (data.silentDoctors.length === 0) {
    return `<div class="empty">All regulars billed in the last day or two — nothing to chase.</div>`;
  }
  const rows = data.silentDoctors.map(d => `
    <div class="doc">
      <span class="rk">·</span>
      <span class="who">
        <span class="n">${escape(d.name)}</span>
        <span class="m">Last billed ${d.daysQuiet} day${d.daysQuiet === 1 ? '' : 's'} ago · normally ${formatINR(d.typicalDayRevenue)}/day</span>
      </span>
      <span class="badge">${d.daysQuiet} day${d.daysQuiet === 1 ? '' : 's'} quiet</span>
    </div>`).join('\n');
  return rows + `
    <div class="nudge">
      A short check-in usually gets them back on the schedule by tomorrow.
    </div>`;
}

function renderWatchlist(data: DailyBriefData): string {
  if (data.watchlist.length === 0) {
    return `<div class="empty">Nothing to flag today ✓</div>`;
  }
  const iconFor = (t: string) => t === 'stock_expiry' ? '℞' : t === 'discount_drift' ? '%' : t === 'sync_failure' ? '↻' : '!';
  return data.watchlist.map(w => `
    <div class="row${w.tone === 'red' ? ' red' : w.tone === 'blue' ? ' blue' : ''}">
      <span class="icn" aria-hidden="true">${iconFor(w.type)}</span>
      <div class="body">
        <span class="t">${escape(w.title)}</span>
        <span class="s">${escape(w.subtitle)}</span>
      </div>
      <span class="right">${escape(w.rightValue)}
        <span class="sub">${escape(w.rightSub)}</span>
      </span>
    </div>`).join('\n');
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ── Public renderer ──
export function renderDailyBriefHtml(data: DailyBriefData): string {
  const template = loadTemplate();

  const yRevDeltaDir = data.yesterday.revenueDeltaPct >= 0 ? 'up' : 'down';
  const yRevDeltaArrow = data.yesterday.revenueDeltaPct >= 0 ? '▲' : '▼';
  const yRevDeltaText = data.yesterday.revenueDeltaPct >= 0
    ? `+${data.yesterday.revenueDeltaPct.toFixed(1)}% vs. last ${data.yesterday.typicalDayLabel}`
    : `${data.yesterday.revenueDeltaPct.toFixed(1)}% vs. last ${data.yesterday.typicalDayLabel}`;

  const yVisitsDir = data.yesterday.visitsDelta >= 0 ? 'up' : 'down';
  const yVisitsArrow = data.yesterday.visitsDelta >= 0 ? '▲' : '▼';
  const yVisitsText = data.yesterday.visitsDelta >= 0
    ? `+${data.yesterday.visitsDelta} vs. a typical ${data.yesterday.typicalDayLabel}`
    : `${data.yesterday.visitsDelta} vs. a typical ${data.yesterday.typicalDayLabel}`;

  const surplusClass = data.yesterday.surplus >= 0 ? 'surplus' : 'deficit';
  const surplusValue = data.yesterday.surplus >= 0
    ? `+ ${formatINR(Math.abs(data.yesterday.surplus))}`
    : `− ${formatINR(Math.abs(data.yesterday.surplus))}`;
  const surplusDeltaDir = data.yesterday.surplus >= 0 ? 'up' : 'down';
  const surplusText = data.yesterday.surplus >= 0
    ? 'Earned more than the day needed'
    : 'Came in below the day’s run rate';
  const surplusFootnote = data.yesterday.surplus >= 0
    ? 'Surplus carries into today'
    : 'Today needs to make up the gap';
  const targetFootnote = data.yesterday.target > 0
    ? `Target was ${formatINR(data.yesterday.target)}`
    : 'No daily target set';

  const statusToneClass = data.status.tone === 'ok' ? '' : data.status.tone;

  const tokens: Record<string, string> = {
    BRANCH_NAME: data.meta.branchName,
    BRANCH_NAME_UPPER: data.meta.branchName.toUpperCase(),
    CLIENT_NAME: data.meta.clientName,
    ISSUE_NUMBER: String(data.meta.issueNumber).padStart(3, '0'),
    FILED_AT_LABEL: data.meta.filedAtLabel,
    FILED_DATE_LABEL: data.meta.todayLabelLong,
    TODAY_WEEKDAY: data.meta.todayWeekday,
    TODAY_DATE_LONG: data.meta.todayLabelLong.split(', ').slice(1).join(', '),
    TODAY_DATE_SHORT: data.meta.todayLabelShort,
    DAY_OF_MONTH: String(data.meta.dayOfMonth),
    DAYS_IN_MONTH: String(data.meta.daysInMonth),
    DAYS_REMAINING: String(data.meta.daysRemaining),
    MONTH_PCT: String(data.meta.monthPct),
    SYNCED_AT: data.meta.syncedAtLabel,
    GENERATED_AT_LABEL: data.meta.generatedAtLabel,
    PROGRESS_FILL_PCT: String(data.meta.progressFillPct),
    PROGRESS_PACE_PCT: String(data.meta.progressPacePct),

    CLIENT_LOGO_DATAURI: getClientLogo(),
    INDEFINE_LOGO_DATAURI: getIndefineLogo(),

    STATUS_TONE_CLASS: statusToneClass,
    STATUS_HEADLINE: escape(data.status.headline),
    STATUS_SYSTEMS: escape(data.status.systems),

    Y_DATE_SHORT: data.meta.yesterdayLabel,
    Y_REVENUE: formatINR(data.yesterday.revenue),
    Y_REVENUE_DELTA_DIR: yRevDeltaDir,
    Y_REVENUE_DELTA_ARROW: yRevDeltaArrow,
    Y_REVENUE_DELTA_TEXT: yRevDeltaText,
    Y_TARGET_FOOTNOTE: targetFootnote,
    Y_VISITS: formatIndian(data.yesterday.visits),
    Y_VISITS_DELTA_DIR: yVisitsDir,
    Y_VISITS_DELTA_ARROW: yVisitsArrow,
    Y_VISITS_DELTA_TEXT: yVisitsText,
    Y_VISITS_FOOTNOTE: `Typical ${data.yesterday.typicalDayLabel} · ${data.yesterday.typicalVisits} visits`,
    Y_SURPLUS_CLASS: surplusClass,
    Y_SURPLUS_VALUE: surplusValue,
    Y_SURPLUS_DELTA_DIR: surplusDeltaDir,
    Y_SURPLUS_TEXT: surplusText,
    Y_SURPLUS_FOOTNOTE: surplusFootnote,

    REQUIRED_RUPEE: formatIndian(data.today.requiredRevenue),
    MTD_REVENUE: formatINR(data.today.mtdRevenue),
    MONTHLY_GOAL: formatINR(data.today.monthlyGoal),

    STREAMS_HTML: renderStreams(data),
    TODAY_PER_STREAM_HTML: renderTodayPerStream(data),
    TOP_DOCS_HTML: renderTopDoctors(data),
    SILENT_DOCS_HTML: renderSilentDoctors(data),
    WATCHLIST_HTML: renderWatchlist(data),
    WATCHLIST_STAMP: data.watchlist.length === 0 ? 'All clear' : `${data.watchlist.length} item${data.watchlist.length === 1 ? '' : 's'} today`,
  };

  return replaceTokens(template, tokens);
}

// ── PDF render via Playwright ──
// Mirrors the launch strategy used by the existing sync runners
// (healthplix-sync, oneglance-sync): on prod we point Playwright at the
// system-installed /usr/bin/chromium so we don't fight 1.49+'s switch to
// the (separately-downloaded) chromium-headless-shell variant. Local
// dev falls through to Playwright's auto-discovery.
function resolveChromiumExecutablePath(): string | undefined {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) return undefined;                       // dev → Playwright auto-discovery
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function renderDailyBriefPdf(data: DailyBriefData): Promise<Buffer> {
  const html = renderDailyBriefHtml(data);
  // Lazy-import Playwright so a server boot in an env without Chromium
  // still works for the HTML preview path.
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

// Filename convention for the PDF attachment / download:
//   DailyBrief_<branch-slug>_<YYYY-MM-DD>.pdf
// Slug strips spaces and lowercases the branch so it's safe in headers.
export function dailyBriefFilename(data: DailyBriefData): string {
  const slug = (data.meta.branchName || 'all').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  return `DailyBrief_${slug}_${data.meta.today}.pdf`;
}
