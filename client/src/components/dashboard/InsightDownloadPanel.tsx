import { useState } from 'react';
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

  // "Target" tick label below the 100% mark
  doc.setFontSize(6.5);
  doc.setTextColor(...MUTED_TEXT);
  doc.text('100%', targetX, y + h + 3.8, { align: 'center' });
}

function drawMiniBarChart(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  values: number[],
  color: [number, number, number],
  targetLine?: number
) {
  if (values.length === 0) return;
  const maxVal = Math.max(...values, targetLine || 0) || 1;
  const gap = 1.2;
  const barW = Math.max((w - gap * (values.length - 1)) / values.length, 1);

  // Axis line
  doc.setDrawColor(...BAR_BG);
  doc.setLineWidth(0.3);
  doc.line(x, y + h, x + w, y + h);

  // Bars
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const bh = (v / maxVal) * h;
    const bx = x + i * (barW + gap);
    const by = y + h - bh;
    doc.setFillColor(...color);
    doc.rect(bx, by, barW, bh, 'F');
  }

  // Target line (dashed-ish — simulate with short segments)
  if (targetLine && targetLine > 0) {
    const ty = y + h - (targetLine / maxVal) * h;
    doc.setDrawColor(220, 38, 38);
    doc.setLineWidth(0.3);
    const step = 2;
    for (let lx = x; lx < x + w; lx += step * 2) {
      doc.line(lx, ty, Math.min(lx + step, x + w), ty);
    }
  }
  doc.setLineWidth(0.2);
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

/* ──────── Page chrome ──────── */

function addHeader(doc: jsPDF, title: string, subtitle: string, clientName: string) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pageW, 34, 'F');
  doc.setFillColor(...PRIMARY_DARK);
  doc.rect(0, 34, pageW, 2, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(19);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 14, 15);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(subtitle, 14, 24);

  if (clientName) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(clientName, pageW - 14, 15, { align: 'right' });
  }
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`,
    pageW - 14, 24, { align: 'right' }
  );
}

function addSectionTitle(doc: jsPDF, title: string, y: number): number {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setTextColor(...PRIMARY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(title, 14, y);
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(14, y + 1.5, pageW - 14, y + 1.5);
  doc.setLineWidth(0.2);
  return y + 8;
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

function ensureSpace(doc: jsPDF, y: number, needed = 40): number {
  const pageH = doc.internal.pageSize.getHeight();
  if (y + needed > pageH - 14) {
    doc.addPage();
    return 16;
  }
  return y;
}

/* ──────── Narrative / insight engine ──────── */

interface InsightNarrative {
  executive: string;       // one-paragraph summary
  streamInsights: string[]; // per-stream paragraph
  observations: string[];   // bullet points
  actions: string[];        // target-focused actions
}

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
    const primary = s.cards.find(c => c.label === 'Revenue' && !c.category)
      || s.cards.find(c => c.label === 'Sales')
      || s.cards[0];
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
    const primary = s.cards.find(c => c.label === 'Revenue' && !c.category) || s.cards.find(c => c.label === 'Sales');
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
    const primary = s.cards.find(c => c.label === 'Revenue' && !c.category)
      || s.cards.find(c => c.label === 'Sales');
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
      if (!actionList.some(x => x.includes(a.message))) {
        actionList.push(`${a.severity === 'RED' ? 'PRIORITY' : 'WATCH'}: ${a.message}`);
      }
    }
  }

  if (actionList.length === 0) {
    actionList.push('All metrics tracking at or above target -- maintain current operational cadence and continue monitoring.');
  }

  return { executive, streamInsights, observations, actions: actionList };
}

/* ──────── Daily PDF ──────── */

function generateDailyPDF(data: InsightsData, clientName: string) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();

  const latestDate = data.streams.flatMap(s => s.daily.map(d => d.date)).sort().pop() || '';
  const prevDate = data.streams.flatMap(s => s.daily.map(d => d.date)).filter(d => d < latestDate).sort().pop() || '';

  addHeader(
    doc,
    'Daily Operational Insight',
    `${data.monthLabel}  |  Day ${data.daysElapsed} of ${data.daysInMonth}  |  ${data.daysRemaining} days remaining`,
    clientName
  );

  let y = 44;
  const narrative = buildNarrative(data, 'daily');

  // Executive summary header row: title on the left, RAG pill on the right
  doc.setTextColor(...PRIMARY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Executive Summary', 14, y);
  drawRAGPill(doc, data.combined.rag, pageW - 58, y, 44, 7);
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(14, y + 1.5, pageW - 14, y + 1.5);
  doc.setLineWidth(0.2);
  y += 8;

  y = addParagraph(doc, narrative.executive, y, { size: 10 });
  y += 5;

  // Combined progress bar
  if (data.combined.targetRevenue > 0) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK_TEXT);
    doc.text('Combined Revenue Progress', 14, y);
    y += 5;

    const mtdPct = (data.combined.mtdRevenue / data.combined.targetRevenue) * 100;
    const projPct = (data.combined.projectedRevenue / data.combined.targetRevenue) * 100;
    drawProgressBar(doc, 14, y, pageW - 28, 7, mtdPct, projPct, ragRGB(data.combined.rag));
    y += 12;

    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED_TEXT);
    doc.text(`MTD: ${fmtRs(data.combined.mtdRevenue)} (${Math.round(mtdPct)}%)`, 14, y);
    doc.text(`Projected: ${fmtRs(data.combined.projectedRevenue)} (${Math.round(projPct)}%)`, pageW / 2, y, { align: 'center' });
    doc.text(`Target: ${fmtRs(data.combined.targetRevenue)}`, pageW - 14, y, { align: 'right' });
    y += 10;
  }

  // Per-stream day snapshot
  for (const stream of data.streams) {
    y = ensureSpace(doc, y, 90);
    y = addSectionTitle(doc, `${stream.name} - Today vs Yesterday`, y);

    const today = latestDate ? stream.daily.find(d => d.date === latestDate) : null;
    const yesterday = prevDate ? stream.daily.find(d => d.date === prevDate) : null;
    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');

    const rows: string[][] = [];
    if (isClinic) {
      rows.push(['Patients', today ? fmtCount(today.patients || 0) : '--', yesterday ? fmtCount(yesterday.patients || 0) : '--', yesterday ? pctChange(today?.patients || 0, yesterday.patients || 0) : '--']);
      rows.push(['Revenue', today ? fmtRs(today.revenue || 0) : '--', yesterday ? fmtRs(yesterday.revenue || 0) : '--', yesterday ? pctChange(today?.revenue || 0, yesterday.revenue || 0) : '--']);
    } else {
      rows.push(['Transactions', today ? fmtCount(today.transactions || 0) : '--', yesterday ? fmtCount(yesterday.transactions || 0) : '--', yesterday ? pctChange(today?.transactions || 0, yesterday.transactions || 0) : '--']);
      rows.push(['Sales', today ? fmtRs(today.revenue || 0) : '--', yesterday ? fmtRs(yesterday.revenue || 0) : '--', yesterday ? pctChange(today?.revenue || 0, yesterday.revenue || 0) : '--']);
      rows.push(['Profit', today ? fmtRs(today.profit || 0) : '--', yesterday ? fmtRs(yesterday.profit || 0) : '--', yesterday ? pctChange(today?.profit || 0, yesterday.profit || 0) : '--']);
    }

    autoTable(doc, {
      startY: y,
      head: [['Metric', latestDate ? prettyDate(latestDate) : 'Latest', prevDate ? prettyDate(prevDate) : 'Previous', 'Change']],
      body: rows,
      theme: 'grid',
      styles: { fontSize: 9.5, cellPadding: 2.5 },
      headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold', fontSize: 9 },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 35 },
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
      },
      didParseCell: (cell) => {
        if (cell.section === 'body' && cell.column.index === 3) {
          const txt = String(cell.cell.raw || '');
          if (txt.startsWith('+')) cell.cell.styles.textColor = [16, 185, 129];
          else if (txt.startsWith('-')) cell.cell.styles.textColor = [220, 38, 38];
        }
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 4;

    // Pace table
    const paceRows: string[][] = [];
    for (const card of stream.cards) {
      if (card.target === 0 || card.unit === 'percent') continue;
      const dailyTarget = Math.round(card.target / data.daysInMonth);
      const aheadMtd = card.mtd >= card.target;
      const onPace = card.requiredRate <= card.dailyRate;
      const status = aheadMtd ? 'EXCEEDED' : onPace ? 'ON PACE' : 'BEHIND';
      paceRows.push([
        card.category ? `${card.category} - ${card.label}` : card.label,
        fmtValue(card.mtd, card.unit),
        fmtValue(card.target, card.unit),
        fmtValue(dailyTarget, card.unit),
        fmtValue(card.dailyRate, card.unit),
        aheadMtd ? '--' : fmtValue(Math.max(card.requiredRate, 0), card.unit),
        status,
      ]);
    }

    if (paceRows.length > 0) {
      autoTable(doc, {
        startY: y,
        head: [['KPI', 'MTD', 'Monthly Goal', 'Daily Target', 'Actual/day', 'Required/day', 'Status']],
        body: paceRows,
        theme: 'grid',
        styles: { fontSize: 8.5, cellPadding: 2 },
        headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold', fontSize: 8.5 },
        columnStyles: {
          0: { fontStyle: 'bold', cellWidth: 42 },
          1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
          4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'center', fontStyle: 'bold' },
        },
        didParseCell: (d) => {
          if (d.section === 'body' && d.column.index === 6) {
            if (d.cell.raw === 'ON PACE' || d.cell.raw === 'EXCEEDED') d.cell.styles.textColor = [16, 185, 129];
            if (d.cell.raw === 'BEHIND') d.cell.styles.textColor = [220, 38, 38];
          }
        },
        margin: { left: 14, right: 14 },
      });
      y = (doc as any).lastAutoTable.finalY + 6;
    }
  }

  // Key observations
  y = ensureSpace(doc, y, 50);
  y = addSectionTitle(doc, 'Key Observations', y);
  for (const obs of narrative.observations.slice(0, 5)) {
    y = ensureSpace(doc, y, 10);
    y = addParagraph(doc, '>  ' + obs, y, { size: 9.5 });
    y += 1;
  }
  y += 2;

  // Action items
  y = ensureSpace(doc, y, 50);
  y = addSectionTitle(doc, "Today's Actions", y);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Action Required']],
    body: narrative.actions.map((r, i) => [String(i + 1), r]),
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 2.8 },
    headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
    margin: { left: 14, right: 14 },
  });

  addFooter(doc, `Daily Insight  |  ${data.monthLabel}  |  ${clientName}`);
  doc.save(`Daily_Insight_${data.month}_${latestDate || 'today'}.pdf`);
}

/* ──────── Weekly PDF ──────── */

function generateWeeklyPDF(data: InsightsData, clientName: string) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();

  addHeader(
    doc,
    'Weekly Operational Insight',
    `${data.monthLabel}  |  Day ${data.daysElapsed} of ${data.daysInMonth}  |  ${data.daysRemaining} days remaining`,
    clientName
  );

  let y = 44;
  const narrative = buildNarrative(data, 'weekly');

  // Executive summary header row: title on the left, RAG pill on the right
  doc.setTextColor(...PRIMARY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Executive Summary', 14, y);
  drawRAGPill(doc, data.combined.rag, pageW - 58, y, 44, 7);
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(14, y + 1.5, pageW - 14, y + 1.5);
  doc.setLineWidth(0.2);
  y += 8;

  y = addParagraph(doc, narrative.executive, y, { size: 10 });
  y += 5;

  for (const stream of data.streams) {
    y = ensureSpace(doc, y, 80);
    y = addSectionTitle(doc, `${stream.name} - Week over Week`, y);

    // Narrative for stream
    const narr = narrative.streamInsights.find(n => n.startsWith(`${stream.name}:`));
    if (narr) {
      y = addParagraph(doc, narr, y, { size: 9.5 });
      y += 2;
    }

    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');
    const tw = stream.thisWeek;
    const lw = stream.lastWeek;

    const rows: string[][] = isClinic ? [
      ['Patients', fmtCount(tw.patients), fmtCount(lw.patients), pctChange(tw.patients, lw.patients)],
      ['Revenue', fmtRs(tw.revenue), fmtRs(lw.revenue), pctChange(tw.revenue, lw.revenue)],
      ['Avg Ticket', fmtRs(tw.avgTicket), fmtRs(lw.avgTicket), pctChange(tw.avgTicket, lw.avgTicket)],
    ] : [
      ['Transactions', fmtCount(tw.transactions), fmtCount(lw.transactions), pctChange(tw.transactions, lw.transactions)],
      ['Sales', fmtRs(tw.revenue), fmtRs(lw.revenue), pctChange(tw.revenue, lw.revenue)],
      ['Profit', fmtRs(tw.profit), fmtRs(lw.profit), pctChange(tw.profit, lw.profit)],
      ['Avg Ticket', fmtRs(tw.avgTicket), fmtRs(lw.avgTicket), pctChange(tw.avgTicket, lw.avgTicket)],
    ];

    autoTable(doc, {
      startY: y,
      head: [['Metric', 'This Week', 'Last Week', 'WoW Change']],
      body: rows,
      theme: 'grid',
      styles: { fontSize: 9.5, cellPadding: 2.5 },
      headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold' },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 35 },
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
      },
      didParseCell: (cell) => {
        if (cell.section === 'body' && cell.column.index === 3) {
          const txt = String(cell.cell.raw || '');
          if (txt.startsWith('+')) cell.cell.styles.textColor = [16, 185, 129];
          else if (txt.startsWith('-')) cell.cell.styles.textColor = [220, 38, 38];
        }
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 4;

    // Visual comparison bars — primary revenue
    y = ensureSpace(doc, y, 30);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK_TEXT);
    doc.text('Visual Comparison (revenue)', 14, y);
    y += 4;
    const maxRev = Math.max(tw.revenue, lw.revenue, 1);
    const barMaxW = pageW - 70;
    // this week
    const twW = (tw.revenue / maxRev) * barMaxW;
    doc.setFillColor(...PRIMARY);
    doc.rect(50, y - 3, twW, 5, 'F');
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...DARK_TEXT);
    doc.text('This Week', 14, y + 1);
    doc.text(fmtRs(tw.revenue), 50 + twW + 2, y + 1);
    y += 7;
    // last week
    const lwW = (lw.revenue / maxRev) * barMaxW;
    doc.setFillColor(148, 163, 184);
    doc.rect(50, y - 3, lwW, 5, 'F');
    doc.text('Last Week', 14, y + 1);
    doc.text(fmtRs(lw.revenue), 50 + lwW + 2, y + 1);
    y += 10;

    // Daily breakdown chart (this month so far)
    if (stream.daily.length > 0) {
      y = ensureSpace(doc, y, 40);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...DARK_TEXT);
      doc.text(`${stream.name} - Daily Revenue Trend (${stream.daily.length} days)`, 14, y);
      y += 3;
      const revs = stream.daily.map(d => d.revenue || 0);
      const primary = stream.cards.find(c => c.label === 'Revenue' && !c.category) || stream.cards.find(c => c.label === 'Sales');
      const dailyTarget = primary && primary.target > 0 ? primary.target / data.daysInMonth : 0;
      drawMiniBarChart(doc, 14, y, pageW - 28, 25, revs, PRIMARY, dailyTarget);
      y += 27;
      doc.setFontSize(7.5);
      doc.setTextColor(...MUTED_TEXT);
      doc.text(`${prettyDate(stream.daily[0].date)}`, 14, y);
      doc.text(`${prettyDate(stream.daily[stream.daily.length - 1].date)}`, pageW - 14, y, { align: 'right' });
      if (dailyTarget > 0) {
        doc.setTextColor(220, 38, 38);
        doc.text(`Red dashed line = daily target ${fmtRs(dailyTarget)}`, pageW / 2, y, { align: 'center' });
      }
      y += 6;
    }
  }

  // Observations
  y = ensureSpace(doc, y, 50);
  y = addSectionTitle(doc, 'Weekly Observations', y);
  for (const obs of narrative.observations) {
    y = ensureSpace(doc, y, 10);
    y = addParagraph(doc, '>  ' + obs, y, { size: 9.5 });
    y += 1;
  }
  y += 2;

  // Actions
  y = ensureSpace(doc, y, 50);
  y = addSectionTitle(doc, 'Focus Areas for Next Week', y);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Recommendation']],
    body: narrative.actions.map((r, i) => [String(i + 1), r]),
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 2.8 },
    headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
    margin: { left: 14, right: 14 },
  });

  addFooter(doc, `Weekly Insight  |  ${data.monthLabel}  |  ${clientName}`);
  doc.save(`Weekly_Insight_${data.month}.pdf`);
}

/* ──────── Monthly PDF ──────── */

function generateMonthlyPDF(data: InsightsData, clientName: string) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();

  addHeader(
    doc,
    'Monthly / MTD Operational Insight',
    `${data.monthLabel}  |  Day ${data.daysElapsed} of ${data.daysInMonth}  |  ${data.daysRemaining} days remaining`,
    clientName
  );

  let y = 44;
  const narrative = buildNarrative(data, 'monthly');

  // Executive summary header row: title on the left, RAG pill on the right
  doc.setTextColor(...PRIMARY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Executive Summary', 14, y);
  drawRAGPill(doc, data.combined.rag, pageW - 58, y, 44, 7);
  doc.setDrawColor(...PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(14, y + 1.5, pageW - 14, y + 1.5);
  doc.setLineWidth(0.2);
  y += 8;

  y = addParagraph(doc, narrative.executive, y, { size: 10 });
  y += 5;

  // Combined revenue visual
  if (data.combined.targetRevenue > 0) {
    y = ensureSpace(doc, y, 35);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK_TEXT);
    doc.text('Combined Revenue Progress', 14, y);
    y += 5;

    const mtdPct = (data.combined.mtdRevenue / data.combined.targetRevenue) * 100;
    const projPct = (data.combined.projectedRevenue / data.combined.targetRevenue) * 100;
    drawProgressBar(doc, 14, y, pageW - 28, 9, mtdPct, projPct, ragRGB(data.combined.rag));
    y += 12;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED_TEXT);
    doc.text(`MTD: ${fmtRs(data.combined.mtdRevenue)} (${Math.round(mtdPct)}%)`, 14, y);
    doc.text(`Projected: ${fmtRs(data.combined.projectedRevenue)} (${Math.round(projPct)}%)`, pageW / 2, y, { align: 'center' });
    doc.text(`Target: ${fmtRs(data.combined.targetRevenue)}`, pageW - 14, y, { align: 'right' });
    y += 6;

    // Summary table
    autoTable(doc, {
      startY: y,
      body: [
        ['MTD Revenue', fmtRs(data.combined.mtdRevenue), `${Math.round(mtdPct)}% of target`],
        ['Monthly Target', fmtRs(data.combined.targetRevenue), ''],
        ['Projected EOM', fmtRs(data.combined.projectedRevenue), `${Math.round(projPct)}% of target`],
        ['Gap to Target', fmtRs(Math.max(data.combined.targetRevenue - data.combined.projectedRevenue, 0)), `${data.daysRemaining} days remaining`],
        ['Status', ragLabel(data.combined.rag), ''],
      ],
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 2.2 },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 50, textColor: DARK_TEXT },
        1: { halign: 'right', cellWidth: 55, fontStyle: 'bold' },
        2: { cellWidth: 'auto', textColor: MUTED_TEXT },
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  } else {
    doc.setFontSize(9);
    doc.setTextColor(...MUTED_TEXT);
    doc.text('No monthly target configured. Showing actuals only.', 14, y);
    y += 6;
  }

  // Per-stream detail
  for (let idx = 0; idx < data.streams.length; idx++) {
    const stream = data.streams[idx];
    y = ensureSpace(doc, y, 110);
    y = addSectionTitle(doc, `${stream.name} - Detailed Performance`, y);

    // Stream narrative
    const narr = narrative.streamInsights[idx];
    if (narr) {
      y = addParagraph(doc, narr, y, { size: 10 });
      y += 3;
    }

    // KPI table
    const kpiRows: string[][] = [];
    for (const card of stream.cards) {
      if (card.unit === 'percent') {
        kpiRows.push([
          card.category ? `${card.category} - ${card.label}` : card.label,
          fmtValue(card.mtd, card.unit),
          card.target > 0 ? `Fcst: ${fmtValue(card.target, card.unit)}` : '--',
          '--', '--', '--',
          ragLabel(card.rag),
        ]);
      } else {
        const aheadMtd = card.mtd >= card.target && card.target > 0;
        const onPace = card.requiredRate <= card.dailyRate;
        const status =
          card.target === 0 ? 'N/A' :
          aheadMtd ? 'EXCEEDED' :
          onPace ? 'ON PACE' : 'BEHIND';
        const requiredDisplay =
          card.target === 0 ? '--' :
          aheadMtd ? '--' :
          fmtValue(Math.max(card.requiredRate, 0), card.unit);
        kpiRows.push([
          card.category ? `${card.category} - ${card.label}` : card.label,
          fmtValue(card.mtd, card.unit),
          card.target > 0 ? fmtValue(card.target, card.unit) : '--',
          fmtValue(card.projected, card.unit),
          fmtValue(card.dailyRate, card.unit),
          requiredDisplay,
          status,
        ]);
      }
    }

    autoTable(doc, {
      startY: y,
      head: [['KPI', 'MTD', 'Target', 'Projected', 'Actual/day', 'Required/day', 'Status']],
      body: kpiRows,
      theme: 'grid',
      styles: { fontSize: 8.5, cellPadding: 2 },
      headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold', fontSize: 8.5 },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 42 },
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
        4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'center', fontStyle: 'bold' },
      },
      didParseCell: (cell) => {
        if (cell.section === 'body' && cell.column.index === 6) {
          const txt = String(cell.cell.raw || '');
          if (txt === 'ON PACE' || txt === 'ON TRACK' || txt === 'EXCEEDED') cell.cell.styles.textColor = [16, 185, 129];
          else if (txt === 'BEHIND' || txt === 'BEHIND TARGET') cell.cell.styles.textColor = [220, 38, 38];
          else if (txt === 'NEEDS ATTENTION') cell.cell.styles.textColor = [245, 158, 11];
        }
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 5;

    // Per-card progress bars for ones with targets
    y = ensureSpace(doc, y, 40);
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK_TEXT);
    doc.text('Target Progress Visualization', 14, y);
    y += 4;

    for (const card of stream.cards) {
      if (card.target === 0 || card.unit === 'percent') continue;
      y = ensureSpace(doc, y, 12);
      const pct = (card.mtd / card.target) * 100;
      const projPct = (card.projected / card.target) * 100;
      const label = card.category ? `${card.category} ${card.label}` : card.label;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...DARK_TEXT);
      doc.text(label, 14, y);
      doc.text(`${Math.round(pct)}%`, pageW - 14, y, { align: 'right' });
      drawProgressBar(doc, 14, y + 1.5, pageW - 28, 4, pct, projPct, ragRGB(card.rag));
      y += 8;
    }
    y += 2;

    // Daily trend chart
    if (stream.daily.length > 0) {
      y = ensureSpace(doc, y, 45);
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...DARK_TEXT);
      doc.text(`Daily Revenue Trend (${stream.daily.length} days)`, 14, y);
      y += 3;
      const revs = stream.daily.map(d => d.revenue || 0);
      const primary = stream.cards.find(c => c.label === 'Revenue' && !c.category) || stream.cards.find(c => c.label === 'Sales');
      const dailyTarget = primary && primary.target > 0 ? primary.target / data.daysInMonth : 0;
      drawMiniBarChart(doc, 14, y, pageW - 28, 28, revs, PRIMARY, dailyTarget);
      y += 30;
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...MUTED_TEXT);
      doc.text(prettyDate(stream.daily[0].date), 14, y);
      doc.text(prettyDate(stream.daily[stream.daily.length - 1].date), pageW - 14, y, { align: 'right' });
      if (dailyTarget > 0) {
        doc.setTextColor(220, 38, 38);
        doc.text(`Red dashed line = daily target ${fmtRs(dailyTarget)}`, pageW / 2, y, { align: 'center' });
      }
      y += 6;
    }

    // Week-over-week stripe
    y = ensureSpace(doc, y, 35);
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK_TEXT);
    doc.text('This Week vs Last Week', 14, y);
    y += 3;

    const tw = stream.thisWeek;
    const lw = stream.lastWeek;
    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');
    const wowRows: string[][] = isClinic ? [
      ['Patients', fmtCount(tw.patients), fmtCount(lw.patients), pctChange(tw.patients, lw.patients)],
      ['Revenue', fmtRs(tw.revenue), fmtRs(lw.revenue), pctChange(tw.revenue, lw.revenue)],
    ] : [
      ['Transactions', fmtCount(tw.transactions), fmtCount(lw.transactions), pctChange(tw.transactions, lw.transactions)],
      ['Sales', fmtRs(tw.revenue), fmtRs(lw.revenue), pctChange(tw.revenue, lw.revenue)],
      ['Profit', fmtRs(tw.profit), fmtRs(lw.profit), pctChange(tw.profit, lw.profit)],
    ];

    autoTable(doc, {
      startY: y,
      head: [['Metric', 'This Week', 'Last Week', 'Change']],
      body: wowRows,
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold' },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 35 },
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
      },
      didParseCell: (cell) => {
        if (cell.section === 'body' && cell.column.index === 3) {
          const txt = String(cell.cell.raw || '');
          if (txt.startsWith('+')) cell.cell.styles.textColor = [16, 185, 129];
          else if (txt.startsWith('-')) cell.cell.styles.textColor = [220, 38, 38];
        }
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // Key Observations
  y = ensureSpace(doc, y, 60);
  y = addSectionTitle(doc, 'Key Observations & Insights', y);
  for (const obs of narrative.observations) {
    y = ensureSpace(doc, y, 10);
    y = addParagraph(doc, '>  ' + obs, y, { size: 9.5 });
    y += 1;
  }
  y += 3;

  // Management Actions
  y = ensureSpace(doc, y, 50);
  y = addSectionTitle(doc, 'Management Actions to Achieve Monthly Target', y);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Action / Recommendation']],
    body: narrative.actions.map((r, i) => [String(i + 1), r]),
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 2.8 },
    headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
    margin: { left: 14, right: 14 },
  });

  addFooter(doc, `Monthly Insight  |  ${data.monthLabel}  |  ${clientName}`);
  doc.save(`Monthly_Insight_${data.month}.pdf`);
}

/* ──────── Component ──────── */

export default function InsightDownloadPanel({ open, onClose, data, clientName = '' }: Props) {
  const [variant, setVariant] = useState<ReportVariant>('monthly');
  const [generating, setGenerating] = useState(false);

  const handleDownload = async () => {
    setGenerating(true);
    try {
      if (variant === 'daily') generateDailyPDF(data, clientName);
      else if (variant === 'weekly') generateWeeklyPDF(data, clientName);
      else generateMonthlyPDF(data, clientName);
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
