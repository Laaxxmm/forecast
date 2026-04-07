import { useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { CheckCircle, Circle, AlertCircle } from 'lucide-react';
import { ForecastItem, Scenario, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  settings: Record<string, any>;
  scenario: Scenario | null;
}

const categories = [
  { key: 'revenue', label: 'Revenue', color: '#0d9488' },
  { key: 'direct_costs', label: 'Direct Costs', color: '#f59e0b' },
  { key: 'personnel', label: 'Personnel', color: '#6366f1' },
  { key: 'expenses', label: 'Expenses', color: '#ef4444' },
  { key: 'assets', label: 'Assets', color: '#8b5cf6' },
  { key: 'taxes', label: 'Taxes', color: '#64748b' },
  { key: 'dividends', label: 'Dividends', color: '#ec4899' },
  { key: 'financing', label: 'Financing', color: '#06b6d4' },
];

export default function ForecastOverview({ items, allValues, months, settings: _settings, scenario: _scenario }: Props) {
  const monthlyData = useMemo(() => {
    return months.map(m => {
      const revenue = items.filter(i => i.category === 'revenue').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const directCosts = items.filter(i => i.category === 'direct_costs').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const personnel = items.filter(i => i.category === 'personnel').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const expenses = items.filter(i => i.category === 'expenses').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const taxes = items.filter(i => i.category === 'taxes').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const totalCostsExpenses = directCosts + personnel + expenses + taxes;
      const netProfit = revenue - totalCostsExpenses;

      return { month: m, label: getMonthLabel(m), revenue, directCosts, personnel, expenses, taxes, totalCostsExpenses, netProfit };
    });
  }, [items, allValues, months]);

  const totals = useMemo(() => {
    const t = { revenue: 0, costs: 0, netProfit: 0 };
    monthlyData.forEach(r => {
      t.revenue += r.revenue;
      t.costs += r.totalCostsExpenses;
      t.netProfit += r.netProfit;
    });
    return t;
  }, [monthlyData]);

  const netProfitMargin = totals.revenue > 0 ? ((totals.netProfit / totals.revenue) * 100).toFixed(1) : '0.0';

  // Cash balance calculation
  let cumulativeCash = 0;
  const cashData = monthlyData.map(r => {
    cumulativeCash += r.netProfit;
    return { month: r.label, cash: cumulativeCash };
  });
  const lowestCash = cashData.reduce((min, d) => d.cash < min.cash ? d : min, cashData[0] || { month: '', cash: 0 });

  // Category completion status
  const categoryStatus = categories.map(c => {
    const catItems = items.filter(i => i.category === c.key);
    const hasValues = catItems.some(i => {
      const vals = allValues[i.id];
      return vals && Object.values(vals).some(v => v > 0);
    });
    return {
      ...c,
      status: catItems.length === 0 ? 'not_started' : hasValues ? 'complete' : 'in_progress',
      count: catItems.length,
    };
  });

  const chartData = monthlyData.map(r => ({
    month: r.label,
    Revenue: r.revenue,
    'Expenses & Costs': r.totalCostsExpenses,
    'Net Profit': r.netProfit,
  }));

  return (
    <div className="bg-slate-900 -mx-6 -mb-6 px-6 py-6 rounded-b-lg min-h-[80vh]">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-white">Forecast Overview</h2>
        <span className="text-sm text-slate-400">Forecast Only</span>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Left sidebar - checklist */}
        <div className="col-span-3">
          <div className="bg-slate-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Forecast Checklist</h3>
            <div className="space-y-2">
              {categoryStatus.map(c => (
                <div key={c.key} className="flex items-center gap-2 text-sm">
                  {c.status === 'complete' ? (
                    <CheckCircle size={16} className="text-emerald-400" />
                  ) : c.status === 'in_progress' ? (
                    <AlertCircle size={16} className="text-amber-400" />
                  ) : (
                    <Circle size={16} className="text-slate-500" />
                  )}
                  <span className={c.status === 'not_started' ? 'text-slate-500' : 'text-slate-300'}>
                    {c.label}
                  </span>
                  {c.count > 0 && <span className="text-xs text-slate-500 ml-auto">{c.count}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="col-span-9 space-y-6">
          {/* KPI Cards */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-slate-800 rounded-lg p-5">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">Net Profit</div>
              <div className={`text-2xl font-bold ${totals.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {formatRs(totals.netProfit)}
              </div>
            </div>
            <div className="bg-slate-800 rounded-lg p-5">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">Net Profit Margin</div>
              <div className="text-2xl font-bold text-white">{netProfitMargin}%</div>
            </div>
            <div className="bg-slate-800 rounded-lg p-5">
              <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">Cash Balance (End of Year)</div>
              <div className={`text-2xl font-bold ${cumulativeCash >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {formatRs(cumulativeCash)}
              </div>
            </div>
          </div>

          {/* Net Profit Chart */}
          <div className="bg-slate-800 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Revenue vs Expenses & Net Profit</h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#475569" />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#475569" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    formatter={(value: number) => [formatRs(value)]}
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: 8, color: '#e2e8f0', fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                  <Bar dataKey="Revenue" fill="#0d9488" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="Expenses & Costs" fill="#f59e0b" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="Net Profit" fill="#6366f1" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Cash Balance Chart */}
          <div className="bg-slate-800 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-300 mb-3">Cash Balance</h3>
            {lowestCash && lowestCash.cash < 0 && (
              <div className="text-xs text-amber-400 mb-2 flex items-center gap-1">
                <AlertCircle size={12} />
                In {lowestCash.month}, your cash will reach its lowest point of {formatRs(lowestCash.cash)}
              </div>
            )}
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={cashData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#475569" />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#475569" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    formatter={(value: number) => [formatRs(value), 'Cash Balance']}
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: 8, color: '#e2e8f0', fontSize: 12 }}
                  />
                  <Line type="monotone" dataKey="cash" stroke="#14b8a6" strokeWidth={2} dot={{ r: 3, fill: '#14b8a6' }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
