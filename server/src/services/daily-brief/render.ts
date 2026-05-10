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
let emailTemplateCache: string | null = null;
let clientLogoCache: string | null = null;
let indefineLogoCache: string | null = null;

function loadTemplate(forEmail: boolean): string {
  if (forEmail) {
    if (emailTemplateCache) return emailTemplateCache;
    emailTemplateCache = fs.readFileSync(path.join(__dirname, 'template-email.html'), 'utf-8');
    return emailTemplateCache;
  }
  if (templateCache) return templateCache;
  templateCache = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf-8');
  return templateCache;
}

// Status tone palette — Outlook-safe inline colors that match the design's
// CSS-variable values. Used by the email template tokens.
const STATUS_PALETTE: Record<string, { bg: string; fg: string; border: string }> = {
  ok:    { bg: '#e3efe4', fg: '#1f7a3e', border: '#b6d4be' },
  amber: { bg: '#fbecca', fg: '#a96508', border: '#e8caa0' },
  red:   { bg: '#f5dbd2', fg: '#a8311c', border: '#e3b6ad' },
};
const COLOR_GREEN = '#1f7a3e';
const COLOR_RED = '#a8311c';
const COLOR_MUTED = '#76787e';
const COLOR_INK = '#15171c';
const COLOR_INK_SOFT = '#3a3d44';

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
// Each section accepts a `forEmail` flag and emits Outlook-safe table HTML
// when true, or the regular CSS-grid version when false (used for the
// browser preview and Playwright PDF render).
function renderStreams(data: DailyBriefData, forEmail: boolean): string {
  if (data.streams.length === 0) {
    return forEmail
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding:14px; font:500 12px/1.4 sans-serif; color:${COLOR_MUTED}; text-align:center;">No streams configured</td></tr></table>`
      : `<div class="area"><div class="head">No streams configured</div></div>`;
  }
  if (!forEmail) {
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
  // Email path: render as a 2x2 table of cards. Status colors are inlined.
  const cards = data.streams.map(s => {
    const tone = STATUS_PALETTE[s.status] || STATUS_PALETTE.ok;
    return {
      label: s.label,
      sub: friendlyName(s.label),
      revenue: s.yesterdayRevenue,
      takeaway: s.takeaway,
      todayTarget: s.todayTarget,
      barColor: tone.fg,
      pillBg: tone.bg,
      pillFg: tone.fg,
      statusLabel: s.statusLabel,
    };
  });
  const renderCard = (c: typeof cards[number]) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #e3e4e8; border-radius:6px;">
      <tr><td style="height:3px; background:${c.barColor}; line-height:0; font-size:0; border-radius:6px 6px 0 0;">&nbsp;</td></tr>
      <tr><td style="padding:12px 14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="font:700 10.5px/1.4 ui-monospace,Menlo,Consolas,monospace; letter-spacing:1.4px; text-transform:uppercase; color:${COLOR_MUTED};">${escape(c.label)}</td><td align="right"><span style="display:inline-block; background:${c.pillBg}; color:${c.pillFg}; font:700 9.5px/1 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; text-transform:uppercase; padding:3px 7px; border-radius:999px;">${escape(c.statusLabel)}</span></td></tr>
        </table>
        <div style="font:600 16px/1.2 'Iowan Old Style',Georgia,serif; color:${COLOR_INK}; margin-top:6px;">${c.sub}</div>
        <div style="font:500 11px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_MUTED}; margin-top:4px;">Earned yesterday</div>
        <div style="font:700 22px/1 'Iowan Old Style',Georgia,serif; letter-spacing:-0.5px; color:${COLOR_INK}; margin-top:2px;">${formatINR(c.revenue)}</div>
        <div style="font:400 12px/1.4 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK_SOFT}; margin-top:6px;">${escape(c.takeaway)}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:8px; border-top:1px dashed #e3e4e8;">
          <tr><td style="padding-top:7px; font:500 10px/1.3 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.8px; text-transform:uppercase; color:${COLOR_MUTED};">Today's target</td><td align="right" style="padding-top:7px; font:700 13px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK};">${formatINR(c.todayTarget)}</td></tr>
        </table>
      </td></tr>
    </table>`;
  // Build 2-card rows
  const rows: string[] = [];
  for (let i = 0; i < cards.length; i += 2) {
    const a = cards[i];
    const b = cards[i + 1];
    rows.push(`
      <tr>
        <td class="dd-stack-td" valign="top" width="50%" style="width:50%; padding:0 5px ${i + 2 < cards.length ? '10px' : '0'} 0;">${renderCard(a)}</td>
        ${b ? `<td class="dd-stack-td" valign="top" width="50%" style="width:50%; padding:0 0 ${i + 2 < cards.length ? '10px' : '0'} 5px;">${renderCard(b)}</td>` : '<td>&nbsp;</td>'}
      </tr>`);
  }
  return `<table role="presentation" class="dd-stack" cellpadding="0" cellspacing="0" border="0" width="100%">${rows.join('')}</table>`;
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

function renderTodayPerStream(data: DailyBriefData, forEmail: boolean): string {
  if (data.today.perStream.length === 0) return '';
  if (!forEmail) {
    return data.today.perStream.map(p => `
      <div class="row">
        <span class="k">${escape(p.label)}</span>
        <span class="v">${formatINR(p.target)}</span>
      </div>`).join('\n');
  }
  // Email path: table rows
  return data.today.perStream.map((p, idx, arr) => `
    <tr>
      <td style="padding:5px 0; ${idx < arr.length - 1 ? `border-bottom:1px solid #eef0f3;` : ''} font:500 10.5px/1.2 ui-monospace,Menlo,Consolas,monospace; letter-spacing:1.1px; text-transform:uppercase; color:${COLOR_MUTED};">${escape(p.label)}</td>
      <td align="right" style="padding:5px 0; ${idx < arr.length - 1 ? `border-bottom:1px solid #eef0f3;` : ''} font:700 15px/1.2 'Iowan Old Style',Georgia,serif; color:${COLOR_INK};">${formatINR(p.target)}</td>
    </tr>`).join('');
}

function renderTopDoctors(data: DailyBriefData, forEmail: boolean): string {
  if (data.topDoctors.length === 0) {
    return forEmail
      ? `<tr><td style="padding:14px; text-align:center; font:italic 500 13px/1.4 'Iowan Old Style',Georgia,serif; color:${COLOR_MUTED};">No billing yesterday.</td></tr>`
      : `<div class="empty" style="padding:18px 4px;text-align:center;font-family:var(--serif);font-style:italic;color:var(--muted);font-size:13px">No billing yesterday.</div>`;
  }
  if (!forEmail) {
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
            <span class="d ${dir}">${arrow} ${sign}${formatINR(Math.abs(delta))} vs. usual</span>
          </span>
        </div>`;
    }).join('\n');
  }
  // Email path: each doctor = a 3-cell row, separated by a thin divider row
  const rows: string[] = [];
  data.topDoctors.forEach((d, i) => {
    const delta = d.yesterdayRevenue - d.typicalDayRevenue;
    const arrow = delta >= 0 ? '▲' : '▼';
    const sign = delta >= 0 ? '+' : '−';
    const deltaColor = delta >= 0 ? COLOR_GREEN : COLOR_MUTED;
    if (i > 0) rows.push(`<tr><td colspan="3" style="border-top:1px solid #eef0f3; line-height:0; font-size:0;">&nbsp;</td></tr>`);
    rows.push(`
      <tr>
        <td width="20" style="font:700 16px/1 'Iowan Old Style',Georgia,serif; color:#155cab; padding:8px 8px 8px 0;">${i + 1}</td>
        <td style="padding:8px 0; font:600 13px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK};">${escape(d.name)}<br/><span style="font:500 10.5px/1.4 ui-monospace,Menlo,Consolas,monospace; color:${COLOR_MUTED};">Typical day · ${formatINR(d.typicalDayRevenue)}</span></td>
        <td align="right" style="padding:8px 0; font:700 14px/1.2 'Iowan Old Style',Georgia,serif; color:${COLOR_INK};">${formatINR(d.yesterdayRevenue)}<br/><span style="font:500 10.5px/1.4 ui-monospace,Menlo,Consolas,monospace; color:${deltaColor};">${arrow} ${sign}${formatINR(Math.abs(delta))}</span></td>
      </tr>`);
  });
  return rows.join('');
}

function renderSilentDoctors(data: DailyBriefData, forEmail: boolean): string {
  if (data.silentDoctors.length === 0) {
    return forEmail
      ? `<div style="padding:14px 0; text-align:center; font:italic 500 13px/1.4 'Iowan Old Style',Georgia,serif; color:${COLOR_MUTED};">All regulars billed recently — nothing to chase.</div>`
      : `<div class="empty">All regulars billed in the last day or two — nothing to chase.</div>`;
  }
  if (!forEmail) {
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
  // Email path
  const rows: string[] = [];
  data.silentDoctors.forEach((d, i) => {
    if (i > 0) rows.push(`<tr><td colspan="2" style="border-top:1px solid #eef0f3; line-height:0; font-size:0;">&nbsp;</td></tr>`);
    rows.push(`
      <tr>
        <td style="padding:6px 0; font:600 13px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK};">${escape(d.name)}<br/><span style="font:500 10.5px/1.4 ui-monospace,Menlo,Consolas,monospace; color:${COLOR_INK_SOFT};">Last billed ${d.daysQuiet}d ago · normally ${formatINR(d.typicalDayRevenue)}/day</span></td>
        <td align="right" style="padding:6px 0;"><span style="display:inline-block; background:#fbecca; color:#a96508; font:700 9.5px/1 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; text-transform:uppercase; padding:4px 8px; border-radius:999px; border:1px solid #e8caa0; white-space:nowrap;">${d.daysQuiet} day${d.daysQuiet === 1 ? '' : 's'} quiet</span></td>
      </tr>`);
  });
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows.join('')}</table>
    <div style="margin-top:10px; padding:9px 11px; background:#f3f4f7; border-radius:4px; font:italic 400 12.5px/1.4 'Iowan Old Style',Georgia,serif; color:${COLOR_INK_SOFT};"><span style="color:#155cab; font-weight:700;">&ldquo;</span>A short check-in usually gets them back on the schedule by tomorrow.</div>`;
}

function renderWatchlist(data: DailyBriefData, forEmail: boolean): string {
  if (data.watchlist.length === 0) {
    return forEmail
      ? `<tr><td style="padding:18px 16px; text-align:center; font:italic 500 14px/1.4 'Iowan Old Style',Georgia,serif; color:${COLOR_MUTED};">Nothing to flag today ✓</td></tr>`
      : `<div class="empty">Nothing to flag today ✓</div>`;
  }
  const iconFor = (t: string) => t === 'stock_expiry' ? '℞' : t === 'discount_drift' ? '%' : t === 'sync_failure' ? '↻' : '!';
  if (!forEmail) {
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
  // Email path
  const toneBg = (t: string) => t === 'red' ? '#f5dbd2' : t === 'blue' ? '#e7eef8' : '#fbecca';
  const toneFg = (t: string) => t === 'red' ? '#a8311c' : t === 'blue' ? '#155cab' : '#a96508';
  const rows: string[] = [];
  data.watchlist.forEach((w, i) => {
    if (i > 0) rows.push(`<tr><td colspan="3" style="border-top:1px solid #eef0f3; line-height:0; font-size:0;">&nbsp;</td></tr>`);
    rows.push(`
      <tr>
        <td width="34" valign="middle" align="center" style="padding:12px 0 12px 14px;"><span style="display:inline-block; width:26px; height:26px; line-height:26px; text-align:center; border-radius:4px; background:${toneBg(w.tone)}; color:${toneFg(w.tone)}; font:italic 700 14px/26px 'Iowan Old Style',Georgia,serif;">${iconFor(w.type)}</span></td>
        <td valign="middle" style="padding:12px 14px;">
          <div style="font:600 13.5px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK};">${escape(w.title)}</div>
          <div style="font:400 12px/1.4 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK_SOFT}; margin-top:2px;">${escape(w.subtitle)}</div>
        </td>
        <td align="right" valign="middle" style="padding:12px 14px 12px 0; white-space:nowrap;">
          <div style="font:700 16px/1.2 'Iowan Old Style',Georgia,serif; color:${COLOR_INK};">${escape(w.rightValue)}</div>
          <div style="font:500 10px/1.3 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.8px; text-transform:uppercase; color:${COLOR_MUTED}; margin-top:2px;">${escape(w.rightSub)}</div>
        </td>
      </tr>`);
  });
  return rows.join('');
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ── Public renderer ──
export function renderDailyBriefHtml(data: DailyBriefData, forEmail: boolean = false): string {
  const template = loadTemplate(forEmail);

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
  const statusPalette = STATUS_PALETTE[data.status.tone] || STATUS_PALETTE.ok;
  const yRevColor = data.yesterday.revenueDeltaPct >= 0 ? COLOR_GREEN : COLOR_RED;
  const yVisitsColor = data.yesterday.visitsDelta >= 0 ? COLOR_GREEN : COLOR_RED;
  const ySurplusColor = data.yesterday.surplus >= 0 ? COLOR_GREEN : COLOR_RED;

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

    STREAMS_HTML: renderStreams(data, forEmail),
    TODAY_PER_STREAM_HTML: renderTodayPerStream(data, forEmail),
    TOP_DOCS_HTML: renderTopDoctors(data, forEmail),
    SILENT_DOCS_HTML: renderSilentDoctors(data, forEmail),
    WATCHLIST_HTML: renderWatchlist(data, forEmail),

    // Email-only color tokens
    STATUS_BG: statusPalette.bg,
    STATUS_FG: statusPalette.fg,
    STATUS_BORDER: statusPalette.border,
    Y_REVENUE_DELTA_COLOR: yRevColor,
    Y_VISITS_DELTA_COLOR: yVisitsColor,
    Y_SURPLUS_COLOR: ySurplusColor,
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
export function resolveChromiumExecutablePath(): string | undefined {
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
