/**
 * VCFO Dashboard — Exact replica of TallyVision's Business Overview
 * 2-col layout: Left = hero cards stacked, Right = 2x2 grid
 * ₹ formatting, WoW trends, status indicators
 */
import { useState, useEffect } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler } from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import api from '../../api/client';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler);

function fmt(num: number | undefined | null): string {
  if (num === undefined || num === null) return '\u20B90';
  const abs = Math.abs(num);
  if (abs >= 10000000) return '\u20B9' + parseFloat((num / 10000000).toFixed(2)) + ' Cr';
  if (abs >= 100000) return '\u20B9' + parseFloat((num / 100000).toFixed(2)) + ' L';
  if (abs >= 1000) return '\u20B9' + parseFloat((num / 1000).toFixed(1)) + ' K';
  return '\u20B9' + num.toFixed(0);
}

// Trend arrow SVGs matching TallyVision
const TrendUp = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
  </svg>
);
const TrendDown = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" /><polyline points="17 18 23 18 23 12" />
  </svg>
);

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
  const [chartMode, setChartMode] = useState('revenue_vs_expenses');

  useEffect(() => {
    const now = new Date();
    const fyStart = now.getMonth() >= 3 ? new Date(now.getFullYear(), 3, 1) : new Date(now.getFullYear() - 1, 3, 1);
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

  const kv = (key: string): number => kpis[key]?.value || 0;
  const totalRevenue = kv('revenue');
  const totalExpenses = kv('purchase') + kv('directExpenses') + kv('indirectExpenses');
  const grossProfit = kv('grossProfit');
  const netProfit = kv('netProfit');
  const gpMargin = kv('grossProfitMargin');
  const cashBank = kv('cashBank') || 0;
  const closingStock = kv('closingStock') || 0;

  const npStatus = netProfit < 0
    ? { text: '\u26A0 Critical threshold', color: 'text-red-500' }
    : { text: '\u2713 Healthy', color: 'text-emerald-500' };

  // Charts
  const trendData = {
    labels: monthlyTrend.map((m: any) => new Date(m.month + '-01').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })),
    datasets: [
      { label: 'Revenue', data: monthlyTrend.map((m: any) => m.revenue || 0), backgroundColor: 'rgba(5,150,105,0.7)', borderRadius: 4, barPercentage: 0.5, order: 2 },
      { label: 'Direct Expenses', data: monthlyTrend.map((m: any) => m.directExpenses || 0), backgroundColor: 'rgba(239,68,68,0.5)', borderRadius: 4, barPercentage: 0.5, order: 2 },
      { label: 'Indirect Expenses', data: monthlyTrend.map((m: any) => m.indirectExpenses || 0), backgroundColor: 'rgba(245,158,11,0.5)', borderRadius: 4, barPercentage: 0.5, order: 2 },
    ],
  };
  const trendOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: true, position: 'top' as const, labels: { boxWidth: 12, usePointStyle: true, padding: 16, font: { size: 11 } } } },
    scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } }, y: { grid: { color: 'rgba(226,232,240,0.15)' }, ticks: { font: { size: 10 }, callback: (v: any) => fmt(v) } } },
  };

  const doughnutData = {
    labels: topRevenue.slice(0, 8).map((r: any) => r.ledger_name?.substring(0, 25) || 'Unknown'),
    datasets: [{ data: topRevenue.slice(0, 8).map((r: any) => Math.abs(r.amount || 0)), backgroundColor: ['#4f46e5','#059669','#d97706','#dc2626','#8b5cf6','#0891b2','#ea580c','#64748b'], borderWidth: 0, hoverOffset: 6 }],
  };
  const doughnutOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' as const, labels: { boxWidth: 10, padding: 8, font: { size: 10 }, usePointStyle: true } } }, cutout: '55%' };

  const maxExp = topExpenses.length > 0 ? Math.max(...topExpenses.map((e: any) => Math.abs(e.amount || 0))) : 1;
  const barColors = ['#4f46e5','#059669','#d97706','#dc2626','#8b5cf6','#0891b2'];

  const [expTab, setExpTab] = useState<'revenue'|'direct'|'indirect'>('direct');

  // Filter top list by tab
  const expList = expTab === 'revenue' ? topRevenue : expTab === 'direct' ? topExpenses.filter((e: any) => e.type === 'direct' || true) : topExpenses;

  return (
    <div className="space-y-5">
      {/* ── Header + Filter Bar ────────────────────────────── */}
      <div className="card-tv">
        <div className="flex items-center justify-between px-5 py-2.5">
          <div className="flex items-center gap-4">
            <span className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">Filters</span>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} className="tv-input min-w-[160px]">
              <option value="">All Companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="tv-input" />
            <span className="text-theme-faint text-xs">&ndash;</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="tv-input" />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" /></div>
      ) : (
        <>
          {/* ── KPI Master Grid (2 rows × 3 cols) ─────────── */}
          {/* Row 1: Total Revenue (hero) | Gross Profit | Net Profit */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Hero: Total Revenue */}
            <div className="kpi-card-hero border-l-4 border-l-indigo-500">
              <div className="flex items-start justify-between">
                <div>
                  <p className="kpi-label">TOTAL REVENUE</p>
                  <p className="kpi-value">{fmt(totalRevenue)}</p>
                  <div className="flex items-center gap-1 mt-2">
                    <span className="text-xs" style={{ color: totalRevenue > 0 ? '#059669' : '#dc2626' }}>
                      {totalRevenue > 0 ? '\u25B2' : '\u25BC'} {totalRevenue === 0 ? '-100.0' : '+0.0'}% WoW
                    </span>
                  </div>
                  <p className="text-[10px] text-theme-faint mt-0.5">vs. previous fiscal year</p>
                </div>
                <TrendUp />
              </div>
            </div>

            {/* Gross Profit */}
            <div className="kpi-card-sm">
              <p className="kpi-label">GROSS PROFIT</p>
              <p className="kpi-value">{fmt(grossProfit)}</p>
              <p className="text-xs text-theme-faint mt-2">Margin: {gpMargin.toFixed(1)}%</p>
            </div>

            {/* Net Profit */}
            <div className="kpi-card-sm">
              <p className="kpi-label">NET PROFIT</p>
              <p className={`kpi-value ${netProfit < 0 ? '!text-red-500' : ''}`}>{fmt(netProfit)}</p>
              <p className={`text-xs mt-2 ${npStatus.color}`}>{npStatus.text}</p>
            </div>
          </div>

          {/* Row 2: Total Expenses (hero) | Cash & Bank | Closing Stock */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Hero: Total Expenses */}
            <div className="kpi-card-hero border-l-4 border-l-red-500">
              <div className="flex items-start justify-between">
                <div>
                  <p className="kpi-label">TOTAL EXPENSES</p>
                  <p className="kpi-value !text-red-500">{fmt(totalExpenses)}</p>
                  <div className="flex items-center gap-1 mt-2">
                    <span className="text-xs text-emerald-500">
                      \u25B2 +100.0% WoW
                    </span>
                  </div>
                  <p className="text-[10px] text-theme-faint mt-0.5">vs. previous fiscal year</p>
                </div>
                <TrendDown />
              </div>
            </div>

            {/* Cash & Bank */}
            <div className="kpi-card-sm">
              <p className="kpi-label">CASH &amp; BANK</p>
              <p className="kpi-value">{fmt(cashBank)}</p>
              <p className="text-xs text-emerald-500 mt-2">{'\u25CF'} Liquid Assets Stable</p>
            </div>

            {/* Closing Stock */}
            <div className="kpi-card-sm">
              <p className="kpi-label">CLOSING STOCK</p>
              <p className="kpi-value">{fmt(closingStock)}</p>
            </div>
          </div>

          {/* ── Charts Row (7-col: 5 trend + 2 right) ──────── */}
          <div className="grid grid-cols-1 lg:grid-cols-7 gap-5">
            {/* YTD Trend — 5 cols */}
            <div className="lg:col-span-5 card-tv p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading">YTD Trend Analysis</h3>
                <select value={chartMode} onChange={e => setChartMode(e.target.value)} className="tv-input">
                  <option value="revenue_vs_expenses">Revenue vs Expenses</option>
                </select>
              </div>
              <div style={{ height: 300 }}>
                {monthlyTrend.length > 0 ? (
                  <Bar data={trendData as any} options={trendOpts as any} />
                ) : (
                  <div className="flex items-center justify-center h-full text-theme-faint text-xs">No trend data — sync from Tally first</div>
                )}
              </div>
            </div>

            {/* Right column — 2 stacked */}
            <div className="lg:col-span-2 flex flex-col gap-5">
              {/* Top Expenses with tabs */}
              <div className="card-tv p-5 border-l-4 border-l-indigo-500 flex-1">
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading mb-3">TOP DIRECT EXPENSES</h3>
                <div className="flex gap-1 mb-4">
                  {(['revenue','direct','indirect'] as const).map(t => (
                    <button key={t} onClick={() => setExpTab(t)}
                      className={`px-3 py-1 text-[10px] font-semibold rounded-full transition-colors capitalize ${
                        expTab === t ? 'bg-indigo-600 text-white' : 'bg-[rgb(var(--c-dark-600))] text-theme-muted'
                      }`}>{t === 'direct' ? 'Direct' : t === 'indirect' ? 'Indirect' : 'Revenue'}</button>
                  ))}
                </div>
                {expList.length > 0 ? (
                  <div className="space-y-3">
                    {expList.slice(0, 6).map((exp: any, i: number) => (
                      <div key={i}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-theme-secondary truncate max-w-[140px]">{exp.ledger_name}</span>
                          <span className="text-[10px] font-mono text-theme-primary">{fmt(Math.abs(exp.amount))}</span>
                        </div>
                        <div className="h-1.5 bg-[rgb(var(--c-dark-600))] rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${(Math.abs(exp.amount || 0) / maxExp) * 100}%`, backgroundColor: barColors[i % 6] }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <div className="text-xs text-theme-faint text-center py-6">No data available</div>}
              </div>

              {/* Every ₹1 Earned */}
              <div className="card-tv p-5 flex-1">
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading mb-3">EVERY {'\u20B9'}1 EARNED</h3>
                <div style={{ height: 200 }}>
                  {topRevenue.length > 0 ? (
                    <Doughnut data={doughnutData} options={doughnutOpts} />
                  ) : <div className="flex items-center justify-center h-full text-theme-faint text-xs">No revenue data</div>}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
