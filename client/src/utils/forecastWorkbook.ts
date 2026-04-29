// ═══════════════════════════════════════════════════════════════════════════
//   forecastWorkbook.ts — multi-sheet linked Excel export for Forecast page
// ═══════════════════════════════════════════════════════════════════════════
//
// Builds a polished operational workbook from the Forecast page's data:
//
//   • Summary sheet — triple statement (P&L + Cash Flow + Balance Sheet) where
//     each line links via formula to the relevant category sheet's Total row.
//     Edit a category sheet → Summary auto-updates.
//
//   • One sheet per category (Revenue / Direct Costs / Personnel / Expenses /
//     Assets / Taxes / Dividends). Top half: items × months matrix with SUM
//     formula totals. Bottom half: a "Calculation Method" table that
//     documents how each item is derived (constant, raise, percentage of,
//     etc.) in plain English so the recipient can audit the assumptions.
//
//   • Visual styling matches the app UI — emerald accents on title bars and
//     Total rows, banded row fills, frozen panes (header row + item column),
//     bold headers, currency number formats with negatives in parentheses.
//
// Library: exceljs. SheetJS community lacks colour / border / merged-cell
// support, which we need for "consistency with the UI". The server already
// uses exceljs, so it's a known quantity for the team.
// ═══════════════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs';
import type { ForecastItem, FY, Scenario } from '../pages/ForecastModulePage';
import { getMonthLabel } from '../pages/ForecastModulePage';

// ── Visual tokens (mirror client/src/index.css design tokens) ──────────────

const COLOR = {
  accent:        'FF10B981',  // --mt-accent
  accentSoft:    'FFD1FAE5',  // --mt-accent-soft (10% emerald approximation)
  accentStrong:  'FF059669',  // --mt-accent-strong
  textHeading:   'FF0F172A',  // --mt-text-heading
  textMuted:     'FF64748B',  // --mt-text-muted
  textFaint:     'FF94A3B8',  // --mt-text-faint
  bgMuted:       'FFF1F5F9',  // --mt-bg-muted (banded rows)
  bgSubtle:      'FFF8FAFC',  // --mt-bg-subtle
  white:         'FFFFFFFF',
  border:        'FFE2E8F0',
};

const NUM_FMT = '#,##0;(#,##0);"-"';   // 1,234 / (1,234) / -
const PCT_FMT = '0.00%';

// ── Public API ──────────────────────────────────────────────────────────────

export interface BuildWorkbookOpts {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];                                    // 12 YYYY-MM strings, FY order
  settings: Record<string, any>;
  scenario: Scenario | null;
  fy: FY | null;
  branchName?: string;
  streamName?: string;
}

/**
 * Build the workbook in memory and return a Blob ready to be saved by the
 * caller (e.g. via an anchor download click).
 */
export async function buildForecastWorkbook(opts: BuildWorkbookOpts): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vision by Indefine';
  wb.created = new Date();

  const monthLabels = opts.months.map(m => getMonthLabel(m));
  const contextLine = [
    opts.scenario?.name,
    opts.fy?.label,
    opts.branchName,
    opts.streamName,
  ].filter(Boolean).join(' · ');

  // Per-category sheet metadata. Order mirrors the Forecast page tabs.
  // Each item supplies its own decomposition (Units / Rate, Hours / Rate,
  // Linked Revenue / Percentage, etc.) so we don't fix labels per category
  // here — see `decomposeItem` below.
  const CATEGORIES: Array<{
    key: string; label: string; sheetName: string;
  }> = [
    { key: 'revenue',      label: 'Revenue',      sheetName: 'Revenue' },
    { key: 'direct_costs', label: 'Direct Costs', sheetName: 'Direct Costs' },
    { key: 'personnel',    label: 'Personnel',    sheetName: 'Personnel' },
    { key: 'expenses',     label: 'Expenses',     sheetName: 'Expenses' },
    { key: 'assets',       label: 'Assets',       sheetName: 'Assets' },
    { key: 'taxes',        label: 'Taxes',        sheetName: 'Taxes' },
    { key: 'dividends',    label: 'Dividends',    sheetName: 'Dividends' },
  ];

  // Build Summary first as a placeholder; we'll fill it after we know each
  // category sheet's Total row position. (exceljs doesn't require us to
  // populate sheets in any particular order — formulas only need the target
  // sheet to exist by save-time.)
  const summary = wb.addWorksheet('Summary', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }],
    properties: { tabColor: { argb: COLOR.accent } },
  });

  // Track each category sheet's Total row number so the Summary can reference
  // them via formula. Map: category key → row number on its sheet.
  const totalRowByCategory: Record<string, number> = {};
  // Item-name lookup for `pct_specific` calculation method resolution.
  const itemNameById = new Map<number, string>();
  for (const it of opts.items) itemNameById.set(it.id, it.name);

  for (const cat of CATEGORIES) {
    const sheet = wb.addWorksheet(cat.sheetName, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }],
      properties: { tabColor: { argb: COLOR.accent } },
    });
    const catItems = opts.items
      .filter(i => i.category === cat.key)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const totalRow = renderCategorySheet({
      sheet,
      title: cat.label,
      contextLine,
      months: opts.months,
      monthLabels,
      items: catItems,
      allItems: opts.items,
      allValues: opts.allValues,
      itemNameById,
    });
    totalRowByCategory[cat.key] = totalRow;
  }

  renderSummarySheet({
    sheet: summary,
    contextLine,
    months: opts.months,
    monthLabels,
    settings: opts.settings,
    items: opts.items,
    allValues: opts.allValues,
    categorySheetNames: CATEGORIES.reduce<Record<string, string>>((acc, c) => {
      acc[c.key] = c.sheetName;
      return acc;
    }, {}),
    totalRowByCategory,
  });

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ─── Category sheet renderer ───────────────────────────────────────────────

interface CategorySheetOpts {
  sheet: ExcelJS.Worksheet;
  title: string;
  contextLine: string;
  months: string[];
  monthLabels: string[];
  /** Items in this category (rendered on this sheet). */
  items: ForecastItem[];
  /** All items across all categories — needed to resolve cross-item refs
   *  (e.g. "% of Total Revenue", "% of Net Profit"). */
  allItems: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  itemNameById: Map<number, string>;
}

// ─── Item decomposition (multi-row method block layout) ────────────────────

/** A single sub-row in the Calculation Method block. */
interface MethodSubRow {
  /** Label that goes in column A (e.g. "Units", "Rate (₹/unit)", "Linked: …"). */
  label: string;
  /** 12 per-month numeric values (one per month, FY order). */
  perMonthValues: number[];
  /** Number format for column B-M cells. */
  numFmt: string;
  /** When true, write a `=SUM(B:M)` formula in the Annual column on this row. */
  hasAnnualSum: boolean;
  /** When true, the cells render in emerald (visual hint that they're editable). */
  isInputRow: boolean;
}

/** Decomposition of one item into sub-rows. The top-table monthly cell for
 *  this item becomes `=qtyCell * rateCell` (or just `=qtyCell` if no rate). */
interface ItemDecomposition {
  subRows: MethodSubRow[];
  /** Index into subRows of the row that supplies the "qty" cell. */
  qtySubRowIndex: number;
  /** Index of the "rate" sub-row, or null when the qty row alone IS the value. */
  rateSubRowIndex: number | null;
  /** One-line plain-English description that goes in the Method column. */
  notes: string;
}

function renderCategorySheet(o: CategorySheetOpts): number {
  const { sheet, title, contextLine, months, monthLabels, items, allItems,
          allValues, itemNameById } = o;

  // Layout
  //
  //   Top table (items × months as DERIVED VALUES):
  //     A: Item    B-M: Apr-Mar (formulas)    N: Total (=SUM)
  //     Each monthly cell is `=qtyCell * rateCell` referencing the
  //     corresponding pair of cells DOWN in the Calculation Method block.
  //
  //   Calculation Method block (SOURCE OF TRUTH — editable inputs):
  //     Each item gets 1+ sub-rows. For decomposable items (unit_sales,
  //     billable_hours, recurring, % of revenue, % of net profit) we render
  //     two stacked sub-rows: a "qty"-style row (units / hours / linked
  //     revenue) and a "rate"-style row (price / rate / percentage). For
  //     items without a meaningful decomposition we render ONE sub-row
  //     containing the monthly amount directly — the top-table cell becomes
  //     a direct ref instead of a multiplication.
  //
  //     A: sub-row label    B-M: monthly values    N: Annual SUM (qty rows
  //     only)    O: plain-English notes (on qty sub-row only)
  const lastMonthCol = 1 + months.length;        // M (col 13)
  const totalCol = 2 + months.length;             // N (col 14)
  const notesCol = totalCol + 1;                  // O (col 15)

  // ─ Column widths ─
  sheet.getColumn(1).width = 34;
  for (let c = 2; c <= lastMonthCol; c++) sheet.getColumn(c).width = 12;
  sheet.getColumn(totalCol).width = 14;
  sheet.getColumn(notesCol).width = 38;

  // ─ Row 1: title bar (merged across A:N — title spans the data area) ─
  sheet.mergeCells(1, 1, 1, totalCol);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title.toUpperCase();
  titleCell.font = { bold: true, size: 14, color: { argb: COLOR.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  sheet.getRow(1).height = 26;

  // ─ Row 2: context line ─
  sheet.mergeCells(2, 1, 2, totalCol);
  const ctxCell = sheet.getCell(2, 1);
  ctxCell.value = contextLine || ' ';
  ctxCell.font = { italic: true, size: 9, color: { argb: COLOR.textFaint } };
  ctxCell.alignment = { horizontal: 'left', indent: 1 };

  // ─ Row 4: top-table column headers ─
  const HEADER_ROW = 4;
  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.values = ['Item', ...monthLabels, 'Total'];
  headerRow.height = 22;
  headerRow.eachCell((cell, colNumber) => {
    if (colNumber > totalCol) return;
    cell.font = { bold: true, color: { argb: COLOR.white }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
    cell.alignment = { horizontal: colNumber === 1 ? 'left' : 'right', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: COLOR.accent } } };
  });

  // ─ Compute decompositions for each item ─
  const decompositions = items.map(item =>
    decomposeItem(item, allValues, months, itemNameById, allItems)
  );

  // ─ Top-table row map + method-block row plan ─
  const FIRST_ITEM_ROW = HEADER_ROW + 1;
  const TOTAL_ROW = FIRST_ITEM_ROW + items.length;
  const METHOD_HEADER_ROW = TOTAL_ROW + 2;
  const METHOD_COL_HEADERS_ROW = METHOD_HEADER_ROW + 1;

  // For each item, plan where its sub-rows go in the method block.
  // Items get a single blank spacer row between them for readability.
  const SPACER_AFTER_ITEM = 1;
  const methodRowsByItem: Array<{
    startRow: number;
    qtySubRow: number;
    rateSubRow: number | null;
  }> = [];
  let cursor = METHOD_COL_HEADERS_ROW + 1;
  for (let i = 0; i < items.length; i++) {
    const decomp = decompositions[i];
    const startRow = cursor;
    const qtySubRow = startRow + decomp.qtySubRowIndex;
    const rateSubRow = decomp.rateSubRowIndex !== null
      ? startRow + decomp.rateSubRowIndex
      : null;
    methodRowsByItem.push({ startRow, qtySubRow, rateSubRow });
    cursor += decomp.subRows.length + SPACER_AFTER_ITEM;
  }

  // ─ Top table: every monthly cell = qty cell * rate cell (or just qty cell
  //   if the item has no rate sub-row). Total column = SUM(B:M). ─
  items.forEach((item, idx) => {
    const r = FIRST_ITEM_ROW + idx;
    const { qtySubRow, rateSubRow } = methodRowsByItem[idx];
    const row = sheet.getRow(r);
    row.getCell(1).value = item.name;
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    row.getCell(1).font = { color: { argb: COLOR.textHeading } };
    months.forEach((_m, j) => {
      const c = 2 + j;
      const cell = row.getCell(c);
      const colL = colLetter(c);
      cell.value = {
        formula: rateSubRow !== null
          ? `${colL}${qtySubRow}*${colL}${rateSubRow}`
          : `${colL}${qtySubRow}`,
      };
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cell.font = { color: { argb: COLOR.textHeading } };
    });
    const totalCell = row.getCell(totalCol);
    totalCell.value = {
      formula: `SUM(${colLetter(2)}${r}:${colLetter(lastMonthCol)}${r})`,
    };
    totalCell.numFmt = NUM_FMT;
    totalCell.alignment = { horizontal: 'right', vertical: 'middle' };
    totalCell.font = { color: { argb: COLOR.textHeading } };
    if (idx % 2 === 1) {
      for (let c = 1; c <= totalCol; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.bgSubtle } };
      }
    }
  });

  // ─ TOTAL row (top table) ─
  const totalRowObj = sheet.getRow(TOTAL_ROW);
  totalRowObj.getCell(1).value = 'TOTAL';
  totalRowObj.getCell(1).font = { bold: true, color: { argb: COLOR.white } };
  totalRowObj.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  for (let c = 2; c <= lastMonthCol; c++) {
    const cell = totalRowObj.getCell(c);
    cell.value = items.length > 0
      ? { formula: `SUM(${colLetter(c)}${FIRST_ITEM_ROW}:${colLetter(c)}${TOTAL_ROW - 1})` }
      : 0;
    cell.numFmt = NUM_FMT;
    cell.font = { bold: true, color: { argb: COLOR.white } };
    cell.alignment = { horizontal: 'right', vertical: 'middle' };
  }
  const grandTotalCell = totalRowObj.getCell(totalCol);
  grandTotalCell.value = items.length > 0
    ? { formula: `SUM(${colLetter(2)}${TOTAL_ROW}:${colLetter(lastMonthCol)}${TOTAL_ROW})` }
    : 0;
  grandTotalCell.numFmt = NUM_FMT;
  grandTotalCell.font = { bold: true, color: { argb: COLOR.white } };
  grandTotalCell.alignment = { horizontal: 'right', vertical: 'middle' };
  for (let c = 1; c <= totalCol; c++) {
    const cell = totalRowObj.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
    cell.border = {
      top: { style: 'medium', color: { argb: COLOR.accentStrong } },
      bottom: { style: 'medium', color: { argb: COLOR.accentStrong } },
    };
  }
  totalRowObj.height = 22;

  // ═════════════════ CALCULATION METHOD block ═════════════════

  // Section header bar
  sheet.mergeCells(METHOD_HEADER_ROW, 1, METHOD_HEADER_ROW, notesCol);
  const methodHeaderCell = sheet.getCell(METHOD_HEADER_ROW, 1);
  methodHeaderCell.value = 'CALCULATION METHOD  ·  edit cells below to drive the table above';
  methodHeaderCell.font = { bold: true, size: 11, color: { argb: COLOR.white } };
  methodHeaderCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  methodHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
  sheet.getRow(METHOD_HEADER_ROW).height = 22;

  // Column headers row: Item / Driver | months | Annual | Method
  const methodColHeaderRow = sheet.getRow(METHOD_COL_HEADERS_ROW);
  methodColHeaderRow.values = ['Item / Driver', ...monthLabels, 'Annual', 'Method'];
  methodColHeaderRow.height = 22;
  methodColHeaderRow.eachCell((cell, colNumber) => {
    if (colNumber > notesCol) return;
    cell.font = { bold: true, color: { argb: COLOR.textHeading }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.bgMuted } };
    cell.alignment = {
      horizontal: colNumber === 1 || colNumber === notesCol ? 'left' : 'right',
      vertical: 'middle',
      indent: colNumber === 1 || colNumber === notesCol ? 1 : 0,
    };
    cell.border = { bottom: { style: 'thin', color: { argb: COLOR.border } } };
  });

  // Render each item's sub-rows
  items.forEach((item, idx) => {
    const decomp = decompositions[idx];
    const { startRow } = methodRowsByItem[idx];

    decomp.subRows.forEach((sub, subIdx) => {
      const r = startRow + subIdx;
      const row = sheet.getRow(r);
      const isQtyRow = subIdx === decomp.qtySubRowIndex;

      // Label in column A
      const labelCell = row.getCell(1);
      if (isQtyRow) {
        // The qty sub-row carries the item name. If there are multiple
        // sub-rows we append the sub-label so it's clear what the cells are
        // (e.g. "Consultation Revenue — Units"). Single-row items just show
        // the item name (the sub-label "Monthly Amount" would be redundant).
        labelCell.value = decomp.subRows.length > 1
          ? `${item.name} — ${sub.label}`
          : item.name;
        labelCell.font = { bold: true, color: { argb: COLOR.textHeading } };
        labelCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      } else {
        labelCell.value = sub.label;
        labelCell.font = { color: { argb: COLOR.textMuted }, italic: true };
        labelCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 3 };
      }

      // Per-month values in B-M
      sub.perMonthValues.forEach((v, j) => {
        const c = 2 + j;
        const cell = row.getCell(c);
        cell.value = v;
        cell.numFmt = sub.numFmt;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        cell.font = {
          color: { argb: sub.isInputRow ? COLOR.accentStrong : COLOR.textHeading },
        };
      });

      // Annual SUM if requested (for qty rows; rate / percentage rows leave
      // the Annual column blank to avoid suggesting a meaningful "annual rate")
      if (sub.hasAnnualSum) {
        const annualCell = row.getCell(totalCol);
        annualCell.value = {
          formula: `SUM(${colLetter(2)}${r}:${colLetter(lastMonthCol)}${r})`,
        };
        annualCell.numFmt = sub.numFmt;
        annualCell.alignment = { horizontal: 'right', vertical: 'middle' };
        annualCell.font = { color: { argb: COLOR.textHeading }, bold: true };
      }

      // Notes column on the qty sub-row only
      if (isQtyRow) {
        const notesCell = row.getCell(notesCol);
        notesCell.value = decomp.notes;
        notesCell.font = { color: { argb: COLOR.textMuted }, italic: true, size: 10 };
        notesCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
      }

      // Banded fill — same shade across all sub-rows of an item
      if (idx % 2 === 1) {
        for (let c = 1; c <= notesCol; c++) {
          row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.bgSubtle } };
        }
      }
      row.height = 20;
    });
  });

  return TOTAL_ROW;
}

// ─── Per-item decomposition into method-block sub-rows ─────────────────────

/**
 * Decompose an item into 1-2 sub-rows for the Calculation Method block.
 *
 *   • unit_sales      → Units × Rate (₹/unit)
 *   • billable_hours  → Hours × Rate (₹/hour)
 *   • recurring       → Subscribers × Charge
 *   • pct_specific    → Linked Revenue × Percentage
 *   • pct_overall     → Total Revenue × Percentage
 *   • pct_net_profit  → Net Profit × Percentage  (dividend items)
 *   • everything else → single row of monthly amounts (top cell = direct ref)
 *
 * Sub-row data comes from `item.meta.stepValues` (varying mode) or
 * `item.meta.stepConstants` (constant mode), with sensible fallbacks if
 * neither is populated. For percent-linked items we read the source's
 * monthly amounts from `allValues`.
 */
function decomposeItem(
  item: ForecastItem,
  allValues: Record<number, Record<string, number>>,
  months: string[],
  itemNameById: Map<number, string>,
  allItems: ForecastItem[],
): ItemDecomposition {
  const meta: any = item.meta || {};
  const stepValues: Record<string, Record<string, number>> = meta.stepValues || {};
  const itemAmounts = months.map(m => Number((allValues[item.id] || {})[m] ?? 0));

  // Resolve a step's per-month series. The Forecast page stores each "step"
  // (units / prices / hours / rates / subscribers / charge / etc.) in one
  // of two shapes depending on entry mode:
  //
  //   • "varying" → meta.stepValues[key] = { 'YYYY-MM': number, ... }
  //   • "constant" → meta.stepConstants[key] = { amount, period, startMonth }
  //
  // We don't try to reproduce annual-raise compounding here — the actual
  // computed numbers in allValues already reflect those, and this decomposition
  // is just for readability + editability in Excel. If a user wants the raise
  // applied they edit the per-month cells directly.
  const resolveStep = (key: string): number[] => {
    const sv = stepValues[key] || {};
    const mode: string = meta.stepEntryModes?.[key] || 'varying';
    const constant = meta.stepConstants?.[key] || {};
    if (mode === 'constant') {
      const amt = Number(constant.amount ?? 0);
      const monthly = constant.period === 'year' ? amt / 12 : amt;
      const startMonth: string = constant.startMonth || months[0];
      return months.map(m => (m >= startMonth ? monthly : 0));
    }
    return months.map(m => Number(sv[m] ?? 0));
  };

  // ── Two-step item types (unit_sales / billable_hours / recurring) ──
  const twoStepTypes: Array<{
    type: string;
    qtyKey: string; rateKey: string;
    qtyLabel: string; rateLabel: string;
    unitName: string;
  }> = [
    { type: 'unit_sales',      qtyKey: 'units',       rateKey: 'prices', qtyLabel: 'Units',       rateLabel: 'Rate (₹/unit)',       unitName: 'unit' },
    { type: 'billable_hours',  qtyKey: 'hours',       rateKey: 'rates',  qtyLabel: 'Hours',       rateLabel: 'Rate (₹/hour)',       unitName: 'hour' },
    { type: 'recurring',       qtyKey: 'subscribers', rateKey: 'charge', qtyLabel: 'Subscribers', rateLabel: 'Charge (₹/subscriber)', unitName: 'subscriber' },
  ];
  for (const t of twoStepTypes) {
    if (item.item_type !== t.type) continue;
    const qty = resolveStep(t.qtyKey);
    const rate = resolveStep(t.rateKey);
    // Only use this decomposition if at least one side has real data, else
    // fall through to the single-row fallback (avoids an all-zeros method
    // block for legacy items that pre-date the step-values storage).
    if (qty.some(v => v > 0) || rate.some(v => v > 0)) {
      return {
        subRows: [
          { label: t.qtyLabel,  perMonthValues: qty,  numFmt: NUM_FMT, hasAnnualSum: true,  isInputRow: true },
          { label: t.rateLabel, perMonthValues: rate, numFmt: NUM_FMT, hasAnnualSum: false, isInputRow: true },
        ],
        qtySubRowIndex: 0,
        rateSubRowIndex: 1,
        notes: stepDecompositionNote(qty, rate, t.unitName),
      };
    }
  }

  // ── Percent-of-specific-revenue (specific_cost / personnel / expenses) ──
  // The Forecast page stores the link as meta.linked_revenue_id (some
  // categories) or meta.linkedRevenueId (specific_cost). The percentage
  // lives in meta.percent_of_revenue or meta.percentOfStream depending on
  // category. Accept any of them.
  const linkedRevenueId = meta.linked_revenue_id ?? meta.linkedRevenueId;
  const percentValue = meta.percent_of_revenue ?? meta.percentOfStream;
  const isPctSpecific = item.entry_mode === 'pct_specific'
    || (item.entry_mode === 'percent' && linkedRevenueId);
  if (isPctSpecific && linkedRevenueId && percentValue != null) {
    const linkedName = itemNameById.get(linkedRevenueId) || `item #${linkedRevenueId}`;
    const linkedValues = allValues[linkedRevenueId] || {};
    const linkedPerMonth = months.map(m => Number(linkedValues[m] ?? 0));
    const pctFraction = Number(percentValue) / 100;
    return {
      subRows: [
        { label: `Linked: ${linkedName}`, perMonthValues: linkedPerMonth, numFmt: NUM_FMT, hasAnnualSum: true,  isInputRow: false },
        { label: 'Percentage',             perMonthValues: months.map(() => pctFraction), numFmt: PCT_FMT, hasAnnualSum: false, isInputRow: true },
      ],
      qtySubRowIndex: 0,
      rateSubRowIndex: 1,
      notes: `${percentValue}% of "${linkedName}"`,
    };
  }

  // ── Percent of total (overall) revenue ──
  if (item.entry_mode === 'pct_overall' && percentValue != null) {
    const revItems = allItems.filter(i => i.category === 'revenue');
    const totalRev = months.map(m =>
      revItems.reduce((s, ri) => s + Number((allValues[ri.id] || {})[m] ?? 0), 0)
    );
    const pctFraction = Number(percentValue) / 100;
    return {
      subRows: [
        { label: 'Total Revenue', perMonthValues: totalRev, numFmt: NUM_FMT, hasAnnualSum: true,  isInputRow: false },
        { label: 'Percentage',     perMonthValues: months.map(() => pctFraction), numFmt: PCT_FMT, hasAnnualSum: false, isInputRow: true },
      ],
      qtySubRowIndex: 0,
      rateSubRowIndex: 1,
      notes: `${percentValue}% of Total Revenue`,
    };
  }

  // ── % of net profit (dividend items) ──
  const pctNetProfit = meta.pct_net_profit;
  if (item.entry_mode === 'pct_net_profit' && pctNetProfit != null) {
    const netProfitPerMonth = months.map(m => {
      const sumByCat = (cat: string) => allItems
        .filter(i => i.category === cat)
        .reduce((s, i) => s + Number((allValues[i.id] || {})[m] ?? 0), 0);
      return sumByCat('revenue')
        - sumByCat('direct_costs')
        - sumByCat('personnel')
        - sumByCat('expenses')
        - sumByCat('taxes');
    });
    const pctFraction = Number(pctNetProfit) / 100;
    return {
      subRows: [
        { label: 'Net Profit (computed)', perMonthValues: netProfitPerMonth, numFmt: NUM_FMT, hasAnnualSum: true,  isInputRow: false },
        { label: 'Percentage',              perMonthValues: months.map(() => pctFraction), numFmt: PCT_FMT, hasAnnualSum: false, isInputRow: true },
      ],
      qtySubRowIndex: 0,
      rateSubRowIndex: 1,
      notes: `${pctNetProfit}% of Net Profit`,
    };
  }

  // ── Single-input fallback (revenue_only / general_cost / one_time / varying) ──
  return {
    subRows: [
      { label: 'Monthly Amount', perMonthValues: itemAmounts, numFmt: NUM_FMT, hasAnnualSum: true, isInputRow: true },
    ],
    qtySubRowIndex: 0,
    rateSubRowIndex: null,
    notes: describeCalculation(item, itemNameById, allValues),
  };
}

/**
 * Build a one-line note like "1,131 units/month × ₹826/unit" or
 * "varying units/month × ₹800–₹900/unit" describing a two-step
 * decomposition (qty × rate).
 */
function stepDecompositionNote(
  qtySeries: number[],
  rateSeries: number[],
  unitName: string,
): string {
  const qtyNonZero = qtySeries.filter(v => v > 0);
  const rateNonZero = rateSeries.filter(v => v > 0);

  let qtyStr = 'no quantities';
  if (qtyNonZero.length > 0) {
    const qtyAllSame = qtyNonZero.every(v => v === qtyNonZero[0]);
    if (qtyAllSame) {
      qtyStr = `${formatRupees(qtyNonZero[0])} ${unitName}s/month`;
    } else {
      const avgQty = Math.round(qtyNonZero.reduce((a, b) => a + b, 0) / qtyNonZero.length);
      qtyStr = `~${formatRupees(avgQty)} ${unitName}s/month (varying)`;
    }
  }

  let rateStr = 'no rate';
  if (rateNonZero.length > 0) {
    const rateAllSame = rateNonZero.every(v => v === rateNonZero[0]);
    if (rateAllSame) {
      rateStr = `₹${formatRupees(rateNonZero[0])}/${unitName}`;
    } else {
      const min = Math.min(...rateNonZero);
      const max = Math.max(...rateNonZero);
      rateStr = `₹${formatRupees(min)}–₹${formatRupees(max)}/${unitName}`;
    }
  }

  return `${qtyStr} × ${rateStr}`;
}

// ─── Calculation method (plain-English) derivation ──────────────────────────

function describeCalculation(
  item: ForecastItem,
  itemNameById: Map<number, string>,
  allValues: Record<number, Record<string, number>>,
): string {
  const meta: any = item.meta || {};
  const start = item.start_month ? formatYYYYMM(item.start_month) : '';
  const startSuffix = start ? ` from ${start}` : '';
  const raiseSuffix = item.annual_raise_pct && item.annual_raise_pct > 0
    ? `, with ${item.annual_raise_pct}% annual raise compounding from ${start || 'the start of FY'}`
    : '';

  // ── Step-based revenue (unit_sales / billable_hours / recurring) ──
  if (item.item_type) {
    const u = meta.units ?? meta.unit_count;
    const p = meta.price ?? meta.unit_price;
    const freq = meta.frequency ?? meta.period;
    if (item.item_type === 'unit_sales' && u != null && p != null) {
      return `${u} units × ₹${formatRupees(p)}${freq ? ` ${freq}` : '/month'}${raiseSuffix}`;
    }
    if (item.item_type === 'billable_hours' && meta.hours_per_month != null && meta.hourly_rate != null) {
      return `${meta.hours_per_month} hrs × ₹${formatRupees(meta.hourly_rate)}/hour${raiseSuffix}`;
    }
    if (item.item_type === 'recurring' && item.constant_amount) {
      return `Recurring ₹${formatRupees(item.constant_amount)}/${item.constant_period === 'year' ? 'year' : 'month'}${startSuffix}${raiseSuffix}`;
    }
  }

  // ── Percentage-of-other-item modes ──
  const linkedId = meta.linked_item_id ?? meta.parent_item_id;
  const pct = meta.percentage ?? meta.pct;
  if (item.entry_mode === 'pct_specific' && linkedId && pct != null) {
    const linkedName = itemNameById.get(linkedId) || `item #${linkedId}`;
    return `${pct}% of "${linkedName}"`;
  }
  if ((item.entry_mode === 'percent' || item.entry_mode === 'pct_overall') && pct != null) {
    return `${pct}% of total ${labelForCategory(item.category)}`;
  }

  // ── Constant amount stored on the item ──
  if (item.entry_mode === 'constant' && item.constant_amount) {
    if (item.constant_period === 'year') {
      const monthly = item.constant_amount / 12;
      return `₹${formatRupees(item.constant_amount)} per year (≈₹${formatRupees(monthly)}/month)${startSuffix}${raiseSuffix}`;
    }
    return `Constant ₹${formatRupees(item.constant_amount)}/month${startSuffix}${raiseSuffix}`;
  }

  // ── Fallbacks: derive from actual monthly values in allValues ──
  // Many items in real data are stored with entry_mode='varying' or with
  // entry_mode='constant' but no constant_amount on the row (the user typed
  // values directly into each month). The shape of those values still tells
  // us whether the item is effectively a constant, has a known raise, or is
  // genuinely varying — derive a useful description from there.
  const monthValues = (allValues[item.id] ?? {}) as Record<string, number>;
  const sortedMonths = Object.keys(monthValues).sort();
  const series = sortedMonths.map(m => monthValues[m] ?? 0);
  const nonZero = series.filter(v => v !== 0);

  if (nonZero.length === 0) {
    return 'No values entered yet — fill the input cells to drive the table above.';
  }

  const allEqual = nonZero.every(v => v === nonZero[0]);
  if (allEqual) {
    const v = nonZero[0];
    const annual = v * series.length;
    return `Constant ₹${formatRupees(v)}/month (₹${formatRupees(annual)}/yr equivalent). Edit any month cell to override.`;
  }

  // Two-tier pattern: e.g. constant for first half then a step-up — common
  // for raise-driven items where the engine writes the raised amount only
  // for months ≥ raise anniversary.
  const distinct = Array.from(new Set(nonZero)).sort((a, b) => a - b);
  if (distinct.length === 2) {
    const [low, high] = distinct;
    const stepPct = low > 0 ? Math.round(((high - low) / low) * 100) : 0;
    return `Two-step pattern: ₹${formatRupees(low)}/mo then ₹${formatRupees(high)}/mo (${stepPct}% step). Edit any cell to override.`;
  }

  // Genuinely varying (3+ distinct values)
  const minV = Math.min(...nonZero);
  const maxV = Math.max(...nonZero);
  const avg = Math.round(nonZero.reduce((a, b) => a + b, 0) / nonZero.length);
  return `Varies month-to-month: ₹${formatRupees(minV)} to ₹${formatRupees(maxV)} (avg ₹${formatRupees(avg)}/mo). Edit any cell to override.`;
}

// ─── Summary sheet renderer ─────────────────────────────────────────────────

interface SummarySheetOpts {
  sheet: ExcelJS.Worksheet;
  contextLine: string;
  months: string[];
  monthLabels: string[];
  settings: Record<string, any>;
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  categorySheetNames: Record<string, string>;
  totalRowByCategory: Record<string, number>;
}

function renderSummarySheet(o: SummarySheetOpts): void {
  const { sheet, contextLine, months, monthLabels, settings, items, allValues,
          categorySheetNames, totalRowByCategory } = o;
  const totalCol = 2 + months.length;
  const lastMonthCol = 1 + months.length;

  // ─ Column widths & frozen panes ─
  sheet.getColumn(1).width = 34;
  for (let c = 2; c <= lastMonthCol; c++) sheet.getColumn(c).width = 12;
  sheet.getColumn(totalCol).width = 14;

  // ─ Row 1: title bar ─
  sheet.mergeCells(1, 1, 1, totalCol);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = 'FORECAST SUMMARY';
  titleCell.font = { bold: true, size: 16, color: { argb: COLOR.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  sheet.getRow(1).height = 32;

  // ─ Row 2: context line ─
  sheet.mergeCells(2, 1, 2, totalCol);
  const ctxCell = sheet.getCell(2, 1);
  ctxCell.value = contextLine || ' ';
  ctxCell.font = { italic: true, size: 10, color: { argb: COLOR.textFaint } };
  ctxCell.alignment = { horizontal: 'left', indent: 1 };

  // ─ Row 4: column headers (frozen below this) ─
  const HEADER_ROW = 4;
  const hdr = sheet.getRow(HEADER_ROW);
  hdr.values = ['Particulars', ...monthLabels, 'Total'];
  hdr.height = 22;
  hdr.eachCell((cell, colNumber) => {
    if (colNumber > totalCol) return;
    cell.font = { bold: true, color: { argb: COLOR.white }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
    cell.alignment = { horizontal: colNumber === 1 ? 'left' : 'right', vertical: 'middle' };
  });

  // Helper: ref to category Total cell on its sheet, e.g. ='Revenue'!B12
  const catRef = (catKey: string, monthCol: number): string => {
    const sheetName = categorySheetNames[catKey];
    const totalRow = totalRowByCategory[catKey];
    const safe = sheetName.includes(' ') ? `'${sheetName}'` : sheetName;
    return `${safe}!${colLetter(monthCol)}${totalRow}`;
  };

  // Helper: write a formula across all month columns + a Total column (sum of months)
  const writeFormulaRow = (
    rowIdx: number,
    label: string,
    formulaFor: (monthCol: number) => string,
    style: 'normal' | 'subtotal' | 'highlight' | 'final' = 'normal',
  ): void => {
    const row = sheet.getRow(rowIdx);
    row.getCell(1).value = label;
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: style === 'normal' ? 2 : 1 };
    for (let c = 2; c <= lastMonthCol; c++) {
      const cell = row.getCell(c);
      cell.value = { formula: formulaFor(c) };
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    }
    const tot = row.getCell(totalCol);
    tot.value = {
      formula: `SUM(${colLetter(2)}${rowIdx}:${colLetter(lastMonthCol)}${rowIdx})`,
    };
    tot.numFmt = NUM_FMT;
    tot.alignment = { horizontal: 'right', vertical: 'middle' };

    if (style === 'subtotal' || style === 'highlight') {
      for (let c = 1; c <= totalCol; c++) {
        const cell = row.getCell(c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentSoft } };
        cell.font = { bold: true, color: { argb: COLOR.textHeading } };
      }
      row.height = 20;
    } else if (style === 'final') {
      for (let c = 1; c <= totalCol; c++) {
        const cell = row.getCell(c);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
        cell.font = { bold: true, color: { argb: COLOR.white } };
        cell.border = {
          top: { style: 'medium', color: { argb: COLOR.accentStrong } },
          bottom: { style: 'medium', color: { argb: COLOR.accentStrong } },
        };
      }
      row.height = 22;
    } else {
      for (let c = 1; c <= totalCol; c++) {
        row.getCell(c).font = { color: { argb: COLOR.textHeading } };
      }
    }
  };

  // Helper: write a section title bar across the row
  const writeSectionBar = (rowIdx: number, label: string): void => {
    sheet.mergeCells(rowIdx, 1, rowIdx, totalCol);
    const cell = sheet.getCell(rowIdx, 1);
    cell.value = label;
    cell.font = { bold: true, size: 12, color: { argb: COLOR.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    sheet.getRow(rowIdx).height = 22;
  };

  // ═══════════════ SECTION 1: PROFIT & LOSS ═══════════════
  let r = HEADER_ROW + 1;
  writeSectionBar(r, 'PROFIT & LOSS');
  r += 1;

  const PNL_ROWS: Record<string, number> = {};
  PNL_ROWS.revenue = r++;
  writeFormulaRow(PNL_ROWS.revenue, 'Revenue', c => `=${catRef('revenue', c)}`);
  PNL_ROWS.directCosts = r++;
  writeFormulaRow(PNL_ROWS.directCosts, 'Direct Costs', c => `=${catRef('direct_costs', c)}`);
  PNL_ROWS.grossProfit = r++;
  writeFormulaRow(PNL_ROWS.grossProfit, 'Gross Profit',
    c => `=${colLetter(c)}${PNL_ROWS.revenue}-${colLetter(c)}${PNL_ROWS.directCosts}`,
    'subtotal');
  PNL_ROWS.personnel = r++;
  writeFormulaRow(PNL_ROWS.personnel, 'Personnel', c => `=${catRef('personnel', c)}`);
  PNL_ROWS.expenses = r++;
  writeFormulaRow(PNL_ROWS.expenses, 'Operating Expenses', c => `=${catRef('expenses', c)}`);
  PNL_ROWS.opProfit = r++;
  writeFormulaRow(PNL_ROWS.opProfit, 'Operating Profit',
    c => `=${colLetter(c)}${PNL_ROWS.grossProfit}-${colLetter(c)}${PNL_ROWS.personnel}-${colLetter(c)}${PNL_ROWS.expenses}`,
    'subtotal');
  PNL_ROWS.taxes = r++;
  writeFormulaRow(PNL_ROWS.taxes, 'Taxes', c => `=${catRef('taxes', c)}`);
  PNL_ROWS.dividends = r++;
  writeFormulaRow(PNL_ROWS.dividends, 'Dividends', c => `=${catRef('dividends', c)}`);
  PNL_ROWS.netProfit = r++;
  writeFormulaRow(PNL_ROWS.netProfit, 'Net Profit',
    c => `=${colLetter(c)}${PNL_ROWS.opProfit}-${colLetter(c)}${PNL_ROWS.taxes}-${colLetter(c)}${PNL_ROWS.dividends}`,
    'final');

  r += 1; // blank spacer

  // ═══════════════ SECTION 2: CASH FLOW (INDIRECT) ═══════════════
  // Simplified indirect-method aligned with DashboardCashFlow.tsx behavior.
  // Operating CF = Net Profit + (Depreciation — out of scope for v1)
  // Investing CF = -Asset Purchases
  // Financing CF = -Dividends (- loan repayments + receipts not modelled here)
  writeSectionBar(r, 'CASH FLOW (INDIRECT METHOD)');
  r += 1;

  const CF_ROWS: Record<string, number> = {};
  CF_ROWS.opening = r++;
  {
    const opening = Number(settings?.cash_opening_balance) || 0;
    const row = sheet.getRow(CF_ROWS.opening);
    row.getCell(1).value = 'Opening Cash Balance';
    row.getCell(1).alignment = { horizontal: 'left', indent: 2 };
    // Constant in first month, then 0 (will be displayed as cumulative via Closing row).
    for (let c = 2; c <= lastMonthCol; c++) {
      const cell = row.getCell(c);
      cell.value = c === 2 ? opening : 0;
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: 'right' };
      cell.font = { color: { argb: COLOR.textHeading } };
    }
    row.getCell(totalCol).value = opening;
    row.getCell(totalCol).numFmt = NUM_FMT;
    row.getCell(totalCol).font = { color: { argb: COLOR.textMuted }, italic: true };
    row.getCell(totalCol).alignment = { horizontal: 'right' };
  }

  CF_ROWS.netProfitFromPnL = r++;
  writeFormulaRow(CF_ROWS.netProfitFromPnL, 'Net Profit (from P&L)',
    c => `=${colLetter(c)}${PNL_ROWS.netProfit}`);

  CF_ROWS.assetPurchases = r++;
  writeFormulaRow(CF_ROWS.assetPurchases, 'Less: Asset Purchases',
    c => `=-${catRef('assets', c)}`);

  CF_ROWS.netChange = r++;
  writeFormulaRow(CF_ROWS.netChange, 'Net Change in Cash',
    c => `=${colLetter(c)}${CF_ROWS.netProfitFromPnL}+${colLetter(c)}${CF_ROWS.assetPurchases}`,
    'subtotal');

  CF_ROWS.closing = r++;
  {
    const row = sheet.getRow(CF_ROWS.closing);
    row.getCell(1).value = 'Closing Cash Balance';
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    for (let c = 2; c <= lastMonthCol; c++) {
      const cell = row.getCell(c);
      // Closing[c] = Closing[c-1] + NetChange[c]; first month uses Opening.
      const formula = c === 2
        ? `${colLetter(c)}${CF_ROWS.opening}+${colLetter(c)}${CF_ROWS.netChange}`
        : `${colLetter(c - 1)}${CF_ROWS.closing}+${colLetter(c)}${CF_ROWS.netChange}`;
      cell.value = { formula };
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: 'right' };
    }
    // Closing total = closing of last month (not a sum)
    const tot = row.getCell(totalCol);
    tot.value = { formula: `${colLetter(lastMonthCol)}${CF_ROWS.closing}` };
    tot.numFmt = NUM_FMT;
    tot.alignment = { horizontal: 'right' };
    for (let c = 1; c <= totalCol; c++) {
      const cell = row.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
      cell.font = { bold: true, color: { argb: COLOR.white } };
      cell.border = {
        top: { style: 'medium', color: { argb: COLOR.accentStrong } },
        bottom: { style: 'medium', color: { argb: COLOR.accentStrong } },
      };
    }
    row.height = 22;
  }

  r += 1; // blank spacer

  // ═══════════════ SECTION 3: BALANCE SHEET ═══════════════
  // Simplified — assumes no AR/AP/inventory working capital adjustments.
  // Cash    = closing from CF section (cell ref)
  // LT Assets = opening + cumulative purchases (depreciation skipped in v1)
  // Equity  = opening + cumulative net profit - cumulative dividends
  writeSectionBar(r, 'BALANCE SHEET (END OF MONTH)');
  r += 1;

  const ltOpen = Number(settings?.long_term_assets) || 0;
  const equityOpen = computeOpeningEquity(items, settings);

  const BS_ROWS: Record<string, number> = {};

  BS_ROWS.cash = r++;
  {
    const row = sheet.getRow(BS_ROWS.cash);
    row.getCell(1).value = 'Cash & Bank';
    row.getCell(1).alignment = { horizontal: 'left', indent: 2 };
    for (let c = 2; c <= lastMonthCol; c++) {
      const cell = row.getCell(c);
      cell.value = { formula: `${colLetter(c)}${CF_ROWS.closing}` };
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: 'right' };
      cell.font = { color: { argb: COLOR.textHeading } };
    }
    const tot = row.getCell(totalCol);
    tot.value = { formula: `${colLetter(lastMonthCol)}${BS_ROWS.cash}` };
    tot.numFmt = NUM_FMT;
    tot.alignment = { horizontal: 'right' };
    tot.font = { color: { argb: COLOR.textMuted }, italic: true };
  }

  BS_ROWS.ltAssets = r++;
  {
    const row = sheet.getRow(BS_ROWS.ltAssets);
    row.getCell(1).value = 'Long-term Assets';
    row.getCell(1).alignment = { horizontal: 'left', indent: 2 };
    for (let c = 2; c <= lastMonthCol; c++) {
      const cell = row.getCell(c);
      // LtAssets[c] = ltOpen + cumulative SUM(asset purchases up to and incl. c)
      // = LtAssets[c-1] + asset_purchases_c
      const formula = c === 2
        ? `${ltOpen}+${catRef('assets', c)}`
        : `${colLetter(c - 1)}${BS_ROWS.ltAssets}+${catRef('assets', c)}`;
      cell.value = { formula };
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: 'right' };
      cell.font = { color: { argb: COLOR.textHeading } };
    }
    const tot = row.getCell(totalCol);
    tot.value = { formula: `${colLetter(lastMonthCol)}${BS_ROWS.ltAssets}` };
    tot.numFmt = NUM_FMT;
    tot.alignment = { horizontal: 'right' };
    tot.font = { color: { argb: COLOR.textMuted }, italic: true };
  }

  BS_ROWS.totalAssets = r++;
  writeFormulaRow(BS_ROWS.totalAssets, 'Total Assets',
    c => `=${colLetter(c)}${BS_ROWS.cash}+${colLetter(c)}${BS_ROWS.ltAssets}`,
    'subtotal');

  r += 1;

  BS_ROWS.equity = r++;
  {
    const row = sheet.getRow(BS_ROWS.equity);
    row.getCell(1).value = 'Equity (incl. retained earnings)';
    row.getCell(1).alignment = { horizontal: 'left', indent: 2 };
    for (let c = 2; c <= lastMonthCol; c++) {
      const cell = row.getCell(c);
      // Equity[c] = openEquity + cumulative net profit
      const formula = c === 2
        ? `${equityOpen}+${colLetter(c)}${PNL_ROWS.netProfit}`
        : `${colLetter(c - 1)}${BS_ROWS.equity}+${colLetter(c)}${PNL_ROWS.netProfit}`;
      cell.value = { formula };
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: 'right' };
      cell.font = { color: { argb: COLOR.textHeading } };
    }
    const tot = row.getCell(totalCol);
    tot.value = { formula: `${colLetter(lastMonthCol)}${BS_ROWS.equity}` };
    tot.numFmt = NUM_FMT;
    tot.alignment = { horizontal: 'right' };
    tot.font = { color: { argb: COLOR.textMuted }, italic: true };
  }

  BS_ROWS.totalLiabEquity = r++;
  writeFormulaRow(BS_ROWS.totalLiabEquity, 'Total Liabilities + Equity',
    c => `=${colLetter(c)}${BS_ROWS.equity}`,
    'subtotal');

  r += 1;

  // ─ Footnote ─
  sheet.mergeCells(r, 1, r, totalCol);
  const note = sheet.getCell(r, 1);
  note.value = 'Note: Cash Flow & Balance Sheet are simplified — depreciation, AR/AP working capital, and loan-payable balances are not modelled in this export. Edit cells to override.';
  note.font = { italic: true, size: 9, color: { argb: COLOR.textFaint } };
  note.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
  sheet.getRow(r).height = 28;
}

// ─── Misc helpers ───────────────────────────────────────────────────────────

/** Convert a 1-based column index to the Excel letter (A, B, …, Z, AA, AB, …). */
function colLetter(col: number): string {
  let s = '';
  let n = col;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function formatRupees(n: number): string {
  if (n == null || isNaN(n)) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

function formatYYYYMM(yyyymm: string): string {
  // "2026-04" → "Apr '26"
  return getMonthLabel(yyyymm);
}

function labelForCategory(cat: string): string {
  const map: Record<string, string> = {
    revenue: 'revenue',
    direct_costs: 'direct costs',
    personnel: 'personnel',
    expenses: 'expenses',
    assets: 'assets',
    taxes: 'taxes',
    dividends: 'dividends',
  };
  return map[cat] || cat;
}

/**
 * Approximate opening equity from settings if available, else 0.
 * Used as the BS Equity opening balance — feel free to override in the cell.
 */
function computeOpeningEquity(_items: ForecastItem[], settings: Record<string, any>): number {
  return Number(settings?.opening_equity) || 0;
}

