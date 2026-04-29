import { useEffect, useState } from 'react';
import { X, Download, Calendar, CalendarDays, CalendarRange } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

/* ──────── Types ──────── */

interface CardData {
  label: string; mtd: number; target: number; projected: number;
  dailyRate: number; requiredRate: number; rag: string;
  lastMonthMtd: number; unit: string;
  category?: string;
}
interface WeekData { patients: number; revenue: number; transactions: number; profit: number; avgTicket: number; }
interface StreamData {
  name: string; streamId: number; icon: string; color: string;
  cards: CardData[]; thisWeek: WeekData; lastWeek: WeekData;
  daily: { date: string; patients?: number; revenue: number; transactions?: number; profit?: number }[];
}
export interface InsightsData {
  month: string; monthLabel: string;
  daysElapsed: number; daysInMonth: number; daysRemaining: number;
  streams: StreamData[];
  combined: { mtdRevenue: number; targetRevenue: number; projectedRevenue: number; rag: string };
  actions: { severity: string; stream: string; message: string }[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  data: InsightsData;
  clientName?: string;
  branchName?: string;
  streamName?: string;
}

/** Holds the client logo as an in-memory PNG data URL plus its aspect ratio
 *  (width / height). The data URL is what jspdf's addImage accepts. We
 *  always normalise to PNG via canvas so SVG/JPEG/WEBP all just work. */
interface LogoState {
  dataUrl: string;
  aspect: number;
}

type ReportVariant = 'daily' | 'weekly' | 'monthly';

/* ──────── PDF-SAFE FORMATTERS (ASCII only) ────────
 *
 * jsPDF's default Helvetica font uses WinAnsi encoding, which does NOT
 * contain the Indian Rupee (Rs.) glyph. Using Intl.NumberFormat's currency
 * mode would inject that character and render as empty boxes, making the
 * PDF unreadable. All formatters below stay inside WinAnsi.
 */

function indianNumber(n: number): string {
  // Indian digit grouping: 12,34,567
  const rounded = Math.round(n);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded).toString();
  if (abs.length <= 3) return sign + abs;
  const last3 = abs.slice(-3);
  const rest = abs.slice(0, -3);
  const withCommas = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return sign + withCommas + ',' + last3;
}

function fmtRs(n: number): string {
  return 'Rs. ' + indianNumber(n);
}

function fmtCount(n: number): string {
  return indianNumber(n);
}

function fmtValue(v: number, unit: string): string {
  if (unit === 'currency') return fmtRs(v);
  if (unit === 'percent') return `${v}%`;
  return fmtCount(v);
}

function pctChange(cur: number, prev: number): string {
  if (!prev) return '--';
  const delta = ((cur - prev) / prev) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

/** Build the footer label rendered at the bottom of every page. Includes
 *  client + branch + stream so a printed copy is unambiguous about which
 *  organisation / location / line of business it pertains to. */
function footerLabel(
  reportType: string,
  monthLabel: string,
  clientName: string,
  branchName: string,
  streamName: string,
): string {
  const parts: string[] = [reportType, monthLabel];
  if (clientName) parts.push(clientName);
  if (branchName) parts.push(branchName);
  if (streamName) parts.push(streamName);
  return parts.map(p => safeText(p)).join('  |  ');
}

/** Build a filesystem-safe filename. `{ReportType}_{YYYY-MM}[_branch][_extra].pdf` */
function filename(prefix: string, month: string, branchName: string, extra?: string): string {
  const branchTag = branchName
    ? `_${branchName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
    : '';
  const extraTag = extra ? `_${extra}` : '';
  return `${prefix}_${month}${branchTag}${extraTag}.pdf`;
}

function prettyDate(d: string): string {
  const [y, m, day] = d.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parseInt(day)} ${months[parseInt(m)]} ${y}`;
}

function ragLabel(rag: string): string {
  switch (rag) {
    case 'GREEN': return 'ON TRACK';
    case 'AMBER': return 'NEEDS ATTENTION';
    case 'RED': return 'BEHIND TARGET';
    default: return 'NO TARGET';
  }
}

function ragRGB(rag: string): [number, number, number] {
  switch (rag) {
    case 'GREEN': return [16, 185, 129];
    case 'AMBER': return [245, 158, 11];
    case 'RED': return [220, 38, 38];
    default: return [100, 116, 139];
  }
}

/* ──────── Color palette ──────── */

const PRIMARY: [number, number, number] = [13, 148, 136]; // teal
const PRIMARY_DARK: [number, number, number] = [6, 95, 87];
const LIGHT_BG: [number, number, number] = [241, 245, 249];
const DARK_TEXT: [number, number, number] = [30, 41, 59];
const MUTED_TEXT: [number, number, number] = [100, 116, 139];
const BAR_BG: [number, number, number] = [226, 232, 240];
const PAGE_BG: [number, number, number] = [243, 246, 250];
const CARD_BORDER: [number, number, number] = [226, 232, 240];
const CARD_SHADOW: [number, number, number] = [220, 226, 234];
const DANGER_BG: [number, number, number] = [254, 226, 226];
const DANGER_BORDER: [number, number, number] = [220, 38, 38];
const DANGER_TEXT: [number, number, number] = [153, 27, 27];

const GREEN: [number, number, number] = [16, 185, 129];
const AMBER: [number, number, number] = [245, 158, 11];
const RED: [number, number, number] = [225, 70, 80];   // softened (was 220,38,38 — too alarming)
const MUTED: [number, number, number] = [148, 163, 184];

/** Classify an end-of-period projection into a RAG band.
 *  Used for status pills + bar fill colour where actual is final.
 *  >=100 green · 80-100 amber · <80 red. */
function pctToRAG(pct: number): 'GREEN' | 'AMBER' | 'RED' {
  if (!isFinite(pct)) return 'RED';
  if (pct >= 100) return 'GREEN';
  if (pct >= 80) return 'AMBER';
  return 'RED';
}

function pctToColor(pct: number): [number, number, number] {
  const r = pctToRAG(pct);
  return r === 'GREEN' ? GREEN : r === 'AMBER' ? AMBER : RED;
}

/** Pace-aware classifier for MTD progress bars. Compares actual MTD% against the
 *  expected MTD% (e.g. day 17/30 = 56.7% expected). Coloring partial-period MTD by
 *  static thresholds (the old behaviour) makes everything look red mid-month even
 *  when the business is on pace. */
function paceRAG(actualPct: number, expectedPct: number): 'GREEN' | 'AMBER' | 'RED' {
  if (!isFinite(actualPct)) return 'RED';
  if (expectedPct <= 0) return pctToRAG(actualPct);
  const ratio = actualPct / expectedPct;
  if (ratio >= 0.95) return 'GREEN';   // at or above expected pace
  if (ratio >= 0.75) return 'AMBER';   // slipping but recoverable
  return 'RED';
}

function paceColor(actualPct: number, expectedPct: number): [number, number, number] {
  const r = paceRAG(actualPct, expectedPct);
  return r === 'GREEN' ? GREEN : r === 'AMBER' ? AMBER : RED;
}

/** Scrub characters jsPDF's WinAnsi-encoded Helvetica can't render. The biggest
 *  offender is the rupee sign which falls back to a "¹" glyph AND reports zero
 *  width — that throws off splitTextToSize and causes downstream truncation
 *  ("Need ¹89,451/day to recover (g..."). Backend-supplied action messages and
 *  any other untrusted text must pass through this before rendering. */
function safeText(s: string | undefined | null): string {
  if (!s) return '';
  return String(s)
    .replace(/\u20B9\s*/g, 'Rs. ')   // ₹ → Rs.
    .replace(/[\u2018\u2019]/g, "'") // smart single quotes → '
    .replace(/[\u201C\u201D]/g, '"') // smart double quotes → "
    .replace(/\u2013/g, '-')         // en-dash → hyphen
    .replace(/\u2014/g, '--')        // em-dash → double hyphen (visually clearer than single)
    .replace(/\u2026/g, '...')       // ellipsis
    .replace(/\u00A0/g, ' ')         // nbsp → space
    .replace(/\u2192/g, '->')        // right arrow → ->
    .replace(/\u2190/g, '<-');       // left arrow → <-
}

/** Resolve the stream's primary revenue card. Top-level Revenue/Sales when
 *  present; otherwise synthesise a stream total by summing all category Revenue
 *  cards (fixes Clinic where every revenue card has a category and the old
 *  fallback returned the first "Patients" card). */
function getStreamPrimary(s: StreamData): CardData | null {
  const top = s.cards.find(c => c.label === 'Revenue' && !c.category)
    || s.cards.find(c => c.label === 'Sales');
  if (top) return top;

  const revCards = s.cards.filter(c => c.label === 'Revenue' && c.target > 0);
  if (revCards.length > 0) {
    const sum = (k: keyof CardData) => revCards.reduce((a, c) => a + (c[k] as number || 0), 0);
    const synth: CardData = {
      label: 'Revenue',
      mtd: sum('mtd'),
      target: sum('target'),
      projected: sum('projected'),
      dailyRate: sum('dailyRate'),
      requiredRate: sum('requiredRate'),
      lastMonthMtd: sum('lastMonthMtd'),
      rag: '',
      unit: 'currency',
    };
    const projPct = synth.target > 0 ? (synth.projected / synth.target) * 100 : 0;
    synth.rag = pctToRAG(projPct);
    return synth;
  }
  return s.cards[0] || null;
}

/** Draw a small filled circle as a list bullet. Decoupling the bullet from the
 *  text means we don't depend on the font supporting any unicode bullet glyph
 *  (the previous ">" prefix looked like terminal output). */
function drawBullet(doc: jsPDF, x: number, y: number, color: [number, number, number]) {
  doc.setFillColor(...color);
  doc.circle(x, y - 1.4, 0.85, 'F');
}

/* ──────── Visual primitives ──────── */

function drawProgressBar(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  actualPct: number,      // 0-N (can exceed 100)
  projectedPct: number,   // 0-N (can exceed 100)
  color: [number, number, number]
) {
  // Track background (represents 100% of target)
  doc.setFillColor(...BAR_BG);
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'F');

  if (actualPct <= 100 && projectedPct <= 100) {
    // Standard case: both under/at target.
    const actualW = Math.max(0, (w * actualPct) / 100);
    if (actualW > 0) {
      doc.setFillColor(...color);
      doc.roundedRect(x, y, actualW, h, 1.5, 1.5, 'F');
    }
    if (projectedPct > 0) {
      const projX = x + (w * projectedPct) / 100;
      doc.setDrawColor(30, 41, 59);
      doc.setLineWidth(0.5);
      doc.line(projX, y - 1, projX, y + h + 1);
      doc.setLineWidth(0.2);
    }
    return;
  }

  // Exceeded case: compress scale so the full actual/projected fits and the
  // original 100% target stays clearly marked inside the track.
  const scaleMax = Math.max(actualPct, projectedPct, 100);
  const targetX = x + (w * 100) / scaleMax;
  const actualW = (w * actualPct) / scaleMax;
  const projX = x + (w * projectedPct) / scaleMax;

  // Fill the portion up to target in the RAG colour
  if (actualW > 0) {
    const capped = Math.min(actualW, targetX - x);
    doc.setFillColor(...color);
    doc.roundedRect(x, y, capped, h, 1.5, 1.5, 'F');
    // Overflow portion in a slightly darker shade to show surplus
    if (actualW > targetX - x) {
      doc.setFillColor(Math.max(color[0] - 30, 0), Math.max(color[1] - 30, 0), Math.max(color[2] - 30, 0));
      doc.rect(targetX, y, actualW - (targetX - x), h, 'F');
    }
  }

  // 100% target marker (solid bold line in the middle of the bar)
  doc.setDrawColor(30, 41, 59);
  doc.setLineWidth(0.7);
  doc.line(targetX, y - 1.5, targetX, y + h + 1.5);

  // Projected marker
  doc.setDrawColor(71, 85, 105);
  doc.setLineWidth(0.4);
  doc.line(projX, y - 1, projX, y + h + 1);

  doc.setLineWidth(0.2);

  // Tick labels above the bar so they don't collide with the MTD/Target row
  // that sits below.
  doc.setFontSize(6.4);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...MUTED_TEXT);
  doc.text('TARGET', targetX, y - 2.4, { align: 'center' });
  doc.setFont('helvetica', 'normal');
}

function drawMiniBarChart(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  values: number[],
  color: [number, number, number],
  targetLine?: number
) {
  if (values.length === 0) return;
  const peak = Math.max(...values);
  const maxVal = Math.max(peak, targetLine || 0) || 1;
  // Reserve a sliver on the left for the y-max label
  const labelW = 14;
  const chartX = x + labelW;
  const chartW = w - labelW;
  const gap = 1.2;
  const barW = Math.max((chartW - gap * (values.length - 1)) / values.length, 1);

  // Y-axis grid: 0, 50%, 100% of maxVal
  doc.setDrawColor(...BAR_BG);
  doc.setLineWidth(0.15);
  doc.line(chartX, y, chartX + chartW, y);                // top (max)
  doc.line(chartX, y + h / 2, chartX + chartW, y + h / 2); // mid
  doc.line(chartX, y + h, chartX + chartW, y + h);        // baseline (0)

  // Y-axis labels
  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED_TEXT);
  doc.text(fmtRsCompact(maxVal), chartX - 1, y + 1.6, { align: 'right' });
  doc.text(fmtRsCompact(maxVal / 2), chartX - 1, y + h / 2 + 1.6, { align: 'right' });
  doc.text('0', chartX - 1, y + h, { align: 'right' });

  // Bars (slightly soft fill, clean stroke)
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const bh = (v / maxVal) * h;
    const bx = chartX + i * (barW + gap);
    const by = y + h - bh;
    doc.setFillColor(...color);
    doc.rect(bx, by, barW, bh, 'F');
  }

  // Target line (subtle amber dashed; less alarming than red)
  if (targetLine && targetLine > 0) {
    const ty = y + h - (targetLine / maxVal) * h;
    doc.setDrawColor(...AMBER);
    doc.setLineWidth(0.3);
    const step = 1.6;
    for (let lx = chartX; lx < chartX + chartW; lx += step * 2) {
      doc.line(lx, ty, Math.min(lx + step, chartX + chartW), ty);
    }
  }
  doc.setLineWidth(0.2);
}

/** Compact rupee formatter for axis labels: 1.2L, 84K, etc. */
function fmtRsCompact(n: number): string {
  if (!isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}K`;
  return Math.round(n).toString();
}

function drawRAGPill(doc: jsPDF, rag: string, x: number, y: number, w = 42, h = 6) {
  const [r, g, b] = ragRGB(rag);
  doc.setFillColor(r, g, b);
  doc.roundedRect(x, y - h + 1, w, h, 1.5, 1.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(ragLabel(rag), x + w / 2, y - 1.5, { align: 'center' });
  doc.setFont('helvetica', 'normal');
}

/** Paint the full page light-grey so white cards stand out. */
function drawPageBg(doc: jsPDF) {
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  doc.setFillColor(...PAGE_BG);
  doc.rect(0, 0, pw, ph, 'F');
}

/** White card with subtle shadow + hairline border. */
function drawCard(doc: jsPDF, x: number, y: number, w: number, h: number) {
  // shadow
  doc.setFillColor(...CARD_SHADOW);
  doc.roundedRect(x + 0.4, y + 0.6, w, h, 2.5, 2.5, 'F');
  // fill
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, y, w, h, 2.5, 2.5, 'F');
  // border
  doc.setDrawColor(...CARD_BORDER);
  doc.setLineWidth(0.2);
  doc.roundedRect(x, y, w, h, 2.5, 2.5, 'S');
}

/** Section title inside a card: coloured accent bar + bold text. */
function drawCardTitle(doc: jsPDF, title: string, x: number, y: number, color: [number, number, number] = PRIMARY) {
  doc.setFillColor(...color);
  doc.rect(x, y - 3.5, 1.6, 5, 'F');
  doc.setTextColor(...DARK_TEXT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(title, x + 4, y);
}

/** Directional arrow next to a WoW change percentage. */
function drawWoWArrow(doc: jsPDF, x: number, y: number, pct: number) {
  const up = pct >= 0;
  const color: [number, number, number] = up ? GREEN : RED;
  doc.setFillColor(...color);
  if (up) {
    // filled up-triangle
    doc.triangle(x, y - 2.6, x + 1.8, y + 0.2, x - 1.8, y + 0.2, 'F');
  } else {
    // filled down-triangle
    doc.triangle(x, y + 0.4, x + 1.8, y - 2.4, x - 1.8, y - 2.4, 'F');
  }
}

/** Small coloured status pill (ON TRACK / WATCH / BEHIND / …). */
function drawStatusPill(doc: jsPDF, status: string, x: number, y: number) {
  const upper = status.toUpperCase();
  const isGreen = /ON TRACK|EXCEEDED|ON PACE/.test(upper);
  const isRed = /BEHIND/.test(upper);
  const isAmber = /WATCH|ATTENTION/.test(upper);
  const color: [number, number, number] = isGreen ? GREEN : isRed ? RED : isAmber ? AMBER : MUTED;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  const tw = doc.getTextWidth(upper) + 5;
  doc.setFillColor(...color);
  doc.roundedRect(x, y - 3.4, tw, 4.6, 1, 1, 'F');
  doc.setTextColor(255, 255, 255);
  doc.text(upper, x + tw / 2, y - 0.3, { align: 'center' });
}

/** Red callout box for critical issues (WoW drops, margin gaps, etc.). */
function drawAlertBox(doc: jsPDF, x: number, y: number, w: number, alerts: string[]): number {
  if (alerts.length === 0) return y;
  const bulletX = x + 6;
  const textX = x + 9.5;
  const innerW = w - (textX - x) - 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);

  // Pre-wrap each alert into lines so we can position bullets per item (not per wrapped line)
  const items: string[][] = alerts.map(a => doc.splitTextToSize(safeText(a), innerW));
  const totalLines = items.reduce((sum, lns) => sum + lns.length, 0);

  const headerH = 10;
  const lineH = 4.6;
  const itemGap = 2.4;
  const bodyH = totalLines * lineH + (items.length - 1) * itemGap;
  const padB = 5;
  const h = headerH + bodyH + padB;

  // background
  doc.setFillColor(...DANGER_BG);
  doc.roundedRect(x, y, w, h, 2, 2, 'F');
  // left accent
  doc.setFillColor(...DANGER_BORDER);
  doc.rect(x, y, 1.6, h, 'F');
  // border
  doc.setDrawColor(252, 165, 165);
  doc.setLineWidth(0.2);
  doc.roundedRect(x, y, w, h, 2, 2, 'S');

  // header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...DANGER_TEXT);
  doc.text('CRITICAL ALERTS', x + 5, y + 5.5);

  // body
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...DARK_TEXT);
  let ly = y + headerH + 3.6;
  for (const lines of items) {
    drawBullet(doc, bulletX, ly, DANGER_BORDER);
    for (let i = 0; i < lines.length; i++) {
      doc.text(lines[i], textX, ly);
      ly += lineH;
    }
    ly += itemGap;
  }
  return y + h + 9;
}

/** Thin progress bar with RAG fill, used inside scorecards and KPI rows. */
function drawInlineBar(doc: jsPDF, x: number, y: number, w: number, pct: number) {
  const color = pctToColor(pct);
  const h = 2.6;
  // track
  doc.setFillColor(...BAR_BG);
  doc.roundedRect(x, y, w, h, 1, 1, 'F');
  // fill (capped at 100%)
  const displayPct = Math.max(0, Math.min(pct, 100));
  const fillW = (w * displayPct) / 100;
  if (fillW > 0) {
    doc.setFillColor(...color);
    doc.roundedRect(x, y, fillW, h, 1, 1, 'F');
  }
  // over-shoot cap marker
  if (pct > 100) {
    doc.setDrawColor(...DARK_TEXT);
    doc.setLineWidth(0.3);
    doc.line(x + w, y - 0.5, x + w, y + h + 0.5);
    doc.setLineWidth(0.2);
  }
}

/** Pace-aware variant. Fill colour depends on actual vs expected MTD%, and a
 *  tick mark on the track shows where the bar SHOULD be at the current point in
 *  the period — so a 50% bar at day 17/30 reads green (on pace) instead of red. */
function drawInlineBarPaced(
  doc: jsPDF, x: number, y: number, w: number, pct: number, expectedPct: number,
) {
  const color = paceColor(pct, expectedPct);
  const h = 2.6;
  // track
  doc.setFillColor(...BAR_BG);
  doc.roundedRect(x, y, w, h, 1, 1, 'F');
  // fill (capped at 100%)
  const displayPct = Math.max(0, Math.min(pct, 100));
  const fillW = (w * displayPct) / 100;
  if (fillW > 0) {
    doc.setFillColor(...color);
    doc.roundedRect(x, y, fillW, h, 1, 1, 'F');
  }
  // expected-pace tick mark — only when meaningful (early/mid period)
  if (expectedPct > 5 && expectedPct < 100) {
    const tickX = x + (w * Math.min(expectedPct, 100)) / 100;
    doc.setDrawColor(...DARK_TEXT);
    doc.setLineWidth(0.4);
    doc.line(tickX, y - 0.8, tickX, y + h + 0.8);
    doc.setLineWidth(0.2);
  }
  if (pct > 100) {
    doc.setDrawColor(...DARK_TEXT);
    doc.setLineWidth(0.3);
    doc.line(x + w, y - 0.5, x + w, y + h + 0.5);
    doc.setLineWidth(0.2);
  }
}

/* ──────── Page chrome ──────── */

/** Draw the teal title bar that crowns every report's first page.
 *
 *  Layout, left → right:
 *    • Logo box (when supplied) — 22mm tall, width by aspect, capped at 36mm
 *    • Title (large bold) and subtitle, anchored to the right edge of the logo
 *    • Right rail: company name (bold), branch · stream context, generated date
 *
 *  When `logo` is null the layout collapses gracefully and the title sits at
 *  x=14 like before, so reports for clients without a logo still look right.
 */
function addHeader(
  doc: jsPDF,
  title: string,
  subtitle: string,
  clientName: string,
  branchName: string,
  streamName: string,
  logo: LogoState | null,
) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pageW, 34, 'F');
  doc.setFillColor(...PRIMARY_DARK);
  doc.rect(0, 34, pageW, 2, 'F');

  // ── Logo (left) ──
  let titleX = 14;
  if (logo && logo.dataUrl) {
    const logoH = 22;
    const aspect = logo.aspect && isFinite(logo.aspect) && logo.aspect > 0 ? logo.aspect : 1;
    // Cap width so very-wide logos don't crowd the title; floor so very-tall
    // logos keep some presence. Height stays at 22mm so the logo always sits
    // visually centred inside the 34mm bar.
    const logoW = Math.max(8, Math.min(36, logoH * aspect));
    try {
      doc.addImage(logo.dataUrl, 'PNG', 14, 6, logoW, logoH, undefined, 'FAST');
      titleX = 14 + logoW + 5;
    } catch {
      // ignore; fall through to a text-only header
    }
  }

  // ── Title + subtitle ──
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(title, titleX, 15);

  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');
  doc.text(subtitle, titleX, 23);

  // ── Right rail: company name, branch · stream, generated timestamp ──
  if (clientName) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text(safeText(clientName), pageW - 14, 13, { align: 'right' });
  }

  const ctxParts: string[] = [];
  if (branchName) ctxParts.push(safeText(branchName));
  if (streamName) ctxParts.push(safeText(streamName));
  if (ctxParts.length) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    // Slightly muted teal-on-teal so the company name stays visually dominant
    doc.setTextColor(220, 245, 235);
    doc.text(ctxParts.join('  ·  '), pageW - 14, 21, { align: 'right' });
  }

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(220, 245, 235);
  doc.text(
    `Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`,
    pageW - 14, 28, { align: 'right' }
  );
}

function addParagraph(doc: jsPDF, text: string, y: number, options?: { bold?: boolean; color?: [number, number, number]; size?: number }): number {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', options?.bold ? 'bold' : 'normal');
  doc.setFontSize(options?.size ?? 10);
  doc.setTextColor(...(options?.color ?? DARK_TEXT));
  const lines = doc.splitTextToSize(text, pageW - 28);
  doc.text(lines, 14, y);
  return y + lines.length * ((options?.size ?? 10) * 0.42) + 1;
}

function addFooter(doc: jsPDF, label: string) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED_TEXT);
    doc.text(label, 14, pageH - 8);
    doc.text(`Page ${p} of ${n}`, pageW - 14, pageH - 8, { align: 'right' });
  }
}

/* ──────── Narrative / insight engine ──────── */

interface InsightNarrative {
  executive: string;        // one-paragraph summary
  streamInsights: string[]; // per-stream paragraph
  observations: string[];   // bullet points
  actions: string[];        // target-focused actions
  alerts: string[];         // critical red-flag callouts (WoW drops, margin gaps, big target misses)
}

/** Walk each stream and surface critical issues that belong in the red alert box. */
function buildAlerts(data: InsightsData): string[] {
  const alerts: string[] = [];
  for (const s of streams_list(data)) {
    // WoW revenue drop
    const tw = s.thisWeek.revenue;
    const lw = s.lastWeek.revenue;
    if (lw > 0 && tw >= 0) {
      const wow = ((tw - lw) / lw) * 100;
      if (wow <= -15) {
        alerts.push(`${s.name} revenue dropped ${Math.abs(Math.round(wow))}% week-over-week (${fmtRs(tw)} vs ${fmtRs(lw)}).`);
      }
    }
    // Gross margin below forecast
    const margin = s.cards.find(c => c.label === 'Gross Margin');
    if (margin && margin.target > 0) {
      const delta = margin.mtd - margin.target;
      if (delta <= -3) {
        alerts.push(`${s.name} gross margin is ${margin.mtd}% vs ${margin.target}% forecast — ${Math.abs(delta).toFixed(1)}pp below plan.`);
      }
    }
    // Primary revenue materially behind target (uses synthetic total when needed)
    const primary = getStreamPrimary(s);
    if (primary && primary.target > 0) {
      const projPct = (primary.projected / primary.target) * 100;
      if (projPct < 70) {
        alerts.push(`${s.name} projected to close month at ${Math.round(projPct)}% of target (${fmtRs(primary.projected)} vs ${fmtRs(primary.target)}).`);
      }
    }
  }
  // Combined projection red
  if (data.combined.targetRevenue > 0) {
    const combinedPct = (data.combined.projectedRevenue / data.combined.targetRevenue) * 100;
    if (combinedPct < 70) {
      alerts.push(`Combined revenue projection is ${Math.round(combinedPct)}% of monthly target — intervention required.`);
    }
  }
  return alerts;
}

/** Tiny helper so buildAlerts reads top-down without TypeScript complaints. */
function streams_list(data: InsightsData) { return data.streams; }

function buildNarrative(data: InsightsData, variant: ReportVariant): InsightNarrative {
  const { streams, combined, daysElapsed, daysInMonth, daysRemaining, monthLabel, actions } = data;

  // ── Executive summary ─────────────────────────────
  let executive = '';
  if (combined.targetRevenue > 0) {
    const mtdPct = Math.round((combined.mtdRevenue / combined.targetRevenue) * 100);
    const projPct = Math.round((combined.projectedRevenue / combined.targetRevenue) * 100);
    const gap = combined.targetRevenue - combined.projectedRevenue;
    const health =
      combined.rag === 'GREEN' ? 'the business is tracking comfortably toward target' :
      combined.rag === 'AMBER' ? 'the business is close to target but needs focused execution' :
      combined.rag === 'RED' ? 'the business is materially behind target and corrective action is needed' :
      'no monthly target is set';

    if (variant === 'daily') {
      executive =
        `Day ${daysElapsed} of ${daysInMonth} in ${monthLabel} -- ${health}. ` +
        `Month-to-date revenue stands at ${fmtRs(combined.mtdRevenue)} (${mtdPct}% of the ${fmtRs(combined.targetRevenue)} monthly target). ` +
        `At the current pace the month is projected to close at ${fmtRs(combined.projectedRevenue)} (${projPct}%). ` +
        (gap > 0
          ? `Closing today's projected gap of ${fmtRs(Math.max(gap, 0))} will require ${fmtRs(gap / Math.max(daysRemaining, 1))} of incremental revenue per remaining day.`
          : `The projected run-rate clears the monthly target with ${fmtRs(Math.abs(gap))} of cushion.`);
    } else if (variant === 'weekly') {
      executive =
        `With ${daysRemaining} days left in ${monthLabel}, ${health}. ` +
        `MTD revenue is ${fmtRs(combined.mtdRevenue)} (${mtdPct}% of target) and the current run-rate projects ${fmtRs(combined.projectedRevenue)} (${projPct}%) by month end. ` +
        (gap > 0
          ? `The week ahead needs to deliver ${fmtRs((gap / Math.max(daysRemaining, 1)) * 7)} to pull projections back to target.`
          : `Current weekly cadence keeps the month on track.`);
    } else {
      executive =
        `${monthLabel} performance overview -- ${health}. ` +
        `Through day ${daysElapsed} of ${daysInMonth}, combined revenue is ${fmtRs(combined.mtdRevenue)}, which is ${mtdPct}% of the ${fmtRs(combined.targetRevenue)} monthly target. ` +
        `The current daily run-rate projects the month will close at ${fmtRs(combined.projectedRevenue)} (${projPct}% of target). ` +
        (gap > 0
          ? `A ${fmtRs(gap)} gap remains; the remaining ${daysRemaining} days must average ${fmtRs(gap / Math.max(daysRemaining, 1))}/day above plan to close it.`
          : `Projections exceed target by ${fmtRs(Math.abs(gap))} -- focus shifts from recovery to margin protection and sustainability.`);
    }
  } else {
    executive =
      `${monthLabel} performance -- no monthly revenue target is configured. ` +
      `Month-to-date combined revenue: ${fmtRs(combined.mtdRevenue)}. Projected end-of-month: ${fmtRs(combined.projectedRevenue)}.`;
  }

  // ── Per-stream narratives ─────────────────────────
  const streamInsights: string[] = [];
  for (const s of streams) {
    const isClinic = s.name.toLowerCase().includes('clinic') || s.name.toLowerCase().includes('health');
    const primary = getStreamPrimary(s);
    if (!primary) continue;

    let para = `${s.name}: `;
    if (primary.target > 0) {
      const pct = Math.round((primary.mtd / primary.target) * 100);
      const projPct = Math.round((primary.projected / primary.target) * 100);
      const aheadMtd = primary.mtd >= primary.target;
      const aheadProj = primary.projected >= primary.target;

      if (aheadMtd) {
        // Already cleared the month with days still to go.
        para += `MTD revenue of ${fmtRs(primary.mtd)} has already cleared the ${fmtRs(primary.target)} monthly target (${pct}%). `;
        para += `Current daily pace is ${fmtRs(primary.dailyRate)}/day and at this run-rate the month is projected to close at ${fmtRs(primary.projected)} (${projPct}%), a ${fmtRs(primary.projected - primary.target)} cushion above target. `;
        para += `Focus shifts from revenue catch-up to maintaining pace and protecting margin. `;
      } else if (aheadProj) {
        // MTD behind target but projection clears it.
        para += `MTD revenue is ${fmtRs(primary.mtd)} (${pct}% of ${fmtRs(primary.target)} target). `;
        para += `Current daily pace of ${fmtRs(primary.dailyRate)}/day projects the month to close at ${fmtRs(primary.projected)} (${projPct}%) -- target clears with a cushion of ${fmtRs(primary.projected - primary.target)}. `;
      } else {
        // Genuinely behind — required rate is positive and meaningful.
        const state =
          primary.rag === 'GREEN' ? 'on pace' :
          primary.rag === 'AMBER' ? 'close, needs attention' : 'behind pace';
        para += `MTD revenue is ${fmtRs(primary.mtd)} (${pct}% of ${fmtRs(primary.target)} target), ${state}. `;
        para += `Actual daily pace is ${fmtRs(primary.dailyRate)}/day vs a required ${fmtRs(Math.max(primary.requiredRate, 0))}/day to hit target. `;
        para += `At this pace, projected EOM is ${fmtRs(primary.projected)} (${projPct}%). `;
      }
    } else {
      para += `MTD revenue is ${fmtRs(primary.mtd)} (no target set). `;
    }

    // WoW signal
    const tw = s.thisWeek.revenue;
    const lw = s.lastWeek.revenue;
    if (lw > 0 && tw > 0) {
      const wow = ((tw - lw) / lw) * 100;
      if (Math.abs(wow) >= 5) {
        para += `Weekly revenue ${wow >= 0 ? 'rose' : 'dropped'} ${Math.abs(wow).toFixed(1)}% vs last week (${fmtRs(tw)} vs ${fmtRs(lw)}). `;
      }
    }

    // Clinic: category call-outs
    if (isClinic) {
      const catCards = s.cards.filter(c => c.category);
      const redCats = catCards.filter(c => c.rag === 'RED');
      if (redCats.length > 0) {
        const names = [...new Set(redCats.map(c => c.category))].join(', ');
        para += `Category watch: ${names} behind target. `;
      }
    }
    streamInsights.push(para.trim());
  }

  // ── Observations (bullet points) ──────────────────
  const observations: string[] = [];

  for (const s of streams) {
    // Positive: stream already cleared target
    const primary = getStreamPrimary(s);
    if (primary && primary.target > 0 && primary.mtd >= primary.target) {
      const overshoot = Math.round((primary.mtd / primary.target) * 100);
      observations.push(`${s.name} has already cleared the monthly target (${overshoot}% of ${fmtRs(primary.target)}). Remaining days are pure upside -- protect margin and sustain pace.`);
    }

    const tw = s.thisWeek.revenue;
    const lw = s.lastWeek.revenue;
    if (lw > 0 && tw > 0) {
      const wow = ((tw - lw) / lw) * 100;
      if (wow < -10) {
        observations.push(`${s.name} weekly revenue fell ${Math.abs(Math.round(wow))}% vs prior week -- investigate operational or demand drivers.`);
      } else if (wow > 15) {
        observations.push(`${s.name} had a strong week, up ${Math.round(wow)}% vs prior -- identify what drove the lift and replicate.`);
      }
    }

    // Daily variance (latest day vs month average)
    if (s.daily.length >= 3) {
      const revs = s.daily.map(d => d.revenue || 0);
      const avg = revs.reduce((a, b) => a + b, 0) / revs.length;
      const worst = revs[revs.length - 1];
      if (avg > 0 && worst < avg * 0.6) {
        observations.push(`${s.name} latest day (${fmtRs(worst)}) is notably below the month's daily average (${fmtRs(avg)}) -- check for day-of-week or operational reasons.`);
      }
    }

    // Category RED — only when genuinely behind (mtd < target)
    const redCats = s.cards.filter(c => c.rag === 'RED' && c.category && c.mtd < c.target);
    for (const rc of redCats) {
      const need = Math.max(rc.requiredRate, 0);
      observations.push(`${s.name} -> ${rc.category} ${rc.label} behind target (${fmtValue(rc.mtd, rc.unit)} of ${fmtValue(rc.target, rc.unit)}); needs ${fmtValue(need, rc.unit)}/day to recover.`);
    }

    // Pharmacy margin comment
    const margin = s.cards.find(c => c.label === 'Gross Margin');
    const forecastMargin = margin?.target || 0;
    if (margin && forecastMargin > 0) {
      const delta = margin.mtd - forecastMargin;
      if (Math.abs(delta) >= 2) {
        observations.push(
          `${s.name} gross margin is ${margin.mtd}% vs ${forecastMargin}% forecast (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp) -- ${delta >= 0 ? 'mix or pricing is beating plan.' : 'mix, discounting, or COGS needs review.'}`
        );
      }
    }
  }

  // Combined projection comfort
  if (combined.targetRevenue > 0) {
    const combinedPct = (combined.projectedRevenue / combined.targetRevenue) * 100;
    if (combinedPct >= 100 && combinedPct < 110) {
      observations.push(`Combined projection is ${Math.round(combinedPct)}% of target -- slim cushion, small disruptions could break the plan.`);
    } else if (combinedPct >= 110 && combinedPct < 150) {
      observations.push(`Combined projection is ${Math.round(combinedPct)}% of target -- strong performance; consider reinvesting or raising internal stretch goals for the remainder.`);
    } else if (combinedPct >= 150) {
      observations.push(`Combined projection is ${Math.round(combinedPct)}% of target -- materially outperforming. Review whether the monthly target was set correctly and recalibrate future forecasts.`);
    }
  }

  if (observations.length === 0) {
    observations.push('All monitored KPIs are within normal bands; no anomalies detected this period.');
  }

  // ── Actions ─────────────────────────────────────
  const actionList: string[] = [];

  if (combined.targetRevenue > 0) {
    const combinedPct = (combined.projectedRevenue / combined.targetRevenue) * 100;
    if (combinedPct < 80) {
      const gap = combined.targetRevenue - combined.mtdRevenue;
      const dailyNeed = daysRemaining > 0 ? gap / daysRemaining : 0;
      actionList.push(
        `URGENT: Combined revenue projection is ${Math.round(combinedPct)}% of target. Close the ${fmtRs(gap)} gap by driving ${fmtRs(dailyNeed)}/day for the next ${daysRemaining} days.`
      );
    } else if (combinedPct < 95) {
      actionList.push(
        `Hold current pace and add targeted revenue initiatives (outbound, bundling, or pricing) to bridge the remaining gap.`
      );
    } else if (combinedPct >= 110) {
      actionList.push(
        `Projections are ${Math.round(combinedPct)}% of target. Sustain operational pace, monitor margin and service quality, and use the surplus to strengthen next month's pipeline.`
      );
    }
  }

  for (const s of streams) {
    const primary = getStreamPrimary(s);
    if (!primary || primary.target === 0) continue;

    // Only recommend "lift pace" when genuinely behind (mtd < target and required rate is positive).
    if (primary.rag === 'RED' && primary.mtd < primary.target && primary.requiredRate > 0) {
      actionList.push(
        `${s.name}: Lift daily pace from ${fmtRs(primary.dailyRate)} to ${fmtRs(primary.requiredRate)} -- review capacity, conversion, and demand levers this week.`
      );
    } else if (primary.mtd >= primary.target) {
      actionList.push(
        `${s.name}: Monthly target already cleared (${Math.round((primary.mtd / primary.target) * 100)}%). Maintain current pace, protect margin, and capture remaining days as upside.`
      );
    }

    // Category-level: only push recommendations for categories actually behind
    const cats = s.cards.filter(c => c.category && c.rag === 'RED' && c.mtd < c.target && c.requiredRate > 0);
    for (const c of cats) {
      actionList.push(`${s.name} -> ${c.category} ${c.label}: needs ${fmtValue(c.requiredRate, c.unit)}/day (currently ${fmtValue(c.dailyRate, c.unit)}) to close the ${fmtValue(c.target - c.mtd, c.unit)} gap.`);
    }
  }

  for (const a of actions) {
    if (a.severity === 'RED' || a.severity === 'AMBER') {
      // Backend message contains real ₹ glyphs and unicode dashes — sanitise
      // before adding so jsPDF wrap/measure doesn't break.
      const msg = safeText(a.message);
      if (!actionList.some(x => x.includes(msg))) {
        actionList.push(`${a.severity === 'RED' ? 'PRIORITY' : 'WATCH'}: ${msg}`);
      }
    }
  }

  if (actionList.length === 0) {
    actionList.push('All metrics tracking at or above target -- maintain current operational cadence and continue monitoring.');
  }

  return {
    executive: safeText(executive),
    streamInsights: streamInsights.map(safeText),
    observations: observations.map(safeText),
    actions: actionList.map(safeText),
    alerts: buildAlerts(data).map(safeText),
  };
}

/* ──────── Shared section builders (card-based layout) ──────── */

type WoWRow = { label: string; cur: string; prev: string; pct: number };

/** Initialise page chrome: grey bg + teal header + white panel below header. */
function drawFirstPageChrome(
  doc: jsPDF,
  title: string,
  subtitle: string,
  clientName: string,
  branchName: string,
  streamName: string,
  logo: LogoState | null,
): number {
  drawPageBg(doc);
  addHeader(doc, title, subtitle, clientName, branchName, streamName, logo);
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  drawCard(doc, 8, 40, pw - 16, ph - 54);
  return 48;
}

/** New page with just the white panel (no teal header repeat). */
function drawContinuationPage(doc: jsPDF): number {
  doc.addPage();
  drawPageBg(doc);
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  drawCard(doc, 8, 14, pw - 16, ph - 28);
  return 22;
}

/** Space-aware wrapper that uses drawContinuationPage for page breaks so
 *  the white panel always re-appears. Shadow-overrides ensureSpace locally. */
function ensureRoom(doc: jsPDF, y: number, needed: number): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y + needed > pageH - 22) return drawContinuationPage(doc);
  return y;
}

/** Executive summary block: title, RAG pill, narrative paragraph, combined progress. */
function drawExecutiveBlock(
  doc: jsPDF,
  data: InsightsData,
  narrative: InsightNarrative,
  y: number,
  x: number,
  w: number,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  drawCardTitle(doc, 'Executive Summary', x, y, PRIMARY);
  drawRAGPill(doc, data.combined.rag, pageW - 60, y, 46, 6.5);
  y += 8;

  y = addParagraph(doc, narrative.executive, y, { size: 10 });
  y += 8;

  if (data.combined.targetRevenue > 0) {
    const mtdPct = (data.combined.mtdRevenue / data.combined.targetRevenue) * 100;
    const projPct = (data.combined.projectedRevenue / data.combined.targetRevenue) * 100;
    const expectedPct = (data.daysElapsed / Math.max(data.daysInMonth, 1)) * 100;
    const barColor = paceColor(mtdPct, expectedPct);

    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK_TEXT);
    doc.text('Combined Revenue -- MTD vs Monthly Target', x, y);
    doc.setTextColor(...barColor);
    doc.text(`${Math.round(mtdPct)}% MTD`, x + w, y, { align: 'right' });
    y += 4;

    // Pace context line above the bar — clarifies what "MTD%" actually means
    doc.setFontSize(7.8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED_TEXT);
    doc.text(
      `Day ${data.daysElapsed} of ${data.daysInMonth} -- expected pace ~${Math.round(expectedPct)}%`,
      x, y
    );
    y += 4;

    drawProgressBar(doc, x, y, w, 7, mtdPct, projPct, barColor);
    y += 14;

    // Three-up label row: MTD | Projected | Target
    doc.setFontSize(8.8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED_TEXT);
    doc.text(`MTD: ${fmtRs(data.combined.mtdRevenue)}`, x, y);
    doc.text(
      `Projected: ${fmtRs(data.combined.projectedRevenue)} (${Math.round(projPct)}%)`,
      x + w / 2, y, { align: 'center' }
    );
    doc.text(`Target: ${fmtRs(data.combined.targetRevenue)}`, x + w, y, { align: 'right' });
    y += 7;

    const gap = data.combined.targetRevenue - data.combined.projectedRevenue;
    doc.setFontSize(8.8);
    doc.setFont('helvetica', 'bold');
    if (gap > 0) {
      const perDay = gap / Math.max(data.daysRemaining, 1);
      doc.setTextColor(...RED);
      doc.text(
        `Gap to target: ${fmtRs(gap)} -- needs ${fmtRs(perDay)}/day for ${data.daysRemaining} days`,
        x, y
      );
    } else {
      doc.setTextColor(...GREEN);
      doc.text(`Projected to clear target with ${fmtRs(Math.abs(gap))} cushion`, x, y);
    }
    y += 10;
  } else {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(...MUTED_TEXT);
    doc.text('No monthly target configured. Showing actuals only.', x, y);
    y += 10;
  }
  return y;
}

/** Scorecard rows: one per card with a numeric target. */
function computeScorecardRows(stream: StreamData) {
  return stream.cards
    .filter(c => c.target > 0 && c.unit !== 'percent')
    .map(c => {
      const mtdPct = (c.mtd / c.target) * 100;
      const projPct = (c.projected / c.target) * 100;
      return {
        label: c.category ? `${c.category} — ${c.label}` : c.label,
        mtd: fmtValue(c.mtd, c.unit),
        target: fmtValue(c.target, c.unit),
        projected: fmtValue(c.projected, c.unit),
        mtdPct, projPct,
      };
    });
}

/** Full stream section: title, narrative, scorecard, KPI bars, WoW table. */
function drawStreamSection(
  doc: jsPDF,
  stream: StreamData,
  idx: number,
  narrative: InsightNarrative,
  y: number,
  x: number,
  w: number,
  expectedPct: number = 100,
): number {
  const pageW = doc.internal.pageSize.getWidth();

  // Light divider above this section — with extra breathing room
  y += 2;
  doc.setDrawColor(...CARD_BORDER);
  doc.setLineWidth(0.2);
  doc.line(x, y - 3, x + w, y - 3);

  drawCardTitle(doc, stream.name.toUpperCase(), x, y, PRIMARY);
  y += 8;

  const narr = narrative.streamInsights[idx];
  if (narr) {
    y = addParagraph(doc, narr, y, { size: 9.5 });
    y += 6;
  }

  // ── Summary Scorecard ──
  y = ensureRoom(doc, y, 35);
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK_TEXT);
  doc.text('Summary Scorecard', x, y);
  y += 4;

  const rows = computeScorecardRows(stream);
  autoTable(doc, {
    startY: y,
    head: [['Metric', 'MTD', 'Target', 'Projected EOM', 'Status']],
    body: rows.map(r => [r.label, r.mtd, r.target, r.projected, '']),
    theme: 'grid',
    styles: { fontSize: 8.8, cellPadding: 2.3, lineColor: CARD_BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold', fontSize: 8.8 },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 52 },
      1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
      4: { halign: 'center', cellWidth: 34 },
    },
    didDrawCell: (hook) => {
      if (hook.section === 'body' && hook.column.index === 4) {
        const r = rows[hook.row.index];
        if (!r) return;
        const rag = pctToRAG(r.projPct);
        const label = rag === 'GREEN' ? 'ON TRACK' : rag === 'AMBER' ? 'WATCH' : 'BEHIND';
        drawStatusPill(doc, label, hook.cell.x + 3, hook.cell.y + hook.cell.height / 2 + 1.6);
      }
    },
    margin: { left: x, right: pageW - (x + w) },
  });
  y = (doc as any).lastAutoTable.finalY + 9;

  // ── KPI Progress Bars ──
  if (rows.length > 0) {
    y = ensureRoom(doc, y, 12 + rows.length * 9);
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK_TEXT);
    doc.text('KPI Progress (MTD vs Target)', x, y);
    y += 6;

    for (const r of rows) {
      y = ensureRoom(doc, y, 11);
      const color = paceColor(r.mtdPct, expectedPct);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...DARK_TEXT);
      doc.text(r.label, x, y);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...color);
      doc.text(`${Math.round(r.mtdPct)}%`, x + w, y, { align: 'right' });
      drawInlineBarPaced(doc, x, y + 1.2, w, r.mtdPct, expectedPct);
      y += 8.5;
    }
    y += 4;
  }

  // ── This Week vs Last Week ──
  y = ensureRoom(doc, y, 40);
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK_TEXT);
  doc.text('This Week vs Last Week', x, y);
  y += 4;

  const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');
  const tw = stream.thisWeek;
  const lw = stream.lastWeek;
  const wowRows: WoWRow[] = isClinic ? [
    { label: 'Patients', cur: fmtCount(tw.patients), prev: fmtCount(lw.patients), pct: lw.patients > 0 ? ((tw.patients - lw.patients) / lw.patients) * 100 : 0 },
    { label: 'Revenue',  cur: fmtRs(tw.revenue),    prev: fmtRs(lw.revenue),    pct: lw.revenue > 0 ? ((tw.revenue - lw.revenue) / lw.revenue) * 100 : 0 },
    { label: 'Avg Ticket', cur: fmtRs(tw.avgTicket), prev: fmtRs(lw.avgTicket), pct: lw.avgTicket > 0 ? ((tw.avgTicket - lw.avgTicket) / lw.avgTicket) * 100 : 0 },
  ] : [
    { label: 'Transactions', cur: fmtCount(tw.transactions), prev: fmtCount(lw.transactions), pct: lw.transactions > 0 ? ((tw.transactions - lw.transactions) / lw.transactions) * 100 : 0 },
    { label: 'Sales',  cur: fmtRs(tw.revenue), prev: fmtRs(lw.revenue), pct: lw.revenue > 0 ? ((tw.revenue - lw.revenue) / lw.revenue) * 100 : 0 },
    { label: 'Profit', cur: fmtRs(tw.profit),  prev: fmtRs(lw.profit),  pct: lw.profit !== 0 && lw.profit > 0 ? ((tw.profit - lw.profit) / lw.profit) * 100 : 0 },
    { label: 'Avg Ticket', cur: fmtRs(tw.avgTicket), prev: fmtRs(lw.avgTicket), pct: lw.avgTicket > 0 ? ((tw.avgTicket - lw.avgTicket) / lw.avgTicket) * 100 : 0 },
  ];

  autoTable(doc, {
    startY: y,
    head: [['Metric', 'This Week', 'Last Week', 'Change']],
    body: wowRows.map(r => {
      const sign = r.pct >= 0 ? '+' : '';
      return [r.label, r.cur, r.prev, `   ${sign}${r.pct.toFixed(1)}%`];
    }),
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 2.3, lineColor: CARD_BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold' },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 42 },
      1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right', cellWidth: 32 },
    },
    didParseCell: (cell) => {
      if (cell.section === 'body' && cell.column.index === 3) {
        const i = cell.row.index;
        const pct = wowRows[i]?.pct ?? 0;
        cell.cell.styles.textColor = pct >= 0 ? GREEN : RED;
        cell.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawCell: (hook) => {
      if (hook.section === 'body' && hook.column.index === 3) {
        const pct = wowRows[hook.row.index]?.pct ?? 0;
        drawWoWArrow(doc, hook.cell.x + 4, hook.cell.y + hook.cell.height / 2 + 0.5, pct);
      }
    },
    margin: { left: x, right: pageW - (x + w) },
  });
  y = (doc as any).lastAutoTable.finalY + 10;

  return y;
}

/** Key observations as a list of rows. */
function drawObservationsBlock(
  doc: jsPDF,
  observations: string[],
  y: number,
  x: number,
  w: number,
  title = 'Key Observations',
): number {
  y = ensureRoom(doc, y, 20);
  drawCardTitle(doc, title, x, y, PRIMARY);
  y += 8;

  const bulletX = x + 1.6;
  const textX = x + 5.4;
  const innerW = w - (textX - x);
  const lineH = 4.6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...DARK_TEXT);

  for (const obs of observations) {
    const lines = doc.splitTextToSize(safeText(obs), innerW);
    y = ensureRoom(doc, y, lines.length * lineH + 3);
    drawBullet(doc, bulletX, y, PRIMARY);
    for (let i = 0; i < lines.length; i++) {
      doc.text(lines[i], textX, y);
      y += lineH;
    }
    y += 2.5;
  }
  return y + 6;
}

/** Numbered action list with PRIORITY/WATCH prefix pills (no row restyle). */
function drawActionsBlock(
  doc: jsPDF,
  title: string,
  actions: string[],
  y: number,
  x: number,
  w: number,
): number {
  if (actions.length === 0) return y;
  y = ensureRoom(doc, y, 20);
  drawCardTitle(doc, title, x, y, PRIMARY);
  y += 8;

  const numW = 6;
  const pillW = 16;          // fixed pill width — keeps text aligned
  const gap = 2.5;
  const numX = x + 1.5;
  const pillX = numX + numW;
  const textX = pillX + pillW + gap;
  const innerW = w - (textX - x) - 1;
  const lineH = 4.7;
  const itemGap = 3.2;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);

  for (let i = 0; i < actions.length; i++) {
    const raw = safeText(actions[i]);
    let kind: 'PRIORITY' | 'WATCH' | null = null;
    let body = raw;
    const m = /^(PRIORITY|URGENT|WATCH):\s*(.*)$/.exec(raw);
    if (m) {
      kind = m[1] === 'WATCH' ? 'WATCH' : 'PRIORITY';
      body = m[2];
    }

    const lines = doc.splitTextToSize(body, innerW);
    const blockH = Math.max(lines.length * lineH, 5.4);
    y = ensureRoom(doc, y, blockH + itemGap);

    // Number
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...PRIMARY);
    doc.text(`${i + 1}.`, numX, y);

    // Pill (drawn even if no kind, for alignment — use neutral grey)
    const pillColor: [number, number, number] = kind === 'PRIORITY' ? RED : kind === 'WATCH' ? AMBER : [148, 163, 184];
    const pillLabel = kind === 'PRIORITY' ? 'PRIORITY' : kind === 'WATCH' ? 'WATCH' : 'NOTE';
    doc.setFillColor(...pillColor);
    doc.roundedRect(pillX, y - 3.4, pillW, 4.6, 1, 1, 'F');
    doc.setFontSize(7);
    doc.setTextColor(255, 255, 255);
    doc.text(pillLabel, pillX + pillW / 2, y - 0.3, { align: 'center' });

    // Body
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...DARK_TEXT);
    let ly = y;
    for (const ln of lines) {
      doc.text(ln, textX, ly);
      ly += lineH;
    }
    y += blockH + itemGap;
  }
  return y + 5;
}

/** Daily trend bar chart used by weekly + monthly reports. */
function drawDailyTrendBlock(
  doc: jsPDF,
  stream: StreamData,
  daysInMonth: number,
  y: number,
  x: number,
  w: number,
): number {
  if (stream.daily.length === 0) return y;
  y = ensureRoom(doc, y, 54);
  y += 2;

  const revs = stream.daily.map(d => d.revenue || 0);
  const peak = Math.max(...revs, 0);
  const avg = revs.length > 0 ? revs.reduce((a, b) => a + b, 0) / revs.length : 0;
  const primary = getStreamPrimary(stream);
  const dailyTarget = primary && primary.target > 0 ? primary.target / daysInMonth : 0;

  // Header row: title (left) + inline stats (right)
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...DARK_TEXT);
  doc.text(`${stream.name} — Daily Revenue Trend`, x, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED_TEXT);
  const statsTxt = `${stream.daily.length} days  |  Peak ${fmtRsCompact(peak)}  |  Avg ${fmtRsCompact(avg)}` +
    (dailyTarget > 0 ? `  |  Target ${fmtRsCompact(dailyTarget)}/day` : '');
  doc.text(statsTxt, x + w, y, { align: 'right' });
  y += 5;

  drawMiniBarChart(doc, x, y, w, 26, revs, PRIMARY, dailyTarget);
  y += 30;

  // X-axis dates (only at chart bounds)
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED_TEXT);
  doc.text(prettyDate(stream.daily[0].date), x + 14, y);
  doc.text(prettyDate(stream.daily[stream.daily.length - 1].date), x + w, y, { align: 'right' });

  return y + 10;
}

/* ──────── Daily PDF ──────── */

function generateDailyPDF(
  data: InsightsData,
  clientName: string,
  branchName: string,
  streamName: string,
  logo: LogoState | null,
) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const INNER_X = 14;
  const INNER_W = pageW - 28;

  const latestDate = data.streams.flatMap(s => s.daily.map(d => d.date)).sort().pop() || '';
  const prevDate   = data.streams.flatMap(s => s.daily.map(d => d.date)).filter(d => d < latestDate).sort().pop() || '';

  let y = drawFirstPageChrome(
    doc,
    'Daily Operational Insight',
    `${data.monthLabel}  |  Day ${data.daysElapsed} of ${data.daysInMonth}  |  ${data.daysRemaining} days remaining`,
    clientName,
    branchName,
    streamName,
    logo,
  );

  const narrative = buildNarrative(data, 'daily');

  // ── Executive summary (narrative + combined revenue progress) ──
  y = drawExecutiveBlock(doc, data, narrative, y, INNER_X, INNER_W);

  // ── Critical alerts callout ──
  if (narrative.alerts.length > 0) {
    y = ensureRoom(doc, y, 15 + narrative.alerts.length * 6);
    y = drawAlertBox(doc, INNER_X, y, INNER_W, narrative.alerts);
  }

  // ── Per-stream "today vs yesterday" + pace table ──
  for (const stream of data.streams) {
    y = ensureRoom(doc, y, 80);

    doc.setDrawColor(...CARD_BORDER);
    doc.setLineWidth(0.2);
    doc.line(INNER_X, y - 3, INNER_X + INNER_W, y - 3);

    drawCardTitle(doc, `${stream.name.toUpperCase()} — TODAY VS YESTERDAY`, INNER_X, y, PRIMARY);
    y += 5;

    const today     = latestDate ? stream.daily.find(d => d.date === latestDate) : null;
    const yesterday = prevDate   ? stream.daily.find(d => d.date === prevDate)   : null;
    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');

    const rows: WoWRow[] = isClinic ? [
      { label: 'Patients', cur: today ? fmtCount(today.patients || 0) : '--', prev: yesterday ? fmtCount(yesterday.patients || 0) : '--',
        pct: (yesterday && yesterday.patients) ? (((today?.patients || 0) - (yesterday.patients || 0)) / yesterday.patients) * 100 : 0 },
      { label: 'Revenue',  cur: today ? fmtRs(today.revenue || 0) : '--',    prev: yesterday ? fmtRs(yesterday.revenue || 0) : '--',
        pct: (yesterday && yesterday.revenue) ? (((today?.revenue || 0) - (yesterday.revenue || 0)) / yesterday.revenue) * 100 : 0 },
    ] : [
      { label: 'Transactions', cur: today ? fmtCount(today.transactions || 0) : '--', prev: yesterday ? fmtCount(yesterday.transactions || 0) : '--',
        pct: (yesterday && yesterday.transactions) ? (((today?.transactions || 0) - (yesterday.transactions || 0)) / yesterday.transactions) * 100 : 0 },
      { label: 'Sales',  cur: today ? fmtRs(today.revenue || 0) : '--', prev: yesterday ? fmtRs(yesterday.revenue || 0) : '--',
        pct: (yesterday && yesterday.revenue) ? (((today?.revenue || 0) - (yesterday.revenue || 0)) / yesterday.revenue) * 100 : 0 },
      { label: 'Profit', cur: today ? fmtRs(today.profit || 0) : '--', prev: yesterday ? fmtRs(yesterday.profit || 0) : '--',
        pct: (yesterday && yesterday.profit) ? (((today?.profit || 0) - (yesterday.profit || 0)) / yesterday.profit) * 100 : 0 },
    ];

    autoTable(doc, {
      startY: y,
      head: [['Metric', latestDate ? prettyDate(latestDate) : 'Latest', prevDate ? prettyDate(prevDate) : 'Previous', 'Change']],
      body: rows.map(r => {
        const sign = r.pct >= 0 ? '+' : '';
        return [r.label, r.cur, r.prev, r.prev === '--' ? '--' : `   ${sign}${r.pct.toFixed(1)}%`];
      }),
      theme: 'grid',
      styles: { fontSize: 9.2, cellPadding: 2.3, lineColor: CARD_BORDER, lineWidth: 0.1 },
      headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold', fontSize: 9 },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 38 },
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right', cellWidth: 30 },
      },
      didParseCell: (cell) => {
        if (cell.section === 'body' && cell.column.index === 3) {
          const txt = String(cell.cell.raw || '');
          if (txt.startsWith('+')) { cell.cell.styles.textColor = GREEN; cell.cell.styles.fontStyle = 'bold'; }
          else if (txt.startsWith('-')) { cell.cell.styles.textColor = RED; cell.cell.styles.fontStyle = 'bold'; }
        }
      },
      didDrawCell: (hook) => {
        if (hook.section === 'body' && hook.column.index === 3) {
          const r = rows[hook.row.index];
          if (r && r.prev !== '--') {
            drawWoWArrow(doc, hook.cell.x + 4, hook.cell.y + hook.cell.height / 2 + 0.5, r.pct);
          }
        }
      },
      margin: { left: INNER_X, right: pageW - (INNER_X + INNER_W) },
    });
    y = (doc as any).lastAutoTable.finalY + 5;

    // Pace table: KPI | MTD | Target | Status
    const paceCards = stream.cards.filter(c => c.target > 0 && c.unit !== 'percent');
    if (paceCards.length > 0) {
      y = ensureRoom(doc, y, 20 + paceCards.length * 7);
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...DARK_TEXT);
      doc.text('Pace to Monthly Target', INNER_X, y);
      y += 2;

      const paceRows = paceCards.map(card => {
        const dailyTarget = Math.round(card.target / data.daysInMonth);
        const aheadMtd = card.mtd >= card.target;
        const onPace = card.requiredRate <= card.dailyRate;
        const status = aheadMtd ? 'EXCEEDED' : onPace ? 'ON PACE' : 'BEHIND';
        return {
          label: card.category ? `${card.category} — ${card.label}` : card.label,
          mtd: fmtValue(card.mtd, card.unit),
          target: fmtValue(card.target, card.unit),
          dailyTarget: fmtValue(dailyTarget, card.unit),
          actualDay: fmtValue(card.dailyRate, card.unit),
          required: aheadMtd ? '—' : fmtValue(Math.max(card.requiredRate, 0), card.unit),
          status,
        };
      });

      autoTable(doc, {
        startY: y,
        head: [['KPI', 'MTD', 'Goal', 'Day Tgt', 'Actual/day', 'Needed/day', 'Status']],
        body: paceRows.map(r => [r.label, r.mtd, r.target, r.dailyTarget, r.actualDay, r.required, '']),
        theme: 'grid',
        styles: { fontSize: 8.5, cellPadding: 2, lineColor: CARD_BORDER, lineWidth: 0.1 },
        headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold', fontSize: 8.5 },
        columnStyles: {
          0: { fontStyle: 'bold', cellWidth: 40 },
          1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
          4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'center', cellWidth: 26 },
        },
        didDrawCell: (hook) => {
          if (hook.section === 'body' && hook.column.index === 6) {
            const r = paceRows[hook.row.index];
            if (r) drawStatusPill(doc, r.status, hook.cell.x + 2, hook.cell.y + hook.cell.height / 2 + 1.6);
          }
        },
        margin: { left: INNER_X, right: pageW - (INNER_X + INNER_W) },
      });
      y = (doc as any).lastAutoTable.finalY + 6;
    }
  }

  // ── Observations ──
  if (narrative.observations.length > 0) {
    y = drawObservationsBlock(doc, narrative.observations.slice(0, 6), y, INNER_X, INNER_W, 'Key Observations');
  }

  // ── Actions ──
  y = drawActionsBlock(doc, "Today's Actions", narrative.actions, y, INNER_X, INNER_W);

  addFooter(doc, footerLabel('Daily Insight', data.monthLabel, clientName, branchName, streamName));
  doc.save(filename('Daily_Insight', data.month, branchName, latestDate || 'today'));
}

/* ──────── Weekly PDF ──────── */

function generateWeeklyPDF(
  data: InsightsData,
  clientName: string,
  branchName: string,
  streamName: string,
  logo: LogoState | null,
) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const INNER_X = 14;
  const INNER_W = pageW - 28;
  const expectedPct = (data.daysElapsed / Math.max(data.daysInMonth, 1)) * 100;

  let y = drawFirstPageChrome(
    doc,
    'Weekly Operational Insight',
    `${data.monthLabel}  |  Day ${data.daysElapsed} of ${data.daysInMonth}  |  ${data.daysRemaining} days remaining`,
    clientName,
    branchName,
    streamName,
    logo,
  );

  const narrative = buildNarrative(data, 'weekly');

  // ── Executive summary ──
  y = drawExecutiveBlock(doc, data, narrative, y, INNER_X, INNER_W);

  // ── Critical alerts callout ──
  if (narrative.alerts.length > 0) {
    y = ensureRoom(doc, y, 15 + narrative.alerts.length * 6);
    y = drawAlertBox(doc, INNER_X, y, INNER_W, narrative.alerts);
  }

  // ── Per-stream section: scorecard + KPI bars + WoW + daily trend ──
  for (let idx = 0; idx < data.streams.length; idx++) {
    const stream = data.streams[idx];
    y = ensureRoom(doc, y, 100);
    y = drawStreamSection(doc, stream, idx, narrative, y, INNER_X, INNER_W, expectedPct);
    y = drawDailyTrendBlock(doc, stream, data.daysInMonth, y, INNER_X, INNER_W);
  }

  // ── Observations ──
  if (narrative.observations.length > 0) {
    y = drawObservationsBlock(doc, narrative.observations, y, INNER_X, INNER_W, 'Weekly Observations');
  }

  // ── Actions ──
  y = drawActionsBlock(doc, 'Focus Areas for Next Week', narrative.actions, y, INNER_X, INNER_W);

  addFooter(doc, footerLabel('Weekly Insight', data.monthLabel, clientName, branchName, streamName));
  doc.save(filename('Weekly_Insight', data.month, branchName));
}

/* ──────── Monthly PDF ──────── */

function generateMonthlyPDF(
  data: InsightsData,
  clientName: string,
  branchName: string,
  streamName: string,
  logo: LogoState | null,
) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const INNER_X = 14;
  const INNER_W = pageW - 28;
  const expectedPct = (data.daysElapsed / Math.max(data.daysInMonth, 1)) * 100;

  let y = drawFirstPageChrome(
    doc,
    'Monthly / MTD Operational Insight',
    `${data.monthLabel}  |  Day ${data.daysElapsed} of ${data.daysInMonth}  |  ${data.daysRemaining} days remaining`,
    clientName,
    branchName,
    streamName,
    logo,
  );

  const narrative = buildNarrative(data, 'monthly');

  // ── Executive summary ──
  y = drawExecutiveBlock(doc, data, narrative, y, INNER_X, INNER_W);

  // ── Critical alerts callout (WoW drops, margin gaps, big misses) ──
  if (narrative.alerts.length > 0) {
    y = ensureRoom(doc, y, 15 + narrative.alerts.length * 6);
    y = drawAlertBox(doc, INNER_X, y, INNER_W, narrative.alerts);
  }

  // ── Per-stream section: scorecard + KPI progress bars + WoW + daily trend ──
  for (let idx = 0; idx < data.streams.length; idx++) {
    const stream = data.streams[idx];
    y = ensureRoom(doc, y, 100);
    y = drawStreamSection(doc, stream, idx, narrative, y, INNER_X, INNER_W, expectedPct);
    y = drawDailyTrendBlock(doc, stream, data.daysInMonth, y, INNER_X, INNER_W);
  }

  // ── Key Observations ──
  if (narrative.observations.length > 0) {
    y = drawObservationsBlock(doc, narrative.observations, y, INNER_X, INNER_W, 'Key Observations & Insights');
  }

  // ── Management Actions ──
  y = drawActionsBlock(doc, 'Management Actions to Achieve Monthly Target', narrative.actions, y, INNER_X, INNER_W);

  addFooter(doc, footerLabel('Monthly Insight', data.monthLabel, clientName, branchName, streamName));
  doc.save(filename('Monthly_Insight', data.month, branchName));
}

/* ──────── Component ──────── */

export default function InsightDownloadPanel({
  open, onClose, data,
  clientName = '', branchName = '', streamName = '',
}: Props) {
  const [variant, setVariant] = useState<ReportVariant>('monthly');
  const [generating, setGenerating] = useState(false);
  const [logo, setLogo] = useState<LogoState | null>(null);

  // Load the client logo when the panel opens. The logo lives at
  // `/api/logos/clients/{slug}.{ext}` (same pattern Sidebar uses) — we try a
  // handful of common extensions, the first one that 200s wins.
  //
  // We render the image to an offscreen <canvas> and serialise it as PNG
  // before passing to jspdf. Two reasons:
  //   1. jspdf's addImage doesn't natively understand SVG; rasterising via
  //      canvas converts it for free (the browser handles the vector → bitmap
  //      step).
  //   2. Some clients upload JPEG / WEBP and listing every encoder in jspdf
  //      is fiddly. Normalising to PNG keeps the PDF code path uniform.
  //
  // If no logo is found we leave `logo` as null and the header collapses
  // gracefully to its text-only layout.
  useEffect(() => {
    if (!open) return;
    const slug = typeof window !== 'undefined' ? localStorage.getItem('client_slug') : null;
    if (!slug) return;

    let cancelled = false;
    (async () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'svg']) {
        const url = `/api/logos/clients/${slug}.${ext}`;
        try {
          const head = await fetch(url, { method: 'HEAD' });
          if (!head.ok) continue;

          const img = new Image();
          img.crossOrigin = 'anonymous';
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = (e) => reject(e);
            img.src = url;
          });

          const w = img.naturalWidth || img.width || 256;
          const h = img.naturalHeight || img.height || 256;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/png');
          if (!cancelled) setLogo({ dataUrl, aspect: w / h });
          return;
        } catch {
          // try next extension
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const handleDownload = async () => {
    setGenerating(true);
    try {
      if (variant === 'daily') generateDailyPDF(data, clientName, branchName, streamName, logo);
      else if (variant === 'weekly') generateWeeklyPDF(data, clientName, branchName, streamName, logo);
      else generateMonthlyPDF(data, clientName, branchName, streamName, logo);
      setTimeout(() => { setGenerating(false); onClose(); }, 400);
    } catch (err) {
      console.error('PDF generation error:', err);
      alert('Failed to generate insight report. Please try again.');
      setGenerating(false);
    }
  };

  if (!open) return null;

  const options: { key: ReportVariant; label: string; sub: string; icon: typeof Calendar }[] = [
    { key: 'daily', label: 'Daily Insight', sub: "Today vs yesterday — pace, gaps, and immediate actions", icon: Calendar },
    { key: 'weekly', label: 'Weekly Insight', sub: 'This week vs last week, WoW trends, focus areas', icon: CalendarDays },
    { key: 'monthly', label: 'Monthly / MTD Insight', sub: 'Full MTD performance with visuals, narrative, and management actions', icon: CalendarRange },
  ];

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full max-w-md bg-dark-700 shadow-2xl z-50 flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-400/50 bg-dark-600">
          <div className="flex items-center gap-3">
            <Download size={20} className="text-accent-400" />
            <h2 className="text-lg font-bold text-theme-heading">Download Insight</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-dark-400 rounded-lg transition-colors" title="Close panel" aria-label="Close panel">
            <X size={18} className="text-theme-faint" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-theme-secondary mb-1">Report Type</h3>
            <p className="text-xs text-theme-faint mb-3">
              Choose the time window. Each report includes a written executive summary, charts, KPI tables, and recommended actions.
            </p>
            <div className="space-y-2">
              {options.map(opt => {
                const Icon = opt.icon;
                const selected = variant === opt.key;
                return (
                  <label key={opt.key} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selected ? 'border-accent-500 bg-accent-500/10' : 'border-dark-400/50 hover:bg-dark-600'
                  }`}>
                    <input type="radio" name="insightVariant" checked={selected} onChange={() => setVariant(opt.key)} className="mt-1 text-accent-400 focus:ring-primary-500" />
                    <Icon size={18} className={`mt-0.5 shrink-0 ${selected ? 'text-accent-400' : 'text-theme-muted'}`} />
                    <div>
                      <p className={`text-sm font-medium ${selected ? 'text-accent-300' : 'text-theme-heading'}`}>{opt.label}</p>
                      <p className="text-xs text-theme-faint mt-0.5">{opt.sub}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border border-dark-400/50 bg-dark-600/40 p-3">
            <p className="text-xs text-theme-muted mb-1.5 font-semibold uppercase tracking-wider">Report will include</p>
            {variant === 'daily' && (
              <ul className="text-xs text-theme-secondary space-y-1 list-disc ml-4">
                <li>Written executive summary of today's performance</li>
                <li>Combined revenue progress bar + RAG status</li>
                <li>Today vs yesterday snapshot and pace table per stream</li>
                <li>Key observations and prioritised action items</li>
              </ul>
            )}
            {variant === 'weekly' && (
              <ul className="text-xs text-theme-secondary space-y-1 list-disc ml-4">
                <li>Written executive summary of the week</li>
                <li>This week vs last week comparison bars and tables</li>
                <li>Daily revenue trend chart with target line per stream</li>
                <li>Observations and focus areas for next week</li>
              </ul>
            )}
            {variant === 'monthly' && (
              <ul className="text-xs text-theme-secondary space-y-1 list-disc ml-4">
                <li>Written executive summary with RAG status</li>
                <li>Combined revenue progress bar + MTD/Target/Projected/Gap</li>
                <li>Per-KPI target progress bars and daily revenue charts</li>
                <li>Per-stream narrative, WoW, observations, and management actions</li>
              </ul>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-dark-400/50 bg-dark-600">
          <button onClick={handleDownload} disabled={generating} className="w-full btn-primary flex items-center justify-center gap-2 py-3 disabled:opacity-50 disabled:cursor-not-allowed">
            {generating ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Download size={18} />
                Download {variant === 'daily' ? 'Daily' : variant === 'weekly' ? 'Weekly' : 'Monthly'} Insight (PDF)
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}
