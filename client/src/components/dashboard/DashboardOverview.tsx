import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
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

const COLORS = ['#0d9488', '#06b6d4', '#6366f1', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

function ChangeIndicator({ pct, direction }: { pct: number; direction: 'up' | 'down' | 'neutral' }) {
  if (direction === 'neutral') return <span className="flex items-center gap-1 text-xs text-slate-400"><Minus size={12} />0%</span>;
  const isUp = direction === 'up';
  return (
    <span className={`flex items-center gap-0.5 text-xs font-semibold ${isUp ? 'text-emerald-600' : 'text-red-500'}`}>
      {isUp ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
      {fmtPct(pct)}
    </span>
  );
}

function MetricCard({ title, actual, forecast, change, periodLabel, onClick, wide, children }: {
  title: string;
  actual: number | string;
  forecast: number;
  change: { pct: number; direction: 'up' | 'down' | 'neutral' };
  periodLabel: string;
  onClick?: () => void;
  wide?: boolean;
  children?: React.ReactNode;
}) {
  const hasData = typeof actual === 'number';
  return (
    <div
      onClick={onClick}
      className={`card cursor-pointer hover:shadow-md transition-shadow ${wide ? 'col-span-1' : ''}`}
    >
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-600">{title}</h3>
        <ChangeIndicator pct={change.pct} direction={change.direction} />
      </div>
      <p className="text-2xl font-bold text-slate-800 mb-3">
        {hasData ? (typeof actual === 'number' ? fmtRs(actual) : actual) : '--'}
      </p>
      {children || (
        <div className="h-20">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={[
              { name: 'Actual', value: hasData ? (typeof actual === 'number' ? actual : 0) : 0 },
              { name: 'Forecast', value: typeof forecast === 'number' ? forecast : 0 },
            ]} barSize={32}>
              <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="#94a3b8" />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                <Cell fill="#0d9488" />
                <Cell fill="#cbd5e1" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-primary-500" />Actual ({periodLabel})</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-slate-300" />Forecast ({periodLabel})</span>
      </div>
    </div>
  );
}

export default function DashboardOverview({ items, allValues, months, settings, actuals, selectedFY }: Props) {
  const navigate = useNavigate();
  const periodOptions = useMemo(() => selectedFY ? buildPeriodOptions(selectedFY.start_date) : [], [selectedFY]);
  const [selectedPeriod, setSelectedPeriod] = useState('full_year');
  const [comparison, setComparison] = useState<'forecast' | 'previous_period' | 'previous_year'>('forecast');

  const periodMonths = useMemo(() => {
    const opt = periodOptions.find(p => p.value === selectedPeriod);
    return opt?.months || months;
  }, [selectedPeriod, periodOptions, months]);

  const periodLabel = useMemo(() => {
    if (periodMonths.length === 0) return '';
    if (periodMonths.length === 1) return monthLabel(periodMonths[0]);
    return `${monthLabel(periodMonths[0])} - ${monthLabel(periodMonths[periodMonths.length - 1])}`;
  }, [periodMonths]);

  if (months.length === 0) {
    return <div className="text-center py-20 text-slate-400">Loading dashboard...</div>;
  }

  const benefitsPct = settings.employee_benefits_pct || 0;

  // Forecast values
  const fRevenue = sumForecastCat(items, 'revenue', allValues, periodMonths);
  const fDirectCosts = sumForecastCat(items, 'direct_costs', allValues, periodMonths);
  const fPersonnel = sumForecastCat(items, 'personnel', allValues, periodMonths);
  const fExpenses = sumForecastCat(items, 'expenses', allValues, periodMonths);
  const fTaxes = sumForecastCat(items, 'taxes', allValues, periodMonths);
  const fAssets = sumForecastCat(items, 'assets', allValues, periodMonths);
  const fAllCosts = fDirectCosts + fPersonnel + Math.round(fPersonnel * benefitsPct / 100) + fExpenses;
  const fGrossProfit = fRevenue - fDirectCosts;
  const fOpIncome = fGrossProfit - fPersonnel - Math.round(fPersonnel * benefitsPct / 100) - fExpenses;
  const fOpMargin = fRevenue > 0 ? (fOpIncome / fRevenue) * 100 : 0;
  const fNetProfit = fOpIncome - fTaxes;
  const fNetMargin = fRevenue > 0 ? (fNetProfit / fRevenue) * 100 : 0;
  const fCashBalance = fNetProfit - fAssets;
  const fNetCashFlow = fNetProfit - fAssets;

  // Actual values
  const aRevenue = sumActualsCat(actuals, 'revenue', periodMonths);
  const aDirectCosts = sumActualsCat(actuals, 'direct_costs', periodMonths);
  const aPersonnel = sumActualsCat(actuals, 'personnel', periodMonths);
  const aExpenses = sumActualsCat(actuals, 'expenses', periodMonths);
  const aTaxes = sumActualsCat(actuals, 'taxes', periodMonths);
  const aAssets = sumActualsCat(actuals, 'assets', periodMonths);
  const aAllCosts = aDirectCosts + aPersonnel + aExpenses;
  const aOpIncome = aRevenue - aDirectCosts - aPersonnel - aExpenses;
  const aOpMargin = aRevenue > 0 ? (aOpIncome / aRevenue) * 100 : 0;
  const aNetProfit = aOpIncome - aTaxes;
  const aNetMargin = aRevenue > 0 ? (aNetProfit / aRevenue) * 100 : 0;
  const aCashBalance = aNetProfit - aAssets;
  const aNetCashFlow = aNetProfit - aAssets;

  const hasActuals = Object.keys(actuals).length > 0;

  // Revenue breakdown chart data
  const revItems = items.filter(i => i.category === 'revenue');
  const revBreakdown = revItems.map((item, idx) => ({
    name: item.name,
    value: periodMonths.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0),
    fill: COLORS[idx % COLORS.length],
  })).filter(d => d.value > 0);

  // Expense breakdown
  const expCategories = [
    { label: 'Direct Costs', val: hasActuals ? aDirectCosts : fDirectCosts },
    { label: 'Personnel', val: hasActuals ? aPersonnel : fPersonnel },
    { label: 'Expenses', val: hasActuals ? aExpenses : fExpenses },
    { label: 'Taxes', val: hasActuals ? aTaxes : fTaxes },
  ].filter(d => d.val > 0).map((d, i) => ({ ...d, name: d.label, value: d.val, fill: COLORS[i % COLORS.length] }));

  const goTrend = (metric: string) => navigate(`/analysis/trends?metric=${metric}`);

  return (
    <div>
      {/* Filter Bar */}
      <div className="flex items-center gap-3 mb-6">
        <select
          value={selectedPeriod}
          onChange={e => setSelectedPeriod(e.target.value)}
          className="input text-sm py-2 w-64"
        >
          {periodOptions.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500 font-medium">vs.</span>
        <select
          value={comparison}
          onChange={e => setComparison(e.target.value as any)}
          className="input text-sm py-2 w-44"
        >
          <option value="forecast">Forecast</option>
          <option value="previous_period">Previous period</option>
          <option value="previous_year">Previous year</option>
        </select>
      </div>

      {/* Row 1: Revenue & Expenses */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <MetricCard
          title="Revenue"
          actual={hasActuals ? aRevenue : 0}
          forecast={fRevenue}
          change={hasActuals ? calcChange(aRevenue, fRevenue) : { pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('revenue')}
          wide
        />
        <MetricCard
          title="Expenses & Costs"
          actual={hasActuals ? aAllCosts : 0}
          forecast={fAllCosts}
          change={hasActuals ? calcChange(aAllCosts, fAllCosts) : { pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('expenses')}
          wide
        />
      </div>

      {/* Row 2: Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="card">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">Revenue Breakdown</h3>
          {revBreakdown.length > 0 ? (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={revBreakdown} cx="50%" cy="50%" outerRadius={75} innerRadius={40} dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {revBreakdown.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtRs(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-52 flex items-center justify-center text-slate-400 text-sm">No data available</div>
          )}
        </div>
        <div className="card">
          <h3 className="text-sm font-semibold text-slate-600 mb-3">Expense & Cost Breakdown</h3>
          {expCategories.length > 0 ? (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={expCategories} cx="50%" cy="50%" outerRadius={75} innerRadius={40} dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {expCategories.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtRs(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-52 flex items-center justify-center text-slate-400 text-sm">No data available</div>
          )}
        </div>
      </div>

      {/* Row 3: Operating metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <MetricCard
          title="Operating Income"
          actual={hasActuals ? aOpIncome : 0}
          forecast={fOpIncome}
          change={hasActuals ? calcChange(aOpIncome, fOpIncome) : { pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('operating_income')}
        />
        <MetricCard
          title="Operating Margin"
          actual={hasActuals ? `${aOpMargin.toFixed(1)}%` : '0%'}
          forecast={fOpMargin}
          change={hasActuals ? calcChange(aOpMargin, fOpMargin) : { pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('operating_margin')}
        />
        <MetricCard
          title="Net Profit"
          actual={hasActuals ? aNetProfit : 0}
          forecast={fNetProfit}
          change={hasActuals ? calcChange(aNetProfit, fNetProfit) : { pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('net_profit')}
        />
      </div>

      {/* Row 4: Net Profit Margin */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <MetricCard
          title="Net Profit Margin"
          actual={hasActuals ? `${aNetMargin.toFixed(1)}%` : '0%'}
          forecast={fNetMargin}
          change={hasActuals ? calcChange(aNetMargin, fNetMargin) : { pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('net_margin')}
        />
      </div>

      {/* Row 5: Cash */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <MetricCard
          title="Cash Balance"
          actual={hasActuals ? aCashBalance : 0}
          forecast={fCashBalance}
          change={hasActuals ? calcChange(aCashBalance, fCashBalance) : { pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('cash_balance')}
          wide
        />
        <MetricCard
          title="Net Cash Flow"
          actual={hasActuals ? aNetCashFlow : 0}
          forecast={fNetCashFlow}
          change={hasActuals ? calcChange(aNetCashFlow, fNetCashFlow) : { pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('net_cash_flow')}
          wide
        />
      </div>

      {/* Row 6: Receivables & Payables */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <MetricCard
          title="Accounts Receivable"
          actual={0}
          forecast={0}
          change={{ pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('accounts_receivable')}
        />
        <MetricCard
          title="Days to Get Paid"
          actual={'--' as any}
          forecast={0}
          change={{ pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('days_to_get_paid')}
        />
        <MetricCard
          title="Accounts Payable"
          actual={0}
          forecast={0}
          change={{ pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('accounts_payable')}
        />
      </div>

      {/* Row 7: Days to pay */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <MetricCard
          title="Days to Pay"
          actual={'--' as any}
          forecast={0}
          change={{ pct: 0, direction: 'neutral' }}
          periodLabel={periodLabel}
          onClick={() => goTrend('days_to_pay')}
        />
      </div>
    </div>
  );
}
