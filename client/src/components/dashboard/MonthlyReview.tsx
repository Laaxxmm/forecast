import { useState, useMemo } from 'react';
import { Download, FileText, AlertCircle } from 'lucide-react';
import { ForecastItem, FY, Scenario } from '../../pages/ForecastModulePage';
import { sumForecastCatMonth, sumActualsCatMonth, fmtRs, fmtPct, monthFullLabel, monthLabel } from './dashboardUtils';

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

export default function MonthlyReview({ items, allValues, months, settings, actuals }: Props) {
  const [selectedMonth, setSelectedMonth] = useState(months[0] || '');
  const [viewMode, setViewMode] = useState<'monthly' | 'ytd'>('monthly');

  const benefitsPct = settings.employee_benefits_pct || 0;

  const hasActuals = useMemo(() => {
    return Object.values(actuals).some(catData => catData[selectedMonth] !== undefined && catData[selectedMonth] !== 0);
  }, [actuals, selectedMonth]);

  const hasForecast = useMemo(() => {
    return items.some(item => allValues[item.id]?.[selectedMonth] !== undefined && allValues[item.id]?.[selectedMonth] !== 0);
  }, [items, allValues, selectedMonth]);

  const isComplete = hasActuals && hasForecast;

  // Calculate metrics for the selected month
  const metrics = useMemo(() => {
    const ms = viewMode === 'ytd'
      ? months.slice(0, months.indexOf(selectedMonth) + 1)
      : [selectedMonth];

    const sumF = (cat: string) => ms.reduce((s, m) => s + sumForecastCatMonth(items, cat, allValues, m), 0);
    const sumA = (cat: string) => ms.reduce((s, m) => s + sumActualsCatMonth(actuals, cat, m), 0);

    const aRev = sumA('revenue');
    const fRev = sumF('revenue');
    const aDC = sumA('direct_costs');
    const fDC = sumF('direct_costs');
    const aPers = sumA('personnel');
    const fPers = sumF('personnel');
    const aExp = sumA('expenses');
    const fExp = sumF('expenses');
    const aTax = sumA('taxes');
    const fTax = sumF('taxes');

    const aGrossProfit = aRev - aDC;
    const fGrossProfit = fRev - fDC;
    const aOpex = aPers + aExp;
    const fOpex = fPers + Math.round(fPers * benefitsPct / 100) + fExp;
    const aOpIncome = aGrossProfit - aOpex;
    const fOpIncome = fGrossProfit - fOpex;
    const aNetProfit = aOpIncome - aTax;
    const fNetProfit = fOpIncome - fTax;

    return { aRev, fRev, aDC, fDC, aGrossProfit, fGrossProfit, aOpex, fOpex, aOpIncome, fOpIncome, aNetProfit, fNetProfit };
  }, [selectedMonth, viewMode, items, allValues, actuals, months, benefitsPct]);

  const generateInsight = (label: string, actual: number, forecast: number): string => {
    if (actual === 0 && forecast === 0) return `${label}: No data available for this period.`;
    const diff = actual - forecast;
    const pct = forecast !== 0 ? ((diff / Math.abs(forecast)) * 100).toFixed(1) : '0';
    if (diff > 0) return `${label} came in at ${fmtRs(actual)}, which is ${fmtRs(diff)} (${pct}%) above the forecast of ${fmtRs(forecast)}. This is a positive variance.`;
    if (diff < 0) return `${label} came in at ${fmtRs(actual)}, which is ${fmtRs(Math.abs(diff))} (${Math.abs(parseFloat(pct))}%) below the forecast of ${fmtRs(forecast)}. This needs attention.`;
    return `${label} matched the forecast exactly at ${fmtRs(actual)}.`;
  };

  return (
    <div>
      {/* Controls */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <select
            value={selectedMonth}
            onChange={e => setSelectedMonth(e.target.value)}
            className="input text-sm py-2 w-48"
          >
            {months.map(m => <option key={m} value={m}>{monthFullLabel(m)}</option>)}
          </select>
          <div className="flex bg-slate-100 rounded-lg p-1">
            <button
              onClick={() => setViewMode('monthly')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium ${viewMode === 'monthly' ? 'bg-primary-600 text-white' : 'text-slate-500'}`}
            >Monthly Insights</button>
            <button
              onClick={() => setViewMode('ytd')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium ${viewMode === 'ytd' ? 'bg-primary-600 text-white' : 'text-slate-500'}`}
            >Year to Date Insights</button>
          </div>
        </div>
        <button
          onClick={() => window.print()}
          className="btn-secondary flex items-center gap-2 text-sm"
        >
          <Download size={14} />
          Download PDF
        </button>
      </div>

      {!isComplete ? (
        /* Incomplete State */
        <div className="card text-center py-16">
          <div className="mx-auto w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mb-4">
            <AlertCircle size={32} className="text-amber-600" />
          </div>
          <h3 className="text-lg font-semibold text-slate-800 mb-2">Your data for this month is incomplete</h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto mb-4">
            The monthly review compares your actual results to your forecast values. One or both are missing for {monthFullLabel(selectedMonth)}.
            Please check your forecast and accounting data, and then try again.
          </p>
          <div className="flex items-center justify-center gap-4 text-sm">
            <span className={`flex items-center gap-2 ${hasForecast ? 'text-emerald-600' : 'text-red-500'}`}>
              <span className={`w-2 h-2 rounded-full ${hasForecast ? 'bg-emerald-500' : 'bg-red-500'}`} />
              Forecast: {hasForecast ? 'Available' : 'Missing'}
            </span>
            <span className={`flex items-center gap-2 ${hasActuals ? 'text-emerald-600' : 'text-red-500'}`}>
              <span className={`w-2 h-2 rounded-full ${hasActuals ? 'bg-emerald-500' : 'bg-red-500'}`} />
              Actuals: {hasActuals ? 'Available' : 'Missing'}
            </span>
          </div>
          <a href="/analysis/update-actuals" className="text-primary-600 text-sm mt-4 inline-block hover:underline">
            Update your actuals →
          </a>
        </div>
      ) : (
        /* Full Review */
        <div className="space-y-6">
          {/* Header */}
          <div className="card">
            <div className="flex items-center gap-3 mb-4">
              <FileText size={20} className="text-primary-600" />
              <h2 className="text-lg font-bold text-slate-800">
                {viewMode === 'monthly' ? 'Monthly' : 'Year to Date'} Financial Review — {monthFullLabel(selectedMonth)}
              </h2>
            </div>
            <p className="text-sm text-slate-500">
              This automated review compares your actual financial results against your forecast for {viewMode === 'monthly' ? monthFullLabel(selectedMonth) : `April to ${monthFullLabel(selectedMonth)}`}.
            </p>
          </div>

          {/* Revenue Section */}
          <div className="card">
            <h3 className="text-md font-semibold text-slate-700 mb-3 flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-primary-500" /> Revenue Performance
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">{generateInsight('Revenue', metrics.aRev, metrics.fRev)}</p>
          </div>

          {/* Expenses Section */}
          <div className="card">
            <h3 className="text-md font-semibold text-slate-700 mb-3 flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-amber-500" /> Expense Analysis
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed mb-2">{generateInsight('Direct Costs', metrics.aDC, metrics.fDC)}</p>
            <p className="text-sm text-slate-600 leading-relaxed">{generateInsight('Operating Expenses', metrics.aOpex, metrics.fOpex)}</p>
          </div>

          {/* Profitability */}
          <div className="card">
            <h3 className="text-md font-semibold text-slate-700 mb-3 flex items-center gap-2">
              <span className="w-3 h-3 rounded bg-emerald-500" /> Profitability Insights
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed mb-2">{generateInsight('Gross Profit', metrics.aGrossProfit, metrics.fGrossProfit)}</p>
            <p className="text-sm text-slate-600 leading-relaxed mb-2">{generateInsight('Operating Income', metrics.aOpIncome, metrics.fOpIncome)}</p>
            <p className="text-sm text-slate-600 leading-relaxed">{generateInsight('Net Profit', metrics.aNetProfit, metrics.fNetProfit)}</p>
          </div>

          {/* Key Takeaways */}
          <div className="card border-l-4 border-primary-500">
            <h3 className="text-md font-semibold text-slate-700 mb-3">Key Takeaways</h3>
            <ul className="space-y-2 text-sm text-slate-600">
              {metrics.aRev > metrics.fRev && <li className="flex items-start gap-2"><span className="text-emerald-500 mt-0.5">✓</span> Revenue exceeded forecast — strong top-line performance.</li>}
              {metrics.aRev < metrics.fRev && <li className="flex items-start gap-2"><span className="text-red-500 mt-0.5">✗</span> Revenue fell short of forecast — review sales strategy and pipeline.</li>}
              {metrics.aOpex < metrics.fOpex && <li className="flex items-start gap-2"><span className="text-emerald-500 mt-0.5">✓</span> Operating expenses were below forecast — good cost control.</li>}
              {metrics.aOpex > metrics.fOpex && <li className="flex items-start gap-2"><span className="text-red-500 mt-0.5">✗</span> Operating expenses exceeded forecast — investigate cost overruns.</li>}
              {metrics.aNetProfit > metrics.fNetProfit && <li className="flex items-start gap-2"><span className="text-emerald-500 mt-0.5">✓</span> Net profit is above forecast — overall positive financial health.</li>}
              {metrics.aNetProfit < metrics.fNetProfit && <li className="flex items-start gap-2"><span className="text-red-500 mt-0.5">✗</span> Net profit is below forecast — consider revising expense allocations or revenue targets.</li>}
              {metrics.aRev === 0 && metrics.fRev === 0 && <li className="text-slate-400">No significant data to analyze for this period.</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
