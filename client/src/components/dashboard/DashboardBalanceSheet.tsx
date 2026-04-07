import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
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

interface BSRow {
  key: string;
  label: string;
  indent?: number;
  isHeader?: boolean;
  isTotal?: boolean;
  expandable?: boolean;
  parentKey?: string;
  getActual: (ms: string[]) => number;
  getForecast: (ms: string[]) => number;
}

export default function DashboardBalanceSheet({ items, allValues, months, settings, actuals, selectedFY }: Props) {
  const periodOptions = useMemo(() => selectedFY ? buildPeriodOptions(selectedFY.start_date) : [], [selectedFY]);
  const [selectedPeriod, setSelectedPeriod] = useState('full_year');
  const [view, setView] = useState<'overall' | 'monthly'>('overall');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ current_assets: true, lt_assets: true, equity: true });

  const periodMonths = useMemo(() => {
    const opt = periodOptions.find(p => p.value === selectedPeriod);
    return opt?.months || months;
  }, [selectedPeriod, periodOptions, months]);

  const sumF = (cat: string, ms: string[]) => sumForecastCat(items, cat, allValues, ms);
  const sumA = (cat: string, ms: string[]) => sumActualsCat(actuals, cat, ms);

  const currentAssetItems = items.filter(i => i.category === 'assets' && i.item_type === 'current');
  const ltAssetItems = items.filter(i => i.category === 'assets' && i.item_type === 'long_term');

  const bsRows: BSRow[] = useMemo(() => {
    const rows: BSRow[] = [];

    rows.push({ key: 'assets_header', label: 'Assets', isHeader: true, getActual: () => 0, getForecast: () => 0 });

    // Current Assets
    rows.push({ key: 'current_assets', label: 'Current Assets', expandable: true,
      getActual: ms => sumA('assets', ms),
      getForecast: ms => {
        const cash = sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms);
        const ca = currentAssetItems.reduce((s, it) => s + ms.reduce((ms2, m) => ms2 + (allValues[it.id]?.[m] || 0), 0), 0);
        return Math.max(cash, 0) + ca;
      },
    });
    rows.push({ key: 'cash', label: 'Cash', indent: 1, parentKey: 'current_assets',
      getActual: () => 0,
      getForecast: ms => Math.max(sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms), 0),
    });
    rows.push({ key: 'ar', label: 'Accounts Receivable', indent: 1, parentKey: 'current_assets', getActual: () => 0, getForecast: () => 0 });
    currentAssetItems.forEach(it => {
      rows.push({ key: `ca_${it.id}`, label: it.name, indent: 1, parentKey: 'current_assets',
        getActual: () => 0,
        getForecast: ms => ms.reduce((s, m) => s + (allValues[it.id]?.[m] || 0), 0),
      });
    });

    // Long-term Assets
    rows.push({ key: 'lt_assets', label: 'Long-term Assets', expandable: true,
      getActual: () => 0,
      getForecast: ms => ltAssetItems.reduce((s, it) => s + ms.reduce((ms2, m) => ms2 + (allValues[it.id]?.[m] || 0), 0), 0),
    });
    ltAssetItems.forEach(it => {
      rows.push({ key: `la_${it.id}`, label: it.name, indent: 1, parentKey: 'lt_assets',
        getActual: () => 0,
        getForecast: ms => ms.reduce((s, m) => s + (allValues[it.id]?.[m] || 0), 0),
      });
    });
    rows.push({ key: 'accum_depr', label: 'Accumulated Depreciation', indent: 1, parentKey: 'lt_assets', getActual: () => 0, getForecast: () => 0 });

    // Total Assets
    rows.push({ key: 'total_assets', label: 'Total Assets', isTotal: true,
      getActual: ms => sumA('assets', ms),
      getForecast: ms => {
        const cash = Math.max(sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms), 0);
        return cash + sumF('assets', ms);
      },
    });

    // Liabilities & Equity
    rows.push({ key: 'le_header', label: 'Liabilities & Equity', isHeader: true, getActual: () => 0, getForecast: () => 0 });
    rows.push({ key: 'current_liabilities', label: 'Current Liabilities', expandable: true, getActual: () => 0, getForecast: () => 0 });
    rows.push({ key: 'ap', label: 'Accounts Payable', indent: 1, parentKey: 'current_liabilities', getActual: () => 0, getForecast: () => 0 });
    rows.push({ key: 'curr_borrow', label: 'Current Borrowing', indent: 1, parentKey: 'current_liabilities', getActual: () => 0, getForecast: () => 0 });
    rows.push({ key: 'other_cl', label: 'Other Current Liabilities', indent: 1, parentKey: 'current_liabilities', getActual: () => 0, getForecast: () => 0 });

    rows.push({ key: 'lt_liabilities', label: 'Long-term Liabilities', getActual: () => 0, getForecast: () => 0 });

    rows.push({ key: 'equity', label: 'Equity', expandable: true,
      getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms) - sumA('taxes', ms),
      getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms) - sumF('taxes', ms),
    });
    rows.push({ key: 'paid_in', label: 'Paid-in Capital', indent: 1, parentKey: 'equity', getActual: () => 0, getForecast: () => 0 });
    rows.push({ key: 'retained', label: 'Retained Earnings', indent: 1, parentKey: 'equity', getActual: () => 0, getForecast: () => 0 });
    rows.push({ key: 'earnings', label: 'Earnings (current period)', indent: 1, parentKey: 'equity',
      getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms) - sumA('taxes', ms),
      getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms) - sumF('taxes', ms),
    });

    rows.push({ key: 'total_le', label: 'Total Liabilities & Equity', isTotal: true,
      getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms) - sumA('taxes', ms),
      getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - sumF('expenses', ms) - sumF('taxes', ms),
    });

    return rows;
  }, [items, allValues, actuals]);

  const toggleExpand = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const visibleRows = bsRows.filter(row => {
    if (!row.parentKey) return true;
    return expanded[row.parentKey];
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-slate-800">Balance Sheet <span className="text-sm font-normal text-slate-500">(At end of period)</span></h2>
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
              <th className="text-left py-3 px-4 font-semibold text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[250px]">Balance Sheet</th>
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
                    <div className="flex justify-end gap-4 text-xs mt-1 font-normal text-slate-400">
                      <span>Actual</span><span>Forecast</span><span>Chg</span>
                    </div>
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(row => {
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
                    <td className={`py-2.5 px-4 sticky left-0 z-10 ${row.isTotal ? 'bg-slate-50/50' : 'bg-white'} ${row.indent ? 'pl-10' : ''}`}>
                      <div className="flex items-center gap-1">
                        {row.expandable && <button onClick={() => toggleExpand(row.key)} className="p-0.5 hover:bg-slate-200 rounded">{expanded[row.key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}
                        <span>{row.label}</span>
                      </div>
                    </td>
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
                    <td className={`py-2 px-4 sticky left-0 z-10 ${row.isTotal ? 'bg-slate-50/50' : 'bg-white'} ${row.indent ? 'pl-10' : ''}`}>
                      <div className="flex items-center gap-1">
                        {row.expandable && <button onClick={() => toggleExpand(row.key)} className="p-0.5 hover:bg-slate-200 rounded">{expanded[row.key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}
                        <span>{row.label}</span>
                      </div>
                    </td>
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
