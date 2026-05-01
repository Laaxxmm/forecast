// Excel export for Scenario Analysis Compare. One workbook, one sheet:
// the triple statement (P&L → Balance Sheet → Cash Flow) listed top-down,
// with one column per scenario plus ∆ and ∆% columns vs. the base scenario.
//
// Why a separate file from forecastWorkbook.ts? That file is tightly coupled
// to the per-scenario operational layout (multiple sheets, Calculation Method
// table, links). Comparison reports want a single dense sheet — different
// shape, easier to keep separate than to retrofit the existing builder.

import ExcelJS from 'exceljs';
import type { ForecastItem, FY, Scenario } from '../pages/ForecastModulePage';
import {
  buildPnLRows, buildBalanceSheetRows, buildCashFlowRows,
} from './financialStatements';

const COLOR = {
  accent: 'FF10B981',
  accentSoft: 'FFD1FAE5',
  accentStrong: 'FF059669',
  textHeading: 'FF0F172A',
  textMuted: 'FF64748B',
  bgMuted: 'FFF1F5F9',
  white: 'FFFFFFFF',
  border: 'FFE2E8F0',
};
const NUM_FMT = '#,##0;(#,##0);"-"';

export interface ComparisonScenarioInput {
  scenario: Scenario;
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  benefitsPct: number;
}

export interface BuildComparisonOpts {
  scenarios: ComparisonScenarioInput[];
  baseId: number;
  months: string[];
  fy: FY | null;
  branchName?: string;
  streamName?: string;
  includeDelta?: boolean;
  includeDeltaPct?: boolean;
}

export async function buildComparisonWorkbook(opts: BuildComparisonOpts): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vision by Indefine';
  wb.created = new Date();

  const sheet = wb.addWorksheet('Comparison Summary', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }],
  });

  // Title row
  sheet.getCell('A1').value = 'Scenario Comparison';
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: COLOR.textHeading } };
  sheet.mergeCells('A1:D1');

  const contextParts = [
    opts.fy?.label,
    opts.branchName,
    opts.streamName,
  ].filter(Boolean);
  sheet.getCell('A2').value = contextParts.join(' · ') || ' ';
  sheet.getCell('A2').font = { italic: true, size: 11, color: { argb: COLOR.textMuted } };
  sheet.mergeCells('A2:D2');

  // Reorder so the base is first (so columns read base → variants).
  const ordered = [...opts.scenarios].sort((a, b) =>
    a.scenario.id === opts.baseId ? -1 : b.scenario.id === opts.baseId ? 1 : 0,
  );
  const base = ordered[0];
  const others = ordered.slice(1);
  const includeDelta = opts.includeDelta !== false;
  const includeDeltaPct = opts.includeDeltaPct !== false;
  const otherColCount = 1 + (includeDelta ? 1 : 0) + (includeDeltaPct ? 1 : 0);

  // Header rows.
  // Row 3: scenario names spanning their group.
  // Row 4: column sub-headers.
  const hdr3 = sheet.getRow(3);
  const hdr4 = sheet.getRow(4);
  hdr3.getCell(1).value = '';
  hdr4.getCell(1).value = 'Line item';
  hdr3.getCell(2).value = base.scenario.name;
  hdr4.getCell(2).value = 'Value';
  let col = 3;
  for (const o of others) {
    sheet.mergeCells(3, col, 3, col + otherColCount - 1);
    hdr3.getCell(col).value = o.scenario.name;
    hdr4.getCell(col).value = 'Value';
    if (includeDelta) hdr4.getCell(col + 1).value = '∆';
    if (includeDeltaPct) hdr4.getCell(col + (includeDelta ? 2 : 1)).value = '∆ %';
    col += otherColCount;
  }
  const lastCol = col - 1;

  for (const r of [hdr3, hdr4]) {
    r.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { bold: true, color: { argb: COLOR.textHeading } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.bgMuted } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: COLOR.border } },
        bottom: { style: 'thin', color: { argb: COLOR.border } },
        left: { style: 'thin', color: { argb: COLOR.border } },
        right: { style: 'thin', color: { argb: COLOR.border } },
      };
    });
  }
  hdr4.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  // Build statement blocks for every scenario.
  const blockFor = (input: ComparisonScenarioInput) => ({
    pnl: buildPnLRows(input.items, input.allValues, opts.months, input.benefitsPct),
    bs: buildBalanceSheetRows(input.items, input.allValues, opts.months),
    cf: buildCashFlowRows(input.items, input.allValues, opts.months),
  });
  const baseBlocks = blockFor(base);
  const othersBlocks = others.map(blockFor);

  let r = 5;

  // Use the BASE scenario's row labels and meta as the canonical sequence.
  // Append three sections (P&L, BS, CF) one after another.
  const yearlyAt = (rows: (string | number)[][], i: number): number => {
    const row = rows[i];
    if (!row) return 0;
    const last = row[row.length - 1];
    return typeof last === 'number' ? last : 0;
  };

  const writeSection = (
    sectionTitle: string,
    baseStmt: ReturnType<typeof buildPnLRows>,
    othersStmt: Array<ReturnType<typeof buildPnLRows>>,
  ) => {
    // Section banner row
    sheet.mergeCells(r, 1, r, lastCol);
    const bannerCell = sheet.getCell(r, 1);
    bannerCell.value = sectionTitle;
    bannerCell.font = { bold: true, size: 12, color: { argb: COLOR.white } };
    bannerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentStrong } };
    bannerCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    sheet.getRow(r).height = 22;
    r += 1;

    // Each row of the statement
    baseStmt.rows.forEach((row, i) => {
      const meta = baseStmt.meta[i] || {};
      const label = String(row[0] ?? '');
      const isPercent = !!meta.isPercent;
      const isSection = !!meta.isSection;
      const isTotal = !!meta.isTotal;

      const sheetRow = sheet.getRow(r);
      const lblCell = sheetRow.getCell(1);
      lblCell.value = label;
      lblCell.alignment = { horizontal: 'left', vertical: 'middle', indent: label.startsWith('  ') ? 1 : 0 };
      lblCell.font = {
        bold: isSection || isTotal,
        color: { argb: COLOR.textHeading },
      };

      if (isSection) {
        for (let c = 2; c <= lastCol; c++) sheetRow.getCell(c).value = '';
      } else {
        const baseVal = yearlyAt(baseStmt.rows, i);
        const baseCell = sheetRow.getCell(2);
        baseCell.value = baseVal;
        baseCell.numFmt = isPercent ? '0.0"%"' : NUM_FMT;
        baseCell.alignment = { horizontal: 'right' };
        if (isTotal) baseCell.font = { bold: true, color: { argb: COLOR.textHeading } };

        let c = 3;
        othersStmt.forEach((oStmt) => {
          const oVal = yearlyAt(oStmt.rows, i);
          const valCell = sheetRow.getCell(c);
          valCell.value = oVal;
          valCell.numFmt = isPercent ? '0.0"%"' : NUM_FMT;
          valCell.alignment = { horizontal: 'right' };
          if (isTotal) valCell.font = { bold: true, color: { argb: COLOR.textHeading } };

          if (includeDelta) {
            const dCell = sheetRow.getCell(c + 1);
            // Live formula so the recipient can edit cells and see ∆ recompute.
            dCell.value = { formula: `${cellRef(c, r)}-${cellRef(2, r)}` } as any;
            dCell.numFmt = isPercent ? '0.0"%"' : NUM_FMT;
            dCell.alignment = { horizontal: 'right' };
          }
          if (includeDeltaPct) {
            const pCell = sheetRow.getCell(c + (includeDelta ? 2 : 1));
            pCell.value = {
              formula: `IF(${cellRef(2, r)}=0,"",(${cellRef(c, r)}-${cellRef(2, r)})/ABS(${cellRef(2, r)}))`,
            } as any;
            pCell.numFmt = '0.0%';
            pCell.alignment = { horizontal: 'right' };
          }
          c += otherColCount;
        });
      }

      if (isTotal) {
        sheetRow.eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR.accentSoft } };
        });
      }
      r += 1;
    });

    // Spacer row
    r += 1;
  };

  writeSection('Profit & Loss', baseBlocks.pnl, othersBlocks.map(b => b.pnl));
  writeSection('Balance Sheet', baseBlocks.bs, othersBlocks.map(b => b.bs));
  writeSection('Cash Flow', baseBlocks.cf, othersBlocks.map(b => b.cf));

  // Column widths
  sheet.getColumn(1).width = 38;
  for (let c = 2; c <= lastCol; c++) sheet.getColumn(c).width = 16;

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ── helpers ────────────────────────────────────────────────────────────────

function cellRef(col: number, row: number): string {
  return columnLetter(col) + String(row);
}

function columnLetter(col: number): string {
  let n = col;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
