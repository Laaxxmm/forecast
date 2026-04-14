'use strict';

/**
 * CFO Performance Review — Word Document Generator
 * Styled to match the reference CFO Review document:
 *   - Cover page: centered, MAGNA HEALTHCARE branding, rating badge
 *   - Heading1 (blue 2E74B5 sz32), Heading2 (blue 2E74B5 sz26)
 *   - Body: Arial, clean tables, "CFO Observation:" + "Suggestion:" pattern
 *   - Header/Footer with company name + page numbers
 *   - Dynamic sections based on entity types present in filtered data
 */

const {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, HeadingLevel, AlignmentType, BorderStyle,
    WidthType, ShadingType, PageOrientation, convertInchesToTwip,
    Header, Footer, PageNumber, PageBreak,
} = require('docx');
const { fmtINR, fmtLakhs, formatDate, formatMonth } = require('./report-generator');

// ── Colour palette (matching reference document) ──
const NAVY      = '1B3A6B';
const TEAL      = '006666';
const BLUE_HD   = '2E74B5';
const GREY_TEXT = '6C7A89';
const GOLD      = 'B8860B';
const RED       = 'CC0000';
const GREEN     = '228B22';
const WHITE     = 'FFFFFF';
const GREY_BG   = 'F2F2F2';
const HDR_BG    = '1B3A6B';

const FONT = 'Arial';

const RATING_COLORS = { Excellent: GREEN, Good: '2E7D32', Fair: GOLD, 'Needs Attention': RED };
const STATUS_COLORS = { Healthy: GREEN, Good: '2E7D32', Fair: GOLD, Attention: GOLD, Critical: RED };

// ── Helpers ──

function fmtCr(num) {
    if (num == null || isNaN(num)) return '0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 10000000) return `${sign}\u20B9${(abs / 10000000).toFixed(2)} Cr`;
    if (abs >= 100000)   return `${sign}\u20B9${fmtLakhs(abs)} L`;
    return `${sign}\u20B9${fmtINR(abs)}`;
}

function shortName(name) {
    return name.replace(/\s*-\s*\(from.*\)$/i, '').replace(/\s*\d{2}-\d{2}\s*:\s*/g, ' ').trim();
}

function pctChg(cur, prev) {
    if (!prev || prev === 0) return null;
    return ((cur - prev) / Math.abs(prev)) * 100;
}
function fmtPct(v) { return v != null ? `${v.toFixed(1)}%` : '-'; }
function fmtPctSigned(v) { return v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '-'; }

// ── Paragraph / Cell factories ──

const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const cellBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
const noBorder = { style: BorderStyle.NONE, size: 0, color: WHITE };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
const cellMargins = { top: 40, bottom: 40, left: 80, right: 80 };

function para(runs, opts = {}) {
    return new Paragraph({
        children: runs,
        alignment: opts.align || AlignmentType.LEFT,
        spacing: { before: opts.before || 0, after: opts.after || 80 },
        ...(opts.bullet ? { bullet: { level: 0 } } : {}),
        ...(opts.pageBreak ? { pageBreakBefore: true } : {}),
    });
}

function run(text, opts = {}) {
    return new TextRun({
        text, font: FONT,
        size: opts.size || 22,
        bold: !!opts.bold,
        italics: !!opts.italics,
        color: opts.color || NAVY,
        ...(opts.break ? { break: opts.break } : {}),
    });
}

function hdrCell(text, width) {
    return new TableCell({
        children: [para([run(text, { color: WHITE, bold: true, size: 18 })], { align: AlignmentType.CENTER })],
        shading: { fill: HDR_BG, type: ShadingType.CLEAR },
        borders: cellBorders, margins: cellMargins,
        width: { size: width, type: WidthType.DXA },
    });
}

function dCell(text, opts = {}) {
    const align = opts.right ? AlignmentType.RIGHT : (opts.center ? AlignmentType.CENTER : AlignmentType.LEFT);
    return new TableCell({
        children: [para([run(String(text ?? ''), { size: opts.size || 18, bold: opts.bold, color: opts.color || NAVY })], { align })],
        shading: opts.bg ? { fill: opts.bg, type: ShadingType.CLEAR } : undefined,
        borders: cellBorders, margins: cellMargins,
        width: { size: opts.width, type: WidthType.DXA },
    });
}

function emptyLine() { return para([], { after: 120 }); }

// A4 content width with 1" margins
const PAGE_W = 11906;
const MARGIN = convertInchesToTwip(1);
const CONTENT_W = PAGE_W - 2 * MARGIN; // ~9026 DXA

// ===================================================================
// COVER PAGE
// ===================================================================

function buildCover(data) {
    const rColor = RATING_COLORS[data.rating] || GREY_TEXT;
    return [
        emptyLine(), emptyLine(), emptyLine(), emptyLine(),
        // Group name
        para([run(data.groupName.toUpperCase(), { size: 52, bold: true, color: NAVY })], { align: AlignmentType.CENTER, after: 40 }),
        // Subtitle
        para([run('CFO Performance Review', { size: 30, color: TEAL })], { align: AlignmentType.CENTER, after: 60 }),
        // Divider
        new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: TEAL, space: 1 } }, spacing: { after: 60 } }),
        // Filter label / city label
        para([run(data.filterLabel || data.cityLabel || '', { size: 42, bold: true, color: NAVY })], { align: AlignmentType.CENTER, after: 40 }),
        // Period
        para([run(`${formatMonth(data.period.from)} ${formatMonth(data.period.from) !== formatMonth(data.period.to) ? '- ' + formatMonth(data.period.to) : ''} | Performance Review`, { size: 26, color: GREY_TEXT })], { align: AlignmentType.CENTER, after: 120 }),
        // Rating
        para([
            run('Overall Rating:    ', { size: 24, color: NAVY }),
            run(`  ${data.rating}  `, { size: 22, bold: true, color: rColor }),
        ], { align: AlignmentType.CENTER, after: 80 }),
        emptyLine(),
        // Adjustment notes
        ...(data.adjustmentNotes && data.adjustmentNotes.trim() ? [
            para([run(`Note: ${data.adjustmentNotes}`, { size: 20, color: GREY_TEXT, italics: true })], { align: AlignmentType.CENTER, after: 60 }),
        ] : []),
        emptyLine(), emptyLine(),
        // Prepared by
        para([run(`Prepared by:  CFO, ${data.groupName}`, { size: 20, color: GREY_TEXT })], { align: AlignmentType.CENTER, after: 40 }),
        para([run(`Date:  ${formatDate(data.generatedAt)}`, { size: 20, color: GREY_TEXT })], { align: AlignmentType.CENTER }),
    ];
}

// ===================================================================
// 1. EXECUTIVE SUMMARY
// ===================================================================

function buildExecSummary(data) {
    const con = data.consolidated;
    const pri = data.priorConsolidated;
    const children = [];

    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run('1. Executive Summary', { size: 32, bold: true, color: BLUE_HD })] }));

    // Narrative paragraphs
    if (data.narrative && data.narrative.length) {
        data.narrative.forEach(n => {
            children.push(para([run(n, { size: 20 })], { after: 60 }));
        });
        children.push(emptyLine());
    }

    return children;
}

// ===================================================================
// 2. FINANCIAL HIGHLIGHTS
// ===================================================================

function buildFinancialHighlights(data) {
    const con = data.consolidated;
    const pri = data.priorConsolidated;
    const children = [];

    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run('2. Financial Highlights', { size: 26, bold: true, color: BLUE_HD })] }));

    const cw = [Math.floor(CONTENT_W * 0.40), Math.floor(CONTENT_W * 0.22), Math.floor(CONTENT_W * 0.22), CONTENT_W - Math.floor(CONTENT_W * 0.40) - Math.floor(CONTENT_W * 0.22) - Math.floor(CONTENT_W * 0.22)];

    const rows = [
        new TableRow({ children: [hdrCell('Particulars', cw[0]), hdrCell(formatMonth(data.period.to), cw[1]), hdrCell(formatMonth(data.priorPeriodLabel || ''), cw[2]), hdrCell('MoM Change', cw[3])] }),
    ];

    const lines = [
        { label: 'Revenue (Sales)', cur: con.revenue, prev: pri?.revenue },
        { label: 'Direct Income', cur: con.directIncome, prev: pri?.directIncome },
        { label: 'Total Operating Income', cur: (con.revenue || 0) + (con.directIncome || 0), prev: pri ? (pri.revenue || 0) + (pri.directIncome || 0) : 0, bold: true },
        { label: 'Purchase / COGS', cur: con.purchase, prev: pri?.purchase },
        { label: 'Direct Expenses', cur: con.directExpenses, prev: pri?.directExpenses },
        { label: 'Gross Profit', cur: con.grossProfit, prev: pri?.grossProfit, bold: true },
        { label: 'Indirect Expenses', cur: con.indirectExpenses, prev: pri?.indirectExpenses },
        { label: 'Indirect Income', cur: con.indirectIncome, prev: pri?.indirectIncome },
        { label: 'Net Profit', cur: con.netProfit, prev: pri?.netProfit, bold: true },
        { label: 'Cash & Bank Balance', cur: con.cashBankBalance, prev: pri?.cashBankBalance },
    ];

    lines.forEach((l, i) => {
        const chg = pctChg(l.cur, l.prev);
        const bg = i % 2 === 0 ? undefined : GREY_BG;
        rows.push(new TableRow({ children: [
            dCell(l.label, { bold: l.bold, width: cw[0], bg }),
            dCell(fmtCr(l.cur), { right: true, bold: l.bold, width: cw[1], bg }),
            dCell(fmtCr(l.prev), { right: true, width: cw[2], bg }),
            dCell(chg != null ? fmtPctSigned(chg) : '-', { right: true, width: cw[3], bg, color: chg != null ? (chg >= 0 ? GREEN : RED) : GREY_TEXT }),
        ] }));
    });

    children.push(new Table({
        rows,
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: cw,
    }));
    children.push(emptyLine());
    return children;
}

// ===================================================================
// 3. SUB-CLINIC PERFORMANCE
// ===================================================================

function buildSubClinicPerformance(data) {
    const children = [];
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run('3. Sub-Clinic Performance', { size: 26, bold: true, color: BLUE_HD })] }));

    const cw = [Math.floor(CONTENT_W * 0.26), Math.floor(CONTENT_W * 0.14), Math.floor(CONTENT_W * 0.14), Math.floor(CONTENT_W * 0.14), Math.floor(CONTENT_W * 0.14), CONTENT_W - Math.floor(CONTENT_W * 0.26) - 4 * Math.floor(CONTENT_W * 0.14)];

    const rows = [
        new TableRow({ children: [
            hdrCell('Clinic / Segment', cw[0]), hdrCell('GP', cw[1]), hdrCell('Net Profit', cw[2]),
            hdrCell('GP%', cw[3]), hdrCell('NP%', cw[4]), hdrCell('Status', cw[5]),
        ] }),
    ];

    data.units.forEach((u, i) => {
        const bg = i % 2 === 0 ? undefined : GREY_BG;
        const sColor = STATUS_COLORS[u.status] || GREY_TEXT;
        rows.push(new TableRow({ children: [
            dCell(shortName(u.name), { bold: true, width: cw[0], bg }),
            dCell(fmtCr(u.grossProfit), { right: true, width: cw[1], bg, color: u.grossProfit < 0 ? RED : NAVY }),
            dCell(fmtCr(u.netProfit), { right: true, width: cw[2], bg, color: u.netProfit < 0 ? RED : NAVY }),
            dCell(fmtPct(u.gpPct), { right: true, width: cw[3], bg }),
            dCell(fmtPct(u.npPct), { right: true, width: cw[4], bg, color: u.netProfit < 0 ? RED : NAVY }),
            dCell(u.status, { center: true, bold: true, color: sColor, width: cw[5], bg }),
        ] }));
    });

    // Total row
    const tGP = data.consolidated.grossProfit;
    const tNP = data.consolidated.netProfit;
    const tRev = (data.consolidated.revenue || 0) + (data.consolidated.directIncome || 0);
    rows.push(new TableRow({ children: [
        dCell('TOTAL', { bold: true, width: cw[0], bg: GREY_BG }),
        dCell(fmtCr(tGP), { right: true, bold: true, width: cw[1], bg: GREY_BG }),
        dCell(fmtCr(tNP), { right: true, bold: true, width: cw[2], bg: GREY_BG }),
        dCell(fmtPct(tRev ? tGP / tRev * 100 : 0), { right: true, bold: true, width: cw[3], bg: GREY_BG }),
        dCell(fmtPct(tRev ? tNP / tRev * 100 : 0), { right: true, bold: true, width: cw[4], bg: GREY_BG }),
        dCell('', { center: true, width: cw[5], bg: GREY_BG }),
    ] }));

    children.push(new Table({ rows, width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: cw }));
    children.push(emptyLine());
    return children;
}

// ===================================================================
// CLINIC INSIGHTS (dynamic section — only if clinics exist)
// ===================================================================

function buildClinicInsights(data, sn) {
    const clinics = data.units.filter(u => (u.entityType || '').toLowerCase() === 'clinic');
    if (!clinics.length) return [];

    const children = [];
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: true, children: [run(`Clinic (Direct Income) Insights`, { size: 26, bold: true, color: BLUE_HD })] }));

    const totalClinicRev = clinics.reduce((s, c) => s + (c.revenue || 0) + (c.directIncome || 0), 0);
    const totalClinicGP  = clinics.reduce((s, c) => s + (c.grossProfit || 0), 0);
    const clinicGPPct    = totalClinicRev ? (totalClinicGP / totalClinicRev * 100) : 0;
    const pri = data.priorConsolidated;
    const priClinicInc = pri ? (pri.directIncome || 0) : 0;
    const momChg = pctChg(totalClinicRev, priClinicInc);

    // Summary table (key-value style like reference)
    const skw = [Math.floor(CONTENT_W * 0.55), CONTENT_W - Math.floor(CONTENT_W * 0.55)];
    const summaryRows = [
        new TableRow({ children: [
            dCell(`Direct Income \u2014 ${formatMonth(data.period.to)}`, { bold: true, width: skw[0] }),
            dCell(fmtCr(totalClinicRev), { right: true, width: skw[1] }),
        ] }),
        new TableRow({ children: [
            dCell('Clinic GP Margin', { bold: true, width: skw[0], bg: GREY_BG }),
            dCell(fmtPct(clinicGPPct), { right: true, width: skw[1], bg: GREY_BG }),
        ] }),
    ];
    if (momChg != null) {
        summaryRows.push(new TableRow({ children: [
            dCell('Month-on-Month Change', { bold: true, width: skw[0] }),
            dCell(fmtPctSigned(momChg), { right: true, width: skw[1], color: momChg >= 0 ? GREEN : RED }),
        ] }));
    }
    children.push(new Table({ rows: summaryRows, width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: skw }));
    children.push(emptyLine());

    // CFO Observation
    const topClinic = clinics.reduce((a, b) => ((a.revenue + (a.directIncome||0)) > (b.revenue + (b.directIncome||0)) ? a : b), clinics[0]);
    const topShare = totalClinicRev ? ((topClinic.revenue + (topClinic.directIncome||0)) / totalClinicRev * 100) : 0;

    children.push(para([
        run('CFO Observation: ', { bold: true, size: 20 }),
    ]));
    children.push(para([
        run(`${shortName(topClinic.name)} is the largest clinic income contributor at ${fmtCr(topClinic.revenue + (topClinic.directIncome||0))} (${topShare.toFixed(0)}% of all clinic income).`, { size: 20 }),
    ], { after: 60 }));

    // High expense warning
    const highExp = clinics.filter(c => {
        const inc = (c.revenue || 0) + (c.directIncome || 0);
        return inc > 0 && ((c.directExpenses + c.purchase) / inc * 100) > 70;
    });
    if (highExp.length) {
        children.push(para([
            run('Suggestion: ', { bold: true, size: 20, color: NAVY }),
            run(`${highExp.map(c => shortName(c.name)).join(', ')} direct expense ratio exceeds 70% of income. Review and rationalize costs.`, { size: 20 }),
        ], { after: 60 }));
    }

    // Sub-clinic breakdown
    children.push(emptyLine());
    children.push(para([run('Sub-Clinic Income Breakdown:', { bold: true, size: 20 })], { after: 60 }));

    const bkw = [Math.floor(CONTENT_W * 0.50), CONTENT_W - Math.floor(CONTENT_W * 0.50)];
    const bkRows = clinics.sort((a, b) => ((b.revenue + (b.directIncome||0)) - (a.revenue + (a.directIncome||0)))).map((c, i) => {
        const inc = (c.revenue || 0) + (c.directIncome || 0);
        const share = totalClinicRev ? (inc / totalClinicRev * 100) : 0;
        return new TableRow({ children: [
            dCell(shortName(c.name), { bold: true, width: bkw[0], bg: i % 2 ? GREY_BG : undefined }),
            dCell(`${fmtCr(inc)}  (${share.toFixed(0)}% of network)`, { right: true, width: bkw[1], bg: i % 2 ? GREY_BG : undefined }),
        ] });
    });
    children.push(new Table({ rows: bkRows, width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: bkw }));
    children.push(emptyLine());

    return children;
}

// ===================================================================
// PHARMACY INSIGHTS (dynamic)
// ===================================================================

function buildPharmaInsights(data, sn) {
    const pharmas = data.units.filter(u => (u.entityType || '').toLowerCase() === 'pharma');
    if (!pharmas.length) return [];

    const children = [];
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: true, children: [run(`Pharmacy Sales Insights`, { size: 26, bold: true, color: BLUE_HD })] }));

    const totalRev   = pharmas.reduce((s, p) => s + (p.revenue || 0), 0);
    const totalCOGS  = pharmas.reduce((s, p) => s + (p.purchase || 0), 0);
    const totalGP    = pharmas.reduce((s, p) => s + (p.grossProfit || 0), 0);
    const gpPct      = totalRev ? (totalGP / totalRev * 100) : 0;
    const cogsPct    = totalRev ? (totalCOGS / totalRev * 100) : 0;

    // Summary table
    const skw = [Math.floor(CONTENT_W * 0.55), CONTENT_W - Math.floor(CONTENT_W * 0.55)];
    const summaryRows = [
        new TableRow({ children: [dCell(`Pharmacy Revenue \u2014 ${formatMonth(data.period.to)}`, { bold: true, width: skw[0] }), dCell(fmtCr(totalRev), { right: true, width: skw[1] })] }),
        new TableRow({ children: [dCell('Purchase / COGS', { bold: true, width: skw[0], bg: GREY_BG }), dCell(fmtCr(totalCOGS), { right: true, width: skw[1], bg: GREY_BG })] }),
        new TableRow({ children: [dCell('Gross Profit', { bold: true, width: skw[0] }), dCell(fmtCr(totalGP), { right: true, width: skw[1], color: totalGP < 0 ? RED : NAVY })] }),
        new TableRow({ children: [dCell('GP Margin', { bold: true, width: skw[0], bg: GREY_BG }), dCell(fmtPct(gpPct), { right: true, width: skw[1], bg: GREY_BG, color: gpPct < 15 ? RED : NAVY })] }),
        new TableRow({ children: [dCell('COGS-to-Revenue Ratio', { bold: true, width: skw[0] }), dCell(fmtPct(cogsPct), { right: true, width: skw[1], color: cogsPct > 90 ? RED : NAVY })] }),
    ];

    // Per-pharmacy rows
    pharmas.forEach((p, i) => {
        summaryRows.push(new TableRow({ children: [
            dCell(`  ${shortName(p.name)}`, { width: skw[0], bg: i % 2 ? GREY_BG : undefined }),
            dCell(`${fmtCr(p.revenue)} (NP: ${fmtCr(p.netProfit)})`, { right: true, width: skw[1], bg: i % 2 ? GREY_BG : undefined, color: p.netProfit < 0 ? RED : NAVY }),
        ] }));
    });

    children.push(new Table({ rows: summaryRows, width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: skw }));
    children.push(emptyLine());

    // CFO Observation
    children.push(para([run('CFO Observation: ', { bold: true, size: 20 }), run(`Pharmacy GP margin is ${gpPct.toFixed(1)}%. ${cogsPct > 90 ? 'The COGS-to-revenue ratio is critically thin.' : ''} ${pharmas.filter(p => p.netProfit < 0).length ? pharmas.filter(p => p.netProfit < 0).map(p => shortName(p.name)).join(', ') + ' is loss-making.' : 'All pharmacies are profitable.'}`, { size: 20 })]));

    if (gpPct < 15) {
        children.push(para([run('Suggestion: ', { bold: true, size: 20 }), run(`The pharmacy margin needs to reach at least 15% to be sustainable. Review purchasing channels and negotiate better margins with distributors.`, { size: 20 })]));
    }
    children.push(emptyLine());

    return children;
}

// ===================================================================
// STOCK HEALTH (dynamic)
// ===================================================================

function buildStockHealth(data, sn) {
    if (!data.stockByUnit || !data.stockByUnit.length) return [];

    const children = [];
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run(`Stock Health & Inventory Insights`, { size: 26, bold: true, color: BLUE_HD })] }));

    const totalStock = data.stockByUnit.reduce((s, u) => s + (u.closingValue || 0), 0);

    const skw = [Math.floor(CONTENT_W * 0.55), CONTENT_W - Math.floor(CONTENT_W * 0.55)];
    const rows = [
        new TableRow({ children: [dCell('Closing Stock', { bold: true, width: skw[0] }), dCell(fmtCr(totalStock), { right: true, width: skw[1] })] }),
    ];

    data.stockByUnit.forEach((u, i) => {
        const pct = totalStock ? (u.closingValue / totalStock * 100) : 0;
        rows.push(new TableRow({ children: [
            dCell(`  ${shortName(u.companyName)}`, { width: skw[0], bg: i % 2 ? GREY_BG : undefined }),
            dCell(`${fmtCr(u.closingValue)} (${pct.toFixed(0)}%)`, { right: true, width: skw[1], bg: i % 2 ? GREY_BG : undefined }),
        ] }));
    });

    children.push(new Table({ rows, width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: skw }));
    children.push(emptyLine());

    // CFO Observation
    const topStock = data.stockByUnit[0];
    const topPct = totalStock ? (topStock.closingValue / totalStock * 100) : 0;
    children.push(para([
        run('CFO Observation: ', { bold: true, size: 20 }),
        run(`${shortName(topStock.companyName)} holds ${topPct.toFixed(0)}% of network stock. `, { size: 20 }),
    ]));
    children.push(para([
        run('Suggestion: ', { bold: true, size: 20 }),
        run(`Conduct a sub-clinic stock audit. Introduce monthly stock-day reporting from next month.`, { size: 20 }),
    ]));
    children.push(emptyLine());

    return children;
}

// ===================================================================
// CFO ASSESSMENT & DIRECTIVES
// ===================================================================

function buildCFOAssessment(data, sn) {
    const children = [];
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: true, children: [run(`${sn}. CFO Assessment & Directives`, { size: 26, bold: true, color: BLUE_HD })] }));

    // Critical notes
    if (data.adjustmentNotes && data.adjustmentNotes.trim()) {
        children.push(para([
            run('Critical \u2014 ', { bold: true, size: 20, color: RED }),
            run(data.adjustmentNotes, { size: 20 }),
        ], { after: 100 }));
    }

    // Priority Actions
    if (data.actionItems && data.actionItems.length) {
        children.push(para([run('Priority Actions:', { bold: true, size: 20 })], { after: 60 }));
        data.actionItems.forEach((item, i) => {
            children.push(para([run(`${i + 1}. ${item}`, { size: 20 })], { after: 60 }));
        });
        children.push(emptyLine());
    }

    // Overall Rating
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run(`${sn + 1}. Overall Rating: ${data.rating}`, { size: 26, bold: true, color: BLUE_HD })] }));

    // Commentary
    if (data.commentary && data.commentary.trim()) {
        data.commentary.split('\n').filter(l => l.trim()).forEach(line => {
            children.push(para([run(line.trim(), { size: 20 })], { after: 60 }));
        });
    }

    // Allocation note
    if (data.allocationsApplied) {
        children.push(emptyLine());
        children.push(para([run('Note: Figures in this report are adjusted for allocation rules defined in TallyVision Settings.', { size: 18, italics: true, color: GREY_TEXT })]));
    }

    return children;
}

// ===================================================================
// MAIN EXPORT
// ===================================================================

async function generateCFOReviewDocx(data, res, filename) {
    const hasClinics = data.units.some(u => (u.entityType || '').toLowerCase() === 'clinic');
    const hasPharmas = data.units.some(u => (u.entityType || '').toLowerCase() === 'pharma');
    const hasStock   = data.stockByUnit && data.stockByUnit.length > 0;

    // Dynamic section numbering for CFO Assessment
    let sn = 4;
    if (hasClinics) sn++;
    if (hasPharmas) sn++;
    if (hasStock) sn++;
    const cfoSn = sn;

    // Prior period label
    data.priorPeriodLabel = data.priorConsolidated?.period?.from || '';

    const content = [
        ...buildCover(data),
        new Paragraph({ children: [new PageBreak()] }),
        ...buildExecSummary(data),
        ...buildFinancialHighlights(data),
        ...buildSubClinicPerformance(data),
        ...(hasClinics ? buildClinicInsights(data) : []),
        ...(hasPharmas ? buildPharmaInsights(data) : []),
        ...(hasStock   ? buildStockHealth(data) : []),
        ...buildCFOAssessment(data, cfoSn),
        // Footer divider
        new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: TEAL, space: 1 } }, spacing: { before: 200, after: 80 } }),
        para([run('Generated by TallyVision \u00B7 CFO Performance Review', { size: 16, color: GREY_TEXT, italics: true })], { align: AlignmentType.CENTER }),
    ];

    const doc = new Document({
        styles: {
            default: { document: { run: { font: FONT, size: 22 } } },
            paragraphStyles: [
                { id: 'Heading1', name: 'heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
                    run: { size: 32, bold: true, font: FONT, color: BLUE_HD },
                    paragraph: { spacing: { before: 240, after: 120 } } },
                { id: 'Heading2', name: 'heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
                    run: { size: 26, bold: true, font: FONT, color: BLUE_HD },
                    paragraph: { spacing: { before: 200, after: 100 } } },
            ],
        },
        sections: [{
            properties: {
                page: {
                    size: { orientation: PageOrientation.PORTRAIT, width: PAGE_W, height: 16838 },
                    margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
                },
            },
            headers: {
                default: new Header({
                    children: [para([
                        run(`${data.groupName}  |  CFO Performance Review`, { size: 16, color: GREY_TEXT }),
                        run(`     ${data.filterLabel || ''}  \u2014  ${formatMonth(data.period.to)}`, { size: 16, color: GREY_TEXT }),
                    ])],
                }),
            },
            footers: {
                default: new Footer({
                    children: [
                        para([
                            run('Confidential \u2014 For Internal Use Only', { size: 14, color: GREY_TEXT }),
                        ], { align: AlignmentType.LEFT }),
                        para([
                            run('Page ', { size: 14, color: GREY_TEXT }),
                            new TextRun({ children: [PageNumber.CURRENT], size: 14, color: GREY_TEXT, font: FONT }),
                            run('   Prepared by TallyVision', { size: 14, color: GREY_TEXT }),
                        ], { align: AlignmentType.CENTER }),
                    ],
                }),
            },
            children: content,
        }],
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(buffer);
}

module.exports = { generateCFOReviewDocx };
