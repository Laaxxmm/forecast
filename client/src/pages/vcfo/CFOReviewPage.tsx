import { useState, useEffect, useCallback } from 'react';
import {
  ClipboardCheck, RefreshCw, ChevronDown, Star, AlertTriangle,
  TrendingUp, TrendingDown, Building2, Package, Lightbulb, CheckCircle2
} from 'lucide-react';
import api from '../../api/client';

// ── Formatting helpers ───────────────────────────────────────────────────────

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
  if (val === undefined || val === null || isNaN(val)) return '0.0%';
  return val.toFixed(1) + '%';
}

// ── Rating badge config ──────────────────────────────────────────────────────

const RATING_CONFIG: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  Excellent: { bg: 'bg-emerald-900/40 border-emerald-600', text: 'text-emerald-400', icon: <Star size={18} className="text-emerald-400" /> },
  Good: { bg: 'bg-blue-900/40 border-blue-600', text: 'text-blue-400', icon: <Star size={18} className="text-blue-400" /> },
  Fair: { bg: 'bg-amber-900/40 border-amber-600', text: 'text-amber-400', icon: <AlertTriangle size={18} className="text-amber-400" /> },
  'Needs Attention': { bg: 'bg-red-900/40 border-red-600', text: 'text-red-400', icon: <AlertTriangle size={18} className="text-red-400" /> },
};

function getRatingConfig(rating: string) {
  return RATING_CONFIG[rating] || RATING_CONFIG['Fair'];
}

// ── Status badge color ───────────────────────────────────────────────────────

function statusColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s.includes('excellent') || s.includes('strong') || s.includes('healthy')) return 'text-emerald-400 bg-emerald-900/30';
  if (s.includes('good') || s.includes('stable')) return 'text-blue-400 bg-blue-900/30';
  if (s.includes('fair') || s.includes('moderate') || s.includes('average')) return 'text-amber-400 bg-amber-900/30';
  if (s.includes('attention') || s.includes('weak') || s.includes('poor') || s.includes('loss')) return 'text-red-400 bg-red-900/30';
  return 'text-theme-muted bg-dark-600';
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Group {
  id: number;
  name: string;
}

interface UnitRow {
  companyId: number;
  name: string;
  revenue: number;
  directIncome: number;
  purchase: number;
  directExpenses: number;
  indirectExpenses: number;
  grossProfit: number;
  netProfit: number;
  gpPct: number;
  npPct: number;
  status: string;
}

interface ReviewData {
  groupName: string;
  cityLabel: string;
  period: string;
  rating: string;
  narrative: string[];
  actionItems: string[];
  units: UnitRow[];
  consolidated: UnitRow | null;
  stockByUnit: any[] | null;
  allocationsApplied: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CFOReviewPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [review, setReview] = useState<ReviewData | null>(null);
  const [insights, setInsights] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'review' | 'insights'>('review');

  // ── Load groups on mount ─────────────────────────────────────────────────

  useEffect(() => {
    api.get('/vcfo/groups').then(res => {
      const g = Array.isArray(res.data) ? res.data : res.data?.groups || [];
      setGroups(g);
      if (g.length > 0) setSelectedGroup(String(g[0].id));
    }).catch(() => {});
  }, []);

  // ── Load review data ─────────────────────────────────────────────────────

  const loadReview = useCallback(async () => {
    if (!selectedGroup) return;
    setLoading(true);
    setError('');
    try {
      const params: any = { groupId: selectedGroup };
      if (fromDate) params.fromDate = fromDate;
      if (toDate) params.toDate = toDate;
      const res = await api.get('/vcfo/reports/cfo-review/preview', { params });
      setReview(res.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to load CFO review');
      setReview(null);
    } finally {
      setLoading(false);
    }
  }, [selectedGroup, fromDate, toDate]);

  // ── Load insights ────────────────────────────────────────────────────────

  const loadInsights = useCallback(async () => {
    if (!selectedGroup) return;
    setLoading(true);
    try {
      const params: any = { groupId: selectedGroup };
      if (fromDate) params.fromDate = fromDate;
      if (toDate) params.toDate = toDate;
      const res = await api.get('/vcfo/reports/cfo-insights/preview', { params });
      setInsights(res.data);
    } catch {
      setInsights(null);
    } finally {
      setLoading(false);
    }
  }, [selectedGroup, fromDate, toDate]);

  const handleLoad = () => {
    if (activeTab === 'review') loadReview();
    else loadInsights();
  };

  // Auto-load on group change
  useEffect(() => {
    if (selectedGroup) loadReview();
  }, [selectedGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ───────────────────────────────────────────────────────────────

  const ratingCfg = review ? getRatingConfig(review.rating) : null;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-theme-heading flex items-center gap-2">
            <ClipboardCheck size={28} /> CFO Performance Review
          </h1>
          <p className="text-theme-muted text-sm mt-1">
            Unit-wise financial performance breakdown and executive insights
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4 bg-dark-700 rounded-xl p-4 border border-dark-500">
        {/* Group selector */}
        <div>
          <label className="text-theme-muted text-xs mb-1 block">Company Group</label>
          <div className="relative">
            <select
              value={selectedGroup}
              onChange={e => setSelectedGroup(e.target.value)}
              className="appearance-none bg-dark-600 border border-dark-500 text-theme-body rounded-lg px-4 py-2 pr-10 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
            >
              <option value="">Select group</option>
              {groups.map(g => (
                <option key={g.id} value={String(g.id)}>{g.name}</option>
              ))}
            </select>
            <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-muted pointer-events-none" />
          </div>
        </div>

        {/* Date range */}
        <div>
          <label className="text-theme-muted text-xs mb-1 block">From Date</label>
          <input
            type="date"
            value={fromDate}
            onChange={e => setFromDate(e.target.value)}
            className="bg-dark-600 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="text-theme-muted text-xs mb-1 block">To Date</label>
          <input
            type="date"
            value={toDate}
            onChange={e => setToDate(e.target.value)}
            className="bg-dark-600 border border-dark-500 text-theme-body rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        {/* Tab toggle */}
        <div className="flex bg-dark-600 rounded-lg p-1 gap-1">
          <button
            onClick={() => setActiveTab('review')}
            className={`px-3 py-1.5 rounded-md text-sm transition ${
              activeTab === 'review' ? 'bg-blue-600 text-white' : 'text-theme-muted hover:text-theme-body'
            }`}
          >
            Review
          </button>
          <button
            onClick={() => setActiveTab('insights')}
            className={`px-3 py-1.5 rounded-md text-sm transition ${
              activeTab === 'insights' ? 'bg-blue-600 text-white' : 'text-theme-muted hover:text-theme-body'
            }`}
          >
            Insights
          </button>
        </div>

        <button
          onClick={handleLoad}
          disabled={loading || !selectedGroup}
          className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition text-sm font-medium"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Generate
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3">
          <span className="text-red-400 text-sm">{error}</span>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw size={24} className="animate-spin text-blue-500" />
          <span className="ml-3 text-theme-muted">Generating report...</span>
        </div>
      )}

      {/* ── REVIEW TAB ──────────────────────────────────────────────────── */}
      {activeTab === 'review' && review && !loading && (
        <div className="space-y-6">
          {/* Title bar + Rating */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-theme-heading">{review.groupName}</h2>
              <p className="text-theme-muted text-sm">
                {review.cityLabel} | {review.period}
                {review.allocationsApplied && (
                  <span className="ml-2 text-xs bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded-full">
                    Allocations Applied
                  </span>
                )}
              </p>
            </div>
            {ratingCfg && (
              <div className={`flex items-center gap-2 px-4 py-2 rounded-xl border ${ratingCfg.bg}`}>
                {ratingCfg.icon}
                <span className={`font-semibold text-lg ${ratingCfg.text}`}>{review.rating}</span>
              </div>
            )}
          </div>

          {/* Consolidated KPI Cards */}
          {review.consolidated && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              {[
                { label: 'Revenue', value: fmt(review.consolidated.revenue), icon: <TrendingUp size={18} className="text-emerald-400" /> },
                { label: 'Gross Profit', value: fmt(review.consolidated.grossProfit), icon: <TrendingUp size={18} className="text-blue-400" /> },
                { label: 'Net Profit', value: fmt(review.consolidated.netProfit), icon: review.consolidated.netProfit >= 0 ? <TrendingUp size={18} className="text-emerald-400" /> : <TrendingDown size={18} className="text-red-400" /> },
                { label: 'GP %', value: pct(review.consolidated.gpPct), icon: <TrendingUp size={18} className="text-blue-400" /> },
                { label: 'NP %', value: pct(review.consolidated.npPct), icon: review.consolidated.npPct >= 0 ? <TrendingUp size={18} className="text-emerald-400" /> : <TrendingDown size={18} className="text-red-400" /> },
                { label: 'Direct Expenses', value: fmt(review.consolidated.directExpenses), icon: <TrendingDown size={18} className="text-amber-400" /> },
              ].map((kpi, i) => (
                <div key={i} className="bg-dark-700 rounded-xl p-4 border border-dark-500">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-theme-muted text-xs uppercase tracking-wider">{kpi.label}</span>
                    {kpi.icon}
                  </div>
                  <p className="text-xl font-bold text-theme-heading">{kpi.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Narrative */}
          {review.narrative && review.narrative.length > 0 && (
            <div className="bg-dark-700 rounded-xl p-5 border border-dark-500">
              <h3 className="text-theme-heading font-semibold mb-3 flex items-center gap-2">
                <Lightbulb size={18} className="text-amber-400" /> Executive Summary
              </h3>
              <ul className="space-y-2">
                {review.narrative.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-3 text-theme-body text-sm">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Unit-wise table */}
          {review.units && review.units.length > 0 && (
            <div className="bg-dark-700 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-dark-600 border-b border-dark-500">
                <h3 className="text-theme-heading font-semibold flex items-center gap-2">
                  <Building2 size={18} /> Unit-wise Performance
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-dark-600/50">
                      <th className="text-left text-theme-muted font-medium px-4 py-3">Unit</th>
                      <th className="text-right text-theme-muted font-medium px-4 py-3">Revenue</th>
                      <th className="text-right text-theme-muted font-medium px-4 py-3">Gross Profit</th>
                      <th className="text-right text-theme-muted font-medium px-4 py-3">Net Profit</th>
                      <th className="text-right text-theme-muted font-medium px-4 py-3">GP %</th>
                      <th className="text-right text-theme-muted font-medium px-4 py-3">NP %</th>
                      <th className="text-center text-theme-muted font-medium px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.units.map((unit, idx) => (
                      <tr key={idx} className="border-t border-dark-500 hover:bg-dark-600/50 transition">
                        <td className="px-4 py-3 text-theme-body font-medium">{unit.name}</td>
                        <td className="px-4 py-3 text-right text-theme-body">{fmt(unit.revenue)}</td>
                        <td className="px-4 py-3 text-right text-theme-body">{fmt(unit.grossProfit)}</td>
                        <td className={`px-4 py-3 text-right font-medium ${unit.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {fmt(unit.netProfit)}
                        </td>
                        <td className="px-4 py-3 text-right text-theme-body">{pct(unit.gpPct)}</td>
                        <td className={`px-4 py-3 text-right font-medium ${unit.npPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {pct(unit.npPct)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${statusColor(unit.status)}`}>
                            {unit.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {/* Consolidated row */}
                    {review.consolidated && (
                      <tr className="border-t-2 border-blue-600 bg-dark-600/70 font-semibold">
                        <td className="px-4 py-3 text-theme-heading">Consolidated</td>
                        <td className="px-4 py-3 text-right text-theme-heading">{fmt(review.consolidated.revenue)}</td>
                        <td className="px-4 py-3 text-right text-theme-heading">{fmt(review.consolidated.grossProfit)}</td>
                        <td className={`px-4 py-3 text-right ${review.consolidated.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {fmt(review.consolidated.netProfit)}
                        </td>
                        <td className="px-4 py-3 text-right text-theme-heading">{pct(review.consolidated.gpPct)}</td>
                        <td className={`px-4 py-3 text-right ${review.consolidated.npPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {pct(review.consolidated.npPct)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${statusColor(review.consolidated.status || '')}`}>
                            {review.consolidated.status || '-'}
                          </span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Action Items */}
          {review.actionItems && review.actionItems.length > 0 && (
            <div className="bg-dark-700 rounded-xl p-5 border border-dark-500">
              <h3 className="text-theme-heading font-semibold mb-3 flex items-center gap-2">
                <CheckCircle2 size={18} className="text-blue-400" /> Action Items
              </h3>
              <ul className="space-y-2">
                {review.actionItems.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-3 text-theme-body text-sm">
                    <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-blue-900/40 border border-blue-600 flex items-center justify-center text-xs text-blue-400 font-medium">
                      {idx + 1}
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Stock by Unit */}
          {review.stockByUnit && review.stockByUnit.length > 0 && (
            <div className="bg-dark-700 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-dark-600 border-b border-dark-500">
                <h3 className="text-theme-heading font-semibold flex items-center gap-2">
                  <Package size={18} /> Stock by Unit
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-dark-600/50">
                      {review.stockByUnit[0] &&
                        Object.keys(review.stockByUnit[0]).map(col => (
                          <th key={col} className="text-left text-theme-muted font-medium px-4 py-3 capitalize">
                            {col.replace(/_/g, ' ')}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {review.stockByUnit.map((row: any, idx: number) => (
                      <tr key={idx} className="border-t border-dark-500 hover:bg-dark-600/50 transition">
                        {Object.values(row).map((v: any, ci: number) => (
                          <td key={ci} className="px-4 py-3 text-theme-body">
                            {typeof v === 'number' ? fmt(v) : String(v ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── INSIGHTS TAB ────────────────────────────────────────────────── */}
      {activeTab === 'insights' && !loading && (
        <div className="space-y-6">
          {insights ? (
            <>
              {/* Render insights dynamically */}
              {typeof insights === 'object' && !Array.isArray(insights) && (
                <>
                  {/* If insights has a summary or narrative */}
                  {insights.summary && (
                    <div className="bg-dark-700 rounded-xl p-5 border border-dark-500">
                      <h3 className="text-theme-heading font-semibold mb-3 flex items-center gap-2">
                        <Lightbulb size={18} className="text-amber-400" /> Summary
                      </h3>
                      <p className="text-theme-body text-sm">{insights.summary}</p>
                    </div>
                  )}

                  {/* KPIs */}
                  {insights.kpis && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                      {Object.entries(insights.kpis).map(([key, value]: [string, any]) => (
                        <div key={key} className="bg-dark-700 rounded-xl p-4 border border-dark-500">
                          <p className="text-theme-muted text-xs uppercase tracking-wider mb-1">
                            {key.replace(/_/g, ' ')}
                          </p>
                          <p className="text-xl font-bold text-theme-heading">
                            {typeof value === 'number' ? fmt(value) : String(value)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Items / bullets */}
                  {insights.items && Array.isArray(insights.items) && (
                    <div className="bg-dark-700 rounded-xl p-5 border border-dark-500">
                      <h3 className="text-theme-heading font-semibold mb-3">Key Insights</h3>
                      <ul className="space-y-2">
                        {insights.items.map((item: any, idx: number) => (
                          <li key={idx} className="flex items-start gap-3 text-theme-body text-sm">
                            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                            {typeof item === 'string' ? item : item.text || JSON.stringify(item)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Recommendations */}
                  {insights.recommendations && Array.isArray(insights.recommendations) && (
                    <div className="bg-dark-700 rounded-xl p-5 border border-dark-500">
                      <h3 className="text-theme-heading font-semibold mb-3 flex items-center gap-2">
                        <CheckCircle2 size={18} className="text-emerald-400" /> Recommendations
                      </h3>
                      <ul className="space-y-2">
                        {insights.recommendations.map((item: string, idx: number) => (
                          <li key={idx} className="flex items-start gap-3 text-theme-body text-sm">
                            <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-emerald-900/40 border border-emerald-600 flex items-center justify-center text-xs text-emerald-400 font-medium">
                              {idx + 1}
                            </span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="bg-dark-700 rounded-xl p-12 text-center">
              <Lightbulb size={48} className="mx-auto text-theme-muted mb-4" />
              <p className="text-theme-muted">Select a group and date range, then click "Generate" to view insights</p>
              <button
                onClick={() => { setActiveTab('insights'); loadInsights(); }}
                className="mt-4 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition text-sm"
              >
                Load Insights
              </button>
            </div>
          )}
        </div>
      )}

      {/* Empty state for review tab */}
      {activeTab === 'review' && !review && !loading && !error && (
        <div className="bg-dark-700 rounded-xl p-12 text-center">
          <ClipboardCheck size={48} className="mx-auto text-theme-muted mb-4" />
          <p className="text-theme-muted">Select a company group and click "Generate" to view the CFO review</p>
        </div>
      )}
    </div>
  );
}
