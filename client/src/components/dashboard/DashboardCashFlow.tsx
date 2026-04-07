import { useState, useMemo } from 'react';
import { ForecastItem, FY, Scenario } from '../../pages/ForecastModulePage';
import { buildPeriodOptions, sumForecastCat, sumActualsCat, calcChange, fmtRs, fmtPct, monthLabel } from './dashboardUtils';

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

interface CFRow {
  key: string;
  label: string;
  indent?: number;
  isHeader?: boolean;
  isTotal?: boolean;
  getActual: (ms: string[]) => number;
  getForecast: (ms: string[]) => number;
}

export default function DashboardCashFlow({ items, allValues, months, settings, actuals, selectedFY }: Props) {
  const periodOptions = useMemo(() => selectedFY ? buildPeriodOptions(selectedFY.start_date) : [], [selectedFY]);
  const [selectedPeriod, setSelectedPeriod] = useState('full_year');
  const [view, setView] = useState<'overall' | 'monthly'>('overall');

  const periodMonths = useMemo(() => {
    const opt = periodOptions.find(p => p.value === selectedPeriod);
    return opt?.months || months;
  }, [selectedPeriod, periodOptions, months]);

  const sumF = (cat: string, ms: string[]) => sumForecastCat(items, cat, allValues, ms);
  const sumA = (cat: string, ms: string[]) => sumActualsCat(actuals, cat, ms);

  const cfRows: CFRow[] = useMemo(() => {
    return [
      { key: 'ops_header', label: 'Net Cash from Operations', isHeader: true, getActual: () => 0, getForecast: () => 0 },
      { key: 'net_profit', label: 'Net Profit', indent: 1,
        getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms) - sumA('taxes', ms),
        getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms) - sumF('taxes', ms),
      },
      { key: 'depr', label: 'Depreciation & Amortization', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'ar_change', label: 'Change in Accounts Receivable', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'inv_change', label: 'Change in Inventory', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'ap_change', label: 'Change in Accounts Payable', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'tax_payable', label: 'Change in Income Tax Payable', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'gst_payable', label: 'Change in Sales Tax Payable', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'prepaid', label: 'Change in Prepaid Revenue', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'net_ops', label: 'Net Cash from Operations', isTotal: true,
        getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms) - sumA('taxes', ms),
        getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms) - sumF('taxes', ms),
      },

      { key: 'inv_header', label: 'Net Cash from Investing', isHeader: true, getActual: () => 0, getForecast: () => 0 },
      { key: 'assets_purch', label: 'Assets Purchased or Sold', indent: 1,
        getActual: ms => -sumA('assets', ms),
        getForecast: ms => -sumF('assets', ms),
      },
      { key: 'other_ca', label: 'Change in Other Current Assets', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'net_inv', label: 'Net Cash from Investing', isTotal: true,
        getActual: ms => -sumA('assets', ms),
        getForecast: ms => -sumF('assets', ms),
      },

      { key: 'fin_header', label: 'Net Cash from Financing', isHeader: true, getActual: () => 0, getForecast: () => 0 },
      { key: 'borrowing', label: 'New Borrowing / Loan Payments', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'investments', label: 'Investments Received', indent: 1, getActual: () => 0, getForecast: () => 0 },
      { key: 'dividends', label: 'Dividends Paid', indent: 1,
        getActual: ms => -sumA('dividends', ms),
        getForecast: ms => -sumF('dividends', ms),
      },
      { key: 'net_fin', label: 'Net Cash from Financing', isTotal: true,
        getActual: ms => -sumA('dividends', ms),
        getForecast: ms => -sumF('dividends', ms),
      },

      { key: 'cash_end', label: 'Cash at End of Period', isTotal: true,
        getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms) - sumA('taxes', ms) - sumA('assets', ms) - sumA('dividends', ms),
        getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms) - sumF('taxes', ms) - sumF('assets', ms) - sumF('dividends', ms),
      },
    ];
  }, [items, allValues, actuals]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-slate-800">Cash Flow</h2>
        <div className="flex items-center gap-3">
          <select value={selectedPeriod} onChange={e => setSelectedPeriod(e.target.value)} className="input text-sm py-1.5 w-56">
            {periodOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <div className="flex bg-slate-100 rounded-lg p-1">
            <button onClick={() => setView('overall')} className={`px-3 py-1.5 rounded-md text-xs font-medium ${view === 'overall' ? 'bg-slate-800 text-white' : 'text-slate-500'}`}>Overall</button>
            <button onClick={() => setView('monthly')} className={`px-3 py-1.5 rounded-md text-xs font-medium ${view === 'monthly' ? 'bg-slate-800 text-white' : 'text-slate-500'}`}>By Month</button>
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={view === 'monthly' ? { minWidth: periodMonths.length * 200 + 280 } : undefined}>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left py-3 px-4 font-semibold text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[280px]">Cash Flow</th>
              {view === 'overall' ? (
                <>
                  <th className="text-right py-3 px-4 font-semibold text-slate-600 min-w-[120px]">Actual</th>
                  <th className="text-right py-3 px-4 font-semibold text-slate-600 min-w-[120px]">Forecast</th>
                  <th className="text-right py-3 px-4 font-semibold text-slate-600 min-w-[100px]">Change</th>
                </>
              ) : (
                periodMonths.map(m => (
                  <th key={m} className="text-right py-3 px-2 font-semibold text-slate-600 whitespace-nowrap min-w-[180px]">
                    <div>{monthLabel(m)}</div>
                    <div className="flex justify-end gap-4 text-xs mt-1 font-normal text-slate-400"><span>Actual</span><span>Forecast</span><span>Chg</span></div>
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {cfRows.map(row => {
              if (row.isHeader) {
                return (
                  <tr key={row.key} className="bg-slate-50 border-b border-slate-200">
                    <td className="py-2.5 px-4 font-semibold text-slate-700 sticky left-0 bg-slate-50 z-10" colSpan={view === 'overall' ? 4 : periodMonths.length + 1}>{row.label}</td>
                  </tr>
                );
              }
              if (view === 'overall') {
                const a = row.getActual(periodMonths);
                const f = row.getForecast(periodMonths);
                const ch = calcChange(a, f);
                return (
                  <tr key={row.key} className={`border-b border-slate-100 ${row.isTotal ? 'font-semibold bg-slate-50/50' : ''}`}>
                    <td className={`py-2.5 px-4 sticky left-0 z-10 ${row.isTotal ? 'bg-slate-50/50' : 'bg-white'} ${row.indent ? 'pl-10' : ''}`}>{row.label}</td>
                    <td className={`text-right py-2.5 px-4 tabular-nums ${a < 0 ? 'text-red-600' : ''}`}>{a !== 0 ? fmtRs(a) : '--'}</td>
                    <td className="text-right py-2.5 px-4 tabular-nums">{f !== 0 ? fmtRs(f) : '--'}</td>
                    <td className="text-right py-2.5 px-4">
                      {(a !== 0 || f !== 0) ? (
                        <span className={`text-xs font-semibold ${ch.direction === 'up' ? 'text-emerald-600' : ch.direction === 'down' ? 'text-red-500' : 'text-slate-400'}`}>
                          {ch.direction === 'up' ? '↑' : ch.direction === 'down' ? '↓' : ''} {fmtPct(ch.pct)}
                        </span>
                      ) : '--'}
                    </td>
                  </tr>
                );
              } else {
                return (
                  <tr key={row.key} className={`border-b border-slate-100 ${row.isTotal ? 'font-semibold bg-slate-50/50' : ''}`}>
                    <td className={`py-2 px-4 sticky left-0 z-10 ${row.isTotal ? 'bg-slate-50/50' : 'bg-white'} ${row.indent ? 'pl-10' : ''}`}>{row.label}</td>
                    {periodMonths.map(m => {
                      const a = row.getActual([m]);
                      const f = row.getForecast([m]);
                      const ch = calcChange(a, f);
                      return (
                        <td key={m} className="text-right py-2 px-2">
                          <div className="flex justify-end gap-3 text-xs tabular-nums">
                            <span>{a !== 0 ? fmtRs(a) : '--'}</span>
                            <span className="text-slate-500">{f !== 0 ? fmtRs(f) : '--'}</span>
                            <span className={`font-semibold ${ch.direction === 'up' ? 'text-emerald-600' : ch.direction === 'down' ? 'text-red-500' : 'text-slate-400'}`}>
                              {a !== 0 || f !== 0 ? `${ch.direction === 'up' ? '↑' : '↓'}${Math.abs(ch.pct).toFixed(0)}%` : '--'}
                            </span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              }
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
