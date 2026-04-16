import { useState } from 'react';
import { X, Printer, FileText, Download } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

interface Props {
  open: boolean;
  onClose: () => void;
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  settings: Record<string, any>;
  scenarioName: string;
  fyLabel: string;
}

interface ReportOption {
  key: string;
  label: string;
  checked: boolean;
}

/* ================================================================
   COLOR / STYLE CONSTANTS
   ================================================================ */

const COLOR = {
  headerBg:      [241, 245, 249] as [number, number, number],   // #f1f5f9
  headerText:    [51, 65, 85]    as [number, number, number],    // #334155
  sectionBg:     [248, 250, 252] as [number, number, number],    // #f8fafc
  accentBg:      [240, 253, 250] as [number, number, number],    // very light teal for totals
  lineColor:     [226, 232, 240] as [number, number, number],    // #e2e8f0
  darkText:      [30, 41, 59]    as [number, number, number],    // #1e293b
  bodyText:      [51, 65, 85]    as [number, number, number],    // #334155
  mutedText:     [100, 116, 139] as [number, number, number],    // #64748b
  footerText:    [148, 163, 184] as [number, number, number],    // #94a3b8
  accent:        [13, 148, 136]  as [number, number, number],    // #0d9488
  negativeText:  [153, 27, 27]   as [number, number, number],    // dark red
  white:         [255, 255, 255] as [number, number, number],
};

/** Labels that mark a row as a "totals" row (bold + accent background) */
const TOTAL_ROW_LABELS = [
  'Total Revenue', 'Total Direct Costs', 'Total Operating Expenses',
  'Gross Profit', 'Operating Income', 'Net Profit',
  'Net Cash from Operations', 'Net Cash from Investing', 'Net Cash from Financing',
  'Net Cash Flow', 'Cash Balance', 'Total Current Assets',
  'Total Long-term Assets', 'Total Assets', 'Totals',
  'Cash at End of Period',
];

/** Labels that mark a section header row (bold, slight bg, no indent) */
const SECTION_HEADER_LABELS = [
  'Revenue', 'Direct Costs', 'Operating Expenses',
  'Cash from Operations', 'Cash from Investing', 'Cash from Financing',
  'Assets', 'Current Assets', 'Long-term Assets',
  'Liabilities', 'Current Liabilities', 'Equity',
];

/** Labels for percentage / margin rows (italic) */
const PERCENT_ROW_LABELS = [
  'Gross Margin', 'Net Profit Margin',
];

/* ================================================================
   HELPER: sumCat
   ================================================================ */

function sumCat(
  items: ForecastItem[],
  cat: string,
  allValues: Record<number, Record<string, number>>,
  m: string,
): number {
  return items
    .filter(i => i.category === cat)
    .reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
}

/* ================================================================
   formatNum  --  Professional number formatting
   ================================================================ */

function formatNum(v: string | number, isPercent = false): string {
  if (typeof v === 'string') return v;
  if (v === 0) return '\u2013'; // em dash
  if (isPercent) {
    const sign = v < 0 ? '(' : '';
    const end  = v < 0 ? ')' : '';
    return `${sign}${Math.abs(v).toFixed(1)}%${end}`;
  }
  if (v < 0) {
    return '(Rs' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(v)) + ')';
  }
  return 'Rs' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
}

/* ================================================================
   DATA BUILDERS
   ================================================================ */

/** Metadata flags attached to each row for styling purposes */
interface RowMeta {
  isSection?: boolean;
  isTotal?: boolean;
  isPercent?: boolean;
}

function buildPnLRows(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
  benefitsPct: number,
) {
  const revenueItems = items.filter(i => i.category === 'revenue');
  const dcItems      = items.filter(i => i.category === 'direct_costs');
  const persItems    = items.filter(i => i.category === 'personnel');
  const expItems     = items.filter(i => i.category === 'expenses');

  const header = ['Profit & Loss', ...months.map(m => getMonthLabel(m)), 'Total'];
  const rows: (string | number)[][] = [];
  const meta: RowMeta[] = [];

  // --- Revenue ---
  rows.push(['Revenue', ...months.map(() => ''), '']);
  meta.push({ isSection: true });
  revenueItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });
  const revTotals = months.map(m => sumCat(items, 'revenue', allValues, m));
  const revTotal = revTotals.reduce((a, b) => a + b, 0);
  rows.push(['Total Revenue', ...revTotals, revTotal]);
  meta.push({ isTotal: true });

  // --- Direct Costs ---
  rows.push(['Direct Costs', ...months.map(() => ''), '']);
  meta.push({ isSection: true });
  dcItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });
  const dcTotals = months.map(m => sumCat(items, 'direct_costs', allValues, m));
  rows.push(['Total Direct Costs', ...dcTotals, dcTotals.reduce((a, b) => a + b, 0)]);
  meta.push({ isTotal: true });

  // --- Gross Profit ---
  const gpTotals = months.map((_, i) => revTotals[i] - dcTotals[i]);
  const gpTotal = gpTotals.reduce((a, b) => a + b, 0);
  rows.push(['Gross Profit', ...gpTotals, gpTotal]);
  meta.push({ isTotal: true });

  // --- Gross Margin % ---
  const gmPctMonths = months.map((_, i) => revTotals[i] !== 0 ? (gpTotals[i] / revTotals[i]) * 100 : 0);
  const gmPctTotal = revTotal !== 0 ? (gpTotal / revTotal) * 100 : 0;
  rows.push(['Gross Margin', ...gmPctMonths, gmPctTotal]);
  meta.push({ isPercent: true });

  // --- Operating Expenses ---
  rows.push(['Operating Expenses', ...months.map(() => ''), '']);
  meta.push({ isSection: true });
  persItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });
  const persTotals = months.map(m => sumCat(items, 'personnel', allValues, m));
  const empTaxTotals = persTotals.map(p => Math.round(p * benefitsPct / 100));
  rows.push(['  Employee Taxes & Benefits', ...empTaxTotals, empTaxTotals.reduce((a, b) => a + b, 0)]);
  meta.push({});
  expItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });
  const expTotals = months.map(m => sumCat(items, 'expenses', allValues, m));
  const opexTotals = months.map((_, i) => persTotals[i] + empTaxTotals[i] + expTotals[i]);
  rows.push(['Total Operating Expenses', ...opexTotals, opexTotals.reduce((a, b) => a + b, 0)]);
  meta.push({ isTotal: true });

  // --- Operating Income ---
  const oiTotals = months.map((_, i) => gpTotals[i] - opexTotals[i]);
  const oiTotal = oiTotals.reduce((a, b) => a + b, 0);
  rows.push(['Operating Income', ...oiTotals, oiTotal]);
  meta.push({ isTotal: true });

  // --- Taxes ---
  const taxTotals = months.map(m => sumCat(items, 'taxes', allValues, m));
  rows.push(['Income Taxes', ...taxTotals, taxTotals.reduce((a, b) => a + b, 0)]);
  meta.push({});

  // --- Depreciation placeholder ---
  const depTotals = months.map(() => 0);
  rows.push(['Depreciation', ...depTotals, 0]);
  meta.push({});

  // --- Total Expenses (OPEX + taxes + depreciation) ---
  const totalExpenses = months.map((_, i) => opexTotals[i] + taxTotals[i] + depTotals[i]);
  rows.push(['Total Expenses', ...totalExpenses, totalExpenses.reduce((a, b) => a + b, 0)]);
  meta.push({ isTotal: true });

  // --- Net Profit ---
  const npTotals = months.map((_, i) => oiTotals[i] - taxTotals[i]);
  const npTotal = npTotals.reduce((a, b) => a + b, 0);
  rows.push(['Net Profit', ...npTotals, npTotal]);
  meta.push({ isTotal: true });

  // --- Net Profit Margin % ---
  const npmPctMonths = months.map((_, i) => revTotals[i] !== 0 ? (npTotals[i] / revTotals[i]) * 100 : 0);
  const npmPctTotal = revTotal !== 0 ? (npTotal / revTotal) * 100 : 0;
  rows.push(['Net Profit Margin', ...npmPctMonths, npmPctTotal]);
  meta.push({ isPercent: true });

  return { header, rows, meta };
}

function buildBalanceSheetRows(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
) {
  const currentAssets = items.filter(i => i.category === 'assets' && i.item_type === 'current');
  const ltAssets      = items.filter(i => i.category === 'assets' && i.item_type === 'long_term');

  const header = ['Balance Sheet', ...months.map(m => getMonthLabel(m))];
  const rows: (string | number)[][] = [];
  const meta: RowMeta[] = [];

  rows.push(['Assets', ...months.map(() => '')]); meta.push({ isSection: true });
  rows.push(['Current Assets', ...months.map(() => '')]); meta.push({ isSection: true });

  const cashVals = months.map(m => {
    const rev   = sumCat(items, 'revenue', allValues, m);
    const costs = sumCat(items, 'direct_costs', allValues, m);
    const opex  = sumCat(items, 'expenses', allValues, m) + sumCat(items, 'personnel', allValues, m);
    return Math.max(rev - costs - opex, 0);
  });
  rows.push(['  Cash', ...cashVals]); meta.push({});
  currentAssets.forEach(item => {
    rows.push([`  ${item.name}`, ...months.map(m => allValues[item.id]?.[m] || 0)]);
    meta.push({});
  });
  const caTotal = months.map((m, i) =>
    cashVals[i] + currentAssets.reduce((s, it) => s + (allValues[it.id]?.[m] || 0), 0),
  );
  rows.push(['Total Current Assets', ...caTotal]); meta.push({ isTotal: true });

  rows.push(['Long-term Assets', ...months.map(() => '')]); meta.push({ isSection: true });
  ltAssets.forEach(item => {
    rows.push([`  ${item.name}`, ...months.map(m => allValues[item.id]?.[m] || 0)]);
    meta.push({});
  });
  const ltTotal = months.map(m => ltAssets.reduce((s, it) => s + (allValues[it.id]?.[m] || 0), 0));
  rows.push(['Total Long-term Assets', ...ltTotal]); meta.push({ isTotal: true });

  const totalAssets = months.map((_, i) => caTotal[i] + ltTotal[i]);
  rows.push(['Total Assets', ...totalAssets]); meta.push({ isTotal: true });

  return { header, rows, meta };
}

function buildCashFlowRows(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
) {
  const header = ['Cash Flow', ...months.map(m => getMonthLabel(m)), 'Total'];
  const rows: (string | number)[][] = [];
  const meta: RowMeta[] = [];
  let cumCash = 0;

  const mData = months.map(m => {
    const rev    = sumCat(items, 'revenue', allValues, m);
    const dc     = sumCat(items, 'direct_costs', allValues, m);
    const pers   = sumCat(items, 'personnel', allValues, m);
    const exp    = sumCat(items, 'expenses', allValues, m);
    const tax    = sumCat(items, 'taxes', allValues, m);
    const assets = sumCat(items, 'assets', allValues, m);
    const div    = sumCat(items, 'dividends', allValues, m);
    const cashOps = rev - dc - pers - exp - tax;
    const cashInv = -assets;
    const cashFin = -div;
    const net     = cashOps + cashInv + cashFin;
    cumCash += net;
    return { rev, dc, pers, exp, tax, cashOps, assets, cashInv, div, cashFin, net, balance: cumCash };
  });

  rows.push(['Cash from Operations', ...months.map(() => ''), '']); meta.push({ isSection: true });
  rows.push(['  Net Profit',       ...mData.map(d => d.rev - d.dc - d.pers - d.exp - d.tax), mData.reduce((s, d) => s + (d.rev - d.dc - d.pers - d.exp - d.tax), 0)]); meta.push({});
  rows.push(['  Depreciation',     ...months.map(() => 0), 0]); meta.push({});
  rows.push(['  Cash Receipts',    ...mData.map(d => d.rev), mData.reduce((s, d) => s + d.rev, 0)]); meta.push({});
  rows.push(['  Direct Costs Paid',...mData.map(d => -d.dc), -mData.reduce((s, d) => s + d.dc, 0)]); meta.push({});
  rows.push(['  Personnel Paid',   ...mData.map(d => -d.pers), -mData.reduce((s, d) => s + d.pers, 0)]); meta.push({});
  rows.push(['  Expenses Paid',    ...mData.map(d => -d.exp), -mData.reduce((s, d) => s + d.exp, 0)]); meta.push({});
  rows.push(['  Taxes Paid',       ...mData.map(d => -d.tax), -mData.reduce((s, d) => s + d.tax, 0)]); meta.push({});
  rows.push(['Net Cash from Operations', ...mData.map(d => d.cashOps), mData.reduce((s, d) => s + d.cashOps, 0)]); meta.push({ isTotal: true });

  rows.push(['Cash from Investing', ...months.map(() => ''), '']); meta.push({ isSection: true });
  rows.push(['  Assets Purchased',  ...mData.map(d => d.cashInv), mData.reduce((s, d) => s + d.cashInv, 0)]); meta.push({});
  rows.push(['Net Cash from Investing', ...mData.map(d => d.cashInv), mData.reduce((s, d) => s + d.cashInv, 0)]); meta.push({ isTotal: true });

  rows.push(['Cash from Financing', ...months.map(() => ''), '']); meta.push({ isSection: true });
  rows.push(['  Dividends Paid',    ...mData.map(d => d.cashFin), mData.reduce((s, d) => s + d.cashFin, 0)]); meta.push({});
  rows.push(['Net Cash from Financing', ...mData.map(d => d.cashFin), mData.reduce((s, d) => s + d.cashFin, 0)]); meta.push({ isTotal: true });

  rows.push(['Net Cash Flow', ...mData.map(d => d.net), mData.reduce((s, d) => s + d.net, 0)]); meta.push({ isTotal: true });
  rows.push(['Cash Balance',  ...mData.map(d => d.balance), mData[mData.length - 1]?.balance || 0]); meta.push({ isTotal: true });

  return { header, rows, meta };
}

function buildCategoryRows(
  items: ForecastItem[],
  cat: string,
  catLabel: string,
  allValues: Record<number, Record<string, number>>,
  months: string[],
  benefitsPct: number,
) {
  const catItems = items.filter(i => i.category === cat);
  const header = [catLabel, ...months.map(m => getMonthLabel(m)), 'Total'];
  const rows: (string | number)[][] = [];
  const meta: RowMeta[] = [];

  catItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
    meta.push({});
  });

  const totals = months.map(m => catItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0));
  const grandTotal = totals.reduce((a, b) => a + b, 0);
  rows.push(['Totals', ...totals, grandTotal]);
  meta.push({ isTotal: true });

  // Personnel gets extra computed rows
  if (cat === 'personnel') {
    const headCount = catItems.length;
    const revTotals = months.map(m => sumCat(items, 'revenue', allValues, m));
    const revGrand = revTotals.reduce((a, b) => a + b, 0);
    const dcTotals = months.map(m => sumCat(items, 'direct_costs', allValues, m));
    const opexTotals = months.map((m, i) =>
      totals[i] + Math.round(totals[i] * benefitsPct / 100) +
      sumCat(items, 'expenses', allValues, m),
    );
    const npTotals = months.map((_, i) => revTotals[i] - dcTotals[i] - opexTotals[i]);
    const npGrand = npTotals.reduce((a, b) => a + b, 0);

    // Head Count
    rows.push(['Head Count', ...months.map(() => headCount), headCount]);
    meta.push({});
    // Average Salary
    if (headCount > 0) {
      const avgSal = months.map((_, i) => Math.round(totals[i] / headCount));
      rows.push(['Average Salary', ...avgSal, Math.round(grandTotal / headCount)]);
      meta.push({});
    }
    // Revenue Per Employee
    if (headCount > 0) {
      const rpe = months.map((_, i) => Math.round(revTotals[i] / headCount));
      rows.push(['Revenue Per Employee', ...rpe, Math.round(revGrand / headCount)]);
      meta.push({});
    }
    // Net Profit Per Employee
    if (headCount > 0) {
      const npe = months.map((_, i) => Math.round(npTotals[i] / headCount));
      rows.push(['Net Profit Per Employee', ...npe, Math.round(npGrand / headCount)]);
      meta.push({});
    }
  }

  return { header, rows, meta };
}

/* ================================================================
   ANNUAL SUMMARY BUILDER  --  2-column tables (Item | FY Total)
   ================================================================ */

function buildAnnualSummaryRows(
  items: ForecastItem[],
  cat: string,
  catLabel: string,
  allValues: Record<number, Record<string, number>>,
  months: string[],
  benefitsPct: number,
) {
  const catItems = items.filter(i => i.category === cat);
  const header = [catLabel, `Annual Total`];
  const rows: (string | number)[][] = [];
  const meta: RowMeta[] = [];

  catItems.forEach(item => {
    const total = months.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0);
    rows.push([`  ${item.name}`, total]);
    meta.push({});
  });

  const grandTotal = catItems.reduce((s, item) =>
    s + months.reduce((sm, m) => sm + (allValues[item.id]?.[m] || 0), 0), 0,
  );
  rows.push(['Totals', grandTotal]);
  meta.push({ isTotal: true });

  // Personnel extra rows
  if (cat === 'personnel') {
    const headCount = catItems.length;
    const revTotal = months.reduce((s, m) => s + sumCat(items, 'revenue', allValues, m), 0);
    const dcTotal = months.reduce((s, m) => s + sumCat(items, 'direct_costs', allValues, m), 0);
    const opexTotal = grandTotal + Math.round(grandTotal * benefitsPct / 100) +
      months.reduce((s, m) => s + sumCat(items, 'expenses', allValues, m), 0);
    const npTotal = revTotal - dcTotal - opexTotal;

    rows.push(['Head Count', headCount]); meta.push({});
    if (headCount > 0) {
      rows.push(['Average Salary', Math.round(grandTotal / headCount)]); meta.push({});
      rows.push(['Revenue Per Employee', Math.round(revTotal / headCount)]); meta.push({});
      rows.push(['Net Profit Per Employee', Math.round(npTotal / headCount)]); meta.push({});
    }
  }

  return { header, rows, meta };
}

/* ================================================================
   PDF RENDERING FUNCTIONS
   ================================================================ */

/**
 * Adds a professional cover page to the PDF document.
 */
function addCoverPage(
  doc: jsPDF,
  fyLabel: string,
  scenarioName: string,
  includeScenarioTitle: boolean,
) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const cx = pageW / 2;

  // Subtle top accent line
  doc.setDrawColor(...COLOR.accent);
  doc.setLineWidth(1.5);
  doc.line(40, 60, pageW - 40, 60);

  // Main title
  doc.setFontSize(32);
  doc.setTextColor(...COLOR.darkText);
  doc.setFont('helvetica', 'bold');
  doc.text(`${fyLabel} Forecast`, cx, 90, { align: 'center' });

  // Scenario / company name
  if (includeScenarioTitle) {
    doc.setFontSize(16);
    doc.setTextColor(...COLOR.mutedText);
    doc.setFont('helvetica', 'normal');
    doc.text(scenarioName, cx, 108, { align: 'center' });
  }

  // Bottom accent line
  doc.setDrawColor(...COLOR.accent);
  doc.setLineWidth(0.5);
  doc.line(60, pageH - 60, pageW - 60, pageH - 60);

  // Generated date
  doc.setFontSize(10);
  doc.setTextColor(...COLOR.mutedText);
  doc.setFont('helvetica', 'normal');
  const dateStr = new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  doc.text(`Generated ${dateStr}`, cx, pageH - 45, { align: 'center' });
}

/**
 * Adds a section title page (e.g., "Annual Summary", "Monthly Detail").
 */
function addSectionTitle(
  doc: jsPDF,
  title: string,
  subtitle: string,
) {
  doc.addPage();
  const pageW = doc.internal.pageSize.getWidth();
  const cx = pageW / 2;

  doc.setDrawColor(...COLOR.accent);
  doc.setLineWidth(0.8);
  doc.line(30, 50, pageW - 30, 50);

  doc.setFontSize(22);
  doc.setTextColor(...COLOR.darkText);
  doc.setFont('helvetica', 'bold');
  doc.text(title, cx, 70, { align: 'center' });

  doc.setFontSize(11);
  doc.setTextColor(...COLOR.mutedText);
  doc.setFont('helvetica', 'normal');
  doc.text(subtitle, cx, 84, { align: 'center' });
}

/**
 * Renders a report title + subtitle above a table.
 */
function addReportHeader(
  doc: jsPDF,
  title: string,
  fyLabel: string,
  y: number,
): number {
  doc.setFontSize(14);
  doc.setTextColor(...COLOR.darkText);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 15, y);

  doc.setFontSize(9);
  doc.setTextColor(...COLOR.mutedText);
  doc.setFont('helvetica', 'normal');
  doc.text(fyLabel, 15, y + 6);

  return y + 12;
}

/**
 * Core table renderer with professional styling.
 *
 * @returns The Y position below the rendered table (with spacing).
 */
function addTableToPDF(
  doc: jsPDF,
  title: string,
  fyLabel: string,
  header: string[],
  rows: (string | number)[][],
  rowMeta: RowMeta[],
  isAnnual: boolean,
): number {
  // Always start on a new page
  doc.addPage();
  let startY = addReportHeader(doc, title, fyLabel, 20);

  // Build display rows
  let displayHeader: string[];
  let displayRows: string[][];
  const displayMeta = [...rowMeta];

  if (isAnnual) {
    // Collapse months into single "Annual Total" column
    displayHeader = [header[0], 'Annual Total'];
    displayRows = rows.map((row, ri) => {
      const label = String(row[0]);
      const total = row[row.length - 1];
      const isPct = displayMeta[ri]?.isPercent;
      return [label, typeof total === 'number' ? formatNum(total, isPct) : String(total)];
    });
  } else {
    displayHeader = header;
    displayRows = rows.map((row, ri) => {
      const isPct = displayMeta[ri]?.isPercent;
      return row.map((cell, ci) => {
        if (ci === 0) return String(cell);
        return typeof cell === 'number' ? formatNum(cell, isPct) : String(cell);
      });
    });
  }

  const firstColWidth = isAnnual ? 90 : 45;

  autoTable(doc, {
    startY,
    head: [displayHeader],
    body: displayRows,
    theme: 'grid',
    styles: {
      fontSize: 7.5,
      cellPadding: 2.5,
      lineColor: COLOR.lineColor,
      lineWidth: 0.15,
      textColor: COLOR.bodyText,
      font: 'helvetica',
    },
    headStyles: {
      fillColor: COLOR.headerBg,
      textColor: COLOR.headerText,
      fontStyle: 'bold',
      fontSize: 7.5,
      cellPadding: 2.5,
    },
    columnStyles: Object.fromEntries(
      displayHeader.map((_, i) => [
        i,
        i === 0
          ? { cellWidth: firstColWidth, fontStyle: 'normal' as const }
          : { halign: 'right' as const, cellWidth: 'auto' as const },
      ]),
    ),
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const rowIdx = data.row.index;
      const colIdx = data.column.index;
      const rowM = displayMeta[rowIdx];
      const cellText = String(data.cell.raw);

      if (!rowM) return;

      // Section header rows
      if (rowM.isSection) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = COLOR.sectionBg;
      }

      // Total rows
      if (rowM.isTotal) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = COLOR.accentBg;
      }

      // Percentage rows
      if (rowM.isPercent) {
        data.cell.styles.fontStyle = 'italic';
        data.cell.styles.textColor = COLOR.mutedText;
      }

      // Negative values in data columns — text with parentheses is negative
      if (colIdx > 0 && cellText.startsWith('(')) {
        data.cell.styles.textColor = COLOR.negativeText;
      }

      // First column: if not section/total, keep normal weight
      if (colIdx === 0 && !rowM.isSection && !rowM.isTotal && !rowM.isPercent) {
        data.cell.styles.fontStyle = 'normal';
      }
    },
    margin: { left: 15, right: 15, top: 15 },
  });

  return (doc as any).lastAutoTable.finalY + 10;
}

/**
 * Adds page footers to all pages in the document.
 */
function addFooters(
  doc: jsPDF,
  scenarioName: string,
  fyLabel: string,
  startPage: number,
) {
  const totalPages = doc.getNumberOfPages();
  for (let p = startPage; p <= totalPages; p++) {
    doc.setPage(p);
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    doc.setFontSize(7);
    doc.setTextColor(...COLOR.footerText);
    doc.setFont('helvetica', 'normal');
    doc.text(
      `Vision by Indefine \u2014 ${scenarioName} \u2014 ${fyLabel}`,
      15,
      pageH - 8,
    );
    doc.text(
      `Page ${p} of ${totalPages}`,
      pageW - 15,
      pageH - 8,
      { align: 'right' },
    );
  }
}

/* ================================================================
   MAIN PDF GENERATION
   ================================================================ */

async function generateFullPDF(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
  settings: Record<string, any>,
  scenarioName: string,
  fyLabel: string,
  reports: ReportOption[],
  detailLevel: 'annual' | 'monthly',
  paperSize: 'a4' | 'letter',
  coverPage: boolean,
  includeScenarioTitle: boolean,
) {
  const format = paperSize === 'a4' ? 'a4' : 'letter';
  const benefitsPct = settings.employee_benefits_pct || 0;

  // Start in portrait for cover + annual pages
  const doc = new jsPDF({ orientation: 'portrait', format, unit: 'mm' });

  const isAllReports = reports.every(r => r.checked);
  const checked = (key: string) => reports.find(r => r.key === key)?.checked ?? false;
  const hasItems = (cat: string) => items.some(i => i.category === cat);

  // Track the first content page (cover page is page 1)
  let firstContentPage = 1;

  // ── COVER PAGE ──
  if (coverPage) {
    addCoverPage(doc, fyLabel, scenarioName, includeScenarioTitle);
    firstContentPage = 2;
  }

  // ── ANNUAL SUMMARY SECTION ──
  if (isAllReports || checked('revenue') || checked('direct_costs') || checked('personnel') || checked('expenses') || checked('assets')) {
    addSectionTitle(doc, 'Annual Summary', fyLabel);

    const categories: [string, string][] = [
      ['revenue', 'Revenue'],
      ['direct_costs', 'Direct Costs'],
      ['personnel', 'Personnel'],
      ['expenses', 'Expenses'],
      ['assets', 'Assets'],
    ];

    for (const [catKey, catLabel] of categories) {
      if (!isAllReports && !checked(catKey)) continue;
      if (!hasItems(catKey)) continue;

      const { header, rows, meta } = buildAnnualSummaryRows(
        items, catKey, catLabel, allValues, months, benefitsPct,
      );
      addTableToPDF(doc, catLabel, fyLabel, header, rows, meta, true);
    }
  }

  // ── ANNUAL FINANCIAL REPORTS ──
  if (isAllReports || checked('pnl') || checked('balance_sheet') || checked('cash_flow')) {
    addSectionTitle(doc, 'Annual Financial Reports', fyLabel);
  }

  // Annual P&L
  if (isAllReports || checked('pnl')) {
    const { header, rows, meta } = buildPnLRows(items, allValues, months, benefitsPct);
    addTableToPDF(doc, 'Projected Profit & Loss', fyLabel, header, rows, meta, true);
  }

  // Annual Balance Sheet
  if (isAllReports || checked('balance_sheet')) {
    const { header, rows, meta } = buildBalanceSheetRows(items, allValues, months);
    addTableToPDF(doc, 'Projected Balance Sheet', fyLabel, header, rows, meta, true);
  }

  // Annual Cash Flow
  if (isAllReports || checked('cash_flow')) {
    const { header, rows, meta } = buildCashFlowRows(items, allValues, months);
    addTableToPDF(doc, 'Projected Cash Flow', fyLabel, header, rows, meta, true);
  }

  // ── MONTHLY DETAIL SECTION (only if monthly detail selected) ──
  if (detailLevel === 'monthly') {
    // Monthly category tables
    if (isAllReports || checked('revenue') || checked('direct_costs') || checked('personnel') || checked('expenses') || checked('assets')) {
      addSectionTitle(doc, 'Monthly Detail', fyLabel);

      // Switch to landscape for monthly tables
      // jsPDF does not support mid-document orientation change per page with autoTable,
      // but we can add landscape pages individually.

      const categories: [string, string][] = [
        ['revenue', 'Revenue'],
        ['direct_costs', 'Direct Costs'],
        ['personnel', 'Personnel'],
        ['expenses', 'Expenses'],
        ['assets', 'Assets'],
      ];

      for (const [catKey, catLabel] of categories) {
        if (!isAllReports && !checked(catKey)) continue;
        if (!hasItems(catKey)) continue;

        const { header, rows, meta } = buildCategoryRows(
          items, catKey, catLabel, allValues, months, benefitsPct,
        );
        // Add landscape page
        doc.addPage(format, 'landscape');
        let y = addReportHeader(doc, catLabel, fyLabel, 20);

        const displayHeader = header;
        const displayRows = rows.map((row, ri) => {
          const isPct = meta[ri]?.isPercent;
          return row.map((cell, ci) => {
            if (ci === 0) return String(cell);
            return typeof cell === 'number' ? formatNum(cell, isPct) : String(cell);
          });
        });

        autoTable(doc, {
          startY: y,
          head: [displayHeader],
          body: displayRows,
          theme: 'grid',
          styles: {
            fontSize: 7.5,
            cellPadding: 2.5,
            lineColor: COLOR.lineColor,
            lineWidth: 0.15,
            textColor: COLOR.bodyText,
            font: 'helvetica',
          },
          headStyles: {
            fillColor: COLOR.headerBg,
            textColor: COLOR.headerText,
            fontStyle: 'bold',
            fontSize: 7.5,
            cellPadding: 2.5,
          },
          columnStyles: Object.fromEntries(
            displayHeader.map((_, i) => [
              i,
              i === 0
                ? { cellWidth: 45, fontStyle: 'normal' as const }
                : { halign: 'right' as const, cellWidth: 'auto' as const },
            ]),
          ),
          didParseCell: (data) => {
            if (data.section !== 'body') return;
            const rowIdx = data.row.index;
            const colIdx = data.column.index;
            const rowM = meta[rowIdx];
            const cellText = String(data.cell.raw);
            if (!rowM) return;
            if (rowM.isSection) {
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.fillColor = COLOR.sectionBg;
            }
            if (rowM.isTotal) {
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.fillColor = COLOR.accentBg;
            }
            if (rowM.isPercent) {
              data.cell.styles.fontStyle = 'italic';
              data.cell.styles.textColor = COLOR.mutedText;
            }
            if (colIdx > 0 && cellText.startsWith('(')) {
              data.cell.styles.textColor = COLOR.negativeText;
            }
            if (colIdx === 0 && !rowM.isSection && !rowM.isTotal && !rowM.isPercent) {
              data.cell.styles.fontStyle = 'normal';
            }
          },
          margin: { left: 15, right: 15, top: 15 },
        });
      }
    }

    // Monthly Financial Reports
    if (isAllReports || checked('pnl') || checked('balance_sheet') || checked('cash_flow')) {
      addSectionTitle(doc, 'Monthly Financial Reports', fyLabel);
    }

    // Monthly P&L (landscape)
    if (isAllReports || checked('pnl')) {
      const { header, rows, meta } = buildPnLRows(items, allValues, months, benefitsPct);
      doc.addPage(format, 'landscape');
      let y = addReportHeader(doc, 'Projected Profit & Loss', fyLabel, 20);

      const displayRows = rows.map((row, ri) => {
        const isPct = meta[ri]?.isPercent;
        return row.map((cell, ci) => {
          if (ci === 0) return String(cell);
          return typeof cell === 'number' ? formatNum(cell, isPct) : String(cell);
        });
      });

      autoTable(doc, {
        startY: y,
        head: [header],
        body: displayRows,
        theme: 'grid',
        styles: {
          fontSize: 7.5,
          cellPadding: 2.5,
          lineColor: COLOR.lineColor,
          lineWidth: 0.15,
          textColor: COLOR.bodyText,
          font: 'helvetica',
        },
        headStyles: {
          fillColor: COLOR.headerBg,
          textColor: COLOR.headerText,
          fontStyle: 'bold',
          fontSize: 7.5,
          cellPadding: 2.5,
        },
        columnStyles: Object.fromEntries(
          header.map((_, i) => [
            i,
            i === 0
              ? { cellWidth: 45, fontStyle: 'normal' as const }
              : { halign: 'right' as const, cellWidth: 'auto' as const },
          ]),
        ),
        didParseCell: (data) => {
          if (data.section !== 'body') return;
          const rowIdx = data.row.index;
          const colIdx = data.column.index;
          const rowM = meta[rowIdx];
          const cellText = String(data.cell.raw);
          if (!rowM) return;
          if (rowM.isSection) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = COLOR.sectionBg; }
          if (rowM.isTotal) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = COLOR.accentBg; }
          if (rowM.isPercent) { data.cell.styles.fontStyle = 'italic'; data.cell.styles.textColor = COLOR.mutedText; }
          if (colIdx > 0 && cellText.startsWith('(')) { data.cell.styles.textColor = COLOR.negativeText; }
          if (colIdx === 0 && !rowM.isSection && !rowM.isTotal && !rowM.isPercent) { data.cell.styles.fontStyle = 'normal'; }
        },
        margin: { left: 15, right: 15, top: 15 },
      });
    }

    // Monthly Balance Sheet (landscape)
    if (isAllReports || checked('balance_sheet')) {
      const { header, rows, meta } = buildBalanceSheetRows(items, allValues, months);
      doc.addPage(format, 'landscape');
      let y = addReportHeader(doc, 'Projected Balance Sheet', fyLabel, 20);

      const displayRows = rows.map((row, ri) => {
        const isPct = meta[ri]?.isPercent;
        return row.map((cell, ci) => {
          if (ci === 0) return String(cell);
          return typeof cell === 'number' ? formatNum(cell, isPct) : String(cell);
        });
      });

      autoTable(doc, {
        startY: y,
        head: [header],
        body: displayRows,
        theme: 'grid',
        styles: {
          fontSize: 7.5,
          cellPadding: 2.5,
          lineColor: COLOR.lineColor,
          lineWidth: 0.15,
          textColor: COLOR.bodyText,
          font: 'helvetica',
        },
        headStyles: {
          fillColor: COLOR.headerBg,
          textColor: COLOR.headerText,
          fontStyle: 'bold',
          fontSize: 7.5,
          cellPadding: 2.5,
        },
        columnStyles: Object.fromEntries(
          header.map((_, i) => [
            i,
            i === 0
              ? { cellWidth: 45, fontStyle: 'normal' as const }
              : { halign: 'right' as const, cellWidth: 'auto' as const },
          ]),
        ),
        didParseCell: (data) => {
          if (data.section !== 'body') return;
          const rowIdx = data.row.index;
          const colIdx = data.column.index;
          const rowM = meta[rowIdx];
          const cellText = String(data.cell.raw);
          if (!rowM) return;
          if (rowM.isSection) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = COLOR.sectionBg; }
          if (rowM.isTotal) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = COLOR.accentBg; }
          if (rowM.isPercent) { data.cell.styles.fontStyle = 'italic'; data.cell.styles.textColor = COLOR.mutedText; }
          if (colIdx > 0 && cellText.startsWith('(')) { data.cell.styles.textColor = COLOR.negativeText; }
          if (colIdx === 0 && !rowM.isSection && !rowM.isTotal && !rowM.isPercent) { data.cell.styles.fontStyle = 'normal'; }
        },
        margin: { left: 15, right: 15, top: 15 },
      });
    }

    // Monthly Cash Flow (landscape)
    if (isAllReports || checked('cash_flow')) {
      const { header, rows, meta } = buildCashFlowRows(items, allValues, months);
      doc.addPage(format, 'landscape');
      let y = addReportHeader(doc, 'Projected Cash Flow', fyLabel, 20);

      const displayRows = rows.map((row, ri) => {
        const isPct = meta[ri]?.isPercent;
        return row.map((cell, ci) => {
          if (ci === 0) return String(cell);
          return typeof cell === 'number' ? formatNum(cell, isPct) : String(cell);
        });
      });

      autoTable(doc, {
        startY: y,
        head: [header],
        body: displayRows,
        theme: 'grid',
        styles: {
          fontSize: 7.5,
          cellPadding: 2.5,
          lineColor: COLOR.lineColor,
          lineWidth: 0.15,
          textColor: COLOR.bodyText,
          font: 'helvetica',
        },
        headStyles: {
          fillColor: COLOR.headerBg,
          textColor: COLOR.headerText,
          fontStyle: 'bold',
          fontSize: 7.5,
          cellPadding: 2.5,
        },
        columnStyles: Object.fromEntries(
          header.map((_, i) => [
            i,
            i === 0
              ? { cellWidth: 45, fontStyle: 'normal' as const }
              : { halign: 'right' as const, cellWidth: 'auto' as const },
          ]),
        ),
        didParseCell: (data) => {
          if (data.section !== 'body') return;
          const rowIdx = data.row.index;
          const colIdx = data.column.index;
          const rowM = meta[rowIdx];
          const cellText = String(data.cell.raw);
          if (!rowM) return;
          if (rowM.isSection) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = COLOR.sectionBg; }
          if (rowM.isTotal) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = COLOR.accentBg; }
          if (rowM.isPercent) { data.cell.styles.fontStyle = 'italic'; data.cell.styles.textColor = COLOR.mutedText; }
          if (colIdx > 0 && cellText.startsWith('(')) { data.cell.styles.textColor = COLOR.negativeText; }
          if (colIdx === 0 && !rowM.isSection && !rowM.isTotal && !rowM.isPercent) { data.cell.styles.fontStyle = 'normal'; }
        },
        margin: { left: 15, right: 15, top: 15 },
      });
    }
  }

  // ── Cash at End of Period (standalone, if selected) ──
  if (checked('cash_at_end')) {
    let cumCash = 0;
    const cashHeader = ['Cash at End of Period', ...months.map(m => getMonthLabel(m))];
    const cashRow = months.map(m => {
      const net = sumCat(items, 'revenue', allValues, m)
        - sumCat(items, 'direct_costs', allValues, m)
        - sumCat(items, 'personnel', allValues, m)
        - sumCat(items, 'expenses', allValues, m)
        - sumCat(items, 'taxes', allValues, m)
        - sumCat(items, 'assets', allValues, m)
        - sumCat(items, 'dividends', allValues, m);
      cumCash += net;
      return cumCash;
    });
    const cashRows: (string | number)[][] = [['Cash Balance', ...cashRow]];
    const cashMeta: RowMeta[] = [{ isTotal: true }];
    addTableToPDF(doc, 'Cash at End of Period', fyLabel, cashHeader, cashRows, cashMeta, false);
  }

  // ── Remove blank first page if cover was added (jsPDF starts with one) ──
  // The initial jsPDF constructor creates page 1. If we used it for the cover, it's fine.
  // If we didn't add a cover, the first page is blank because addTableToPDF always calls addPage().
  // Remove page 1 if it's blank.
  if (!coverPage && doc.getNumberOfPages() > 1) {
    doc.deletePage(1);
  }

  // ── FOOTERS ──
  addFooters(doc, scenarioName, fyLabel, 1);

  // ── SAVE ──
  doc.save(`Forecast_Report_${fyLabel.replace(/\s+/g, '_')}.pdf`);
}

/* ================================================================
   COMPONENT  (UI unchanged)
   ================================================================ */

export default function DownloadPrintPanel({ open, onClose, items, allValues, months, settings, scenarioName, fyLabel }: Props) {
  const [reportType, setReportType] = useState<'forecast' | 'actuals_forecast'>('forecast');
  const [detailLevel, setDetailLevel] = useState<'annual' | 'monthly'>('monthly');
  const [paperSize, setPaperSize] = useState<'a4' | 'letter'>('a4');
  const [coverPage, setCoverPage] = useState(true);
  const [includeCharts, setIncludeCharts] = useState(false);
  const [includeScenarioTitle, setIncludeScenarioTitle] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [reports, setReports] = useState<ReportOption[]>([
    { key: 'pnl', label: 'Profit & Loss Statement', checked: true },
    { key: 'balance_sheet', label: 'Balance Sheet', checked: true },
    { key: 'cash_flow', label: 'Cash Flow Statement', checked: true },
    { key: 'revenue', label: 'Revenue', checked: true },
    { key: 'direct_costs', label: 'Direct Costs', checked: false },
    { key: 'personnel', label: 'Personnel', checked: false },
    { key: 'expenses', label: 'Expenses', checked: false },
    { key: 'assets', label: 'Assets', checked: false },
    { key: 'financing', label: 'Financing', checked: false },
    { key: 'cash_at_end', label: 'Cash at end of period', checked: false },
  ]);

  const toggleReport = (key: string) => {
    setReports(prev => prev.map(r => r.key === key ? { ...r, checked: !r.checked } : r));
  };

  const allReportsChecked = reports.every(r => r.checked);
  const someReportsChecked = reports.some(r => r.checked);
  const toggleAllReports = () => {
    // If all or some are checked, clear. If none are checked, select all.
    const next = !allReportsChecked;
    setReports(prev => prev.map(r => ({ ...r, checked: next })));
  };

  const generatePDF = async () => {
    setGenerating(true);

    try {
      await generateFullPDF(
        items,
        allValues,
        months,
        settings,
        scenarioName,
        fyLabel,
        reports,
        detailLevel,
        paperSize,
        coverPage,
        includeScenarioTitle,
      );
    } catch (err) {
      console.error('PDF generation error:', err);
      alert('Failed to generate PDF. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Slide-out Panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-lg bg-dark-700 shadow-2xl z-50 flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-400/50 bg-dark-600">
          <div className="flex items-center gap-3">
            <Printer size={20} className="text-accent-400" />
            <h2 className="text-lg font-bold text-theme-heading">Download & Print</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-dark-400 rounded-lg transition-colors" title="Close panel" aria-label="Close panel">
            <X size={18} className="text-theme-faint" />
          </button>
        </div>

        {/* Body - scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* A. Report Type */}
          <div>
            <h3 className="text-sm font-semibold text-theme-secondary mb-3">Report Type</h3>
            <div className="space-y-2">
              <label className="flex items-center gap-3 p-3 rounded-lg border border-dark-400/50 cursor-pointer hover:bg-dark-600 transition-colors">
                <input
                  type="radio"
                  name="reportType"
                  checked={reportType === 'forecast'}
                  onChange={() => setReportType('forecast')}
                  className="text-accent-400 focus:ring-primary-500"
                />
                <div>
                  <p className="text-sm font-medium text-theme-heading">Forecast Only</p>
                  <p className="text-xs text-theme-faint">A PDF using your original forecast data</p>
                </div>
              </label>
              <label className="flex items-center gap-3 p-3 rounded-lg border border-dark-400/50 cursor-pointer hover:bg-dark-600 transition-colors">
                <input
                  type="radio"
                  name="reportType"
                  checked={reportType === 'actuals_forecast'}
                  onChange={() => setReportType('actuals_forecast')}
                  className="text-accent-400 focus:ring-primary-500"
                />
                <div>
                  <p className="text-sm font-medium text-theme-heading">Actuals + Forecast</p>
                  <p className="text-xs text-theme-faint">A PDF with adjusted values based on past actuals and future forecast</p>
                </div>
              </label>
            </div>
          </div>

          {/* B. Reports to Include */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-theme-secondary">Reports to Include</h3>
              <button
                type="button"
                onClick={toggleAllReports}
                className="text-xs font-medium text-accent-400 hover:text-accent-300 transition-colors"
                title={allReportsChecked ? 'Clear all reports' : 'Select every report'}
              >
                {allReportsChecked ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors border-b border-dark-400/40 pb-2 mb-1">
                <input
                  type="checkbox"
                  checked={allReportsChecked}
                  ref={el => { if (el) el.indeterminate = !allReportsChecked && someReportsChecked; }}
                  onChange={toggleAllReports}
                  className="rounded text-accent-400 focus:ring-primary-500"
                />
                <span className="text-sm font-medium text-theme-heading">All reports</span>
              </label>
              {reports.map(r => (
                <label key={r.key} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={() => toggleReport(r.key)}
                    className="rounded text-accent-400 focus:ring-primary-500"
                  />
                  <span className="text-sm text-theme-secondary">{r.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* C. Level of Detail */}
          <div>
            <h3 className="text-sm font-semibold text-theme-secondary mb-3">Level of Detail</h3>
            <div className="flex gap-3">
              <label className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                detailLevel === 'annual' ? 'border-primary-400 bg-accent-500/10' : 'border-dark-400/50 hover:bg-dark-600'
              }`}>
                <input type="radio" name="detail" checked={detailLevel === 'annual'} onChange={() => setDetailLevel('annual')} className="hidden" />
                <FileText size={16} className={detailLevel === 'annual' ? 'text-accent-400' : 'text-theme-muted'} />
                <span className={`text-sm font-medium ${detailLevel === 'annual' ? 'text-accent-300' : 'text-theme-muted'}`}>Annual Totals</span>
              </label>
              <label className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                detailLevel === 'monthly' ? 'border-primary-400 bg-accent-500/10' : 'border-dark-400/50 hover:bg-dark-600'
              }`}>
                <input type="radio" name="detail" checked={detailLevel === 'monthly'} onChange={() => setDetailLevel('monthly')} className="hidden" />
                <FileText size={16} className={detailLevel === 'monthly' ? 'text-accent-400' : 'text-theme-muted'} />
                <span className={`text-sm font-medium ${detailLevel === 'monthly' ? 'text-accent-300' : 'text-theme-muted'}`}>Monthly Totals</span>
              </label>
            </div>
          </div>

          {/* D. Other Options */}
          <div>
            <h3 className="text-sm font-semibold text-theme-secondary mb-3">Other Options</h3>
            <div className="space-y-1.5">
              <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors">
                <input type="checkbox" checked={coverPage} onChange={e => setCoverPage(e.target.checked)} className="rounded text-accent-400 focus:ring-primary-500" />
                <span className="text-sm text-theme-secondary">Cover page</span>
              </label>
              <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors">
                <input type="checkbox" checked={includeCharts} onChange={e => setIncludeCharts(e.target.checked)} className="rounded text-accent-400 focus:ring-primary-500" />
                <span className="text-sm text-theme-secondary">Include charts</span>
              </label>
              <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors">
                <input type="checkbox" checked={includeScenarioTitle} onChange={e => setIncludeScenarioTitle(e.target.checked)} className="rounded text-accent-400 focus:ring-primary-500" />
                <span className="text-sm text-theme-secondary">Include forecast scenario title</span>
              </label>
            </div>
          </div>

          {/* E. Paper Size */}
          <div>
            <h3 className="text-sm font-semibold text-theme-secondary mb-3">Paper Size</h3>
            <select
              value={paperSize}
              onChange={e => setPaperSize(e.target.value as 'a4' | 'letter')}
              className="input text-sm w-full"
            >
              <option value="a4">A4</option>
              <option value="letter">US Letter</option>
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-dark-400/50 bg-dark-600">
          <button
            onClick={generatePDF}
            disabled={generating || !reports.some(r => r.checked)}
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
                Download Forecast Report (PDF)
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}
