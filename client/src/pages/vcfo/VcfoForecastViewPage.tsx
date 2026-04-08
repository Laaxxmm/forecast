/**
 * VCFO Forecast View — Read-only view of forecast data from the Forecast module.
 * Shows P&L statement, overview KPIs, and monthly financial tables.
 * All data comes from the same tenant DB — no edits allowed here.
 */
import { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Lock, TrendingUp, Calendar, AlertCircle } from 'lucide-react';
import api from '../../api/client';

interface FY { id: number; label: string; start_date: string; end_date: string; is_active: number }
interface Scenario { id: number; fy_id: number; name: string; is_default: number }
interface ForecastItem {
  id: number; scenario_id: number; category: string; name: string;
  item_type: string | null; entry_mode: string; sort_order: number; meta: Record<string, any>;
}

function getFYMonths(startDate: string): string[] {
  const startYear = parseInt(startDate.slice(0, 4));
  const months: string[] = [];
  for (let m = 4; m <= 12; m++) months.push(`${startYear}-${String(m).padStart(2, '0')}`);
  for (let m = 1; m <= 3; m++) months.push(`${startYear + 1}-${String(m).padStart(2, '0')}`);
  return months;
}

function getMonthLabel(month: string): string {
  const [y, m] = month.split('-');
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(m)]} '${y.slice(-2)}`;
}

function formatRs(amount: number): string {
  if (amount === 0) return '-';
  const prefix = amount < 0 ? '-Rs' : 'Rs';
  return prefix + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(amount));
}

type ViewTab = 'overview' | 'pnl' | 'tables';

export default function VcfoForecastViewPage() {
  const [fys, setFYs] = useState<FY[]>([]);
  const [selectedFY, setSelectedFY] = useState<FY | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [items, setItems] = useState<ForecastItem[]>([]);
  const [allValues, setAllValues] = useState<Record<number, Record<string, number>>>({});
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [actuals, setActuals] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ViewTab>('overview');

  // Load FYs on mount
  useEffect(() => {
    api.get('/vcfo/forecast-view/financial-years').then(res => {
      setFYs(res.data);
      const active = res.data.find((f: FY) => f.is_active);
      setSelectedFY(active || res.data[0] || null);
    }).catch(() => {});
  }, []);

  // Load scenarios when FY changes
  useEffect(() => {
    if (!selectedFY) return;
    api.get('/vcfo/forecast-view/scenarios', { params: { fy_id: selectedFY.id } }).then(res => {
      setScenarios(res.data);
      const defaultS = res.data.find((s: Scenario) => s.is_default) || res.data[0];
      setSelectedScenario(defaultS || null);
    }).catch(() => setScenarios([]));
  }, [selectedFY]);

  // Load forecast data when scenario changes
  useEffect(() => {
    if (!selectedScenario) { setItems([]); setAllValues({}); setSettings({}); setLoading(false); return; }
    setLoading(true);
    api.get('/vcfo/forecast-view/summary', { params: { scenario_id: selectedScenario.id } }).then(res => {
      setItems(res.data.items || []);
      setAllValues(res.data.values || {});
      setSettings(res.data.settings || {});
      setActuals(res.data.actuals || {});
    }).catch(() => {}).finally(() => setLoading(false));
  }, [selectedScenario]);

  const months = selectedFY ? getFYMonths(selectedFY.start_date) : [];

  const noForecastData = !loading && items.length === 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <TrendingUp size={20} className="text-accent-400" />
          <h1 className="text-lg font-bold text-theme-heading">Forecast</h1>
          <span className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 px-2 py-1 rounded-lg">
            <Lock size={11} />
            View Only
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedScenario?.id || ''}
            onChange={e => {
              const s = scenarios.find(sc => sc.id === Number(e.target.value));
              if (s) setSelectedScenario(s);
            }}
            className="tv-input text-xs py-1.5 w-44"
          >
            {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select
            value={selectedFY?.id || ''}
            onChange={e => {
              const fy = fys.find(f => f.id === Number(e.target.value));
              if (fy) setSelectedFY(fy);
            }}
            className="tv-input text-xs py-1.5 w-32"
          >
            {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-1">
        {([
          { key: 'overview', label: 'Overview' },
          { key: 'pnl', label: 'Profit & Loss' },
          { key: 'tables', label: 'Financial Tables' },
        ] as { key: ViewTab; label: string }[]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`tv-tab ${activeTab === tab.key ? 'active' : ''}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="card-tv p-12 text-center text-theme-muted text-sm">Loading forecast data...</div>
      ) : noForecastData ? (
        <div className="card-tv p-12 text-center">
          <AlertCircle size={32} className="text-theme-faint mx-auto mb-3" />
          <p className="text-theme-muted text-sm font-medium">No forecast data available</p>
          <p className="text-theme-faint text-xs mt-1">Build a forecast in the Forecast module first. It will appear here automatically.</p>
        </div>
      ) : (
        <>
          {activeTab === 'overview' && <OverviewTab items={items} allValues={allValues} months={months} settings={settings} actuals={actuals} />}
          {activeTab === 'pnl' && <PnLTab items={items} allValues={allValues} months={months} settings={settings} />}
          {activeTab === 'tables' && <FinancialTablesTab items={items} allValues={allValues} months={months} />}
        </>
      )}
    </div>
  );
}

/* ─── Overview Tab ──────────────────────────────────────────── */
function OverviewTab({ items, allValues, months, settings, actuals }: {
  items: ForecastItem[]; allValues: Record<number, Record<string, number>>;
  months: string[]; settings: Record<string, any>; actuals: Record<string, Record<string, number>>;
}) {
  const employeeBenefitsPct = settings.employee_benefits_pct || 0;

  const monthlyData = useMemo(() => {
    return months.map(m => {
      const revenue = items.filter(i => i.category === 'revenue').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const directCosts = items.filter(i => i.category === 'direct_costs').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const personnel = items.filter(i => i.category === 'personnel').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const employeeTaxes = personnel * (employeeBenefitsPct / 100);
      const expenses = items.filter(i => i.category === 'expenses').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const taxes = items.filter(i => i.category === 'taxes').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const totalCosts = directCosts + personnel + employeeTaxes + expenses + taxes;
      const netProfit = revenue - totalCosts;

      // Sum actuals revenue for this month
      let actualRevenue = 0;
      for (const [key, monthVals] of Object.entries(actuals)) {
        if (key.startsWith('revenue::')) actualRevenue += (monthVals[m] || 0);
      }

      return { month: m, label: getMonthLabel(m), revenue, totalCosts, netProfit, actualRevenue };
    });
  }, [items, allValues, months, actuals, employeeBenefitsPct]);

  const totals = useMemo(() => {
    const t = { revenue: 0, costs: 0, netProfit: 0, actualRevenue: 0 };
    monthlyData.forEach(r => { t.revenue += r.revenue; t.costs += r.totalCosts; t.netProfit += r.netProfit; t.actualRevenue += r.actualRevenue; });
    return t;
  }, [monthlyData]);

  const margin = totals.revenue > 0 ? ((totals.netProfit / totals.revenue) * 100).toFixed(1) : '0.0';

  const chartData = monthlyData.map(r => ({
    month: r.label,
    'Forecast Revenue': r.revenue,
    'Forecast Costs': r.totalCosts,
    'Net Profit': r.netProfit,
    ...(r.actualRevenue > 0 ? { 'Actual Revenue': r.actualRevenue } : {}),
  }));

  const hasActuals = monthlyData.some(r => r.actualRevenue > 0);

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="card-tv p-4">
          <div className="text-[10px] text-theme-faint uppercase tracking-wider mb-1">Total Revenue</div>
          <div className="text-xl font-bold text-emerald-400">{formatRs(totals.revenue)}</div>
        </div>
        <div className="card-tv p-4">
          <div className="text-[10px] text-theme-faint uppercase tracking-wider mb-1">Total Costs</div>
          <div className="text-xl font-bold text-amber-400">{formatRs(totals.costs)}</div>
        </div>
        <div className="card-tv p-4">
          <div className="text-[10px] text-theme-faint uppercase tracking-wider mb-1">Net Profit</div>
          <div className={`text-xl font-bold ${totals.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatRs(totals.netProfit)}</div>
        </div>
        <div className="card-tv p-4">
          <div className="text-[10px] text-theme-faint uppercase tracking-wider mb-1">Net Margin</div>
          <div className="text-xl font-bold text-theme-heading">{margin}%</div>
        </div>
      </div>

      {/* Revenue vs Costs Chart */}
      <div className="card-tv p-4">
        <h3 className="text-sm font-semibold text-theme-secondary mb-3">
          Forecast Revenue vs Costs{hasActuals ? ' (with Actuals)' : ''}
        </h3>
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
              <Bar dataKey="Forecast Revenue" fill="#0d9488" radius={[2, 2, 0, 0]} />
              <Bar dataKey="Forecast Costs" fill="#f59e0b" radius={[2, 2, 0, 0]} />
              <Bar dataKey="Net Profit" fill="#6366f1" radius={[2, 2, 0, 0]} />
              {hasActuals && <Bar dataKey="Actual Revenue" fill="#22d3ee" radius={[2, 2, 0, 0]} />}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Category Breakdown */}
      <div className="card-tv p-4">
        <h3 className="text-sm font-semibold text-theme-secondary mb-3">Category Totals</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { key: 'revenue', label: 'Revenue', color: 'text-emerald-400' },
            { key: 'direct_costs', label: 'Direct Costs', color: 'text-amber-400' },
            { key: 'personnel', label: 'Personnel', color: 'text-indigo-400' },
            { key: 'expenses', label: 'Expenses', color: 'text-red-400' },
            { key: 'taxes', label: 'Taxes', color: 'text-slate-400' },
            { key: 'assets', label: 'Assets', color: 'text-purple-400' },
            { key: 'dividends', label: 'Dividends', color: 'text-pink-400' },
            { key: 'financing', label: 'Financing', color: 'text-cyan-400' },
          ].map(cat => {
            const catItems = items.filter(i => i.category === cat.key);
            const total = catItems.reduce((sum, item) => {
              return sum + months.reduce((ms, m) => ms + (allValues[item.id]?.[m] || 0), 0);
            }, 0);
            if (catItems.length === 0) return null;
            return (
              <div key={cat.key} className="bg-dark-600/50 rounded-lg p-3">
                <div className="text-[10px] text-theme-faint uppercase tracking-wider">{cat.label}</div>
                <div className={`text-base font-bold ${cat.color} mt-0.5`}>{formatRs(total)}</div>
                <div className="text-[10px] text-theme-faint">{catItems.length} item{catItems.length > 1 ? 's' : ''}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── P&L Tab ───────────────────────────────────────────────── */
function PnLTab({ items, allValues, months, settings }: {
  items: ForecastItem[]; allValues: Record<number, Record<string, number>>;
  months: string[]; settings: Record<string, any>;
}) {
  const employeeBenefitsPct = settings.employee_benefits_pct || 0;

  const revenueItems = items.filter(i => i.category === 'revenue');
  const directCostItems = items.filter(i => i.category === 'direct_costs');
  const personnelItems = items.filter(i => i.category === 'personnel');
  const expenseItems = items.filter(i => i.category === 'expenses');
  const taxItems = items.filter(i => i.category === 'taxes');

  const rows = useMemo(() => {
    return months.map(m => {
      const revenue = items.filter(i => i.category === 'revenue').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const directCosts = items.filter(i => i.category === 'direct_costs').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const grossProfit = revenue - directCosts;
      const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
      const personnel = items.filter(i => i.category === 'personnel').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const employeeTaxes = personnel * (employeeBenefitsPct / 100);
      const expenses = items.filter(i => i.category === 'expenses').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const totalOpex = personnel + employeeTaxes + expenses;
      const operatingIncome = grossProfit - totalOpex;
      const taxes = items.filter(i => i.category === 'taxes').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const netProfit = operatingIncome - taxes;
      return { month: m, revenue, directCosts, grossProfit, grossMargin, personnel, employeeTaxes, expenses, totalOpex, operatingIncome, taxes, netProfit };
    });
  }, [items, allValues, months, employeeBenefitsPct]);

  const totals = useMemo(() => {
    const t = { revenue: 0, directCosts: 0, grossProfit: 0, personnel: 0, employeeTaxes: 0, expenses: 0, totalOpex: 0, operatingIncome: 0, taxes: 0, netProfit: 0 };
    rows.forEach(r => {
      t.revenue += r.revenue; t.directCosts += r.directCosts; t.grossProfit += r.grossProfit;
      t.personnel += r.personnel; t.employeeTaxes += r.employeeTaxes; t.expenses += r.expenses;
      t.totalOpex += r.totalOpex; t.operatingIncome += r.operatingIncome; t.taxes += r.taxes; t.netProfit += r.netProfit;
    });
    return t;
  }, [rows]);

  // Chart
  const chartData = rows.map(r => ({ month: getMonthLabel(r.month), Revenue: r.revenue, 'Net Profit': r.netProfit }));

  type PnLRow = { label: string; key: string; isHeader?: boolean; isTotal?: boolean; indent?: number; pct?: boolean };
  const pnlRows: PnLRow[] = [
    { label: 'Revenue', key: 'revenue_h', isHeader: true },
    ...revenueItems.map(i => ({ label: i.name, key: `rev_${i.id}`, indent: 1 })),
    { label: 'Total Revenue', key: 'revenue_total', isTotal: true },
    { label: 'Direct Costs', key: 'dc_h', isHeader: true },
    ...directCostItems.map(i => ({ label: i.name, key: `dc_${i.id}`, indent: 1 })),
    { label: 'Total Direct Costs', key: 'dc_total', isTotal: true },
    { label: 'Gross Profit', key: 'grossProfit', isTotal: true },
    { label: 'Gross Margin (%)', key: 'grossMargin', pct: true },
    { label: 'Operating Expenses', key: 'opex_h', isHeader: true },
    ...personnelItems.map(i => ({ label: i.name, key: `pers_${i.id}`, indent: 1 })),
    { label: 'Employee Taxes & Benefits', key: 'employeeTaxes', indent: 1 },
    ...expenseItems.map(i => ({ label: i.name, key: `exp_${i.id}`, indent: 1 })),
    { label: 'Total Operating Expenses', key: 'totalOpex', isTotal: true },
    { label: 'Operating Income', key: 'operatingIncome', isTotal: true },
    ...taxItems.map(i => ({ label: i.name, key: `tax_${i.id}`, indent: 1 })),
    { label: 'Net Profit', key: 'netProfit', isTotal: true },
  ];

  const getRowValue = (row: PnLRow, month: string): number => {
    const idMatch = row.key.match(/^(rev|dc|pers|exp|tax)_(\d+)$/);
    if (idMatch) return allValues[parseInt(idMatch[2])]?.[month] || 0;
    const r = rows.find(x => x.month === month);
    if (!r) return 0;
    const map: Record<string, number> = {
      revenue_total: r.revenue, dc_total: r.directCosts, grossProfit: r.grossProfit,
      grossMargin: r.grossMargin, employeeTaxes: r.employeeTaxes, totalOpex: r.totalOpex,
      operatingIncome: r.operatingIncome, netProfit: r.netProfit,
    };
    return map[row.key] ?? 0;
  };

  return (
    <div className="space-y-4">
      {/* Chart */}
      <div className="card-tv p-4">
        <h3 className="text-sm font-semibold text-theme-secondary mb-3">Projected Profit & Loss</h3>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#475569" />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#475569" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: 8, color: '#e2e8f0', fontSize: 12 }} />
              <Area type="monotone" dataKey="Revenue" stroke="#0d9488" fill="#0d948820" strokeWidth={2} />
              <Area type="monotone" dataKey="Net Profit" stroke="#6366f1" fill="#6366f120" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* P&L Table */}
      <div className="card-tv overflow-x-auto p-0">
        <table className="tv-table w-full" style={{ minWidth: months.length * 100 + 280 }}>
          <thead>
            <tr>
              <th className="text-left py-3 px-4 sticky left-0 bg-dark-600 z-10 min-w-[250px]">Profit & Loss</th>
              {months.map(m => <th key={m} className="text-right py-3 px-3 whitespace-nowrap min-w-[100px]">{getMonthLabel(m)}</th>)}
              <th className="text-right py-3 px-4 bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {pnlRows.map(row => {
              if (row.isHeader) {
                return (
                  <tr key={row.key} className="bg-dark-600">
                    <td className="py-2.5 px-4 font-semibold text-theme-secondary sticky left-0 bg-dark-600 z-10">{row.label}</td>
                    <td colSpan={months.length + 1} />
                  </tr>
                );
              }
              const rowTotal = months.reduce((sum, m) => sum + getRowValue(row, m), 0);
              return (
                <tr key={row.key} className={row.isTotal ? 'font-semibold bg-dark-600/50' : ''}>
                  <td className={`py-2 px-4 text-theme-secondary sticky left-0 z-10 ${row.isTotal ? 'bg-dark-600/50 font-semibold' : 'bg-dark-700'} ${row.indent ? 'pl-8' : ''}`}>
                    {row.label}
                  </td>
                  {months.map(m => {
                    const val = getRowValue(row, m);
                    return (
                      <td key={m} className={`text-right py-2 px-3 tabular-nums ${val < 0 ? 'text-red-400' : 'text-theme-secondary'}`}>
                        {row.pct ? `${val.toFixed(1)}%` : (val !== 0 ? formatRs(val) : <span className="text-theme-faint">-</span>)}
                      </td>
                    );
                  })}
                  <td className={`text-right py-2 px-4 tabular-nums bg-dark-600 ${rowTotal < 0 ? 'text-red-400' : 'text-theme-heading'}`}>
                    {row.pct ? `${(totals.revenue > 0 ? (totals.grossProfit / totals.revenue * 100) : 0).toFixed(1)}%` : formatRs(rowTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Financial Tables Tab ──────────────────────────────────── */
function FinancialTablesTab({ items, allValues, months }: {
  items: ForecastItem[]; allValues: Record<number, Record<string, number>>; months: string[];
}) {
  const categories = [
    { key: 'revenue', label: 'Revenue', color: 'text-emerald-400' },
    { key: 'direct_costs', label: 'Direct Costs', color: 'text-amber-400' },
    { key: 'personnel', label: 'Personnel', color: 'text-indigo-400' },
    { key: 'expenses', label: 'Expenses', color: 'text-red-400' },
    { key: 'taxes', label: 'Taxes', color: 'text-slate-400' },
    { key: 'assets', label: 'Assets', color: 'text-purple-400' },
    { key: 'dividends', label: 'Dividends', color: 'text-pink-400' },
    { key: 'financing', label: 'Financing', color: 'text-cyan-400' },
  ];

  return (
    <div className="space-y-4">
      {categories.map(cat => {
        const catItems = items.filter(i => i.category === cat.key);
        if (catItems.length === 0) return null;

        const categoryTotal = (m: string) => catItems.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
        const grandTotal = months.reduce((s, m) => s + categoryTotal(m), 0);

        return (
          <div key={cat.key} className="card-tv overflow-x-auto p-0">
            <table className="tv-table w-full" style={{ minWidth: months.length * 90 + 250 }}>
              <thead>
                <tr>
                  <th className={`text-left py-2.5 px-4 sticky left-0 bg-dark-600 z-10 min-w-[220px] ${cat.color}`}>{cat.label}</th>
                  {months.map(m => <th key={m} className="text-right py-2.5 px-2 whitespace-nowrap text-xs min-w-[85px]">{getMonthLabel(m)}</th>)}
                  <th className="text-right py-2.5 px-4 bg-dark-500 min-w-[100px]">Total</th>
                </tr>
              </thead>
              <tbody>
                {catItems.map(item => {
                  const itemTotal = months.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0);
                  return (
                    <tr key={item.id}>
                      <td className="py-2 px-4 text-theme-secondary sticky left-0 bg-dark-700 z-10 text-sm">{item.name}</td>
                      {months.map(m => {
                        const val = allValues[item.id]?.[m] || 0;
                        return (
                          <td key={m} className={`text-right py-2 px-2 tabular-nums text-xs ${val < 0 ? 'text-red-400' : 'text-theme-secondary'}`}>
                            {val !== 0 ? formatRs(val) : <span className="text-theme-faint">-</span>}
                          </td>
                        );
                      })}
                      <td className={`text-right py-2 px-4 tabular-nums text-xs bg-dark-600 ${itemTotal < 0 ? 'text-red-400' : 'text-theme-heading'}`}>
                        {formatRs(itemTotal)}
                      </td>
                    </tr>
                  );
                })}
                {/* Category total row */}
                <tr className="font-semibold bg-dark-600/50">
                  <td className="py-2 px-4 text-theme-secondary sticky left-0 bg-dark-600/50 z-10 text-sm">Total {cat.label}</td>
                  {months.map(m => {
                    const val = categoryTotal(m);
                    return (
                      <td key={m} className={`text-right py-2 px-2 tabular-nums text-xs ${val < 0 ? 'text-red-400' : 'text-theme-heading'}`}>
                        {val !== 0 ? formatRs(val) : '-'}
                      </td>
                    );
                  })}
                  <td className={`text-right py-2 px-4 tabular-nums text-xs bg-dark-500 ${grandTotal < 0 ? 'text-red-400' : 'text-theme-heading'}`}>
                    {formatRs(grandTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
