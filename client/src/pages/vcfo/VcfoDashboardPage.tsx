/**
 * VCFO Dashboard — Exact replica of TallyVision's Business Overview
 * Layout: 2-col KPI (heroes left, 2×2 right), 7-col charts row,
 * geo filter bar (Type/State/City/Location), group context badge,
 * quick action cards at bottom.
 */
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, ArcElement, Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Bar, Line, Doughnut } from 'react-chartjs-2';
import api from '../../api/client';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler);

// ── Formatting (matches TallyVision fmt exactly) ─────────────────────────────

function fmt(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num as number)) return '\u20B90';
  const abs = Math.abs(num as number);
  if (abs >= 10000000) return '\u20B9' + parseFloat(((num as number) / 10000000).toFixed(2)) + ' Cr';
  if (abs >= 100000) return '\u20B9' + parseFloat(((num as number) / 100000).toFixed(2)) + ' L';
  if (abs >= 1000) return '\u20B9' + parseFloat(((num as number) / 1000).toFixed(1)) + ' K';
  return '\u20B9' + (num as number).toFixed(0);
}

function monthLabel(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function VcfoDashboardPage() {
  const navigate = useNavigate();

  // Data
  const [groups, setGroups] = useState<any[]>([]);
  const [kpis, setKpis] = useState<any>({});
  const [prevKpis, setPrevKpis] = useState<any>({});
  const [monthlyTrend, setMonthlyTrend] = useState<any[]>([]);
  const [topRevenue, setTopRevenue] = useState<any[]>([]);
  const [topDirectExp, setTopDirectExp] = useState<any[]>([]);
  const [topIndirectExp, setTopIndirectExp] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Geo filter options
  const [typeOptions, setTypeOptions] = useState<string[]>([]);
  const [stateOptions, setStateOptions] = useState<string[]>([]);
  const [cityOptions, setCityOptions] = useState<string[]>([]);
  const [locationOptions, setLocationOptions] = useState<string[]>([]);

  // Filter state
  const [groupId, setGroupId] = useState<string>('');
  const [selectedType, setSelectedType] = useState('');
  const [selectedState, setSelectedState] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [selectedLocation, setSelectedLocation] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // UI
  const [trendMode, setTrendMode] = useState<'rev_exp' | 'gp_np'>('rev_exp');
  const [expTab, setExpTab] = useState<'rev' | 'direct' | 'indirect'>('direct');

  // Active group label
  const activeGroup = groups.find((g: any) => String(g.id) === groupId);
  const activeLabel = activeGroup ? activeGroup.name : 'No Company Selected';

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

  // ── Load groups + geo filter options ───────────────────────────────────────
  useEffect(() => {
    Promise.all([
      api.get('/vcfo/groups').catch(() => ({ data: [] })),
      api.get('/vcfo/filters/types').catch(() => ({ data: [] })),
      api.get('/vcfo/filters/states').catch(() => ({ data: [] })),
    ]).then(([grpRes, typesRes, statesRes]) => {
      const grps = grpRes.data || [];
      setGroups(grps);
      setTypeOptions(typesRes.data || []);
      setStateOptions(statesRes.data || []);
      if (grps.length > 0) setGroupId(String(grps[0].id));
    });
  }, []);

  // ── Cascade city filter when state changes ─────────────────────────────────
  useEffect(() => {
    const params: any = {};
    if (selectedState) params.state = selectedState;
    api.get('/vcfo/filters/cities', { params }).then(r => setCityOptions(r.data || [])).catch(() => {});
  }, [selectedState]);

  // ── Cascade location filter when city changes ──────────────────────────────
  useEffect(() => {
    const params: any = {};
    if (selectedState) params.state = selectedState;
    if (selectedCity) params.city = selectedCity;
    api.get('/vcfo/filters/locations', { params }).then(r => setLocationOptions(r.data || [])).catch(() => {});
  }, [selectedState, selectedCity]);

  // ── Compute previous period ────────────────────────────────────────────────
  const getPrevDates = useCallback(() => {
    if (!fromDate || !toDate) return { prevFrom: '', prevTo: '' };
    const f = new Date(fromDate);
    const t = new Date(toDate);
    const days = Math.round((t.getTime() - f.getTime()) / 86400000);
    let unit: 'week' | 'month' | 'quarter' | 'year' = 'year';
    if (days <= 10) unit = 'week';
    else if (days <= 45) unit = 'month';
    else if (days <= 100) unit = 'quarter';

    const sub = (d: Date) => {
      const n = new Date(d);
      if (unit === 'week') n.setDate(n.getDate() - 7);
      else if (unit === 'month') n.setMonth(n.getMonth() - 1);
      else if (unit === 'quarter') n.setMonth(n.getMonth() - 3);
      else n.setFullYear(n.getFullYear() - 1);
      return n;
    };
    return {
      prevFrom: sub(f).toISOString().split('T')[0],
      prevTo: sub(t).toISOString().split('T')[0],
    };
  }, [fromDate, toDate]);

  // Period label
  const periodLabel = (() => {
    if (!fromDate || !toDate) return 'YoY';
    const days = Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000);
    if (days <= 10) return 'WoW';
    if (days <= 45) return 'MoM';
    if (days <= 100) return 'QoQ';
    return 'YoY';
  })();

  // ── Build query params ─────────────────────────────────────────────────────
  const buildParams = useCallback((base?: any) => {
    const p: any = { from: fromDate, to: toDate, ...base };
    if (groupId) p.groupId = groupId;
    if (selectedType) p.type = selectedType;
    if (selectedState) p.state = selectedState;
    if (selectedCity) p.city = selectedCity;
    if (selectedLocation) p.location = selectedLocation;
    return p;
  }, [fromDate, toDate, groupId, selectedType, selectedState, selectedCity, selectedLocation]);

  // ── Load dashboard data ───────────────────────────────────────────────────
  useEffect(() => {
    if (!fromDate || !toDate || !groupId) return;
    setLoading(true);

    const params = buildParams();
    const trendParams = buildParams({ fromDate: fromDate, toDate: toDate });
    const { prevFrom, prevTo } = getPrevDates();
    const prevParams = prevFrom ? buildParams({ from: prevFrom, to: prevTo }) : null;

    const requests: Promise<any>[] = [
      api.get('/vcfo/dashboard/kpi', { params }).catch(() => ({ data: { kpis: {} } })),
      api.get('/vcfo/dashboard/monthly-trend', { params }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/top-revenue', { params }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/top-direct-expenses', { params: trendParams }).catch(() => ({ data: [] })),
      api.get('/vcfo/dashboard/top-indirect-expenses', { params: trendParams }).catch(() => ({ data: [] })),
    ];
    if (prevParams) {
      requests.push(api.get('/vcfo/dashboard/kpi', { params: prevParams }).catch(() => ({ data: { kpis: {} } })));
    }

    Promise.all(requests).then(([kpiRes, trendRes, revRes, deRes, ieRes, prevKpiRes]) => {
      setKpis(kpiRes.data?.kpis || {});
      setMonthlyTrend(trendRes.data || []);
      setTopRevenue(revRes.data || []);
      setTopDirectExp(deRes.data || []);
      setTopIndirectExp(ieRes.data || []);
      if (prevKpiRes) setPrevKpis(prevKpiRes.data?.kpis || {});
    }).finally(() => setLoading(false));
  }, [fromDate, toDate, groupId, selectedType, selectedState, selectedCity, selectedLocation, buildParams, getPrevDates]);

  // ── Derived values ────────────────────────────────────────────────────────
  const k = kpis;
  const pk = prevKpis;
  const totalRevenue = (k.revenue || 0) + (k.directIncome || 0) + (k.indirectIncome || 0);
  const totalExpenses = (k.purchase || 0) + (k.directExpenses || 0) + (k.indirectExpenses || 0);
  const prevTotalRev = (pk.revenue || 0) + (pk.directIncome || 0) + (pk.indirectIncome || 0);
  const prevTotalExp = (pk.purchase || 0) + (pk.directExpenses || 0) + (pk.indirectExpenses || 0);
  const gpMargin = totalRevenue ? ((k.grossProfit || 0) / totalRevenue * 100).toFixed(1) : '0.0';

  function changeBadge(current: number, prev: number | null) {
    if (prev == null || prev === 0) return null;
    const pct = ((current - prev) / Math.abs(prev)) * 100;
    const up = pct >= 0;
    return (
      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${up ? 'text-emerald-600 bg-emerald-50' : 'text-red-600 bg-red-50'}`}>
        {up ? '\u25B2' : '\u25BC'} {up ? '+' : ''}{pct.toFixed(1)}% {periodLabel}
      </span>
    );
  }

  // ── Expense tab data ──────────────────────────────────────────────────────
  const expData = expTab === 'rev' ? topRevenue : expTab === 'direct' ? topDirectExp : topIndirectExp;
  const expColor = expTab === 'rev' ? '#059669' : expTab === 'direct' ? '#dc2626' : '#d97706';
  const expTitle = expTab === 'rev' ? 'Top Revenue' : expTab === 'direct' ? 'Top Direct Expenses' : 'Top Indirect Expenses';
  const maxExpVal = expData.length > 0 ? Math.max(...expData.map((d: any) => Math.abs(d.total || 0))) : 1;

  // ── Trend chart ───────────────────────────────────────────────────────────
  const trendLabels = monthlyTrend.map((m: any) => monthLabel(m.month));
  const revExpData = {
    labels: trendLabels,
    datasets: [
      { label: 'Revenue', data: monthlyTrend.map((m: any) => m.revenue || 0), backgroundColor: 'rgba(74,222,128,0.75)', borderRadius: 6, borderSkipped: false as const },
      { label: 'Direct Expenses', data: monthlyTrend.map((m: any) => m.expenses || 0), backgroundColor: 'rgba(252,165,165,0.75)', borderRadius: 6, borderSkipped: false as const },
    ],
  };
  const gpNpData = {
    labels: trendLabels,
    datasets: [
      { label: 'GP %', data: monthlyTrend.map((m: any) => m.revenue ? (m.grossProfit || 0) / m.revenue * 100 : 0), borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.12)', fill: true, tension: 0.4, pointRadius: 3, pointBackgroundColor: '#22c55e', borderWidth: 2 },
      { label: 'NP %', data: monthlyTrend.map((m: any) => m.revenue ? (m.netProfit || 0) / m.revenue * 100 : 0), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', fill: true, tension: 0.4, pointRadius: 3, pointBackgroundColor: '#3b82f6', borderWidth: 2 },
    ],
  };
  const chartOpts: any = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#64748b', font: { size: 11 } } }, datalabels: { display: false } },
    scales: {
      x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(226,232,240,0.15)' } },
      y: { beginAtZero: true, ticks: { color: '#64748b', font: { size: 10 }, callback: (v: any) => trendMode === 'gp_np' ? v.toFixed(1) + '%' : fmt(v) }, grid: { color: 'rgba(226,232,240,0.15)' } },
    },
  };

  // ── Rupee breakdown doughnut ───────────────────────────────────────────────
  const directExp = Math.abs(k.purchase || 0) + Math.abs(k.directExpenses || 0);
  const indirectExp = Math.abs(k.indirectExpenses || 0);
  const profit = totalRevenue - directExp - indirectExp;
  const rupeeData = {
    labels: ['Direct Expenses', 'Indirect Expenses', profit >= 0 ? 'Profit' : 'Loss'],
    datasets: [{ data: [directExp, indirectExp, Math.abs(profit)], backgroundColor: ['#dc2626', '#d97706', profit >= 0 ? '#059669' : '#ef4444'], borderWidth: 0, hoverOffset: 6 }],
  };
  const rupeeOpts: any = {
    responsive: true, maintainAspectRatio: false, cutout: '55%',
    plugins: {
      legend: { display: false },
      datalabels: { display: false },
      tooltip: { callbacks: { label: (ctx: any) => { const total = ctx.dataset.data.reduce((a: number, b: number) => a + b, 0); return `${ctx.label}: ${total ? ((ctx.raw / total) * 100).toFixed(1) : 0}% (${fmt(ctx.raw)})`; } } },
    },
  };
  // Custom legend items
  const rupeeTotal = directExp + indirectExp + Math.abs(profit);
  const rupeeLegend = [
    { label: 'Direct Exp', value: directExp, color: '#dc2626' },
    { label: 'Indirect Exp', value: indirectExp, color: '#d97706' },
    { label: profit >= 0 ? 'Profit' : 'Loss', value: Math.abs(profit), color: profit >= 0 ? '#059669' : '#ef4444' },
  ];

  // ── Filter chip removal ───────────────────────────────────────────────────
  const activeFilters: { label: string; clear: () => void }[] = [];
  if (selectedType) activeFilters.push({ label: `Type: ${selectedType}`, clear: () => setSelectedType('') });
  if (selectedState) activeFilters.push({ label: `State: ${selectedState}`, clear: () => { setSelectedState(''); setSelectedCity(''); setSelectedLocation(''); } });
  if (selectedCity) activeFilters.push({ label: `City: ${selectedCity}`, clear: () => { setSelectedCity(''); setSelectedLocation(''); } });
  if (selectedLocation) activeFilters.push({ label: `Location: ${selectedLocation}`, clear: () => setSelectedLocation('') });

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ══ Filter Bar ══════════════════════════════════════════════════ */}
      <div className="bg-dark-700 rounded-xl border border-dark-400/30 px-4 py-2.5 flex items-center gap-4 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wide text-theme-faint">Filters</span>

        {/* Group context badge */}
        <div className="flex items-center gap-1.5 border-r border-dark-400/30 pr-4">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-theme-faint"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9h1m-1 4h1m-1 4h1"/></svg>
          <select
            value={groupId}
            onChange={e => setGroupId(e.target.value)}
            className="text-xs font-semibold text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded-full px-2.5 py-0.5 focus:outline-none"
          >
            <option value="">No Company Selected</option>
            {groups.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>

        {/* Geo filters */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-medium text-theme-faint">Type</label>
            <select value={selectedType} onChange={e => setSelectedType(e.target.value)}
              className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-2 py-1 focus:outline-none min-w-[70px]">
              <option value="">All</option>
              {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-medium text-theme-faint">State</label>
            <select value={selectedState} onChange={e => { setSelectedState(e.target.value); setSelectedCity(''); setSelectedLocation(''); }}
              className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-2 py-1 focus:outline-none min-w-[70px]">
              <option value="">All</option>
              {stateOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-medium text-theme-faint">City</label>
            <select value={selectedCity} onChange={e => { setSelectedCity(e.target.value); setSelectedLocation(''); }}
              className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-2 py-1 focus:outline-none min-w-[70px]">
              <option value="">All</option>
              {cityOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-medium text-theme-faint">Location</label>
            <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)}
              className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-2 py-1 focus:outline-none min-w-[70px]">
              <option value="">All</option>
              {locationOptions.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        </div>

        {/* Date Range — pushed right */}
        <div className="flex items-center gap-2 ml-auto">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-theme-faint"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-2 py-1 focus:outline-none" />
          <span className="text-theme-faint text-xs">–</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-2 py-1 focus:outline-none" />
        </div>
      </div>

      {/* Active filter chips */}
      {activeFilters.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {activeFilters.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 text-xs font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 rounded-full px-2.5 py-0.5">
              {f.label}
              <button onClick={f.clear} className="ml-0.5 hover:text-white">&times;</button>
            </span>
          ))}
        </div>
      )}

      {!groupId ? (
        /* ══ Empty State ══════════════════════════════════════════════ */
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="text-6xl mb-4 opacity-60">{'\uD83D\uDCCA'}</div>
          <h3 className="text-lg font-semibold text-theme-heading mb-2">No Company Selected</h3>
          <p className="text-sm text-theme-muted mb-6 max-w-sm">Select a company or group to view the dashboard.</p>
          <button onClick={() => navigate('/vcfo/settings')}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition">
            {'\u2699'} Open Settings
          </button>
        </div>
      ) : loading ? (
        <div className="flex justify-center py-24">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" />
        </div>
      ) : (
        <>
          {/* ══ KPI Grid: 2 columns ═══════════════════════════════════ */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* LEFT: Hero cards stacked */}
            <div className="flex flex-col gap-4">
              {/* Total Revenue — hero */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-7 flex-1 flex flex-col justify-center hover:-translate-y-0.5 hover:shadow-lg transition-all">
                <p className="text-[11px] font-bold uppercase tracking-widest text-theme-faint mb-3">Total Revenue</p>
                <div className="flex items-center justify-between">
                  <p className="text-4xl font-extrabold text-theme-heading" style={{ letterSpacing: '-0.03em', lineHeight: 1 }}>{fmt(totalRevenue)}</p>
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M4 24 L12 14 L18 18 L28 6" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M22 6 L28 6 L28 12" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                <div className="mt-4">{changeBadge(totalRevenue, prevTotalRev)}</div>
                <p className="text-[10px] text-theme-faint mt-1">vs. previous fiscal year</p>
              </div>

              {/* Total Expenses — hero */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-7 flex-1 flex flex-col justify-center hover:-translate-y-0.5 hover:shadow-lg transition-all" style={{ borderLeft: '4px solid #dc2626' }}>
                <p className="text-[11px] font-bold uppercase tracking-widest text-theme-faint mb-3">Total Expenses</p>
                <div className="flex items-center justify-between">
                  <p className="text-4xl font-extrabold text-red-400" style={{ letterSpacing: '-0.03em', lineHeight: 1 }}>{fmt(totalExpenses)}</p>
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M4 8 L12 18 L18 14 L28 26" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M22 26 L28 26 L28 20" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                <div className="mt-4">{changeBadge(totalExpenses, prevTotalExp)}</div>
                <p className="text-[10px] text-theme-faint mt-1">vs. previous fiscal year</p>
              </div>
            </div>

            {/* RIGHT: 2×2 smaller cards */}
            <div className="grid grid-cols-2 gap-4">
              {/* Gross Profit */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 flex flex-col justify-center hover:-translate-y-0.5 hover:shadow-md transition-all">
                <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint mb-2">Gross Profit</p>
                <p className="text-2xl font-extrabold text-theme-heading" style={{ letterSpacing: '-0.02em' }}>{fmt(k.grossProfit)}</p>
                <p className="text-[11px] text-theme-faint mt-2">Margin: {gpMargin}%</p>
              </div>

              {/* Net Profit */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 flex flex-col justify-center hover:-translate-y-0.5 hover:shadow-md transition-all">
                <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint mb-2">Net Profit</p>
                <p className={`text-2xl font-extrabold ${(k.netProfit || 0) >= 0 ? 'text-theme-heading' : 'text-red-400'}`} style={{ letterSpacing: '-0.02em' }}>{fmt(k.netProfit)}</p>
                <div className="mt-2">
                  {(k.netProfit || 0) < 0
                    ? <span className="text-[11px] font-semibold text-red-400">{'\u26A0'} Critical threshold</span>
                    : <span className="text-[11px] font-semibold text-emerald-400">{'\u2713'} Healthy</span>
                  }
                </div>
              </div>

              {/* Cash & Bank */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 flex flex-col justify-center hover:-translate-y-0.5 hover:shadow-md transition-all">
                <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint mb-2">Cash & Bank</p>
                <p className="text-2xl font-extrabold text-theme-heading" style={{ letterSpacing: '-0.02em' }}>{fmt(k.cashBankBalance)}</p>
                <div className="mt-2"><span className="text-[11px] font-semibold text-emerald-400">{'\u25CF'} Liquid Assets Stable</span></div>
              </div>

              {/* Closing Stock */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 flex flex-col justify-center hover:-translate-y-0.5 hover:shadow-md transition-all">
                <p className="text-[10px] font-bold uppercase tracking-widest text-theme-faint mb-2">Closing Stock</p>
                <p className="text-2xl font-extrabold text-theme-heading" style={{ letterSpacing: '-0.02em' }}>{fmt(k.closingStock)}</p>
              </div>
            </div>
          </div>

          {/* ══ Charts Row: 7-col (5 trend + 2 right) ═════════════════ */}
          <div className="grid grid-cols-1 lg:grid-cols-7 gap-5">
            {/* LEFT: YTD Trend (5 cols) */}
            <div className="lg:col-span-5 bg-dark-700 rounded-xl border border-dark-400/30 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading">YTD Trend Analysis</h3>
                <select value={trendMode} onChange={e => setTrendMode(e.target.value as any)}
                  className="bg-dark-600 border border-dark-400/40 text-theme-primary text-xs rounded-lg px-3 py-1.5 font-semibold focus:outline-none">
                  <option value="rev_exp">Revenue vs Expenses</option>
                  <option value="gp_np">GP % vs NP % Ratio</option>
                </select>
              </div>
              <div style={{ height: 300 }}>
                {monthlyTrend.length > 0 ? (
                  trendMode === 'rev_exp'
                    ? <Bar data={revExpData} options={chartOpts} />
                    : <Line data={gpNpData} options={chartOpts} />
                ) : (
                  <div className="flex items-center justify-center h-full text-theme-faint text-xs">No trend data — sync from Tally first</div>
                )}
              </div>
            </div>

            {/* RIGHT: Stacked panels (2 cols) */}
            <div className="flex flex-col gap-5 lg:col-span-2 min-w-0">
              {/* Top Expenses/Revenue — with tabs */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5" style={{ borderLeft: '3px solid #059669' }}>
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading mb-4">{expTitle}</h3>
                <div className="flex gap-1 mb-3">
                  {(['rev', 'direct', 'indirect'] as const).map(tab => (
                    <button key={tab} onClick={() => setExpTab(tab)}
                      className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                        expTab === tab
                          ? 'bg-indigo-600 text-white'
                          : 'bg-dark-600 text-theme-muted border border-dark-400/40'
                      }`}>
                      {tab === 'rev' ? 'Revenue' : tab === 'direct' ? 'Direct' : 'Indirect'}
                    </button>
                  ))}
                </div>
                {expData.length > 0 ? (
                  <div className="space-y-3">
                    {expData.slice(0, 3).map((d: any, i: number) => {
                      const name = (d.category || d.ledger_name || '').substring(0, 25);
                      const val = Math.abs(d.total || 0);
                      const pct = maxExpVal ? (val / maxExpVal * 100) : 0;
                      return (
                        <div key={i}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-theme-secondary truncate">{name}</span>
                            <span className="text-[10px] font-mono text-theme-primary font-semibold">{fmt(val)}</span>
                          </div>
                          <div className="h-2 bg-dark-600 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: expColor }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : <p className="text-xs text-theme-faint text-center py-4">No data available</p>}
              </div>

              {/* Every ₹1 Earned */}
              <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5">
                <h3 className="text-sm font-bold uppercase tracking-wider text-theme-heading mb-3">Every {'\u20B9'}1 Earned</h3>
                <div className="grid items-center gap-2" style={{ gridTemplateColumns: '110px 1fr', height: 140 }}>
                  <div style={{ width: 110, height: 110 }}>
                    {totalRevenue > 0 ? <Doughnut data={rupeeData} options={rupeeOpts} /> : <div className="flex items-center justify-center h-full text-theme-faint text-[10px]">No data</div>}
                  </div>
                  <div className="space-y-2">
                    {rupeeLegend.map((item, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: item.color }} />
                        <span className="text-[10px] text-theme-secondary flex-1">{item.label}</span>
                        <span className="text-[10px] font-semibold text-theme-primary">{rupeeTotal ? ((item.value / rupeeTotal) * 100).toFixed(0) : 0}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ══ Quick Action Cards ═════════════════════════════════════ */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Ledger Reports — dark card */}
            <div className="rounded-xl px-5 py-4 cursor-pointer hover:opacity-90 transition bg-slate-800"
              onClick={() => navigate('/vcfo/table-view')}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-white/10">
                  <svg width="18" height="18" fill="none" stroke="#fff" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v4M12 14v4M16 14v4"/></svg>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-white/50">Ledger Reports</p>
                  <p className="text-[13px] font-semibold text-white">Review All Accounts</p>
                </div>
              </div>
            </div>

            {/* Outstanding */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 px-5 py-4 cursor-pointer hover:shadow-md transition"
              onClick={() => navigate('/vcfo/table-view')}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-emerald-500/10">
                  <svg width="18" height="18" fill="none" stroke="#059669" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="16" rx="2"/><path d="M2 10h20M7 15h.01M12 15h5"/></svg>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-theme-faint">Outstanding</p>
                  <p className="text-[13px] font-semibold text-theme-heading">View Pending</p>
                </div>
              </div>
            </div>

            {/* Inventory */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 px-5 py-4 cursor-pointer hover:shadow-md transition"
              onClick={() => navigate('/vcfo/table-view')}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-purple-500/10">
                  <svg width="18" height="18" fill="none" stroke="#7c3aed" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-theme-faint">Inventory</p>
                  <p className="text-[13px] font-semibold text-theme-heading">Check Stock Levels</p>
                </div>
              </div>
            </div>

            {/* Settings */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 px-5 py-4 cursor-pointer hover:shadow-md transition"
              onClick={() => navigate('/vcfo/settings')}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-red-500/10">
                  <svg width="18" height="18" fill="none" stroke="#dc2626" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-theme-faint">Settings</p>
                  <p className="text-[13px] font-semibold text-theme-heading">Configure Tally API</p>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
