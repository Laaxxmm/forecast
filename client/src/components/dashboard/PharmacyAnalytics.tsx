import { useEffect, useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line,
} from 'recharts';
import api from '../../api/client';
import { formatINR, formatNumber, getMonthLabel } from '../../utils/format';
import {
  Pill, ShoppingCart, TrendingUp, Package, AlertTriangle, Search,
  ChevronLeft, ChevronRight, DollarSign, Users, FileText, Gift,
  BarChart3, ArrowRightLeft, Warehouse, Clock, Download,
} from 'lucide-react';
import { downloadXlsx, PURCHASE_COLUMNS, SALES_COLUMNS, STOCK_COLUMNS,
  PHARMA_PURCHASE_EXPORT_COLUMNS, PHARMA_SALES_EXPORT_COLUMNS } from '../../utils/xlsxExport';
import DataTable, { type ColumnDef } from '../common/DataTable';

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#f97316', '#84cc16'];
const CHART_STYLE = { backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '12px' };

const TABS = [
  { key: 'purchases', label: 'Purchases', icon: ShoppingCart },
  { key: 'sales', label: 'Sales & Profit', icon: TrendingUp },
  { key: 'stock', label: 'Stock & Expiry', icon: Package },
  { key: 'cross', label: 'Cross-Report', icon: ArrowRightLeft },
] as const;

type TabKey = typeof TABS[number]['key'];

interface PharmacyAnalyticsProps {
  isVisible: (key: string) => boolean;
  startMonth?: string | null;
  endMonth?: string | null;
}

export default function PharmacyAnalytics({ isVisible, startMonth, endMonth }: PharmacyAnalyticsProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('purchases');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    const params: Record<string, string> = {};
    if (startMonth) params.startMonth = startMonth;
    if (endMonth) params.endMonth = endMonth;

    setLoading(true);
    api.get('/dashboard/pharmacy-analytics', { params }).then(res => {
      setData(res.data);
      if (res.data?.hasData) {
        if (res.data.hasPurchases) setActiveTab('purchases');
        else if (res.data.hasSales) setActiveTab('sales');
        else if (res.data.hasStock) setActiveTab('stock');
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [startMonth, endMonth]);

  // Reset search/page on tab change
  useEffect(() => { setSearch(''); setPage(0); }, [activeTab]);

  if (loading) return (
    <div className="text-center py-8">
      <div className="w-6 h-6 border-2 border-teal-500/30 border-t-teal-500 rounded-full animate-spin mx-auto" />
    </div>
  );

  if (!data?.hasData) return null;

  // Check if any pharmacy visualization is visible
  const allKeys = [
    // Purchase cards
    'pharma_total_purchase', 'pharma_total_invoices', 'pharma_unique_stockists',
    'pharma_unique_products', 'pharma_total_free_qty', 'pharma_total_tax',
    // Purchase charts
    'pharma_monthly_purchase_trend', 'pharma_top_stockists', 'pharma_top_manufacturers',
    'pharma_top_purchase_products', 'pharma_profit_margin_dist', 'pharma_free_qty_analysis',
    'pharma_purchase_table',
    // Sales cards
    'pharma_total_sales', 'pharma_total_cogs', 'pharma_total_profit',
    'pharma_profit_margin', 'pharma_total_bills', 'pharma_unique_patients',
    // Sales charts
    'pharma_monthly_sales_trend', 'pharma_top_drugs_sales', 'pharma_top_drugs_profit',
    'pharma_referral_analysis', 'pharma_sales_vs_cogs', 'pharma_top_patients',
    'pharma_sales_table',
    // Stock cards
    'pharma_stock_value', 'pharma_stock_skus', 'pharma_near_expiry',
    'pharma_expired_items', 'pharma_total_batches',
    // Stock charts
    'pharma_expiry_zones', 'pharma_top_stock_products', 'pharma_stock_table',
    // Cross cards/charts
    'pharma_cross_kpis', 'pharma_purchase_vs_sales', 'pharma_dead_stock',
  ];
  if (!allKeys.some(isVisible)) return null;

  // Determine which tabs are available
  const availableTabs = TABS.filter(t => {
    if (t.key === 'purchases') return data.hasPurchases;
    if (t.key === 'sales') return data.hasSales;
    if (t.key === 'stock') return data.hasStock;
    if (t.key === 'cross') return data.hasSales && data.hasPurchases;
    return false;
  });

  return (
    <div className="mt-8">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <Pill size={18} className="text-teal-400" />
        <h2 className="text-lg font-bold text-theme-heading">Pharmacy Analytics</h2>
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-400">OneGlance</span>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {availableTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === tab.key
                ? 'bg-teal-500/20 text-teal-400 border border-teal-500/30'
                : 'bg-dark-600/50 text-theme-faint border border-transparent hover:text-theme-secondary hover:bg-dark-600'
            }`}
          >
            <tab.icon size={13} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'purchases' && data.purchases && (
        <PurchasesTab data={data.purchases} isVisible={isVisible} search={search} setSearch={setSearch} page={page} setPage={setPage} pageSize={PAGE_SIZE} fyStart={data.fyStart} fyEnd={data.fyEnd} />
      )}
      {activeTab === 'sales' && data.sales && (
        <SalesTab data={data.sales} isVisible={isVisible} search={search} setSearch={setSearch} page={page} setPage={setPage} pageSize={PAGE_SIZE} fyStart={data.fyStart} fyEnd={data.fyEnd} />
      )}
      {activeTab === 'stock' && data.stock && (
        <StockTab data={data.stock} isVisible={isVisible} search={search} setSearch={setSearch} page={page} setPage={setPage} pageSize={PAGE_SIZE} fyStart={data.fyStart} fyEnd={data.fyEnd} />
      )}
      {activeTab === 'cross' && data.crossInsights && (
        <CrossTab data={data.crossInsights} isVisible={isVisible} />
      )}
    </div>
  );
}

// ── Mini KPI Card ────────────────────────────────────────────────────────────

function MiniKPI({ label, value, icon: Icon, color, sub }: {
  label: string; value: string; icon: any; color: string; sub?: string;
}) {
  const colorMap: Record<string, string> = {
    teal: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    rose: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    cyan: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  };
  const c = colorMap[color] || colorMap.teal;
  return (
    <div className={`rounded-xl border p-3 ${c.split(' ').slice(2).join(' ')} ${c.split(' ')[0]}`}>
      <Icon size={16} className={c.split(' ')[1]} />
      <p className="text-lg font-bold text-theme-heading mt-2">{value}</p>
      <p className="text-[11px] text-theme-faint">{label}</p>
      {sub && <p className="text-[10px] text-theme-faint mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Table Pagination ─────────────────────────────────────────────────────────

function TablePagination({ page, totalPages, setPage }: { page: number; totalPages: number; setPage: (fn: (p: number) => number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between mt-3 pt-3 border-t border-dark-400/20">
      <span className="text-xs text-theme-faint">Page {page + 1} of {totalPages}</span>
      <div className="flex gap-1">
        <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
          className="p-1.5 rounded-lg text-theme-faint hover:text-theme-secondary disabled:opacity-30"><ChevronLeft size={14} /></button>
        <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
          className="p-1.5 rounded-lg text-theme-faint hover:text-theme-secondary disabled:opacity-30"><ChevronRight size={14} /></button>
      </div>
    </div>
  );
}

// ── PURCHASES TAB ────────────────────────────────────────────────────────────

interface TabProps {
  data: any;
  isVisible: (key: string) => boolean;
  search: string;
  setSearch: (s: string) => void;
  page: number;
  setPage: (fn: (p: number) => number) => void;
  pageSize: number;
  fyStart?: string;
  fyEnd?: string;
}

async function exportFromDb(source: string, columns: any[], filename: string, fyStart?: string, fyEnd?: string) {
  try {
    const from = fyStart || '2000-01-01';
    const to = fyEnd || '2099-12-31';
    const res = await api.get(`/import/export/${source}`, { params: { from, to } });
    const { rows, count } = res.data;
    if (!rows || count === 0) { alert('No data found'); return; }
    downloadXlsx(rows, columns, filename);
  } catch { alert('Download failed'); }
}

// ── Purchases-tab visual primitives ──────────────────────────────────────────
//
// These live next to PurchasesTab (and not in components/common) because
// they encode tab-specific design choices: a 5-card tinted KPI strip with
// same-ramp text, a margin pill with a fixed bracket→colour mapping, and a
// margin-bracket progress bar that has to use the same palette as the pills.
// If/when Sales & Profit, Stock & Expiry, or Cross-Report adopt the same
// language we can lift these into common; until then they belong here so the
// shared MiniKPI used by the other tabs stays untouched.

type PurchaseTone = 'green' | 'blue' | 'purple' | 'amber' | 'coral' | 'teal';

// Soft tint backgrounds + same-ramp dark text. Each tone exposes:
//   bg     — card fill (alpha tint, works in both light + dark themes)
//   border — soft outline matching the tint
//   label  — top label colour (dark stop in light, mid stop in dark)
//   value  — main number colour (darkest stop in light, lightest dark-mode stop)
//   sub    — sub-line colour (slightly muted version of label)
const PURCHASE_TONES: Record<PurchaseTone, { bg: string; border: string; label: string; value: string; sub: string }> = {
  green:  { bg: 'bg-emerald-500/10', border: 'border-emerald-500/15', label: 'text-emerald-700 dark:text-emerald-400', value: 'text-emerald-900 dark:text-emerald-300', sub: 'text-emerald-700/70 dark:text-emerald-400/70' },
  blue:   { bg: 'bg-blue-500/10',    border: 'border-blue-500/15',    label: 'text-blue-700 dark:text-blue-400',       value: 'text-blue-900 dark:text-blue-300',       sub: 'text-blue-700/70 dark:text-blue-400/70' },
  purple: { bg: 'bg-purple-500/10',  border: 'border-purple-500/15',  label: 'text-purple-700 dark:text-purple-400',   value: 'text-purple-900 dark:text-purple-300',   sub: 'text-purple-700/70 dark:text-purple-400/70' },
  amber:  { bg: 'bg-amber-500/10',   border: 'border-amber-500/15',   label: 'text-amber-800 dark:text-amber-400',     value: 'text-amber-900 dark:text-amber-300',     sub: 'text-amber-800/70 dark:text-amber-400/70' },
  coral:  { bg: 'bg-rose-500/10',    border: 'border-rose-500/15',    label: 'text-rose-700 dark:text-rose-400',       value: 'text-rose-900 dark:text-rose-300',       sub: 'text-rose-700/70 dark:text-rose-400/70' },
  teal:   { bg: 'bg-teal-500/10',    border: 'border-teal-500/15',    label: 'text-teal-700 dark:text-teal-400',       value: 'text-teal-900 dark:text-teal-300',       sub: 'text-teal-700/70 dark:text-teal-400/70' },
};

function PurchaseKPI({ tone, label, value, sub }: { tone: PurchaseTone; label: string; value: string; sub?: string }) {
  const t = PURCHASE_TONES[tone];
  return (
    <div className={`rounded-xl border p-3 ${t.bg} ${t.border}`}>
      <p className={`text-[11px] font-medium ${t.label}`}>{label}</p>
      <p className={`text-xl font-medium mt-1 ${t.value}`}>{value}</p>
      {sub && <p className={`text-[11px] mt-1 ${t.sub}`}>{sub}</p>}
    </div>
  );
}

// DB returns range strings with hyphens; render uses en-dash for typography.
const RANGE_DISPLAY: Record<string, string> = {
  'Loss': 'Loss', '0-10%': '0–10%', '10-20%': '10–20%',
  '20-30%': '20–30%', '30-50%': '30–50%', '50%+': '50%+',
  'Unknown': 'Unknown',
};

// Bar segment colours — saturated stops since segments may be narrow.
// 20–30% is the dark-blue from the spec, 10–20% is teal-green, 50%+ is purple.
const RANGE_BAR_COLOR: Record<string, string> = {
  'Loss': '#dc2626', '0-10%': '#ea580c', '10-20%': '#059669',
  '20-30%': '#1d4ed8', '30-50%': '#0891b2', '50%+': '#7c3aed',
  'Unknown': '#64748b',
};

// Pill colours for per-product margin badges. Same ramp as the bar segments.
const RANGE_PILL: Record<string, string> = {
  'Loss':    'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20',
  '0-10%':   'bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20',
  '10-20%':  'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
  '20-30%':  'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20',
  '30-50%':  'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20',
  '50%+':    'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20',
  'Unknown': 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
};

function bracketFor(pct: number | null | undefined): string {
  if (pct == null || isNaN(pct)) return 'Unknown';
  if (pct < 0) return 'Loss';
  if (pct < 10) return '0-10%';
  if (pct < 20) return '10-20%';
  if (pct < 30) return '20-30%';
  if (pct < 50) return '30-50%';
  return '50%+';
}

function PurchasesTab({ data, isVisible, fyStart, fyEnd }: TabProps) {
  const { kpi, monthlyTrend, topStockists, topManufacturers, topProducts, profitMarginDist, freeQtyAnalysis, table } = data;
  const [showAllMfg, setShowAllMfg] = useState(false);
  const [showAllProducts, setShowAllProducts] = useState(false);

  // ── Visibility gates ─────────────────────────────────────────────────────
  // Each former visibility key is mapped to its place in the new layout. Old
  // keys are kept (no schema break) — `pharma_total_tax` now drives the
  // "incl. ₹X tax" sub-line under Total Purchase rather than its own card.
  const showTotalPurchase = isVisible('pharma_total_purchase');
  const showTaxSub        = isVisible('pharma_total_tax');
  const showInvoices      = isVisible('pharma_total_invoices');
  const showStockistsKpi  = isVisible('pharma_unique_stockists');
  const showProductsKpi   = isVisible('pharma_unique_products');
  const showFreeQtyKpi    = isVisible('pharma_total_free_qty');
  const showStockistList  = isVisible('pharma_top_stockists');
  const showMfgList       = isVisible('pharma_top_manufacturers');
  const showFreeCallout   = isVisible('pharma_free_qty_analysis');
  const showProductList   = isVisible('pharma_top_purchase_products');
  const showMarginDist    = isVisible('pharma_profit_margin_dist');
  const showTrend         = isVisible('pharma_monthly_purchase_trend');
  const showTable         = isVisible('pharma_purchase_table');

  // ── Derived values ───────────────────────────────────────────────────────
  const trendData = useMemo(
    () => (monthlyTrend || []).map((m: any) => ({ ...m, label: getMonthLabel(m.month) })),
    [monthlyTrend],
  );
  // Single-month periods make the bar chart look broken (one bar pair filling
  // the canvas), so the chart is gated to ≥3 months of data even when the
  // visibility toggle is on.
  const renderTrend = showTrend && trendData.length >= 3;

  const totalPurchase = Number(kpi?.totalPurchaseValue) || 0;
  const totalTax = Number(kpi?.totalTax) || 0;
  const totalInvoices = Number(kpi?.totalInvoices) || 0;
  const avgInvoiceValue = totalInvoices > 0 ? totalPurchase / totalInvoices : 0;
  const totalFreeQty = Number(kpi?.totalFreeQty) || 0;
  const freeStockistCount = (freeQtyAnalysis || []).length;

  // Sourcing card — concentration risk on the top stockist.
  const totalSourcing = (topStockists || []).reduce((s: number, x: any) => s + (Number(x.value) || 0), 0);
  const topStockistShare = totalSourcing > 0 && topStockists?.length
    ? Math.round((Number(topStockists[0].value) / totalSourcing) * 100)
    : 0;
  const topStockistName = topStockists?.[0]?.name || '';
  const stockistCount = topStockists?.length || 0;

  // Free-qty annotation map for stockist rows.
  const freeQtyByStockist = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of freeQtyAnalysis || []) m.set(f.name, Number(f.freeQty) || 0);
    return m;
  }, [freeQtyAnalysis]);

  const maxStockistVal = Number(topStockists?.[0]?.value) || 1;
  const maxMfgVal = Number(topManufacturers?.[0]?.value) || 1;
  const visibleMfg = showAllMfg ? (topManufacturers || []) : (topManufacturers || []).slice(0, 5);

  // Free-quantity callout — total rupee value of free units (free_qty × unit
  // purchase rate of that batch), plus the most prominent free-qty line for
  // the supporting copy.
  const tableRows: any[] = table || [];
  const freeRows = tableRows.filter((r: any) => (Number(r.free_qty) || 0) > 0);
  const totalFreeValue = freeRows.reduce((sum: number, r: any) => {
    const fq = Number(r.free_qty) || 0;
    const bq = Number(r.batch_qty) || 0;
    const pv = Number(r.purchase_value) || 0;
    if (bq <= 0 || fq <= 0) return sum;
    return sum + fq * (pv / bq);
  }, 0);
  const topFreeRow = freeRows.slice().sort((a: any, b: any) => (Number(b.free_qty) || 0) - (Number(a.free_qty) || 0))[0];
  const topFreeStockist = (freeQtyAnalysis || [])[0];

  // Per-product margin avg + free-qty totals for the products card and table.
  const productMargin = useMemo(() => {
    const acc = new Map<string, { sum: number; n: number }>();
    for (const r of tableRows) {
      const p = Number(r.profit_pct);
      if (r.profit_pct == null || isNaN(p)) continue;
      const e = acc.get(r.drug_name) || { sum: 0, n: 0 };
      e.sum += p; e.n++;
      acc.set(r.drug_name, e);
    }
    const out = new Map<string, number>();
    for (const [k, v] of acc) if (v.n > 0) out.set(k, v.sum / v.n);
    return out;
  }, [tableRows]);

  const productFreeQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of tableRows) {
      const fq = Number(r.free_qty) || 0;
      if (fq > 0) m.set(r.drug_name, (m.get(r.drug_name) || 0) + fq);
    }
    return m;
  }, [tableRows]);

  // Margin distribution segments — non-empty brackets only, normalised pcts.
  type MarginSegment = { range: string; count: number; pct: number };
  const marginSegments = useMemo<MarginSegment[]>(() => {
    const dist = (profitMarginDist || []).filter((b: any) => (Number(b.count) || 0) > 0);
    const total = dist.reduce((s: number, b: any) => s + (Number(b.count) || 0), 0);
    return dist.map((b: any) => ({
      range: String(b.range),
      count: Number(b.count) || 0,
      pct: total > 0 ? (Number(b.count) / total) * 100 : 0,
    }));
  }, [profitMarginDist]);

  const totalProductCount = Number(kpi?.uniqueProducts) || marginSegments.reduce((s, b) => s + b.count, 0);
  const visibleProducts = showAllProducts ? (topProducts || []) : (topProducts || []).slice(0, 8);
  const productCardVisibleCount = visibleProducts.length;

  // Visible KPI count drives the lg grid template.
  const visibleKPI = [showTotalPurchase, showInvoices, showStockistsKpi, showProductsKpi, showFreeQtyKpi].filter(Boolean).length;
  const kpiColCls: Record<number, string> = { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5' };

  const showSourcingCard = (showStockistList && (topStockists?.length || 0) > 0) || (showMfgList && (topManufacturers?.length || 0) > 0);
  const showProductsCard = ((showProductList && (topProducts?.length || 0) > 0) || (showMarginDist && marginSegments.length > 0));

  return (
    <div>
      {/* ── KPI strip (5 tinted cards) ─────────────────────────────────── */}
      {visibleKPI > 0 && (
        <div className={`grid grid-cols-2 md:grid-cols-3 ${kpiColCls[visibleKPI] || 'lg:grid-cols-5'} gap-4 mb-6`}>
          {showTotalPurchase && (
            <PurchaseKPI
              tone="green"
              label="Total purchase"
              value={formatINR(totalPurchase)}
              sub={showTaxSub && totalTax > 0 ? `incl. ${formatINR(totalTax)} tax` : undefined}
            />
          )}
          {showInvoices && (
            <PurchaseKPI
              tone="blue"
              label="Invoices"
              value={formatNumber(totalInvoices)}
              sub={avgInvoiceValue > 0 ? `avg ${formatINR(avgInvoiceValue)}` : undefined}
            />
          )}
          {showStockistsKpi && (
            <PurchaseKPI
              tone="purple"
              label="Stockists"
              value={formatNumber(Number(kpi?.uniqueStockists) || 0)}
              sub="active suppliers"
            />
          )}
          {showProductsKpi && (
            <PurchaseKPI
              tone="amber"
              label="Products"
              value={formatNumber(Number(kpi?.uniqueProducts) || 0)}
              sub="unique SKUs"
            />
          )}
          {showFreeQtyKpi && (
            <PurchaseKPI
              tone="coral"
              label="Free quantity"
              value={formatNumber(totalFreeQty)}
              sub={freeStockistCount > 0
                ? `from ${freeStockistCount} stockist${freeStockistCount === 1 ? '' : 's'}`
                : 'none received'}
            />
          )}
        </div>
      )}

      {/* ── Monthly trend (only when ≥3 months of data) ─────────────────── */}
      {renderTrend && (
        <div className="card mb-6">
          <h3 className="text-base font-medium text-theme-heading mb-1">Monthly purchase trend</h3>
          <p className="text-[13px] text-theme-faint mb-4">Purchase value and invoice count over time</p>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={trendData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
              <Legend />
              <Bar dataKey="purchaseValue" name="Gross Purchase" fill="#3b82f6" radius={[6, 6, 0, 0]} />
              <Bar dataKey="netPurchase" name="Net Purchase" fill="#10b981" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── "Where the money is going" sourcing card ────────────────────── */}
      {showSourcingCard && (
        <div className="card mb-6">
          <h3 className="text-base font-medium text-theme-heading">Where the money is going</h3>
          <p className="text-[13px] text-theme-faint mt-0.5 mb-1">By purchase value</p>
          {topStockistName && topStockistShare >= 50 && (
            <p className="text-[12px] text-amber-700 dark:text-amber-400 mb-5">
              {topStockistName} accounts for ~{topStockistShare}% of purchases — high concentration risk
            </p>
          )}
          {topStockistName && topStockistShare > 0 && topStockistShare < 50 && (
            <p className="text-[12px] text-theme-faint mb-5">
              {topStockistName} leads at ~{topStockistShare}% of purchases
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            {/* Stockists column */}
            {showStockistList && (topStockists?.length || 0) > 0 && (
              <div>
                <p className="text-[12px] uppercase tracking-[0.5px] text-theme-muted mb-2.5">
                  STOCKISTS ({stockistCount})
                </p>
                <div className="space-y-3">
                  {topStockists.map((s: any) => {
                    const pct = totalSourcing > 0 ? (Number(s.value) / totalSourcing) * 100 : 0;
                    const barWidth = Math.max(2, (Number(s.value) / maxStockistVal) * 100);
                    const stockistFreeQty = freeQtyByStockist.get(s.name) || 0;
                    return (
                      <div key={s.name}>
                        <div className="flex items-baseline justify-between gap-3 mb-1">
                          <span className="text-sm font-medium text-theme-primary truncate">{s.name}</span>
                          <span className="text-sm text-theme-heading shrink-0 tabular-nums">{formatINR(Number(s.value) || 0)}</span>
                        </div>
                        <div className="h-[6px] rounded-full bg-blue-500/10 overflow-hidden">
                          <div className="h-full bg-blue-500/70 rounded-full" style={{ width: `${barWidth}%` }} />
                        </div>
                        <div className="flex justify-between mt-1 text-[11px] text-theme-faint">
                          <span>{Math.round(pct)}% of total</span>
                          {stockistFreeQty > 0 && (
                            <span className="text-emerald-700 dark:text-emerald-400">+{formatNumber(stockistFreeQty)} free qty</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Manufacturers column */}
            {showMfgList && (topManufacturers?.length || 0) > 0 && (
              <div>
                <p className="text-[12px] uppercase tracking-[0.5px] text-theme-muted mb-2.5">
                  TOP MANUFACTURERS
                </p>
                <div className="space-y-3">
                  {visibleMfg.map((m: any) => {
                    const barWidth = Math.max(2, (Number(m.value) / maxMfgVal) * 100);
                    return (
                      <div key={m.name}>
                        <div className="flex items-baseline justify-between gap-3 mb-1">
                          <span className="text-sm font-medium text-theme-primary truncate">{m.name}</span>
                          <span className="text-sm text-theme-heading shrink-0 tabular-nums">{formatINR(Number(m.value) || 0)}</span>
                        </div>
                        <div className="h-[5px] rounded-full bg-purple-500/10 overflow-hidden">
                          <div className="h-full bg-purple-500/70 rounded-full" style={{ width: `${barWidth}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(topManufacturers?.length || 0) > 5 && (
                  <button
                    onClick={() => setShowAllMfg(v => !v)}
                    className="mt-3 text-[12px] text-theme-faint hover:text-theme-secondary transition-colors"
                  >
                    {showAllMfg
                      ? 'Show fewer'
                      : `+ ${topManufacturers.length - 5} more · view all`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Free-quantity callout banner ────────────────────────────────── */}
      {showFreeCallout && topFreeStockist && (
        <div
          className="flex items-center justify-between gap-4 mb-6 px-5 py-4 rounded-xl border bg-emerald-500/10 border-emerald-500/15"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
              Free quantity recovered: {formatINR(Math.round(totalFreeValue))} in value
            </p>
            <p className="text-[12px] text-emerald-700/80 dark:text-emerald-400/80 mt-1 truncate">
              {topFreeStockist.name} provided {formatNumber(Number(topFreeStockist.freeQty) || 0)} free unit
              {Number(topFreeStockist.freeQty) === 1 ? '' : 's'}
              {' '}({Number(topFreeStockist.freePct) || 0}% of batch)
              {topFreeRow?.drug_name ? ` on ${topFreeRow.drug_name}` : ''} — keep negotiating
            </p>
          </div>
          <p className="text-2xl font-medium text-emerald-900 dark:text-emerald-200 shrink-0 tabular-nums">
            {Number(topFreeStockist.freePct) || 0}%
          </p>
        </div>
      )}

      {/* ── "Top products by purchase value" card ───────────────────────── */}
      {showProductsCard && (
        <div className="card mb-6">
          <div className="flex items-start justify-between gap-3 mb-1">
            <div>
              <h3 className="text-base font-medium text-theme-heading">Top products by purchase value</h3>
              <p className="text-[13px] text-theme-faint mt-0.5">Margin bracket shown alongside each product</p>
            </div>
            {showProductList && (topProducts?.length || 0) > 0 && (
              <p className="text-[12px] text-theme-faint shrink-0">
                Showing {productCardVisibleCount} of {totalProductCount || (topProducts?.length || 0)}
              </p>
            )}
          </div>

          {/* Margin distribution stacked bar */}
          {showMarginDist && marginSegments.length > 0 && (
            <div className="mt-5 mb-5">
              <p className="text-[11px] text-theme-faint mb-1.5">
                Margin distribution across {totalProductCount || marginSegments.reduce((s, b) => s + b.count, 0)} products
              </p>
              <div className="flex h-[22px] rounded-md overflow-hidden">
                {marginSegments.map((seg, i) => (
                  <div
                    key={seg.range}
                    title={`${RANGE_DISPLAY[seg.range] || seg.range}: ${seg.count} products (${Math.round(seg.pct)}%)`}
                    className="flex items-center justify-center text-[11px] font-medium text-white whitespace-nowrap overflow-hidden"
                    style={{
                      width: `${seg.pct}%`,
                      backgroundColor: RANGE_BAR_COLOR[seg.range] || '#64748b',
                      borderRight: i < marginSegments.length - 1 ? '1px solid rgba(255,255,255,0.6)' : undefined,
                    }}
                  >
                    {seg.pct >= 8 ? `${RANGE_DISPLAY[seg.range] || seg.range} · ${Math.round(seg.pct)}%` : ''}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-[11px] text-theme-faint">
                {marginSegments.map(seg => (
                  <span key={seg.range} className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: RANGE_BAR_COLOR[seg.range] || '#64748b' }} />
                    {RANGE_DISPLAY[seg.range] || seg.range}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Product table inside the card */}
          {showProductList && (topProducts?.length || 0) > 0 && (
            <div>
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-1 pb-2 text-[11px] uppercase tracking-[0.5px] text-theme-muted border-b border-dark-400/20">
                <span>Product</span>
                <span className="text-right">Purchase value</span>
                <span className="text-right">Margin</span>
              </div>
              <div className="divide-y divide-dark-400/10">
                {visibleProducts.map((p: any) => {
                  const fq = productFreeQty.get(p.name) || 0;
                  const margin = productMargin.get(p.name);
                  const bracket = bracketFor(margin);
                  return (
                    <div key={p.name} className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center px-1 py-2.5 text-sm">
                      <span className="text-theme-primary truncate">
                        {p.name}
                        {fq > 0 && (
                          <span className="ml-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">+{formatNumber(fq)} free</span>
                        )}
                      </span>
                      <span className="text-theme-heading text-right tabular-nums">{formatINR(Number(p.value) || 0)}</span>
                      <span className="text-right">
                        {margin == null ? (
                          <span className="text-theme-faint text-[11px]">—</span>
                        ) : (
                          <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] border ${RANGE_PILL[bracket]}`}>
                            {margin.toFixed(1)}%
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              {(topProducts?.length || 0) > 8 && (
                <button
                  onClick={() => setShowAllProducts(v => !v)}
                  className="mt-3 text-[12px] text-theme-faint hover:text-theme-secondary transition-colors"
                >
                  {showAllProducts
                    ? 'Show fewer'
                    : `+ ${(topProducts?.length || 0) - 8} more · view all`}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Purchase details table ──────────────────────────────────────── */}
      {showTable && tableRows.length > 0 && (() => {
        const enriched = tableRows.map((r: any) => ({
          ...r,
          _hasFreeQty: (Number(r.free_qty) || 0) > 0,
        }));
        const cols: ColumnDef<typeof enriched[number]>[] = [
          { key: 'invoice_no', header: 'Invoice', cellClassName: 'font-mono text-xs', width: 'max-w-[110px]' },
          { key: 'invoice_date', header: 'Date', type: 'date' },
          { key: 'stockiest_name', header: 'Stockist', cellClassName: 'truncate max-w-[140px]' },
          { key: 'drug_name', header: 'Drug', cellClassName: 'truncate max-w-[200px]', render: (r) => (
            <>
              {r.drug_name}
              {r._hasFreeQty && (
                <span title={`Received ${r.free_qty} free unit(s) on this batch.`}
                  className="ml-1.5 text-[11px] text-emerald-700 dark:text-emerald-400 align-middle">
                  +{r.free_qty} free
                </span>
              )}
            </>
          ) },
          { key: 'batch_qty', header: 'Batch Qty', type: 'number', format: 'number' },
          { key: 'purchase_value', header: 'Purchase Val', type: 'number', format: 'currency' },
          { key: 'tax_amount', header: 'Tax', type: 'number', format: 'currency' },
          { key: 'profit_pct', header: 'Margin', type: 'number', accessor: r => r.profit_pct,
            render: (r) => {
              if (r.profit_pct == null) return <span className="text-theme-faint">—</span>;
              const bracket = bracketFor(Number(r.profit_pct));
              return (
                <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] border ${RANGE_PILL[bracket]}`}>
                  {Number(r.profit_pct).toFixed(1)}%
                </span>
              );
            } },
        ];
        return (
          <div className="card mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-medium text-theme-heading">Purchase details</h3>
                <p className="text-[13px] text-theme-faint">
                  {formatNumber(tableRows.length)} line item{tableRows.length === 1 ? '' : 's'}
                  {totalInvoices > 0 ? ` across ${formatNumber(totalInvoices)} invoice${totalInvoices === 1 ? '' : 's'}` : ''}
                </p>
              </div>
              <button onClick={() => exportFromDb('pharma-purchase', PHARMA_PURCHASE_EXPORT_COLUMNS, 'Purchase_Details', fyStart, fyEnd)}
                className="btn btn-sm btn-ghost flex items-center gap-1.5 text-xs text-theme-faint hover:text-accent-500" title="Download XLSX">
                <Download size={14} /> Download
              </button>
            </div>
            <DataTable
              columns={cols}
              rows={enriched}
              pageSize={10}
              searchPlaceholder="Search drug, stockist, invoice..."
              rowClassName={r => r._hasFreeQty ? 'bg-emerald-500/10' : ''}
            />
          </div>
        );
      })()}
    </div>
  );
}

// ── SALES TAB ────────────────────────────────────────────────────────────────

function SalesTab({ data, isVisible, search, setSearch, page, setPage, pageSize, fyStart, fyEnd }: TabProps) {
  const { kpi, monthlyTrend, topDrugsBySales, topDrugsByProfit, referralAnalysis, topPatients, table } = data;

  const cardKeys = ['pharma_total_sales', 'pharma_total_cogs', 'pharma_total_profit', 'pharma_profit_margin', 'pharma_total_bills', 'pharma_unique_patients'];
  const chartKeys = ['pharma_monthly_sales_trend', 'pharma_top_drugs_sales', 'pharma_top_drugs_profit', 'pharma_referral_analysis', 'pharma_sales_vs_cogs', 'pharma_top_patients'];
  const anyCardVisible = cardKeys.some(isVisible);
  const anyChartVisible = chartKeys.some(isVisible);
  const tableVisible = isVisible('pharma_sales_table');

  const filteredTable = useMemo(() => {
    if (!search || !table) return table || [];
    const s = search.toLowerCase();
    return table.filter((r: any) =>
      (r.drug_name || '').toLowerCase().includes(s) ||
      (r.patient_name || '').toLowerCase().includes(s) ||
      (r.bill_no || '').toLowerCase().includes(s)
    );
  }, [table, search]);

  const trendData = monthlyTrend?.map((m: any) => ({ ...m, label: getMonthLabel(m.month) })) || [];
  const totalPages = Math.ceil(filteredTable.length / pageSize);
  const pageRows = filteredTable.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div>
      {/* KPI Cards */}
      {anyCardVisible && (() => {
        const visibleCount = cardKeys.filter(isVisible).length;
        const cols: Record<number, string> = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6' };
        return (
          <div className={`grid grid-cols-2 md:grid-cols-3 ${cols[visibleCount] || 'lg:grid-cols-6'} gap-4 mb-3`}>
            {isVisible('pharma_total_sales') && (
              // Headline sales card shows NET of GST so it reads as
              // P&L revenue (matches Gross Profit / Margin which are
              // also computed off net sales). Gross sales incl. GST is
              // still surfaced in the footnote below + the Sales table
              // for GST-filing reconciliation. Falls back to
              // (totalSales - totalTax) for legacy responses without
              // `totalNetSales`.
              <MiniKPI
                label="Net Sales (ex-GST)"
                sub="Top-line revenue"
                value={formatINR(kpi.totalNetSales ?? Math.max(0, (kpi.totalSales || 0) - (kpi.totalTax || 0)))}
                icon={TrendingUp}
                color="teal"
              />
            )}
            {isVisible('pharma_total_cogs') && <MiniKPI label="COGS (ex-GST)" sub="Net purchase rate" value={formatINR(kpi.totalCogs)} icon={DollarSign} color="blue" />}
            {isVisible('pharma_total_profit') && <MiniKPI label="Gross Profit" sub="Net Sales − COGS" value={formatINR(kpi.totalGrossProfit ?? kpi.totalProfit)} icon={TrendingUp} color="emerald" />}
            {isVisible('pharma_profit_margin') && <MiniKPI label="Gross Margin %" sub="On Net Sales (ex-GST)" value={`${kpi.grossMarginPct ?? kpi.profitMargin}%`} icon={BarChart3} color="purple" />}
            {isVisible('pharma_total_bills') && <MiniKPI label="Total Bills" value={formatNumber(kpi.totalBills)} icon={FileText} color="amber" />}
            {isVisible('pharma_unique_patients') && <MiniKPI label="Unique Patients" value={formatNumber(kpi.uniquePatients)} icon={Users} color="cyan" />}
          </div>
        );
      })()}

      {/* Profit math footnote — explains the GST-inclusive vs ex-GST split.
          Headline card now shows Net Sales (ex-GST), so the footnote
          surfaces Gross Sales (for GST-filing reconciliation) plus the
          sanity-check identity (reported − correct ≡ tax collected). */}
      {anyCardVisible && kpi && (
        <div className="text-[11px] text-theme-faint mb-6 px-3 py-2 rounded-lg border border-dark-400/20 bg-dark-700/30 leading-relaxed">
          <span className="font-medium text-theme-secondary">Gross Sales (incl. GST · for filing):</span>{' '}
          {formatINR(kpi.totalSales || 0)}
          {' · '}
          <span className="font-medium text-theme-secondary">GST collected (govt liability, not income):</span>{' '}
          {formatINR(kpi.totalTax || 0)}
          {kpi.reportedProfit != null && (
            <>
              {' · '}
              <span className="font-medium text-theme-secondary">Source-system &quot;profit&quot; was overstated by:</span>{' '}
              {formatINR((kpi.reportedProfit || 0) - (kpi.totalGrossProfit ?? kpi.totalProfit ?? 0))}
              <span className="text-theme-faint"> (matches GST collected — sanity check)</span>
            </>
          )}
          <span className="block mt-1 text-theme-faint">
            Gross Profit is profit on goods only — operating expenses (rent, salaries, expiries) still need to be deducted to get bottom-line profit.
          </span>
        </div>
      )}

      {/* Charts */}
      {anyChartVisible && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          {/* Monthly Sales & Profitability — uses ex-GST values so the green
              bar (Net Sales) and purple bar (Gross Profit) are directly
              comparable to COGS, which is also ex-GST. */}
          {isVisible('pharma_monthly_sales_trend') && trendData.length > 0 && (
            <div className="card lg:col-span-2">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Monthly Sales &amp; Profitability</h3>
              <p className="text-xs text-theme-faint mb-4">Net Sales (ex-GST), COGS, and Gross Profit per month</p>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={trendData} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Legend />
                  <Bar dataKey="netSales" name="Net Sales (ex-GST)" fill="#10b981" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="cogs" name="COGS" fill="#3b82f6" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="grossProfit" name="Gross Profit" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Net Sales vs COGS — both ex-GST so the gap = Gross Profit. */}
          {isVisible('pharma_sales_vs_cogs') && trendData.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Net Sales vs COGS</h3>
              <p className="text-xs text-theme-faint mb-4">Both ex-GST · gap = Gross Profit</p>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Legend />
                  <Line type="monotone" dataKey="netSales" name="Net Sales" stroke="#10b981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="cogs" name="COGS" stroke="#ef4444" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top Drugs by Sales */}
          {isVisible('pharma_top_drugs_sales') && topDrugsBySales?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Top Drugs by Revenue</h3>
              <p className="text-xs text-theme-faint mb-4">Highest selling medicines</p>
              <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
                {topDrugsBySales.map((d: any, i: number) => {
                  const maxVal = topDrugsBySales[0]?.sales || 1;
                  const width = Math.max(4, (d.sales / maxVal) * 100);
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-theme-secondary truncate mr-2">{d.name}</span>
                        <span className="text-theme-heading font-medium shrink-0">{formatINR(d.sales)}</span>
                      </div>
                      <div className="h-5 rounded-md overflow-hidden bg-dark-600">
                        <div className="h-full rounded-md" style={{ width: `${width}%`, backgroundColor: COLORS[i % COLORS.length] }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Top Drugs by Gross Profit — uses recomputed gross profit (Net Sales − COGS),
              not the source-system 'profit' which leaves GST inside profit. */}
          {isVisible('pharma_top_drugs_profit') && topDrugsByProfit?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Top Drugs by Gross Profit</h3>
              <p className="text-xs text-theme-faint mb-4">Margin % is on Net Sales (ex-GST)</p>
              <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
                {topDrugsByProfit.map((d: any, i: number) => {
                  const value = d.grossProfit ?? d.profit ?? 0;
                  const maxVal = (topDrugsByProfit[0]?.grossProfit ?? topDrugsByProfit[0]?.profit) || 1;
                  const width = Math.max(4, (value / maxVal) * 100);
                  const barColor = d.marginPct >= 30 ? '#10b981' : d.marginPct >= 15 ? '#f59e0b' : '#ef4444';
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-theme-secondary truncate mr-2">{d.name}</span>
                        <span className="text-theme-heading font-medium shrink-0">{formatINR(value)} <span className="text-theme-faint">({d.marginPct}%)</span></span>
                      </div>
                      <div className="h-5 rounded-md overflow-hidden bg-dark-600">
                        <div className="h-full rounded-md" style={{ width: `${width}%`, backgroundColor: barColor }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Referral Analysis */}
          {isVisible('pharma_referral_analysis') && referralAnalysis?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Referral Analysis</h3>
              <p className="text-xs text-theme-faint mb-4">Revenue by referral source</p>
              <ResponsiveContainer width="100%" height={Math.max(200, referralAnalysis.length * 32)}>
                <BarChart data={referralAnalysis} layout="vertical" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" horizontal={false} />
                  <XAxis type="number" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} width={140} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Bar dataKey="sales" name="Revenue" fill="#f59e0b" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top Patients */}
          {isVisible('pharma_top_patients') && topPatients?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Top Patients by Spend</h3>
              <p className="text-xs text-theme-faint mb-4">Highest-value pharmacy customers</p>
              <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
                {topPatients.map((p: any, i: number) => (
                  <div key={i} className="flex items-center justify-between bg-dark-600/50 rounded-lg px-3 py-2">
                    <div className="min-w-0 mr-3">
                      <div className="text-xs font-medium text-theme-heading truncate">{p.patient_name}</div>
                      <div className="text-[10px] text-theme-faint">{p.visits} visits, {p.drugs} drugs</div>
                    </div>
                    <span className="text-sm font-bold text-teal-400 shrink-0">{formatINR(p.totalSales)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sales Table */}
      {tableVisible && table?.length > 0 && (() => {
        // Pre-compute derived fields ONCE per row so the DataTable filter/sort
        // can read them via accessors. Same flag rules as before:
        //   loss-making: COGS > Net Sales (truly negative gross profit)
        //   outlier:     margin <5% or >40% (review for billing/discount errors)
        const enriched = table.map((r: any) => {
          const sales = Number(r.sales_amount) || 0;
          const tax = Number(r.sales_tax) || 0;
          const cogs = Number(r.purchase_amount) || 0;
          const netSales = sales - tax;
          const grossProfit = netSales - cogs;
          const marginPct = netSales > 0 ? (grossProfit / netSales) * 100 : 0;
          const isLoss = grossProfit < 0;
          const isOutlier = !isLoss && netSales > 0 && (marginPct < 5 || marginPct > 40);
          return { ...r, _sales: sales, _tax: tax, _cogs: cogs, _netSales: netSales, _grossProfit: grossProfit, _marginPct: marginPct, _isLoss: isLoss, _isOutlier: isOutlier };
        });
        const cols: ColumnDef<typeof enriched[number]>[] = [
          { key: 'bill_no', header: 'Bill #', cellClassName: 'font-mono text-xs', width: 'max-w-[110px]' },
          { key: 'bill_date', header: 'Date', type: 'date' },
          { key: 'patient_name', header: 'Patient', cellClassName: 'truncate max-w-[120px]' },
          { key: 'drug_name', header: 'Drug', cellClassName: 'truncate max-w-[150px]' },
          { key: 'qty', header: 'Qty', type: 'number', format: 'number' },
          { key: 'sales', header: 'Sales (incl. GST)', type: 'number', accessor: r => r._sales, render: r => formatINR(r._sales) },
          { key: 'tax', header: 'GST', type: 'number', accessor: r => r._tax, render: r => formatINR(r._tax) },
          { key: 'netSales', header: 'Net Sales', type: 'number', accessor: r => r._netSales, render: r => formatINR(r._netSales) },
          { key: 'cogs', header: 'COGS', type: 'number', accessor: r => r._cogs, render: r => formatINR(r._cogs) },
          { key: 'grossProfit', header: 'Gross Profit', type: 'number', accessor: r => r._grossProfit,
            render: r => <span className={r._grossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}>{formatINR(r._grossProfit)}</span> },
          { key: 'marginPct', header: 'Margin %', type: 'number', accessor: r => r._marginPct,
            render: r => <span className={r._isLoss ? 'text-red-400' : r._isOutlier ? 'text-amber-400' : 'text-theme-faint'}>
              {r._netSales > 0 ? `${r._marginPct.toFixed(1)}%` : '-'}
            </span> },
          { key: 'flags', header: 'Flags', type: 'custom', render: r => (
            <span className="text-xs">
              {r._isLoss && (
                <span title="COGS exceeds Net Sales — loss-making line. Could be a real loss, or a billing/discount error worth investigating."
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  <AlertTriangle size={10} /> Loss
                </span>
              )}
              {r._isOutlier && (
                <span title={`Margin ${r._marginPct.toFixed(1)}% is outside the 5–40% normal band — review for billing/discount errors.`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <AlertTriangle size={10} /> Outlier
                </span>
              )}
            </span>
          ) },
          { key: 'referred_by', header: 'Referred By', cellClassName: 'truncate max-w-[100px]' },
        ];
        return (
          <div className="card mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-theme-heading">Sales Details</h3>
                <p className="text-xs text-theme-faint">{formatNumber(table.length)} records</p>
              </div>
              <button onClick={() => exportFromDb('pharma-sales', PHARMA_SALES_EXPORT_COLUMNS, 'Sales_Details', fyStart, fyEnd)}
                className="btn btn-sm btn-ghost flex items-center gap-1.5 text-xs text-theme-faint hover:text-accent-500" title="Download XLSX">
                <Download size={14} /> Download
              </button>
            </div>
            <DataTable
              columns={cols}
              rows={enriched}
              pageSize={50}
              searchPlaceholder="Search drug, patient, bill..."
              rowClassName={r => r._isLoss ? 'bg-rose-500/5' : ''}
            />
          </div>
        );
      })()}
    </div>
  );
}

// ── STOCK TAB ────────────────────────────────────────────────────────────────

function StockTab({ data, isVisible }: TabProps) {
  const { kpi, topProducts, expiryZones, table } = data;
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [showExpired, setShowExpired] = useState(false);

  const cardKeys = ['pharma_live_stock_value', 'pharma_healthy_stock', 'pharma_at_risk_stock', 'pharma_expired_items'];
  const chartKeys = ['pharma_expired_alert', 'pharma_expiry_breakdown', 'pharma_critical_batches', 'pharma_top_stock_products'];
  const anyCardVisible = cardKeys.some(isVisible);
  const anyChartVisible = chartKeys.some(isVisible);
  const tableVisible = isVisible('pharma_stock_table');

  // ── Derive everything from the existing API payload ─────────────────
  // We do not change the server response shape. The brief explicitly
  // calls for KPIs framed around live-vs-expired and healthy-vs-at-risk,
  // which are recombinations of the four sellable expiry zones the API
  // already returns.
  const zoneByName: Record<string, { batches: number; value: number; qty: number }> = {};
  for (const z of (expiryZones || []) as any[]) {
    zoneByName[z.name] = { batches: z.batches || 0, value: z.value || 0, qty: z.qty || 0 };
  }
  const zCritical = zoneByName['Critical (0-3m)'] || { batches: 0, value: 0, qty: 0 };
  const zWarning  = zoneByName['Warning (3-6m)']  || { batches: 0, value: 0, qty: 0 };
  const zSafe     = zoneByName['Safe (6-12m)']    || { batches: 0, value: 0, qty: 0 };
  const zLong     = zoneByName['Long Term (12m+)']|| { batches: 0, value: 0, qty: 0 };
  const zExpired  = zoneByName['Expired']         || { batches: 0, value: 0, qty: 0 };

  const liveStockValue   = zCritical.value + zWarning.value + zSafe.value + zLong.value;
  const liveBatchCount   = zCritical.batches + zWarning.batches + zSafe.batches + zLong.batches;
  const healthyStockValue = zSafe.value + zLong.value;
  const atRiskStockValue  = zCritical.value + zWarning.value;
  const healthyPct = liveStockValue > 0 ? Math.round((healthyStockValue / liveStockValue) * 100) : 0;
  const atRiskPct  = liveStockValue > 0 ? Math.round((atRiskStockValue  / liveStockValue) * 100) : 0;

  const totalBatches = kpi?.totalBatches || (liveBatchCount + zExpired.batches);
  const expiredBatches = kpi?.expired || zExpired.batches;
  const expiredPct = totalBatches > 0 ? Math.round((expiredBatches / totalBatches) * 1000) / 10 : 0;
  const expiredAbsValue = Math.abs(zExpired.value);

  // ── Snapshot date helpers ──────────────────────────────────────────
  // The API returns snapshotDate as a YYYY-MM-DD or ISO string. Format
  // it as "28 Apr 2026" and compute the days-elapsed-since-now so the
  // user knows how stale the inventory snapshot is.
  const parseSnapshot = (s?: string): Date | null => {
    if (!s) return null;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (!m) return null;
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10);
    return new Date(y, mo, d);
  };
  const snapshotDate = parseSnapshot(kpi?.snapshotDate);
  const snapshotLabel = snapshotDate
    ? snapshotDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : kpi?.snapshotDate || '—';
  const snapshotAge = snapshotDate
    ? Math.max(0, Math.floor((Date.now() - snapshotDate.getTime()) / 86400000))
    : null;

  // ── Per-batch days-to-expiry & enriched table rows ─────────────────
  // The brief is explicit: days-to-expiry must be computed from the
  // SNAPSHOT date, not from today. Stock data is point-in-time.
  // Pharma data uses MM/YYYY or YYYY-MM expiry strings; we default to
  // the last day of the expiry month so a "01/2027" batch is treated
  // as expiring 31 Jan 2027 (industry convention).
  const parseExpiry = (s?: string): Date | null => {
    if (!s) return null;
    const dayMatch = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
    if (dayMatch) {
      return new Date(parseInt(dayMatch[3], 10), parseInt(dayMatch[2], 10) - 1, parseInt(dayMatch[1], 10));
    }
    const monthFirst = /^(\d{1,2})[\/\-](\d{4})$/.exec(s);
    if (monthFirst) {
      const y = parseInt(monthFirst[2], 10), mo = parseInt(monthFirst[1], 10);
      return new Date(y, mo, 0); // last day of that month
    }
    const yearFirst = /^(\d{4})[\/\-](\d{1,2})(?:[\/\-](\d{1,2}))?$/.exec(s);
    if (yearFirst) {
      const y = parseInt(yearFirst[1], 10), mo = parseInt(yearFirst[2], 10), d = parseInt(yearFirst[3] || '0', 10);
      return d ? new Date(y, mo - 1, d) : new Date(y, mo, 0);
    }
    return null;
  };
  const refDate = snapshotDate || new Date();
  const enrichedTable = useMemo(() => {
    return ((table || []) as any[]).map((r: any) => {
      const exp = parseExpiry(r.expiry_date);
      const days = exp ? Math.floor((exp.getTime() - refDate.getTime()) / 86400000) : null;
      return { ...r, _expDate: exp, _daysToExpiry: days };
    });
  }, [table, refDate.getTime()]);

  const sellableRows  = enrichedTable.filter(r => (r._daysToExpiry ?? 1) >= 0);
  const expiredRows   = enrichedTable.filter(r => (r._daysToExpiry ?? 0) < 0);
  const visibleRows   = showExpired ? enrichedTable : sellableRows;
  const stockTableRows = criticalOnly
    ? visibleRows.filter(r => r._daysToExpiry != null && r._daysToExpiry >= 0 && r._daysToExpiry <= 90)
    : visibleRows;

  // Top critical-by-value batches (≤ 90 days, sellable)
  const allCritical = sellableRows
    .filter(r => r._daysToExpiry != null && r._daysToExpiry <= 90)
    .sort((a, b) => (b.stock_value || 0) - (a.stock_value || 0));
  const criticalTotal = allCritical.reduce((s, r) => s + (r.stock_value || 0), 0);
  const topCritical = allCritical.slice(0, 6);

  // Earliest-expiry per top product (computed client-side from the
  // batch table; the API's topProducts payload doesn't carry expiry).
  const earliestExpiryByDrug = useMemo(() => {
    const m = new Map<string, Date | null>();
    for (const r of enrichedTable) {
      if (!r.drug_name || !r._expDate || (r._daysToExpiry ?? 0) < 0) continue;
      const cur = m.get(r.drug_name);
      if (!cur || r._expDate < cur) m.set(r.drug_name, r._expDate);
    }
    return m;
  }, [enrichedTable]);

  const sellableSkuCount = useMemo(() => {
    const s = new Set<string>();
    for (const r of sellableRows) s.add(r.drug_name);
    return s.size;
  }, [sellableRows]);

  // ── Stacked-bar segments ───────────────────────────────────────────
  const segments = [
    { key: 'critical', label: 'Critical · 0–3m', value: zCritical.value, batches: zCritical.batches, color: '#E24B4A',
      tile: { bg: 'rgb(226 75 74 / 0.10)',  border: 'rgb(226 75 74 / 0.25)',  label: 'text-rose-700 dark:text-rose-300',  num: 'text-rose-900 dark:text-rose-200' } },
    { key: 'warning',  label: 'Warning · 3–6m', value: zWarning.value,  batches: zWarning.batches,  color: '#BA7517',
      tile: { bg: 'rgb(186 117 23 / 0.10)', border: 'rgb(186 117 23 / 0.25)', label: 'text-amber-800 dark:text-amber-300', num: 'text-amber-900 dark:text-amber-200' } },
    { key: 'safe',     label: 'Safe · 6–12m',   value: zSafe.value,     batches: zSafe.batches,     color: '#639922',
      tile: { bg: 'rgb(99 153 34 / 0.10)',  border: 'rgb(99 153 34 / 0.25)',  label: 'text-emerald-700 dark:text-emerald-300', num: 'text-emerald-900 dark:text-emerald-200' } },
    { key: 'long',     label: 'Long term · 12m+', value: zLong.value,   batches: zLong.batches,     color: '#185FA5',
      tile: { bg: 'rgb(24 95 165 / 0.10)',  border: 'rgb(24 95 165 / 0.25)',  label: 'text-blue-700 dark:text-blue-300',  num: 'text-blue-900 dark:text-blue-200' } },
  ];

  // ── Pill helper for days-to-expiry / earliest-expiry ──────────────
  const expiryPillByDays = (days: number | null) => {
    if (days == null) return { bg: 'rgb(148 163 184 / 0.15)', text: 'text-slate-700 dark:text-slate-300' };
    if (days < 90)   return { bg: 'rgb(226 75 74 / 0.12)',  text: 'text-rose-800 dark:text-rose-200' };
    if (days < 180)  return { bg: 'rgb(186 117 23 / 0.12)', text: 'text-amber-800 dark:text-amber-200' };
    if (days < 365)  return { bg: 'rgb(99 153 34 / 0.12)',  text: 'text-emerald-800 dark:text-emerald-200' };
    return { bg: 'rgb(24 95 165 / 0.12)', text: 'text-blue-800 dark:text-blue-200' };
  };

  return (
    <div>
      {/* ── Snapshot timestamp ─────────────────────────────────────
          Promotes "when was this data captured" from a small grey
          chip to a visible context line above the KPI strip. */}
      {kpi?.snapshotDate && (
        <p className="text-[12px] text-theme-secondary mb-3 flex items-center gap-2">
          <Clock size={12} className="shrink-0" />
          <span>Snapshot taken: {snapshotLabel}</span>
          {snapshotAge != null && (
            <span className="text-theme-faint">· {snapshotAge === 0 ? 'today' : `${snapshotAge} day${snapshotAge === 1 ? '' : 's'} ago`}</span>
          )}
        </p>
      )}

      {/* ── KPI strip — 4 cards framed live vs expired, healthy vs at-risk ── */}
      {anyCardVisible && (() => {
        const visibleCount = cardKeys.filter(isVisible).length;
        const cols: Record<number, string> = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' };
        return (
          <div className={`grid grid-cols-2 md:grid-cols-2 ${cols[visibleCount] || 'lg:grid-cols-4'} gap-4 mb-4`}>
            {isVisible('pharma_live_stock_value') && (
              <PurchaseKPI
                tone="teal"
                label="Live stock value"
                value={formatINR(liveStockValue)}
                sub={`${formatNumber(liveBatchCount)} sellable batches · ${formatNumber(sellableSkuCount || kpi.totalSkus || 0)} SKUs`}
              />
            )}
            {isVisible('pharma_healthy_stock') && (
              <PurchaseKPI
                tone="blue"
                label="Healthy stock"
                value={formatINR(healthyStockValue)}
                sub={`${healthyPct}% · expires 6m+`}
              />
            )}
            {isVisible('pharma_at_risk_stock') && (
              <PurchaseKPI
                tone="amber"
                label="At-risk stock"
                value={formatINR(atRiskStockValue)}
                sub={`${atRiskPct}% · expires within 6m`}
              />
            )}
            {isVisible('pharma_expired_items') && (
              <PurchaseKPI
                tone="coral"
                label="Already expired"
                value={formatNumber(expiredBatches)}
                sub={`batches written off · ${formatINR(expiredAbsValue)}`}
              />
            )}
          </div>
        );
      })()}

      {/* ── Expired batches alert callout ─────────────────────────
          Reframes the scary 71% figure as a likely data-hygiene
          issue rather than a business failure. Hidden if expired
          share is below 5% (callout would be noise). */}
      {isVisible('pharma_expired_alert') && expiredBatches > 0 && expiredPct >= 5 && (
        <div
          className="mb-4 rounded-xl flex items-start gap-4"
          style={{
            background: 'rgb(163 45 45 / 0.08)',
            borderLeft: '4px solid #A32D2D',
            padding: '1rem 1.25rem',
          }}
        >
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-medium text-rose-900 dark:text-rose-200 flex items-center gap-1.5">
              <AlertTriangle size={14} className="shrink-0" />
              {expiredPct.toFixed(1)}% of all batches on file are already expired
            </p>
            <p className="text-[12px] text-rose-800 dark:text-rose-300/90 mt-1.5 leading-relaxed">
              {formatNumber(expiredBatches)} of {formatNumber(totalBatches)} batches in the system have crossed
              their expiry date. Likely cause: old batches were never archived after sell-through. This isn't
              current loss (already written off at -{formatINR(expiredAbsValue)}) but it bloats reports and slows
              queries. Recommend a one-time data cleanup to archive batches expired more than 12 months ago.
            </p>
          </div>
          <div className="text-right shrink-0" style={{ minWidth: '80px' }}>
            <p className="text-[24px] font-medium leading-none text-rose-900 dark:text-rose-200">{expiredPct.toFixed(1)}%</p>
            <p className="text-[11px] text-rose-800 dark:text-rose-300/90 mt-1">of total batches</p>
          </div>
        </div>
      )}

      {/* ── When your stock will expire — stacked-bar card ─────────
          Replaces the donut + long legend. The bar shows the four
          sellable zones proportioned by VALUE (not batch count) so
          it tells the financial story directly. Detail tiles below
          give batch counts + value per zone. */}
      {isVisible('pharma_expiry_breakdown') && liveStockValue > 0 && (
        <div
          className="mb-4 rounded-xl p-5"
          style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
        >
          <h3 className="text-base font-medium text-theme-heading">When your stock will expire</h3>
          <p className="text-[13px] text-theme-secondary mt-0.5">By value, sellable batches only</p>
          <p className="text-[13px] text-theme-faint mt-1">
            {formatINR(atRiskStockValue)} worth of stock expires in the next 6 months — focus liquidation here.
          </p>

          {/* Single horizontal stacked bar */}
          <div
            className="mt-4 flex w-full overflow-hidden rounded-md"
            style={{ height: '36px' }}
            role="img"
            aria-label={`Stock value by expiry zone: ${segments.map(s => `${s.label} ${formatINR(s.value)}`).join(', ')}`}
          >
            {segments.map((seg, i) => {
              const pct = liveStockValue > 0 ? (seg.value / liveStockValue) * 100 : 0;
              const showLabel = pct >= 8;
              return (
                <div
                  key={seg.key}
                  className="flex items-center justify-center text-[11px] font-medium text-white"
                  style={{
                    width: pct > 0 ? `${Math.max(0.4, pct)}%` : '0%',
                    background: seg.color,
                    minWidth: pct > 0 ? '4px' : '0',
                    paddingInline: showLabel ? '8px' : '0',
                    borderRight: i < segments.length - 1 && pct > 0 ? '1px solid rgba(255,255,255,0.15)' : 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {showLabel && `${formatINR(seg.value)} · ${pct.toFixed(0)}%`}
                </div>
              );
            })}
          </div>

          {/* Detail tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
            {segments.map(seg => (
              <div
                key={seg.key}
                className="rounded-md p-3"
                style={{ background: seg.tile.bg, border: `0.5px solid ${seg.tile.border}` }}
              >
                <div className={`text-[12px] font-medium flex items-center gap-1.5 ${seg.tile.label}`}>
                  <span className="inline-block rounded-sm" style={{ width: '8px', height: '8px', background: seg.color }} />
                  {seg.label}
                </div>
                <p className={`text-[16px] font-medium mt-1.5 ${seg.tile.num}`}>{formatINR(seg.value)}</p>
                <p className={`text-[11px] mt-0.5 ${seg.tile.label}`}>
                  {formatNumber(seg.batches)} batch{seg.batches === 1 ? '' : 'es'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Expires within 3 months — act now ────────────────────────
          New card. The data was always there (every batch row has
          expiry + value); the brief promotes it from "buried in the
          table" to a top-of-page action list. */}
      {isVisible('pharma_critical_batches') && allCritical.length > 0 && (
        <div
          className="mb-4 rounded-xl p-5"
          style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-medium text-theme-heading">Expires within 3 months — act now</h3>
              <p className="text-[13px] text-theme-secondary mt-0.5">
                Top {Math.min(6, allCritical.length)} by value · {formatINR(criticalTotal)} total
              </p>
              <p className="text-[13px] text-theme-faint mt-1">
                Discount, return to stockist, or push these to fast-moving doctors.
              </p>
            </div>
          </div>

          <div className="mt-4">
            <div className="grid grid-cols-[1fr_80px_120px_100px] gap-3 px-2 pb-2 text-[12px] uppercase tracking-[0.5px] text-theme-faint border-b" style={{ borderColor: 'var(--mt-border)' }}>
              <span>Drug · batch</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Value at risk</span>
              <span className="text-right">Expires in</span>
            </div>
            {topCritical.map((r, i) => {
              const days = r._daysToExpiry ?? 0;
              const pill = expiryPillByDays(days);
              return (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_80px_120px_100px] gap-3 px-2 py-2.5 items-center text-[13px]"
                  style={{ borderTop: i === 0 ? 'none' : '0.5px solid var(--mt-border)' }}
                >
                  <div className="min-w-0">
                    <span className="text-theme-heading truncate block" title={r.drug_name}>{r.drug_name}</span>
                    <span className="text-[11px] text-theme-faint font-mono">{r.batch_no}</span>
                  </div>
                  <span className="text-right text-theme-secondary">{formatNumber(r.avl_qty || 0)}</span>
                  <span className="text-right text-theme-heading font-medium">{formatINR(r.stock_value || 0)}</span>
                  <span className="text-right">
                    <span
                      className={`inline-block rounded-md text-[11px] ${pill.text}`}
                      style={{ background: pill.bg, padding: '2px 8px' }}
                    >
                      {days} day{days === 1 ? '' : 's'}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          {allCritical.length > 6 && (
            <button
              type="button"
              onClick={() => setCriticalOnly(true)}
              className="mt-3 text-[12px] text-theme-faint hover:text-theme-heading transition-colors"
            >
              + {allCritical.length - 6} more critical batch{allCritical.length - 6 === 1 ? '' : 'es'} · view all
            </button>
          )}
        </div>
      )}

      {/* ── Top products by stock value ───────────────────────────
          Color encodes earliest-expiry zone instead of being a
          single green palette. The "earliest expiry" is computed
          client-side from the batch table since the API's
          topProducts payload doesn't carry per-product expiry. */}
      {isVisible('pharma_top_stock_products') && topProducts?.length > 0 && (() => {
        const visible = topProducts.slice(0, 7);
        return (
          <div
            className="mb-4 rounded-xl p-5"
            style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
          >
            <h3 className="text-base font-medium text-theme-heading">Top products by stock value</h3>
            <p className="text-[13px] text-theme-secondary mt-0.5">Highest inventory items</p>
            <p className="text-[13px] text-theme-faint mt-1">Color shows expiry zone — green is safe, amber/red needs attention.</p>

            <div className="mt-4">
              <div className="grid grid-cols-[1fr_120px_80px_120px] gap-3 px-2 pb-2 text-[12px] uppercase tracking-[0.5px] text-theme-faint border-b" style={{ borderColor: 'var(--mt-border)' }}>
                <span>Drug</span>
                <span className="text-right">Stock value</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Earliest expiry</span>
              </div>
              {visible.map((p: any, i: number) => {
                const earliest = earliestExpiryByDrug.get(p.name) || null;
                const days = earliest ? Math.floor((earliest.getTime() - refDate.getTime()) / 86400000) : null;
                const pill = expiryPillByDays(days);
                const label = earliest
                  ? earliest.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
                  : '—';
                return (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_120px_80px_120px] gap-3 px-2 py-2.5 items-center text-[13px]"
                    style={{ borderTop: i === 0 ? 'none' : '0.5px solid var(--mt-border)' }}
                  >
                    <span className="text-theme-heading truncate" title={p.name}>{p.name}</span>
                    <span className="text-right text-theme-heading font-medium">{formatINR(p.value || 0)}</span>
                    <span className="text-right text-theme-secondary">{formatNumber(p.qty || 0)}</span>
                    <span className="text-right">
                      <span
                        className={`inline-block rounded-md text-[11px] ${pill.text}`}
                        style={{ background: pill.bg, padding: '2px 8px' }}
                      >
                        {label}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>

            {topProducts.length > 7 && (
              <p className="mt-3 text-[12px] text-theme-faint">
                + {topProducts.length - 7} more · use the table below to browse the full list
              </p>
            )}
          </div>
        );
      })()}

      {/* ── Stock details table ───────────────────────────────────
          Drops the empty Strips column, hides expired by default,
          adds Critical-only quick filter, and tints at-risk rows
          + colour-codes the Stock Value column by safety. */}
      {tableVisible && enrichedTable.length > 0 && (() => {
        const cols: ColumnDef<any>[] = [
          { key: 'drug_name', header: 'Drug Name', cellClassName: 'truncate max-w-[220px]' },
          { key: 'batch_no', header: 'Batch', cellClassName: 'font-mono text-[11px]' },
          { key: 'received_date', header: 'Received', type: 'date' },
          { key: 'expiry_date', header: 'Expiry', type: 'date',
            render: r => {
              const d = r._daysToExpiry;
              if (d != null && d < 0) {
                return <span className="text-rose-700 dark:text-rose-300 font-medium flex items-center gap-1"><AlertTriangle size={11} /> {r.expiry_date}</span>;
              }
              if (d != null && d <= 90) {
                return <span className="text-rose-700 dark:text-rose-300 font-medium flex items-center gap-1"><AlertTriangle size={11} /> {r.expiry_date}</span>;
              }
              return <span className="text-theme-secondary">{r.expiry_date}</span>;
            } },
          { key: 'avl_qty', header: 'Avl Qty', type: 'number', format: 'number' },
          { key: 'purchase_price', header: 'Purchase Price', type: 'number', format: 'currency' },
          { key: 'stock_value', header: 'Stock Value', type: 'number',
            render: r => {
              const d = r._daysToExpiry;
              const cls = d != null && d <= 90
                ? 'text-rose-800 dark:text-rose-300 font-medium'
                : d != null && d >= 180
                  ? 'text-emerald-800 dark:text-emerald-300 font-medium'
                  : 'text-theme-heading font-medium';
              return <span className={cls}>{formatINR(r.stock_value || 0)}</span>;
            } },
        ];
        return (
          <div
            className="mb-6 rounded-xl p-5"
            style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
          >
            <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
              <div>
                <h3 className="text-base font-medium text-theme-heading">Stock details</h3>
                <p className="text-[13px] text-theme-secondary mt-0.5">
                  {formatNumber(stockTableRows.length)} {showExpired ? 'items' : 'sellable items'}
                  {' · sorted by stock value'}
                  {expiredRows.length > 0 && !showExpired && (
                    <> · <button type="button" onClick={() => setShowExpired(true)} className="underline hover:text-theme-heading">show {formatNumber(expiredRows.length)} expired</button></>
                  )}
                  {showExpired && (
                    <> · <button type="button" onClick={() => setShowExpired(false)} className="underline hover:text-theme-heading">hide expired</button></>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCriticalOnly(v => !v)}
                  className="flex items-center gap-1 rounded-md text-[12px] transition-colors"
                  style={{
                    background: criticalOnly ? 'rgb(226 75 74 / 0.20)' : 'rgb(226 75 74 / 0.10)',
                    color: criticalOnly ? '#7f1d1d' : '#A32D2D',
                    padding: '6px 12px',
                    border: criticalOnly ? '1px solid rgb(226 75 74 / 0.35)' : '1px solid transparent',
                  }}
                  title="Filter to batches expiring within 90 days"
                >
                  <AlertTriangle size={12} /> Critical only{criticalOnly ? ' · on' : ''}
                </button>
                <button
                  onClick={() => exportFromDb('pharma-stock', STOCK_COLUMNS, 'Stock_Details')}
                  className="btn btn-sm btn-ghost flex items-center gap-1.5 text-[12px] text-theme-faint hover:text-accent-500"
                  title="Download XLSX"
                >
                  <Download size={14} /> Download
                </button>
              </div>
            </div>
            <DataTable
              columns={cols}
              rows={stockTableRows}
              pageSize={15}
              defaultSort={{ key: 'stock_value', dir: 'desc' }}
              searchPlaceholder="Search drug, batch..."
              rowClassName={(r: any) => r._daysToExpiry != null && r._daysToExpiry >= 0 && r._daysToExpiry <= 90 ? 'bg-rose-500/5' : ''}
            />
          </div>
        );
      })()}
    </div>
  );
}

// ── CROSS-REPORT TAB ─────────────────────────────────────────────────────────

function CrossTab({ data, isVisible }: { data: any; isVisible: (key: string) => boolean }) {
  const { kpi, topCrossProducts, purchasedNotSold, soldNotPurchased } = data;

  const anyVisible = ['pharma_cross_kpis', 'pharma_purchase_vs_sales', 'pharma_dead_stock'].some(isVisible);
  if (!anyVisible) return null;

  return (
    <div>
      {/* Cross KPI Cards */}
      {isVisible('pharma_cross_kpis') && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <MiniKPI label="Total Products" value={formatNumber(kpi.totalProducts)} icon={Package} color="teal" />
          <MiniKPI label="Sell-Through Rate" value={`${kpi.sellThroughRate}%`} icon={TrendingUp} color="blue" sub="Sales / Purchases" />
          <MiniKPI label="Purchased, Not Sold" value={formatNumber(kpi.purchasedNotSoldCount)} icon={Warehouse} color="amber" sub={formatINR(kpi.purchasedNotSoldValue)} />
          <MiniKPI label="Sold, Not Purchased" value={formatNumber(kpi.soldNotPurchasedCount)} icon={AlertTriangle} color="rose" sub="May be from old stock" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        {/* Purchase vs Sales Comparison */}
        {isVisible('pharma_purchase_vs_sales') && topCrossProducts?.length > 0 && (
          <div className="card lg:col-span-2">
            <h3 className="text-sm font-semibold text-theme-heading mb-1">Purchase vs Sales by Product</h3>
            <p className="text-xs text-theme-faint mb-4">Top products that appear in both purchase and sales data</p>
            <ResponsiveContainer width="100%" height={Math.max(300, topCrossProducts.length * 30)}>
              <BarChart data={topCrossProducts.map((p: any) => ({
                ...p, name: p.name.length > 20 ? p.name.slice(0, 20) + '...' : p.name
              }))} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" horizontal={false} />
                <XAxis type="number" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} width={160} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                <Legend />
                <Bar dataKey="purchases" name="Purchases" fill="#3b82f6" radius={[0, 0, 0, 0]} />
                <Bar dataKey="sales" name="Sales" fill="#10b981" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Dead Stock — Purchased but not sold */}
        {isVisible('pharma_dead_stock') && purchasedNotSold?.length > 0 && (
          <div className="card">
            <h3 className="text-sm font-semibold text-theme-heading mb-1">Purchased, Not Sold</h3>
            <p className="text-xs text-theme-faint mb-4">Products with purchases but zero sales this period</p>
            <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
              {purchasedNotSold.map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between bg-dark-600/50 rounded-lg px-3 py-2">
                  <span className="text-xs text-theme-secondary truncate mr-2">{p.name}</span>
                  <span className="text-xs text-amber-400 font-medium shrink-0">{formatINR(p.purchases)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sold but not purchased this period */}
        {isVisible('pharma_dead_stock') && soldNotPurchased?.length > 0 && (
          <div className="card">
            <h3 className="text-sm font-semibold text-theme-heading mb-1">Sold, Not Purchased</h3>
            <p className="text-xs text-theme-faint mb-4">Products sold but not purchased this period (old stock)</p>
            <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
              {soldNotPurchased.map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between bg-dark-600/50 rounded-lg px-3 py-2">
                  <span className="text-xs text-theme-secondary truncate mr-2">{p.name}</span>
                  <span className="text-xs text-teal-400 font-medium shrink-0">{formatINR(p.sales)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
