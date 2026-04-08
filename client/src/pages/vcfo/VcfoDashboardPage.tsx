/**
 * VCFO Dashboard — Full-featured Business Overview
 * Matches TallyVision's dashboard: KPI cards, trend charts, expense breakdowns,
 * receivable/payable ageing, geo filters, company/group selectors.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, ArcElement, Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Bar, Line, Doughnut } from 'react-chartjs-2';
import api from '../../api/client';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler);

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return '\u20B90';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 10000000) return sign + '\u20B9' + parseFloat((abs / 10000000).toFixed(2)) + ' Cr';
  if (abs >= 100000) return sign + '\u20B9' + parseFloat((abs / 100000).toFixed(2)) + ' L';
  if (abs >= 1000) return sign + '\u20B9' + parseFloat((abs / 1000).toFixed(1)) + ' K';
  return sign + '\u20B9' + abs.toFixed(0);
}

function pct(val: number | undefined | null): string {
  if (!val || isNaN(val)) return '0.0%';
  return val.toFixed(1) + '%';
}

function monthLabel(m: string): string {
  try {
    return new Date(m + '-01').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  } catch { return m; }
}

// ── SVG trend indicators ──────────────────────────────────────────────────────

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

// ── Chart colors ──────────────────────────────────────────────────────────────

const COLORS = {
  green: 'rgba(5,150,105,0.75)', red: 'rgba(220,38,38,0.6)', amber: 'rgba(217,119,6,0.6)',
  blue: 'rgba(59,130,246,0.75)', purple: 'rgba(139,92,246,0.6)',
  greenLine: '#22c55e', blueLine: '#3b82f6',
  ageGreen: 'rgba(134,239,172,0.75)', ageYellow: 'rgba(253,230,138,0.8)',
  ageOrange: 'rgba(253,186,116,0.8)', ageRed: 'rgba(252,165,165,0.8)',
};
const BAR_PALETTE = ['#4f46e5', '#059669', '#d97706', '#dc2626', '#8b5cf6', '#0891b2', '#ea580c', '#64748b'];

// ── Component ─────────────────────────────────────────────────────────────────

export default function VcfoDashboardPage() {
  // Data state
  const [companies, setCompanies] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [kpis, setKpis] = useState<any>({});
  const [prevKpis, setPrevKpis] = useState<any>({});
  const [monthlyTrend, setMonthlyTrend] = useState<any[]>([]);
  const [topRevenue, setTopRevenue] = useState<any[]>([]);
  const [topDirectExp, setTopDirectExp] = useState<any[]>([]);
  const [topIndirectExp, setTopIndirectExp] = useState<any[]>([]);
  const [receivableAgeing, setReceivableAgeing] = useState<any[]>([]);
  const [payableAgeing, setPayableAgeing] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Filter state
  const [companyId, setCompanyId] = useState<string>('');
  const [groupId, setGroupId] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // UI state
  const [trendMode, setTrendMode] = useState<'rev_exp' | 'gp_np'>('rev_exp');
  const [expTab, setExpTab] = useState<'revenue' | 'direct' | 'indirect'>('direct');

  // ── Init dates (current FY) ────────────────────────────────────────────────
  useEffect(() => {
    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? new Date(now.getFullYear(), 3, 1)
      : new Date(now.getFullYear() - 1, 3, 1);
    const fyEnd = new Date(fyStart.getFullYear() + 1, 2, 31);
    setFromDate(fyStart.toISOString().split('T')[0]);
    setToDate(fyEnd.toISOString().split('T')[0]);
  }, []);

  // ── Load companies + groups ────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      api.get('/vcfo/companies').catch(() => ({ data: [] })),
      api.get('/vcfo/groups').catch(() => ({ data: [] })),
    ]).then(([compRes, grpRes]) => {
      const comps = compRes.data || [];
      setCompanies(comps);
      setGroups(grpRes.data || []);
      // Auto-select first group if available, else first company
      if (grpRes.data?.length > 0) {
        setGroupId(String(grpRes.data[0].id));
      } else if (comps.length > 0) {
        setCompanyId(String(comps[0].id));
      }
    });
  }, []);

  // ── Compute previous period dates ─────────────────────────────────────────
  const getPrevDates = useCallback(() => {
    if (!fromDate || !toDate) return { prevFrom: '', prevTo: '' };
    const f = new Date(fromDate);
    const t = new Date(toDate);
    const diffMs = t.getTime() - f.getTime();
    const prevTo = new Date(f.getTime() - 86400000); // day before fromDate
    const prevFrom = new Date(prevTo.getTime() - diffMs);
    return {
      prevFrom: prevFrom.toISOString().split('T')[0],
      prevTo: prevTo.toISOString().split('T')[0],
    };
  }, [fromDate, toDate]);

  // ── Load dashboard data ───────────────────────────────────────────────────
  useEffect(() => {
    if (!fromDate || !toDate) return;
    if (!companyId && !groupId) return;

    setLoading(true);
    const params: any = { from: fromDate, to: toDate };
    if (companyId) params.companyId = companyId;
    if (groupId) params.groupId = groupId;

    // For trend query, always use FY range
    const trendParams = { ...params, fromDate: fromDate, toDate: toDate };
    const { prevFrom, prevTo } = getPrevDates();
    const prevParams = prevFrom ? { ...params, from: prevFrom, to: prevTo } : null;

    const requests = [
      api.get('/vcfo/dashboard/kpi', { params }).catch(() => ({ data: { kpis: {} } })),
      api.get('/vcfo/dashboard/monthly-trend', { params }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/top-revenue', { params }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/top-direct-expenses', { params: trendParams }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/top-indirect-expenses', { params: trendParams }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/receivable-ageing', { params }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/payable-ageing', { params }).catch(() => ({ data: [] })),
    ];

    // Previous period KPI for comparison
    if (prevParams) {
      requests.push(api.get('/vcfo/dashboard/kpi', { params: prevParams }).catch(() => ({ data: { kpis: {} } })));
    }

    Promise.all(requests).then(([kpiRes, trendRes, revRes, deRes, ieRes, arRes, apRes, prevKpiRes]) => {
      setKpis(kpiRes.data?.kpis || {});
      setMonthlyTrend(trendRes.data || []);
      setTopRevenue(revRes.data || []);
      setTopDirectExp(deRes.data || []);
      setTopIndirectExp(ieRes.data || []);
      setReceivableAgeing(arRes.data || []);
      setPayableAgeing(apRes.data || []);
      if (prevKpiRes) setPrevKpis(prevKpiRes.data?.kpis || {});
    }).finally(() => setLoading(false));
  }, [companyId, groupId, fromDate, toDate, getPrevDates]);

  // ── Derived KPI values ────────────────────────────────────────────────────
  const k = kpis;
  const pk = prevKpis;
  const totalRevenue = (k.revenue || 0) + (k.directIncome || 0) + (k.indirectIncome || 0);
  const totalExpenses = (k.purchase || 0) + (k.directExpenses || 0) + (k.indirectExpenses || 0);
  const grossProfit = k.grossProfit || 0;
  const netProfit = k.netProfit || 0;
  const gpMargin = k.grossProfitMargin || 0;
  const npMargin = k.netProfitMargin || 0;
  const cashBank = k.cashBankBalance || 0;
  const closingStock = k.closingStock || 0;

  // Previous period for change%
  const prevTotalRev = (pk.revenue || 0) + (pk.directIncome || 0) + (pk.indirectIncome || 0);
  const prevTotalExp = (pk.purchase || 0) + (pk.directExpenses || 0) + (pk.indirectExpenses || 0);

  function changeStr(current: number, previous: number): { text: string; positive: boolean } {
    if (!previous) return { text: 'N/A', positive: current >= 0 };
    const change = ((current - previous) / Math.abs(previous)) * 100;
    return {
      text: `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`,
      positive: change >= 0,
    };
  }

  const revChange = changeStr(totalRevenue, prevTotalRev);
  const expChange = changeStr(totalExpenses, prevTotalExp);

  // Period label
  const periodLabel = (() => {
    if (!fromDate || !toDate) return '';
    const f = new Date(fromDate);
    const t = new Date(toDate);
    const diffDays = (t.getTime() - f.getTime()) / 86400000;
    if (diffDays <= 10) return 'WoW';
    if (diffDays <= 45) return 'MoM';
    if (diffDays <= 100) return 'QoQ';
    return 'YoY';
  })();

  // Net profit status
  const npStatus = netProfit < 0
    ? { text: '\u26A0 Critical threshold', color: 'text-red-400' }
    : { text: '\u2713 Healthy', color: 'text-emerald-400' };

  // ── Expense bar list data ─────────────────────────────────────────────────
  const expList = expTab === 'revenue' ? topRevenue : expTab === 'direct' ? topDirectExp : topIndirectExp;
  const maxExpVal = expList.length > 0
    ? Math.max(...expList.map((e: any) => Math.abs(e.total || e.amount || 0)))
    : 1;

  // ── Trend chart data ──────────────────────────────────────────────────────
  const trendLabels = monthlyTrend.map((m: any) => monthLabel(m.month));

  const revExpChartData = {
    labels: trendLabels,
    datasets: [
      { label: 'Revenue', data: monthlyTrend.map((m: any) => m.revenue || 0), backgroundColor: COLORS.green, borderRadius: 6, barPercentage: 0.5, order: 2 },
      { label: 'Direct Expenses', data: monthlyTrend.map((m: any) => m.expenses || 0), backgroundColor: COLORS.red, borderRadius: 6, barPercentage: 0.5, order: 2 },
    ],
  };

  const gpNpChartData = {
    labels: trendLabels,
    datasets: [
      {
        label: 'GP %', data: monthlyTrend.map((m: any) => m.revenue ? ((m.grossProfit || 0) / m.revenue * 100) : 0),
        borderColor: COLORS.greenLine, backgroundColor: 'rgba(34,197,94,0.12)', fill: true, tension: 0.4, pointRadius: 3,
      },
      {
        label: 'NP %', data: monthlyTrend.map((m: any) => m.revenue ? ((m.netProfit || 0) / m.revenue * 100) : 0),
        borderColor: COLORS.blueLine, backgroundColor: 'rgba(59,130,246,0.12)', fill: true, tension: 0.4, pointRadius: 3,
      },
    ],
  };

  const chartOpts: any = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: true, position: 'top' as const, labels: { boxWidth: 12, usePointStyle: true, padding: 16, font: { size: 11 }, color: '#94a3b8' } },
      tooltip: { callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${trendMode === 'gp_np' ? ctx.parsed.y.toFixed(1) + '%' : fmt(ctx.parsed.y)}` } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#94a3b8' } },
      y: { grid: { color: 'rgba(30,41,59,0.4)' }, ticks: { font: { size: 10 }, color: '#94a3b8', callback: (v: any) => trendMode === 'gp_np' ? v + '%' : fmt(v) } },
    },
  };

  // ── Every ₹1 Earned (Doughnut) ────────────────────────────────────────────
  const directExp = Math.abs(k.purchase || 0) + Math.abs(k.directExpenses || 0);
  const indirectExp = Math.abs(k.indirectExpenses || 0);
  const profit = totalRevenue - directExp - indirectExp;

  const rupeeData = {
    labels: ['Direct Expenses', 'Indirect Expenses', profit >= 0 ? 'Profit' : 'Loss'],
    datasets: [{
      data: [directExp, indirectExp, Math.abs(profit)],
      backgroundColor: ['#dc2626', '#d97706', profit >= 0 ? '#059669' : '#ef4444'],
      borderWidth: 0, hoverOffset: 6,
    }],
  };
  const rupeeOpts: any = {
    responsive: true, maintainAspectRatio: false, cutout: '60%',
    plugins: {
      legend: { position: 'bottom' as const, labels: { boxWidth: 10, padding: 8, font: { size: 10 }, usePointStyle: true, color: '#94a3b8' } },
      tooltip: {
        callbacks: {
          label: (ctx: any) => {
            const total = ctx.dataset.data.reduce((a: number, b: number) => a + b, 0);
            const p = total ? ((ctx.raw / total) * 100).toFixed(1) : '0';
            return `${ctx.label}: ${p}% (${fmt(ctx.raw)})`;
          },
        },
      },
    },
  };

  // ── Ageing chart builder ──────────────────────────────────────────────────
  const buildAgeingChart = (data: any[]) => {
    const labels = data.slice(0, 10).map((r: any) => {
      const name = r.party_name || '';
      return name.length > 22 ? name.substring(0, 22) + '...' : name;
    });
    return {
      data: {
        labels,
        datasets: [
          { label: '0-30 days', data: data.slice(0, 10).map((r: any) => r['0_30'] || 0), backgroundColor: COLORS.ageGreen, borderRadius: 6 },
          { label: '31-60 days', data: data.slice(0, 10).map((r: any) => r['31_60'] || 0), backgroundColor: COLORS.ageYellow, borderRadius: 6 },
          { label: '61-90 days', data: data.slice(0, 10).map((r: any) => r['61_90'] || 0), backgroundColor: COLORS.ageOrange, borderRadius: 6 },
          { label: '90+ days', data: data.slice(0, 10).map((r: any) => r['90_plus'] || 0), backgroundColor: COLORS.ageRed, borderRadius: 6 },
        ],
      },
      options: {
        indexAxis: 'y' as const, responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top' as const, labels: { boxWidth: 10, padding: 10, font: { size: 10 }, usePointStyle: true, color: '#94a3b8' } },
          tooltip: { callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${fmt(ctx.raw)}` } },
        },
        scales: {
          x: { stacked: true, grid: { color: 'rgba(30,41,59,0.3)' }, ticks: { font: { size: 9 }, color: '#94a3b8', callback: (v: any) => fmt(v) } },
          y: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, color: '#94a3b8' } },
        },
      },
    };
  };

  const arChart = buildAgeingChart(receivableAgeing);
  const apChart = buildAgeingChart(payableAgeing);

  // ── Handle filter changes ─────────────────────────────────────────────────
  const handleCompanyChange = (val: string) => {
    setCompanyId(val);
    if (val) setGroupId(''); // company overrides group
  };
  const handleGroupChange = (val: string) => {
    setGroupId(val);
    if (val) setCompanyId(''); // group overrides company
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* ── Filter Bar ──────────────────────────────────────────────────── */}
      <div className="bg-dark-700 rounded-xl border border-dark-400/30">
        <div className="flex items-center justify-between px-5 py-3 flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">Filters</span>
            {groups.length > 0 && (
              <select
                value={groupId}
                onChange={e => handleGroupChange(e.target.value)}
                className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
              >
                <option value="">No Group</option>
                {groups.map((g: any) => (
                  <option key={g.id} value={g.id}>{g.name} ({g.member_count})</option>
                ))}
              </select>
            )}
            <select
              value={companyId}
              onChange={e => handleCompanyChange(e.target.value)}
              className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-3 py-1.5 min-w-[180px] focus:ring-1 focus:ring-indigo-500 focus:outline-none"
            >
              <option value="">All Companies</option>
              {companies.map((c: any) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-indigo-500 focus:outline-none" />
            <span className="text-theme-faint text-xs">&ndash;</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-indigo-500 focus:outline-none" />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-24">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" />
        </div>
      ) : (
        <>
          {/* ── KPI Row 1: Revenue (hero) | Gross Profit | Net Profit ──── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Hero: Total Revenue */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-6 border-l-4 border-l-indigo-500 hover:-translate-y-0.5 hover:shadow-lg transition-all">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-theme-faint">TOTAL REVENUE</p>
                  <p className="text-3xl font-extrabold text-theme-heading mt-1">{fmt(totalRevenue)}</p>
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className={`text-xs font-semibold ${revChange.positive ? 'text-emerald-400' : 'text-red-400'}`}>
                      {revChange.positive ? '\u25B2' : '\u25BC'} {revChange.text} {periodLabel}
                    </span>
                  </div>
                  <p className="text-[10px] text-theme-faint mt-0.5">vs. previous period</p>
                </div>
                <TrendUp />
              </div>
            </div>

            {/* Gross Profit */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 hover:-translate-y-0.5 hover:shadow-lg transition-all">
              <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">GROSS PROFIT</p>
              <p className="text-2xl font-extrabold text-theme-heading mt-1">{fmt(grossProfit)}</p>
              <p className="text-xs text-theme-faint mt-2">Margin: <span className="font-semibold text-theme-secondary">{pct(gpMargin)}</span></p>
            </div>

            {/* Net Profit */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 hover:-translate-y-0.5 hover:shadow-lg transition-all">
              <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">NET PROFIT</p>
              <p className={`text-2xl font-extrabold mt-1 ${netProfit < 0 ? 'text-red-400' : 'text-theme-heading'}`}>{fmt(netProfit)}</p>
              <p className={`text-xs mt-2 font-medium ${npStatus.color}`}>{npStatus.text}</p>
            </div>
          </div>

          {/* ── KPI Row 2: Expenses (hero) | Cash & Bank | Closing Stock ─ */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Hero: Total Expenses */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-6 border-l-4 border-l-red-500 hover:-translate-y-0.5 hover:shadow-lg transition-all">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-theme-faint">TOTAL EXPENSES</p>
                  <p className="text-3xl font-extrabold text-red-400 mt-1">{fmt(totalExpenses)}</p>
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className={`text-xs font-semibold ${!expChange.positive ? 'text-emerald-400' : 'text-red-400'}`}>
                      {expChange.positive ? '\u25B2' : '\u25BC'} {expChange.text} {periodLabel}
                    </span>
                  </div>
                  <p className="text-[10px] text-theme-faint mt-0.5">vs. previous period</p>
                </div>
                <TrendDown />
              </div>
            </div>

            {/* Cash & Bank */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 hover:-translate-y-0.5 hover:shadow-lg transition-all">
              <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">CASH &amp; BANK</p>
              <p className="text-2xl font-extrabold text-theme-heading mt-1">{fmt(cashBank)}</p>
              <p className="text-xs text-emerald-400 mt-2 font-medium">{'\u25CF'} Liquid Assets</p>
            </div>

            {/* Closing Stock */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 hover:-translate-y-0.5 hover:shadow-lg transition-all">
              <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">CLOSING STOCK</p>
              <p className="text-2xl font-extrabold text-theme-heading mt-1">{fmt(closingStock)}</p>
              <p className="text-xs text-theme-faint mt-2">Inventory value</p>
            </div>
          </div>

          {/* ── Charts Row: 5-col trend + 2-col sidebar ───────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-7 gap-5">
            {/* YTD Trend — 5 cols */}
            <div className="lg:col-span-5 bg-dark-700 rounded-xl border border-dark-400/30 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading">YTD Trend Analysis</h3>
                <select
                  value={trendMode}
                  onChange={e => setTrendMode(e.target.value as 'rev_exp' | 'gp_np')}
                  className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="rev_exp">Revenue vs Expenses</option>
                  <option value="gp_np">GP % vs NP % Ratio</option>
                </select>
              </div>
              <div style={{ height: 300 }}>
                {monthlyTrend.length > 0 ? (
                  trendMode === 'rev_exp'
                    ? <Bar data={revExpChartData} options={chartOpts} />
                    : <Line data={gpNpChartData} options={chartOpts} />
                ) : (
                  <div className="flex items-center justify-center h-full text-theme-faint text-xs">
                    No trend data — sync from Tally first
                  </div>
                )}
              </div>
            </div>

            {/* Right sidebar — 2 cols stacked */}
            <div className="lg:col-span-2 flex flex-col gap-5">
              {/* Top Expenses with tabs */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 border-l-4 border-l-indigo-500 flex-1">
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading mb-3">TOP BREAKDOWN</h3>
                <div className="flex gap-1 mb-4">
                  {(['revenue', 'direct', 'indirect'] as const).map(t => (
                    <button key={t} onClick={() => setExpTab(t)}
                      className={`px-3 py-1 text-[10px] font-semibold rounded-full transition-colors capitalize ${
                        expTab === t ? 'bg-indigo-600 text-white' : 'bg-dark-600 text-theme-muted hover:text-theme-primary'
                      }`}>
                      {t === 'direct' ? 'Direct Exp' : t === 'indirect' ? 'Indirect Exp' : 'Revenue'}
                    </button>
                  ))}
                </div>
                {expList.length > 0 ? (
                  <div className="space-y-3">
                    {expList.slice(0, 6).map((item: any, i: number) => {
                      const val = Math.abs(item.total || item.amount || 0);
                      const name = item.category || item.ledger_name || item.group_name || 'Unknown';
                      return (
                        <div key={i}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-theme-secondary truncate max-w-[140px]" title={name}>{name}</span>
                            <span className="text-[10px] font-mono text-theme-primary">{fmt(val)}</span>
                          </div>
                          <div className="h-1.5 bg-dark-600 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${(val / maxExpVal) * 100}%`, backgroundColor: BAR_PALETTE[i % BAR_PALETTE.length] }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-theme-faint text-center py-6">No data available</div>
                )}
              </div>

              {/* Every ₹1 Earned */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 flex-1">
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading mb-3">EVERY {'\u20B9'}1 EARNED</h3>
                <div style={{ height: 200 }}>
                  {totalRevenue > 0 ? (
                    <Doughnut data={rupeeData} options={rupeeOpts} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-theme-faint text-xs">No revenue data</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ── Ageing Section ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Receivable Ageing */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading mb-4">
                Receivable Ageing
                <span className="text-[10px] text-theme-faint font-normal ml-2">Top {Math.min(receivableAgeing.length, 10)} parties</span>
              </h3>
              <div style={{ height: Math.max(200, receivableAgeing.slice(0, 10).length * 35 + 60) }}>
                {receivableAgeing.length > 0 ? (
                  <Bar data={arChart.data} options={arChart.options as any} />
                ) : (
                  <div className="flex items-center justify-center h-full text-theme-faint text-xs">No receivable data</div>
                )}
              </div>
            </div>

            {/* Payable Ageing */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5">
              <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading mb-4">
                Payable Ageing
                <span className="text-[10px] text-theme-faint font-normal ml-2">Top {Math.min(payableAgeing.length, 10)} parties</span>
              </h3>
              <div style={{ height: Math.max(200, payableAgeing.slice(0, 10).length * 35 + 60) }}>
                {payableAgeing.length > 0 ? (
                  <Bar data={apChart.data} options={apChart.options as any} />
                ) : (
                  <div className="flex items-center justify-center h-full text-theme-faint text-xs">No payable data</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Quick Summary Footer ──────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'GP Margin', value: pct(gpMargin), sub: 'Gross Profit / Revenue', color: 'text-emerald-400' },
              { label: 'NP Margin', value: pct(npMargin), sub: 'Net Profit / Revenue', color: netProfit < 0 ? 'text-red-400' : 'text-emerald-400' },
              { label: 'Expense Ratio', value: pct(totalRevenue ? (totalExpenses / totalRevenue * 100) : 0), sub: 'Total Expenses / Revenue', color: 'text-amber-400' },
              { label: 'Companies', value: String(companies.length), sub: 'Active Tally companies', color: 'text-blue-400' },
            ].map((card, i) => (
              <div key={i} className="bg-dark-700 rounded-xl border border-dark-400/30 p-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">{card.label}</p>
                <p className={`text-xl font-extrabold mt-1 ${card.color}`}>{card.value}</p>
                <p className="text-[10px] text-theme-faint mt-1">{card.sub}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
