// Lightweight PDF builder for Scenario Analysis Compare. Single document with
// three tables (P&L, Balance Sheet, Cash Flow) where rows are statement lines
// and columns are scenarios + ∆ + ∆% vs. base.

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ForecastItem, FY, Scenario } from '../pages/ForecastModulePage';
import {
  buildPnLRows, buildBalanceSheetRows, buildCashFlowRows,
  formatNum, StatementBlock,
} from './financialStatements';

export interface ComparisonScenarioInput {
  scenario: Scenario;
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  benefitsPct: number;
}

export interface BuildComparisonPdfOpts {
  scenarios: ComparisonScenarioInput[];
  baseId: number;
  months: string[];
  fy: FY | null;
  branchName?: string;
  streamName?: string;
  includeDelta?: boolean;
  includeDeltaPct?: boolean;
}

const ACCENT: [number, number, number] = [16, 185, 129];
const ACCENT_SOFT: [number, number, number] = [209, 250, 229];
const TEXT_HEADING: [number, number, number] = [15, 23, 42];
const TEXT_MUTED: [number, number, number] = [100, 116, 139];
const SECTION_BG: [number, number, number] = [241, 245, 249];

export function buildComparisonPdf(opts: BuildComparisonPdfOpts): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  // Reorder so base comes first.
  const ordered = [...opts.scenarios].sort((a, b) =>
    a.scenario.id === opts.baseId ? -1 : b.scenario.id === opts.baseId ? 1 : 0,
  );
  const base = ordered[0];
  const others = ordered.slice(1);
  const includeDelta = opts.includeDelta !== false;
  const includeDeltaPct = opts.includeDeltaPct !== false;

  // Header
  doc.setFontSize(18);
  doc.setTextColor(...TEXT_HEADING);
  doc.text('Scenario Comparison', 32, 36);
  const ctx = [opts.fy?.label, opts.branchName, opts.streamName].filter(Boolean).join(' · ');
  if (ctx) {
    doc.setFontSize(10);
    doc.setTextColor(...TEXT_MUTED);
    doc.text(ctx, 32, 52);
  }

  let y = 70;

  const blockFor = (input: ComparisonScenarioInput) => ({
    pnl: buildPnLRows(input.items, input.allValues, opts.months, input.benefitsPct),
    bs: buildBalanceSheetRows(input.items, input.allValues, opts.months),
    cf: buildCashFlowRows(input.items, input.allValues, opts.months),
  });
  const baseBlocks = blockFor(base);
  const othersBlocks = others.map(blockFor);

  const drawSection = (title: string, baseStmt: StatementBlock, othersStmt: StatementBlock[]) => {
    // Push to a fresh page if there's not enough headroom for at least the
    // section title plus a few rows. Doing this BEFORE drawing the title
    // (rather than after the table) prevents an orphaned title at the bottom
    // of a page when the upcoming table needs to wrap anyway.
    const pageH = doc.internal.pageSize.getHeight();
    if (y > pageH - 120) {
      doc.addPage();
      y = 36;
    }
    // Section title
    doc.setFontSize(13);
    doc.setTextColor(...TEXT_HEADING);
    doc.text(title, 32, y + 14);
    y += 22;

    // Build header rows. Two-row header so each scenario can group "Value / ∆ / ∆%".
    const head1: any[] = [{ content: 'Line item', rowSpan: 2 }, { content: base.scenario.name }];
    const head2: any[] = ['Value'];
    for (const o of others) {
      const span = 1 + (includeDelta ? 1 : 0) + (includeDeltaPct ? 1 : 0);
      head1.push({ content: o.scenario.name, colSpan: span });
      head2.push('Value');
      if (includeDelta) head2.push('∆');
      if (includeDeltaPct) head2.push('∆%');
    }

    const body: any[] = [];
    const yearlyAt = (rows: (string | number)[][], i: number): number => {
      const row = rows[i];
      if (!row) return 0;
      const last = row[row.length - 1];
      return typeof last === 'number' ? last : 0;
    };

    baseStmt.rows.forEach((row, i) => {
      const meta = baseStmt.meta[i] || {};
      const label = String(row[0] ?? '');
      const isPct = !!meta.isPercent;
      const isSection = !!meta.isSection;
      const isTotal = !!meta.isTotal;

      const cells: any[] = [label];
      if (isSection) {
        // section banner — empty values across the row
        const remaining = head2.length - 1;
        for (let k = 0; k < remaining; k++) cells.push('');
        body.push({
          row: cells,
          isSection: true, isTotal, isPct,
        });
        return;
      }

      const baseVal = yearlyAt(baseStmt.rows, i);
      cells.push(formatNum(baseVal, isPct));
      othersStmt.forEach((o) => {
        const v = yearlyAt(o.rows, i);
        cells.push(formatNum(v, isPct));
        if (includeDelta) cells.push(formatNum(v - baseVal, isPct));
        if (includeDeltaPct) cells.push(baseVal === 0 ? '' : formatNum(((v - baseVal) / Math.abs(baseVal)) * 100, true));
      });
      body.push({ row: cells, isSection: false, isTotal, isPct });
    });

    autoTable(doc, {
      head: [head1, head2],
      body: body.map(b => b.row),
      startY: y,
      theme: 'grid',
      styles: {
        fontSize: 8.5,
        cellPadding: { top: 4, right: 6, bottom: 4, left: 6 },
        textColor: TEXT_HEADING,
        lineColor: [226, 232, 240],
        lineWidth: 0.5,
      },
      headStyles: {
        fillColor: ACCENT,
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        halign: 'center',
      },
      columnStyles: { 0: { halign: 'left', cellWidth: 220 } },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const meta = body[data.row.index];
        if (!meta) return;
        if (meta.isSection) {
          data.cell.styles.fillColor = SECTION_BG;
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.halign = data.column.index === 0 ? 'left' : 'center';
        } else if (meta.isTotal) {
          data.cell.styles.fillColor = ACCENT_SOFT;
          data.cell.styles.fontStyle = 'bold';
        }
        if (data.column.index > 0 && !meta.isSection) {
          data.cell.styles.halign = 'right';
        }
      },
      margin: { left: 32, right: 32 },
    });
    // autoTable attaches `lastAutoTable.finalY` to the doc once it finishes.
    // Use `??` so a literal 0 finalY (degenerate empty table) is preserved
    // instead of falling through to the +200 fallback.
    const finalY = (doc as any).lastAutoTable?.finalY;
    y = (typeof finalY === 'number' ? finalY : y - 24) + 24;
  };

  drawSection('Profit & Loss', baseBlocks.pnl, othersBlocks.map(b => b.pnl));
  drawSection('Balance Sheet', baseBlocks.bs, othersBlocks.map(b => b.bs));
  drawSection('Cash Flow', baseBlocks.cf, othersBlocks.map(b => b.cf));

  return doc;
}
