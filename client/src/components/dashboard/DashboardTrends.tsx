import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ForecastItem, FY, Scenario } from '../../pages/ForecastModulePage';
import { sumForecastCatMonth, sumActualsCatMonth, calcChange, fmtRs, fmtPct, monthLabel } from './dashboardUtils';

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

const METRICS = [
  { key: 'revenue', label: 'Revenue', type: 'aggregate' },
  { key: 'revenue_breakdown', label: 'Revenue Breakdown', type: 'breakdown' },
  { key: 'expenses', label: 'Expenses & Costs', type: 'aggregate' },
  { key: 'expense_breakdown', label: 'Expense & Cost Breakdown', type: 'breakdown' },
  { key: 'operating_income', label: 'Operating Income', type: 'aggregate' },
  { key: 'operating_margin', label: 'Operating Margin', type: 'aggregate' },
  { key: 'net_profit', label: 'Net Profit', type: 'aggregate' },
  { key: 'net_margin', label: 'Net Profit Margin', type: 'aggregate' },
  { key: 'cash_balance', label: 'Cash Balance', type: 'aggregate' },
  { key: 'net_cash_flow', label: 'Net Cash Flow', type: 'aggregate' },
];

const AGG_CHART_TYPES = ['area', 'line', 'column'] as const;
const BREAKDOWN_CHART_TYPES = ['table', 'bar', 'donut'] as const;
const COLORS = ['#0d9488', '#06b6d4', '#6366f1', '#f59e0b', '#ef4444', '#8b5cf6'];

function getMetricValue(
  metricKey: string,
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  actuals: Record<string, Record<string, number>>,
  month: string,
  source: 'forecast' | 'actual',
  benefitsPct: number,
): number {
  const sumF = (cat: string) => sumForecastCatMonth(items, cat, allValues, month);
  const sumA = (cat: string) => sumActualsCatMonth(actuals, cat, month);
  const sum = source === 'forecast' ? sumF : sumA;

  switch (metricKey) {
    case 'revenue': return sum('revenue');
    case 'expenses': return sum('direct_costs') + sum('personnel') + sum('expenses');
    case 'operating_income': {
      const rev = sum('revenue');
      const costs = sum('direct_costs') + sum('personnel') + sum('expenses');
      return rev - costs;
    }
    case 'operating_margin': {
      const rev = sum('revenue');
      const costs = sum('direct_costs') + sum('personnel') + sum('expenses');
      return rev > 0 ? ((rev - costs) / rev) * 100 : 0;
    }
    case 'net_profit': {
      const rev = sum('revenue');
      const costs = sum('direct_costs') + sum('personnel') + sum('expenses') + sum('taxes');
      return rev - costs;
    }
    case 'net_margin': {
      const rev = sum('revenue');
      const costs = sum('direct_costs') + sum('personnel') + sum('expenses') + sum('taxes');
      return rev > 0 ? ((rev - costs) / rev) * 100 : 0;
    }
    case 'cash_balance':
    case 'net_cash_flow': {
      const rev = sum('revenue');
      const costs = sum('direct_costs') + sum('personnel') + sum('expenses') + sum('taxes') + sum('assets');
      return rev - costs;
    }
    default: return 0;
  }
}

export default function DashboardTrends({ items, allValues, months, settings, actuals }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialMetric = searchParams.get('metric') || 'revenue';
  const [metricKey, setMetricKey] = useState(initialMetric);
  const [chartType, setChartType] = useState<string>('area');
  const [comparisonType, setComparisonType] = useState<'forecast' | 'previous_period' | 'previous_year'>('forecast');

  const metric = METRICS.find(m => m.key === metricKey) || METRICS[0];
  const metricIdx = METRICS.findIndex(m => m.key === metricKey);
  const isBreakdown = metric.type === 'breakdown';
  const benefitsPct = settings.employee_benefits_pct || 0;

  const navigateMetric = (dir: number) => {
    const newIdx = (metricIdx + dir + METRICS.length) % METRICS.length;
    setMetricKey(METRICS[newIdx].key);
  };

  // Build chart data
  const chartData = useMemo(() => {
    return months.map(m => ({
      month: monthLabel(m),
      Actual: getMetricValue(metricKey, items, allValues, actuals, m, 'actual', benefitsPct),
      Forecast: getMetricValue(metricKey, items, allValues, actuals, m, 'forecast', benefitsPct),
    }));
  }, [metricKey, items, allValues, actuals, months, benefitsPct]);

  // Summary stats
  const totalActual = chartData.reduce((s, d) => s + d.Actual, 0);
  const totalForecast = chartData.reduce((s, d) => s + d.Forecast, 0);
  const vsForecast = calcChange(totalActual, totalForecast);
  const isPercent = metricKey.includes('margin');

  // Breakdown data for table/bar/donut
  const breakdownData = useMemo(() => {
    if (metricKey === 'revenue_breakdown') {
      return items.filter(i => i.category === 'revenue').map(item => {
        const forecast = months.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0);
        return { name: item.name, actual: 0, forecast, change: calcChange(0, forecast) };
      });
    }
    if (metricKey === 'expense_breakdown') {
      const cats = ['direct_costs', 'personnel', 'expenses', 'taxes'];
      const labels: Record<string, string> = { direct_costs: 'Direct Costs', personnel: 'Personnel', expenses: 'Expenses', taxes: 'Taxes' };
      return cats.map(cat => {
        const forecast = items.filter(i => i.category === cat).reduce((s, item) =>
          s + months.reduce((ms, m) => ms + (allValues[item.id]?.[m] || 0), 0), 0);
        const actual = months.reduce((s, m) => s + (actuals[cat]?.[m] || 0), 0);
        return { name: labels[cat] || cat, actual, forecast, change: calcChange(actual, forecast) };
      });
    }
    return [];
  }, [metricKey, items, allValues, actuals, months]);

  const renderChart = () => {
    if (isBreakdown) {
      if (chartType === 'donut' || (!['table', 'bar', 'donut'].includes(chartType) && chartType !== 'table')) {
        return (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={breakdownData.map(d => ({ name: d.name, value: d.forecast }))} cx="50%" cy="50%" outerRadius={100} innerRadius={50} dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {breakdownData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => fmtRs(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        );
      }
      if (chartType === 'bar') {
        return (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={breakdownData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                <XAxis type="number" tickFormatter={v => fmtRs(v)} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => fmtRs(v)} />
                <Legend />
                <Bar dataKey="actual" name="Actual" fill="#0d9488" barSize={16} radius={[0, 4, 4, 0]} />
                <Bar dataKey="forecast" name="Forecast" fill="#cbd5e1" barSize={16} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      }
      // Table view
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dark-400/50 bg-dark-600">
                <th className="text-left py-2.5 px-4 font-semibold text-slate-400">Item</th>
                <th className="text-right py-2.5 px-4 font-semibold text-slate-400">Actual (Rs)</th>
                <th className="text-right py-2.5 px-4 font-semibold text-slate-400">Forecast (Rs)</th>
                <th className="text-right py-2.5 px-4 font-semibold text-slate-400">Change (%)</th>
              </tr>
            </thead>
            <tbody>
              {breakdownData.map(d => (
                <tr key={d.name} className="border-b border-dark-400/30 hover:bg-dark-600">
                  <td className="py-2 px-4 text-accent-400 font-medium">{d.name}</td>
                  <td className="text-right py-2 px-4 tabular-nums">{d.actual ? fmtRs(d.actual) : '--'}</td>
                  <td className="text-right py-2 px-4 tabular-nums">{fmtRs(d.forecast)}</td>
                  <td className="text-right py-2 px-4">
                    <span className={`text-xs font-semibold ${d.change.direction === 'up' ? 'text-emerald-400' : d.change.direction === 'down' ? 'text-red-500' : 'text-slate-400'}`}>
                      {d.change.direction === 'up' ? '↑' : d.change.direction === 'down' ? '↓' : ''} {fmtPct(d.change.pct)}
                    </span>
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-dark-400 font-semibold">
                <td className="py-2 px-4">Total</td>
                <td className="text-right py-2 px-4 tabular-nums">{fmtRs(breakdownData.reduce((s, d) => s + d.actual, 0))}</td>
                <td className="text-right py-2 px-4 tabular-nums">{fmtRs(breakdownData.reduce((s, d) => s + d.forecast, 0))}</td>
                <td className="text-right py-2 px-4">--</td>
              </tr>
            </tbody>
          </table>
        </div>
      );
    }

    // Aggregate charts
    const ChartComp = chartType === 'column' ? BarChart : chartType === 'line' ? LineChart : AreaChart;
    return (
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ChartComp data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" />
            <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8"
              tickFormatter={v => isPercent ? `${v.toFixed(0)}%` : fmtRs(v)} />
            <Tooltip
              formatter={(v: number, name: string) => [isPercent ? `${v.toFixed(1)}%` : fmtRs(v), name]}
              contentStyle={{ borderRadius: 8, fontSize: 12 }}
            />
            <Legend />
            {chartType === 'column' ? (
              <>
                <Bar dataKey="Actual" fill="#0d9488" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Forecast" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
              </>
            ) : chartType === 'line' ? (
              <>
                <Line type="monotone" dataKey="Actual" stroke="#0d9488" strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="Forecast" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} />
              </>
            ) : (
              <>
                <Area type="monotone" dataKey="Forecast" stroke="#94a3b8" fill="#94a3b820" strokeWidth={1.5} strokeDasharray="5 3" />
                <Area type="monotone" dataKey="Actual" stroke="#0d9488" fill="#0d948830" strokeWidth={2} />
              </>
            )}
          </ChartComp>
        </ResponsiveContainer>
      </div>
    );
  };

  return (
    <div>
      {/* Controls */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <select
            value={metricKey}
            onChange={e => setMetricKey(e.target.value)}
            className="input text-sm py-2 w-56"
          >
            {METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <button onClick={() => navigateMetric(-1)} className="flex items-center gap-1 hover:text-accent-400">
              <ChevronLeft size={14} />Previous metric
            </button>
            <span className="text-slate-300">|</span>
            <button onClick={() => navigateMetric(1)} className="flex items-center gap-1 hover:text-accent-400">
              Next metric<ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      {!isBreakdown && (
        <div className="card mb-4">
          <div className="grid grid-cols-3 divide-x divide-dark-400/50">
            <div className="px-4 py-2">
              <p className="text-xs text-slate-500 mb-1">Actual results</p>
              <p className="text-xl font-bold text-white">
                {isPercent ? `${(totalActual / (months.length || 1)).toFixed(1)}%` : fmtRs(totalActual)}
              </p>
            </div>
            <div className="px-4 py-2">
              <p className="text-xs text-slate-500 mb-1">Vs. forecast</p>
              <p className="text-xl font-bold flex items-center gap-1">
                <span className={vsForecast.direction === 'up' ? 'text-emerald-400' : vsForecast.direction === 'down' ? 'text-red-500' : 'text-slate-400'}>
                  {vsForecast.direction === 'up' ? '↑' : vsForecast.direction === 'down' ? '↓' : ''} {fmtPct(vsForecast.pct)}
                </span>
              </p>
            </div>
            <div className="px-4 py-2">
              <p className="text-xs text-slate-500 mb-1">Vs. previous period</p>
              <p className="text-xl font-bold text-slate-400">↑ 0%</p>
            </div>
          </div>
        </div>
      )}

      {/* Chart Type Selector + Comparison */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex bg-dark-500 rounded-lg p-1">
          {(isBreakdown ? BREAKDOWN_CHART_TYPES : AGG_CHART_TYPES).map(ct => (
            <button
              key={ct}
              onClick={() => setChartType(ct)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize ${
                chartType === ct ? 'bg-dark-700 shadow-sm text-accent-400' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {ct}
            </button>
          ))}
        </div>
        {!isBreakdown && (
          <select
            value={comparisonType}
            onChange={e => setComparisonType(e.target.value as any)}
            className="input text-xs py-1.5 w-40"
          >
            <option value="forecast">Vs. forecast</option>
            <option value="previous_period">Vs. previous period</option>
            <option value="previous_year">Vs. previous year</option>
          </select>
        )}
      </div>

      {/* Chart / Table */}
      <div className="card">
        {renderChart()}
      </div>
    </div>
  );
}
