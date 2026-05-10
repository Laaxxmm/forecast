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
let emailTemplateCache: string | null = null;
let clientLogoCache: string | null = null;
let indefineLogoCache: string | null = null;

function loadTemplate(forEmail: boolean): string {
  if (forEmail) {
    if (emailTemplateCache) return emailTemplateCache;
    emailTemplateCache = fs.readFileSync(path.join(__dirname, 'weekly-email-template.html'), 'utf-8');
    return emailTemplateCache;
  }
  if (templateCache) return templateCache;
  templateCache = fs.readFileSync(path.join(__dirname, 'weekly-template.html'), 'utf-8');
  return templateCache;
}

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
function renderChartRows(data: WeeklyPulseData, forEmail: boolean): string {
  const max = Math.max(...data.chart.days.map(d => d.revenue), 1);
  const scale = Math.max(max * 1.05, 1);
  if (!forEmail) {
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
  // Email path: each row = 3-cell table; the bar is a colored td of width%
  return data.chart.days.map((d, i) => {
    const widthPct = Math.min(100, (d.revenue / scale) * 100);
    const dateLabel = `${parseInt(d.date.split('-')[2], 10)} ${monthShort(d.date)}`;
    const barColor = d.isBest ? COLOR_GREEN : (d.isClosed || d.isWorst ? '#cdd0d6' : '#155cab');
    const pillBest = d.isBest ? `<span style="display:inline-block; background:#e3efe4; color:#1f7a3e; font:700 9.5px/1 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; text-transform:uppercase; padding:2px 6px; border-radius:999px; margin-left:6px;">Best</span>` : '';
    const pillWorst = d.isClosed
      ? `<span style="display:inline-block; background:#f3f4f7; color:${COLOR_MUTED}; border:1px solid #e3e4e8; font:700 9.5px/1 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; text-transform:uppercase; padding:2px 6px; border-radius:999px; margin-left:6px;">Closed-ish</span>`
      : (d.isWorst ? `<span style="display:inline-block; background:#f3f4f7; color:${COLOR_MUTED}; border:1px solid #e3e4e8; font:700 9.5px/1 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; text-transform:uppercase; padding:2px 6px; border-radius:999px; margin-left:6px;">Worst</span>` : '');
    const visitsLabel = d.visits > 0 ? `<div style="font:500 10px/1.3 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; text-transform:uppercase; color:${COLOR_MUTED}; margin-top:2px;">${formatIndian(d.visits)} visits</div>` : '';
    const border = i > 0 ? 'border-top:1px solid #eef0f3;' : '';
    return `
      <tr>
        <td width="64" valign="middle" style="${border} padding:8px 0; font:500 11px/1.3 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.8px; text-transform:uppercase; color:${COLOR_INK_SOFT};">
          <span style="color:${COLOR_INK}; font:700 14px/1.1 'Iowan Old Style',Georgia,serif; letter-spacing:0; text-transform:none; display:block;">${escape(d.weekday)}</span>
          <span style="color:${COLOR_MUTED}; font-weight:500; font-size:10.5px;">${escape(dateLabel)}</span>
        </td>
        <td valign="middle" style="${border} padding:8px 10px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f7; border-radius:3px; height:18px;">
            <tr>
              <td width="${widthPct.toFixed(1)}%" style="width:${widthPct.toFixed(1)}%; background:${barColor}; height:18px; border-radius:3px 0 0 3px; line-height:0; font-size:0;">&nbsp;</td>
              <td style="line-height:0; font-size:0;">&nbsp;</td>
            </tr>
          </table>
        </td>
        <td width="130" align="right" valign="middle" style="${border} padding:8px 0; font:700 14px/1.2 'Iowan Old Style',Georgia,serif; color:${COLOR_INK}; white-space:nowrap;">
          ${formatINR(d.revenue)}${pillBest}${pillWorst}
          ${visitsLabel}
        </td>
      </tr>`;
  }).join('');
}

function monthShort(ymd: string): string {
  const m = parseInt(ymd.split('-')[1], 10) - 1;
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m];
}

function renderStreams(data: WeeklyPulseData, forEmail: boolean): string {
  if (data.streams.length === 0) {
    return forEmail
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="padding:14px; text-align:center; color:${COLOR_MUTED};">No streams configured</td></tr></table>`
      : `<div class="area"><div class="head">No streams configured</div></div>`;
  }
  if (!forEmail) {
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
  // Email path: 2x2 grid of cards
  const renderCard = (s: WeeklyPulseData['streams'][number]) => {
    const tone = STATUS_PALETTE[s.status] || STATUS_PALETTE.ok;
    const wowArrow = s.wowDelta >= 0 ? '▲' : '▼';
    const wowSign = s.wowDelta >= 0 ? '+' : '';
    const wowColor = s.wowDelta >= 0 ? COLOR_GREEN : COLOR_RED;
    const headsLine = s.unitsCount != null
      ? `<div style="font:500 11px/1.4 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.4px; color:${COLOR_INK_SOFT}; margin-top:6px;"><b style="color:${COLOR_INK}; font-weight:700;">${formatIndian(s.unitsCount)}</b> ${escape(s.unitsLabel || 'sales')}</div>`
      : '';
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #e3e4e8; border-radius:6px;">
        <tr><td style="height:3px; background:${tone.fg}; line-height:0; font-size:0; border-radius:6px 6px 0 0;">&nbsp;</td></tr>
        <tr><td style="padding:12px 14px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td style="font:700 10.5px/1.4 ui-monospace,Menlo,Consolas,monospace; letter-spacing:1.4px; text-transform:uppercase; color:${COLOR_MUTED};">${escape(s.label)}</td><td align="right"><span style="display:inline-block; background:${tone.bg}; color:${tone.fg}; font:700 9.5px/1 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; text-transform:uppercase; padding:3px 7px; border-radius:999px;">${escape(s.statusLabel)}</span></td></tr>
          </table>
          <div style="font:600 16px/1.2 'Iowan Old Style',Georgia,serif; color:${COLOR_INK}; margin-top:6px;">${escape(friendlyStreamName(s.label))}</div>
          <div style="font:500 11px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_MUTED}; margin-top:4px;">Earned this week</div>
          <div style="font:700 22px/1 'Iowan Old Style',Georgia,serif; letter-spacing:-0.5px; color:${COLOR_INK}; margin-top:2px;">${formatINR(s.weekRevenue)}</div>
          ${headsLine}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:6px;">
            <tr><td style="font:500 10.5px/1.3 ui-monospace,Menlo,Consolas,monospace; color:${COLOR_MUTED};"><b style="color:${COLOR_INK};">${s.weekShare}%</b> of week</td><td align="right" style="font:600 10.5px/1.3 ui-monospace,Menlo,Consolas,monospace; color:${wowColor};">${wowArrow} ${wowSign}${s.wowDelta}% WoW</td></tr>
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:8px; border-top:1px dashed #e3e4e8;">
            <tr><td style="padding-top:7px; font:500 10px/1.3 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.8px; text-transform:uppercase; color:${COLOR_MUTED};">Next week target</td><td align="right" style="padding-top:7px; font:700 13px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK};">${formatINR(s.nextWeekTarget)}</td></tr>
          </table>
        </td></tr>
      </table>`;
  };
  const rows: string[] = [];
  for (let i = 0; i < data.streams.length; i += 2) {
    const a = data.streams[i];
    const b = data.streams[i + 1];
    const isLast = i + 2 >= data.streams.length;
    rows.push(`
      <tr>
        <td class="wp-stack-td" valign="top" width="50%" style="width:50%; padding:0 5px ${isLast ? '0' : '10px'} 0;">${renderCard(a)}</td>
        ${b ? `<td class="wp-stack-td" valign="top" width="50%" style="width:50%; padding:0 0 ${isLast ? '0' : '10px'} 5px;">${renderCard(b)}</td>` : '<td>&nbsp;</td>'}
      </tr>`);
  }
  return `<table role="presentation" class="wp-stack" cellpadding="0" cellspacing="0" border="0" width="100%">${rows.join('')}</table>`;
}

function friendlyStreamName(label: string): string {
  if (label === 'Consultations') return 'Doctor visits';
  if (label === 'Diagnostics') return 'Lab tests';
  if (label === 'Other Revenue') return 'Procedures & packages';
  if (label === 'Pharmacy') return 'Counter sales';
  return label;
}

function renderPerStream(data: WeeklyPulseData, forEmail: boolean): string {
  if (data.prescription.perStream.length === 0) return '';
  if (!forEmail) {
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
  return data.prescription.perStream.map((p, idx, arr) => {
    const border = idx < arr.length - 1 ? `border-bottom:1px solid #eef0f3;` : '';
    const unitsHtml = p.units && p.units.count > 0
      ? `<br/><span style="display:block; font:500 10px/1.2 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; color:${COLOR_MUTED}; margin-top:2px; text-transform:uppercase;">~${formatIndian(p.units.count)} ${escape(p.units.label)}</span>`
      : '';
    return `
      <tr>
        <td style="padding:5px 0; ${border} font:500 10.5px/1.2 ui-monospace,Menlo,Consolas,monospace; letter-spacing:1.1px; text-transform:uppercase; color:${COLOR_MUTED};">${escape(p.label)}</td>
        <td align="right" style="padding:5px 0; ${border} font:700 15px/1.2 'Iowan Old Style',Georgia,serif; color:${COLOR_INK};">${formatINR(p.target)}${unitsHtml}</td>
      </tr>`;
  }).join('');
}

function renderTopDoctors(data: WeeklyPulseData, forEmail: boolean): string {
  if (data.topDoctors.length === 0) {
    return forEmail
      ? `<tr><td style="padding:14px; text-align:center; font:italic 500 13px/1.4 'Iowan Old Style',Georgia,serif; color:${COLOR_MUTED};">No doctor billed across the week.</td></tr>`
      : `<div style="padding:18px 4px;text-align:center;font-family:var(--serif);font-style:italic;color:var(--muted);font-size:13px">No doctor billed across the week.</div>`;
  }
  if (!forEmail) {
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
  // Email path
  const rows: string[] = [];
  data.topDoctors.forEach((d, i) => {
    const delta = d.weekRevenue - d.typicalWeekRevenue;
    const arrow = delta >= 0 ? '▲' : '▼';
    const sign = delta >= 0 ? '+' : '−';
    const deltaColor = delta >= 0 ? COLOR_GREEN : COLOR_MUTED;
    const visits = d.weekVisits > 0 ? `${formatIndian(d.weekVisits)} pts · ` : '';
    if (i > 0) rows.push(`<tr><td colspan="3" style="border-top:1px solid #eef0f3; line-height:0; font-size:0;">&nbsp;</td></tr>`);
    rows.push(`
      <tr>
        <td width="20" style="font:700 16px/1 'Iowan Old Style',Georgia,serif; color:#155cab; padding:7px 8px 7px 0;">${d.rank}</td>
        <td style="padding:7px 0; font:600 13px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK};">${escape(d.name)}<br/><span style="font:500 10.5px/1.4 ui-monospace,Menlo,Consolas,monospace; color:${COLOR_MUTED};">${visits}Typical · ${formatINR(d.typicalWeekRevenue)}</span></td>
        <td align="right" style="padding:7px 0; font:700 14px/1.2 'Iowan Old Style',Georgia,serif; color:${COLOR_INK};">${formatINR(d.weekRevenue)}<br/><span style="font:500 10.5px/1.4 ui-monospace,Menlo,Consolas,monospace; color:${deltaColor};">${arrow} ${sign}${formatINR(Math.abs(delta))}</span></td>
      </tr>`);
  });
  return rows.join('');
}

function renderSilentDoctors(data: WeeklyPulseData, forEmail: boolean): string {
  if (data.silentDoctors.length === 0) {
    return forEmail
      ? `<div style="padding:14px 0; text-align:center; font:italic 500 13px/1.4 'Iowan Old Style',Georgia,serif; color:${COLOR_MUTED};">Every regular billed at least once — nothing to chase.</div>`
      : `<div class="empty">Every regular billed at least one day this week — nothing to chase.</div>`;
  }
  if (!forEmail) {
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
  // Email path
  const rows: string[] = [];
  data.silentDoctors.forEach((d, i) => {
    if (i > 0) rows.push(`<tr><td colspan="2" style="border-top:1px solid #eef0f3; line-height:0; font-size:0;">&nbsp;</td></tr>`);
    rows.push(`
      <tr>
        <td style="padding:6px 0; font:600 13px/1.3 -apple-system,Helvetica,Arial,sans-serif; color:${COLOR_INK};">${escape(d.name)}<br/><span style="font:500 10.5px/1.4 ui-monospace,Menlo,Consolas,monospace; color:${COLOR_INK_SOFT};">0 days · normally ${d.typicalDaysPerWeek}/wk · ${formatINR(d.typicalDayRevenue)}/day</span></td>
        <td align="right" style="padding:6px 0;"><span style="display:inline-block; background:#f5dbd2; color:#a8311c; font:700 9.5px/1 ui-monospace,Menlo,Consolas,monospace; letter-spacing:0.6px; text-transform:uppercase; padding:4px 8px; border-radius:999px; border:1px solid #e3b6ad; white-space:nowrap;">All week</span></td>
      </tr>`);
  });
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows.join('')}</table>
    <div style="margin-top:10px; padding:9px 11px; background:#f3f4f7; border-radius:4px; font:italic 400 12.5px/1.4 'Iowan Old Style',Georgia,serif; color:${COLOR_INK_SOFT};"><span style="color:#155cab; font-weight:700;">&ldquo;</span>When regulars miss an entire week, it's usually scheduling, not departure.</div>`;
}

function renderWatchlist(data: WeeklyPulseData, forEmail: boolean): string {
  if (data.watchlist.length === 0) {
    return forEmail
      ? `<tr><td style="padding:18px 16px; text-align:center; font:italic 500 14px/1.4 'Iowan Old Style',Georgia,serif; color:${COLOR_MUTED};">A clean week — nothing on the watchlist ✓</td></tr>`
      : `<div class="empty">A clean week — nothing on the watchlist ✓</div>`;
  }
  const iconFor = (t: string) =>
    t === 'stock_expiry' ? '℞'
    : t === 'discount_drift' ? '%'
    : t === 'margin_drift' ? '▾'
    : t === 'refund_concentration' ? '↩'
    : t === 'unmapped_doctor' ? '⚲'
    : '!';
  if (!forEmail) {
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

// ── Public renderer ──
export function renderWeeklyPulseHtml(data: WeeklyPulseData, forEmail: boolean = false): string {
  const template = loadTemplate(forEmail);

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

  const statusPalette = STATUS_PALETTE[data.status.tone] || STATUS_PALETTE.ok;
  const wRevColor = data.week.revenueWoWPct >= 0 ? COLOR_GREEN : COLOR_RED;
  const wVisitsColor = data.week.visitsWoWDelta >= 0 ? COLOR_GREEN : COLOR_RED;

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

    CHART_ROWS_HTML: renderChartRows(data, forEmail),
    CHART_SUMMARY_HTML: data.chart.summary,
    STREAMS_HTML: renderStreams(data, forEmail),
    TODAY_PER_STREAM_HTML: renderPerStream(data, forEmail),
    TOP_DOCS_HTML: renderTopDoctors(data, forEmail),
    TOP_DOCS_COUNT: String(data.topDoctors.length || 10),
    SILENT_DOCS_HTML: renderSilentDoctors(data, forEmail),

    PATTERN_LABEL: escape(data.pattern.label),
    // pattern text intentionally NOT escaped — the data layer renders <b>…</b>
    // for the highlighted phrase. The label IS escaped above.
    PATTERN_TEXT: data.pattern.text,

    WATCHLIST_HTML: renderWatchlist(data, forEmail),
    WATCHLIST_STAMP: data.watchlist.length === 0 ? 'All clear' : `${data.watchlist.length} item${data.watchlist.length === 1 ? '' : 's'} this week`,

    // Email-only color tokens
    STATUS_BG: statusPalette.bg,
    STATUS_FG: statusPalette.fg,
    STATUS_BORDER: statusPalette.border,
    W_REVENUE_DELTA_COLOR: wRevColor,
    W_VISITS_DELTA_COLOR: wVisitsColor,
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
