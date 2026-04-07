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

/* ──────── helpers to build report data ──────── */

function sumCat(items: ForecastItem[], cat: string, allValues: Record<number, Record<string, number>>, m: string) {
  return items.filter(i => i.category === cat).reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
}

function buildPnLRows(items: ForecastItem[], allValues: Record<number, Record<string, number>>, months: string[], benefitsPct: number) {
  const revenueItems = items.filter(i => i.category === 'revenue');
  const dcItems = items.filter(i => i.category === 'direct_costs');
  const persItems = items.filter(i => i.category === 'personnel');
  const expItems = items.filter(i => i.category === 'expenses');

  const header = ['Profit & Loss', ...months.map(m => getMonthLabel(m)), 'Total'];
  const rows: (string | number)[][] = [];

  // Revenue section
  rows.push(['Revenue', ...months.map(() => ''), '']);
  revenueItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
  });
  const revTotals = months.map(m => sumCat(items, 'revenue', allValues, m));
  rows.push(['Total Revenue', ...revTotals, revTotals.reduce((a, b) => a + b, 0)]);

  // Direct Costs
  rows.push(['Direct Costs', ...months.map(() => ''), '']);
  dcItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
  });
  const dcTotals = months.map(m => sumCat(items, 'direct_costs', allValues, m));
  rows.push(['Total Direct Costs', ...dcTotals, dcTotals.reduce((a, b) => a + b, 0)]);

  // Gross Profit
  const gpTotals = months.map((_, i) => revTotals[i] - dcTotals[i]);
  rows.push(['Gross Profit', ...gpTotals, gpTotals.reduce((a, b) => a + b, 0)]);

  // Operating Expenses
  rows.push(['Operating Expenses', ...months.map(() => ''), '']);
  persItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
  });
  const persTotals = months.map(m => sumCat(items, 'personnel', allValues, m));
  const empTaxTotals = persTotals.map(p => Math.round(p * benefitsPct / 100));
  rows.push(['  Employee Taxes & Benefits', ...empTaxTotals, empTaxTotals.reduce((a, b) => a + b, 0)]);
  expItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([`  ${item.name}`, ...vals, vals.reduce((a, b) => a + b, 0)]);
  });
  const expTotals = months.map(m => sumCat(items, 'expenses', allValues, m));
  const opexTotals = months.map((_, i) => persTotals[i] + empTaxTotals[i] + expTotals[i]);
  rows.push(['Total Operating Expenses', ...opexTotals, opexTotals.reduce((a, b) => a + b, 0)]);

  // Operating Income
  const oiTotals = months.map((_, i) => gpTotals[i] - opexTotals[i]);
  rows.push(['Operating Income', ...oiTotals, oiTotals.reduce((a, b) => a + b, 0)]);

  // Taxes
  const taxTotals = months.map(m => sumCat(items, 'taxes', allValues, m));
  rows.push(['Taxes', ...taxTotals, taxTotals.reduce((a, b) => a + b, 0)]);

  // Net Profit
  const npTotals = months.map((_, i) => oiTotals[i] - taxTotals[i]);
  rows.push(['Net Profit', ...npTotals, npTotals.reduce((a, b) => a + b, 0)]);

  return { header, rows };
}

function buildBalanceSheetRows(items: ForecastItem[], allValues: Record<number, Record<string, number>>, months: string[]) {
  const currentAssets = items.filter(i => i.category === 'assets' && i.item_type === 'current');
  const ltAssets = items.filter(i => i.category === 'assets' && i.item_type === 'long_term');

  const header = ['Balance Sheet', ...months.map(m => getMonthLabel(m))];
  const rows: (string | number)[][] = [];

  rows.push(['Assets', ...months.map(() => '')]);
  rows.push(['Current Assets', ...months.map(() => '')]);

  // Cash (simplified — net income)
  const cashVals = months.map(m => {
    const rev = sumCat(items, 'revenue', allValues, m);
    const costs = sumCat(items, 'direct_costs', allValues, m);
    const opex = sumCat(items, 'expenses', allValues, m) + sumCat(items, 'personnel', allValues, m);
    return Math.max(rev - costs - opex, 0);
  });
  rows.push(['  Cash', ...cashVals]);
  currentAssets.forEach(item => {
    rows.push([`  ${item.name}`, ...months.map(m => allValues[item.id]?.[m] || 0)]);
  });
  const caTotal = months.map((m, i) => cashVals[i] + currentAssets.reduce((s, it) => s + (allValues[it.id]?.[m] || 0), 0));
  rows.push(['Total Current Assets', ...caTotal]);

  rows.push(['Long-term Assets', ...months.map(() => '')]);
  ltAssets.forEach(item => {
    rows.push([`  ${item.name}`, ...months.map(m => allValues[item.id]?.[m] || 0)]);
  });
  const ltTotal = months.map(m => ltAssets.reduce((s, it) => s + (allValues[it.id]?.[m] || 0), 0));
  rows.push(['Total Long-term Assets', ...ltTotal]);

  const totalAssets = months.map((_, i) => caTotal[i] + ltTotal[i]);
  rows.push(['Total Assets', ...totalAssets]);

  return { header, rows };
}

function buildCashFlowRows(items: ForecastItem[], allValues: Record<number, Record<string, number>>, months: string[]) {
  const header = ['Cash Flow', ...months.map(m => getMonthLabel(m)), 'Total'];
  const rows: (string | number)[][] = [];
  let cumCash = 0;

  const mData = months.map(m => {
    const rev = sumCat(items, 'revenue', allValues, m);
    const dc = sumCat(items, 'direct_costs', allValues, m);
    const pers = sumCat(items, 'personnel', allValues, m);
    const exp = sumCat(items, 'expenses', allValues, m);
    const tax = sumCat(items, 'taxes', allValues, m);
    const assets = sumCat(items, 'assets', allValues, m);
    const div = sumCat(items, 'dividends', allValues, m);
    const cashOps = rev - dc - pers - exp - tax;
    const cashInv = -assets;
    const cashFin = -div;
    const net = cashOps + cashInv + cashFin;
    cumCash += net;
    return { rev, dc, pers, exp, tax, cashOps, assets, cashInv, div, cashFin, net, balance: cumCash };
  });

  rows.push(['Cash from Operations', ...months.map(() => ''), '']);
  rows.push(['  Cash Receipts', ...mData.map(d => d.rev), mData.reduce((s, d) => s + d.rev, 0)]);
  rows.push(['  Direct Costs Paid', ...mData.map(d => -d.dc), -mData.reduce((s, d) => s + d.dc, 0)]);
  rows.push(['  Personnel Paid', ...mData.map(d => -d.pers), -mData.reduce((s, d) => s + d.pers, 0)]);
  rows.push(['  Expenses Paid', ...mData.map(d => -d.exp), -mData.reduce((s, d) => s + d.exp, 0)]);
  rows.push(['  Taxes Paid', ...mData.map(d => -d.tax), -mData.reduce((s, d) => s + d.tax, 0)]);
  rows.push(['Net Cash from Operations', ...mData.map(d => d.cashOps), mData.reduce((s, d) => s + d.cashOps, 0)]);
  rows.push(['Cash from Investing', ...months.map(() => ''), '']);
  rows.push(['  Assets Purchased', ...mData.map(d => d.cashInv), mData.reduce((s, d) => s + d.cashInv, 0)]);
  rows.push(['Net Cash from Investing', ...mData.map(d => d.cashInv), mData.reduce((s, d) => s + d.cashInv, 0)]);
  rows.push(['Cash from Financing', ...months.map(() => ''), '']);
  rows.push(['  Dividends Paid', ...mData.map(d => d.cashFin), mData.reduce((s, d) => s + d.cashFin, 0)]);
  rows.push(['Net Cash from Financing', ...mData.map(d => d.cashFin), mData.reduce((s, d) => s + d.cashFin, 0)]);
  rows.push(['Net Cash Flow', ...mData.map(d => d.net), mData.reduce((s, d) => s + d.net, 0)]);
  rows.push(['Cash Balance', ...mData.map(d => d.balance), mData[mData.length - 1]?.balance || 0]);

  return { header, rows };
}

function buildCategoryRows(items: ForecastItem[], cat: string, catLabel: string, allValues: Record<number, Record<string, number>>, months: string[]) {
  const catItems = items.filter(i => i.category === cat);
  const header = [catLabel, ...months.map(m => getMonthLabel(m)), 'Total'];
  const rows: (string | number)[][] = [];

  catItems.forEach(item => {
    const vals = months.map(m => allValues[item.id]?.[m] || 0);
    rows.push([item.name, ...vals, vals.reduce((a, b) => a + b, 0)]);
  });

  const totals = months.map(m => catItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0));
  rows.push(['Totals', ...totals, totals.reduce((a, b) => a + b, 0)]);

  return { header, rows };
}

/* ──────── PDF Generation ──────── */

function formatNum(v: string | number): string {
  if (typeof v === 'string') return v;
  if (v === 0) return '-';
  return formatRs(v);
}

function addTableToPDF(
  doc: jsPDF,
  title: string,
  header: string[],
  rows: (string | number)[][],
  startY: number,
  isAnnual: boolean,
): number {
  // Title
  doc.setFontSize(13);
  doc.setTextColor(30, 41, 59);
  doc.text(title, 14, startY);
  startY += 6;

  // Build display rows — if annual, collapse months into single total
  let displayHeader: string[];
  let displayRows: string[][];

  if (isAnnual) {
    displayHeader = [header[0], 'Annual Total'];
    displayRows = rows.map(row => {
      const label = String(row[0]);
      const total = row[row.length - 1];
      return [label, typeof total === 'number' ? formatNum(total) : String(total)];
    });
  } else {
    displayHeader = header;
    displayRows = rows.map(row => row.map(cell => typeof cell === 'number' ? formatNum(cell) : String(cell)));
  }

  autoTable(doc, {
    startY,
    head: [displayHeader],
    body: displayRows,
    theme: 'grid',
    styles: {
      fontSize: 7,
      cellPadding: 2,
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [241, 245, 249],
      textColor: [51, 65, 85],
      fontStyle: 'bold',
      fontSize: 7,
    },
    columnStyles: Object.fromEntries(
      displayHeader.map((_, i) => [i, i === 0 ? { cellWidth: isAnnual ? 80 : 42, fontStyle: 'normal' } : { halign: 'right' as const, cellWidth: 'auto' }])
    ),
    didParseCell: (data) => {
      const text = String(data.cell.raw);
      // Bold section headers and totals
      if (data.section === 'body' && data.column.index === 0) {
        if (!text.startsWith('  ') && text !== '') {
          data.cell.styles.fontStyle = 'bold';
        }
      }
      // Red for negative values
      if (data.section === 'body' && data.column.index > 0 && text.startsWith('-')) {
        data.cell.styles.textColor = [220, 38, 38];
      }
    },
    margin: { left: 14, right: 14 },
  });

  return (doc as any).lastAutoTable.finalY + 12;
}

/* ──────── Component ──────── */

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

  const generatePDF = async () => {
    setGenerating(true);

    try {
      const isAnnual = detailLevel === 'annual';
      const orientation = isAnnual ? 'portrait' : 'landscape';
      const format = paperSize === 'a4' ? 'a4' : 'letter';

      const doc = new jsPDF({ orientation, format, unit: 'mm' });
      const pageW = doc.internal.pageSize.getWidth();
      const benefitsPct = settings.employee_benefits_pct || 0;

      // Cover page
      if (coverPage) {
        doc.setFillColor(13, 148, 136); // primary teal
        doc.rect(0, 0, pageW, 80, 'F');

        doc.setTextColor(255, 255, 255);
        doc.setFontSize(28);
        doc.text('Financial Forecast Report', pageW / 2, 35, { align: 'center' });

        if (includeScenarioTitle) {
          doc.setFontSize(16);
          doc.text(scenarioName, pageW / 2, 50, { align: 'center' });
        }

        doc.setFontSize(12);
        doc.text(fyLabel, pageW / 2, 62, { align: 'center' });

        doc.setTextColor(100, 116, 139);
        doc.setFontSize(10);
        doc.text(`Generated on ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, pageW / 2, 95, { align: 'center' });

        doc.setFontSize(9);
        doc.text(`Report Type: ${reportType === 'forecast' ? 'Forecast Only' : 'Actuals + Forecast'}`, pageW / 2, 105, { align: 'center' });
        doc.text(`Detail Level: ${isAnnual ? 'Annual Totals' : 'Monthly Totals'}`, pageW / 2, 112, { align: 'center' });

        // Reports included
        const selected = reports.filter(r => r.checked).map(r => r.label);
        doc.setFontSize(9);
        doc.setTextColor(71, 85, 105);
        doc.text('Reports Included:', pageW / 2, 130, { align: 'center' });
        selected.forEach((name, i) => {
          doc.text(`• ${name}`, pageW / 2, 140 + i * 7, { align: 'center' });
        });

        doc.addPage();
      }

      let y = 16;

      // P&L
      if (reports.find(r => r.key === 'pnl')?.checked) {
        const { header, rows } = buildPnLRows(items, allValues, months, benefitsPct);
        y = addTableToPDF(doc, 'Projected Profit & Loss', header, rows, y, isAnnual);
        if (y > doc.internal.pageSize.getHeight() - 30) { doc.addPage(); y = 16; }
      }

      // Balance Sheet
      if (reports.find(r => r.key === 'balance_sheet')?.checked) {
        if (y > 40) { doc.addPage(); y = 16; }
        const { header, rows } = buildBalanceSheetRows(items, allValues, months);
        y = addTableToPDF(doc, 'Projected Balance Sheet', header, rows, y, isAnnual);
      }

      // Cash Flow
      if (reports.find(r => r.key === 'cash_flow')?.checked) {
        if (y > 40) { doc.addPage(); y = 16; }
        const { header, rows } = buildCashFlowRows(items, allValues, months);
        y = addTableToPDF(doc, 'Projected Cash Flow', header, rows, y, isAnnual);
      }

      // Category-level tables
      const catMap: Record<string, string> = {
        revenue: 'Revenue',
        direct_costs: 'Direct Costs',
        personnel: 'Personnel',
        expenses: 'Expenses',
        assets: 'Assets',
        financing: 'Financing',
      };

      for (const [catKey, catLabel] of Object.entries(catMap)) {
        if (!reports.find(r => r.key === catKey)?.checked) continue;
        const catItems = items.filter(i => i.category === catKey);
        if (catItems.length === 0) continue;
        if (y > 60) { doc.addPage(); y = 16; }
        const { header, rows } = buildCategoryRows(items, catKey, catLabel, allValues, months);
        y = addTableToPDF(doc, catLabel, header, rows, y, isAnnual);
      }

      // Cash at end of period
      if (reports.find(r => r.key === 'cash_at_end')?.checked) {
        if (y > 60) { doc.addPage(); y = 16; }
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
        y = addTableToPDF(doc, 'Cash at End of Period', cashHeader, cashRows, y, isAnnual);
      }

      // Footer on each page
      const totalPages = doc.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFontSize(7);
        doc.setTextColor(148, 163, 184);
        doc.text(
          `Vision by Indefine — ${scenarioName} — ${fyLabel}`,
          14,
          doc.internal.pageSize.getHeight() - 8
        );
        doc.text(
          `Page ${p} of ${totalPages}`,
          pageW - 14,
          doc.internal.pageSize.getHeight() - 8,
          { align: 'right' }
        );
      }

      doc.save(`Forecast_Report_${fyLabel.replace(/\s+/g, '_')}.pdf`);
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
            <h2 className="text-lg font-bold text-white">Download & Print</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-dark-400 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        {/* Body - scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* A. Report Type */}
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Report Type</h3>
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
                  <p className="text-sm font-medium text-white">Forecast Only</p>
                  <p className="text-xs text-slate-500">A PDF using your original forecast data</p>
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
                  <p className="text-sm font-medium text-white">Actuals + Forecast</p>
                  <p className="text-xs text-slate-500">A PDF with adjusted values based on past actuals and future forecast</p>
                </div>
              </label>
            </div>
          </div>

          {/* B. Reports to Include */}
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Reports to Include</h3>
            <div className="space-y-1.5">
              {reports.map(r => (
                <label key={r.key} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={r.checked}
                    onChange={() => toggleReport(r.key)}
                    className="rounded text-accent-400 focus:ring-primary-500"
                  />
                  <span className="text-sm text-slate-300">{r.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* C. Level of Detail */}
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Level of Detail</h3>
            <div className="flex gap-3">
              <label className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                detailLevel === 'annual' ? 'border-primary-400 bg-accent-500/10/50' : 'border-dark-400/50 hover:bg-dark-600'
              }`}>
                <input type="radio" name="detail" checked={detailLevel === 'annual'} onChange={() => setDetailLevel('annual')} className="hidden" />
                <FileText size={16} className={detailLevel === 'annual' ? 'text-accent-400' : 'text-slate-400'} />
                <span className={`text-sm font-medium ${detailLevel === 'annual' ? 'text-accent-300' : 'text-slate-400'}`}>Annual Totals</span>
              </label>
              <label className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                detailLevel === 'monthly' ? 'border-primary-400 bg-accent-500/10/50' : 'border-dark-400/50 hover:bg-dark-600'
              }`}>
                <input type="radio" name="detail" checked={detailLevel === 'monthly'} onChange={() => setDetailLevel('monthly')} className="hidden" />
                <FileText size={16} className={detailLevel === 'monthly' ? 'text-accent-400' : 'text-slate-400'} />
                <span className={`text-sm font-medium ${detailLevel === 'monthly' ? 'text-accent-300' : 'text-slate-400'}`}>Monthly Totals</span>
              </label>
            </div>
          </div>

          {/* D. Other Options */}
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Other Options</h3>
            <div className="space-y-1.5">
              <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors">
                <input type="checkbox" checked={coverPage} onChange={e => setCoverPage(e.target.checked)} className="rounded text-accent-400 focus:ring-primary-500" />
                <span className="text-sm text-slate-300">Cover page</span>
              </label>
              <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors">
                <input type="checkbox" checked={includeCharts} onChange={e => setIncludeCharts(e.target.checked)} className="rounded text-accent-400 focus:ring-primary-500" />
                <span className="text-sm text-slate-300">Include charts</span>
              </label>
              <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer transition-colors">
                <input type="checkbox" checked={includeScenarioTitle} onChange={e => setIncludeScenarioTitle(e.target.checked)} className="rounded text-accent-400 focus:ring-primary-500" />
                <span className="text-sm text-slate-300">Include forecast scenario title</span>
              </label>
            </div>
          </div>

          {/* E. Paper Size */}
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Paper Size</h3>
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
