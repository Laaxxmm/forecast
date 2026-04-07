import { useState } from 'react';
import { Download, Printer, FileText } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ForecastItem, FY, Scenario, getMonthLabel } from '../../pages/ForecastModulePage';
import { sumForecastCat, sumActualsCat, fmtRs, monthLabel } from './dashboardUtils';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  settings: Record<string, any>;
  actuals: Record<string, Record<string, number>>;
  scenario: Scenario | null;
  selectedFY: FY | null;
  onReload: () => Promise<void>;
}

export default function DashboardDownloadPrint({ items, allValues, months, settings, actuals, scenario, selectedFY }: Props) {
  const [generating, setGenerating] = useState(false);
  const [selectedReports, setSelectedReports] = useState({
    pnl: true,
    balance_sheet: true,
    cash_flow: true,
    monthly_review: false,
  });
  const [detailLevel, setDetailLevel] = useState<'annual' | 'monthly'>('monthly');
  const [paperSize, setPaperSize] = useState<'a4' | 'letter'>('a4');

  const toggleReport = (key: string) => {
    setSelectedReports(prev => ({ ...prev, [key]: !prev[key as keyof typeof prev] }));
  };

  const benefitsPct = settings.employee_benefits_pct || 0;
  const sumF = (cat: string) => sumForecastCat(items, cat, allValues, months);
  const sumA = (cat: string) => sumActualsCat(actuals, cat, months);

  const generatePDF = async () => {
    setGenerating(true);
    try {
      const isAnnual = detailLevel === 'annual';
      const doc = new jsPDF({ orientation: isAnnual ? 'portrait' : 'landscape', format: paperSize, unit: 'mm' });
      const pageW = doc.internal.pageSize.getWidth();

      // Cover page
      doc.setFillColor(13, 148, 136);
      doc.rect(0, 0, pageW, 80, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(28);
      doc.text('Dashboard Report', pageW / 2, 35, { align: 'center' });
      doc.setFontSize(14);
      doc.text('Actual vs. Forecast Comparison', pageW / 2, 50, { align: 'center' });
      doc.setFontSize(12);
      doc.text(selectedFY?.label || '', pageW / 2, 62, { align: 'center' });
      doc.setTextColor(100, 116, 139);
      doc.setFontSize(10);
      doc.text(`Generated on ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, pageW / 2, 95, { align: 'center' });
      doc.addPage();

      let y = 16;

      // P&L Report
      if (selectedReports.pnl) {
        doc.setFontSize(13);
        doc.setTextColor(30, 41, 59);
        doc.text('Profit & Loss — Actual vs. Forecast', 14, y);
        y += 6;

        const pnlData = [
          ['Revenue', fmtRs(sumA('revenue')), fmtRs(sumF('revenue'))],
          ['Direct Costs', fmtRs(sumA('direct_costs')), fmtRs(sumF('direct_costs'))],
          ['Gross Profit', fmtRs(sumA('revenue') - sumA('direct_costs')), fmtRs(sumF('revenue') - sumF('direct_costs'))],
          ['Personnel', fmtRs(sumA('personnel')), fmtRs(sumF('personnel'))],
          ['Expenses', fmtRs(sumA('expenses')), fmtRs(sumF('expenses'))],
          ['Operating Income', fmtRs(sumA('revenue') - sumA('direct_costs') - sumA('personnel') - sumA('expenses')),
           fmtRs(sumF('revenue') - sumF('direct_costs') - sumF('personnel') - sumF('expenses'))],
          ['Taxes', fmtRs(sumA('taxes')), fmtRs(sumF('taxes'))],
          ['Net Profit', fmtRs(sumA('revenue') - sumA('direct_costs') - sumA('personnel') - sumA('expenses') - sumA('taxes')),
           fmtRs(sumF('revenue') - sumF('direct_costs') - sumF('personnel') - sumF('expenses') - sumF('taxes'))],
        ];

        autoTable(doc, {
          startY: y,
          head: [['Line Item', 'Actual', 'Forecast']],
          body: pnlData,
          theme: 'grid',
          styles: { fontSize: 8, cellPadding: 3 },
          headStyles: { fillColor: [241, 245, 249], textColor: [51, 65, 85], fontStyle: 'bold' },
          columnStyles: { 0: { cellWidth: 60 }, 1: { halign: 'right' }, 2: { halign: 'right' } },
          margin: { left: 14, right: 14 },
        });

        y = (doc as any).lastAutoTable.finalY + 12;
      }

      // Balance Sheet
      if (selectedReports.balance_sheet) {
        if (y > 100) { doc.addPage(); y = 16; }
        doc.setFontSize(13);
        doc.setTextColor(30, 41, 59);
        doc.text('Balance Sheet — Actual vs. Forecast', 14, y);
        y += 6;

        const cash = Math.max(sumF('revenue') - sumF('direct_costs') - sumF('personnel') - sumF('expenses'), 0);
        const bsData = [
          ['Cash', '--', fmtRs(cash)],
          ['Total Assets', fmtRs(sumA('assets')), fmtRs(cash + sumF('assets'))],
          ['Retained Earnings', '--', fmtRs(sumF('revenue') - sumF('direct_costs') - sumF('personnel') - sumF('expenses') - sumF('taxes'))],
        ];

        autoTable(doc, {
          startY: y,
          head: [['Line Item', 'Actual', 'Forecast']],
          body: bsData,
          theme: 'grid',
          styles: { fontSize: 8, cellPadding: 3 },
          headStyles: { fillColor: [241, 245, 249], textColor: [51, 65, 85], fontStyle: 'bold' },
          columnStyles: { 0: { cellWidth: 60 }, 1: { halign: 'right' }, 2: { halign: 'right' } },
          margin: { left: 14, right: 14 },
        });

        y = (doc as any).lastAutoTable.finalY + 12;
      }

      // Cash Flow
      if (selectedReports.cash_flow) {
        if (y > 100) { doc.addPage(); y = 16; }
        doc.setFontSize(13);
        doc.setTextColor(30, 41, 59);
        doc.text('Cash Flow — Actual vs. Forecast', 14, y);
        y += 6;

        const netProfitA = sumA('revenue') - sumA('direct_costs') - sumA('personnel') - sumA('expenses') - sumA('taxes');
        const netProfitF = sumF('revenue') - sumF('direct_costs') - sumF('personnel') - sumF('expenses') - sumF('taxes');

        const cfData = [
          ['Net Cash from Operations', fmtRs(netProfitA), fmtRs(netProfitF)],
          ['Net Cash from Investing', fmtRs(-sumA('assets')), fmtRs(-sumF('assets'))],
          ['Net Cash from Financing', fmtRs(-sumA('dividends')), fmtRs(-sumF('dividends'))],
          ['Cash at End of Period', fmtRs(netProfitA - sumA('assets') - sumA('dividends')), fmtRs(netProfitF - sumF('assets') - sumF('dividends'))],
        ];

        autoTable(doc, {
          startY: y,
          head: [['Line Item', 'Actual', 'Forecast']],
          body: cfData,
          theme: 'grid',
          styles: { fontSize: 8, cellPadding: 3 },
          headStyles: { fillColor: [241, 245, 249], textColor: [51, 65, 85], fontStyle: 'bold' },
          columnStyles: { 0: { cellWidth: 60 }, 1: { halign: 'right' }, 2: { halign: 'right' } },
          margin: { left: 14, right: 14 },
        });
      }

      // Page footers
      const totalPages = doc.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFontSize(7);
        doc.setTextColor(148, 163, 184);
        doc.text(`Magna Tracker — ${scenario?.name || 'Dashboard'} — ${selectedFY?.label || ''}`, 14, doc.internal.pageSize.getHeight() - 8);
        doc.text(`Page ${p} of ${totalPages}`, pageW - 14, doc.internal.pageSize.getHeight() - 8, { align: 'right' });
      }

      doc.save(`Dashboard_Report_${selectedFY?.label?.replace(/\s+/g, '_') || 'report'}.pdf`);
    } catch (err) {
      console.error('PDF generation failed:', err);
      alert('Failed to generate PDF');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Printer size={24} className="text-accent-400" />
        <div>
          <h2 className="text-xl font-bold text-white">Download & Print</h2>
          <p className="text-sm text-slate-500">Generate PDF reports comparing actuals vs. forecast</p>
        </div>
      </div>

      {/* Reports to Include */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">Reports to Include</h3>
        <div className="space-y-2">
          {[
            { key: 'pnl', label: 'Profit & Loss Statement' },
            { key: 'balance_sheet', label: 'Balance Sheet' },
            { key: 'cash_flow', label: 'Cash Flow Statement' },
            { key: 'monthly_review', label: 'Monthly Review' },
          ].map(r => (
            <label key={r.key} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-600 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedReports[r.key as keyof typeof selectedReports]}
                onChange={() => toggleReport(r.key)}
                className="rounded text-accent-400 focus:ring-accent-500"
              />
              <span className="text-sm text-slate-300">{r.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Detail Level */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">Level of Detail</h3>
        <div className="flex gap-3">
          {(['annual', 'monthly'] as const).map(level => (
            <label key={level} className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
              detailLevel === level ? 'border-accent-500 bg-accent-500/10' : 'border-dark-400/50 hover:bg-dark-600'
            }`}>
              <input type="radio" checked={detailLevel === level} onChange={() => setDetailLevel(level)} className="hidden" />
              <FileText size={16} className={detailLevel === level ? 'text-accent-400' : 'text-slate-400'} />
              <span className={`text-sm font-medium capitalize ${detailLevel === level ? 'text-accent-300' : 'text-slate-400'}`}>{level} Totals</span>
            </label>
          ))}
        </div>
      </div>

      {/* Paper Size */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">Paper Size</h3>
        <select value={paperSize} onChange={e => setPaperSize(e.target.value as any)} className="input text-sm w-full">
          <option value="a4">A4</option>
          <option value="letter">US Letter</option>
        </select>
      </div>

      {/* Generate Button */}
      <button
        onClick={generatePDF}
        disabled={generating || !Object.values(selectedReports).some(v => v)}
        className="w-full btn-primary flex items-center justify-center gap-2 py-3 disabled:opacity-50"
      >
        {generating ? (
          <>
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Generating...
          </>
        ) : (
          <>
            <Download size={18} />
            Download Dashboard Report (PDF)
          </>
        )}
      </button>
    </div>
  );
}
