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
  /** The location label shown beneath the logo in the report header,
   *  e.g. "BTM Layout". */
  branchName?: string;
  /** State the branch is in, e.g. "Karnataka". Rendered on its own line
   *  below the branch name in muted text. */
  branchState?: string;
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

/** Compact rupee for KPI strips and inline narrative.
 *  Lakh shorthand kicks in at >= 1,00,000 — below that we keep full digits
 *  so a small "Rs. 84,000" reads naturally and the eye doesn't have to
 *  decode an unnecessary K/L abbreviation. */
function fmtRsLakh(n: number): string {
  const abs = Math.abs(Math.round(n));
  const sign = n < 0 ? '-' : '';
  if (abs < 100_000) return 'Rs. ' + indianNumber(n);
  if (abs < 10_000_000) {
    const v = abs / 100_000;
    return sign + 'Rs. ' + (v < 10 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toFixed(1).replace(/\.?0+$/, '')) + 'L';
  }
  const v = abs / 10_000_000;
  return sign + 'Rs. ' + (v < 10 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toFixed(1).replace(/\.?0+$/, '')) + 'Cr';
}

/** Signed % with arrow prefix. Returns label + colour token (caller sets it). */
function fmtChange(cur: number, prev: number): { label: string; positive: boolean | null } {
  if (!prev || !isFinite(prev)) return { label: '--', positive: null };
  const delta = ((cur - prev) / prev) * 100;
  const sign = delta >= 0 ? '+' : '';
  return { label: `${sign}${delta.toFixed(1)}%`, positive: delta >= 0 };
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
 *  client + branch + state so a printed copy is unambiguous about which
 *  organisation and location it pertains to. */
function footerLabel(
  reportType: string,
  monthLabel: string,
  clientName: string,
  branchName: string,
  branchState: string,
): string {
  const parts: string[] = [reportType, monthLabel];
  if (clientName) parts.push(clientName);
  if (branchName && branchState) parts.push(`${branchName}, ${branchState}`);
  else if (branchName) parts.push(branchName);
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

/* ──────── Redesign palette (May 2026) ────────
 *
 * The Operational Insight PDF redesign brief locks in a specific
 * design-token palette so all three reports (Daily / Weekly / Monthly)
 * share a consistent visual language. These tokens map to the brief's
 * hex values verbatim and are kept separate from the legacy palette
 * above so existing helpers continue to work unchanged. */

// Headline / accent
const HEAD_GREEN: [number, number, number]    = [4, 52, 44];     // #04342C
const TEXT_DARK: [number, number, number]     = [44, 44, 42];    // #2C2C2A
const TEXT_SECONDARY: [number, number, number]= [95, 94, 90];    // #5F5E5A
const TEXT_TERTIARY: [number, number, number] = [136, 135, 128]; // #888780
const TEXT_FAINT: [number, number, number]    = [180, 178, 169]; // #B4B2A9
const SURFACE: [number, number, number]       = [250, 250, 247]; // #FAFAF7
const HAIRLINE: [number, number, number]      = [241, 239, 232]; // #F1EFE8

// Status — on track / pace
const STATUS_GREEN_BORDER: [number, number, number] = [29, 158, 117]; // #1D9E75
const STATUS_GREEN_BG:     [number, number, number] = [225, 245, 238];// #E1F5EE
const STATUS_GREEN_HEAD:   [number, number, number] = [4, 52, 44];    // #04342C
const STATUS_GREEN_BODY:   [number, number, number] = [15, 110, 86];  // #0F6E56
const PILL_GREEN_BG:       [number, number, number] = [234, 243, 222];// #EAF3DE
const PILL_GREEN_TEXT:     [number, number, number] = [23, 52, 4];    // #173404

// Status — behind / watch
const STATUS_AMBER_BORDER: [number, number, number] = [186, 117, 23]; // #BA7517
const STATUS_AMBER_BG:     [number, number, number] = [250, 238, 218];// #FAEEDA
const STATUS_AMBER_HEAD:   [number, number, number] = [65, 36, 2];    // #412402
const STATUS_AMBER_BODY:   [number, number, number] = [133, 79, 11];  // #854F0B
const PILL_AMBER_BG:       [number, number, number] = [250, 238, 218];// #FAEEDA
const PILL_AMBER_TEXT:     [number, number, number] = [65, 36, 2];    // #412402

// Status — at risk
const STATUS_RED_BORDER: [number, number, number] = [163, 45, 45]; // #A32D2D
const STATUS_RED_BG:     [number, number, number] = [252, 235, 235];// #FCEBEB
const STATUS_RED_HEAD:   [number, number, number] = [80, 19, 19];   // #501313
const STATUS_RED_BODY:   [number, number, number] = [163, 45, 45];  // #A32D2D
const PILL_RED_BG:       [number, number, number] = [252, 235, 235];// #FCEBEB
const PILL_RED_TEXT:     [number, number, number] = [80, 19, 19];   // #501313

// KPI strip border accents (cycle through on the 4-card row)
const KPI_BORDERS: [number, number, number][] = [
  [29, 158, 117],  // green  #1D9E75
  [24, 95, 165],   // blue   #185FA5
  [163, 45, 45],   // red    #A32D2D
  [186, 117, 23],  // amber  #BA7517
  [83, 74, 183],   // purple #534AB7
];

// Section-bar theme colours
const SECTION_RED:    [number, number, number] = [163, 45, 45];  // status / alerts
const SECTION_BLUE:   [number, number, number] = [24, 95, 165];  // pace / trends
const SECTION_AMBER:  [number, number, number] = [186, 117, 23]; // actions
const SECTION_PURPLE: [number, number, number] = [83, 74, 183];  // cross-tab

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

/** Header layout constants. The teal bar's height is bumped to 42mm to
 *  give the logo + branch info comfortable vertical breathing room — this
 *  shifts the white card down by 6mm relative to the old 34mm bar. */
const HEADER_BAR_H = 42;
const HEADER_BORDER_H = 2;
const HEADER_TOTAL_H = HEADER_BAR_H + HEADER_BORDER_H;  // 44mm
const CARD_TOP_AFTER_HEADER = HEADER_TOTAL_H + 4;       // 48mm — first row of card content
const FIRST_CONTENT_Y = HEADER_TOTAL_H + 12;            // 56mm — y returned to caller

/** Draw the teal title bar that crowns every report's first page.
 *
 *  Layout, left ↔ right:
 *    • LEFT — title (bold), subtitle (regular), generated-at timestamp (faint)
 *    • RIGHT — logo box (when present), then branch name + state stacked
 *      beneath. If no logo is configured, the company name sits at the top
 *      of the right rail in its place so the bar never feels lopsided.
 *
 *  Logo sizing is bounding-box based: we fit the image inside a
 *  `LOGO_MAX_W × LOGO_MAX_H` rectangle while preserving aspect ratio, so a
 *  square logo, a tall logo, and a wide logo all render without distortion.
 *  The previous fixed-height approach stretched square logos when the
 *  reported aspect ratio was off.
 */
function addHeader(
  doc: jsPDF,
  title: string,
  subtitle: string,
  clientName: string,
  branchName: string,
  branchState: string,
  logo: LogoState | null,
) {
  const pageW = doc.internal.pageSize.getWidth();
  const RIGHT_X = pageW - 14;

  // Backdrop — teal bar + thin darker stripe just below
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pageW, HEADER_BAR_H, 'F');
  doc.setFillColor(...PRIMARY_DARK);
  doc.rect(0, HEADER_BAR_H, pageW, HEADER_BORDER_H, 'F');

  // ── RIGHT side: logo (or company name) + branch info ─────────────────
  // Track where the right-side branch text should start vertically.
  // When a logo is present, branch info sits below it; when there's no
  // logo, we promote the company name into the logo's slot.
  let rightTextY = 14;

  if (logo && logo.dataUrl) {
    const LOGO_MAX_W = 38;
    const LOGO_MAX_H = 22;
    const aspect = logo.aspect && isFinite(logo.aspect) && logo.aspect > 0 ? logo.aspect : 1;

    // Fit inside the bounding box, preserving aspect.
    let logoW: number, logoH: number;
    if (aspect >= LOGO_MAX_W / LOGO_MAX_H) {
      // Wider than the box — width is the binding constraint
      logoW = LOGO_MAX_W;
      logoH = LOGO_MAX_W / aspect;
    } else {
      // Taller than the box — height is the binding constraint
      logoH = LOGO_MAX_H;
      logoW = LOGO_MAX_H * aspect;
    }

    const logoX = RIGHT_X - logoW;
    const logoY = 5;
    try {
      doc.addImage(logo.dataUrl, 'PNG', logoX, logoY, logoW, logoH, undefined, 'FAST');
      rightTextY = logoY + logoH + 5;  // 5mm gap below the logo
    } catch {
      // Fall back to text-only on the right rail
      rightTextY = 14;
    }
  } else if (clientName) {
    // No logo → company name takes the prominent slot
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text(safeText(clientName), RIGHT_X, 14, { align: 'right' });
    rightTextY = 22;
  }

  // Branch name (bold) + state (regular, slightly muted) stacked
  if (branchName) {
    doc.setFontSize(10.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text(safeText(branchName), RIGHT_X, rightTextY, { align: 'right' });
  }
  if (branchState) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    // Muted teal-on-teal — keeps the hierarchy clear without harsh contrast
    doc.setTextColor(216, 240, 232);
    doc.text(safeText(branchState), RIGHT_X, rightTextY + 5.5, { align: 'right' });
  }

  // ── LEFT side: title, subtitle, generated timestamp ──────────────────
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(19);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 14, 16);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(subtitle, 14, 25);

  // Generated timestamp moves to the left side now that the right rail is
  // logo + branch only. Sits low in the bar in a faded teal-on-teal.
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(216, 240, 232);
  doc.text(
    `Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`,
    14, 35
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

  // Newsletter-voice addendum: every page footer carries the report
  // identity on the left and a subtle "Powered by indefine. · Page N
  // of M" co-branding strip on the right. The Indefine logo image is
  // deferred to a follow-up (see INSIGHT_PDF_BACKEND.md §5a) — for
  // now the wordmark renders as plain text with a small red period
  // accent matching the brief's brand callout.
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);

    // Left: report info
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...TEXT_TERTIARY);
    doc.text(safeText(label), 14, pageH - 8);

    // Right (assembled right-to-left): page number, then wordmark, then
    // "Powered by". jsPDF doesn't lay out flex rows so we compute the
    // x-coordinates from getTextWidth() and walk leftward.
    const pageLabel = `Page ${p} of ${n}`;
    doc.setFontSize(7.5);
    doc.setTextColor(...TEXT_FAINT);
    doc.text(pageLabel, pageW - 14, pageH - 8, { align: 'right' });
    const pageLabelW = doc.getTextWidth(pageLabel);

    // "indefine." wordmark — lowercase brand text + red period accent.
    // The period sits flush after the "e" so the eye reads it as part
    // of the wordmark, not a sentence terminator.
    const wordmarkX = pageW - 14 - pageLabelW - 6;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    const dotW = doc.getTextWidth('.');
    doc.setTextColor(...TEXT_DARK);
    doc.text('indefine', wordmarkX - dotW, pageH - 8, { align: 'right' });
    const indefineW = doc.getTextWidth('indefine');
    doc.setTextColor(...STATUS_RED_BORDER);
    doc.text('.', wordmarkX, pageH - 8, { align: 'right' });

    // "Powered by" lead-in
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...TEXT_FAINT);
    doc.text('Powered by', wordmarkX - dotW - indefineW - 4, pageH - 8, { align: 'right' });
  }
}

/* ──────── Redesign primitives (May 2026) ────────
 *
 * Reusable building blocks for the redesigned Daily / Weekly / Monthly
 * templates. They map 1:1 to the visual specs in the brief: outline
 * header, sentence-form hero status block, 4-card KPI strip with
 * coloured left borders, vertical-bar section headers, 3-state status
 * pills, sparkline charts, callout cards. */

const PAGE_INNER_X = 18;       // 18mm side margins per brief
const PAGE_TOP     = 16;       // 16mm top margin

/** Status verdict computed from projected period-end attainment.
 *  Daily reports use the projection so day 2 of 31 doesn't read as
 *  "BEHIND TARGET" alarmism. Weekly and monthly use the same logic
 *  but their projection should equal final attainment when the period
 *  is closed. */
type StatusBand = 'on_track' | 'on_pace' | 'behind' | 'behind_target' | 'at_risk';
function statusFromProjection(projectedPct: number): StatusBand {
  if (!isFinite(projectedPct)) return 'at_risk';
  if (projectedPct >= 100) return 'on_track';
  if (projectedPct >= 90)  return 'on_pace';
  if (projectedPct >= 75)  return 'behind';
  if (projectedPct >= 60)  return 'behind_target';
  return 'at_risk';
}

/** Map a status band to its 4-colour theme used by the hero block,
 *  status pill, and any inline callout that wants to align with it. */
function statusTheme(band: StatusBand) {
  if (band === 'on_track' || band === 'on_pace') {
    return {
      border: STATUS_GREEN_BORDER, bg: STATUS_GREEN_BG,
      head: STATUS_GREEN_HEAD, body: STATUS_GREEN_BODY,
      pillBg: PILL_GREEN_BG, pillText: PILL_GREEN_TEXT,
      label: band === 'on_track' ? 'On track' : 'On pace',
    };
  }
  if (band === 'behind' || band === 'behind_target') {
    return {
      border: STATUS_AMBER_BORDER, bg: STATUS_AMBER_BG,
      head: STATUS_AMBER_HEAD, body: STATUS_AMBER_BODY,
      pillBg: PILL_AMBER_BG, pillText: PILL_AMBER_TEXT,
      label: band === 'behind' ? 'Behind' : 'Behind target',
    };
  }
  return {
    border: STATUS_RED_BORDER, bg: STATUS_RED_BG,
    head: STATUS_RED_HEAD, body: STATUS_RED_BODY,
    pillBg: PILL_RED_BG, pillText: PILL_RED_TEXT,
    label: 'At risk',
  };
}

/** Compose the hero block headline as a complete sentence using
 *  newsletter voice — "you" / "your" framing, never status codes.
 *  The brief is firm: every headline must read like the opening line
 *  of a letter to the doctor / pharmacy owner, not a database row. */
function composeStatusHeadline(
  kind: 'daily' | 'weekly' | 'monthly_mtd' | 'monthly_final',
  projectedPct: number,
  band: StatusBand,
  options: { topStream?: string; weakStream?: string; wow?: number; period?: string },
): string {
  const pct = Math.round(projectedPct);
  if (kind === 'daily') {
    if (band === 'on_track')      return `You're on track -- projected to finish at ${pct}% of target`;
    if (band === 'on_pace')       return `You're on pace -- projected to finish at ${pct}% of target`;
    if (band === 'behind')        return `You're behind the early-month pace -- projected at ${pct}% of target`;
    if (band === 'behind_target') return `You're behind target -- projected to finish at ${pct}% of target`;
    return `You're materially behind -- projected at ${pct}% of target if today's pace holds`;
  }
  if (kind === 'weekly') {
    const w = options.wow;
    if (w == null) return `Your week revenue is at ${pct}% of target`;
    if (w >= 10)        return `Your revenue is up ${w.toFixed(0)}% week-on-week -- strong momentum`;
    if (w >= 0)         return `Steady week -- you're up ${w.toFixed(1)}% vs last`;
    if (w >= -10)       return `Revenue dipped ${Math.abs(w).toFixed(1)}% this week -- watch for next-week recovery`;
    return `You're down ${Math.abs(w).toFixed(0)}% week-on-week -- worth investigating`;
  }
  const period = options.period || 'the month';
  if (kind === 'monthly_final') {
    if (pct >= 110) return `You closed ${period} at ${pct}% of target -- ${options.topStream || 'pharmacy'} drove the surplus`;
    if (pct >= 95)  return `You met ${period}'s target at ${pct}% -- solid finish`;
    if (pct >= 80)  return `You closed ${period} at ${pct}% of target -- ${options.weakStream || 'clinic'} pulled the average down`;
    return `You closed ${period} at ${pct}% of target -- a recovery plan is needed`;
  }
  // monthly_mtd
  if (band === 'on_track')      return `You're on track for ${period} -- projected to finish at ${pct}% of target`;
  if (band === 'on_pace')       return `You're on pace -- projected to finish at ${pct}% of target`;
  if (band === 'behind')        return `You're behind the early-month pace -- projected at ${pct}% of target`;
  if (band === 'behind_target') return `You're behind target -- projected at ${pct}% of target`;
  return `You're materially behind -- projected at ${pct}% of target if today's pace holds`;
}

/** Outline header per brief: dark green title under a 3px green underline,
 *  no banner fill. Replaces the previous teal-bar treatment. The org/branch
 *  block sits on the right. Returns the y after the underline. */
function drawOutlineHeader(
  doc: jsPDF,
  label: string,        // e.g. "DAILY OPERATIONAL INSIGHT"
  primaryDate: string,  // e.g. "2 May 2026"
  subtitle: string,     // e.g. "Day 2 of 31 - 29 days remaining"
  clientName: string,
  branchName: string,
  branchState: string,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const RIGHT_X = pageW - PAGE_INNER_X;

  const labelY    = PAGE_TOP + 4;
  const titleY    = PAGE_TOP + 13;
  const subtitleY = PAGE_TOP + 21;
  const ruleY     = PAGE_TOP + 28;

  // Left side
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_TERTIARY);
  doc.text(safeText(label), PAGE_INNER_X, labelY, { charSpace: 0.6 });

  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...HEAD_GREEN);
  doc.text(safeText(primaryDate), PAGE_INNER_X, titleY);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...TEXT_SECONDARY);
  doc.text(safeText(subtitle), PAGE_INNER_X, subtitleY);

  // Right side — org / branch / generated-at
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_SECONDARY);
  if (clientName) doc.text(safeText(clientName), RIGHT_X, labelY + 3, { align: 'right' });

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...TEXT_TERTIARY);
  const locParts = [branchName, branchState].filter(Boolean).join(', ');
  if (locParts) doc.text(safeText(locParts), RIGHT_X, labelY + 9, { align: 'right' });

  doc.setFontSize(7.5);
  doc.setTextColor(...TEXT_FAINT);
  const gen = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  doc.text(`Generated ${gen}`, RIGHT_X, labelY + 14, { align: 'right' });

  // 3px (~1mm) dark-green underline
  doc.setDrawColor(...HEAD_GREEN);
  doc.setLineWidth(1);
  doc.line(PAGE_INNER_X, ruleY, pageW - PAGE_INNER_X, ruleY);
  doc.setLineWidth(0.2);

  return ruleY + 8;
}

/** Hero status block — left-border accent, tinted bg, sentence headline.
 *  `metaRight` is the small text on the top-right (e.g. "Update at 6 PM"). */
function drawHeroStatus(
  doc: jsPDF,
  x: number, y: number, w: number,
  topLabel: string,        // "STATUS - DAY 2"
  metaRight: string,       // "Update at 6 PM today"
  headline: string,        // sentence form
  body: string,            // 1-2 sentences
  band: StatusBand,
): number {
  const t = statusTheme(band);
  const padX = 10;
  const padY = 7;

  // Wrap body up front so we know the box height
  doc.setFontSize(9.5);
  const bodyLines = doc.splitTextToSize(safeText(body), w - padX * 2);

  doc.setFontSize(15);
  const headLines = doc.splitTextToSize(safeText(headline), w - padX * 2);

  const labelH = 5;
  const headH  = headLines.length * 5.6;
  const bodyH  = bodyLines.length * 4.4;
  const h = padY + labelH + 3 + headH + 3 + bodyH + padY;

  // Bg
  doc.setFillColor(...t.bg);
  doc.roundedRect(x, y, w, h, 2, 2, 'F');
  // Left border
  doc.setFillColor(...t.border);
  doc.rect(x, y, 1.4, h, 'F');

  // Top row: label (left) + meta (right)
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...t.body);
  doc.text(safeText(topLabel), x + padX, y + padY + labelH - 1, { charSpace: 0.7 });

  if (metaRight) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(safeText(metaRight), x + w - padX, y + padY + labelH - 1, { align: 'right' });
  }

  // Headline
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...t.head);
  doc.text(headLines, x + padX, y + padY + labelH + headH - 0.5);

  // Body
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...t.body);
  doc.text(bodyLines, x + padX, y + padY + labelH + 3 + headH + 4);

  return y + h + 6;
}

/** 4-card KPI strip with coloured left borders. Each card has a small
 *  uppercase label, a main number (lakh shorthand recommended), and an
 *  optional sub-line. */
interface KpiCardSpec {
  label: string;
  value: string;
  sub?: string;
  subTone?: 'positive' | 'negative' | 'neutral';
}
function drawKpiStrip(
  doc: jsPDF,
  x: number, y: number, w: number,
  cards: KpiCardSpec[],
): number {
  const gap = 4;
  const n = cards.length;
  const cardW = (w - gap * (n - 1)) / n;
  const cardH = 22;

  for (let i = 0; i < n; i++) {
    const cx = x + i * (cardW + gap);
    const c  = cards[i];
    const accent = KPI_BORDERS[i % KPI_BORDERS.length];

    // Soft surface fill
    doc.setFillColor(...SURFACE);
    doc.roundedRect(cx, y, cardW, cardH, 1.5, 1.5, 'F');
    // Hairline border
    doc.setDrawColor(...HAIRLINE);
    doc.setLineWidth(0.2);
    doc.roundedRect(cx, y, cardW, cardH, 1.5, 1.5, 'S');
    // Coloured left rule
    doc.setFillColor(...accent);
    doc.rect(cx, y, 1.1, cardH, 'F');

    // Label
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text(safeText(c.label.toUpperCase()), cx + 4, y + 6, { charSpace: 0.6 });

    // Value
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...TEXT_DARK);
    doc.text(safeText(c.value), cx + 4, y + 13);

    // Sub-line
    if (c.sub) {
      doc.setFontSize(7.6);
      doc.setFont('helvetica', 'normal');
      const tone = c.subTone === 'positive' ? STATUS_GREEN_BODY
                 : c.subTone === 'negative' ? STATUS_RED_BODY
                 : TEXT_SECONDARY;
      doc.setTextColor(...tone);
      doc.text(safeText(c.sub), cx + 4, y + 18);
    }
  }
  return y + cardH + 6;
}

/** Section header per brief: 4px wide × ~14mm tall coloured vertical bar
 *  + 13-14px font-weight 500 dark title. Returns y after the header. */
function drawSectionBar(
  doc: jsPDF,
  x: number, y: number,
  title: string,
  color: [number, number, number] = SECTION_BLUE,
): number {
  const barW = 1.3;
  const barH = 4.8;
  doc.setFillColor(...color);
  doc.roundedRect(x, y - 4, barW, barH, 0.5, 0.5, 'F');

  doc.setFontSize(11.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_DARK);
  doc.text(safeText(title), x + barW + 2.5, y);

  return y + 5;
}

/** 3-state status pill (used in tables and inline). */
function drawStatusPill3(
  doc: jsPDF,
  x: number, y: number,
  band: StatusBand,
  label?: string,
) {
  const t = statusTheme(band);
  const text = label || t.label;
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  const w = doc.getTextWidth(text) + 6;
  const h = 4.4;

  doc.setFillColor(...t.pillBg);
  doc.roundedRect(x, y - h + 1, w, h, 0.8, 0.8, 'F');

  doc.setTextColor(...t.pillText);
  doc.text(text, x + 3, y - 0.6);
}

/** Sparkline-style line chart with subtle filled area below the line.
 *  Draws a dashed amber target line at `target` if provided. */
function drawSparkline(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  values: number[],
  target?: number,
) {
  if (values.length === 0) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(...TEXT_TERTIARY);
    doc.text('No data for the selected period', x + w / 2, y + h / 2, { align: 'center' });
    return;
  }

  const maxV = Math.max(...values, target ?? 0);
  const minV = 0;
  const range = Math.max(1, maxV - minV);
  const n = values.length;

  // Hairline baseline
  doc.setDrawColor(...HAIRLINE);
  doc.setLineWidth(0.2);
  doc.line(x, y + h, x + w, y + h);

  // Dashed target line
  if (target && target > 0 && target <= maxV) {
    const ty = y + h - ((target - minV) / range) * h;
    doc.setDrawColor(...STATUS_AMBER_BORDER);
    doc.setLineWidth(0.4);
    doc.setLineDashPattern([1.5, 1.5], 0);
    doc.line(x, ty, x + w, ty);
    doc.setLineDashPattern([], 0);

    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...STATUS_AMBER_BODY);
    doc.text(`Target ${fmtRsLakh(target)}/day`, x + w, ty - 1.2, { align: 'right' });
  }

  // Plot points
  const px = (i: number) => x + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const py = (v: number) => y + h - ((v - minV) / range) * h;

  // Filled area (build a polygon under the line)
  doc.setFillColor(...STATUS_GREEN_BORDER);
  // jsPDF lacks easy alpha — approximate with a lighter green fill
  doc.setFillColor(225, 245, 238); // STATUS_GREEN_BG
  const poly: number[][] = [];
  for (let i = 0; i < n; i++) poly.push([px(i), py(values[i])]);
  poly.push([px(n - 1), y + h]);
  poly.push([px(0), y + h]);
  doc.lines(
    poly.slice(1).map((p, i) => [p[0] - poly[i][0], p[1] - poly[i][1]]),
    poly[0][0], poly[0][1], [1, 1], 'F', true
  );

  // Line stroke
  doc.setDrawColor(...STATUS_GREEN_BORDER);
  doc.setLineWidth(0.7);
  for (let i = 1; i < n; i++) {
    doc.line(px(i - 1), py(values[i - 1]), px(i), py(values[i]));
  }
  doc.setLineWidth(0.2);
}

/** Solid bar chart used by Weekly Page 1 (Mon-Sun). */
function drawDayBarChart(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  bars: { label: string; value: number }[],
  target?: number,
) {
  if (bars.length === 0) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(...TEXT_TERTIARY);
    doc.text('No daily data', x + w / 2, y + h / 2, { align: 'center' });
    return;
  }
  const maxV = Math.max(...bars.map(b => b.value), target ?? 0);
  const range = Math.max(1, maxV);
  const labelStripH = 4;
  const chartH = h - labelStripH;
  const gap = 1.4;
  const barW = (w - gap * (bars.length - 1)) / bars.length;

  for (let i = 0; i < bars.length; i++) {
    const bx = x + i * (barW + gap);
    const bv = bars[i].value;
    const bh = (bv / range) * chartH;
    doc.setFillColor(...STATUS_GREEN_BORDER);
    doc.roundedRect(bx, y + chartH - bh, barW, bh, 0.6, 0.6, 'F');

    // Day label below
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text(safeText(bars[i].label), bx + barW / 2, y + h - 0.5, { align: 'center' });
  }

  // Dashed target line
  if (target && target > 0 && target <= maxV) {
    const ty = y + chartH - (target / range) * chartH;
    doc.setDrawColor(...STATUS_AMBER_BORDER);
    doc.setLineWidth(0.4);
    doc.setLineDashPattern([1.5, 1.5], 0);
    doc.line(x, ty, x + w, ty);
    doc.setLineDashPattern([], 0);
    doc.setLineWidth(0.2);
  }
}

/** Numbered alert card used in the redesigned alert block. Returns y after. */
function drawNumberedAlert(
  doc: jsPDF,
  x: number, y: number, w: number,
  index: number,
  headline: string,
  subline: string,
  severity: 'critical' | 'watch',
): number {
  const bg = severity === 'critical' ? STATUS_RED_BG    : STATUS_AMBER_BG;
  const border = severity === 'critical' ? STATUS_RED_BORDER : STATUS_AMBER_BORDER;
  const head = severity === 'critical' ? STATUS_RED_HEAD : STATUS_AMBER_HEAD;
  const body = severity === 'critical' ? STATUS_RED_BODY : STATUS_AMBER_BODY;

  const padX = 8;
  const padY = 5;
  doc.setFontSize(9.5);
  const headLines = doc.splitTextToSize(safeText(headline), w - padX * 2 - 6);
  doc.setFontSize(8);
  const subLines  = doc.splitTextToSize(safeText(subline), w - padX * 2 - 6);

  const h = padY + headLines.length * 4.4 + 1 + subLines.length * 3.8 + padY;

  // Bg + left rule
  doc.setFillColor(...bg);
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'F');
  doc.setFillColor(...border);
  doc.rect(x, y, 1.2, h, 'F');

  // Number prefix
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...border);
  doc.text(`${index}`, x + padX - 4, y + padY + 3.2);

  // Headline
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...head);
  doc.text(headLines, x + padX + 2, y + padY + 3.2);

  // Sub
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...body);
  doc.text(subLines, x + padX + 2, y + padY + 3.2 + headLines.length * 4.4 + 0.5);

  return y + h + 3;
}

/** Newsletter-voice "Three things" numbered story card.
 *  - 12-14px padding, off-white background, 4px border-radius
 *  - Large coloured numeral on the left (1, 2, 3) — colour reflects severity
 *  - 12px font-weight 500 headline (the story in one phrase)
 *  - 11px body explaining the math/context in plain words
 *
 *  Used on Page 1 of all three reports to replace the previous flat
 *  alert lists. Composition mixes positive + negative observations
 *  whenever possible. Each card carries a rupee or volume number in
 *  the body to ground the story in reality. */
type ThingTone = 'positive' | 'watch' | 'critical';
function drawThingCard(
  doc: jsPDF,
  x: number, y: number, w: number,
  index: number,
  headline: string,
  body: string,
  tone: ThingTone,
): number {
  const numColor = tone === 'positive' ? STATUS_GREEN_BORDER
                 : tone === 'watch'    ? STATUS_AMBER_BORDER
                 :                       STATUS_RED_BORDER;
  const padX = 12;
  const padY = 8;
  const numCol = 12;

  doc.setFontSize(11);
  const headLines = doc.splitTextToSize(safeText(headline), w - padX * 2 - numCol);
  doc.setFontSize(8.6);
  const bodyLines = doc.splitTextToSize(safeText(body), w - padX * 2 - numCol);

  const headH = headLines.length * 4.6;
  const bodyH = bodyLines.length * 3.9;
  const h = padY + headH + 1.5 + bodyH + padY;

  // Card surface
  doc.setFillColor(...SURFACE);
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'F');

  // Left numeral
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...numColor);
  doc.text(String(index), x + padX - 2, y + padY + headH - 1);

  // Headline
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_DARK);
  doc.text(headLines, x + padX + numCol, y + padY + 4);

  // Body
  doc.setFontSize(8.6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...TEXT_SECONDARY);
  doc.text(bodyLines, x + padX + numCol, y + padY + headH + 4);

  return y + h + 4;
}

/** Newsletter-voice action card.
 *  - 14px padding, white background, 4px border-radius
 *  - 3px solid coloured left border (volume / margin / risk-mitigation)
 *  - Top row flex-justify-between: 13px headline (left) + rupee-impact
 *    pill (right)
 *  - Body: 11px line-height 1.5 explaining the math
 *
 *  Categories:
 *    - 'volume'   — green left border #1D9E75, green pill
 *    - 'margin'   — red left border #A32D2D, red pill
 *    - 'risk'     — amber left border #BA7517, amber pill */
type ActionCategory = 'volume' | 'margin' | 'risk';
function drawActionCard(
  doc: jsPDF,
  x: number, y: number, w: number,
  category: ActionCategory,
  headline: string,
  body: string,
  impactPill: string,
): number {
  const t = category === 'volume'
    ? { border: STATUS_GREEN_BORDER, pillBg: PILL_GREEN_BG, pillText: PILL_GREEN_TEXT }
    : category === 'margin'
      ? { border: STATUS_RED_BORDER, pillBg: PILL_RED_BG, pillText: PILL_RED_TEXT }
      : { border: STATUS_AMBER_BORDER, pillBg: PILL_AMBER_BG, pillText: PILL_AMBER_TEXT };

  const padX = 10;
  const padY = 6;

  // Pill geometry — measured first so we know how much room the
  // headline has on the right side of its row.
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  const pillW = doc.getTextWidth(impactPill) + 8;
  const pillH = 5;

  // Headline — wrap to width minus pill area
  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'bold');
  const headLines = doc.splitTextToSize(safeText(headline), w - padX * 2 - pillW - 6);

  doc.setFontSize(8.6);
  doc.setFont('helvetica', 'normal');
  const bodyLines = doc.splitTextToSize(safeText(body), w - padX * 2);

  const headH = headLines.length * 4.4;
  const bodyH = bodyLines.length * 3.9;
  const h = padY + headH + 2 + bodyH + padY;

  // Card surface — pure white per the brief
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'F');
  // Hairline outer border so the card pops on off-white surfaces
  doc.setDrawColor(...HAIRLINE);
  doc.setLineWidth(0.2);
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'S');
  // 3px left border in the category colour
  doc.setFillColor(...t.border);
  doc.rect(x, y, 1, h, 'F');

  // Headline
  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_DARK);
  doc.text(headLines, x + padX, y + padY + 3.4);

  // Pill (top-right)
  doc.setFillColor(...t.pillBg);
  doc.roundedRect(x + w - padX - pillW, y + padY - 1, pillW, pillH, 1, 1, 'F');
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...t.pillText);
  doc.text(safeText(impactPill), x + w - padX - pillW / 2, y + padY + 2.3, { align: 'center' });

  // Body
  doc.setFontSize(8.6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...TEXT_SECONDARY);
  doc.text(bodyLines, x + padX, y + padY + headH + 4);

  return y + h + 4;
}

/** Compose three story cards from the alerts array, padding with a
 *  positive observation when fewer than 3 negatives exist so the
 *  section is always exactly 3 cards (per the brief).
 *
 *  Inputs:
 *  - alerts:   narrative.alerts[] from the existing engine, ranked by
 *              impact. Strings of the form "headline - body" or just
 *              "headline".
 *  - positive: optional string to use as a green-toned story card if
 *              fewer than 3 alerts exist. Caller composes this from
 *              the data (e.g. top performer, week improvement).
 *
 *  Returns up to 3 cards in the form { headline, body, tone }. */
function composeThreeThings(
  alerts: string[],
  positive?: { headline: string; body: string },
): { headline: string; body: string; tone: ThingTone }[] {
  const out: { headline: string; body: string; tone: ThingTone }[] = [];
  for (let i = 0; i < Math.min(3, alerts.length); i++) {
    const parts = alerts[i].split(' - ');
    const headline = parts[0];
    const body = parts.slice(1).join(' - ') || '';
    out.push({ headline, body, tone: i === 0 ? 'critical' : 'watch' });
  }
  if (out.length < 3 && positive) {
    out.push({ headline: positive.headline, body: positive.body, tone: 'positive' });
  }
  return out.slice(0, 3);
}

/** Pattern-match a narrative action string into the right action-card
 *  category. Volume plays touch cross-sell, capacity, throughput;
 *  margin plays touch pricing, MRP, discounts; risk plays touch
 *  expiry, supplier concentration, data hygiene. Defaults to volume
 *  if nothing matches — callers can override. */
function categoriseAction(text: string): ActionCategory {
  const t = text.toLowerCase();
  if (/(margin|price|discount|mrp|markup|outlier)/.test(t))      return 'margin';
  if (/(expir|stockist|supplier|concentration|dead stock|hygien)/.test(t)) return 'risk';
  return 'volume';
}

/** Cheap rupee-impact extractor for narrative actions — pulls the
 *  first "Rs. X,XXX" / "Rs. 1.2L" pattern out of the body so it can
 *  populate the action card's right-side pill. Falls back to a short
 *  category-tag if no number is present. */
function extractImpactPill(text: string, category: ActionCategory): string {
  const m = /Rs\.\s*[\d,.]+(?:[KLM]|Cr)?/i.exec(text);
  if (m) return '+' + m[0].replace(/^Rs\.\s*/i, 'Rs. ');
  return category === 'volume' ? 'Volume play'
       : category === 'margin' ? 'Margin play'
       :                          'Risk play';
}

/** Soft-tinted callout card used for "Cross-tab insight pending" stubs
 *  and the Monthly verdict box. */
function drawCalloutCard(
  doc: jsPDF,
  x: number, y: number, w: number,
  body: string,
  tone: 'neutral' | 'amber' | 'red' = 'neutral',
): number {
  const bg = tone === 'amber' ? STATUS_AMBER_BG : tone === 'red' ? STATUS_RED_BG : SURFACE;
  const text = tone === 'amber' ? STATUS_AMBER_BODY : tone === 'red' ? STATUS_RED_BODY : TEXT_SECONDARY;

  const padX = 8;
  const padY = 5;
  doc.setFontSize(9.5);
  const lines = doc.splitTextToSize(safeText(body), w - padX * 2);
  const h = padY * 2 + lines.length * 4.4;

  doc.setFillColor(...bg);
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'F');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...text);
  doc.text(lines, x + padX, y + padY + 3.2);
  return y + h + 6;
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
  branchState: string,
  logo: LogoState | null,
): number {
  drawPageBg(doc);
  addHeader(doc, title, subtitle, clientName, branchName, branchState, logo);
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  drawCard(doc, 8, CARD_TOP_AFTER_HEADER, pw - 16, ph - CARD_TOP_AFTER_HEADER - 14);
  return FIRST_CONTENT_Y;
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
    // Was "Patients" (unique). Now plots "Visits" — encounter counts
    // straight from order_number, so a patient who came twice this week
    // contributes 2 to the headline number.
    { label: 'Visits', cur: fmtCount(tw.patients), prev: fmtCount(lw.patients), pct: lw.patients > 0 ? ((tw.patients - lw.patients) / lw.patients) * 100 : 0 },
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
  branchState: string,
  _logo: LogoState | null,
) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const INNER_X = PAGE_INNER_X;
  const INNER_W = pageW - PAGE_INNER_X * 2;

  const latestDate = data.streams.flatMap(s => s.daily.map(d => d.date)).sort().pop() || '';
  const prevDate   = data.streams.flatMap(s => s.daily.map(d => d.date)).filter(d => d < latestDate).sort().pop() || '';
  const narrative  = buildNarrative(data, 'daily');

  // ── PAGE 1 — Decision page ────────────────────────────────────────
  let y = drawOutlineHeader(
    doc,
    'DAILY OPERATIONAL INSIGHT',
    latestDate ? prettyDate(latestDate) : data.monthLabel,
    `Day ${data.daysElapsed} of ${data.daysInMonth} - ${data.daysRemaining} days remaining`,
    clientName, branchName, branchState,
  );

  // Hero status block — sentence-form headline driven by projection vs target
  const tgt = data.combined.targetRevenue;
  const proj = data.combined.projectedRevenue;
  const mtd = data.combined.mtdRevenue;
  const projPct = tgt > 0 ? (proj / tgt) * 100 : 0;
  const band = statusFromProjection(projPct);
  const expectedPct = (data.daysElapsed / Math.max(data.daysInMonth, 1)) * 100;
  const headline = composeStatusHeadline('daily', projPct, band, {});
  const dailyNeed = data.daysRemaining > 0 ? Math.max(0, tgt - mtd) / data.daysRemaining : 0;
  const dailyRun  = mtd / Math.max(data.daysElapsed, 1);
  // Newsletter voice (May 2026 addendum): the body opens like a
  // letter and frames numbers in plain words. We address the reader
  // directly with "you" / "your" and bold the rupee values via the
  // hero block's own typography (font-weight 500 across).
  const body = tgt > 0
    ? `Dear team -- here's where you stand today. You've earned ${fmtRsLakh(mtd)} so far, ${Math.round((mtd / tgt) * 100)}% of the monthly target with ${Math.round(expectedPct)}% of the month elapsed. Today's pace is ${fmtRsLakh(dailyRun)}/day; you need ${fmtRsLakh(dailyNeed)}/day for the remaining ${data.daysRemaining} days.`
    : `Dear team -- here's where you stand today. You've earned ${fmtRsLakh(mtd)} so far. No monthly target is configured yet.`;
  y = drawHeroStatus(doc, INNER_X, y, INNER_W, `DAY ${data.daysElapsed} OF ${data.daysInMonth}`, 'Updates daily', headline, body, band);

  // KPI strip — newsletter-voice labels per the May 2026 addendum.
  // "Earned MTD" / "Projected EOM" / "Gap to target" / "Daily need"
  // become "You earned" / "On track to finish at" / "Short by" /
  // "Need per day" — same data, plain language.
  const gap = Math.max(0, tgt - proj);
  y = drawKpiStrip(doc, INNER_X, y, INNER_W, [
    { label: 'You earned',           value: fmtRsLakh(mtd) },
    { label: 'On track to finish at', value: tgt > 0 ? fmtRsLakh(proj) : '--', sub: tgt > 0 ? `${Math.round(projPct)}% of target` : undefined },
    { label: 'Short by',             value: tgt > 0 ? fmtRsLakh(gap)  : '--', sub: gap > 0 ? 'shortfall' : 'on target', subTone: gap > 0 ? 'negative' : 'positive' },
    { label: 'Need per day',         value: dailyNeed > 0 ? fmtRsLakh(dailyNeed) : '--', sub: data.daysRemaining > 0 ? `for ${data.daysRemaining} days left` : 'period closed' },
  ]);

  // Critical alerts — top 3, ranked
  // ── Three things to focus on today ─────────────────────────────
  // Newsletter-voice rebuild of the previous "Critical alerts" block.
  // Always exactly 3 numbered story cards, padded with a positive
  // observation if fewer than 3 alerts exist. Each card carries a
  // rupee or volume number so the story is grounded in real data.
  const dailyTopStream = data.streams.reduce((p, x) => {
    const xPrim = getStreamPrimary(x);
    const pPrim = getStreamPrimary(p);
    return (xPrim?.mtd || 0) > (pPrim?.mtd || 0) ? x : p;
  }, data.streams[0]);
  const dailyTopPrim = dailyTopStream ? getStreamPrimary(dailyTopStream) : null;
  const positiveDaily = dailyTopPrim && dailyTopPrim.mtd > 0
    ? { headline: `${dailyTopStream.name} is your strongest stream so far`, body: `${dailyTopStream.name} has earned ${fmtRsLakh(dailyTopPrim.mtd)} this month${dailyTopPrim.target > 0 ? `, ${Math.round((dailyTopPrim.mtd / dailyTopPrim.target) * 100)}% of its target` : ''}. Keep the pace and it'll carry the headline number.` }
    : undefined;
  const things = composeThreeThings(narrative.alerts, positiveDaily);
  if (things.length > 0) {
    y = drawSectionBar(doc, INNER_X, y + 2, 'Three things to focus on today', SECTION_RED);
    for (let i = 0; i < things.length; i++) {
      y = drawThingCard(doc, INNER_X, y, INNER_W, i + 1, things[i].headline, things[i].body, things[i].tone);
    }
  }

  // ── What today calls for ───────────────────────────────────────
  // Action cards with category-coloured left border + rupee-impact
  // pill, replacing the previous flat numbered list.
  const actions = narrative.actions.slice(0, 3);
  if (actions.length > 0 && y < pageH - 80) {
    y = drawSectionBar(doc, INNER_X, y + 4, 'What today calls for', SECTION_AMBER);
    for (const a of actions) {
      const parts = a.split(' - ');
      const head = parts[0];
      const body = parts.slice(1).join(' - ') || '';
      const cat = categoriseAction(head + ' ' + body);
      const pill = extractImpactPill(body, cat);
      y = drawActionCard(doc, INNER_X, y, INNER_W, cat, head, body, pill);
    }
  }

  // ── PAGE 2 — Detail ───────────────────────────────────────────────
  doc.addPage();
  y = PAGE_TOP + 6;

  // Page-2 small chrome line
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_TERTIARY);
  doc.text('PAGE 2 - DETAIL', INNER_X, y, { charSpace: 0.6 });
  y += 8;

  // Pace to monthly target — full scorecard (per-stream rows grouped)
  y = drawSectionBar(doc, INNER_X, y, 'Pace to monthly target', SECTION_BLUE);
  for (const stream of data.streams) {
    const paceCards = stream.cards.filter(c => c.target > 0 && c.unit !== 'percent');
    if (paceCards.length === 0) continue;

    // Subsection group header (uppercase letter-spaced)
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...TEXT_TERTIARY);
    doc.text(safeText(stream.name.toUpperCase()), INNER_X, y, { charSpace: 0.6 });
    y += 4;

    const rows = paceCards.map(card => {
      const aheadMtd = card.mtd >= card.target;
      const onPace = card.requiredRate <= card.dailyRate;
      const projPctRow = card.target > 0 ? (card.projected / card.target) * 100 : 0;
      const rowBand = statusFromProjection(projPctRow);
      return {
        label: card.category ? `${card.category} - ${card.label}` : card.label,
        mtd: fmtValue(card.mtd, card.unit),
        actualDay: fmtValue(card.dailyRate, card.unit),
        required: aheadMtd ? '-' : fmtValue(Math.max(card.requiredRate, 0), card.unit),
        band: aheadMtd ? 'on_track' : onPace ? 'on_pace' : rowBand,
      };
    });

    autoTable(doc, {
      startY: y,
      head: [['KPI', 'MTD', 'Pace/d', 'Need/d', 'Status']],
      body: rows.map(r => [r.label, r.mtd, r.actualDay, r.required, '']),
      theme: 'plain',
      styles: { fontSize: 8.5, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 }, lineColor: HAIRLINE, lineWidth: 0 },
      headStyles: { fillColor: [255, 255, 255], textColor: TEXT_SECONDARY, fontStyle: 'bold', fontSize: 7.5, lineColor: TEXT_DARK, lineWidth: 0.4 },
      bodyStyles: { lineColor: HAIRLINE, lineWidth: 0.1, textColor: TEXT_DARK },
      columnStyles: {
        0: { cellWidth: 60 },
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'left', cellWidth: 26 },
      },
      didDrawCell: (hook) => {
        if (hook.section === 'body' && hook.column.index === 4) {
          const r = rows[hook.row.index];
          if (r) drawStatusPill3(doc, hook.cell.x + 1, hook.cell.y + hook.cell.height / 2 + 1.4, r.band as StatusBand);
        }
      },
      margin: { left: INNER_X, right: pageW - (INNER_X + INNER_W) },
    });
    y = (doc as any).lastAutoTable.finalY + 5;
  }

  // Today vs yesterday — two side-by-side mini tables
  y = drawSectionBar(doc, INNER_X, y + 2, 'Today vs yesterday', SECTION_BLUE);
  const halfW = (INNER_W - 6) / 2;
  const renderMini = (xCol: number, label: string, rows: { metric: string; today: string; yesterday: string; pct: { label: string; positive: boolean | null } }[]) => {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...TEXT_TERTIARY);
    doc.text(safeText(label), xCol, y, { charSpace: 0.6 });
    autoTable(doc, {
      startY: y + 1.5,
      head: [['Metric', 'Today', 'Yesterday', 'Change']],
      body: rows.map(r => [r.metric, r.today, r.yesterday, r.pct.label]),
      theme: 'plain',
      styles: { fontSize: 8, cellPadding: { top: 1.6, bottom: 1.6, left: 1.5, right: 1.5 }, textColor: TEXT_DARK },
      headStyles: { fillColor: [255, 255, 255], textColor: TEXT_SECONDARY, fontStyle: 'bold', fontSize: 7, lineColor: TEXT_DARK, lineWidth: 0.3 },
      bodyStyles: { lineColor: HAIRLINE, lineWidth: 0.1 },
      columnStyles: {
        0: { cellWidth: halfW * 0.34 },
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
      },
      didParseCell: (cell) => {
        if (cell.section === 'body' && cell.column.index === 3) {
          const txt = String(cell.cell.raw || '');
          if (txt.startsWith('+'))      cell.cell.styles.textColor = STATUS_GREEN_BODY;
          else if (txt.startsWith('-')) cell.cell.styles.textColor = STATUS_RED_BODY;
        }
      },
      margin: { left: xCol, right: pageW - (xCol + halfW) },
      tableWidth: halfW,
    });
  };
  for (const stream of data.streams) {
    const today     = latestDate ? stream.daily.find(d => d.date === latestDate) : null;
    const yesterday = prevDate   ? stream.daily.find(d => d.date === prevDate)   : null;
    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');
    const rows = isClinic ? [
      { metric: 'Visits',  today: today ? fmtCount(today.patients || 0) : '--', yesterday: yesterday ? fmtCount(yesterday.patients || 0) : '--', pct: fmtChange(today?.patients || 0, yesterday?.patients || 0) },
      { metric: 'Revenue', today: today ? fmtRsLakh(today.revenue || 0) : '--', yesterday: yesterday ? fmtRsLakh(yesterday.revenue || 0) : '--', pct: fmtChange(today?.revenue || 0, yesterday?.revenue || 0) },
    ] : [
      { metric: 'Bills',   today: today ? fmtCount(today.transactions || 0) : '--', yesterday: yesterday ? fmtCount(yesterday.transactions || 0) : '--', pct: fmtChange(today?.transactions || 0, yesterday?.transactions || 0) },
      { metric: 'Sales',   today: today ? fmtRsLakh(today.revenue || 0) : '--', yesterday: yesterday ? fmtRsLakh(yesterday.revenue || 0) : '--', pct: fmtChange(today?.revenue || 0, yesterday?.revenue || 0) },
    ];
    const xCol = stream === data.streams[0] ? INNER_X : INNER_X + halfW + 6;
    renderMini(xCol, stream.name.toUpperCase(), rows);
  }
  y = (doc as any).lastAutoTable.finalY + 5;

  // Last 7 days sparkline (combined revenue)
  y = drawSectionBar(doc, INNER_X, y + 2, 'Last 7 days', SECTION_BLUE);
  // Aggregate combined daily revenue from all streams
  const dailyByDate = new Map<string, number>();
  for (const s of data.streams) {
    for (const d of s.daily) dailyByDate.set(d.date, (dailyByDate.get(d.date) || 0) + (d.revenue || 0));
  }
  const dates = [...dailyByDate.keys()].sort();
  const last7Dates = dates.slice(-7);
  const last7Vals  = last7Dates.map(d => dailyByDate.get(d) || 0);
  const dailyTarget = tgt > 0 ? tgt / data.daysInMonth : 0;

  drawSparkline(doc, INNER_X, y, INNER_W, 28, last7Vals, dailyTarget);
  // X-axis labels: first, middle, last
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...TEXT_TERTIARY);
  if (last7Dates.length > 0) {
    doc.text(safeText(prettyDate(last7Dates[0])), INNER_X, y + 32);
    if (last7Dates.length > 2) {
      const mid = last7Dates[Math.floor(last7Dates.length / 2)];
      doc.text(safeText(prettyDate(mid)), INNER_X + INNER_W / 2, y + 32, { align: 'center' });
    }
    doc.text(safeText(prettyDate(last7Dates[last7Dates.length - 1])), INNER_X + INNER_W, y + 32, { align: 'right' });
  }

  addFooter(doc, footerLabel('Daily Insight', data.monthLabel, clientName, branchName, branchState));
  doc.save(filename('Daily_Insight', data.month, branchName, latestDate || 'today'));
}

/* ──────── Weekly PDF ──────── */

function generateWeeklyPDF(
  data: InsightsData,
  clientName: string,
  branchName: string,
  branchState: string,
  _logo: LogoState | null,
) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const INNER_X = PAGE_INNER_X;
  const INNER_W = pageW - PAGE_INNER_X * 2;
  const narrative = buildNarrative(data, 'weekly');

  // Aggregate this-week / last-week totals across streams
  const tw = data.streams.reduce((s, x) => ({
    revenue: s.revenue + (x.thisWeek?.revenue || 0),
    txns:    s.txns    + (x.thisWeek?.transactions || 0) + (x.thisWeek?.patients || 0),
    profit:  s.profit  + (x.thisWeek?.profit || 0),
  }), { revenue: 0, txns: 0, profit: 0 });
  const lw = data.streams.reduce((s, x) => ({
    revenue: s.revenue + (x.lastWeek?.revenue || 0),
    txns:    s.txns    + (x.lastWeek?.transactions || 0) + (x.lastWeek?.patients || 0),
    profit:  s.profit  + (x.lastWeek?.profit || 0),
  }), { revenue: 0, txns: 0, profit: 0 });
  const wow = lw.revenue > 0 ? ((tw.revenue - lw.revenue) / lw.revenue) * 100 : 0;
  const avgTicket = tw.txns > 0 ? tw.revenue / tw.txns : 0;
  const avgTicketPrev = lw.txns > 0 ? lw.revenue / lw.txns : 0;
  const marginPct = tw.revenue > 0 ? (tw.profit / tw.revenue) * 100 : 0;

  // ── PAGE 1 — Week summary ─────────────────────────────────────────
  let y = drawOutlineHeader(
    doc,
    'WEEKLY OPERATIONAL INSIGHT',
    `Week of ${data.monthLabel}`,
    `Day ${data.daysElapsed} of ${data.daysInMonth} - compared to prior week`,
    clientName, branchName, branchState,
  );

  // Hero status — newsletter voice: salutation, sentence headline,
  // body addressed to the reader. WoW change drives the band.
  const wowBand: StatusBand = wow >= 0 ? (wow >= 10 ? 'on_track' : 'on_pace') : (wow >= -10 ? 'behind' : 'at_risk');
  const wowHead = composeStatusHeadline('weekly', 0, wowBand, { wow });
  const peakStream = data.streams.reduce((p, x) => (x.thisWeek?.revenue || 0) > (p.thisWeek?.revenue || 0) ? x : p, data.streams[0]);
  const wowBody = `Dear team -- here's how the week went. You earned ${fmtRsLakh(tw.revenue)} this week vs ${fmtRsLakh(lw.revenue)} last week.${peakStream ? ` ${peakStream.name} led at ${fmtRsLakh(peakStream.thisWeek?.revenue || 0)}.` : ''} Margin held at ${marginPct.toFixed(1)}%. ${data.daysRemaining} days remain in ${data.monthLabel}.`;
  y = drawHeroStatus(doc, INNER_X, y, INNER_W, 'WEEK SUMMARY', `${data.daysRemaining} days remain in ${data.monthLabel}`, wowHead, wowBody, wowBand);

  // KPI strip
  const wowChange = fmtChange(tw.revenue, lw.revenue);
  const txnChange = fmtChange(tw.txns, lw.txns);
  const ticketChange = fmtChange(avgTicket, avgTicketPrev);
  y = drawKpiStrip(doc, INNER_X, y, INNER_W, [
    { label: 'Week revenue', value: fmtRsLakh(tw.revenue), sub: `${wowChange.label} WoW`, subTone: wowChange.positive ? 'positive' : wowChange.positive === false ? 'negative' : 'neutral' },
    { label: 'Visits / bills', value: fmtCount(tw.txns), sub: `${txnChange.label} WoW`, subTone: txnChange.positive ? 'positive' : txnChange.positive === false ? 'negative' : 'neutral' },
    { label: 'Avg ticket', value: avgTicket > 0 ? fmtRsLakh(Math.round(avgTicket)) : '--', sub: `${ticketChange.label} WoW`, subTone: ticketChange.positive ? 'positive' : ticketChange.positive === false ? 'negative' : 'neutral' },
    { label: 'Margin', value: `${marginPct.toFixed(1)}%`, sub: 'gross profit / revenue' },
  ]);

  // Daily breakdown bar chart (full month, last 7 if available)
  y = drawSectionBar(doc, INNER_X, y + 2, 'Daily breakdown', SECTION_BLUE);
  const allDates = [...new Set(data.streams.flatMap(s => s.daily.map(d => d.date)))].sort();
  const last7 = allDates.slice(-7);
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const bars = last7.map(d => {
    const total = data.streams.reduce((sum, s) => sum + (s.daily.find(x => x.date === d)?.revenue || 0), 0);
    const dt = new Date(d);
    return { label: dayLabels[(dt.getDay() + 6) % 7], value: total };
  });
  const dailyTarget = data.combined.targetRevenue > 0 ? data.combined.targetRevenue / data.daysInMonth : 0;
  drawDayBarChart(doc, INNER_X, y, INNER_W, 30, bars, dailyTarget);
  y += 34;

  // Best/worst day callout
  if (bars.length > 0) {
    const best  = bars.reduce((p, x) => x.value > p.value ? x : p, bars[0]);
    const worst = bars.reduce((p, x) => x.value < p.value ? x : p, bars[0]);
    const above = bars.filter(b => b.value >= dailyTarget).length;
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text(`Best ${best.label} ${fmtRsLakh(best.value)}  -  Worst ${worst.label} ${fmtRsLakh(worst.value)}  -  ${above} of ${bars.length} days above target`, INNER_X, y);
    y += 6;
  }

  // ── Three things from this week ────────────────────────────────
  // Newsletter-voice section: 3 numbered story cards covering the
  // week's biggest signals. Pads with a positive observation when
  // fewer than 3 alerts exist (e.g. peak day callout).
  const positiveWeekly = bars.length > 0
    ? (() => {
        const best = bars.reduce((p, x) => x.value > p.value ? x : p, bars[0]);
        return { headline: `${best.label} was your best day of the week`, body: `${best.label} closed at ${fmtRsLakh(best.value)} -- the high-water mark of the week. Worth understanding what worked so you can repeat it.` };
      })()
    : undefined;
  const weeklyThings = composeThreeThings(narrative.alerts, positiveWeekly);
  if (weeklyThings.length > 0) {
    y = drawSectionBar(doc, INNER_X, y + 2, 'Three things from this week', SECTION_RED);
    for (let i = 0; i < weeklyThings.length; i++) {
      y = drawThingCard(doc, INNER_X, y, INNER_W, i + 1, weeklyThings[i].headline, weeklyThings[i].body, weeklyThings[i].tone);
    }
  }

  // ── PAGE 2 — Streams within the week ──────────────────────────────
  doc.addPage();
  y = PAGE_TOP + 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_TERTIARY);
  doc.text('PAGE 2 - STREAMS', INNER_X, y, { charSpace: 0.6 });
  y += 8;

  for (const stream of data.streams) {
    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');
    y = drawSectionBar(doc, INNER_X, y, stream.name, SECTION_BLUE);
    const tw = stream.thisWeek;
    const lw = stream.lastWeek;
    const rev = tw?.revenue || 0;
    const ticket = (tw && (tw.transactions || tw.patients)) ? rev / ((tw.transactions || tw.patients) as number) : 0;

    // Two-column: narrative (left) + KPI mini-table (right)
    const narrativeText = isClinic
      ? `Clinic delivered ${fmtCount(tw?.patients || 0)} visits at ${fmtRsLakh(rev)} this week (${fmtChange(rev, lw?.revenue || 0).label} WoW). Avg ticket settled at ${fmtRsLakh(Math.round(ticket))}.`
      : `Pharmacy ran ${fmtCount(tw?.transactions || 0)} bills at ${fmtRsLakh(rev)} this week (${fmtChange(rev, lw?.revenue || 0).label} WoW). Profit ${fmtRsLakh(tw?.profit || 0)} at ${tw?.profit && rev > 0 ? ((tw.profit / rev) * 100).toFixed(1) : '0'}% margin.`;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...TEXT_DARK);
    const lines = doc.splitTextToSize(safeText(narrativeText), INNER_W * 0.55);
    doc.text(lines, INNER_X, y + 2);

    // KPI mini-table on the right
    const tableX = INNER_X + INNER_W * 0.58;
    const tableW = INNER_W * 0.42;
    const rows = isClinic ? [
      ['Visits', fmtCount(tw?.patients || 0)],
      ['Revenue', fmtRsLakh(rev)],
      ['Avg ticket', ticket > 0 ? fmtRsLakh(Math.round(ticket)) : '--'],
    ] : [
      ['Bills', fmtCount(tw?.transactions || 0)],
      ['Sales', fmtRsLakh(rev)],
      ['Profit', fmtRsLakh(tw?.profit || 0)],
      ['Margin', `${tw?.profit && rev > 0 ? ((tw.profit / rev) * 100).toFixed(1) : '0'}%`],
    ];
    autoTable(doc, {
      startY: y - 1,
      body: rows,
      theme: 'plain',
      styles: { fontSize: 8, cellPadding: { top: 1.5, bottom: 1.5, left: 2, right: 2 }, textColor: TEXT_DARK, lineColor: HAIRLINE, lineWidth: 0.1 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: tableW * 0.55, textColor: TEXT_SECONDARY }, 1: { halign: 'right' } },
      margin: { left: tableX, right: pageW - (tableX + tableW) },
      tableWidth: tableW,
    });
    y = Math.max((doc as any).lastAutoTable.finalY, y + lines.length * 4 + 4) + 6;
  }

  // Daily revenue split by stream — stacked bar
  y = drawSectionBar(doc, INNER_X, y + 2, 'Daily revenue split by stream', SECTION_BLUE);
  if (last7.length > 0) {
    const stackH = 30;
    const gap = 2;
    const barW = (INNER_W - gap * (last7.length - 1)) / last7.length;
    let maxStack = 0;
    const perDay = last7.map(d => {
      const parts = data.streams.map(s => ({ name: s.name, value: s.daily.find(x => x.date === d)?.revenue || 0 }));
      const total = parts.reduce((sum, p) => sum + p.value, 0);
      maxStack = Math.max(maxStack, total);
      return { date: d, total, parts };
    });
    const range = Math.max(1, maxStack);
    for (let i = 0; i < perDay.length; i++) {
      const bx = INNER_X + i * (barW + gap);
      let stackY = y + stackH;
      for (let j = 0; j < perDay[i].parts.length; j++) {
        const p = perDay[i].parts[j];
        const ph = (p.value / range) * stackH;
        const isClinic = p.name.toLowerCase().includes('clinic') || p.name.toLowerCase().includes('health');
        doc.setFillColor(...(isClinic ? SECTION_BLUE : SECTION_PURPLE));
        doc.rect(bx, stackY - ph, barW, ph, 'F');
        stackY -= ph;
      }
      const dt = new Date(perDay[i].date);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...TEXT_SECONDARY);
      doc.text(dayLabels[(dt.getDay() + 6) % 7], bx + barW / 2, y + stackH + 4, { align: 'center' });
    }
    y += stackH + 6;
    // Legend
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...TEXT_SECONDARY);
    doc.setFillColor(...SECTION_BLUE);
    doc.rect(INNER_X, y - 2.5, 2.5, 2.5, 'F');
    doc.text('Clinic', INNER_X + 4, y);
    doc.setFillColor(...SECTION_PURPLE);
    doc.rect(INNER_X + 22, y - 2.5, 2.5, 2.5, 'F');
    doc.text('Pharmacy', INNER_X + 26, y);
    y += 6;
  }

  // ── PAGE 3 — Actions for next week ────────────────────────────────
  doc.addPage();
  y = PAGE_TOP + 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_TERTIARY);
  doc.text('PAGE 3 - ACTIONS FOR NEXT WEEK', INNER_X, y, { charSpace: 0.6 });
  y += 8;

  y = drawSectionBar(doc, INNER_X, y, 'Priority actions', SECTION_AMBER);
  const wkActions = narrative.actions.slice(0, 3);
  for (let i = 0; i < wkActions.length; i++) {
    const parts = wkActions[i].split(' - ');
    y = drawNumberedAlert(doc, INNER_X, y, INNER_W, i + 1, parts[0], parts.slice(1).join(' - '), i === 0 ? 'critical' : 'watch');
  }
  if (wkActions.length === 0) {
    y = drawCalloutCard(doc, INNER_X, y, INNER_W, 'No outstanding priority actions for next week. Maintain current pace and watch the leading indicators below.', 'neutral');
  }

  y = drawSectionBar(doc, INNER_X, y + 2, 'Forward indicators', SECTION_BLUE);
  // Forward indicators are derived from existing data: days remaining vs gap, projected EOM
  const fwdGap = Math.max(0, data.combined.targetRevenue - data.combined.projectedRevenue);
  const fwdNeed = data.daysRemaining > 0 ? fwdGap / data.daysRemaining : 0;
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...TEXT_DARK);
  y = drawCalloutCard(doc, INNER_X, y, INNER_W,
    `${data.daysRemaining} days remain in ${data.monthLabel}. ${fwdGap > 0 ? `Closing the ${fmtRsLakh(fwdGap)} gap requires ${fmtRsLakh(fwdNeed)}/day - up from this week's ${fmtRsLakh(tw.revenue / 7)}/day pace.` : 'On track to clear the monthly target.'}`,
    fwdGap > 0 ? 'amber' : 'neutral'
  );

  addFooter(doc, footerLabel('Weekly Insight', data.monthLabel, clientName, branchName, branchState));
  doc.save(filename('Weekly_Insight', data.month, branchName));
}

/* ──────── Monthly PDF ──────── */

function generateMonthlyPDF(
  data: InsightsData,
  clientName: string,
  branchName: string,
  branchState: string,
  _logo: LogoState | null,
) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const INNER_X = PAGE_INNER_X;
  const INNER_W = pageW - PAGE_INNER_X * 2;
  const narrative = buildNarrative(data, 'monthly');

  const tgt = data.combined.targetRevenue;
  const proj = data.combined.projectedRevenue;
  const mtd = data.combined.mtdRevenue;
  const isFinal = data.daysRemaining === 0;
  const projPct = tgt > 0 ? (proj / tgt) * 100 : 0;
  const band = statusFromProjection(projPct);

  // Top / weak stream by attainment
  const streamPct = data.streams.map(s => {
    const p = getStreamPrimary(s);
    const t = p?.target || 0;
    return { name: s.name, pct: t > 0 ? ((p?.projected || 0) / t) * 100 : 0, mtd: p?.mtd || 0 };
  });
  const topStream  = streamPct.reduce((p, x) => x.pct > p.pct ? x : p, streamPct[0] || { name: '', pct: 0, mtd: 0 });
  const weakStream = streamPct.reduce((p, x) => x.pct < p.pct ? x : p, streamPct[0] || { name: '', pct: 0, mtd: 0 });

  // ── PAGE 1 — Executive summary ────────────────────────────────────
  let y = drawOutlineHeader(
    doc,
    'MONTHLY OPERATIONAL INSIGHT',
    data.monthLabel,
    isFinal ? `Final - Day ${data.daysInMonth} of ${data.daysInMonth}` : `MTD - Day ${data.daysElapsed} of ${data.daysInMonth}`,
    clientName, branchName, branchState,
  );

  const monthlyKind = isFinal ? 'monthly_final' : 'monthly_mtd';
  const monthName = data.monthLabel.split(' ')[0] || data.monthLabel;
  const headline = composeStatusHeadline(monthlyKind, projPct, band, { topStream: topStream.name, weakStream: weakStream.name, period: monthName });
  // Newsletter-voice opening — "Dear team" salutation, plain words,
  // a 3-4 sentence story about what happened in the month.
  const monthlyBody = tgt > 0
    ? `Dear team -- here's how ${monthName} went. You earned ${fmtRsLakh(mtd)} of a ${fmtRsLakh(tgt)} target${isFinal ? '' : `, with ${data.daysRemaining} days still to go`}. ${topStream.name} hit ${Math.round(topStream.pct)}% of its goal; ${weakStream.name} came in at ${Math.round(weakStream.pct)}%. ${isFinal ? `That's the story of ${monthName} in one paragraph.` : `The next ${data.daysRemaining} days will decide whether you close above or below target.`}`
    : `Dear team -- here's how ${monthName} went. You earned ${fmtRsLakh(mtd)}. No monthly target is configured yet.`;
  y = drawHeroStatus(doc, INNER_X, y, INNER_W,
    isFinal ? `${data.monthLabel.toUpperCase()} - FINAL` : `${data.monthLabel.toUpperCase()} - MTD`,
    isFinal ? `Closed ${data.monthLabel}` : `${data.daysRemaining} days remaining`,
    headline, monthlyBody, band,
  );

  // KPI strip — Combined / Clinic / Pharmacy / Pharmacy margin
  const clinicS  = data.streams.find(s => s.name.toLowerCase().includes('clinic') || s.name.toLowerCase().includes('health'));
  const pharmaS  = data.streams.find(s => s.name.toLowerCase().includes('pharma'));
  const clinicPrimary = clinicS ? getStreamPrimary(clinicS) : null;
  const pharmaPrimary = pharmaS ? getStreamPrimary(pharmaS) : null;
  const pharmaProfitCard = pharmaS?.cards.find(c => /profit/i.test(c.label));
  const pharmaMargin = pharmaPrimary && pharmaPrimary.mtd > 0 && pharmaProfitCard ? (pharmaProfitCard.mtd / pharmaPrimary.mtd) * 100 : 0;
  const pharmaMarginTarget = pharmaPrimary?.target && pharmaProfitCard?.target ? (pharmaProfitCard.target / pharmaPrimary.target) * 100 : 0;
  const marginGap = pharmaMargin - pharmaMarginTarget;

  const deltaTgt = tgt > 0 ? mtd - tgt : 0;
  y = drawKpiStrip(doc, INNER_X, y, INNER_W, [
    { label: 'You earned',      value: fmtRsLakh(mtd), sub: tgt > 0 ? (deltaTgt >= 0 ? `+${fmtRsLakh(deltaTgt)} vs target` : `${fmtRsLakh(deltaTgt)} vs target`) : undefined, subTone: deltaTgt >= 0 ? 'positive' : 'negative' },
    { label: 'Clinic',          value: clinicPrimary ? fmtRsLakh(clinicPrimary.mtd) : '--', sub: clinicPrimary?.target ? `${Math.round((clinicPrimary.mtd / clinicPrimary.target) * 100)}% of target` : undefined },
    { label: 'Pharmacy',        value: pharmaPrimary ? fmtRsLakh(pharmaPrimary.mtd) : '--', sub: pharmaPrimary?.target ? `${Math.round((pharmaPrimary.mtd / pharmaPrimary.target) * 100)}% of target` : undefined },
    { label: 'Pharmacy margin', value: pharmaMargin > 0 ? `${pharmaMargin.toFixed(1)}%` : '--', sub: pharmaMarginTarget > 0 ? `${marginGap >= 0 ? '+' : ''}${marginGap.toFixed(1)}pp vs forecast` : undefined, subTone: marginGap >= 0 ? 'positive' : 'negative' },
  ]);

  // ── Three things you should know about [Month] ────────────────
  // Newsletter-voice section: 3 numbered story cards covering the
  // month's biggest signals. Mixes positive + negative -- e.g. when
  // the combined number is on track, the top alert sits alongside a
  // green positive observation about the strongest stream.
  const positiveMonthly = topStream && topStream.pct > 0
    ? { headline: `${topStream.name} carried the headline number`, body: `${topStream.name} hit ${Math.round(topStream.pct)}% of its target with ${fmtRsLakh(topStream.mtd)} earned. That's the engine you want to keep tuned.` }
    : undefined;
  const monthlyThings = composeThreeThings(narrative.alerts, positiveMonthly);
  if (monthlyThings.length > 0) {
    y = drawSectionBar(doc, INNER_X, y + 2, `Three things you should know about ${monthName}`, SECTION_RED);
    for (let i = 0; i < monthlyThings.length; i++) {
      y = drawThingCard(doc, INNER_X, y, INNER_W, i + 1, monthlyThings[i].headline, monthlyThings[i].body, monthlyThings[i].tone);
    }
  }

  // Verdict — a soft prose summary
  y = drawSectionBar(doc, INNER_X, y + 2, 'Verdict', SECTION_BLUE);
  const verdictText = isFinal
    ? `${data.monthLabel} closed at ${Math.round(projPct)}% of target. ${topStream.name} ${topStream.pct >= 100 ? 'cleared its goal' : `landed at ${Math.round(topStream.pct)}%`}; ${weakStream.name} ${weakStream.pct >= 100 ? 'also cleared' : `pulled the average down at ${Math.round(weakStream.pct)}%`}. Focus next month on ${weakStream.pct < 80 ? `recovering ${weakStream.name}` : 'maintaining momentum and protecting margin'}.`
    : `${data.monthLabel} is on track to land at ${Math.round(projPct)}% with ${data.daysRemaining} days remaining. The headline number is ${narrative.alerts.length > 0 ? 'driven by the issue flagged above' : 'tracking close to plan'} - decisions for the remainder of the month should focus on ${weakStream.pct < 80 ? weakStream.name : 'sustaining the current pace'}.`;
  y = drawCalloutCard(doc, INNER_X, y, INNER_W, verdictText, 'neutral');

  // ── PAGE 2 — Month progression ────────────────────────────────────
  doc.addPage();
  y = PAGE_TOP + 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_TERTIARY);
  doc.text('PAGE 2 - MONTH PROGRESSION', INNER_X, y, { charSpace: 0.6 });
  y += 8;

  y = drawSectionBar(doc, INNER_X, y, `How ${data.monthLabel.split(' ')[0]} unfolded`, SECTION_BLUE);

  // Daily revenue chart (full month, combined)
  const dailyByDate = new Map<string, number>();
  for (const s of data.streams) for (const d of s.daily) dailyByDate.set(d.date, (dailyByDate.get(d.date) || 0) + (d.revenue || 0));
  const sortedDates = [...dailyByDate.keys()].sort();
  const dailyVals = sortedDates.map(d => dailyByDate.get(d) || 0);
  const dailyTarget = tgt > 0 ? tgt / data.daysInMonth : 0;
  const peak = dailyVals.length > 0 ? Math.max(...dailyVals) : 0;
  const peakIdx = dailyVals.indexOf(peak);
  const peakDate = peakIdx >= 0 ? sortedDates[peakIdx] : '';
  const dailyAvg = dailyVals.length > 0 ? dailyVals.reduce((s, v) => s + v, 0) / dailyVals.length : 0;
  const daysAboveTarget = dailyVals.filter(v => v >= dailyTarget).length;

  // Stats summary box
  y = drawCalloutCard(doc, INNER_X, y, INNER_W,
    `Peak ${peakDate ? prettyDate(peakDate) : '--'} at ${fmtRsLakh(peak)}.  Daily avg ${fmtRsLakh(Math.round(dailyAvg))}.  Daily target ${fmtRsLakh(Math.round(dailyTarget))}.  ${daysAboveTarget} of ${dailyVals.length} days above target.`,
    'neutral'
  );

  drawSparkline(doc, INNER_X, y, INNER_W, 36, dailyVals, dailyTarget);
  // X-axis labels
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...TEXT_TERTIARY);
  if (sortedDates.length > 0) {
    doc.text(safeText(prettyDate(sortedDates[0])), INNER_X, y + 40);
    if (sortedDates.length > 2) {
      doc.text(safeText(prettyDate(sortedDates[Math.floor(sortedDates.length / 2)])), INNER_X + INNER_W / 2, y + 40, { align: 'center' });
    }
    doc.text(safeText(prettyDate(sortedDates[sortedDates.length - 1])), INNER_X + INNER_W, y + 40, { align: 'right' });
  }
  y += 46;

  // 3-month trend (B-stub)
  y = drawSectionBar(doc, INNER_X, y + 2, '3-month trend', SECTION_PURPLE);
  y = drawCalloutCard(doc, INNER_X, y, INNER_W,
    '3-month history pending - the operational-insights endpoint currently returns one month at a time. See INSIGHT_PDF_BACKEND.md for the proposed extension.',
    'neutral'
  );

  // ── PAGE 3 — Clinic deep dive ─────────────────────────────────────
  doc.addPage();
  y = PAGE_TOP + 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_TERTIARY);
  doc.text('PAGE 3 - CLINIC DEEP DIVE', INNER_X, y, { charSpace: 0.6 });
  y += 8;

  if (clinicS && clinicPrimary) {
    // Narrative
    const visits = clinicS.cards.find(c => /visits|patients/i.test(c.label));
    const clinicNarr = `Clinic recorded ${fmtCount(visits?.mtd || 0)} visits at ${fmtRsLakh(clinicPrimary.mtd)} (${clinicPrimary.target > 0 ? `${Math.round((clinicPrimary.mtd / clinicPrimary.target) * 100)}% of target` : 'no target set'}). Avg ticket ${visits && visits.mtd > 0 ? fmtRsLakh(Math.round(clinicPrimary.mtd / visits.mtd)) : '--'}. Projected EOM ${fmtRsLakh(clinicPrimary.projected)}.`;
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...TEXT_DARK);
    const lines = doc.splitTextToSize(safeText(clinicNarr), INNER_W);
    doc.text(lines, INNER_X, y);
    y += lines.length * 4.5 + 4;

    // Stream scorecard
    y = drawSectionBar(doc, INNER_X, y + 2, 'Stream scorecard', SECTION_BLUE);
    const sRows = clinicS.cards.filter(c => c.target > 0 && c.unit !== 'percent').map(c => {
      const projPctRow = c.target > 0 ? (c.projected / c.target) * 100 : 0;
      const rowBand = statusFromProjection(projPctRow);
      return {
        metric: c.category ? `${c.category} - ${c.label}` : c.label,
        mtd: fmtValue(c.mtd, c.unit), target: fmtValue(c.target, c.unit),
        projected: fmtValue(c.projected, c.unit), band: rowBand,
      };
    });
    autoTable(doc, {
      startY: y,
      head: [['Metric', 'MTD', 'Target', 'Projected EOM', 'Status']],
      body: sRows.map(r => [r.metric, r.mtd, r.target, r.projected, '']),
      theme: 'plain',
      styles: { fontSize: 8.5, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 }, textColor: TEXT_DARK },
      headStyles: { fillColor: [255, 255, 255], textColor: TEXT_SECONDARY, fontStyle: 'bold', fontSize: 7.5, lineColor: TEXT_DARK, lineWidth: 0.4 },
      bodyStyles: { lineColor: HAIRLINE, lineWidth: 0.1 },
      columnStyles: { 0: { cellWidth: 60 }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { cellWidth: 22 } },
      didDrawCell: (hook) => {
        if (hook.section === 'body' && hook.column.index === 4) {
          const r = sRows[hook.row.index];
          if (r) drawStatusPill3(doc, hook.cell.x + 1, hook.cell.y + hook.cell.height / 2 + 1.4, r.band as StatusBand);
        }
      },
      margin: { left: INNER_X, right: pageW - (INNER_X + INNER_W) },
    });
    y = (doc as any).lastAutoTable.finalY + 5;
  }

  // Cross-tab insights stub
  y = drawSectionBar(doc, INNER_X, y + 2, 'Cross-tab insights', SECTION_PURPLE);
  y = drawCalloutCard(doc, INNER_X, y, INNER_W,
    'Cross-tab insight pending - the PDF generator does not currently fetch /dashboard/clinic-analytics. See INSIGHT_PDF_BACKEND.md for the recommended pre-fetch.',
    'neutral'
  );

  // Action for next month
  y = drawSectionBar(doc, INNER_X, y + 2, 'Action for next month', SECTION_AMBER);
  if (clinicPrimary && clinicPrimary.target > 0) {
    const gapClinic = Math.max(0, clinicPrimary.target - clinicPrimary.projected);
    if (gapClinic > 0) {
      y = drawNumberedAlert(doc, INNER_X, y, INNER_W, 1,
        `Recover ${fmtRsLakh(gapClinic)} clinic gap into next month`,
        `${clinicPrimary.label} projected at ${Math.round((clinicPrimary.projected / clinicPrimary.target) * 100)}% - tighten daily run-rate or push cross-sell.`,
        'critical'
      );
    } else {
      y = drawCalloutCard(doc, INNER_X, y, INNER_W, 'Clinic on track. Maintain current cross-sell pace.', 'neutral');
    }
  }

  // ── PAGE 4 — Pharmacy deep dive ───────────────────────────────────
  doc.addPage();
  y = PAGE_TOP + 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_TERTIARY);
  doc.text('PAGE 4 - PHARMACY DEEP DIVE', INNER_X, y, { charSpace: 0.6 });
  y += 8;

  if (pharmaS && pharmaPrimary) {
    const profit = pharmaProfitCard?.mtd || 0;
    const pharmaNarr = `Pharmacy delivered ${fmtRsLakh(pharmaPrimary.mtd)} in sales (${pharmaPrimary.target > 0 ? `${Math.round((pharmaPrimary.mtd / pharmaPrimary.target) * 100)}% of target` : 'no target set'}) with gross profit ${fmtRsLakh(profit)} at ${pharmaMargin.toFixed(1)}% margin. ${marginGap < -2 ? `Margin is ${Math.abs(marginGap).toFixed(1)}pp below the ${pharmaMarginTarget.toFixed(1)}% forecast - investigate pricing.` : 'Margin held at or above forecast.'} Projected EOM ${fmtRsLakh(pharmaPrimary.projected)}.`;
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...TEXT_DARK);
    const lines = doc.splitTextToSize(safeText(pharmaNarr), INNER_W);
    doc.text(lines, INNER_X, y);
    y += lines.length * 4.5 + 4;

    y = drawSectionBar(doc, INNER_X, y + 2, 'Sales / profit / margin', SECTION_BLUE);
    const pRows = pharmaS.cards.filter(c => c.target > 0 && c.unit !== 'percent').map(c => {
      const projPctRow = c.target > 0 ? (c.projected / c.target) * 100 : 0;
      const rowBand = statusFromProjection(projPctRow);
      return {
        metric: c.category ? `${c.category} - ${c.label}` : c.label,
        mtd: fmtValue(c.mtd, c.unit), target: fmtValue(c.target, c.unit),
        projected: fmtValue(c.projected, c.unit), band: rowBand,
      };
    });
    autoTable(doc, {
      startY: y,
      head: [['Metric', 'MTD', 'Target', 'Projected EOM', 'Status']],
      body: pRows.map(r => [r.metric, r.mtd, r.target, r.projected, '']),
      theme: 'plain',
      styles: { fontSize: 8.5, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 }, textColor: TEXT_DARK },
      headStyles: { fillColor: [255, 255, 255], textColor: TEXT_SECONDARY, fontStyle: 'bold', fontSize: 7.5, lineColor: TEXT_DARK, lineWidth: 0.4 },
      bodyStyles: { lineColor: HAIRLINE, lineWidth: 0.1 },
      columnStyles: { 0: { cellWidth: 60 }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { cellWidth: 22 } },
      didDrawCell: (hook) => {
        if (hook.section === 'body' && hook.column.index === 4) {
          const r = pRows[hook.row.index];
          if (r) drawStatusPill3(doc, hook.cell.x + 1, hook.cell.y + hook.cell.height / 2 + 1.4, r.band as StatusBand);
        }
      },
      margin: { left: INNER_X, right: pageW - (INNER_X + INNER_W) },
    });
    y = (doc as any).lastAutoTable.finalY + 5;
  }

  y = drawSectionBar(doc, INNER_X, y + 2, 'Cross-tab insights', SECTION_PURPLE);
  y = drawCalloutCard(doc, INNER_X, y, INNER_W,
    'Cross-tab insight pending - margin leak, expiry risk, supplier concentration, and money-cycle counts need a /dashboard/pharmacy-analytics pre-fetch. See INSIGHT_PDF_BACKEND.md.',
    'neutral'
  );

  y = drawSectionBar(doc, INNER_X, y + 2, 'Action for next month', SECTION_AMBER);
  if (marginGap < -2 && pharmaPrimary) {
    y = drawNumberedAlert(doc, INNER_X, y, INNER_W, 1,
      `Recover ${Math.abs(marginGap).toFixed(1)}pp pharmacy margin`,
      `Margin running ${pharmaMargin.toFixed(1)}% vs ${pharmaMarginTarget.toFixed(1)}% forecast - audit pricing on top sellers and check for tax / cogs anomalies.`,
      'critical'
    );
  } else if (pharmaPrimary && pharmaPrimary.target > 0 && pharmaPrimary.projected < pharmaPrimary.target) {
    const pharmaGap = Math.max(0, pharmaPrimary.target - pharmaPrimary.projected);
    y = drawNumberedAlert(doc, INNER_X, y, INNER_W, 1,
      `Recover ${fmtRsLakh(pharmaGap)} pharmacy sales gap`,
      `Push fast-movers and re-attempt slow drugs - see Cross-Report once the pre-fetch lands.`,
      'watch'
    );
  } else {
    y = drawCalloutCard(doc, INNER_X, y, INNER_W, 'Pharmacy on track. Maintain margin discipline.', 'neutral');
  }

  // ── PAGE 5 — Looking ahead ────────────────────────────────────────
  doc.addPage();
  y = PAGE_TOP + 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...TEXT_TERTIARY);
  doc.text('PAGE 5 - LOOKING AHEAD', INNER_X, y, { charSpace: 0.6 });
  y += 8;

  // Projection — uses the 3-month trend (deferred); fall back to current projection
  y = drawSectionBar(doc, INNER_X, y, 'Projection for next month', SECTION_BLUE);
  y = drawCalloutCard(doc, INNER_X, y, INNER_W,
    `Projection range pending the 3-month history endpoint. Current month projected to land at ${tgt > 0 ? fmtRsLakh(proj) : '--'} (${tgt > 0 ? Math.round(projPct) + '% of target' : 'no target'}). Once history is wired up, this section will surface a variance-banded forecast for next month.`,
    'neutral'
  );

  // Top 3 management actions
  y = drawSectionBar(doc, INNER_X, y + 2, 'Top management actions for next month', SECTION_AMBER);
  const mgmtActions = narrative.actions.slice(0, 3);
  for (let i = 0; i < mgmtActions.length; i++) {
    const parts = mgmtActions[i].split(' - ');
    y = drawNumberedAlert(doc, INNER_X, y, INNER_W, i + 1, parts[0], parts.slice(1).join(' - '), i === 0 ? 'critical' : 'watch');
  }
  if (mgmtActions.length === 0) {
    y = drawCalloutCard(doc, INNER_X, y, INNER_W, 'No outstanding management actions. Maintain current course.', 'neutral');
  }

  addFooter(doc, footerLabel('Monthly Insight', data.monthLabel, clientName, branchName, branchState));
  doc.save(filename('Monthly_Insight', data.month, branchName));
}

/* ──────── Component ──────── */

export default function InsightDownloadPanel({
  open, onClose, data,
  clientName = '', branchName = '', branchState = '',
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
      if (variant === 'daily') generateDailyPDF(data, clientName, branchName, branchState, logo);
      else if (variant === 'weekly') generateWeeklyPDF(data, clientName, branchName, branchState, logo);
      else generateMonthlyPDF(data, clientName, branchName, branchState, logo);
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
