// ─────────────────────────────────────────────────────────────────────────────
// VCFO Report Exporters (Slice 5b).
//
// Render the outputs of `vcfo-report-builder` into downloadable files —
// three formats per report type: XLSX (exceljs), PDF (pdfkit), DOCX (docx).
//
// All renderers return a Buffer so the HTTP handler can set the correct
// Content-Type + Content-Disposition and pipe directly to the response.
// ─────────────────────────────────────────────────────────────────────────────

import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, HeadingLevel, TextRun, WidthType, AlignmentType, BorderStyle } from 'docx';
import type {
  TrialBalanceReport,
  PLStatement,
  PLSection,
  BSStatement,
  CFStatement,
} from './vcfo-report-builder.js';

type ReportKind = 'tb' | 'pl' | 'bs' | 'cf';
type AnyReport = TrialBalanceReport | PLStatement | BSStatement | CFStatement;

// ─── Shared helpers ─────────────────────────────────────────────────────────

const INR = (n: number): string => {
  const abs = Math.abs(Math.round(n));
  const sign = n < 0 ? '-' : '';
  return sign + abs.toLocaleString('en-IN');
};

const REPORT_TITLES: Record<ReportKind, string> = {
  tb: 'Trial Balance',
  pl: 'Profit & Loss Statement',
  bs: 'Balance Sheet',
  cf: 'Cash Flow Statement',
};

export interface ExportContext {
  companyName: string;
  reportKind: ReportKind;
}

// ─── Shared P&L export-row builder ─────────────────────────────────────────
// Flattens a PLStatement into the ordered sequence of rows the three
// exporters render. Nested `section.children` get emitted with a `depth`
// marker (parents indent their children visually). COGS-related rows
// (Opening / Closing Stock / COGS subtotal) appear between Indirect
// Expenses and Gross Profit, but only when the tenant carries inventory
// — mirrors the UI's `hasStock` gate. Gross Margin is included for parity
// with the on-screen P&L; its trailing total is suppressed because
// percentages don't aggregate.

interface PLExportRow {
  label: string;
  /** 0 for section parents, +1 per nesting level inside children. */
  depth: number;
  values: Record<string, number>;
  grandTotal: number;
  bold: boolean;
  /** Render in red (expense) vs green (income) — matches the dashboard. */
  tone: 'expense' | 'income' | 'neutral';
  /** Percent rows skip the trailing-Total cell and render with `%` suffix. */
  isPercentage?: boolean;
  /** Visual separator above the row (e.g. double underline above Net Profit). */
  separator?: 'thin' | 'double';
}

function buildPLExportRows(report: PLStatement): PLExportRow[] {
  const rows: PLExportRow[] = [];

  const walkSection = (sec: PLSection, depth: number) => {
    rows.push({
      label: sec.label,
      depth,
      values: sec.values,
      grandTotal: sec.grandTotal,
      bold: depth === 0,
      tone: sec.isExpense ? 'expense' : 'income',
    });
    if (sec.children) for (const ch of sec.children) walkSection(ch, depth + 1);
  };

  // Same hasStock check the UI uses — skip the COGS block when the tenant
  // carries no inventory so service-only companies don't see zero rows.
  const cols = report.columns;
  const stockOpening = report.computed.stockOpening || {};
  const stockClosing = report.computed.stockClosing || {};
  const cogsByCol = report.computed.cogs || {};
  const hasStock = cols.some(c => (stockOpening[c] ?? 0) !== 0 || (stockClosing[c] ?? 0) !== 0);

  // Render sections; inject COGS block immediately after Direct Costs so the
  // trading-account flow (Direct Costs → ±Stock → COGS) reads in one
  // continuous block, with Indirect Income / Indirect Expenses following
  // separately as the P&L A/c portion. Matches the dashboard layout.
  for (const sec of report.sections) {
    walkSection(sec, 0);
    if (hasStock && sec.key === 'directCosts') {
      rows.push({
        label: '+ Opening Stock',
        depth: 0,
        values: stockOpening,
        grandTotal: report.grandTotals.stockOpening ?? 0,
        bold: false,
        tone: 'expense',
      });
      rows.push({
        label: '− Closing Stock',
        depth: 0,
        values: stockClosing,
        grandTotal: report.grandTotals.stockClosing ?? 0,
        bold: false,
        tone: 'income', // reduces costs, displayed in green like other reducers
      });
      rows.push({
        label: 'COGS',
        depth: 0,
        values: cogsByCol,
        grandTotal: report.grandTotals.cogs ?? 0,
        bold: true,
        tone: 'expense',
      });
    }
  }

  rows.push({
    label: 'Gross Profit',
    depth: 0,
    values: report.computed.grossProfit,
    grandTotal: report.grandTotals.grossProfit,
    bold: true,
    tone: 'neutral',
    separator: 'thin',
  });
  rows.push({
    label: 'Gross Margin (%)',
    depth: 0,
    values: report.computed.grossMargin,
    grandTotal: 0,
    bold: false,
    tone: 'neutral',
    isPercentage: true,
  });
  rows.push({
    label: 'Net Profit',
    depth: 0,
    values: report.computed.netProfit,
    grandTotal: report.grandTotals.netProfit,
    bold: true,
    tone: 'neutral',
    separator: 'double',
  });

  return rows;
}

/** Human-readable label for a P&L column. Bifurcated views carry
 *  `columnLabels` mapping `co:<id>` to the company name; everything else
 *  falls back to the raw column key (or 'Total' for the special total). */
function plColumnLabel(report: PLStatement, col: string): string {
  if (report.columnLabels && report.columnLabels[col]) return report.columnLabels[col];
  return col === 'total' ? 'Total' : col;
}

// ─── XLSX ───────────────────────────────────────────────────────────────────

export async function renderXlsx(ctx: ExportContext, report: AnyReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Magna Tracker';
  wb.created = new Date();

  const ws = wb.addWorksheet(REPORT_TITLES[ctx.reportKind]);

  // Title block
  const titleRow = ws.addRow([`${ctx.companyName} — ${REPORT_TITLES[ctx.reportKind]}`]);
  titleRow.font = { size: 14, bold: true };
  ws.addRow([describePeriod(report)]);
  ws.addRow([]);

  if (ctx.reportKind === 'tb') writeTBSheet(ws, report as TrialBalanceReport);
  else if (ctx.reportKind === 'pl') writePLSheet(ws, report as PLStatement);
  else if (ctx.reportKind === 'bs') writeBSSheet(ws, report as BSStatement);
  else if (ctx.reportKind === 'cf') writeCFSheet(ws, report as CFStatement);

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr as ArrayBuffer);
}

function writeTBSheet(ws: ExcelJS.Worksheet, report: TrialBalanceReport) {
  const header = ws.addRow(['Ledger', 'Group', 'Opening', 'Debit', 'Credit', 'Closing']);
  header.font = { bold: true };
  header.eachCell(c => { c.border = { bottom: { style: 'thin' } }; });

  for (const r of report.rows) {
    ws.addRow([r.ledgerName, r.groupName || '', r.opening, r.debit, r.credit, r.closing]);
  }

  const totals = ws.addRow(['TOTAL', '', report.totals.opening, report.totals.debit, report.totals.credit, report.totals.closing]);
  totals.font = { bold: true };
  totals.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } }; });

  ws.columns = [
    { width: 40 }, { width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
  ];
  [3, 4, 5, 6].forEach(c => { ws.getColumn(c).numFmt = '#,##0.00;(#,##0.00)'; });
}

function writePLSheet(ws: ExcelJS.Worksheet, report: PLStatement) {
  const cols = report.columns;
  const headerLabels = ['Section', ...cols.map(c => plColumnLabel(report, c)), 'Total'];
  const header = ws.addRow(headerLabels);
  header.font = { bold: true };
  header.eachCell(c => { c.border = { bottom: { style: 'thin' } }; });

  for (const r of buildPLExportRows(report)) {
    const indented = (r.depth > 0 ? '  '.repeat(r.depth) : '') + r.label;
    const trailingCell = r.isPercentage ? '' : r.grandTotal;
    const rowCells: any[] = [indented, ...cols.map(c => r.isPercentage ? (r.values[c] ?? 0) : (r.values[c] || 0)), trailingCell];
    const excelRow = ws.addRow(rowCells);

    if (r.bold) excelRow.font = { bold: true, ...(excelRow.font || {}) };
    if (r.tone === 'expense') {
      excelRow.font = { ...(excelRow.font || {}), color: { argb: 'FFB91C1C' } };
    } else if (r.tone === 'income') {
      excelRow.font = { ...(excelRow.font || {}), color: { argb: 'FF047857' } };
    }
    if (r.separator === 'thin') {
      excelRow.eachCell(c => { c.border = { ...(c.border || {}), top: { style: 'thin' } }; });
    } else if (r.separator === 'double') {
      excelRow.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } }; });
    }
    if (r.isPercentage) {
      // Per-column percentage cells get a `%` numFmt; trailing cell stays blank.
      for (let i = 0; i < cols.length; i++) {
        excelRow.getCell(2 + i).numFmt = '0.00"%"';
      }
    }
  }

  ws.getColumn(1).width = 40;
  for (let c = 2; c <= cols.length + 2; c++) {
    ws.getColumn(c).width = 16;
    ws.getColumn(c).numFmt = '#,##0.00;(#,##0.00)';
  }
}

function writeBSSheet(ws: ExcelJS.Worksheet, report: BSStatement) {
  const cols = report.columns;
  const header = ws.addRow(['Section', ...cols.map(c => c === 'total' ? 'Total' : c), 'Total']);
  header.font = { bold: true };
  header.eachCell(c => { c.border = { bottom: { style: 'thin' } }; });

  // Assets
  ws.addRow(['— ASSETS —']).font = { italic: true };
  for (const sec of report.sections.filter(s => s.side === 'asset')) {
    ws.addRow([sec.label, ...cols.map(c => sec.values[c] || 0), sec.grandTotal]);
  }
  const ta = ws.addRow(['Total Assets', ...cols.map(c => report.totals.totalAssets[c] || 0),
    cols.reduce((s, c) => s + (report.totals.totalAssets[c] || 0), 0)]);
  ta.font = { bold: true };

  ws.addRow([]);
  ws.addRow(['— LIABILITIES + EQUITY —']).font = { italic: true };
  for (const sec of report.sections.filter(s => s.side === 'liability')) {
    ws.addRow([sec.label, ...cols.map(c => sec.values[c] || 0), sec.grandTotal]);
  }
  const tl = ws.addRow(['Total Liabilities + Equity', ...cols.map(c => report.totals.totalLiabilities[c] || 0),
    cols.reduce((s, c) => s + (report.totals.totalLiabilities[c] || 0), 0)]);
  tl.font = { bold: true };
  tl.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } }; });

  ws.getColumn(1).width = 30;
  for (let c = 2; c <= cols.length + 2; c++) {
    ws.getColumn(c).width = 16;
    ws.getColumn(c).numFmt = '#,##0.00;(#,##0.00)';
  }
}

function writeCFSheet(ws: ExcelJS.Worksheet, report: CFStatement) {
  const header = ws.addRow(['Item', 'Amount']);
  header.font = { bold: true };
  header.eachCell(c => { c.border = { bottom: { style: 'thin' } }; });

  const section = (label: string) => {
    const r = ws.addRow([label, '']);
    r.font = { italic: true, bold: true };
  };

  section('Operating Activities');
  for (const line of report.operating) ws.addRow([`  ${line.label}`, line.amount]);
  const op = ws.addRow(['  Net Cash from Operating', report.operatingTotal]);
  op.font = { bold: true };

  section('Investing Activities');
  for (const line of report.investing) ws.addRow([`  ${line.label}`, line.amount]);
  const inv = ws.addRow(['  Net Cash from Investing', report.investingTotal]);
  inv.font = { bold: true };

  section('Financing Activities');
  for (const line of report.financing) ws.addRow([`  ${line.label}`, line.amount]);
  const fin = ws.addRow(['  Net Cash from Financing', report.financingTotal]);
  fin.font = { bold: true };

  ws.addRow([]);
  ws.addRow(['Opening Cash & Bank', report.openingCash]);
  const nc = ws.addRow(['Net Change in Cash', report.netChange]);
  nc.font = { bold: true };
  const cc = ws.addRow(['Closing Cash & Bank', report.closingCash]);
  cc.font = { bold: true };
  cc.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } }; });

  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 18;
  ws.getColumn(2).numFmt = '#,##0.00;(#,##0.00)';
}

// ─── PDF ────────────────────────────────────────────────────────────────────

export function renderPdf(ctx: ExportContext, report: AnyReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(16).font('Helvetica-Bold').text(ctx.companyName, { continued: false });
    doc.fontSize(13).font('Helvetica').text(REPORT_TITLES[ctx.reportKind]);
    doc.fontSize(10).fillColor('#6b7280').text(describePeriod(report));
    doc.fillColor('#000000').moveDown(1);

    if (ctx.reportKind === 'tb') renderTBPdf(doc, report as TrialBalanceReport);
    else if (ctx.reportKind === 'pl') renderPLPdf(doc, report as PLStatement);
    else if (ctx.reportKind === 'bs') renderBSPdf(doc, report as BSStatement);
    else if (ctx.reportKind === 'cf') renderCFPdf(doc, report as CFStatement);

    doc.end();
  });
}

function pdfTable(doc: PDFKit.PDFDocument, headers: string[], rows: Array<{ cells: string[]; bold?: boolean; expense?: boolean }>, colWidths: number[]) {
  const startX = doc.x;
  let y = doc.y;
  const rowHeight = 18;
  const tableWidth = colWidths.reduce((s, w) => s + w, 0);

  // Header
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x + 3, y + 4, { width: colWidths[i] - 6, align: i === 0 ? 'left' : 'right' });
    x += colWidths[i];
  });
  y += rowHeight;
  doc.moveTo(startX, y).lineTo(startX + tableWidth, y).stroke();

  // Rows
  for (const row of rows) {
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = doc.y;
    }
    doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    doc.fillColor(row.expense ? '#b91c1c' : '#000000');
    x = startX;
    row.cells.forEach((c, i) => {
      doc.text(c, x + 3, y + 4, { width: colWidths[i] - 6, align: i === 0 ? 'left' : 'right' });
      x += colWidths[i];
    });
    y += rowHeight;
    doc.moveTo(startX, y).strokeColor('#e5e7eb').lineTo(startX + tableWidth, y).stroke();
  }

  doc.fillColor('#000000').strokeColor('#000000');
  doc.y = y + 4;
}

function renderTBPdf(doc: PDFKit.PDFDocument, report: TrialBalanceReport) {
  const widths = [220, 170, 80, 80, 80, 80];
  const rows = report.rows.map(r => ({
    cells: [r.ledgerName, r.groupName || '', INR(r.opening), INR(r.debit), INR(r.credit), INR(r.closing)],
  }));
  rows.push({
    cells: ['TOTAL', '', INR(report.totals.opening), INR(report.totals.debit), INR(report.totals.credit), INR(report.totals.closing)],
    bold: true,
  } as any);
  pdfTable(doc, ['Ledger', 'Group', 'Opening', 'Debit', 'Credit', 'Closing'], rows, widths);
}

function renderPLPdf(doc: PDFKit.PDFDocument, report: PLStatement) {
  const cols = report.columns;
  const labels = ['Section', ...cols.map(c => plColumnLabel(report, c)), 'Total'];
  const colCount = labels.length;
  const firstCol = 220;
  const restCols = Math.floor((720 - firstCol) / (colCount - 1));
  const widths = [firstCol, ...Array(colCount - 1).fill(restCols)];

  const rows: Array<{ cells: string[]; bold?: boolean; expense?: boolean }> = [];
  for (const r of buildPLExportRows(report)) {
    const indented = (r.depth > 0 ? '  '.repeat(r.depth) : '') + r.label;
    const cells = [indented, ...cols.map(c => {
      const v = r.values[c] ?? 0;
      return r.isPercentage ? `${v.toFixed(2)}%` : INR(v);
    }), r.isPercentage ? '' : INR(r.grandTotal)];
    rows.push({
      cells,
      bold: r.bold,
      expense: r.tone === 'expense',
    });
  }

  pdfTable(doc, labels, rows, widths);
}

function renderBSPdf(doc: PDFKit.PDFDocument, report: BSStatement) {
  const cols = report.columns;
  const labels = ['Section', ...cols.map(c => c === 'total' ? 'Total' : c), 'Total'];
  const colCount = labels.length;
  const firstCol = 240;
  const restCols = Math.floor((720 - firstCol) / (colCount - 1));
  const widths = [firstCol, ...Array(colCount - 1).fill(restCols)];

  const rows: Array<{ cells: string[]; bold?: boolean }> = [];
  rows.push({ cells: ['— ASSETS —', ...cols.map(() => ''), ''], bold: true });
  for (const sec of report.sections.filter(s => s.side === 'asset')) {
    rows.push({ cells: [sec.label, ...cols.map(c => INR(sec.values[c] || 0)), INR(sec.grandTotal)] });
  }
  rows.push({
    cells: ['Total Assets', ...cols.map(c => INR(report.totals.totalAssets[c] || 0)),
      INR(cols.reduce((s, c) => s + (report.totals.totalAssets[c] || 0), 0))],
    bold: true,
  });

  rows.push({ cells: ['', ...cols.map(() => ''), ''] });
  rows.push({ cells: ['— LIABILITIES + EQUITY —', ...cols.map(() => ''), ''], bold: true });
  for (const sec of report.sections.filter(s => s.side === 'liability')) {
    rows.push({ cells: [sec.label, ...cols.map(c => INR(sec.values[c] || 0)), INR(sec.grandTotal)] });
  }
  rows.push({
    cells: ['Total Liabilities + Equity', ...cols.map(c => INR(report.totals.totalLiabilities[c] || 0)),
      INR(cols.reduce((s, c) => s + (report.totals.totalLiabilities[c] || 0), 0))],
    bold: true,
  });

  pdfTable(doc, labels, rows, widths);
}

function renderCFPdf(doc: PDFKit.PDFDocument, report: CFStatement) {
  const widths = [380, 180];
  const rows: Array<{ cells: string[]; bold?: boolean }> = [];
  rows.push({ cells: ['Operating Activities', ''], bold: true });
  for (const l of report.operating) rows.push({ cells: ['  ' + l.label, INR(l.amount)] });
  rows.push({ cells: ['  Net Cash from Operating', INR(report.operatingTotal)], bold: true });

  rows.push({ cells: ['', ''] });
  rows.push({ cells: ['Investing Activities', ''], bold: true });
  for (const l of report.investing) rows.push({ cells: ['  ' + l.label, INR(l.amount)] });
  rows.push({ cells: ['  Net Cash from Investing', INR(report.investingTotal)], bold: true });

  rows.push({ cells: ['', ''] });
  rows.push({ cells: ['Financing Activities', ''], bold: true });
  for (const l of report.financing) rows.push({ cells: ['  ' + l.label, INR(l.amount)] });
  rows.push({ cells: ['  Net Cash from Financing', INR(report.financingTotal)], bold: true });

  rows.push({ cells: ['', ''] });
  rows.push({ cells: ['Opening Cash & Bank', INR(report.openingCash)] });
  rows.push({ cells: ['Net Change in Cash', INR(report.netChange)], bold: true });
  rows.push({ cells: ['Closing Cash & Bank', INR(report.closingCash)], bold: true });

  pdfTable(doc, ['Item', 'Amount'], rows, widths);
}

// ─── DOCX ───────────────────────────────────────────────────────────────────

export async function renderDocx(ctx: ExportContext, report: AnyReport): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: ctx.companyName, bold: true })],
  }));
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text: REPORT_TITLES[ctx.reportKind], bold: true })],
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: describePeriod(report), italics: true, color: '6B7280' })],
  }));
  children.push(new Paragraph({ text: '' }));

  if (ctx.reportKind === 'tb') children.push(buildTBDocx(report as TrialBalanceReport));
  else if (ctx.reportKind === 'pl') children.push(buildPLDocx(report as PLStatement));
  else if (ctx.reportKind === 'bs') children.push(buildBSDocx(report as BSStatement));
  else if (ctx.reportKind === 'cf') children.push(buildCFDocx(report as CFStatement));

  const doc = new Document({
    creator: 'Magna Tracker',
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

function docxCell(text: string, opts: { bold?: boolean; align?: 'left' | 'right'; color?: string } = {}): TableCell {
  return new TableCell({
    children: [new Paragraph({
      alignment: opts.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text, bold: opts.bold, color: opts.color })],
    })],
  });
}

function docxTable(headers: string[], rows: Array<{ cells: string[]; bold?: boolean; expense?: boolean }>): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => docxCell(h, { bold: true, align: i === 0 ? 'left' : 'right' })),
  });

  const dataRows = rows.map(r => new TableRow({
    children: r.cells.map((c, i) => docxCell(c, {
      bold: r.bold,
      align: i === 0 ? 'left' : 'right',
      color: r.expense ? 'B91C1C' : undefined,
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

function buildTBDocx(report: TrialBalanceReport): Table {
  const rows = report.rows.map(r => ({
    cells: [r.ledgerName, r.groupName || '', INR(r.opening), INR(r.debit), INR(r.credit), INR(r.closing)],
  }));
  rows.push({
    cells: ['TOTAL', '', INR(report.totals.opening), INR(report.totals.debit), INR(report.totals.credit), INR(report.totals.closing)],
    bold: true,
  } as any);
  return docxTable(['Ledger', 'Group', 'Opening', 'Debit', 'Credit', 'Closing'], rows);
}

function buildPLDocx(report: PLStatement): Table {
  const cols = report.columns;
  const headers = ['Section', ...cols.map(c => plColumnLabel(report, c)), 'Total'];
  const rows: Array<{ cells: string[]; bold?: boolean; expense?: boolean }> = [];
  for (const r of buildPLExportRows(report)) {
    const indented = (r.depth > 0 ? '  '.repeat(r.depth) : '') + r.label;
    const cells = [indented, ...cols.map(c => {
      const v = r.values[c] ?? 0;
      return r.isPercentage ? `${v.toFixed(2)}%` : INR(v);
    }), r.isPercentage ? '' : INR(r.grandTotal)];
    rows.push({
      cells,
      bold: r.bold,
      expense: r.tone === 'expense',
    });
  }
  return docxTable(headers, rows);
}

function buildBSDocx(report: BSStatement): Table {
  const cols = report.columns;
  const headers = ['Section', ...cols.map(c => c === 'total' ? 'Total' : c), 'Total'];
  const rows: Array<{ cells: string[]; bold?: boolean }> = [];

  rows.push({ cells: ['— ASSETS —', ...cols.map(() => ''), ''], bold: true });
  for (const sec of report.sections.filter(s => s.side === 'asset')) {
    rows.push({ cells: [sec.label, ...cols.map(c => INR(sec.values[c] || 0)), INR(sec.grandTotal)] });
  }
  rows.push({
    cells: ['Total Assets', ...cols.map(c => INR(report.totals.totalAssets[c] || 0)),
      INR(cols.reduce((s, c) => s + (report.totals.totalAssets[c] || 0), 0))],
    bold: true,
  });

  rows.push({ cells: ['', ...cols.map(() => ''), ''] });
  rows.push({ cells: ['— LIABILITIES + EQUITY —', ...cols.map(() => ''), ''], bold: true });
  for (const sec of report.sections.filter(s => s.side === 'liability')) {
    rows.push({ cells: [sec.label, ...cols.map(c => INR(sec.values[c] || 0)), INR(sec.grandTotal)] });
  }
  rows.push({
    cells: ['Total Liabilities + Equity', ...cols.map(c => INR(report.totals.totalLiabilities[c] || 0)),
      INR(cols.reduce((s, c) => s + (report.totals.totalLiabilities[c] || 0), 0))],
    bold: true,
  });

  return docxTable(headers, rows);
}

function buildCFDocx(report: CFStatement): Table {
  const rows: Array<{ cells: string[]; bold?: boolean }> = [];
  rows.push({ cells: ['Operating Activities', ''], bold: true });
  for (const l of report.operating) rows.push({ cells: ['  ' + l.label, INR(l.amount)] });
  rows.push({ cells: ['  Net Cash from Operating', INR(report.operatingTotal)], bold: true });

  rows.push({ cells: ['', ''] });
  rows.push({ cells: ['Investing Activities', ''], bold: true });
  for (const l of report.investing) rows.push({ cells: ['  ' + l.label, INR(l.amount)] });
  rows.push({ cells: ['  Net Cash from Investing', INR(report.investingTotal)], bold: true });

  rows.push({ cells: ['', ''] });
  rows.push({ cells: ['Financing Activities', ''], bold: true });
  for (const l of report.financing) rows.push({ cells: ['  ' + l.label, INR(l.amount)] });
  rows.push({ cells: ['  Net Cash from Financing', INR(report.financingTotal)], bold: true });

  rows.push({ cells: ['', ''] });
  rows.push({ cells: ['Opening Cash & Bank', INR(report.openingCash)] });
  rows.push({ cells: ['Net Change in Cash', INR(report.netChange)], bold: true });
  rows.push({ cells: ['Closing Cash & Bank', INR(report.closingCash)], bold: true });

  return docxTable(['Item', 'Amount'], rows);
}

// ─── Shared ─────────────────────────────────────────────────────────────────

function describePeriod(report: AnyReport): string {
  if ('period' in report) return `${report.period.from} to ${report.period.to}`;
  if ('asOfDate' in report) return `As of ${report.asOfDate}`;
  return '';
}
