/**
 * CFO Performance Review — Word Document Generator
 * Uses the 'docx' npm package to build a per-unit performance review .docx report.
 */

const {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, HeadingLevel, AlignmentType, BorderStyle,
    WidthType, ShadingType, convertInchesToTwip,
} = require('docx');
const { fmtINR, fmtLakhs } = require('./report-generator');

// ── Colour palette ──
const NAVY   = '1e293b';
const WHITE  = 'FFFFFF';
const GREY   = 'f1f5f9';
const GREEN  = '16a34a';
const RED    = 'dc2626';
const AMBER  = 'd97706';
const BORDER = 'cbd5e1';

const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: BORDER };
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
                color: opts.color || undefined,
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

function statusColor(status) {
    if (status === 'Healthy') return GREEN;
    if (status === 'Attention') return AMBER;
    return RED;
}

/**
 * Generate CFO Performance Review Word document
 * @param {Object} data - Output from buildCFOReviewData()
 * @param {Object} res  - Express response object (streamed)
 * @param {string} filename - Download filename
 */
async function generateCFOReviewDocx(data, res, filename) {
    const { groupName, cityLabel, filterLabel, period, rating, commentary, narrative,
            actionItems, units, consolidated, priorConsolidated, stockByUnit, adjustmentNotes } = data;

    const periodLabel = `${formatMonth(period.from)} to ${formatMonth(period.to)}`;
    const sections = [];

    // ── Title Page ──
    sections.push(
        heading(`CFO Performance Review`),
        bodyText(`${groupName}${filterLabel ? ` — ${filterLabel}` : ''}`, { bold: true }),
        bodyText(`Period: ${periodLabel}`),
        bodyText(`Generated: ${new Date().toLocaleDateString('en-IN')}`),
        emptyLine(),
    );

    // ── Overall Rating ──
    const ratingColor = rating === 'Excellent' ? GREEN : rating === 'Good' ? GREEN :
                        rating === 'Fair' ? AMBER : RED;
    sections.push(
        subheading('Overall Performance Rating'),
        new Paragraph({
            children: [
                new TextRun({ text: `Rating: `, size: 22, font: 'Calibri', bold: true }),
                new TextRun({ text: rating, size: 22, font: 'Calibri', bold: true, color: ratingColor }),
            ],
            spacing: { after: 120 },
        }),
        emptyLine(),
    );

    // ── Executive Summary ──
    sections.push(subheading('Executive Summary'));
    if (narrative && narrative.length) {
        narrative.forEach(n => sections.push(bulletPoint(n)));
    }
    sections.push(emptyLine());

    // ── Commentary ──
    if (commentary) {
        sections.push(subheading('Commentary'));
        commentary.split('\n').forEach(line => {
            if (line.trim()) sections.push(bodyText(line));
        });
        sections.push(emptyLine());
    }

    // ── Adjustment Notes ──
    if (adjustmentNotes) {
        sections.push(subheading('Adjustment Notes'));
        adjustmentNotes.split('\n').forEach(line => {
            if (line.trim()) sections.push(bodyText(line));
        });
        sections.push(emptyLine());
    }

    // ── Consolidated KPIs ──
    sections.push(subheading('Consolidated Financials'));

    const consRows = [
        ['Revenue (Sales)', fmtINR(consolidated.revenue || 0)],
        ['Direct Income', fmtINR(consolidated.directIncome || 0)],
        ['Purchase / COGS', fmtINR(consolidated.purchase || 0)],
        ['Gross Profit', fmtINR(consolidated.grossProfit || 0)],
        ['Indirect Expenses', fmtINR(consolidated.indirectExpenses || 0)],
        ['Indirect Income', fmtINR(consolidated.indirectIncome || 0)],
        ['Net Profit', fmtINR(consolidated.netProfit || 0)],
        ['Cash & Bank Balance', fmtINR(consolidated.cashBankBalance || 0)],
    ];

    const consTable = new Table({
        rows: [
            new TableRow({
                children: [headerCell('Particulars', 50), headerCell('Amount', 50)],
                tableHeader: true,
            }),
            ...consRows.map((row, i) => new TableRow({
                children: [
                    dataCell(row[0], { bold: row[0].includes('Profit'), shaded: i % 2 === 0 }),
                    dataCell(row[1], { right: true, bold: row[0].includes('Profit'), shaded: i % 2 === 0 }),
                ],
            })),
        ],
        width: { size: 100, type: WidthType.PERCENTAGE },
    });
    sections.push(consTable, emptyLine());

    // ── Per-Unit Performance Table ──
    if (units && units.length > 1) {
        sections.push(subheading('Per-Unit Performance'));

        const unitTable = new Table({
            rows: [
                new TableRow({
                    children: [
                        headerCell('Unit', 25),
                        headerCell('Revenue', 12),
                        headerCell('Gross Profit', 12),
                        headerCell('GP %', 8),
                        headerCell('Net Profit', 12),
                        headerCell('NP %', 8),
                        headerCell('Cash & Bank', 12),
                        headerCell('Status', 11),
                    ],
                    tableHeader: true,
                }),
                ...units.map((u, i) => new TableRow({
                    children: [
                        dataCell(u.name, { shaded: i % 2 === 0 }),
                        currCell(u.revenue, { shaded: i % 2 === 0 }),
                        currCell(u.grossProfit, { shaded: i % 2 === 0 }),
                        pctCell(u.gpPct, { shaded: i % 2 === 0 }),
                        currCell(u.netProfit, { shaded: i % 2 === 0, color: u.netProfit < 0 ? RED : undefined }),
                        pctCell(u.npPct, { shaded: i % 2 === 0 }),
                        currCell(u.cashBankBalance, { shaded: i % 2 === 0 }),
                        dataCell(u.status, { center: true, shaded: i % 2 === 0, color: statusColor(u.status), bold: true }),
                    ],
                })),
            ],
            width: { size: 100, type: WidthType.PERCENTAGE },
        });
        sections.push(unitTable, emptyLine());
    }

    // ── Stock Summary ──
    if (stockByUnit && stockByUnit.length) {
        sections.push(subheading('Stock Summary (Closing Values)'));
        const stockTable = new Table({
            rows: [
                new TableRow({
                    children: [headerCell('Unit', 60), headerCell('Closing Stock Value', 40)],
                    tableHeader: true,
                }),
                ...stockByUnit.map((s, i) => new TableRow({
                    children: [
                        dataCell(s.companyName, { shaded: i % 2 === 0 }),
                        currCell(s.closingValue, { shaded: i % 2 === 0 }),
                    ],
                })),
            ],
            width: { size: 100, type: WidthType.PERCENTAGE },
        });
        sections.push(stockTable, emptyLine());
    }

    // ── Action Items ──
    if (actionItems && actionItems.length) {
        sections.push(subheading('Action Items'));
        actionItems.forEach(item => sections.push(bulletPoint(item)));
        sections.push(emptyLine());
    }

    // ── Build Document ──
    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    margin: {
                        top: convertInchesToTwip(0.8),
                        bottom: convertInchesToTwip(0.8),
                        left: convertInchesToTwip(0.8),
                        right: convertInchesToTwip(0.8),
                    },
                },
            },
            children: sections,
        }],
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
}

function formatMonth(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

module.exports = { generateCFOReviewDocx };
