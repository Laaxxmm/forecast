'use strict';

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

// ===== HELPERS =====

/** Format number in Indian grouping: 12,34,567.00 */
function fmtINR(num) {
    if (num === null || num === undefined || isNaN(num)) return '0.00';
    const sign = num < 0 ? '-' : '';
    const abs = Math.abs(num).toFixed(2);
    const [int, dec] = abs.split('.');
    if (int.length <= 3) return sign + int + '.' + dec;
    const last3 = int.slice(-3);
    const rest = int.slice(0, -3);
    const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return sign + (grouped ? grouped + ',' : '') + last3 + '.' + dec;
}

/** Compact format for PDF: value in Lakhs with Indian grouping (2 decimals) */
function fmtLakhs(num) {
    if (num === null || num === undefined || isNaN(num)) return '0.00';
    const val = num / 100000;
    const sign = val < 0 ? '-' : '';
    const abs = Math.abs(val).toFixed(2);
    const [int, dec] = abs.split('.');
    if (int.length <= 3) return sign + int + '.' + dec;
    const last3 = int.slice(-3);
    const rest = int.slice(0, -3);
    const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return sign + (grouped ? grouped + ',' : '') + last3 + '.' + dec;
}

/** Convert '2025-04-01' to 'Apr 2025' */
function formatMonth(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
}

/** Convert '2025-04-01' to '01-Apr-2025' */
function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ===== PDF GENERATION =====

const A4_W = 595.28; // A4 portrait width
const A4_H = 841.89; // A4 portrait height
const MARGIN = 40;

/** Create a page-layout context based on orientation */
function makeLayout(landscape) {
    const PAGE_W = landscape ? A4_H : A4_W;
    const PAGE_H = landscape ? A4_W : A4_H;
    return {
        PAGE_W,
        PAGE_H,
        CONTENT_W: PAGE_W - MARGIN * 2,
        FOOTER_Y: PAGE_H - 30,
        landscape,
    };
}

function drawPageFooter(doc, pageNum, lay) {
    const savedY = doc.y;
    const savedX = doc.x;
    doc.save();
    doc.fontSize(7).font('Helvetica').fillColor('#94a3b8');
    doc.text('TallyVision MIS Report', MARGIN, lay.FOOTER_Y, { width: lay.CONTENT_W / 2, align: 'left', lineBreak: false });
    doc.text(`Page ${pageNum}`, lay.PAGE_W / 2, lay.FOOTER_Y, { width: lay.CONTENT_W / 2, align: 'right', lineBreak: false });
    doc.restore();
    doc.x = savedX;
    doc.y = savedY;
}

function checkPageBreak(doc, needed, pageCount, lay) {
    if (doc.y + needed > lay.FOOTER_Y - 15) {
        drawPageFooter(doc, pageCount.n, lay);
        doc.addPage();
        pageCount.n++;
        doc.y = MARGIN;
    }
}

function drawSectionTitle(doc, title, pageCount, lay) {
    checkPageBreak(doc, 40, pageCount, lay);
    doc.moveDown(0.6);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(title, MARGIN);
    const lineY = doc.y + 1;
    doc.moveTo(MARGIN, lineY).lineTo(MARGIN + lay.CONTENT_W, lineY)
        .strokeColor('#cbd5e1').lineWidth(0.5).stroke();
    doc.y = lineY + 5;
}

function drawTable(doc, headers, rows, colWidths, pageCount, lay) {
    const CW = lay.CONTENT_W;
    const rowH = 16;
    const startX = MARGIN;

    // Header row
    checkPageBreak(doc, rowH * 2, pageCount, lay);
    let x = startX;
    const headerY = doc.y;
    doc.save();
    doc.rect(startX, headerY - 1, CW, rowH).fill('#f1f5f9');
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#475569');
    x = startX;
    headers.forEach((h, i) => {
        const align = i === 0 ? 'left' : 'right';
        const pad = i === 0 ? 4 : 0;
        doc.text(h, x + pad, headerY + 3, { width: colWidths[i] - pad - 4, align, lineBreak: false });
        x += colWidths[i];
    });
    doc.restore();
    doc.x = MARGIN;
    doc.y = headerY + rowH;

    // Data rows
    rows.forEach((row, ri) => {
        checkPageBreak(doc, rowH, pageCount, lay);
        const y = doc.y;

        doc.save();
        if (ri % 2 === 1) {
            doc.rect(startX, y - 1, CW, rowH).fill('#f8fafc');
        }

        doc.fontSize(7.5).font('Helvetica').fillColor('#334155');
        x = startX;
        row.forEach((cell, ci) => {
            const align = ci === 0 ? 'left' : 'right';
            const pad = ci === 0 ? 4 : 0;
            doc.text(String(cell), x + pad, y + 3, { width: colWidths[ci] - pad - 4, align, lineBreak: false });
            x += colWidths[ci];
        });
        doc.restore();
        doc.x = MARGIN;
        doc.y = y + rowH;
    });
}

/**
 * Draw a columnar Profit & Loss statement table in the PDF.
 * plStatement = { columnar, level1?, level2?, columns: [{name, data}], lines }
 *   level1 (cities):    [{ label: 'Bangalore', span: 4 }, ...]
 *   level2 (locations): [{ label: 'HSR', span: 2 }, ...]
 *   columns (streams):  [{ name: 'Clinic', data }, { name: 'Pharma', data }, ...]
 */
function drawPLStatement(doc, plStatement, pageCount, lay) {
    const { columns, lines, columnar, level1, level2 } = plStatement;
    const CW = lay.CONTENT_W;
    const rowH = 16;
    const startX = MARGIN;

    // Column widths — dynamic based on column count
    const numDataCols = columns.length;
    const labelW = columnar ? Math.min(130, CW * 0.18) : CW * 0.5;
    const dataColW = (CW - labelW) / numDataCols;

    // Use lakhs format when many columns to avoid number wrapping
    const useLakhs = numDataCols > 8;
    const fmt = useLakhs ? fmtLakhs : fmtINR;

    // Show "Amounts in ₹ Lakhs" note
    if (useLakhs) {
        doc.save();
        doc.fontSize(7).font('Helvetica-Oblique').fillColor('#64748b')
            .text('Amounts in \u20B9 Lakhs', startX, doc.y, { width: CW, align: 'right', lineBreak: false });
        doc.restore();
        doc.y += 12;
    }

    let x;
    const headerRows = 1 + (level1 ? 1 : 0) + (level2 ? 1 : 0);

    if (level1 || level2) {
        // ── Multi-level header ──
        checkPageBreak(doc, rowH * (headerRows + 1), pageCount, lay);

        // Helper to draw one header band
        function drawHeaderBand(y, bgColor, fontSize, fontColor, items, isLabel) {
            doc.save();
            doc.rect(startX, y - 1, CW, rowH).fill(bgColor);
            doc.fontSize(fontSize).font('Helvetica-Bold').fillColor(fontColor);
            if (isLabel) {
                doc.text('Particulars', startX + 4, y + 3, { width: labelW - 8, align: 'left', lineBreak: false });
            }
            x = startX + labelW;
            for (const item of items) {
                const w = dataColW * item.span;
                if (item.label) {
                    doc.text(item.label, x, y + 3, { width: w - 4, align: 'center', lineBreak: false });
                }
                // Vertical separator
                if (x > startX + labelW) {
                    doc.moveTo(x, y - 1).lineTo(x, y + rowH - 1)
                        .strokeColor('#475569').lineWidth(0.3).stroke();
                }
                x += w;
            }
            doc.restore();
        }

        let curY = doc.y;

        // Dynamic header font sizes based on column count
        const hdrFont1 = numDataCols > 10 ? 6.5 : 7.5;
        const hdrFont2 = numDataCols > 10 ? 6 : 7;
        const hdrFont3 = numDataCols > 10 ? 5.5 : 6.5;

        // Level 1: Cities
        if (level1) {
            drawHeaderBand(curY, '#0f172a', hdrFont1, '#ffffff', level1, true);
            curY += rowH;
        }

        // Level 2: Locations
        if (level2) {
            drawHeaderBand(curY, '#1e293b', hdrFont2, '#cbd5e1', level2, !level1);
            curY += rowH;
        }

        // Bottom row: Stream types (column names)
        doc.save();
        doc.rect(startX, curY - 1, CW, rowH).fill('#334155');
        doc.fontSize(hdrFont3).font('Helvetica-Bold').fillColor('#e2e8f0');
        if (!level1 && !level2) {
            doc.text('Particulars', startX + 4, curY + 3, { width: labelW - 8, align: 'left', lineBreak: false });
        }
        x = startX + labelW;
        columns.forEach((col) => {
            doc.text(col.name, x, curY + 3, { width: dataColW - 4, align: 'right', lineBreak: false });
            x += dataColW;
        });
        doc.restore();
        curY += rowH;

        doc.x = MARGIN;
        doc.y = curY;

    } else {
        // ── Single-level header ──
        const headers = ['Particulars', ...columns.map(c => c.name)];
        const colWidths = [labelW, ...columns.map(() => dataColW)];

        checkPageBreak(doc, rowH * 2, pageCount, lay);
        const headerY = doc.y;
        doc.save();
        doc.rect(startX, headerY - 1, CW, rowH).fill('#1e293b');
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff');
        x = startX;
        headers.forEach((h, i) => {
            const align = i === 0 ? 'left' : 'right';
            const pad = i === 0 ? 6 : 0;
            doc.text(h, x + pad, headerY + 3, { width: colWidths[i] - pad - 6, align, lineBreak: false });
            x += colWidths[i];
        });
        doc.restore();
        doc.x = MARGIN;
        doc.y = headerY + rowH;
    }

    // ── Data rows (shared for both header styles) ──
    lines.forEach((line) => {
        checkPageBreak(doc, rowH + 4, pageCount, lay);
        const y = doc.y;

        doc.save();

        // Top separator line for GP/NP rows
        if (line.line === 'top' || line.line === 'both') {
            doc.moveTo(startX, y - 1).lineTo(startX + CW, y - 1)
                .strokeColor('#94a3b8').lineWidth(0.75).stroke();
        }

        // Background for bold rows
        if (line.bold) {
            doc.rect(startX, y - 1, CW, rowH).fill('#f1f5f9');
        }

        // Label — slightly smaller font when many columns
        const fontName = line.bold ? 'Helvetica-Bold' : 'Helvetica';
        const baseFontSize = numDataCols > 10 ? 6.5 : numDataCols > 6 ? 7 : 7.5;
        const fontSize = line.bold ? baseFontSize + 0.5 : baseFontSize;
        doc.fontSize(fontSize).font(fontName).fillColor('#1e293b');
        doc.text(line.label, startX + 4, y + 3, { width: labelW - 8, align: 'left', lineBreak: false });

        // Data values
        x = startX + labelW;
        columns.forEach((col) => {
            const val = col.data[line.key] || 0;
            doc.text(fmt(val), x, y + 3, { width: dataColW - 4, align: 'right', lineBreak: false });
            x += dataColW;
        });

        doc.restore();

        // Bottom separator line for NP row
        if (line.line === 'both') {
            const bottomY = y + rowH - 1;
            doc.save();
            doc.moveTo(startX, bottomY).lineTo(startX + CW, bottomY)
                .strokeColor('#1e293b').lineWidth(1).stroke();
            doc.moveTo(startX, bottomY + 2).lineTo(startX + CW, bottomY + 2)
                .strokeColor('#1e293b').lineWidth(0.5).stroke();
            doc.restore();
        }

        doc.x = MARGIN;
        doc.y = y + rowH;
    });
}

function generatePDF(reportData, res, filename) {
    // Decide orientation: landscape when columnar P&L has > 6 data columns
    const pl = reportData.plStatement;
    const useLandscape = pl && pl.columnar && pl.columns.length > 6;
    const lay = makeLayout(useLandscape);

    const doc = new PDFDocument({
        margin: MARGIN,
        size: 'A4',
        layout: useLandscape ? 'landscape' : 'portrait',
        bufferPages: true,
    });
    const pageCount = { n: 1 };

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    // ===== TITLE SECTION =====
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f172a')
        .text(reportData.title, { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(9).font('Helvetica').fillColor('#64748b')
        .text(reportData.filterLabel, { align: 'center' });
    doc.fontSize(8).text(
        `Period: ${formatDate(reportData.period.from)} to ${formatDate(reportData.period.to)}`,
        { align: 'center' }
    );
    doc.fontSize(7).text(
        `Generated: ${new Date(reportData.generatedAt).toLocaleString('en-IN')}`,
        { align: 'center' }
    );
    doc.moveDown(0.8);

    // ===== PROFIT & LOSS STATEMENT =====
    drawSectionTitle(doc, 'Profit & Loss Statement', pageCount, lay);
    if (pl) {
        drawPLStatement(doc, pl, pageCount, lay);
    }

    // Draw footer on all buffered pages
    // Temporarily set bottom margin to 0 to prevent PDFKit auto-page-breaking
    // when drawing text near the page bottom
    const totalPages = doc.bufferedPageRange();
    const numPages = totalPages.count;
    for (let i = 0; i < numPages; i++) {
        doc.switchToPage(i);
        const origBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        drawPageFooter(doc, i + 1, lay);
        doc.page.margins.bottom = origBottom;
    }

    // Switch back to last content page before ending
    doc.switchToPage(numPages - 1);
    doc.flushPages();
    doc.end();
}

// ===== EXCEL GENERATION =====

function styleHeaderRow(sheet, rowNum, colCount) {
    const row = sheet.getRow(rowNum);
    row.font = { bold: true, color: { argb: 'FF475569' }, size: 10 };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    row.alignment = { vertical: 'middle' };
    for (let c = 1; c <= colCount; c++) {
        row.getCell(c).border = {
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } }
        };
    }
}

function addTitleToSheet(sheet, reportData) {
    sheet.mergeCells('A1:B1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = reportData.title;
    titleCell.font = { size: 14, bold: true, color: { argb: 'FF0F172A' } };

    sheet.getCell('A2').value = reportData.filterLabel;
    sheet.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };

    sheet.getCell('A3').value = `Period: ${formatDate(reportData.period.from)} to ${formatDate(reportData.period.to)}`;
    sheet.getCell('A3').font = { size: 9, color: { argb: 'FF64748B' } };
}

async function generateExcel(reportData, res, filename) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TallyVision';
    workbook.created = new Date();

    const INR_FMT = '#,##,##0.00';

    // Helper: column index → letter (1=A, 2=B, ... 26=Z, 27=AA)
    function colLetter(n) {
        let s = '';
        while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
        return s;
    }

    // ===== Sheet 1: Profit & Loss =====
    const plSheet = workbook.addWorksheet('Profit & Loss');
    const pl = reportData.plStatement;
    const plCols = pl ? pl.columns : [];
    const plLines = pl ? pl.lines : [];
    const totalExcelCols = 1 + plCols.length; // Particulars + data columns

    // Title — merge across all columns
    plSheet.mergeCells(`A1:${colLetter(totalExcelCols)}1`);
    const plTitleCell = plSheet.getCell('A1');
    plTitleCell.value = reportData.title;
    plTitleCell.font = { size: 14, bold: true, color: { argb: 'FF0F172A' } };
    plSheet.getCell('A2').value = reportData.filterLabel;
    plSheet.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };
    plSheet.getCell('A3').value = `Period: ${formatDate(reportData.period.from)} to ${formatDate(reportData.period.to)}`;
    plSheet.getCell('A3').font = { size: 9, color: { argb: 'FF64748B' } };

    // Column widths
    plSheet.getColumn(1).width = 22;
    for (let c = 2; c <= totalExcelCols; c++) {
        plSheet.getColumn(c).width = 20;
        plSheet.getColumn(c).numFmt = INR_FMT;
    }

    // Headers — up to 3 levels or single-level
    const plLevel1 = pl ? pl.level1 : null;
    const plLevel2 = pl ? pl.level2 : null;
    let dataStartRow;

    // Helper: draw one grouped header band
    function drawGroupBand(sheet, rowNum, items, bgArgb, fontArgb, fontSize) {
        const row = sheet.getRow(rowNum);
        row.getCell(1).value = rowNum === 5 ? 'Particulars' : '';
        let ci = 2;
        for (const g of items) {
            if (g.span > 1) {
                sheet.mergeCells(`${colLetter(ci)}${rowNum}:${colLetter(ci + g.span - 1)}${rowNum}`);
            }
            row.getCell(ci).value = g.label;
            row.getCell(ci).alignment = { horizontal: 'center', vertical: 'middle' };
            ci += g.span;
        }
        row.font = { bold: true, color: { argb: fontArgb }, size: fontSize };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
        for (let c = 1; c <= totalExcelCols; c++) {
            row.getCell(c).border = { bottom: { style: 'thin', color: { argb: 'FF475569' } } };
        }
    }

    if (plLevel1 || plLevel2) {
        let curRow = 5;

        // Level 1: Cities
        if (plLevel1) {
            drawGroupBand(plSheet, curRow, plLevel1, 'FF0F172A', 'FFFFFFFF', 10);
            curRow++;
        }

        // Level 2: Locations
        if (plLevel2) {
            drawGroupBand(plSheet, curRow, plLevel2, 'FF1E293B', 'FFCBD5E1', 9);
            curRow++;
        }

        // Stream type row (column names)
        const streamRow = plSheet.getRow(curRow);
        streamRow.getCell(1).value = !plLevel1 && !plLevel2 ? 'Particulars' : '';
        plCols.forEach((col, i) => { streamRow.getCell(i + 2).value = col.name; });
        streamRow.font = { bold: true, color: { argb: 'FFE2E8F0' }, size: 9 };
        streamRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
        streamRow.alignment = { horizontal: 'right', vertical: 'middle' };
        streamRow.getCell(1).alignment = { horizontal: 'left' };
        for (let c = 1; c <= totalExcelCols; c++) {
            streamRow.getCell(c).border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
        }

        dataStartRow = curRow + 1;
    } else {
        // Single-level header at row 5
        const plHeaderValues = ['Particulars', ...plCols.map(c => c.name)];
        plSheet.getRow(5).values = plHeaderValues;
        styleHeaderRow(plSheet, 5, totalExcelCols);
        dataStartRow = 6;
    }

    // Data rows
    plLines.forEach((line, i) => {
        const row = plSheet.getRow(dataStartRow + i);
        const values = [line.label];
        plCols.forEach(col => {
            values.push(col.data[line.key] || 0);
        });
        row.values = values;

        // Bold + background for GP and NP rows
        if (line.bold) {
            row.font = { bold: true, size: 11 };
            row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
            // Add top border for GP/NP
            for (let c = 1; c <= totalExcelCols; c++) {
                row.getCell(c).border = {
                    top: { style: 'thin', color: { argb: 'FF94A3B8' } },
                    bottom: line.line === 'both'
                        ? { style: 'double', color: { argb: 'FF1E293B' } }
                        : { style: 'thin', color: { argb: 'FFCBD5E1' } }
                };
            }
        }
    });

    // Stream to response
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
}

module.exports = { generatePDF, generateExcel, fmtINR, fmtLakhs, formatDate, formatMonth };
