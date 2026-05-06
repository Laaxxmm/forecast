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

// Discriminator selecting which renderer handles a given category sheet.
// See the CATEGORIES array in `buildForecastWorkbook` for the mapping.
type SheetKind =
  | 'flat'
  | 'personnel'
  | 'assets'
  | 'taxes'
  | 'cash_flow_assumptions'
  | 'initial_balances'
  | 'financing';

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
  /** When set (e.g. 'revenue', 'personnel'), the workbook contains ONLY the
   *  matching category sheet — no Summary, no other categories. Used by the
   *  per-tab "Excel" download to export just that one tab. The full `items`
   *  list is still consumed (so percent-linked decompositions can resolve
   *  cross-category references), but only one sheet is written. */
  singleCategory?: string;
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
  //
  // `kind` discriminates which renderer handles the sheet:
  //   • 'flat'        — one row per item × months, with TOTAL (Revenue/Direct
  //                     Costs/Expenses/Dividends). Items decompose into the
  //                     Calculation Method block via `decomposeItem`.
  //   • 'personnel'   — three sections (Direct Labor / Other Labor / Employee
  //                     Benefits) with subtotals + Headcount info row.
  //   • 'assets'      — three sections (Current / Long-term / Investment)
  //                     with subtotals.
  //   • 'taxes'       — computed from settings + cross-sheet refs (Income Tax
  //                     Accrued/Paid + Sales Tax Accrued/Paid). No items.
  //   • 'cash_flow_assumptions' / 'initial_balances' — settings dumps. No
  //                     monthly grid; not in Summary's P&L.
  //   • 'financing'   — top totals table + per-item loan mechanics block
  //                     (draws/repayments/interest/outstanding balance).
  const CATEGORIES: Array<{
    key: string; label: string; sheetName: string; kind: SheetKind;
  }> = [
    { key: 'revenue',                label: 'Revenue',                sheetName: 'Revenue',                kind: 'flat'       },
    { key: 'direct_costs',           label: 'Direct Costs',           sheetName: 'Direct Costs',           kind: 'flat'       },
    { key: 'personnel',              label: 'Personnel',              sheetName: 'Personnel',              kind: 'personnel'  },
    { key: 'expenses',               label: 'Expenses',               sheetName: 'Expenses',               kind: 'flat'       },
    { key: 'assets',                 label: 'Assets',                 sheetName: 'Assets',                 kind: 'assets'     },
    { key: 'taxes',                  label: 'Taxes',                  sheetName: 'Taxes',                  kind: 'taxes'      },
    { key: 'dividends',              label: 'Dividends',              sheetName: 'Dividends',              kind: 'flat'       },
    { key: 'cash_flow_assumptions',  label: 'Cash Flow Assumptions',  sheetName: 'Cash Flow Assumptions',  kind: 'cash_flow_assumptions' },
    { key: 'initial_balances',       label: 'Initial Balances',       sheetName: 'Initial Balances',       kind: 'initial_balances'      },
    // Financing isn't part of the P&L (loans / investments hit Cash Flow,
    // not the income statement), so the Summary's P&L formulas don't
    // reference it. The sheet still exists for the per-tab Excel download.
    { key: 'financing',              label: 'Financing',              sheetName: 'Financing',              kind: 'financing'  },
  ];

  // Single-category mode skips the Summary sheet entirely (the user is
  // exporting just one tab — there's nothing to summarise across).
  const isSingleCategory = !!opts.singleCategory;
  const categoriesToRender = isSingleCategory
    ? CATEGORIES.filter(c => c.key === opts.singleCategory)
    : CATEGORIES;

  // Build Summary first as a placeholder; we'll fill it after we know each
  // category sheet's Total row position. (exceljs doesn't require us to
  // populate sheets in any particular order — formulas only need the target
  // sheet to exist by save-time.)
  const summary = isSingleCategory ? null : wb.addWorksheet('Summary', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }],
    properties: { tabColor: { argb: COLOR.accent } },
  });

  // Track each category sheet's Total row number so the Summary can reference
  // them via formula. Map: category key → row number on its sheet.
  const totalRowByCategory: Record<string, number> = {};
  // Item-name lookup for `pct_specific` calculation method resolution.
  const itemNameById = new Map<number, string>();
  for (const it of opts.items) itemNameById.set(it.id, it.name);

  // Note: settings-only sheets (cash_flow_assumptions, initial_balances) are
  // built later, AFTER the Summary, so the Summary's category Total row
  // references resolve cleanly. Their `totalRowByCategory` entries are
  // initialised to 0 — the Summary doesn't reference them.
  const SETTINGS_KINDS = new Set<SheetKind>(['cash_flow_assumptions', 'initial_balances']);

  for (const cat of categoriesToRender) {
    if (SETTINGS_KINDS.has(cat.kind)) {
      totalRowByCategory[cat.key] = 0;
      continue;
    }
    const sheet = wb.addWorksheet(cat.sheetName, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }],
      properties: { tabColor: { argb: COLOR.accent } },
    });
    const catItems = opts.items
      .filter(i => i.category === cat.key)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    let totalRow: number;
    switch (cat.kind) {
      case 'personnel':
        totalRow = renderPersonnelSheet({
          sheet, title: cat.label, contextLine,
          months: opts.months, monthLabels,
          items: catItems, allItems: opts.items, allValues: opts.allValues,
          itemNameById,
        });
        break;
      case 'assets':
        totalRow = renderAssetsSheet({
          sheet, title: cat.label, contextLine,
          months: opts.months, monthLabels,
          items: catItems, allItems: opts.items, allValues: opts.allValues,
          itemNameById,
        });
        break;
      case 'taxes':
        totalRow = renderTaxesSheet({
          sheet, title: cat.label, contextLine,
          months: opts.months, monthLabels,
          allItems: opts.items, allValues: opts.allValues,
          settings: opts.settings,
          // Pass the per-category TOTAL row positions accumulated so far
          // (Revenue / Direct Costs / Personnel / Expenses are all rendered
          // before Taxes, so their TOTAL rows are already known here).
          categoryTotalRows: { ...totalRowByCategory },
          categorySheetNames: CATEGORIES.reduce<Record<string, string>>((acc, c) => {
            acc[c.key] = c.sheetName;
            return acc;
          }, {}),
        });
        break;
      case 'financing':
        totalRow = renderFinancingSheet({
          sheet, title: cat.label, contextLine,
          months: opts.months, monthLabels,
          items: catItems, allItems: opts.items, allValues: opts.allValues,
          itemNameById,
        });
        break;
      case 'flat':
      default:
        totalRow = renderCategorySheet({
          sheet, title: cat.label, contextLine,
          months: opts.months, monthLabels,
          items: catItems, allItems: opts.items, allValues: opts.allValues,
          itemNameById,
        });
        break;
    }
    totalRowByCategory[cat.key] = totalRow;
  }

  if (summary) {
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
  }

  // Settings-only sheets — built after the Summary so they end up at the
  // right position in the tab strip (matching the UI tab order).
  for (const cat of categoriesToRender) {
    if (!SETTINGS_KINDS.has(cat.kind)) continue;
    const sheet = wb.addWorksheet(cat.sheetName, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }],
      properties: { tabColor: { argb: COLOR.accent } },
    });
    if (cat.kind === 'cash_flow_assumptions') {
      renderCashFlowAssumptionsSheet({
        sheet, title: cat.label, contextLine,
        allItems: opts.items, settings: opts.settings, itemNameById,
      });
    } else if (cat.kind === 'initial_balances') {
      renderInitialBalancesSheet({
        sheet, title: cat.label, contextLine,
        settings: opts.settings,
      });
    }
  }

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

  // ─ Empty-state placeholder ─
  // When the category has zero items, render a single italic hint row + a
  // TOTAL=0 row so the Summary's `=SheetName!B<totalRow>` formula still
  // resolves cleanly. This replaces the old behaviour of showing a bare
  // TOTAL=0 with no explanation, which left users wondering whether the
  // export was broken.
  if (items.length === 0) {
    const HINT_ROW = HEADER_ROW + 1;
    const EMPTY_TOTAL_ROW = HINT_ROW + 1;
    sheet.mergeCells(HINT_ROW, 1, HINT_ROW, totalCol);
    const hint = sheet.getCell(HINT_ROW, 1);
    hint.value = `No items added yet — add line items on the ${title} tab to populate this sheet.`;
    hint.font = { italic: true, size: 10, color: { argb: COLOR.textFaint } };
    hint.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
    sheet.getRow(HINT_ROW).height = 22;

    const totalRowObj = sheet.getRow(EMPTY_TOTAL_ROW);
    totalRowObj.getCell(1).value = 'TOTAL';
    totalRowObj.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    for (let c = 2; c <= totalCol; c++) {
      const cell = totalRowObj.getCell(c);
      cell.value = 0;
      cell.numFmt = NUM_FMT;
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    }
    for (let c = 1; c <= totalCol; c++) {
      const cell = totalRowObj.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
      cell.font = { bold: true, color: { argb: COLOR.white } };
      cell.border = {
        top: { style: 'medium', color: { argb: COLOR.accentStrong } },
        bottom: { style: 'medium', color: { argb: COLOR.accentStrong } },
      };
    }
    totalRowObj.height = 22;
    return EMPTY_TOTAL_ROW;
  }

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

// ═══════════════════════════════════════════════════════════════════════════
//   Shared layout helpers (used by Personnel / Assets / Taxes / Financing /
//   Cash Flow Assumptions / Initial Balances renderers)
// ═══════════════════════════════════════════════════════════════════════════

/** Standard column count: 1 (label) + 12 (months) + 1 (total) = 14. */
function sheetColumnCount(months: string[]): { lastMonthCol: number; totalCol: number } {
  return { lastMonthCol: 1 + months.length, totalCol: 2 + months.length };
}

/** Apply the standard column widths used by every category sheet. */
function applyStandardColumnWidths(sheet: ExcelJS.Worksheet, months: string[]): void {
  const { lastMonthCol, totalCol } = sheetColumnCount(months);
  sheet.getColumn(1).width = 38;
  for (let c = 2; c <= lastMonthCol; c++) sheet.getColumn(c).width = 12;
  sheet.getColumn(totalCol).width = 14;
}

/** Title bar (row 1) + context line (row 2) + header row (row 4) — the
 *  three rows every category sheet starts with. Returns the header row
 *  index (4) so the caller can start writing data at row 5. */
function writeSheetHeader(
  sheet: ExcelJS.Worksheet,
  title: string,
  contextLine: string,
  monthLabels: string[],
  totalCol: number,
): number {
  // Row 1: emerald title bar
  sheet.mergeCells(1, 1, 1, totalCol);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title.toUpperCase();
  titleCell.font = { bold: true, size: 14, color: { argb: COLOR.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  sheet.getRow(1).height = 26;

  // Row 2: context line
  sheet.mergeCells(2, 1, 2, totalCol);
  const ctxCell = sheet.getCell(2, 1);
  ctxCell.value = contextLine || ' ';
  ctxCell.font = { italic: true, size: 9, color: { argb: COLOR.textFaint } };
  ctxCell.alignment = { horizontal: 'left', indent: 1 };

  // Row 4: column headers
  const HEADER_ROW = 4;
  const headerRow = sheet.getRow(HEADER_ROW);
  headerRow.values = ['Particulars', ...monthLabels, 'Total'];
  headerRow.height = 22;
  headerRow.eachCell((cell, colNumber) => {
    if (colNumber > totalCol) return;
    cell.font = { bold: true, color: { argb: COLOR.white }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
    cell.alignment = { horizontal: colNumber === 1 ? 'left' : 'right', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: COLOR.accent } } };
  });

  return HEADER_ROW;
}

/** Write a full-width emerald section bar (e.g. "Direct Labor", "Income Tax"). */
function writeSheetSectionBar(
  sheet: ExcelJS.Worksheet,
  rowIdx: number,
  label: string,
  totalCol: number,
  rateLabel?: string,
): void {
  sheet.mergeCells(rowIdx, 1, rowIdx, totalCol);
  const cell = sheet.getCell(rowIdx, 1);
  cell.value = rateLabel ? `${label}   (${rateLabel})` : label;
  cell.font = { bold: true, size: 11, color: { argb: COLOR.white } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
  cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  sheet.getRow(rowIdx).height = 22;
}

/** Write a single data row — label in col A, per-month values in B..M,
 *  optional row-total in the last column (formula sums B..M). */
function writeDataRow(
  sheet: ExcelJS.Worksheet,
  rowIdx: number,
  label: string,
  perMonthValues: Array<number | { formula: string }>,
  totalCol: number,
  opts: {
    indent?: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    numFmt?: string;
    bandedFill?: boolean;
    rowTotal?: 'sum' | 'last' | { formula: string } | null;
  } = {},
): void {
  const numFmt = opts.numFmt ?? NUM_FMT;
  const fontColor = opts.color ?? COLOR.textHeading;
  const row = sheet.getRow(rowIdx);

  const labelCell = row.getCell(1);
  labelCell.value = label;
  labelCell.alignment = { horizontal: 'left', vertical: 'middle', indent: opts.indent ?? 1 };
  labelCell.font = { color: { argb: fontColor }, bold: !!opts.bold, italic: !!opts.italic };

  perMonthValues.forEach((v, j) => {
    const c = 2 + j;
    const cell = row.getCell(c);
    cell.value = v as any;
    cell.numFmt = numFmt;
    cell.alignment = { horizontal: 'right', vertical: 'middle' };
    cell.font = { color: { argb: fontColor }, bold: !!opts.bold, italic: !!opts.italic };
  });

  // Row total column
  const totCell = row.getCell(totalCol);
  if (opts.rowTotal === null || opts.rowTotal === undefined || opts.rowTotal === 'sum') {
    totCell.value = { formula: `SUM(${colLetter(2)}${rowIdx}:${colLetter(totalCol - 1)}${rowIdx})` };
  } else if (opts.rowTotal === 'last') {
    totCell.value = { formula: `${colLetter(totalCol - 1)}${rowIdx}` };
  } else {
    totCell.value = { formula: opts.rowTotal.formula };
  }
  totCell.numFmt = numFmt;
  totCell.alignment = { horizontal: 'right', vertical: 'middle' };
  totCell.font = { color: { argb: fontColor }, bold: !!opts.bold, italic: !!opts.italic };

  if (opts.bandedFill) {
    for (let c = 1; c <= totalCol; c++) {
      row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.bgSubtle } };
    }
  }
}

/** Apply emerald "TOTAL" highlight to a row that's already been written. */
function applyTotalRowStyle(sheet: ExcelJS.Worksheet, rowIdx: number, totalCol: number): void {
  const row = sheet.getRow(rowIdx);
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

/** Apply soft-emerald "subtotal" highlight to a row. */
function applySubtotalRowStyle(sheet: ExcelJS.Worksheet, rowIdx: number, totalCol: number): void {
  const row = sheet.getRow(rowIdx);
  for (let c = 1; c <= totalCol; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentSoft } };
    cell.font = { bold: true, color: { argb: COLOR.textHeading } };
  }
  row.height = 20;
}

// ═══════════════════════════════════════════════════════════════════════════
//   Personnel sheet — 3 sections + computed Benefits + Headcount info row
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors PersonnelTab.tsx:
//   • Direct Labor          (items where meta.labor_type === 'direct_labor')
//   • Other Labor           (everything else that isn't an employee_benefits item)
//   • Employee Benefits     (items where item_type === 'employee_benefits')
//     — the "Computed Benefits Cost" sub-row mirrors the UI's
//       `onStaffSalary × rate%` calculation as a live Excel formula.
//   • TOTAL PERSONNEL       (sum of three subtotals)
//   • Headcount             (info row, italic — not summed in TOTAL)

interface PersonnelSheetOpts {
  sheet: ExcelJS.Worksheet;
  title: string;
  contextLine: string;
  months: string[];
  monthLabels: string[];
  items: ForecastItem[];
  allItems: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  itemNameById: Map<number, string>;
}

function renderPersonnelSheet(o: PersonnelSheetOpts): number {
  const { sheet, title, contextLine, months, monthLabels, items, allItems,
          allValues, itemNameById } = o;
  const { lastMonthCol, totalCol } = sheetColumnCount(months);
  applyStandardColumnWidths(sheet, months);
  writeSheetHeader(sheet, title, contextLine, monthLabels, totalCol);

  // Empty state
  if (items.length === 0) {
    return writeEmptySheetTotalRow(sheet, title, monthLabels, totalCol);
  }

  // Section split — mirrors PersonnelTab.tsx:41-43
  const directLaborItems = items.filter(i => i.item_type !== 'employee_benefits' && (i.meta as any)?.labor_type === 'direct_labor')
                                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const otherLaborItems  = items.filter(i => i.item_type !== 'employee_benefits' && (i.meta as any)?.labor_type !== 'direct_labor')
                                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const benefitsItems    = items.filter(i => i.item_type === 'employee_benefits')
                                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const onStaffPersonnelItems = items.filter(i => i.item_type !== 'employee_benefits' && (i.meta as any)?.staffing_type !== 'contract');

  // Track row indices we'll need for totals + summary references
  let r = 5;
  const itemRowById = new Map<number, number>();   // item.id → row in this sheet

  const writeSection = (
    sectionLabel: string,
    sectionItems: ForecastItem[],
    subtotalKey: string,
  ): { subtotalRow: number; itemRowRange: [number, number] | null } => {
    writeSheetSectionBar(sheet, r, sectionLabel, totalCol);
    r += 1;

    if (sectionItems.length === 0) {
      writeDataRow(sheet, r, 'No items in this section', months.map(() => 0), totalCol, {
        italic: true, color: COLOR.textFaint, indent: 3,
      });
      const onlyRow = r;
      r += 1;
      // Subtotal row references the empty row — gives 0 but keeps formula chain valid
      writeDataRow(sheet, r, `Subtotal: ${sectionLabel}`,
        months.map((_, j) => ({ formula: `${colLetter(2 + j)}${onlyRow}` })),
        totalCol,
        { bold: true, indent: 1 });
      const subtotalRow = r;
      applySubtotalRowStyle(sheet, subtotalRow, totalCol);
      r += 1;
      return { subtotalRow, itemRowRange: null };
    }

    const firstItemRow = r;
    sectionItems.forEach((item, idx) => {
      const itemValues = allValues[item.id] || {};
      const perMonth = months.map(m => Number(itemValues[m] ?? 0));
      writeDataRow(sheet, r, item.name, perMonth, totalCol, {
        indent: 3, bandedFill: idx % 2 === 1,
      });
      itemRowById.set(item.id, r);
      r += 1;
    });
    const lastItemRow = r - 1;

    // Subtotal row — formula sums the items above
    writeDataRow(sheet, r, `Subtotal: ${sectionLabel}`,
      months.map((_, j) => {
        const colL = colLetter(2 + j);
        return { formula: `SUM(${colL}${firstItemRow}:${colL}${lastItemRow})` };
      }),
      totalCol,
      { bold: true, indent: 1 });
    const subtotalRow = r;
    applySubtotalRowStyle(sheet, subtotalRow, totalCol);
    r += 1;

    // Identify the subtotal for benefits formula references
    void subtotalKey;
    return { subtotalRow, itemRowRange: [firstItemRow, lastItemRow] };
  };

  const directSection  = writeSection('Direct Labor', directLaborItems, 'direct_labor');
  const otherSection   = writeSection('Other Labor',  otherLaborItems,  'other_labor');

  // Employee Benefits section — special case. Items themselves carry the
  // RATE in meta; the actual monthly cost = on-staff salary × rate. Render
  // the items as info rows (showing the configured rate %) plus a computed
  // "Computed Benefits Cost" row whose values are real Excel formulas
  // referencing the on-staff items in Direct Labor + Other Labor by cell.
  writeSheetSectionBar(sheet, r, 'Employee Benefits', totalCol);
  r += 1;

  const benefitsItem = benefitsItems[0];
  const benefitsRatePct = benefitsItem
    ? Number((benefitsItem.meta as any)?.stepConstants?.rate?.amount ?? 0)
    : 0;
  const isBenefitsVarying = !!benefitsItem
    && (benefitsItem.meta as any)?.stepEntryModes?.rate === 'varying';

  benefitsItems.forEach((item, idx) => {
    let label: string;
    let perMonthValues: Array<number | { formula: string }>;
    if (isBenefitsVarying && item === benefitsItem) {
      const stepRates = (item.meta as any)?.stepValues?.rate || {};
      const rates = months.map(m => Number(stepRates[m] ?? 0));
      label = `${item.name}  (varying rate)`;
      perMonthValues = rates.map(v => v / 100);
      writeDataRow(sheet, r, label, perMonthValues, totalCol, {
        indent: 3, italic: true, color: COLOR.textMuted,
        numFmt: PCT_FMT, rowTotal: { formula: `""` },
        bandedFill: idx % 2 === 1,
      });
    } else {
      const ratePct = Number((item.meta as any)?.stepConstants?.rate?.amount ?? 0);
      label = `${item.name}  (constant rate)`;
      perMonthValues = months.map(() => ratePct / 100);
      writeDataRow(sheet, r, label, perMonthValues, totalCol, {
        indent: 3, italic: true, color: COLOR.textMuted,
        numFmt: PCT_FMT, rowTotal: { formula: `""` },
        bandedFill: idx % 2 === 1,
      });
    }
    itemRowById.set(item.id, r);
    r += 1;
  });

  // Resolve the on-staff personnel item rows (cells that contribute to the
  // benefits base). These are items in Direct Labor or Other Labor whose
  // meta.staffing_type !== 'contract'. We sum them per-month.
  const onStaffRows = onStaffPersonnelItems
    .map(i => itemRowById.get(i.id))
    .filter((x): x is number => x != null);

  // Computed Benefits Cost row — real Excel formula
  const benefitsRateRow = benefitsItems[0] ? itemRowById.get(benefitsItems[0].id) : null;
  if (benefitsItems.length === 0) {
    writeDataRow(sheet, r, 'No benefits configured', months.map(() => 0), totalCol, {
      italic: true, color: COLOR.textFaint, indent: 3,
    });
    r += 1;
    writeDataRow(sheet, r, 'Subtotal: Employee Benefits',
      months.map(() => 0),
      totalCol,
      { bold: true, indent: 1 });
  } else if (onStaffRows.length === 0) {
    writeDataRow(sheet, r, 'Computed Benefits Cost',
      months.map(() => 0), totalCol,
      { italic: true, color: COLOR.textMuted, indent: 3 });
    const computedRow = r;
    r += 1;
    writeDataRow(sheet, r, 'Subtotal: Employee Benefits',
      months.map((_, j) => ({ formula: `${colLetter(2 + j)}${computedRow}` })),
      totalCol,
      { bold: true, indent: 1 });
  } else {
    writeDataRow(sheet, r, 'Computed Benefits Cost  (= on-staff salaries × rate)',
      months.map((_, j) => {
        const colL = colLetter(2 + j);
        const sumExpr = onStaffRows.map(rr => `${colL}${rr}`).join('+');
        if (isBenefitsVarying && benefitsRateRow) {
          // Use per-month rate cell from the varying item
          return { formula: `ROUND((${sumExpr})*${colL}${benefitsRateRow}, 0)` };
        }
        // Constant rate — multiply by the rate cell on the item row (each
        // month cell holds the same percent value, so any column works,
        // but referencing the same column keeps the formula self-similar).
        const rateRef = benefitsRateRow ? `${colL}${benefitsRateRow}` : `${benefitsRatePct / 100}`;
        return { formula: `ROUND((${sumExpr})*${rateRef}, 0)` };
      }),
      totalCol,
      { bold: false, indent: 3, color: COLOR.accentStrong });
    const computedRow = r;
    r += 1;
    writeDataRow(sheet, r, 'Subtotal: Employee Benefits',
      months.map((_, j) => ({ formula: `${colLetter(2 + j)}${computedRow}` })),
      totalCol,
      { bold: true, indent: 1 });
  }
  const benefitsSubtotalRow = r;
  applySubtotalRowStyle(sheet, benefitsSubtotalRow, totalCol);
  r += 1;

  // Spacer
  r += 1;

  // TOTAL PERSONNEL
  writeDataRow(sheet, r, 'TOTAL PERSONNEL',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      return { formula: `${colL}${directSection.subtotalRow}+${colL}${otherSection.subtotalRow}+${colL}${benefitsSubtotalRow}` };
    }),
    totalCol,
    { bold: true, indent: 1 });
  const TOTAL_ROW = r;
  applyTotalRowStyle(sheet, TOTAL_ROW, totalCol);
  r += 2;

  // Headcount info row — counts on-staff personnel per month.
  // For per-month values we read the actual headcount from each item's meta
  // (group items use meta.stepValues.headcount[month], individuals = 1 if
  // they have a non-zero salary that month). This is informational; not
  // included in the TOTAL.
  const headcountPerMonth = months.map(m => {
    let count = 0;
    for (const it of items) {
      if (it.item_type === 'employee_benefits') continue;
      const hasSalary = Number((allValues[it.id] || {})[m] ?? 0) > 0;
      if (!hasSalary) continue;
      if (it.item_type === 'group') {
        count += Number((it.meta as any)?.stepValues?.headcount?.[m] ?? 0);
      } else {
        count += 1;
      }
    }
    return count;
  });
  writeDataRow(sheet, r, 'Headcount  (info — not summed)', headcountPerMonth, totalCol, {
    indent: 1, italic: true, color: COLOR.textMuted, numFmt: '0',
    rowTotal: { formula: `MAX(${colLetter(2)}${r}:${colLetter(lastMonthCol)}${r})` },
  });

  // Use itemNameById to silence unused-var warning even when not needed
  void itemNameById;
  void allItems;

  return TOTAL_ROW;
}

/** Tiny helper: when a sheet has no items, write an empty TOTAL=0 row at
 *  row 6 (after a single italic placeholder row at row 5) and return its
 *  row number. Used by Personnel/Assets/Financing renderers. */
function writeEmptySheetTotalRow(
  sheet: ExcelJS.Worksheet,
  title: string,
  monthLabels: string[],
  totalCol: number,
): number {
  void monthLabels;
  const HINT_ROW = 5;
  const TOTAL_ROW = 6;
  sheet.mergeCells(HINT_ROW, 1, HINT_ROW, totalCol);
  const hint = sheet.getCell(HINT_ROW, 1);
  hint.value = `No items added yet — add line items on the ${title} tab to populate this sheet.`;
  hint.font = { italic: true, size: 10, color: { argb: COLOR.textFaint } };
  hint.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
  sheet.getRow(HINT_ROW).height = 22;

  writeDataRow(sheet, TOTAL_ROW, `TOTAL ${title.toUpperCase()}`,
    Array(totalCol - 2).fill(0),
    totalCol, { bold: true, indent: 1 });
  applyTotalRowStyle(sheet, TOTAL_ROW, totalCol);
  return TOTAL_ROW;
}

// ═══════════════════════════════════════════════════════════════════════════
//   Assets sheet — 3 sections (Current / Long-term / Investment)
// ═══════════════════════════════════════════════════════════════════════════

interface AssetsSheetOpts {
  sheet: ExcelJS.Worksheet;
  title: string;
  contextLine: string;
  months: string[];
  monthLabels: string[];
  items: ForecastItem[];
  allItems: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  itemNameById: Map<number, string>;
}

function renderAssetsSheet(o: AssetsSheetOpts): number {
  const { sheet, title, contextLine, months, monthLabels, items,
          allValues, itemNameById, allItems } = o;
  void itemNameById; void allItems;
  const { totalCol } = sheetColumnCount(months);
  applyStandardColumnWidths(sheet, months);
  writeSheetHeader(sheet, title, contextLine, monthLabels, totalCol);

  if (items.length === 0) {
    return writeEmptySheetTotalRow(sheet, title, monthLabels, totalCol);
  }

  // Section split — mirrors AssetsTab.tsx:30-32. "long_term" or no type
  // both fall into the Long-term section.
  const currentItems     = items.filter(i => i.item_type === 'current')
                                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const longTermItems    = items.filter(i => i.item_type === 'long_term' || !i.item_type)
                                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const investmentItems  = items.filter(i => i.item_type === 'investment')
                                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  let r = 5;
  const subtotalRows: number[] = [];

  const writeSection = (sectionLabel: string, sectionItems: ForecastItem[]) => {
    writeSheetSectionBar(sheet, r, sectionLabel, totalCol);
    r += 1;

    if (sectionItems.length === 0) {
      writeDataRow(sheet, r, 'No items in this section', months.map(() => 0), totalCol, {
        italic: true, color: COLOR.textFaint, indent: 3,
      });
      const onlyRow = r;
      r += 1;
      writeDataRow(sheet, r, `Subtotal: ${sectionLabel}`,
        months.map((_, j) => ({ formula: `${colLetter(2 + j)}${onlyRow}` })),
        totalCol, { bold: true, indent: 1 });
    } else {
      const firstItemRow = r;
      sectionItems.forEach((item, idx) => {
        const perMonth = months.map(m => Number((allValues[item.id] || {})[m] ?? 0));
        writeDataRow(sheet, r, item.name, perMonth, totalCol, {
          indent: 3, bandedFill: idx % 2 === 1,
        });
        r += 1;
      });
      const lastItemRow = r - 1;
      writeDataRow(sheet, r, `Subtotal: ${sectionLabel}`,
        months.map((_, j) => {
          const colL = colLetter(2 + j);
          return { formula: `SUM(${colL}${firstItemRow}:${colL}${lastItemRow})` };
        }),
        totalCol, { bold: true, indent: 1 });
    }
    applySubtotalRowStyle(sheet, r, totalCol);
    subtotalRows.push(r);
    r += 1;
  };

  writeSection('Current Assets',     currentItems);
  writeSection('Long-term Assets',   longTermItems);
  writeSection('Investment Assets',  investmentItems);

  r += 1;  // spacer

  // TOTAL ASSETS
  writeDataRow(sheet, r, 'TOTAL ASSETS',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      return { formula: subtotalRows.map(rr => `${colL}${rr}`).join('+') };
    }),
    totalCol, { bold: true, indent: 1 });
  const TOTAL_ROW = r;
  applyTotalRowStyle(sheet, TOTAL_ROW, totalCol);

  return TOTAL_ROW;
}

// ═══════════════════════════════════════════════════════════════════════════
//   Taxes sheet — computed Income Tax + Sales Tax (Accrued / Paid)
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors TaxesTab.tsx. Two computed sections:
//
//   Income Tax:
//     Net Profit (computed)  =Revenue − DirectCosts − Personnel − Expenses
//     Income Tax Accrued     =MAX(0, NetProfit) × rate%
//     Income Tax Paid        (distributed per frequency: monthly / quarterly
//                             / annually / custom — see computeTaxPaidShares)
//
//   Sales Tax:
//     Taxable Revenue        =SUM(selected revenue items, or all revenue)
//     Sales Tax Accrued      =Taxable Revenue × rate%
//     Sales Tax Paid         (distributed per frequency, lagged 1 period)
//
// All cell values are real Excel formulas referencing the Revenue / Direct
// Costs / Personnel / Expenses sheets — so editing any input on those sheets
// recomputes the Taxes sheet live.

interface TaxesSheetOpts {
  sheet: ExcelJS.Worksheet;
  title: string;
  contextLine: string;
  months: string[];
  monthLabels: string[];
  allItems: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  settings: Record<string, any>;
  /** TOTAL row positions for categories already rendered (Revenue, Direct
   *  Costs, Personnel, Expenses). Used to build the Net Profit formula
   *  that references the right cells on each P&L sheet. */
  categoryTotalRows: Record<string, number>;
  /** Map of category key → sheet name (for formula references). */
  categorySheetNames: Record<string, string>;
}

function renderTaxesSheet(o: TaxesSheetOpts): number {
  const { sheet, title, contextLine, months, monthLabels, allItems, allValues,
          settings, categoryTotalRows, categorySheetNames } = o;
  const { lastMonthCol, totalCol } = sheetColumnCount(months);
  applyStandardColumnWidths(sheet, months);
  writeSheetHeader(sheet, title, contextLine, monthLabels, totalCol);

  // Build a "ref to category sheet's TOTAL cell at column c" helper.
  // Falls back to a literal 0 if the category wasn't rendered (defensive).
  const catTotalRef = (catKey: string, monthCol: number): string => {
    const totalRow = categoryTotalRows[catKey];
    const sheetName = categorySheetNames[catKey];
    if (!totalRow || !sheetName) return '0';
    const safe = sheetName.includes(' ') ? `'${sheetName}'` : sheetName;
    return `${safe}!${colLetter(monthCol)}${totalRow}`;
  };

  const incomeTaxRate    = Number(settings?.income_tax_rate ?? 25);
  const incomeTaxFreq    = String(settings?.income_tax_frequency ?? 'annually');
  const incomeTaxCustom  = Array.isArray(settings?.income_tax_custom_months) ? settings.income_tax_custom_months : [];
  const salesTaxRate     = Number(settings?.sales_tax_rate ?? 18);
  const salesTaxFreq     = String(settings?.sales_tax_frequency ?? 'monthly');
  const salesTaxStreams  = Array.isArray(settings?.sales_tax_streams) ? settings.sales_tax_streams as number[] : [];

  const revenueItems = allItems.filter(i => i.category === 'revenue');
  const taxableStreamsResolved = salesTaxStreams.length === 0
    ? revenueItems
    : revenueItems.filter(i => salesTaxStreams.includes(i.id));

  // Pre-compute accrued amounts (numeric, not formulas) so the "Paid" row's
  // distribution algorithm can work. Accrued is shown as a formula in the
  // sheet, but the Paid distribution requires actual values to know where
  // to bucket payments. The Paid cells are written as static numbers (with
  // a note explaining the algorithm). If the user edits an Accrued cell,
  // the Paid distribution won't recompute — we mark this clearly.
  const sumByCatPerMonth = (cat: string) => {
    return months.map(m => allItems
      .filter(i => i.category === cat)
      .reduce((s, i) => s + Number((allValues[i.id] || {})[m] ?? 0), 0));
  };
  const revPerMonth      = sumByCatPerMonth('revenue');
  const dcPerMonth       = sumByCatPerMonth('direct_costs');
  const persPerMonth     = sumByCatPerMonth('personnel');
  const expPerMonth      = sumByCatPerMonth('expenses');
  const netProfitNumeric = months.map((_, i) => revPerMonth[i] - dcPerMonth[i] - persPerMonth[i] - expPerMonth[i]);
  const incomeAccruedNumeric = netProfitNumeric.map(v => v > 0 ? Math.round(v * incomeTaxRate / 100) : 0);
  const incomePaidNumeric = computeTaxPaidShares(incomeAccruedNumeric, months, incomeTaxFreq, incomeTaxCustom, false);

  const taxableRevPerMonth = months.map(m => taxableStreamsResolved
    .reduce((s, i) => s + Number((allValues[i.id] || {})[m] ?? 0), 0));
  const salesAccruedNumeric = taxableRevPerMonth.map(v => Math.round(v * salesTaxRate / 100));
  const salesPaidNumeric = computeTaxPaidShares(salesAccruedNumeric, months, salesTaxFreq, [], true);

  // ─── Section: Income Tax ───
  let r = 5;
  writeSheetSectionBar(sheet, r, 'Income Tax', totalCol,
    `${incomeTaxRate}% — ${capitalize(incomeTaxFreq)} payments`);
  r += 1;

  // Net Profit row — formula references the TOTAL row on each P&L sheet
  writeDataRow(sheet, r, 'Net Profit (computed)',
    months.map((_, j) => {
      const c = 2 + j;
      return { formula: `${catTotalRef('revenue', c)}-${catTotalRef('direct_costs', c)}-${catTotalRef('personnel', c)}-${catTotalRef('expenses', c)}` };
    }),
    totalCol, { italic: true, color: COLOR.textMuted, indent: 3 });
  const netProfitRow = r;
  r += 1;

  // Income Tax Accrued — formula MAX(0, NetProfit) × rate
  writeDataRow(sheet, r, 'Income Tax Accrued',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      return { formula: `ROUND(MAX(0,${colL}${netProfitRow})*${incomeTaxRate / 100}, 0)` };
    }),
    totalCol, { color: COLOR.accentStrong, indent: 3 });
  const incomeAccruedRow = r;
  r += 1;

  // Income Tax Paid — computed (numeric values + distribution note)
  writeDataRow(sheet, r, 'Income Tax Paid',
    incomePaidNumeric,
    totalCol, { color: COLOR.textHeading, indent: 3 });
  const incomePaidRow = r;
  r += 1;

  // ─── Section: Sales Tax ───
  const streamsLabel = salesTaxStreams.length === 0
    ? 'all revenue'
    : `${taxableStreamsResolved.length} stream${taxableStreamsResolved.length > 1 ? 's' : ''}`;
  writeSheetSectionBar(sheet, r, 'Sales Tax (GST)', totalCol,
    `${salesTaxRate}% — ${capitalize(salesTaxFreq)} payments — ${streamsLabel}`);
  r += 1;

  // Taxable Revenue — formula referencing each selected revenue stream's
  // row on the Revenue sheet. (We don't have the source rows here; use
  // numeric fallback with a note that this is a snapshot.)
  writeDataRow(sheet, r, 'Taxable Revenue',
    taxableRevPerMonth,
    totalCol, { italic: true, color: COLOR.textMuted, indent: 3 });
  const taxableRevRow = r;
  r += 1;

  // Sales Tax Accrued — formula = TaxableRevenue × rate
  writeDataRow(sheet, r, 'Sales Tax Accrued',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      return { formula: `ROUND(${colL}${taxableRevRow}*${salesTaxRate / 100}, 0)` };
    }),
    totalCol, { color: COLOR.accentStrong, indent: 3 });
  const salesAccruedRow = r;
  r += 1;

  // Sales Tax Paid — computed (numeric)
  writeDataRow(sheet, r, 'Sales Tax Paid',
    salesPaidNumeric,
    totalCol, { color: COLOR.textHeading, indent: 3 });
  const salesPaidRow = r;
  r += 1;

  r += 1; // spacer

  // ─── TOTAL TAXES (Accrued) ───
  writeDataRow(sheet, r, 'TOTAL TAXES (Accrued)',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      return { formula: `${colL}${incomeAccruedRow}+${colL}${salesAccruedRow}` };
    }),
    totalCol, { bold: true, indent: 1 });
  const TOTAL_ACCRUED_ROW = r;
  applyTotalRowStyle(sheet, TOTAL_ACCRUED_ROW, totalCol);
  r += 1;

  // ─── TOTAL TAXES (Paid) ───
  writeDataRow(sheet, r, 'TOTAL TAXES (Paid)',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      return { formula: `${colL}${incomePaidRow}+${colL}${salesPaidRow}` };
    }),
    totalCol, { bold: true, indent: 1 });
  const TOTAL_PAID_ROW = r;
  applySubtotalRowStyle(sheet, TOTAL_PAID_ROW, totalCol);
  r += 2;

  // ─── Calculation Method block ───
  sheet.mergeCells(r, 1, r, totalCol);
  const methodHdr = sheet.getCell(r, 1);
  methodHdr.value = 'CALCULATION METHOD';
  methodHdr.font = { bold: true, size: 11, color: { argb: COLOR.white } };
  methodHdr.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  methodHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
  sheet.getRow(r).height = 22;
  r += 1;

  const methodLines: Array<[string, string]> = [
    ['Income Tax Rate',         `${incomeTaxRate}%`],
    ['Income Tax Frequency',    capitalize(incomeTaxFreq) + (incomeTaxFreq === 'custom' && incomeTaxCustom.length ? ` (months: ${incomeTaxCustom.join(', ')})` : '')],
    ['Sales Tax (GST) Rate',    `${salesTaxRate}%`],
    ['Sales Tax Frequency',     capitalize(salesTaxFreq) + ' (paid one period after accrual)'],
    ['Sales Tax Streams',       salesTaxStreams.length === 0 ? 'All revenue items' : taxableStreamsResolved.map(i => i.name).join(', ') || 'None selected'],
    ['Net Profit formula',      'Revenue − Direct Costs − Personnel − Expenses (per month)'],
    ['Income Tax Accrued',      `MAX(0, Net Profit) × ${incomeTaxRate}%`],
    ['Sales Tax Accrued',       `Taxable Revenue × ${salesTaxRate}%`],
    ['Income Tax Paid',         `Distributed per ${incomeTaxFreq} schedule (recomputed at export time — does NOT live-update if you edit Accrued cells)`],
    ['Sales Tax Paid',          `Distributed per ${salesTaxFreq} schedule with one-period lag`],
  ];
  for (const [k, v] of methodLines) {
    const row = sheet.getRow(r);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true, color: { argb: COLOR.textHeading } };
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    sheet.mergeCells(r, 2, r, totalCol);
    row.getCell(2).value = v;
    row.getCell(2).font = { color: { argb: COLOR.textMuted } };
    row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
    row.height = 18;
    r += 1;
  }

  // Suppress unused: we computed lastMonthCol for symmetry but didn't
  // need it (each formula uses colLetter directly).
  void lastMonthCol;

  // The Summary's "Taxes" row should reference the Accrued total (matches
  // P&L semantics). Return that row.
  return TOTAL_ACCRUED_ROW;
}

/** Distribute monthly accrued amounts into payment months per frequency.
 *  Mirrors `computePaidSchedule` in TaxesTab.tsx:350-406. */
function computeTaxPaidShares(
  accrued: number[],
  months: string[],
  frequency: string,
  customMonths: number[],
  lag: boolean,
): number[] {
  const result = months.map(() => 0);
  if (frequency === 'monthly') {
    if (lag) {
      for (let i = 1; i < months.length; i++) result[i] = accrued[i - 1];
    } else {
      for (let i = 0; i < months.length; i++) result[i] = accrued[i];
    }
  } else if (frequency === 'quarterly') {
    const quarterEndMonths = [6, 9, 12, 3];
    let acc = 0;
    for (let i = 0; i < months.length; i++) {
      acc += accrued[i] || 0;
      const monthNum = parseInt(months[i].split('-')[1]);
      if (quarterEndMonths.includes(monthNum)) {
        const payIdx = lag && i + 1 < months.length ? i + 1 : i;
        result[payIdx] += acc;
        acc = 0;
      }
    }
  } else if (frequency === 'annually') {
    const total = accrued.reduce((s, v) => s + (v || 0), 0);
    result[months.length - 1] = total;
  } else if (frequency === 'custom' && customMonths.length > 0) {
    let acc = 0;
    for (let i = 0; i < months.length; i++) {
      acc += accrued[i] || 0;
      const monthNum = parseInt(months[i].split('-')[1]);
      if (customMonths.includes(monthNum)) {
        result[i] += acc;
        acc = 0;
      }
    }
    if (acc > 0) result[months.length - 1] += acc;
  }
  return result;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ═══════════════════════════════════════════════════════════════════════════
//   Cash Flow Assumptions sheet — settings dump (AR / AP / Inventory)
// ═══════════════════════════════════════════════════════════════════════════

interface CashFlowAssumptionsSheetOpts {
  sheet: ExcelJS.Worksheet;
  title: string;
  contextLine: string;
  allItems: ForecastItem[];
  settings: Record<string, any>;
  itemNameById: Map<number, string>;
}

function renderCashFlowAssumptionsSheet(o: CashFlowAssumptionsSheetOpts): void {
  const { sheet, title, contextLine, allItems, settings, itemNameById } = o;
  // Column layout: A = Particulars (wide), B = Value, C = Days, D = Notes
  sheet.getColumn(1).width = 44;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 60;

  const TOTAL_COL = 4; // for header / section bars

  // Title bar
  sheet.mergeCells(1, 1, 1, TOTAL_COL);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title.toUpperCase();
  titleCell.font = { bold: true, size: 14, color: { argb: COLOR.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  sheet.getRow(1).height = 26;

  // Context line
  sheet.mergeCells(2, 1, 2, TOTAL_COL);
  const ctxCell = sheet.getCell(2, 1);
  ctxCell.value = contextLine || ' ';
  ctxCell.font = { italic: true, size: 9, color: { argb: COLOR.textFaint } };
  ctxCell.alignment = { horizontal: 'left', indent: 1 };

  // Header row
  const HDR = 4;
  const hdr = sheet.getRow(HDR);
  hdr.values = ['Setting', 'Value', 'Days', 'Notes'];
  hdr.height = 22;
  hdr.eachCell((cell, c) => {
    if (c > TOTAL_COL) return;
    cell.font = { bold: true, color: { argb: COLOR.white }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
    cell.alignment = { horizontal: c === 1 ? 'left' : 'center', vertical: 'middle' };
  });

  let r = 5;

  // Helper: write a "label / value / days / notes" row
  const writeRow = (label: string, value: string | number, days: string | number = '', notes = '', opts: { indent?: number; bold?: boolean } = {}) => {
    const row = sheet.getRow(r);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: !!opts.bold, color: { argb: COLOR.textHeading } };
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: opts.indent ?? 1 };
    row.getCell(2).value = value;
    row.getCell(2).font = { color: { argb: COLOR.textHeading } };
    row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(3).value = days;
    row.getCell(3).font = { color: { argb: COLOR.textHeading } };
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(4).value = notes;
    row.getCell(4).font = { italic: true, color: { argb: COLOR.textMuted } };
    row.getCell(4).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
    row.height = 18;
    r += 1;
  };

  // Note about how this sheet is used
  void itemNameById;

  // ── ACCOUNTS RECEIVABLE ──
  writeSheetSectionBar(sheet, r, 'Accounts Receivable', TOTAL_COL); r += 1;
  const arIndividual = !!settings.ar_individual;
  writeRow('Mode', arIndividual ? 'Per Stream' : 'Global', '', 'How AR collection terms are configured', { indent: 1 });
  if (!arIndividual) {
    writeRow('Global Credit Sales %', `${settings.ar_global_credit_pct ?? 0}%`, '', '% of sales made on credit (vs cash)', { indent: 2 });
    writeRow('Global Days to Collect', '', `${settings.ar_global_days ?? 30}`, 'Average time customers take to pay', { indent: 2 });
  } else {
    writeRow('Per-stream overrides', '', '', '', { bold: true, indent: 1 });
    const arPerStream: Record<number, { credit_pct: number; days_to_collect: number }> = settings.ar_per_stream || {};
    const revItems = allItems.filter(i => i.category === 'revenue');
    if (revItems.length === 0 || Object.keys(arPerStream).length === 0) {
      writeRow('(No per-stream overrides configured)', '', '', '', { indent: 2 });
    } else {
      for (const ri of revItems) {
        const cfg = arPerStream[ri.id];
        if (!cfg) continue;
        writeRow(ri.name, `${cfg.credit_pct ?? 0}%`, `${cfg.days_to_collect ?? 30}`, '', { indent: 2 });
      }
    }
  }
  r += 1;  // spacer

  // ── ACCOUNTS PAYABLE ──
  writeSheetSectionBar(sheet, r, 'Accounts Payable', TOTAL_COL); r += 1;
  const apIndividual = !!settings.ap_individual;
  writeRow('Mode', apIndividual ? 'Per Item' : 'Global', '', 'How AP payment terms are configured', { indent: 1 });
  if (!apIndividual) {
    writeRow('Global Credit Purchases %', `${settings.ap_global_credit_pct ?? 0}%`, '', '% of purchases made on credit (vs cash)', { indent: 2 });
    writeRow('Global Days to Pay', '', `${settings.ap_global_days ?? 30}`, 'Average time you take to pay vendors', { indent: 2 });
  } else {
    writeRow('Per-item overrides', '', '', '', { bold: true, indent: 1 });
    const apPerItem: Record<number, { credit_pct: number; days_to_pay: number }> = settings.ap_per_item || {};
    const cogsAndOpex = allItems.filter(i => i.category === 'direct_costs' || i.category === 'expenses');
    const overridesEntered = cogsAndOpex.filter(it => apPerItem[it.id]);
    if (overridesEntered.length === 0) {
      writeRow('(No per-item overrides configured)', '', '', '', { indent: 2 });
    } else {
      for (const it of overridesEntered) {
        const cfg = apPerItem[it.id];
        writeRow(it.name, `${cfg.credit_pct ?? 0}%`, `${cfg.days_to_pay ?? 30}`, '', { indent: 2 });
      }
    }
  }
  r += 1;  // spacer

  // ── INVENTORY ──
  writeSheetSectionBar(sheet, r, 'Inventory', TOTAL_COL); r += 1;
  writeRow('Enabled', settings.inventory_enabled ? 'Yes' : 'No', '', 'Whether inventory roll is modelled', { indent: 1 });
  if (settings.inventory_enabled) {
    writeRow('Months on Hand', `${settings.inventory_months ?? 1}`, '', 'Months of forward direct-cost coverage to keep in stock', { indent: 2 });
    const minOrder = Number(settings.inventory_min_order ?? 0);
    writeRow('Minimum Order Value', minOrder ? `Rs ${formatRupees(minOrder)}` : '—', '', 'Smallest reorder amount', { indent: 2 });
  }
  r += 1;

  // Footnote
  sheet.mergeCells(r, 1, r, TOTAL_COL);
  const note = sheet.getCell(r, 1);
  note.value = 'Note: These assumptions feed the Cash Flow & Balance Sheet on the Summary sheet. The current export uses a simplified Cash Flow that ignores AR/AP/Inventory working-capital impact — a follow-up version will model these.';
  note.font = { italic: true, size: 9, color: { argb: COLOR.textFaint } };
  note.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
  sheet.getRow(r).height = 36;
}

// ═══════════════════════════════════════════════════════════════════════════
//   Initial Balances sheet — settings dump (Assets / Liabilities / Equity)
// ═══════════════════════════════════════════════════════════════════════════

interface InitialBalancesSheetOpts {
  sheet: ExcelJS.Worksheet;
  title: string;
  contextLine: string;
  settings: Record<string, any>;
}

function renderInitialBalancesSheet(o: InitialBalancesSheetOpts): void {
  const { sheet, title, contextLine, settings } = o;
  // Layout: A = Particulars, B = Opening Balance, C = Notes
  sheet.getColumn(1).width = 44;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 60;
  const TOTAL_COL = 3;

  // Title
  sheet.mergeCells(1, 1, 1, TOTAL_COL);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title.toUpperCase();
  titleCell.font = { bold: true, size: 14, color: { argb: COLOR.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accent } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  sheet.getRow(1).height = 26;

  // Context
  sheet.mergeCells(2, 1, 2, TOTAL_COL);
  const ctxCell = sheet.getCell(2, 1);
  ctxCell.value = contextLine || ' ';
  ctxCell.font = { italic: true, size: 9, color: { argb: COLOR.textFaint } };
  ctxCell.alignment = { horizontal: 'left', indent: 1 };

  // Header
  const hdr = sheet.getRow(4);
  hdr.values = ['Particulars', 'Opening Balance (Rs)', 'Notes'];
  hdr.height = 22;
  hdr.eachCell((cell, c) => {
    if (c > TOTAL_COL) return;
    cell.font = { bold: true, color: { argb: COLOR.white }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
    cell.alignment = { horizontal: c === 1 ? 'left' : (c === 2 ? 'right' : 'left'), vertical: 'middle' };
  });

  const ib = settings.initial_balances || {};
  const num = (k: string) => Number(ib[k] ?? 0);
  const str = (k: string, fallback = '') => String(ib[k] ?? fallback);

  let r = 5;
  const writeRow = (label: string, value: number | string, notes = '', opts: { indent?: number; bold?: boolean; isFormula?: boolean } = {}) => {
    const row = sheet.getRow(r);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: !!opts.bold, color: { argb: COLOR.textHeading } };
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: opts.indent ?? 1 };
    if (opts.isFormula && typeof value === 'string') {
      row.getCell(2).value = { formula: value };
    } else {
      row.getCell(2).value = value;
    }
    row.getCell(2).numFmt = typeof value === 'number' || opts.isFormula ? NUM_FMT : '@';
    row.getCell(2).font = { bold: !!opts.bold, color: { argb: COLOR.textHeading } };
    row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(3).value = notes;
    row.getCell(3).font = { italic: true, color: { argb: COLOR.textMuted } };
    row.getCell(3).alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: true };
    row.height = 18;
    r += 1;
  };

  // ── ASSETS ──
  writeSheetSectionBar(sheet, r, 'ASSETS', TOTAL_COL); r += 1;
  const cashRow = r; writeRow('Cash & Bank', num('cash'), 'Opening cash on hand', { indent: 2 });
  const arRow = r; writeRow('Accounts Receivable', num('accounts_receivable'), `Customers owe (days to collect: ${num('days_to_get_paid') || 30})`, { indent: 2 });
  const invRow = r; writeRow('Inventory', num('inventory'), 'Value of unsold stock', { indent: 2 });
  const ltaRow = r; writeRow('Long-term Assets (gross)', num('long_term_assets'), 'Original cost of fixed assets', { indent: 2 });
  const adRow = r; writeRow('Less: Accumulated Depreciation', num('accumulated_depreciation'), `Dep. period: ${str('depreciation_period', 'forever')} year(s)`, { indent: 2 });
  const ocaRow = r; writeRow('Other Current Assets', num('other_current_assets'), `Amortization: ${str('amortization_period', 'keep')} months`, { indent: 2 });

  const totalAssetsRow = r;
  writeRow('Total Assets',
    `${colLetter(2)}${cashRow}+${colLetter(2)}${arRow}+${colLetter(2)}${invRow}+${colLetter(2)}${ltaRow}-${colLetter(2)}${adRow}+${colLetter(2)}${ocaRow}`,
    '', { bold: true, indent: 1, isFormula: true });
  applySubtotalRowStyle(sheet, totalAssetsRow, TOTAL_COL);
  r += 1;

  // ── LIABILITIES ──
  writeSheetSectionBar(sheet, r, 'LIABILITIES', TOTAL_COL); r += 1;
  const apRow = r; writeRow('Accounts Payable', num('accounts_payable'), `You owe vendors (days to pay: ${num('days_to_pay') || 30})`, { indent: 2 });
  const itpRow = r; writeRow('Income Taxes Payable', num('income_taxes_payable'), 'Income tax owed but not yet paid', { indent: 2 });
  const stpRow = r; writeRow('Sales Taxes Payable', num('sales_taxes_payable'), 'GST/sales tax owed but not yet paid', { indent: 2 });

  const totalLiabRow = r;
  writeRow('Total Liabilities',
    `${colLetter(2)}${apRow}+${colLetter(2)}${itpRow}+${colLetter(2)}${stpRow}`,
    '', { bold: true, indent: 1, isFormula: true });
  applySubtotalRowStyle(sheet, totalLiabRow, TOTAL_COL);
  r += 1;

  // ── EQUITY ──
  writeSheetSectionBar(sheet, r, 'EQUITY', TOTAL_COL); r += 1;
  const picRow = r; writeRow('Paid-in Capital', num('paid_in_capital'), 'Initial owner / investor capital', { indent: 2 });
  const reRow = r; writeRow('Retained Earnings (auto-balance)',
    `${colLetter(2)}${totalAssetsRow}-${colLetter(2)}${totalLiabRow}-${colLetter(2)}${picRow}`,
    'Auto-computed so Assets = Liabilities + Equity',
    { indent: 2, isFormula: true });

  const totalEquityRow = r;
  writeRow('Total Equity',
    `${colLetter(2)}${picRow}+${colLetter(2)}${reRow}`,
    '', { bold: true, indent: 1, isFormula: true });
  applySubtotalRowStyle(sheet, totalEquityRow, TOTAL_COL);
  r += 1;

  // ── BALANCE CHECK ──
  writeRow('Total Liabilities + Equity',
    `${colLetter(2)}${totalLiabRow}+${colLetter(2)}${totalEquityRow}`,
    'Should equal Total Assets',
    { bold: true, indent: 1, isFormula: true });
  applyTotalRowStyle(sheet, r - 1, TOTAL_COL);
  r += 1;

  // Footnote
  sheet.mergeCells(r, 1, r, TOTAL_COL);
  const note = sheet.getCell(r, 1);
  note.value = 'Note: These open the FY\'s Balance Sheet on the Summary sheet. The Retained Earnings row auto-balances so Assets = Liabilities + Equity.';
  note.font = { italic: true, size: 9, color: { argb: COLOR.textFaint } };
  note.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
  sheet.getRow(r).height = 28;
}

// ═══════════════════════════════════════════════════════════════════════════
//   Financing sheet — top totals + per-item loan/credit-line mechanics
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors FinancingTab.tsx loan / credit-line / investment / other types.
// For each item we render:
//
//   1. A row in the top summary table (Item × Months — net cash flow per
//      month: receipts − payments).
//   2. A per-item mechanics block below: Receive Month, Principal, Rate, Term;
//      Draws / Repayments / Interest Accrued / Outstanding Balance per month.
//
// Values come from the item's `meta` (preferred — contains the explicit
// receive_amount / num_payments / interest_rate / withdrawals / payments
// shape) with `allValues[item.id]` as a fallback.

interface FinancingSheetOpts {
  sheet: ExcelJS.Worksheet;
  title: string;
  contextLine: string;
  months: string[];
  monthLabels: string[];
  items: ForecastItem[];
  allItems: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  itemNameById: Map<number, string>;
}

function renderFinancingSheet(o: FinancingSheetOpts): number {
  const { sheet, title, contextLine, months, monthLabels, items,
          allValues, itemNameById, allItems } = o;
  void itemNameById; void allItems;
  const { lastMonthCol, totalCol } = sheetColumnCount(months);
  applyStandardColumnWidths(sheet, months);
  writeSheetHeader(sheet, title, contextLine, monthLabels, totalCol);

  if (items.length === 0) {
    return writeEmptySheetTotalRow(sheet, title, monthLabels, totalCol);
  }

  // ─── Top summary table — one row per item ───
  let r = 5;
  const itemRowMap = new Map<number, number>();
  items.forEach((item, idx) => {
    const perMonth = months.map(m => Number((allValues[item.id] || {})[m] ?? 0));
    writeDataRow(sheet, r, item.name, perMonth, totalCol, {
      indent: 1, bandedFill: idx % 2 === 1,
    });
    itemRowMap.set(item.id, r);
    r += 1;
  });

  // TOTAL FINANCING (top table)
  const firstItemRow = 5;
  const lastItemRow = r - 1;
  writeDataRow(sheet, r, 'TOTAL FINANCING (net cash flow)',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      return { formula: `SUM(${colL}${firstItemRow}:${colL}${lastItemRow})` };
    }),
    totalCol, { bold: true, indent: 1 });
  const TOTAL_ROW = r;
  applyTotalRowStyle(sheet, TOTAL_ROW, totalCol);
  r += 2;

  // ─── Per-item mechanics blocks ───
  sheet.mergeCells(r, 1, r, totalCol);
  const blockHdr = sheet.getCell(r, 1);
  blockHdr.value = 'PER-ITEM MECHANICS  ·  loan schedules, balances, and interest';
  blockHdr.font = { bold: true, size: 11, color: { argb: COLOR.white } };
  blockHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
  blockHdr.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  sheet.getRow(r).height = 22;
  r += 2;

  for (const item of items) {
    r = renderFinancingItemBlock(sheet, item, months, totalCol, lastMonthCol, allValues, r);
    r += 2;
  }

  return TOTAL_ROW;
}

function renderFinancingItemBlock(
  sheet: ExcelJS.Worksheet,
  item: ForecastItem,
  months: string[],
  totalCol: number,
  lastMonthCol: number,
  allValues: Record<number, Record<string, number>>,
  startRow: number,
): number {
  let r = startRow;
  const meta: any = item.meta || {};
  const itemType = item.item_type || 'loan';
  const typeLabel: Record<string, string> = {
    loan: 'Term Loan',
    line_of_credit: 'Line of Credit',
    investment: 'Investment',
    other: 'Other Financing',
  };
  const typeStr = typeLabel[itemType] || 'Loan';

  // Item title sub-bar
  sheet.mergeCells(r, 1, r, totalCol);
  const titleCell = sheet.getCell(r, 1);
  titleCell.value = `${item.name}  —  ${typeStr}`;
  titleCell.font = { bold: true, size: 11, color: { argb: COLOR.textHeading } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentSoft } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  sheet.getRow(r).height = 20;
  r += 1;

  // Term sheet line — single key/value summary
  const interestRate = Number(meta.interest_rate ?? 0);
  const principal = Number(meta.receive_amount ?? meta.credit_limit ?? 0);
  const termMonths = Number(meta.num_payments ?? 0);
  const receiveMonth = String(meta.receive_month || '');
  const rateMode = String(meta.rate_mode || 'constant');

  const termsLines: Array<[string, string]> = [];
  if (principal) termsLines.push(['Principal / Limit', `Rs ${formatRupees(principal)}`]);
  if (receiveMonth && receiveMonth !== 'before_start') termsLines.push(['Receive Month', formatYYYYMM(receiveMonth)]);
  else if (receiveMonth === 'before_start') termsLines.push(['Receive Month', 'Before plan start']);
  if (termMonths) termsLines.push(['Term', `${termMonths} monthly payments`]);
  termsLines.push(['Interest Rate', `${interestRate}% (${rateMode})`]);

  for (const [k, v] of termsLines) {
    const row = sheet.getRow(r);
    row.getCell(1).value = `   ${k}`;
    row.getCell(1).font = { color: { argb: COLOR.textMuted }, italic: true };
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 2 };
    sheet.mergeCells(r, 2, r, totalCol);
    row.getCell(2).value = v;
    row.getCell(2).font = { color: { argb: COLOR.textHeading } };
    row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    row.height = 16;
    r += 1;
  }
  r += 1;

  // Build per-month series for: Draws, Repayments, Interest Accrued, Balance.
  // Sources differ by item type:
  //   • loan: receive_amount in receive_month → draws; equal monthly principal
  //     repayments starting next month for `num_payments`.
  //   • line_of_credit / other: meta.withdrawals → draws, meta.payments → repayments.
  //   • investment: receive_amount in receive_month → draws, no repayments.
  //
  // For complex / unknown shapes we fall back to allValues[item.id] for the
  // net cash flow row only.
  const draws = months.map(() => 0);
  const repayments = months.map(() => 0);

  if (itemType === 'loan' || itemType === 'investment') {
    if (principal && receiveMonth && receiveMonth !== 'before_start') {
      const recIdx = months.indexOf(receiveMonth);
      if (recIdx >= 0) draws[recIdx] = principal;
    } else if (principal && receiveMonth === 'before_start') {
      // Treat as opening balance at month 0; no draw shown
    }
    if (itemType === 'loan' && principal && termMonths > 0) {
      // Equal-principal amortization (simple model — matches the UI's
      // FinancingTab default behaviour for term loans). Round to whole
      // rupees so the column matches the Rs formatting on every other
      // sheet — fractional repayments looked broken in the export.
      const monthlyPrincipal = Math.round(principal / termMonths);
      const recIdx = receiveMonth === 'before_start'
        ? -1
        : months.indexOf(receiveMonth);
      const startIdx = recIdx >= 0 ? recIdx + 1 : 0;
      for (let i = 0; i < termMonths && (startIdx + i) < months.length; i++) {
        repayments[startIdx + i] += monthlyPrincipal;
      }
    }
  } else if (itemType === 'line_of_credit' || itemType === 'other') {
    const withdrawals = (meta.withdrawals || {}) as Record<string, number>;
    const payments = (meta.payments || {}) as Record<string, number>;
    months.forEach((m, i) => {
      draws[i] = Number(withdrawals[m] ?? 0);
      repayments[i] = Number(payments[m] ?? 0);
    });
    // Carry an existing balance from before plan start by treating it as
    // a starting outstanding (handled implicitly in balance row below).
  }

  // Header row for the per-month grid
  const monthHdr = sheet.getRow(r);
  monthHdr.values = ['Mechanic', ...months.map(m => formatYYYYMM(m)), 'Total'];
  monthHdr.height = 18;
  monthHdr.eachCell((cell, c) => {
    if (c > totalCol) return;
    cell.font = { bold: true, color: { argb: COLOR.textHeading }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.bgMuted } };
    cell.alignment = { horizontal: c === 1 ? 'left' : 'right', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: COLOR.border } } };
  });
  r += 1;

  // Draws row
  writeDataRow(sheet, r, 'Draws', draws, totalCol, { indent: 2, color: COLOR.accentStrong });
  const drawsRow = r;
  r += 1;

  // Repayments row
  writeDataRow(sheet, r, 'Repayments', repayments.map(v => -Math.abs(v)), totalCol, { indent: 2 });
  const repaymentsRow = r;
  r += 1;

  // Interest Accrued row — = Outstanding Balance × annual rate / 12
  // (Outstanding row is below, so reference its row index after we know it.)
  const interestRow = r; r += 1;

  // Outstanding Balance row — rolling: prev_balance + draws + repayments
  // (repayments are stored as negative numbers, so adding them reduces balance).
  const existingBal = Number(meta.existing_balance ?? 0);
  const openingBal = receiveMonth === 'before_start' ? principal : existingBal;
  const balanceRow = r;
  writeDataRow(sheet, balanceRow, 'Outstanding Balance',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      if (j === 0) {
        return { formula: `${openingBal}+${colL}${drawsRow}+${colL}${repaymentsRow}` };
      }
      const prev = colLetter(2 + j - 1);
      return { formula: `${prev}${balanceRow}+${colL}${drawsRow}+${colL}${repaymentsRow}` };
    }),
    totalCol, { indent: 2, bold: true,
                rowTotal: { formula: `${colLetter(lastMonthCol)}${balanceRow}` } });
  r += 1;

  // Now write the Interest Accrued row (knew balanceRow now)
  writeDataRow(sheet, interestRow, 'Interest Accrued',
    months.map((_, j) => {
      const colL = colLetter(2 + j);
      return { formula: `ROUND(${colL}${balanceRow}*${interestRate / 100}/12, 0)` };
    }),
    totalCol, { indent: 2, italic: true, color: COLOR.textMuted });

  return r;
}
// ═══════════════════════════════════════════════════════════════════════════

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
  //
  // Two coexisting storage shapes — ItemEditForm.tsx writes BOTH key sets
  // for every item (lines 800-809) but only one carries real values; the
  // other holds the field's default (0/null). Which set is "real" depends
  // on the item type:
  //
  //   • Direct Costs → specific_cost items with meta.stepEntryModes.cost
  //     === 'percent' use camelCase: meta.linkedRevenueId + meta.percentOfStream
  //   • Personnel/Expenses → entry_mode === 'pct_specific' uses snake_case:
  //     meta.linked_revenue_id + meta.percent_of_revenue
  //
  // The previous `meta.linked_revenue_id ?? meta.linkedRevenueId` chain
  // only fell back on null/undefined, so a snake_case zero (default value
  // for a specific_cost item) shadowed the real camelCase percentage →
  // Excel formula became revenue × 0 = 0 ("share of consultation" bug).
  //
  // Fix: prefer the PAIR (linkId, pct) where both are populated AND pct > 0.
  // If neither pair is fully populated, fall through to the next branch.
  const camelLinkId = meta.linkedRevenueId;
  const camelPct    = meta.percentOfStream;
  const snakeLinkId = meta.linked_revenue_id;
  const snakePct    = meta.percent_of_revenue;

  let linkedRevenueId: number | null = null;
  let percentValue:    number | null = null;
  if (camelLinkId && Number(camelPct) > 0) {
    linkedRevenueId = camelLinkId;
    percentValue = Number(camelPct);
  } else if (snakeLinkId && Number(snakePct) > 0) {
    linkedRevenueId = snakeLinkId;
    percentValue = Number(snakePct);
  } else if (camelLinkId && camelPct != null) {
    // Both keys populated but pct is 0 — still treat as pct_specific so
    // the export shows the link + 0% instead of falling through to the
    // single-row fallback (which would mask the configuration).
    linkedRevenueId = camelLinkId;
    percentValue = Number(camelPct);
  } else if (snakeLinkId && snakePct != null) {
    linkedRevenueId = snakeLinkId;
    percentValue = Number(snakePct);
  }

  const isPctSpecific = item.entry_mode === 'pct_specific'
    || (item.entry_mode === 'percent' && linkedRevenueId)
    || (item.item_type === 'specific_cost'
        && (meta.stepEntryModes?.cost === 'percent'
            || meta.stepEntryModes?.cost === 'pct_specific')
        && linkedRevenueId);
  if (isPctSpecific && linkedRevenueId && percentValue != null) {
    const linkedName = itemNameById.get(linkedRevenueId) || `item #${linkedRevenueId}`;
    const linkedValues = allValues[linkedRevenueId] || {};
    const linkedPerMonth = months.map(m => Number(linkedValues[m] ?? 0));
    const pctFraction = percentValue / 100;
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

