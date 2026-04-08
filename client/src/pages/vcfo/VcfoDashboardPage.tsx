/**
 * VCFO Dashboard — Matches TallyVision's Business Overview panel
 * Hero KPI cards, 4-col grid, 7-col chart layout, expense bars
 */
import { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, DollarSign, ShoppingCart, Wallet, Package, ArrowUpRight, ArrowDownRight, BarChart3 } from 'lucide-react';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler } from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import api from '../../api/client';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler);

function fmt(n: number): string {
  if (!n) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10000000) return sign + (abs / 10000000).toFixed(2) + ' Cr';
  if (abs >= 100000) return sign + (abs / 100000).toFixed(2) + ' L';
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + ' K';
  return sign + abs.toFixed(0);
}

export default function VcfoDashboardPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [kpis, setKpis] = useState<Record<string, any>>({});
  const [monthlyTrend, setMonthlyTrend] = useState<any[]>([]);
  const [topRevenue, setTopRevenue] = useState<any[]>([]);
  const [topExpenses, setTopExpenses] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? new Date(now.getFullYear(), 3, 1)
      : new Date(now.getFullYear() - 1, 3, 1);
    const fyEnd = new Date(fyStart.getFullYear() + 1, 2, 31);
    setFromDate(fyStart.toISOString().split('T')[0]);
    setToDate(fyEnd.toISOString().split('T')[0]);
  }, []);

  useEffect(() => {
    api.get('/vcfo/companies').then(r => {
      setCompanies(r.data || []);
      if (r.data?.length > 0) setCompanyId(String(r.data[0].id));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!fromDate || !toDate) return;
    setLoading(true);
    const params: any = { from: fromDate, to: toDate };
    if (companyId) params.companyId = companyId;

    Promise.all([
      api.get('/vcfo/dashboard/kpi', { params }).catch(() => ({ data: {} })),
      api.get('/vcfo/dashboard/monthly-trend', { params }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/top-revenue', { params }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/top-expenses', { params }).catch(() => ({ data: [] })),
    ]).then(([kpiRes, trendRes, revRes, expRes]) => {
      setKpis(kpiRes.data || {});
      setMonthlyTrend(trendRes.data || []);
      setTopRevenue(revRes.data || []);
      setTopExpenses(expRes.data || []);
    }).finally(() => setLoading(false));
  }, [companyId, fromDate, toDate]);

  const hasData = Object.keys(kpis).length > 0;
  const kv = (key: string): number => kpis[key]?.value || 0;

  // Chart data
  const trendChartData = {
    labels: monthlyTrend.map((m: any) => {
      const d = new Date(m.month + '-01');
      return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    }),
    datasets: [
      {
        label: 'Revenue',
        data: monthlyTrend.map((m: any) => m.revenue || 0),
        backgroundColor: 'rgba(79, 70, 229, 0.7)',
        borderRadius: 4,
        barPercentage: 0.6,
        order: 2,
      },
      {
        label: 'Expenses',
        data: monthlyTrend.map((m: any) => m.expenses || 0),
        backgroundColor: 'rgba(220, 38, 38, 0.5)',
        borderRadius: 4,
        barPercentage: 0.6,
        order: 2,
      },
      {
        label: 'Net Profit',
        data: monthlyTrend.map((m: any) => (m.revenue || 0) - (m.expenses || 0)),
        type: 'line' as const,
        borderColor: '#059669',
        backgroundColor: 'rgba(5, 150, 105, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: '#059669',
        order: 1,
      },
    ],
  };

  const trendOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, position: 'top' as const, labels: { boxWidth: 12, usePointStyle: true, padding: 16, font: { size: 11 } } },
      tooltip: { mode: 'index' as const, intersect: false },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 } } },
      y: { grid: { color: 'rgba(226,232,240,0.15)' }, ticks: { font: { size: 10 }, callback: (v: any) => fmt(v) } },
    },
  };

  const doughnutData = {
    labels: topRevenue.slice(0, 8).map((r: any) => r.ledger_name?.substring(0, 20) || 'Unknown'),
    datasets: [{
      data: topRevenue.slice(0, 8).map((r: any) => Math.abs(r.amount || 0)),
      backgroundColor: ['#4f46e5', '#059669', '#d97706', '#dc2626', '#8b5cf6', '#0891b2', '#ea580c', '#64748b'],
      borderWidth: 0,
      hoverOffset: 6,
    }],
  };

  const doughnutOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom' as const, labels: { boxWidth: 10, padding: 8, font: { size: 10 }, usePointStyle: true } },
    },
    cutout: '55%',
  };

  const maxExp = topExpenses.length > 0 ? Math.max(...topExpenses.map((e: any) => Math.abs(e.amount || 0))) : 1;
  const barColors = ['#4f46e5', '#059669', '#d97706', '#dc2626', '#8b5cf6', '#0891b2'];

  return (
    <div className="space-y-5">
      {/* ── Filter Bar ───────────────────────────────────────── */}
      <div className="card-tv">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e293b]">
          <h1 className="text-lg font-bold text-theme-heading tracking-wide">VCFO Dashboard</h1>
          <span className="text-[10px] text-theme-faint uppercase tracking-wider">Financial Overview</span>
        </div>
        <div className="flex flex-wrap items-center gap-4 px-5 py-3">
          <span className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">Filters</span>
          <select value={companyId} onChange={e => setCompanyId(e.target.value)}
            className="tv-input min-w-[160px]">
            <option value="">All Companies</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="tv-input" />
            <span className="text-theme-faint text-xs">to</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="tv-input" />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" />
        </div>
      ) : (
        <>
          {/* ── Hero KPI Row ──────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="flex flex-col gap-4">
              <HeroCard label="TOTAL REVENUE" value={kv('revenue')} icon={DollarSign}
                accent="indigo" borderColor="border-l-indigo-500" />
              <HeroCard label="TOTAL EXPENSES" value={kv('purchase') + kv('directExpenses') + kv('indirectExpenses')} icon={ShoppingCart}
                accent="red" borderColor="border-l-red-500" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <KpiCard label="GROSS PROFIT" value={kv('grossProfit')} positive={kv('grossProfit') >= 0} icon={TrendingUp} />
              <KpiCard label="NET PROFIT" value={kv('netProfit')} positive={kv('netProfit') >= 0} icon={kv('netProfit') >= 0 ? TrendingUp : TrendingDown} />
              <KpiCard label="CASH & BANK" value={kv('cashBank') || 0} positive icon={Wallet} />
              <KpiCard label="CLOSING STOCK" value={kv('closingStock') || 0} positive icon={Package} />
            </div>
          </div>

          {/* ── Small KPIs ─────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SmallKpi label="SALES" value={kv('revenue')} />
            <SmallKpi label="DIRECT INCOME" value={kv('directIncome')} />
            <SmallKpi label="INDIRECT INCOME" value={kv('indirectIncome')} />
            <SmallKpi label="PURCHASE" value={kv('purchase')} negative />
            <SmallKpi label="DIRECT EXPENSES" value={kv('directExpenses')} negative />
            <SmallKpi label="INDIRECT EXPENSES" value={kv('indirectExpenses')} negative />
            <SmallKpi label="GP MARGIN" value={kv('grossProfitMargin')} suffix="%" isPercent />
            <SmallKpi label="NP MARGIN" value={kv('netProfitMargin')} suffix="%" isPercent />
          </div>

          {/* ── Charts (7-col layout) ─────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-7 gap-5">
            <div className="lg:col-span-5 card-tv p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-theme-heading">YTD Trend Analysis</h3>
                <span className="text-[10px] text-theme-faint">Revenue vs Expenses vs Net Profit</span>
              </div>
              <div style={{ height: 300 }}>
                {monthlyTrend.length > 0 ? (
                  <Bar data={trendChartData as any} options={trendOpts as any} />
                ) : (
                  <EmptyChart message="No trend data — sync from Tally first" />
                )}
              </div>
            </div>

            <div className="lg:col-span-2 flex flex-col gap-5">
              {/* Top Expenses with bar list */}
              <div className="card-tv p-5 border-l-4 border-l-emerald-500 flex-1">
                <h3 className="text-sm font-semibold text-theme-heading mb-4">Top Expenses</h3>
                {topExpenses.length > 0 ? (
                  <div className="space-y-3">
                    {topExpenses.slice(0, 6).map((exp: any, i: number) => (
                      <div key={i} className="flex items-center gap-3">
                        <span className="text-[10px] text-theme-secondary truncate min-w-[90px] max-w-[110px]">{exp.ledger_name}</span>
                        <div className="flex-1 h-2 bg-dark-600 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${(Math.abs(exp.amount || 0) / maxExp) * 100}%`, backgroundColor: barColors[i % 6] }} />
                        </div>
                        <span className="text-[10px] font-mono text-theme-primary min-w-[55px] text-right">{fmt(Math.abs(exp.amount))}</span>
                      </div>
                    ))}
                  </div>
                ) : <EmptyChart message="No expense data" />}
              </div>

              {/* Revenue Doughnut */}
              <div className="card-tv p-5 flex-1">
                <h3 className="text-sm font-semibold text-theme-heading mb-3">Every Rupee Earned</h3>
                <div style={{ height: 200 }}>
                  {topRevenue.length > 0 ? (
                    <Doughnut data={doughnutData} options={doughnutOpts} />
                  ) : <EmptyChart message="No revenue data" />}
                </div>
              </div>
            </div>
          </div>

          {/* Empty state CTA */}
          {!hasData && (
            <div className="card-tv p-12 text-center">
              <BarChart3 size={48} className="mx-auto mb-4 text-theme-faint opacity-30" />
              <h3 className="text-base font-semibold text-theme-heading mb-2">No Financial Data Yet</h3>
              <p className="text-sm text-theme-muted mb-4">Connect to Tally and sync your data to see the dashboard.</p>
              <a href="/vcfo/sync" className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                Go to Tally Sync <ArrowUpRight size={14} />
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function HeroCard({ label, value, icon: Icon, accent, borderColor }: {
  label: string; value: number; icon: any; accent: string; borderColor: string;
}) {
  const isIndigo = accent === 'indigo';
  return (
    <div className={`card-tv p-7 border-l-4 ${borderColor} hover:-translate-y-0.5 hover:shadow-lg transition-all`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-widest text-theme-faint mb-2">{label}</p>
          <p className="text-2xl font-extrabold text-theme-heading">{fmt(value)}</p>
        </div>
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isIndigo ? 'bg-indigo-500/10' : 'bg-red-500/10'}`}>
          <Icon size={22} className={isIndigo ? 'text-indigo-400' : 'text-red-400'} />
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, positive, icon: Icon }: {
  label: string; value: number; positive: boolean; icon: any;
}) {
  return (
    <div className="card-tv p-5 hover:-translate-y-0.5 hover:shadow-md transition-all">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${positive ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
          <Icon size={15} className={positive ? 'text-emerald-400' : 'text-red-400'} />
        </div>
        <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">{label}</p>
      </div>
      <p className={`text-xl font-bold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(value)}</p>
    </div>
  );
}

function SmallKpi({ label, value, negative, suffix, isPercent }: {
  label: string; value: number; negative?: boolean; suffix?: string; isPercent?: boolean;
}) {
  const display = isPercent ? (value?.toFixed(1) || '0.0') : fmt(value);
  const color = negative ? 'text-red-400' : isPercent ? (value >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-theme-heading';
  return (
    <div className="card-tv px-4 py-3 hover:-translate-y-0.5 hover:shadow-md transition-all">
      <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint mb-1">{label}</p>
      <p className={`text-base font-bold ${color}`}>{display}{suffix || ''}</p>
    </div>
  );
}

function EmptyChart({ message }: { message: string }) {
  return <div className="flex items-center justify-center h-full text-theme-faint text-xs">{message}</div>;
}
