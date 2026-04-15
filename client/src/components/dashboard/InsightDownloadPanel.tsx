import { useState } from 'react';
import { X, Download, Calendar, CalendarDays, CalendarRange } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatINR, formatNumber } from '../../utils/format';

/* ──────── Types (mirror OperationalInsightsPage) ──────── */

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

/* ──────── Format helpers ──────── */

function fmtVal(v: number, unit: string) {
  if (unit === 'currency') return formatINR(v);
  if (unit === 'percent') return `${v}%`;
  return formatNumber(v);
}

function pctChange(cur: number, prev: number): string {
  if (!prev) return '—';
  const delta = ((cur - prev) / prev) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

function pretty(d: string): string {
  // 2026-04-15 → 15 Apr 2026
  const [y, m, day] = d.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parseInt(day)} ${months[parseInt(m)]} ${y}`;
}

function ragLabel(rag: string): string {
  switch (rag) {
    case 'GREEN': return 'On Track';
    case 'AMBER': return 'Needs Attention';
    case 'RED': return 'Behind Target';
    default: return 'No Target';
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

/* ──────── PDF builders ──────── */

const PRIMARY: [number, number, number] = [13, 148, 136]; // teal
const LIGHT_BG: [number, number, number] = [241, 245, 249];
const DARK_TEXT: [number, number, number] = [30, 41, 59];
const MUTED_TEXT: [number, number, number] = [100, 116, 139];

function addHeader(doc: jsPDF, title: string, subtitle: string, clientName: string) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pageW, 32, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 14, 14);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(subtitle, 14, 22);

  if (clientName) {
    doc.text(clientName, pageW - 14, 14, { align: 'right' });
  }
  doc.setFontSize(8);
  doc.text(
    `Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`,
    pageW - 14,
    22,
    { align: 'right' }
  );
}

function addSectionTitle(doc: jsPDF, title: string, y: number): number {
  doc.setTextColor(...DARK_TEXT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(title, 14, y);
  return y + 6;
}

function addFooter(doc: jsPDF, label: string) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(...MUTED_TEXT);
    doc.text(label, 14, pageH - 8);
    doc.text(`Page ${p} of ${n}`, pageW - 14, pageH - 8, { align: 'right' });
  }
}

function addRAGBadge(doc: jsPDF, rag: string, x: number, y: number) {
  const [r, g, b] = ragRGB(rag);
  const label = ragLabel(rag);
  doc.setFillColor(r, g, b);
  doc.roundedRect(x, y - 4, 40, 6, 1.5, 1.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(label, x + 20, y, { align: 'center' });
  doc.setFont('helvetica', 'normal');
}

function pickTargetRow(card: CardData, daysInMonth: number): {
  mtdPct: number;
  projPct: number;
  onPace: boolean;
  gap: number;
  dailyTarget: number;
} {
  const mtdPct = card.target > 0 ? (card.mtd / card.target) * 100 : 0;
  const projPct = card.target > 0 ? (card.projected / card.target) * 100 : 0;
  const onPace = card.requiredRate <= card.dailyRate && card.target > 0;
  const gap = Math.max(card.target - card.mtd, 0);
  const dailyTarget = card.target > 0 ? Math.round(card.target / daysInMonth) : 0;
  return { mtdPct, projPct, onPace, gap, dailyTarget };
}

/* ── Recommendation engine ────────────────────────── */

function buildRecommendations(data: InsightsData, variant: ReportVariant): string[] {
  const recs: string[] = [];
  const { streams, combined, daysRemaining, actions } = data;

  // Combined target health
  if (combined.targetRevenue > 0) {
    const combinedPct = (combined.projectedRevenue / combined.targetRevenue) * 100;
    if (combinedPct < 80) {
      const gap = combined.targetRevenue - combined.mtdRevenue;
      const dailyNeed = daysRemaining > 0 ? gap / daysRemaining : 0;
      recs.push(
        `URGENT: Combined revenue projection is ${Math.round(combinedPct)}% of monthly target. ` +
        `Close the ${formatINR(gap)} gap by driving ${formatINR(dailyNeed)}/day over the remaining ${daysRemaining} days.`
      );
    } else if (combinedPct < 95) {
      recs.push(
        `Combined revenue is tracking at ${Math.round(combinedPct)}% of target. ` +
        `Maintain current pace and add focused initiatives to close the remaining gap.`
      );
    }
  }

  // Per-stream analysis
  for (const s of streams) {
    const primaryCard = s.cards.find(c => c.label === 'Revenue' && !c.category) || s.cards.find(c => c.label === 'Sales') || s.cards[0];
    if (!primaryCard) continue;

    if (primaryCard.rag === 'RED' && primaryCard.target > 0) {
      const gap = primaryCard.target - primaryCard.mtd;
      recs.push(
        `${s.name}: RED — ${Math.round((primaryCard.projected / primaryCard.target) * 100)}% projected vs target. ` +
        `Required daily pace: ${fmtVal(primaryCard.requiredRate, primaryCard.unit)} (currently ${fmtVal(primaryCard.dailyRate, primaryCard.unit)}). Gap: ${fmtVal(gap, primaryCard.unit)}.`
      );
    }

    // WoW analysis
    const tw = s.thisWeek.revenue;
    const lw = s.lastWeek.revenue;
    if (lw > 0 && tw > 0) {
      const wow = ((tw - lw) / lw) * 100;
      if (wow < -10 && (variant === 'weekly' || variant === 'daily')) {
        recs.push(
          `${s.name}: Weekly revenue dropped ${Math.abs(Math.round(wow))}% vs last week (${formatINR(tw)} vs ${formatINR(lw)}). ` +
          `Investigate root cause — patient flow, marketing, or operational disruption.`
        );
      } else if (wow > 15) {
        recs.push(
          `${s.name}: Strong week — revenue up ${Math.round(wow)}% vs last week. Identify what drove the lift and replicate.`
        );
      }
    }

    // Category-level calls (clinic)
    const catCards = s.cards.filter(c => c.category);
    for (const cc of catCards) {
      if (cc.rag === 'RED' && cc.target > 0) {
        recs.push(
          `${s.name} → ${cc.category}: ${cc.label} behind target (${fmtVal(cc.mtd, cc.unit)} / ${fmtVal(cc.target, cc.unit)}). ` +
          `Required pace: ${fmtVal(cc.requiredRate, cc.unit)}/day.`
        );
      }
    }
  }

  // Include action items from API
  for (const a of actions) {
    if (a.severity === 'RED' || a.severity === 'AMBER') {
      if (!recs.some(r => r.includes(a.message))) {
        recs.push(`${a.severity === 'RED' ? 'PRIORITY' : 'WATCH'}: ${a.message}`);
      }
    }
  }

  if (recs.length === 0) {
    recs.push('All monitored metrics are tracking at or above target. Maintain current operational cadence.');
  }

  return recs;
}

/* ── Daily Insights PDF ───────────────────────────── */

function generateDailyPDF(data: InsightsData, clientName: string) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  // Determine "today" as the latest daily record we have
  const latestDate = data.streams
    .flatMap(s => s.daily.map(d => d.date))
    .sort()
    .pop() || '';
  const prevDate = data.streams
    .flatMap(s => s.daily.map(d => d.date))
    .filter(d => d < latestDate)
    .sort()
    .pop() || '';

  addHeader(
    doc,
    'Daily Operational Insight',
    `${data.monthLabel} • Day ${data.daysElapsed} of ${data.daysInMonth} • ${data.daysRemaining} days remaining`,
    clientName
  );

  let y = 42;

  // Snapshot header line
  doc.setTextColor(...DARK_TEXT);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(`Snapshot for ${latestDate ? pretty(latestDate) : 'today'}`, 14, y);
  y += 4;
  addRAGBadge(doc, data.combined.rag, pageW - 54, y);
  y += 6;

  // MTD combined pace context
  if (data.combined.targetRevenue > 0) {
    const combinedPct = Math.round((data.combined.mtdRevenue / data.combined.targetRevenue) * 100);
    const projPct = Math.round((data.combined.projectedRevenue / data.combined.targetRevenue) * 100);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED_TEXT);
    doc.text(
      `Combined MTD: ${formatINR(data.combined.mtdRevenue)} (${combinedPct}%) • Projected EOM: ${formatINR(data.combined.projectedRevenue)} (${projPct}% of target)`,
      14, y
    );
    y += 8;
  }

  // Per-stream: today's numbers vs yesterday vs required daily
  for (const stream of data.streams) {
    y = addSectionTitle(doc, stream.name, y);

    const today = latestDate ? stream.daily.find(d => d.date === latestDate) : null;
    const yesterday = prevDate ? stream.daily.find(d => d.date === prevDate) : null;

    // Today vs yesterday summary table
    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');
    const tableRows: string[][] = [];
    if (isClinic) {
      tableRows.push([
        'Patients',
        today ? formatNumber(today.patients || 0) : '—',
        yesterday ? formatNumber(yesterday.patients || 0) : '—',
        yesterday ? pctChange(today?.patients || 0, yesterday.patients || 0) : '—',
      ]);
      tableRows.push([
        'Revenue',
        today ? formatINR(today.revenue || 0) : '—',
        yesterday ? formatINR(yesterday.revenue || 0) : '—',
        yesterday ? pctChange(today?.revenue || 0, yesterday.revenue || 0) : '—',
      ]);
    } else {
      tableRows.push([
        'Transactions',
        today ? formatNumber(today.transactions || 0) : '—',
        yesterday ? formatNumber(yesterday.transactions || 0) : '—',
        yesterday ? pctChange(today?.transactions || 0, yesterday.transactions || 0) : '—',
      ]);
      tableRows.push([
        'Sales',
        today ? formatINR(today.revenue || 0) : '—',
        yesterday ? formatINR(yesterday.revenue || 0) : '—',
        yesterday ? pctChange(today?.revenue || 0, yesterday.revenue || 0) : '—',
      ]);
      tableRows.push([
        'Profit',
        today ? formatINR(today.profit || 0) : '—',
        yesterday ? formatINR(yesterday.profit || 0) : '—',
        yesterday ? pctChange(today?.profit || 0, yesterday.profit || 0) : '—',
      ]);
    }

    autoTable(doc, {
      startY: y,
      head: [['Metric', latestDate ? pretty(latestDate) : 'Today', prevDate ? pretty(prevDate) : 'Prev Day', 'Change']],
      body: tableRows,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold' },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 35 },
        1: { halign: 'right' },
        2: { halign: 'right' },
        3: { halign: 'right' },
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 4;

    // Required pace table per card
    const paceRows: string[][] = [];
    for (const card of stream.cards) {
      if (card.target === 0 || card.unit === 'percent') continue;
      const { dailyTarget, onPace } = pickTargetRow(card, data.daysInMonth);
      paceRows.push([
        card.category ? `${card.category} — ${card.label}` : card.label,
        fmtVal(card.mtd, card.unit),
        fmtVal(card.target, card.unit),
        fmtVal(dailyTarget, card.unit),
        fmtVal(card.dailyRate, card.unit),
        fmtVal(card.requiredRate, card.unit),
        onPace ? 'ON PACE' : 'BEHIND',
      ]);
    }

    if (paceRows.length > 0) {
      autoTable(doc, {
        startY: y,
        head: [['Target', 'MTD', 'Monthly Goal', 'Daily Target', 'Actual Pace', 'Required', 'Status']],
        body: paceRows,
        theme: 'grid',
        styles: { fontSize: 7.5, cellPadding: 1.8 },
        headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold' },
        columnStyles: {
          0: { fontStyle: 'bold', cellWidth: 40 },
          1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
          4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'center' },
        },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 6) {
            if (data.cell.raw === 'ON PACE') data.cell.styles.textColor = [16, 185, 129];
            if (data.cell.raw === 'BEHIND') data.cell.styles.textColor = [220, 38, 38];
          }
        },
        margin: { left: 14, right: 14 },
      });
      y = (doc as any).lastAutoTable.finalY + 8;
    }

    if (y > pageH - 60) { doc.addPage(); y = 16; }
  }

  // Recommendations
  if (y > pageH - 60) { doc.addPage(); y = 16; }
  y = addSectionTitle(doc, "Today's Action Items", y);
  const recs = buildRecommendations(data, 'daily');
  autoTable(doc, {
    startY: y,
    head: [['#', 'Action Required']],
    body: recs.map((r, i) => [String(i + 1), r]),
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
    margin: { left: 14, right: 14 },
  });

  addFooter(doc, `Daily Insight • ${data.monthLabel} • ${clientName}`);
  doc.save(`Daily_Insight_${data.month}_${latestDate || 'today'}.pdf`);
}

/* ── Weekly Insights PDF ──────────────────────────── */

function generateWeeklyPDF(data: InsightsData, clientName: string) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  addHeader(
    doc,
    'Weekly Operational Insight',
    `${data.monthLabel} • Day ${data.daysElapsed} of ${data.daysInMonth} • ${data.daysRemaining} days remaining`,
    clientName
  );

  let y = 42;

  // Combined summary line
  doc.setTextColor(...DARK_TEXT);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Week-over-Week Performance', 14, y);
  y += 4;
  addRAGBadge(doc, data.combined.rag, pageW - 54, y);
  y += 6;

  for (const stream of data.streams) {
    y = addSectionTitle(doc, stream.name, y);

    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');
    const tw = stream.thisWeek;
    const lw = stream.lastWeek;

    const rows: string[][] = isClinic ? [
      ['Patients', formatNumber(tw.patients), formatNumber(lw.patients), pctChange(tw.patients, lw.patients)],
      ['Revenue', formatINR(tw.revenue), formatINR(lw.revenue), pctChange(tw.revenue, lw.revenue)],
      ['Avg Ticket', formatINR(tw.avgTicket), formatINR(lw.avgTicket), pctChange(tw.avgTicket, lw.avgTicket)],
    ] : [
      ['Transactions', formatNumber(tw.transactions), formatNumber(lw.transactions), pctChange(tw.transactions, lw.transactions)],
      ['Sales', formatINR(tw.revenue), formatINR(lw.revenue), pctChange(tw.revenue, lw.revenue)],
      ['Profit', formatINR(tw.profit), formatINR(lw.profit), pctChange(tw.profit, lw.profit)],
      ['Avg Ticket', formatINR(tw.avgTicket), formatINR(lw.avgTicket), pctChange(tw.avgTicket, lw.avgTicket)],
    ];

    autoTable(doc, {
      startY: y,
      head: [['Metric', 'This Week', 'Last Week', 'WoW Change']],
      body: rows,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
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

    // Weekly pace context — how this week fits into the monthly target
    const primary = stream.cards.find(c => c.label === 'Revenue' && !c.category) || stream.cards.find(c => c.label === 'Sales');
    if (primary && primary.target > 0) {
      const weeksInMonth = data.daysInMonth / 7;
      const weeklyTarget = primary.target / weeksInMonth;
      const weeksRemaining = Math.max(data.daysRemaining / 7, 0.1);
      const gap = Math.max(primary.target - primary.mtd, 0);
      const weeklyNeed = gap / weeksRemaining;

      doc.setFontSize(9);
      doc.setTextColor(...MUTED_TEXT);
      doc.setFont('helvetica', 'normal');
      const lines = [
        `Weekly Target: ${formatINR(weeklyTarget)}  •  This Week Actual: ${formatINR(tw.revenue)}  •  Delta: ${formatINR(tw.revenue - weeklyTarget)}`,
        `Required weekly pace to close the MTD gap: ${formatINR(weeklyNeed)} for the remaining ${Math.ceil(weeksRemaining * 10) / 10} weeks.`,
      ];
      for (const line of lines) {
        doc.text(line, 14, y);
        y += 4;
      }
      y += 4;
    }

    if (y > pageH - 70) { doc.addPage(); y = 16; }
  }

  // Recommendations
  if (y > pageH - 60) { doc.addPage(); y = 16; }
  y = addSectionTitle(doc, 'Focus Areas for Next Week', y);
  const recs = buildRecommendations(data, 'weekly');
  autoTable(doc, {
    startY: y,
    head: [['#', 'Recommendation']],
    body: recs.map((r, i) => [String(i + 1), r]),
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
    margin: { left: 14, right: 14 },
  });

  addFooter(doc, `Weekly Insight • ${data.monthLabel} • ${clientName}`);
  doc.save(`Weekly_Insight_${data.month}.pdf`);
}

/* ── Monthly/MTD Insights PDF ─────────────────────── */

function generateMonthlyPDF(data: InsightsData, clientName: string) {
  const doc = new jsPDF({ orientation: 'portrait', format: 'a4', unit: 'mm' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  addHeader(
    doc,
    'Monthly / MTD Operational Insight',
    `${data.monthLabel} • Day ${data.daysElapsed} of ${data.daysInMonth} • ${data.daysRemaining} days remaining`,
    clientName
  );

  let y = 42;

  // Combined Revenue Summary
  y = addSectionTitle(doc, 'Combined Revenue Summary', y);

  if (data.combined.targetRevenue > 0) {
    const mtdPct = Math.round((data.combined.mtdRevenue / data.combined.targetRevenue) * 100);
    const projPct = Math.round((data.combined.projectedRevenue / data.combined.targetRevenue) * 100);
    autoTable(doc, {
      startY: y,
      body: [
        ['MTD Revenue', formatINR(data.combined.mtdRevenue), `${mtdPct}% of target`],
        ['Monthly Target', formatINR(data.combined.targetRevenue), '—'],
        ['Projected EOM', formatINR(data.combined.projectedRevenue), `${projPct}% of target`],
        ['Gap to Target', formatINR(Math.max(data.combined.targetRevenue - data.combined.projectedRevenue, 0)), `${data.daysRemaining} days remaining`],
        ['Status', ragLabel(data.combined.rag), ''],
      ],
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 2 },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 45, textColor: DARK_TEXT },
        1: { halign: 'right', cellWidth: 50, fontStyle: 'bold' },
        2: { cellWidth: 'auto', textColor: MUTED_TEXT },
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 8;
  } else {
    doc.setFontSize(9);
    doc.setTextColor(...MUTED_TEXT);
    doc.text('No monthly target set. Showing actuals only.', 14, y);
    y += 6;
    autoTable(doc, {
      startY: y,
      body: [
        ['MTD Revenue', formatINR(data.combined.mtdRevenue)],
        ['Projected EOM', formatINR(data.combined.projectedRevenue)],
      ],
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 2 },
      columnStyles: { 0: { fontStyle: 'bold' }, 1: { halign: 'right', fontStyle: 'bold' } },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // Per-stream KPI detail
  for (const stream of data.streams) {
    if (y > pageH - 70) { doc.addPage(); y = 16; }
    y = addSectionTitle(doc, `${stream.name} — Detailed KPIs`, y);

    const kpiRows: string[][] = [];
    for (const card of stream.cards) {
      if (card.unit === 'percent') {
        kpiRows.push([
          card.category ? `${card.category} — ${card.label}` : card.label,
          fmtVal(card.mtd, card.unit),
          card.target > 0 ? `Fcst: ${fmtVal(card.target, card.unit)}` : '—',
          '—', '—', '—',
          ragLabel(card.rag),
        ]);
      } else {
        const { onPace } = pickTargetRow(card, data.daysInMonth);
        kpiRows.push([
          card.category ? `${card.category} — ${card.label}` : card.label,
          fmtVal(card.mtd, card.unit),
          card.target > 0 ? fmtVal(card.target, card.unit) : '—',
          fmtVal(card.projected, card.unit),
          fmtVal(card.dailyRate, card.unit) + '/d',
          card.target > 0 ? fmtVal(card.requiredRate, card.unit) + '/d' : '—',
          card.target === 0 ? 'N/A' : (onPace ? 'ON PACE' : 'BEHIND'),
        ]);
      }
    }

    autoTable(doc, {
      startY: y,
      head: [['Metric', 'MTD', 'Target', 'Projected', 'Actual Pace', 'Required', 'Status']],
      body: kpiRows,
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 1.8 },
      headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold' },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 40 },
        1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
        4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'center' },
      },
      didParseCell: (cell) => {
        if (cell.section === 'body' && cell.column.index === 6) {
          const txt = String(cell.cell.raw || '');
          if (txt === 'ON PACE' || txt === 'On Track') cell.cell.styles.textColor = [16, 185, 129];
          else if (txt === 'BEHIND' || txt === 'Behind Target') cell.cell.styles.textColor = [220, 38, 38];
          else if (txt === 'Needs Attention') cell.cell.styles.textColor = [245, 158, 11];
        }
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 4;

    // Week-over-week stripe
    const tw = stream.thisWeek;
    const lw = stream.lastWeek;
    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...DARK_TEXT);
    doc.text('This Week vs Last Week', 14, y);
    y += 4;

    const wowRows: string[][] = isClinic ? [
      ['Patients', formatNumber(tw.patients), formatNumber(lw.patients), pctChange(tw.patients, lw.patients)],
      ['Revenue', formatINR(tw.revenue), formatINR(lw.revenue), pctChange(tw.revenue, lw.revenue)],
    ] : [
      ['Transactions', formatNumber(tw.transactions), formatNumber(lw.transactions), pctChange(tw.transactions, lw.transactions)],
      ['Sales', formatINR(tw.revenue), formatINR(lw.revenue), pctChange(tw.revenue, lw.revenue)],
      ['Profit', formatINR(tw.profit), formatINR(lw.profit), pctChange(tw.profit, lw.profit)],
    ];

    autoTable(doc, {
      startY: y,
      head: [['', 'This Week', 'Last Week', 'Change']],
      body: wowRows,
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 1.8 },
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

  // Daily breakdown — combined table per stream
  for (const stream of data.streams) {
    if (stream.daily.length === 0) continue;
    if (y > pageH - 60) { doc.addPage(); y = 16; }

    y = addSectionTitle(doc, `${stream.name} — Daily Breakdown`, y);
    const isClinic = stream.name.toLowerCase().includes('clinic') || stream.name.toLowerCase().includes('health');

    const dailyRows: string[][] = stream.daily.map(d => isClinic ? [
      pretty(d.date),
      formatNumber(d.patients || 0),
      formatINR(d.revenue || 0),
    ] : [
      pretty(d.date),
      formatNumber(d.transactions || 0),
      formatINR(d.revenue || 0),
      formatINR(d.profit || 0),
    ]);

    autoTable(doc, {
      startY: y,
      head: [isClinic
        ? ['Date', 'Patients', 'Revenue']
        : ['Date', 'Transactions', 'Sales', 'Profit']],
      body: dailyRows,
      theme: 'striped',
      styles: { fontSize: 7.5, cellPadding: 1.5 },
      headStyles: { fillColor: LIGHT_BG, textColor: DARK_TEXT, fontStyle: 'bold' },
      columnStyles: isClinic ? {
        0: { cellWidth: 30 },
        1: { halign: 'right', cellWidth: 25 },
        2: { halign: 'right' },
      } : {
        0: { cellWidth: 30 },
        1: { halign: 'right', cellWidth: 25 },
        2: { halign: 'right' },
        3: { halign: 'right' },
      },
      margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 8;
  }

  // Recommendations / Management Actions
  if (y > pageH - 60) { doc.addPage(); y = 16; }
  y = addSectionTitle(doc, 'Management Actions to Achieve Monthly Target', y);
  const recs = buildRecommendations(data, 'monthly');
  autoTable(doc, {
    startY: y,
    head: [['#', 'Action / Recommendation']],
    body: recs.map((r, i) => [String(i + 1), r]),
    theme: 'striped',
    styles: { fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 10, halign: 'center', fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
    margin: { left: 14, right: 14 },
  });

  addFooter(doc, `Monthly Insight • ${data.monthLabel} • ${clientName}`);
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
      // Small delay then close for UX feedback
      setTimeout(() => { setGenerating(false); onClose(); }, 400);
    } catch (err) {
      console.error('PDF generation error:', err);
      alert('Failed to generate insight report. Please try again.');
      setGenerating(false);
    }
  };

  if (!open) return null;

  const options: { key: ReportVariant; label: string; sub: string; icon: typeof Calendar }[] = [
    {
      key: 'daily',
      label: 'Daily Insight',
      sub: "Today's performance vs yesterday — pace, gaps, and immediate actions",
      icon: Calendar,
    },
    {
      key: 'weekly',
      label: 'Weekly Insight',
      sub: 'This week vs last week, week-over-week trends, focus areas',
      icon: CalendarDays,
    },
    {
      key: 'monthly',
      label: 'Monthly / MTD Insight',
      sub: 'Full MTD performance, category breakdown, projected EOM, management actions',
      icon: CalendarRange,
    },
  ];

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Slide-out Panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-md bg-dark-700 shadow-2xl z-50 flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-400/50 bg-dark-600">
          <div className="flex items-center gap-3">
            <Download size={20} className="text-accent-400" />
            <h2 className="text-lg font-bold text-theme-heading">Download Insight</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-dark-400 rounded-lg transition-colors"
            title="Close panel"
            aria-label="Close panel"
          >
            <X size={18} className="text-theme-faint" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-theme-secondary mb-1">Report Type</h3>
            <p className="text-xs text-theme-faint mb-3">
              Choose the time window for the operational insight report.
            </p>
            <div className="space-y-2">
              {options.map(opt => {
                const Icon = opt.icon;
                const selected = variant === opt.key;
                return (
                  <label
                    key={opt.key}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selected
                        ? 'border-accent-500 bg-accent-500/10'
                        : 'border-dark-400/50 hover:bg-dark-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="insightVariant"
                      checked={selected}
                      onChange={() => setVariant(opt.key)}
                      className="mt-1 text-accent-400 focus:ring-primary-500"
                    />
                    <Icon size={18} className={`mt-0.5 shrink-0 ${selected ? 'text-accent-400' : 'text-theme-muted'}`} />
                    <div>
                      <p className={`text-sm font-medium ${selected ? 'text-accent-300' : 'text-theme-heading'}`}>
                        {opt.label}
                      </p>
                      <p className="text-xs text-theme-faint mt-0.5">{opt.sub}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Summary hint */}
          <div className="rounded-lg border border-dark-400/50 bg-dark-600/40 p-3">
            <p className="text-xs text-theme-muted mb-1.5 font-semibold uppercase tracking-wider">Report will include</p>
            {variant === 'daily' && (
              <ul className="text-xs text-theme-secondary space-y-1 list-disc ml-4">
                <li>Today vs yesterday snapshot for every stream</li>
                <li>Daily target vs actual pace, required pace to hit monthly goal</li>
                <li>Immediate action items for operational focus</li>
              </ul>
            )}
            {variant === 'weekly' && (
              <ul className="text-xs text-theme-secondary space-y-1 list-disc ml-4">
                <li>This week vs last week per stream (patients, revenue, profit)</li>
                <li>Weekly target vs actual, required weekly pace</li>
                <li>Trends and focus areas for the next week</li>
              </ul>
            )}
            {variant === 'monthly' && (
              <ul className="text-xs text-theme-secondary space-y-1 list-disc ml-4">
                <li>Combined MTD summary with projected EOM and gap to target</li>
                <li>Detailed KPI table per stream with all pace metrics</li>
                <li>Week-over-week delta, daily breakdown, management actions</li>
              </ul>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-dark-400/50 bg-dark-600">
          <button
            onClick={handleDownload}
            disabled={generating}
            className="w-full btn-primary flex items-center justify-center gap-2 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
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
