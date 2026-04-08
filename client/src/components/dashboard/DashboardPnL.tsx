import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { ForecastItem, FY, Scenario } from '../../pages/ForecastModulePage';
import { buildPeriodOptions, sumForecastCat, sumActualsCat, sumForecastCatMonth, sumActualsCatMonth, calcChange, fmtRs, fmtPct, monthLabel } from './dashboardUtils';

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

interface PnLRow {
  key: string;
  label: string;
  indent?: number;
  isHeader?: boolean;
  isTotal?: boolean;
  isPct?: boolean;
  expandable?: boolean;
  parentKey?: string;
  getActual: (months: string[]) => number;
  getForecast: (months: string[]) => number;
}

export default function DashboardPnL({ items, allValues, months, settings, actuals, selectedFY }: Props) {
  const periodOptions = useMemo(() => selectedFY ? buildPeriodOptions(selectedFY.start_date) : [], [selectedFY]);
  const [selectedPeriod, setSelectedPeriod] = useState('full_year');
  const [view, setView] = useState<'overall' | 'monthly'>('overall');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const periodMonths = useMemo(() => {
    const opt = periodOptions.find(p => p.value === selectedPeriod);
    return opt?.months || months;
  }, [selectedPeriod, periodOptions, months]);

  const benefitsPct = settings.employee_benefits_pct || 0;

  const revenueItems = items.filter(i => i.category === 'revenue');
  const dcItems = items.filter(i => i.category === 'direct_costs');
  const persItems = items.filter(i => i.category === 'personnel');
  const expItems = items.filter(i => i.category === 'expenses');

  const sumF = (cat: string, ms: string[]) => sumForecastCat(items, cat, allValues, ms);
  const sumA = (cat: string, ms: string[]) => sumActualsCat(actuals, cat, ms);

  const pnlRows: PnLRow[] = useMemo(() => {
    const rows: PnLRow[] = [];

    // Revenue
    rows.push({ key: 'revenue', label: 'Revenue', expandable: true, getActual: ms => sumA('revenue', ms), getForecast: ms => sumF('revenue', ms) });
    revenueItems.forEach(item => {
      rows.push({
        key: `rev_${item.id}`, label: item.name, indent: 1, parentKey: 'revenue',
        getActual: ms => ms.reduce((s, m) => s + (actuals.revenue?.[m] || 0), 0) > 0 ? 0 : 0, // individual actuals not tracked
        getForecast: ms => ms.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0),
      });
    });

    // Direct Costs
    rows.push({ key: 'direct_costs', label: 'Direct Costs', expandable: true, getActual: ms => sumA('direct_costs', ms), getForecast: ms => sumF('direct_costs', ms) });
    dcItems.forEach(item => {
      rows.push({
        key: `dc_${item.id}`, label: item.name, indent: 1, parentKey: 'direct_costs',
        getActual: () => 0,
        getForecast: ms => ms.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0),
      });
    });

    // Gross Profit
    rows.push({
      key: 'gross_profit', label: 'Gross Profit', isTotal: true,
      getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms),
      getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms),
    });
    rows.push({
      key: 'gross_margin', label: 'Gross Margin', isPct: true,
      getActual: ms => { const r = sumA('revenue', ms); return r > 0 ? ((r - sumA('direct_costs', ms)) / r) * 100 : 0; },
      getForecast: ms => { const r = sumF('revenue', ms); return r > 0 ? ((r - sumF('direct_costs', ms)) / r) * 100 : 0; },
    });

    // Operating Expenses
    rows.push({
      key: 'opex', label: 'Operating Expenses', expandable: true,
      getActual: ms => sumA('personnel', ms) + sumA('expenses', ms),
      getForecast: ms => sumF('personnel', ms) + Math.round(sumF('personnel', ms) * benefitsPct / 100) + sumF('expenses', ms),
    });
    persItems.forEach(item => {
      rows.push({
        key: `pers_${item.id}`, label: item.name, indent: 1, parentKey: 'opex',
        getActual: () => 0,
        getForecast: ms => ms.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0),
      });
    });
    if (benefitsPct > 0) {
      rows.push({
        key: 'emp_taxes', label: 'Employee Taxes & Benefits', indent: 1, parentKey: 'opex',
        getActual: () => 0,
        getForecast: ms => Math.round(sumF('personnel', ms) * benefitsPct / 100),
      });
    }
    expItems.forEach(item => {
      rows.push({
        key: `exp_${item.id}`, label: item.name, indent: 1, parentKey: 'opex',
        getActual: () => 0,
        getForecast: ms => ms.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0),
      });
    });

    // Operating Income
    rows.push({
      key: 'op_income', label: 'Operating Income', isTotal: true,
      getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms),
      getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - Math.round(sumF('personnel', ms) * benefitsPct / 100) - sumF('expenses', ms),
    });
    rows.push({
      key: 'op_margin', label: 'Operating Margin', isPct: true,
      getActual: ms => { const r = sumA('revenue', ms); const oi = r - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms); return r > 0 ? (oi / r) * 100 : 0; },
      getForecast: ms => { const r = sumF('revenue', ms); const oi = r - sumF('direct_costs', ms) - sumF('personnel', ms) - Math.round(sumF('personnel', ms) * benefitsPct / 100) - sumF('expenses', ms); return r > 0 ? (oi / r) * 100 : 0; },
    });

    // Taxes
    rows.push({ key: 'taxes', label: 'Taxes', getActual: ms => sumA('taxes', ms), getForecast: ms => sumF('taxes', ms) });

    // Net Profit
    rows.push({
      key: 'net_profit', label: 'Net Profit', isTotal: true,
      getActual: ms => sumA('revenue', ms) - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms) - sumA('taxes', ms),
      getForecast: ms => sumF('revenue', ms) - sumF('direct_costs', ms) - sumF('personnel', ms) - Math.round(sumF('personnel', ms) * benefitsPct / 100) - sumF('expenses', ms) - sumF('taxes', ms),
    });
    rows.push({
      key: 'net_margin', label: 'Net Profit Margin', isPct: true,
      getActual: ms => {
        const r = sumA('revenue', ms); const np = r - sumA('direct_costs', ms) - sumA('personnel', ms) - sumA('expenses', ms) - sumA('taxes', ms);
        return r > 0 ? (np / r) * 100 : 0;
      },
      getForecast: ms => {
        const r = sumF('revenue', ms); const np = r - sumF('direct_costs', ms) - sumF('personnel', ms) - Math.round(sumF('personnel', ms) * benefitsPct / 100) - sumF('expenses', ms) - sumF('taxes', ms);
        return r > 0 ? (np / r) * 100 : 0;
      },
    });

    return rows;
  }, [items, allValues, actuals, benefitsPct]);

  const toggleExpand = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const visibleRows = pnlRows.filter(row => {
    if (!row.parentKey) return true;
    return expanded[row.parentKey];
  });

  const fmtVal = (v: number, isPct: boolean) => isPct ? `${v.toFixed(1)}%` : fmtRs(v);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-theme-heading">Profit & Loss</h2>
        <div className="flex items-center gap-3">
          <select value={selectedPeriod} onChange={e => setSelectedPeriod(e.target.value)} className="input text-sm py-1.5 w-56">
            {periodOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <div className="flex bg-dark-500 rounded-lg p-1">
            <button onClick={() => setView('overall')} className={`px-3 py-1.5 rounded-md text-xs font-medium ${view === 'overall' ? 'bg-slate-800 text-theme-heading' : 'text-theme-faint'}`}>Overall</button>
            <button onClick={() => setView('monthly')} className={`px-3 py-1.5 rounded-md text-xs font-medium ${view === 'monthly' ? 'bg-slate-800 text-theme-heading' : 'text-theme-faint'}`}>By Month</button>
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={view === 'monthly' ? { minWidth: periodMonths.length * 200 + 280 } : undefined}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-theme-muted sticky left-0 bg-dark-600 z-10 min-w-[250px]">Profit & Loss</th>
              {view === 'overall' ? (
                <>
                  <th className="text-right py-3 px-4 font-semibold text-theme-muted min-w-[120px]">Actual</th>
                  <th className="text-right py-3 px-4 font-semibold text-theme-muted min-w-[120px]">Forecast</th>
                  <th className="text-right py-3 px-4 font-semibold text-theme-muted min-w-[100px]">Change</th>
                </>
              ) : (
                periodMonths.map(m => (
                  <th key={m} className="text-right py-3 px-2 font-semibold text-theme-muted whitespace-nowrap min-w-[180px]" colSpan={1}>
                    <div>{monthLabel(m)}</div>
                    <div className="flex justify-end gap-4 text-xs mt-1 font-normal text-theme-muted">
                      <span>Actual</span><span>Forecast</span><span>Chg</span>
                    </div>
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(row => {
              if (view === 'overall') {
                const actual = row.getActual(periodMonths);
                const forecast = row.getForecast(periodMonths);
                const change = calcChange(actual, forecast);
                return (
                  <tr key={row.key} className={`border-b border-dark-400/30 ${row.isTotal ? 'font-semibold bg-dark-600/50' : ''}`}>
                    <td className={`py-2.5 px-4 sticky left-0 z-10 ${row.isTotal ? 'bg-dark-600/50' : 'bg-dark-700'} ${row.indent ? 'pl-10' : ''}`}>
                      <div className="flex items-center gap-1">
                        {row.expandable && (
                          <button onClick={() => toggleExpand(row.key)} className="p-0.5 hover:bg-dark-400 rounded">
                            {expanded[row.key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        )}
                        <span className="text-theme-secondary">{row.label}</span>
                      </div>
                    </td>
                    <td className={`text-right py-2.5 px-4 tabular-nums ${actual < 0 ? 'text-red-400' : ''}`}>{actual !== 0 ? fmtVal(actual, !!row.isPct) : '--'}</td>
                    <td className="text-right py-2.5 px-4 tabular-nums">{forecast !== 0 ? fmtVal(forecast, !!row.isPct) : '--'}</td>
                    <td className="text-right py-2.5 px-4">
                      {actual !== 0 || forecast !== 0 ? (
                        <span className={`text-xs font-semibold ${change.direction === 'up' ? 'text-emerald-400' : change.direction === 'down' ? 'text-red-500' : 'text-theme-muted'}`}>
                          {change.direction === 'up' ? '↑' : change.direction === 'down' ? '↓' : ''} {fmtPct(change.pct)}
                        </span>
                      ) : '--'}
                    </td>
                  </tr>
                );
              } else {
                // By Month view
                return (
                  <tr key={row.key} className={`border-b border-dark-400/30 ${row.isTotal ? 'font-semibold bg-dark-600/50' : ''}`}>
                    <td className={`py-2 px-4 sticky left-0 z-10 ${row.isTotal ? 'bg-dark-600/50' : 'bg-dark-700'} ${row.indent ? 'pl-10' : ''}`}>
                      <div className="flex items-center gap-1">
                        {row.expandable && (
                          <button onClick={() => toggleExpand(row.key)} className="p-0.5 hover:bg-dark-400 rounded">
                            {expanded[row.key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        )}
                        <span className="text-theme-secondary">{row.label}</span>
                      </div>
                    </td>
                    {periodMonths.map(m => {
                      const a = row.getActual([m]);
                      const f = row.getForecast([m]);
                      const ch = calcChange(a, f);
                      return (
                        <td key={m} className="text-right py-2 px-2">
                          <div className="flex justify-end gap-3 text-xs tabular-nums">
                            <span className={a < 0 ? 'text-red-400' : ''}>{a !== 0 ? fmtVal(a, !!row.isPct) : '--'}</span>
                            <span className="text-theme-faint">{f !== 0 ? fmtVal(f, !!row.isPct) : '--'}</span>
                            <span className={`font-semibold ${ch.direction === 'up' ? 'text-emerald-400' : ch.direction === 'down' ? 'text-red-500' : 'text-theme-muted'}`}>
                              {a !== 0 || f !== 0 ? `${ch.direction === 'up' ? '↑' : ch.direction === 'down' ? '↓' : ''}${Math.abs(ch.pct).toFixed(0)}%` : '--'}
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
