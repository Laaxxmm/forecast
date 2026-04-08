/**
 * CFO Insights — Word Document Generator
 * Uses the 'docx' npm package to build a professional .docx report.
 */

const {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, HeadingLevel, AlignmentType, BorderStyle,
    WidthType, ShadingType, PageOrientation, convertInchesToTwip,
    TableLayoutType, ImageRun
} = require('docx');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { fmtINR, fmtLakhs, formatDate, formatMonth } = require('./report-generator');

// ── Chart renderer (server-side Chart.js → PNG) ──
const chartRenderer = new ChartJSNodeCanvas({ width: 700, height: 380, backgroundColour: 'white' });

// ── Colour palette ──
const NAVY   = '1e293b';
const WHITE  = 'FFFFFF';
const GREY   = 'f1f5f9';
const BORDER = 'cbd5e1';

// ── Reusable helpers ──
function heading(text, level = HeadingLevel.HEADING_1) {
    return new Paragraph({
        children: [new TextRun({ text, bold: true, color: NAVY, size: level === HeadingLevel.HEADING_1 ? 28 : 24, font: 'Calibri' })],
        heading: level,
        spacing: { before: 240, after: 120 },
    });
}

function subheading(text) {
    return heading(text, HeadingLevel.HEADING_2);
}

function bodyText(text, opts = {}) {
    return new Paragraph({
        children: [new TextRun({ text, size: 20, font: 'Calibri', ...opts })],
        spacing: { after: 80 },
    });
}

function bulletPoint(text) {
    return new Paragraph({
        children: [new TextRun({ text, size: 20, font: 'Calibri' })],
        bullet: { level: 0 },
        spacing: { after: 60 },
    });
}

function emptyLine() {
    return new Paragraph({ children: [], spacing: { after: 120 } });
}

const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: BORDER };
const noBorder   = { style: BorderStyle.NONE, size: 0, color: WHITE };
const cellBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

function headerCell(text, width) {
    return new TableCell({
        children: [new Paragraph({
            children: [new TextRun({ text, bold: true, color: WHITE, size: 18, font: 'Calibri' })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 40, after: 40 },
        })],
        shading: { type: ShadingType.SOLID, color: NAVY },
        borders: cellBorders,
        ...(width ? { width: { size: width, type: WidthType.PERCENTAGE } } : {}),
    });
}

function dataCell(text, opts = {}) {
    const align = opts.right ? AlignmentType.RIGHT : (opts.center ? AlignmentType.CENTER : AlignmentType.LEFT);
    return new TableCell({
        children: [new Paragraph({
            children: [new TextRun({
                text: String(text ?? ''),
                bold: !!opts.bold,
                size: 18,
                font: 'Calibri',
            })],
            alignment: align,
            spacing: { before: 30, after: 30 },
        })],
        shading: opts.shaded ? { type: ShadingType.SOLID, color: GREY } : undefined,
        borders: cellBorders,
        ...(opts.width ? { width: { size: opts.width, type: WidthType.PERCENTAGE } } : {}),
    });
}

function currCell(num, opts = {}) {
    return dataCell(fmtINR(num || 0), { right: true, ...opts });
}

function pctCell(num, opts = {}) {
    return dataCell(num != null ? `${Number(num).toFixed(1)}%` : '-', { right: true, ...opts });
}

// ── Section Builders ──

function buildTitleSection(data) {
    return [
        new Paragraph({
            children: [new TextRun({ text: data.title, bold: true, color: NAVY, size: 36, font: 'Calibri' })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
        }),
        new Paragraph({
            children: [new TextRun({ text: data.filterLabel, size: 22, color: '475569', font: 'Calibri' })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
        }),
        new Paragraph({
            children: [
                new TextRun({ text: `Period: ${formatMonth(data.period.from)} – ${formatMonth(data.period.to)}`, size: 20, color: '64748b', font: 'Calibri' }),
                new TextRun({ text: `     Generated: ${formatDate(data.generatedAt)}`, size: 20, color: '64748b', font: 'Calibri' }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
        }),
        new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: NAVY } },
            spacing: { after: 200 },
        }),
    ];
}

function buildExecutiveSummary(data) {
    const children = [heading('1. Executive Summary')];

    // Narrative bullets
    if (data.narrative && data.narrative.length) {
        children.push(bodyText('Key highlights for the reporting period:', { bold: true }));
        for (const b of data.narrative) {
            children.push(bulletPoint(b));
        }
        children.push(emptyLine());
    }

    // Big-3 KPI table
    const cur = data.plComparison.current;
    const pri = data.plComparison.prior;
    const pctChange = (c, p) => p ? ((c - p) / Math.abs(p) * 100) : 0;

    const rows = [
        new TableRow({ children: [headerCell('Metric', 30), headerCell(data.plComparison.currentLabel, 25), headerCell(data.plComparison.priorLabel, 25), headerCell('MoM %', 20)] }),
        kpiRow('Revenue', cur.revenue, pri.revenue, pctChange, false),
        kpiRow('Net Profit', cur.netProfit, pri.netProfit, pctChange, false),
        kpiRow('Cash & Bank', cur.cashBankBalance, pri.cashBankBalance, pctChange, true),
    ];

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

function kpiRow(label, curVal, priVal, pctFn, shaded) {
    const chg = pctFn(curVal, priVal);
    const chgStr = `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`;
    return new TableRow({
        children: [
            dataCell(label, { bold: true, width: 30, shaded }),
            currCell(curVal, { width: 25, shaded }),
            currCell(priVal, { width: 25, shaded }),
            dataCell(chgStr, { right: true, width: 20, shaded }),
        ],
    });
}

// ── Section 2: Profitability & Operations ──

function buildPLComparison(data) {
    const children = [heading('2. Profitability & Operations'), subheading('2.1 Profit & Loss Comparison')];

    const PL_LINES = [
        { key: 'revenue',          label: 'Revenue (Sales)' },
        { key: 'directIncome',     label: 'Direct Income' },
        { key: 'purchase',         label: 'COGS (Purchase)' },
        { key: 'directExpenses',   label: 'Direct Expenses' },
        { key: 'openingStock',     label: 'Opening Stock' },
        { key: 'closingStock',     label: 'Closing Stock' },
        { key: 'grossProfit',      label: 'GROSS PROFIT', bold: true },
        { key: 'indirectExpenses', label: 'Indirect Expenses' },
        { key: 'indirectIncome',   label: 'Indirect Income' },
        { key: 'netProfit',        label: 'NET PROFIT', bold: true },
    ];

    const { current, prior } = data.plComparison;
    const rows = [
        new TableRow({ children: [
            headerCell('Particulars', 40),
            headerCell(data.plComparison.currentLabel, 30),
            headerCell(data.plComparison.priorLabel, 30),
        ]}),
    ];

    PL_LINES.forEach((line, i) => {
        const shaded = i % 2 === 1;
        rows.push(new TableRow({ children: [
            dataCell(line.label, { bold: line.bold, width: 40, shaded }),
            currCell(current[line.key], { bold: line.bold, width: 30, shaded }),
            currCell(prior[line.key],   { bold: line.bold, width: 30, shaded }),
        ]}));
    });

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

// ── Compact helpers for wide Geographic P&L table ──

/** Compact number format: ₹1.41 Cr / ₹38.57 L / ₹5,371 */
/** Total income denominator for margin calculations = |Revenue| + |Direct Income| */
function totalIncome(d) {
    return Math.abs(d?.revenue || 0) + Math.abs(d?.directIncome || 0) || 1;
}

function fmtCompact(num) {
    if (num === null || num === undefined || isNaN(num) || num === 0) return '-';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1e7) return sign + (abs / 1e7).toFixed(2) + ' Cr';
    if (abs >= 1e5) return sign + (abs / 1e5).toFixed(2) + ' L';
    if (abs >= 1e3) return sign + Math.round(abs).toLocaleString('en-IN');
    return sign + abs.toFixed(0);
}

function compactHeaderCell(text) {
    return new TableCell({
        children: [new Paragraph({
            children: [new TextRun({ text, bold: true, color: WHITE, size: 13, font: 'Calibri' })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 20, after: 20 },
        })],
        shading: { type: ShadingType.SOLID, color: NAVY },
        borders: cellBorders,
    });
}

function compactDataCell(text, opts = {}) {
    const align = opts.right ? AlignmentType.RIGHT : (opts.center ? AlignmentType.CENTER : AlignmentType.LEFT);
    return new TableCell({
        children: [new Paragraph({
            children: [new TextRun({
                text: String(text ?? ''),
                bold: !!opts.bold,
                size: 13,
                font: 'Calibri',
            })],
            alignment: align,
            spacing: { before: 15, after: 15 },
        })],
        shading: opts.shaded ? { type: ShadingType.SOLID, color: GREY } : undefined,
        borders: cellBorders,
    });
}

function compactCurrCell(num, opts = {}) {
    return compactDataCell(fmtCompact(num), { right: true, ...opts });
}

function buildColumnarPL(data) {
    const children = [];
    const pl = data.plStatement;
    if (!pl || !pl.columnar || !pl.columns || pl.columns.length <= 1) return children;

    children.push(subheading('2.2 Geographic P&L Breakdown'));

    // Build header rows — up to 3 tiers: level1 (cities), level2 (locations), entity types
    // Cases: level1+level2 → 3 rows | level1 only → 2 rows | level2 only → 2 rows | neither → 1 row
    const hasL1 = pl.level1 && pl.level1.length > 0;
    const hasL2 = pl.level2 && pl.level2.length > 0;
    const rows = [];

    // Helper: build a spanning header row from an array of { label, span } entries
    function spanningRow(items) {
        const cells = [compactHeaderCell('')];
        for (const item of items) {
            if (item.span > 1) {
                cells.push(new TableCell({
                    children: [new Paragraph({
                        children: [new TextRun({ text: item.label, bold: true, color: WHITE, size: 13, font: 'Calibri' })],
                        alignment: AlignmentType.CENTER,
                        spacing: { before: 20, after: 20 },
                    })],
                    columnSpan: item.span,
                    shading: { type: ShadingType.SOLID, color: NAVY },
                    borders: cellBorders,
                }));
            } else {
                cells.push(compactHeaderCell(item.label));
            }
        }
        return new TableRow({ children: cells });
    }

    // Row for entity-type column names (always the bottom header row)
    function entityTypeRow() {
        const cells = [compactHeaderCell('Particulars')];
        for (const col of pl.columns) {
            cells.push(compactHeaderCell(col.name));
        }
        return new TableRow({ children: cells });
    }

    if (hasL1) {
        // Level1 cities as top spanning row (with 'Particulars' label)
        const l1Cells = [compactHeaderCell('Particulars')];
        for (const l1 of pl.level1) {
            if (l1.span > 1) {
                l1Cells.push(new TableCell({
                    children: [new Paragraph({
                        children: [new TextRun({ text: l1.label, bold: true, color: WHITE, size: 13, font: 'Calibri' })],
                        alignment: AlignmentType.CENTER,
                        spacing: { before: 20, after: 20 },
                    })],
                    columnSpan: l1.span,
                    shading: { type: ShadingType.SOLID, color: NAVY },
                    borders: cellBorders,
                }));
            } else {
                l1Cells.push(compactHeaderCell(l1.label));
            }
        }
        rows.push(new TableRow({ children: l1Cells }));
        if (hasL2) rows.push(spanningRow(pl.level2));  // locations row
        // Entity type sub-header row
        const subCells = [compactHeaderCell('')];
        for (const col of pl.columns) subCells.push(compactHeaderCell(col.name));
        rows.push(new TableRow({ children: subCells }));
    } else if (hasL2) {
        // No level1 but has level2 — locations as top spanning row
        const l2Cells = [compactHeaderCell('Particulars')];
        for (const l2 of pl.level2) {
            if (l2.span > 1) {
                l2Cells.push(new TableCell({
                    children: [new Paragraph({
                        children: [new TextRun({ text: l2.label, bold: true, color: WHITE, size: 13, font: 'Calibri' })],
                        alignment: AlignmentType.CENTER,
                        spacing: { before: 20, after: 20 },
                    })],
                    columnSpan: l2.span,
                    shading: { type: ShadingType.SOLID, color: NAVY },
                    borders: cellBorders,
                }));
            } else {
                l2Cells.push(compactHeaderCell(l2.label));
            }
        }
        rows.push(new TableRow({ children: l2Cells }));
        // Entity type sub-header row
        const subCells = [compactHeaderCell('')];
        for (const col of pl.columns) subCells.push(compactHeaderCell(col.name));
        rows.push(new TableRow({ children: subCells }));
    } else {
        // No spanning — just entity type column names
        rows.push(entityTypeRow());
    }

    // Data rows
    const lines = pl.lines || [];
    lines.forEach((line, i) => {
        const shaded = i % 2 === 1;
        const rowCells = [compactDataCell(line.label, { bold: line.bold, shaded })];
        for (const col of pl.columns) {
            rowCells.push(compactCurrCell(col.data?.[line.key], { bold: line.bold, shaded }));
        }
        rows.push(new TableRow({ children: rowCells }));
    });

    // GP% row
    const gpRowCells = [compactDataCell('GP %', { bold: true, shaded: true })];
    for (const col of pl.columns) {
        const ti = totalIncome(col.data);
        const gpPct = ((col.data?.grossProfit || 0) / ti * 100).toFixed(1);
        gpRowCells.push(compactDataCell(gpPct + '%', { right: true, bold: true, shaded: true }));
    }
    rows.push(new TableRow({ children: gpRowCells }));

    // NP% row
    const npRowCells = [compactDataCell('NP %', { bold: true })];
    for (const col of pl.columns) {
        const ti = totalIncome(col.data);
        const npPct = ((col.data?.netProfit || 0) / ti * 100).toFixed(1);
        npRowCells.push(compactDataCell(npPct + '%', { right: true, bold: true }));
    }
    rows.push(new TableRow({ children: npRowCells }));

    children.push(new Table({
        rows,
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.AUTOFIT,
    }));
    children.push(emptyLine());
    return children;
}

function buildRevenueConcentration(data, subNum = '2.3') {
    const children = [];
    if (!data.revenueConcentration || data.revenueConcentration.length === 0) return children;

    children.push(subheading(`${subNum} Revenue Concentration (Top 5 – YTD)`));

    const rows = [
        new TableRow({ children: [headerCell('Ledger', 50), headerCell('Amount (₹)', 30), headerCell('% of Total', 20)] }),
    ];
    data.revenueConcentration.forEach((r, i) => {
        const shaded = i % 2 === 1;
        rows.push(new TableRow({ children: [
            dataCell(r.name, { shaded }),
            currCell(r.amount, { shaded }),
            pctCell(r.pct, { shaded }),
        ]}));
    });

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

function buildDirectIncomeAnalysis(data, subNum = '2.5') {
    const supp = data.directIncomeSupp;
    const bd = data.directIncomeBreakdown;

    // Need at least supplementary data or ledger breakdown to render
    if (!supp && (!bd || bd.length === 0)) return [];

    const children = [];
    children.push(subheading(`${subNum} Direct Income Insights`));

    // ── KPI Summary (from supplementary uploaded data) ──
    if (supp && supp.kpis) {
        const k = supp.kpis;
        const kpiRows = [
            new TableRow({ children: [
                headerCell('Total Billed', 12.5), headerCell('Collections', 12.5),
                headerCell('Collection Rate', 12.5), headerCell('Total Orders', 12.5),
                headerCell('Unique Patients', 12.5), headerCell('Avg. Billing', 12.5),
                headerCell('Returns', 12.5), headerCell('Refunds', 12.5),
            ]}),
            new TableRow({ children: [
                currCell(k.totalBilled), currCell(k.totalCollections),
                pctCell(k.collectionRate), dataCell(k.totalOrders.toLocaleString('en-IN'), { right: true }),
                dataCell(k.uniquePatients.toLocaleString('en-IN'), { right: true }), currCell(k.avgBillingValue),
                dataCell(k.totalReturns.toLocaleString('en-IN'), { right: true }), currCell(k.totalRefunds),
            ]}),
        ];
        children.push(new Table({ rows: kpiRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    // ── Doctor-wise Revenue Table ──
    if (supp && supp.doctors && supp.doctors.length > 0) {
        children.push(bodyText('Doctor-wise Revenue:', { bold: true }));
        const totalDocRev = supp.doctors.reduce((s, d) => s + d.total, 0) || 1;
        const docRows = [
            new TableRow({ children: [
                headerCell('Doctor', 40), headerCell('Revenue (₹)', 25),
                headerCell('Items', 15), headerCell('Share', 20),
            ]}),
        ];
        supp.doctors.slice(0, 10).forEach((d, i) => {
            const shaded = i % 2 === 1;
            const share = ((d.total / totalDocRev) * 100).toFixed(1);
            docRows.push(new TableRow({ children: [
                dataCell(d.name || '-', { shaded }), currCell(d.total, { shaded }),
                dataCell(d.itemCount.toLocaleString('en-IN'), { right: true, shaded }), pctCell(share, { shaded }),
            ]}));
        });
        children.push(new Table({ rows: docRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    // ── Ledger Breakdown (from Tally P&L) ──
    if (bd && bd.length > 0) {
        children.push(bodyText('Direct Income Ledger Breakdown (YTD):', { bold: true }));
        const ledgerRows = [
            new TableRow({ children: [headerCell('Ledger', 50), headerCell('Amount (₹)', 30), headerCell('% of Total', 20)] }),
        ];
        bd.forEach((r, i) => {
            const shaded = i % 2 === 1;
            ledgerRows.push(new TableRow({ children: [
                dataCell(r.name, { shaded }), currCell(r.amount, { shaded }), pctCell(r.pct, { shaded }),
            ]}));
        });
        children.push(new Table({ rows: ledgerRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    return children;
}

/** Chart: Department-wise Performance (horizontal bar) */
async function buildDeptPerformanceChart(data) {
    const supp = data.directIncomeSupp;
    if (!supp || !supp.departments || supp.departments.length === 0) return [];
    const depts = supp.departments.slice(0, 10);
    const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f43f5e', '#84cc16', '#a855f7'];
    const config = {
        type: 'bar',
        data: {
            labels: depts.map(d => d.name.length > 20 ? d.name.slice(0, 18) + '..' : d.name),
            datasets: [{
                label: 'Revenue (₹)',
                data: depts.map(d => d.total),
                backgroundColor: colors.slice(0, depts.length),
            }],
        },
        options: {
            indexAxis: 'y',
            plugins: {
                legend: { display: false },
                title: { display: true, text: 'Department-wise Performance', font: { size: 14, weight: 'bold' } },
            },
            scales: {
                x: { ticks: { callback: v => '₹' + fmtLakhs(v) + 'L' }, grid: { color: '#e2e8f0' } },
            },
        },
    };
    return [await renderChart(config)];
}

/** Chart: Weekly Billing Trend (line + bar) */
async function buildWeeklyTrendChart(data) {
    const supp = data.directIncomeSupp;
    if (!supp || !supp.weeklyTrend || supp.weeklyTrend.length === 0) return [];
    const trend = supp.weeklyTrend;
    const config = {
        type: 'bar',
        data: {
            labels: trend.map(w => w.label),
            datasets: [
                {
                    type: 'line',
                    label: 'Collected',
                    data: trend.map(w => w.collected),
                    borderColor: '#3b82f6',
                    backgroundColor: '#3b82f6',
                    tension: 0.3,
                    pointRadius: 3,
                    order: 1,
                },
                {
                    label: 'Billed',
                    data: trend.map(w => w.billed),
                    backgroundColor: 'rgba(34,197,94,0.5)',
                    order: 2,
                },
            ],
        },
        options: {
            plugins: {
                legend: { position: 'top', labels: { font: { size: 10 } } },
                title: { display: true, text: 'Weekly Billing Trend', font: { size: 14, weight: 'bold' } },
            },
            scales: {
                y: { ticks: { callback: v => '₹' + fmtLakhs(v) + 'L' }, grid: { color: '#e2e8f0' } },
            },
        },
    };
    return [await renderChart(config)];
}

function buildDirectExpenseBreakdown(data, subNum = '2.4') {
    const children = [];
    if (!data.directExpenseBreakdown || data.directExpenseBreakdown.length === 0) return children;

    children.push(subheading(`${subNum} Direct Expense Breakdown (YTD)`));

    const rows = [
        new TableRow({ children: [headerCell('Expense Group', 50), headerCell('Amount (₹)', 30), headerCell('% of Total', 20)] }),
    ];
    data.directExpenseBreakdown.forEach((r, i) => {
        const shaded = i % 2 === 1;
        rows.push(new TableRow({ children: [
            dataCell(r.name, { shaded }),
            currCell(r.amount, { shaded }),
            pctCell(r.pct, { shaded }),
        ]}));
    });

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

function buildIndirectExpenseBreakdown(data, subNum = '2.5') {
    const children = [];
    if (!data.indirectExpenseBreakdown || data.indirectExpenseBreakdown.length === 0) return children;

    children.push(subheading(`${subNum} Indirect Expense Breakdown (YTD)`));

    const rows = [
        new TableRow({ children: [headerCell('Expense Group', 50), headerCell('Amount (₹)', 30), headerCell('% of Total', 20)] }),
    ];
    data.indirectExpenseBreakdown.forEach((r, i) => {
        const shaded = i % 2 === 1;
        rows.push(new TableRow({ children: [
            dataCell(r.name, { shaded }),
            currCell(r.amount, { shaded }),
            pctCell(r.pct, { shaded }),
        ]}));
    });

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

// ── Expense-to-Revenue Ratio Chart (MoM) ──

async function buildExpenseRevenueRatioChart(data) {
    const td = data.trendData;
    if (!td || td.length < 2) return [];

    const labels = td.map(m => formatMonth(m.month));
    const directRatios = td.map(m => m.revenue ? (Math.abs(m.directExpenses) / Math.abs(m.revenue) * 100) : 0);
    const indirectRatios = td.map(m => m.revenue ? (Math.abs(m.indirectExpenses) / Math.abs(m.revenue) * 100) : 0);

    const config = {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Direct Exp / Revenue %',
                    data: directRatios,
                    borderColor: '#3b82f6',
                    backgroundColor: '#3b82f620',
                    tension: 0.3,
                    fill: true,
                    pointRadius: 4,
                },
                {
                    label: 'Indirect Exp / Revenue %',
                    data: indirectRatios,
                    borderColor: '#f59e0b',
                    backgroundColor: '#f59e0b20',
                    tension: 0.3,
                    fill: true,
                    pointRadius: 4,
                },
            ],
        },
        options: {
            plugins: {
                legend: { position: 'bottom', labels: { font: { size: 11 } } },
                title: { display: true, text: 'Expense-to-Revenue Ratio (MoM)', font: { size: 14, weight: 'bold' } },
            },
            scales: {
                y: {
                    ticks: { callback: v => v.toFixed(0) + '%' },
                    grid: { color: '#e2e8f0' },
                    title: { display: true, text: '% of Revenue' },
                },
                x: { grid: { display: false } },
            },
        },
    };
    return [await renderChart(config)];
}

// ── Unit GP/NP Chart (consolidated only, placed after 2.2 table) ──

async function buildUnitMarginChart(data) {
    const pl = data.plStatement;
    if (!pl || !pl.columnar || pl.columns.length <= 2) return [];

    const unitCols = pl.columns.filter(c => c.name !== 'Total');
    const labels = unitCols.map(c => c.name);
    const gpData = unitCols.map(c => {
        const ti = totalIncome(c.data);
        return ((c.data?.grossProfit || 0) / ti * 100);
    });
    const npData = unitCols.map(c => {
        const ti = totalIncome(c.data);
        return ((c.data?.netProfit || 0) / ti * 100);
    });

    const config = {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Gross Profit %', data: gpData, backgroundColor: '#22c55e' },
                { label: 'Net Profit %', data: npData, backgroundColor: '#3b82f6' },
            ],
        },
        options: {
            plugins: {
                legend: { position: 'bottom', labels: { font: { size: 11 } } },
                title: { display: true, text: 'Unit Profitability — GP% vs NP%', font: { size: 14, weight: 'bold' } },
            },
            scales: {
                y: {
                    ticks: { callback: v => v.toFixed(0) + '%' },
                    grid: { color: '#e2e8f0' },
                },
                x: { grid: { display: false } },
            },
        },
    };
    return [await renderChart(config)];
}

// ── Segment P&L (consolidated only) — separate table per segment + GP%/NP% rows ──

function aggregateSegments(pl) {
    // Columns may repeat names (e.g. "Pharma" for each city). Aggregate by name.
    const map = new Map();
    const PL_KEYS = (pl.lines || []).map(l => l.key);
    for (const col of pl.columns) {
        if (col.name === 'Total') continue;
        if (!map.has(col.name)) {
            // Clone all KPI keys to 0
            const agg = {};
            for (const k of PL_KEYS) agg[k] = 0;
            map.set(col.name, agg);
        }
        const agg = map.get(col.name);
        for (const k of PL_KEYS) {
            agg[k] = (agg[k] || 0) + (col.data?.[k] || 0);
        }
    }
    return Array.from(map.entries()).map(([name, d]) => ({ name, data: d }));
}

function buildSegmentPL(data, subNum = '2.3') {
    const pl = data.plStatement;
    if (!pl || !pl.columnar || pl.columns.length <= 2) return [];

    const children = [subheading(`${subNum} Segment Profit & Loss`)];
    const PL_LINES = pl.lines || [];
    const segments = aggregateSegments(pl);

    // Build a separate P&L table for each segment (Pharma, Clinic, etc.)
    segments.forEach(seg => {
        const d = seg.data;
        children.push(bodyText(`${seg.name}`, { bold: true }));

        const rows = [
            new TableRow({ children: [headerCell('Particulars', 60), headerCell('Amount (₹)', 40)] }),
        ];

        PL_LINES.forEach((line, i) => {
            const shaded = i % 2 === 1;
            rows.push(new TableRow({ children: [
                dataCell(line.label, { bold: line.bold, shaded }),
                currCell(d?.[line.key] || 0, { bold: line.bold, shaded }),
            ]}));
        });

        // GP% row
        const ti = totalIncome(d);
        const gpPct = ((d?.grossProfit || 0) / ti * 100).toFixed(1);
        rows.push(new TableRow({ children: [
            dataCell('GP %', { bold: true, shaded: true }),
            dataCell(gpPct + '%', { right: true, bold: true, shaded: true }),
        ]}));

        // NP% row
        const npPct = ((d?.netProfit || 0) / ti * 100).toFixed(1);
        rows.push(new TableRow({ children: [
            dataCell('NP %', { bold: true }),
            dataCell(npPct + '%', { right: true, bold: true }),
        ]}));

        children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    });

    return children;
}

async function buildSegmentComparisonChart(data) {
    const pl = data.plStatement;
    if (!pl || !pl.columnar || pl.columns.length <= 2) return [];

    const segments = aggregateSegments(pl);
    const labels = segments.map(c => c.name);
    const gpData = segments.map(c => {
        const ti = totalIncome(c.data);
        return ((c.data?.grossProfit || 0) / ti * 100);
    });
    const npData = segments.map(c => {
        const ti = totalIncome(c.data);
        return ((c.data?.netProfit || 0) / ti * 100);
    });

    const config = {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Gross Profit %', data: gpData, backgroundColor: '#22c55e' },
                { label: 'Net Profit %',   data: npData, backgroundColor: '#3b82f6' },
            ],
        },
        options: {
            plugins: {
                legend: { position: 'bottom', labels: { font: { size: 11 } } },
                title: { display: true, text: 'Segment GP% vs NP%', font: { size: 14, weight: 'bold' } },
            },
            scales: {
                y: {
                    ticks: { callback: v => v.toFixed(0) + '%' },
                    grid: { color: '#e2e8f0' },
                },
                x: { grid: { display: false } },
            },
        },
    };
    return [await renderChart(config)];
}

// ── Section 3: Liquidity & Working Capital ──

function buildCashPosition(data, sn) {
    const children = [heading(`${sn || 3}. Liquidity & Working Capital`), subheading(`${sn || 3}.1 Cash Position`)];

    const cp = data.cashPosition;
    const rows = [
        new TableRow({ children: [headerCell('Metric', 60), headerCell('Amount (₹)', 40)] }),
        new TableRow({ children: [dataCell('Opening Balance (Start of Month)'), currCell(cp.opening)] }),
        new TableRow({ children: [dataCell('Closing Balance (End of Month)', { shaded: true }), currCell(cp.closing, { shaded: true })] }),
        new TableRow({ children: [dataCell('Net Change', { bold: true }), currCell(cp.netChange, { bold: true })] }),
    ];

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

function buildAgeingTable(title, sectionNum, ageData) {
    const children = [subheading(`${sectionNum} ${title}`)];

    if (!ageData || ageData.length === 0) {
        children.push(bodyText('No outstanding bills found for this period.'));
        return children;
    }

    const rows = [
        new TableRow({ children: [
            headerCell('Party', 28), headerCell('0-30 days', 15), headerCell('31-60 days', 15),
            headerCell('61-90 days', 14), headerCell('90+ days', 14), headerCell('Total', 14),
        ]}),
    ];

    let grandTotal = 0;
    ageData.forEach((r, i) => {
        const shaded = i % 2 === 1;
        grandTotal += r.total || 0;
        rows.push(new TableRow({ children: [
            dataCell(r.party_name, { shaded }),
            currCell(r['0_30'], { shaded }),
            currCell(r['31_60'], { shaded }),
            currCell(r['61_90'], { shaded }),
            currCell(r['90_plus'], { shaded }),
            currCell(r.total, { bold: true, shaded }),
        ]}));
    });

    // Grand total row
    rows.push(new TableRow({ children: [
        dataCell('TOTAL', { bold: true, shaded: true }),
        dataCell('', { shaded: true }), dataCell('', { shaded: true }),
        dataCell('', { shaded: true }), dataCell('', { shaded: true }),
        currCell(grandTotal, { bold: true, shaded: true }),
    ]}));

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

// ── Section 4: Statutory & Tax Compliance ──

function buildGSTSummary(data, sn) {
    const children = [heading(`${sn || 4}. Statutory & Tax Compliance`), subheading(`${sn || 4}.1 GST Summary`)];

    if (!data.gstSummary || data.gstSummary.length === 0) {
        children.push(bodyText('GST module not synced — no GST data available for this period.', { italics: true, color: '94a3b8' }));
        children.push(emptyLine());
        return children;
    }

    const rows = [
        new TableRow({ children: [
            headerCell('Voucher Type', 22), headerCell('Count', 10), headerCell('Taxable (₹)', 17),
            headerCell('IGST (₹)', 17), headerCell('CGST (₹)', 17), headerCell('SGST (₹)', 17),
        ]}),
    ];

    data.gstSummary.forEach((r, i) => {
        const shaded = i % 2 === 1;
        rows.push(new TableRow({ children: [
            dataCell(r.voucher_type, { shaded }),
            dataCell(String(r.count || 0), { right: true, shaded }),
            currCell(r.taxable, { shaded }),
            currCell(r.igst, { shaded }),
            currCell(r.cgst, { shaded }),
            currCell(r.sgst, { shaded }),
        ]}));
    });

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

function buildTDSNote(sn) {
    return [
        subheading(`${sn || 4}.2 TDS / TCS`),
        bodyText('TDS/TCS data is not available in the current sync. Please ensure TDS/TCS data is synced from Tally for complete compliance reporting.', { italics: true, color: '94a3b8' }),
        emptyLine(),
    ];
}

function buildComplianceCalendar(data, sn) {
    const children = [subheading(`${sn || 4}.3 Upcoming Compliance Deadlines`)];

    if (!data.complianceCalendar || data.complianceCalendar.length === 0) {
        children.push(bodyText('No upcoming deadlines in the next 60 days.'));
        return children;
    }

    const rows = [
        new TableRow({ children: [headerCell('Due Date', 30), headerCell('Compliance Item', 70)] }),
    ];
    data.complianceCalendar.forEach((c, i) => {
        const shaded = i % 2 === 1;
        rows.push(new TableRow({ children: [
            dataCell(c.date, { shaded }),
            dataCell(c.description, { shaded }),
        ]}));
    });

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

function buildAuditStatus(sn) {
    return [
        subheading(`${sn}.4 Audit & Notice Status`),
        bodyText('[To be filled by management — note any pending tax assessments, notices, or audit observations here.]', { italics: true, color: '94a3b8' }),
        emptyLine(),
    ];
}

// ── Section: Pharma Sales Insights (conditional) ──

function buildPharmaInsights(data, subNum) {
    const children = [];
    const p = data.pharmaInsights;
    if (!p) return children;

    children.push(subheading(`${subNum} Pharma Sales Insights`));

    // KPI summary table
    const k = p.kpis;
    const kpiRows = [
        new TableRow({ children: [
            headerCell('Total Sales', 20), headerCell('Gross Profit', 20), headerCell('Margin %', 15),
            headerCell('Avg Bill Value', 20), headerCell('Unique Bills', 12), headerCell('Qty Sold', 13),
        ]}),
        new TableRow({ children: [
            currCell(k.totalSalesAmount), currCell(k.computedGrossProfit),
            pctCell(k.profitMarginPct), currCell(k.avgBillValue),
            dataCell(k.uniqueBills.toLocaleString('en-IN'), { right: true }),
            dataCell(k.totalQtySold.toLocaleString('en-IN'), { right: true }),
        ]}),
    ];
    children.push(new Table({ rows: kpiRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());

    // Top drugs by revenue
    if (p.topDrugsByRevenue?.length) {
        children.push(bodyText('Top 10 Drugs by Revenue:', { bold: true }));
        const drugRevRows = [
            new TableRow({ children: [headerCell('Drug Name', 50), headerCell('Revenue (₹)', 30), headerCell('Qty', 20)] }),
        ];
        p.topDrugsByRevenue.forEach((d, i) => {
            const shaded = i % 2 === 1;
            drugRevRows.push(new TableRow({ children: [
                dataCell(d.name, { shaded }), currCell(d.total, { shaded }),
                dataCell(Math.round(d.qty).toLocaleString('en-IN'), { right: true, shaded }),
            ]}));
        });
        children.push(new Table({ rows: drugRevRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    // Top drugs by profit
    if (p.topDrugsByProfit?.length) {
        children.push(bodyText('Top 10 Drugs by Gross Profit:', { bold: true }));
        const drugProfRows = [
            new TableRow({ children: [headerCell('Drug Name', 50), headerCell('Profit (₹)', 25), headerCell('Margin %', 25)] }),
        ];
        p.topDrugsByProfit.forEach((d, i) => {
            const shaded = i % 2 === 1;
            drugProfRows.push(new TableRow({ children: [
                dataCell(d.name, { shaded }), currCell(d.profit, { shaded }),
                pctCell(d.marginPct, { shaded }),
            ]}));
        });
        children.push(new Table({ rows: drugProfRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    // Doctor revenue
    if (p.doctorRevenue?.length) {
        children.push(bodyText('Top 5 Doctors by Revenue:', { bold: true }));
        const docRows = [
            new TableRow({ children: [headerCell('Doctor', 50), headerCell('Revenue (₹)', 30), headerCell('Bills', 20)] }),
        ];
        p.doctorRevenue.forEach((d, i) => {
            const shaded = i % 2 === 1;
            docRows.push(new TableRow({ children: [
                dataCell(d.name, { shaded }), currCell(d.total, { shaded }),
                dataCell(d.billCount.toLocaleString('en-IN'), { right: true, shaded }),
            ]}));
        });
        children.push(new Table({ rows: docRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    return children;
}

// ── Section: Inventory & Stock Health (conditional) ──

function buildStockHealth(data, sn) {
    const children = [];
    const s = data.closingStockInsights;
    if (!s) return children;

    const k = s.kpis;

    // Section heading with snapshot month
    const monthLabel = s.latestMonth
        ? new Date(s.latestMonth + '-01').toLocaleString('en-IN', { month: 'long', year: 'numeric' })
        : '';
    children.push(heading(`${sn}. Inventory & Stock Health`));
    if (monthLabel) {
        children.push(bodyText(`Snapshot as at ${monthLabel}`, { italics: true, color: '64748b' }));
    }

    // 3.1 Stock Position Summary
    children.push(subheading(`${sn}.1 Stock Position Summary`));
    const posRows = [
        new TableRow({ children: [headerCell('Metric', 40), headerCell('Value', 30), headerCell('', 30)] }),
        new TableRow({ children: [dataCell('Total Stock Value (MRP)'), currCell(k.totalStockValue), dataCell('')] }),
        new TableRow({ children: [dataCell('Purchase Value', { shaded: true }), currCell(k.totalPurchaseValue, { shaded: true }), dataCell('', { shaded: true })] }),
        new TableRow({ children: [dataCell('Margin %'), dataCell(`${k.marginPct}%`, { right: true }), dataCell('')] }),
        new TableRow({ children: [dataCell('Active SKUs', { shaded: true }), dataCell(k.activeSKUs.toLocaleString('en-IN'), { right: true, shaded: true }), dataCell('', { shaded: true })] }),
        new TableRow({ children: [dataCell('Total Batches'), dataCell(k.totalBatches.toLocaleString('en-IN'), { right: true }), dataCell('')] }),
    ];
    children.push(new Table({ rows: posRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());

    // 3.2 Expiry Risk Analysis
    children.push(subheading(`${sn}.2 Expiry Risk Analysis`));

    const totalVal = k.totalStockValue || 1;
    const safePct = (k.safeStockValue / totalVal * 100).toFixed(1);
    const nearPct = (k.nearExpiryStockValue / totalVal * 100).toFixed(1);
    const expPct = (k.expiredStockValue / totalVal * 100).toFixed(1);

    const expiryRows = [
        new TableRow({ children: [headerCell('Category', 30), headerCell('Value (₹)', 25), headerCell('% of Total', 20), headerCell('Batches', 25)] }),
        new TableRow({ children: [dataCell('Safe Stock'), currCell(k.safeStockValue), pctCell(parseFloat(safePct)), dataCell('-', { right: true })] }),
        new TableRow({ children: [dataCell('Near-Expiry (within 3 months)', { shaded: true }), currCell(k.nearExpiryStockValue, { shaded: true }), pctCell(parseFloat(nearPct), { shaded: true }), dataCell(String(k.nearExpiryBatchCount), { right: true, shaded: true })] }),
        new TableRow({ children: [dataCell('Expired', { bold: true }), currCell(k.expiredStockValue, { bold: true }), pctCell(parseFloat(expPct), { bold: true }), dataCell(String(k.expiredBatchCount), { right: true, bold: true })] }),
    ];
    children.push(new Table({ rows: expiryRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());

    // Expired items table
    if (s.expiredItems?.length) {
        children.push(bodyText('Top Expired Batches (by value):', { bold: true }));
        const expItemRows = [
            new TableRow({ children: [headerCell('Product', 30), headerCell('Manufacturer', 20), headerCell('Batch', 12), headerCell('Expiry', 13), headerCell('Qty', 10), headerCell('Value (₹)', 15)] }),
        ];
        s.expiredItems.forEach((item, i) => {
            const shaded = i % 2 === 1;
            expItemRows.push(new TableRow({ children: [
                dataCell(item.product.length > 30 ? item.product.slice(0, 28) + '..' : item.product, { shaded }),
                dataCell(item.manufacturer.length > 20 ? item.manufacturer.slice(0, 18) + '..' : item.manufacturer, { shaded }),
                dataCell(item.batchNo, { shaded }),
                dataCell(item.expiryDate, { shaded }),
                dataCell(String(item.avlQty), { right: true, shaded }),
                currCell(item.stockValue, { shaded }),
            ]}));
        });
        children.push(new Table({ rows: expItemRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    // Near-expiry items table
    if (s.nearExpiryItems?.length) {
        children.push(bodyText('Near-Expiry Batches (expiring within 3 months):', { bold: true }));
        const neItemRows = [
            new TableRow({ children: [headerCell('Product', 30), headerCell('Manufacturer', 20), headerCell('Batch', 12), headerCell('Expiry', 13), headerCell('Qty', 10), headerCell('Value (₹)', 15)] }),
        ];
        s.nearExpiryItems.forEach((item, i) => {
            const shaded = i % 2 === 1;
            neItemRows.push(new TableRow({ children: [
                dataCell(item.product.length > 30 ? item.product.slice(0, 28) + '..' : item.product, { shaded }),
                dataCell(item.manufacturer.length > 20 ? item.manufacturer.slice(0, 18) + '..' : item.manufacturer, { shaded }),
                dataCell(item.batchNo, { shaded }),
                dataCell(item.expiryDate, { shaded }),
                dataCell(String(item.avlQty), { right: true, shaded }),
                currCell(item.stockValue, { shaded }),
            ]}));
        });
        children.push(new Table({ rows: neItemRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    // 3.3 Slow-Moving Inventory
    if (s.slowMovingItems?.length) {
        children.push(subheading(`${sn}.3 Slow-Moving Inventory`));
        children.push(bodyText(`Total slow-moving value: ${fmtINR(k.slowMovingValue)} across ${k.slowMovingBatchCount} batches (received over 1 year ago).`));
        const smRows = [
            new TableRow({ children: [headerCell('Product', 30), headerCell('Manufacturer', 22), headerCell('Received', 15), headerCell('Qty', 13), headerCell('Value (₹)', 20)] }),
        ];
        s.slowMovingItems.forEach((item, i) => {
            const shaded = i % 2 === 1;
            smRows.push(new TableRow({ children: [
                dataCell(item.product.length > 30 ? item.product.slice(0, 28) + '..' : item.product, { shaded }),
                dataCell(item.manufacturer.length > 22 ? item.manufacturer.slice(0, 20) + '..' : item.manufacturer, { shaded }),
                dataCell(item.receivedDate, { shaded }),
                dataCell(String(item.avlQty), { right: true, shaded }),
                currCell(item.stockValue, { shaded }),
            ]}));
        });
        children.push(new Table({ rows: smRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        children.push(emptyLine());
    }

    // 3.4 Supplier Concentration
    const hasStockists = s.topStockists?.length > 0;
    const hasMfg = s.topManufacturers?.length > 0;
    if (hasStockists || hasMfg) {
        children.push(subheading(`${sn}.4 Supplier Concentration`));

        if (hasStockists) {
            children.push(bodyText('Top Stockists by Stock Value:', { bold: true }));
            const stRows = [
                new TableRow({ children: [headerCell('Stockist', 50), headerCell('Stock Value (₹)', 30), headerCell('Batches', 20)] }),
            ];
            s.topStockists.forEach((st, i) => {
                const shaded = i % 2 === 1;
                stRows.push(new TableRow({ children: [
                    dataCell(st.name, { shaded }), currCell(st.stockValue, { shaded }),
                    dataCell(String(st.batchCount), { right: true, shaded }),
                ]}));
            });
            children.push(new Table({ rows: stRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
            children.push(emptyLine());
        }

        if (hasMfg) {
            children.push(bodyText('Top Manufacturers by Stock Value:', { bold: true }));
            const mfgRows = [
                new TableRow({ children: [headerCell('Manufacturer', 50), headerCell('Stock Value (₹)', 30), headerCell('Batches', 20)] }),
            ];
            s.topManufacturers.forEach((m, i) => {
                const shaded = i % 2 === 1;
                mfgRows.push(new TableRow({ children: [
                    dataCell(m.name, { shaded }), currCell(m.stockValue, { shaded }),
                    dataCell(String(m.batchCount), { right: true, shaded }),
                ]}));
            });
            children.push(new Table({ rows: mfgRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
            children.push(emptyLine());
        }
    }

    return children;
}

// ── Section: Key Action Items (conditional) ──

const ACTION_COLORS = { high: 'dc2626', medium: 'f59e0b' };

function buildActionItemsSection(data, sn) {
    const children = [];
    const items = data.actionItems;
    if (!items || items.length === 0) return children;

    children.push(heading(`${sn}. Key Action Items`));
    children.push(bodyText('Auto-generated action items requiring management attention:', { italics: true, color: '64748b' }));
    children.push(emptyLine());

    const rows = [
        new TableRow({ children: [headerCell('Priority', 12), headerCell('Category', 18), headerCell('Action Required', 70)] }),
    ];

    items.forEach((item, i) => {
        const shaded = i % 2 === 1;
        const prioColor = ACTION_COLORS[item.priority] || '64748b';
        rows.push(new TableRow({ children: [
            new TableCell({
                children: [new Paragraph({
                    children: [new TextRun({ text: item.priority.toUpperCase(), bold: true, size: 16, color: prioColor, font: 'Calibri' })],
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 30, after: 30 },
                })],
                shading: shaded ? { type: ShadingType.SOLID, color: GREY } : undefined,
                borders: cellBorders,
            }),
            dataCell(item.category, { bold: true, shaded }),
            dataCell(item.description, { shaded }),
        ]}));
    });

    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    children.push(emptyLine());
    return children;
}

// ── Chart Helpers ──

/** Render a Chart.js config to a centered ImageRun paragraph */
async function renderChart(config) {
    const buffer = await chartRenderer.renderToBuffer(config);
    return new Paragraph({
        children: [new ImageRun({
            type: 'png',
            data: buffer,
            transformation: { width: 540, height: 310 },
        })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 100, after: 200 },
    });
}

/** Chart 1: P&L Comparison — Grouped Bar Chart */
async function buildPLComparisonChart(data) {
    const comp = data.plComparison;
    if (!comp || !comp.current) return [];

    const labels = ['Revenue', 'Gross Profit', 'Indirect Exp', 'Net Profit'];
    const keys   = ['revenue', 'grossProfit', 'indirectExpenses', 'netProfit'];
    const curVals  = keys.map(k => Math.abs(comp.current[k] || 0));
    const priVals  = keys.map(k => Math.abs(comp.prior[k] || 0));

    const config = {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: comp.currentLabel || 'Current', data: curVals,  backgroundColor: '#3b82f6' },
                { label: comp.priorLabel   || 'Prior',   data: priVals,  backgroundColor: '#94a3b8' },
            ],
        },
        options: {
            plugins: {
                legend: { position: 'bottom', labels: { font: { size: 11 } } },
                title: { display: true, text: 'P&L Comparison', font: { size: 14, weight: 'bold' } },
            },
            scales: {
                y: {
                    ticks: { callback: v => '₹' + fmtLakhs(v) + 'L' },
                    grid: { color: '#e2e8f0' },
                },
                x: { grid: { display: false } },
            },
        },
    };
    return [await renderChart(config)];
}

/** Chart 2: Revenue Concentration — Doughnut Chart */
async function buildRevenueConcentrationChart(data) {
    const rc = data.revenueConcentration;
    if (!rc || rc.length === 0) return [];

    const top5 = rc.slice(0, 5);
    const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'];

    const config = {
        type: 'doughnut',
        data: {
            labels: top5.map(r => r.name.length > 25 ? r.name.slice(0, 23) + '..' : r.name),
            datasets: [{
                data: top5.map(r => Math.abs(r.amount)),
                backgroundColor: colors.slice(0, top5.length),
            }],
        },
        options: {
            plugins: {
                legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12 } },
                title: { display: true, text: 'Revenue Concentration (Top 5)', font: { size: 14, weight: 'bold' } },
            },
        },
    };
    return [await renderChart(config)];
}

// buildOpExTrendChart removed — data accuracy under review

/** Chart 4: AR/AP Ageing — Horizontal Stacked Bar Chart */
async function buildAgeingChart(ageingData, title) {
    if (!ageingData || ageingData.length === 0) return [];

    const top8 = ageingData.slice(0, 8);
    const config = {
        type: 'bar',
        data: {
            labels: top8.map(r => {
                const name = r.party_name || '';
                return name.length > 22 ? name.slice(0, 20) + '..' : name;
            }),
            datasets: [
                { label: '0-30 days',  data: top8.map(r => Math.abs(r['0_30']  || 0)), backgroundColor: '#22c55e' },
                { label: '31-60 days', data: top8.map(r => Math.abs(r['31_60'] || 0)), backgroundColor: '#f59e0b' },
                { label: '61-90 days', data: top8.map(r => Math.abs(r['61_90'] || 0)), backgroundColor: '#f97316' },
                { label: '90+ days',   data: top8.map(r => Math.abs(r['90_plus'] || 0)), backgroundColor: '#dc2626' },
            ],
        },
        options: {
            indexAxis: 'y',
            plugins: {
                legend: { position: 'bottom', labels: { font: { size: 10 } } },
                title: { display: true, text: title || 'Ageing Analysis', font: { size: 14, weight: 'bold' } },
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: { callback: v => '₹' + fmtLakhs(v) + 'L' },
                    grid: { color: '#e2e8f0' },
                },
                y: { stacked: true },
            },
        },
    };
    return [await renderChart(config)];
}

// ── Main generator ──

async function generateDocx(cfoData, res, filename) {
    const isConsolidated = !!cfoData.isConsolidated;

    // ── Render all charts in parallel ──
    const [plChartArr, revChartArr, arChartArr, apChartArr, ratioChartArr, unitMarginChartArr, segmentChartArr, deptChartArr, weeklyTrendChartArr] = await Promise.all([
        buildPLComparisonChart(cfoData),
        buildRevenueConcentrationChart(cfoData),
        buildAgeingChart(cfoData.arAgeing, 'Accounts Receivable Ageing'),
        buildAgeingChart(cfoData.apAgeing, 'Accounts Payable Ageing'),
        buildExpenseRevenueRatioChart(cfoData),
        isConsolidated ? buildUnitMarginChart(cfoData) : Promise.resolve([]),
        isConsolidated ? buildSegmentComparisonChart(cfoData) : Promise.resolve([]),
        buildDeptPerformanceChart(cfoData),
        buildWeeklyTrendChart(cfoData),
    ]);

    // ── Dynamic section numbering ──
    const hasStockHealth = !!cfoData.closingStockInsights;
    const hasActionItems = cfoData.actionItems && cfoData.actionItems.length > 0;

    // Section 2 sub-numbering
    // Consolidated: 2.1=P&L Comparison, 2.2=Geographic P&L (hardcoded), then 2.3+
    // Individual: 2.1=P&L Comparison, then 2.2+
    const profitSn = 2;
    let profSub = isConsolidated ? 3 : 2;
    const hasDirectInc = !!(cfoData.directIncomeSupp || (cfoData.directIncomeBreakdown && cfoData.directIncomeBreakdown.length > 0));
    const hasPharma = !!cfoData.pharmaInsights;
    const segmentPLSubNum   = isConsolidated ? `${profitSn}.${profSub++}` : null;
    const revConcSubNum     = `${profitSn}.${profSub++}`;
    const directIncSubNum   = hasDirectInc ? `${profitSn}.${profSub++}` : null;
    const pharmaSubNum      = hasPharma ? `${profitSn}.${profSub++}` : null;
    const directExpSubNum   = `${profitSn}.${profSub++}`;
    const indirectExpSubNum = `${profitSn}.${profSub++}`;
    const ratioSubNum       = `${profitSn}.${profSub}`;

    // Top-level section numbering
    let sn = 3;
    const stockSn  = hasStockHealth ? sn++ : null;
    const liqSn    = sn++;
    const taxSn    = !isConsolidated ? sn++ : null;
    const actionSn = (!isConsolidated && hasActionItems) ? sn++ : null;

    // ── Footer paragraphs (reused in single or multi-section) ──
    const footerParagraphs = [
        new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: NAVY } },
            spacing: { before: 200, after: 80 },
        }),
        new Paragraph({
            children: [new TextRun({ text: 'Generated by TallyVision · CFO Insights Report', size: 16, color: '94a3b8', font: 'Calibri', italics: true })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
        }),
    ];

    // ── Check if we need landscape for the Geographic P&L ──
    const plCols = cfoData.plStatement?.columns?.length || 0;
    const needsLandscape = plCols > 4;

    // ── Page property presets ──
    const portraitPage = {
        page: {
            size: { orientation: PageOrientation.PORTRAIT, width: convertInchesToTwip(8.27), height: convertInchesToTwip(11.69) },
            margin: { top: convertInchesToTwip(0.8), right: convertInchesToTwip(0.8), bottom: convertInchesToTwip(0.8), left: convertInchesToTwip(0.8) },
        },
    };
    // NOTE: docx package swaps width/height when orientation=LANDSCAPE,
    // so pass portrait dimensions and let it swap them for correct XML output (w:w > w:h)
    const landscapePage = {
        page: {
            size: { orientation: PageOrientation.LANDSCAPE, width: convertInchesToTwip(8.27), height: convertInchesToTwip(11.69) },
            margin: { top: convertInchesToTwip(0.6), right: convertInchesToTwip(0.6), bottom: convertInchesToTwip(0.6), left: convertInchesToTwip(0.6) },
        },
    };

    // ── Shared content blocks (used in both layout paths) ──
    const consolidatedBlocks = isConsolidated ? [
        ...buildSegmentPL(cfoData, segmentPLSubNum),
        ...segmentChartArr,
    ] : [];

    const ratioBlock = ratioChartArr.length
        ? [subheading(`${ratioSubNum} Expense-to-Revenue Ratio (MoM)`), ...ratioChartArr]
        : [];

    const statutoryBlock = taxSn ? [
        ...buildGSTSummary(cfoData, taxSn),
        ...buildTDSNote(taxSn),
        ...buildComplianceCalendar(cfoData, taxSn),
        ...buildAuditStatus(taxSn),
    ] : [];

    let sections;

    if (needsLandscape) {
        // ── 3-SECTION DOCUMENT: Portrait → Landscape → Portrait ──

        // Section 1 (Portrait): Title → Executive Summary → P&L Comparison + chart
        const portraitSection1Children = [
            ...buildTitleSection(cfoData),
            ...buildExecutiveSummary(cfoData),
            ...buildPLComparison(cfoData),
            ...plChartArr,
        ];

        // Section 2 (Landscape): Geographic P&L Breakdown + GP/NP chart
        const landscapeChildren = [
            ...buildColumnarPL(cfoData),
            ...unitMarginChartArr,
        ];

        // Section 3 (Portrait): remaining content
        const portraitSection2Children = [
            ...consolidatedBlocks,
            ...buildRevenueConcentration(cfoData, revConcSubNum),
            ...revChartArr,
            ...buildDirectIncomeAnalysis(cfoData, directIncSubNum),
            ...deptChartArr,
            ...weeklyTrendChartArr,
            ...buildPharmaInsights(cfoData, pharmaSubNum),
            ...buildDirectExpenseBreakdown(cfoData, directExpSubNum),
            ...buildIndirectExpenseBreakdown(cfoData, indirectExpSubNum),
            ...ratioBlock,
            ...(stockSn ? buildStockHealth(cfoData, stockSn) : []),
            ...buildCashPosition(cfoData, liqSn),
            ...(!isConsolidated ? [
                ...buildAgeingTable('Accounts Receivable Ageing', `${liqSn}.2`, cfoData.arAgeing),
                ...arChartArr,
                ...buildAgeingTable('Accounts Payable Ageing', `${liqSn}.3`, cfoData.apAgeing),
                ...apChartArr,
            ] : []),
            ...statutoryBlock,
            ...(actionSn ? buildActionItemsSection(cfoData, actionSn) : []),
            ...footerParagraphs,
        ];

        sections = [
            { properties: portraitPage, children: portraitSection1Children },
            { properties: landscapePage, children: landscapeChildren },
            { properties: portraitPage, children: portraitSection2Children },
        ];
    } else {
        // ── SINGLE-SECTION DOCUMENT (Portrait only) ──
        const children = [
            ...buildTitleSection(cfoData),
            ...buildExecutiveSummary(cfoData),
            ...buildPLComparison(cfoData),
            ...plChartArr,
            ...buildColumnarPL(cfoData),
            ...unitMarginChartArr,
            ...consolidatedBlocks,
            ...buildRevenueConcentration(cfoData, revConcSubNum),
            ...revChartArr,
            ...buildDirectIncomeAnalysis(cfoData, directIncSubNum),
            ...deptChartArr,
            ...weeklyTrendChartArr,
            ...buildPharmaInsights(cfoData, pharmaSubNum),
            ...buildDirectExpenseBreakdown(cfoData, directExpSubNum),
            ...buildIndirectExpenseBreakdown(cfoData, indirectExpSubNum),
            ...ratioBlock,
            ...(stockSn ? buildStockHealth(cfoData, stockSn) : []),
            ...buildCashPosition(cfoData, liqSn),
            ...(!isConsolidated ? [
                ...buildAgeingTable('Accounts Receivable Ageing', `${liqSn}.2`, cfoData.arAgeing),
                ...arChartArr,
                ...buildAgeingTable('Accounts Payable Ageing', `${liqSn}.3`, cfoData.apAgeing),
                ...apChartArr,
            ] : []),
            ...statutoryBlock,
            ...(actionSn ? buildActionItemsSection(cfoData, actionSn) : []),
            ...footerParagraphs,
        ];

        sections = [{ properties: portraitPage, children }];
    }

    const doc = new Document({ sections });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
}

module.exports = { generateDocx };
