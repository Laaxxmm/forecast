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
        <CrossTab data={data} isVisible={isVisible} startMonth={startMonth} endMonth={endMonth} />
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
//
// Sales-tab visual primitives. Lives next to SalesTab so the Margin pill /
// outlier mapping doesn't drift from the per-row colours used in the table.
// Margin buckets here are coarser than the Purchases-tab ones because the
// Sales tab cares about "is this drug making us money?" rather than the
// finer 0/10/20/30/50%+ split used for purchase margin distribution.

type SalesMarginTone = 'darkGreen' | 'green' | 'amber' | 'red';

function salesMarginTone(pct: number): SalesMarginTone {
  if (pct >= 50) return 'darkGreen';
  if (pct >= 20) return 'green';
  if (pct >= 10) return 'amber';
  return 'red';
}

const SALES_MARGIN_PILL: Record<SalesMarginTone, string> = {
  darkGreen: 'bg-emerald-700/15 text-emerald-900 dark:text-emerald-300 border-emerald-700/30',
  green:     'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
  amber:     'bg-amber-500/10 text-amber-800 dark:text-amber-400 border-amber-500/20',
  red:       'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20',
};

// Outlier threshold — kept in one place so the KPI count, the alert callout,
// the table flag, the row tint, and the "outliers only" filter all agree.
// Per the redesign brief: low-margin (< 5%) sales on positive net-sales rows
// are the "at risk" rows worth surfacing as a top-level alert. Loss-making
// rows (negative gross profit) are tracked separately because they're a
// stronger signal — usually a billing/discount error rather than a pricing
// issue.
const LOW_MARGIN_THRESHOLD = 5;

// ── Doctor name fuzzy-merge helpers ───────────────────────────────────────
//
// Pharmacy referral data frequently contains the same doctor entered with
// different spellings ("DR.RAJESHWARI" vs "DR.RAJESWARI" vs "DR.RAJESWRI").
// Showing them as separate bars misrepresents who's actually driving
// revenue, so the Top Referring Doctors card collapses near-identical
// names into a single canonical row. The underlying data is NOT mutated —
// the Sales Details table still shows the raw spellings so the user can
// fix them at source.

function normalizeDoctor(name: string): string {
  return String(name || '')
    .toUpperCase()
    .replace(/^\s*DR\.?\s*/, '')   // strip leading "DR" / "DR."
    .replace(/^\s*DOCTOR\s*/, '')  // strip leading "DOCTOR"
    .replace(/[\s.\-_,]/g, '')     // strip whitespace and punctuation
    .trim();
}

// Standard Levenshtein distance. Short strings only (doctor names) so the
// O(m*n) cost is negligible.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev: number[] = new Array(a.length + 1);
  const curr: number[] = new Array(a.length + 1);
  for (let j = 0; j <= a.length; j++) prev[j] = j;
  for (let i = 1; i <= b.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= a.length; j++) prev[j] = curr[j];
  }
  return prev[a.length];
}

type DoctorGroup = { canonical: string; spellings: string[]; revenue: number };

// Group near-identical doctor names. Two normalized forms count as the same
// person when Levenshtein distance is ≤ 2 OR ≤ 25% of the longer name (so
// long names tolerate slightly more variation, short names are stricter).
// Canonical spelling per group = the longest spelling (most likely complete).
function mergeReferrals(rows: Array<{ name: string; sales: number }>): DoctorGroup[] {
  const groups: DoctorGroup[] = [];
  for (const r of rows) {
    const norm = normalizeDoctor(r.name);
    const sales = Number(r.sales) || 0;
    if (!norm) {
      groups.push({ canonical: r.name, spellings: [r.name], revenue: sales });
      continue;
    }
    const match = groups.find(g => {
      const gnorm = normalizeDoctor(g.canonical);
      if (!gnorm) return false;
      const dist = levenshtein(norm, gnorm);
      const longer = Math.max(norm.length, gnorm.length);
      return dist <= 2 || (longer >= 8 && dist / longer <= 0.25);
    });
    if (match) {
      if (!match.spellings.includes(r.name)) match.spellings.push(r.name);
      match.revenue += sales;
    } else {
      groups.push({ canonical: r.name, spellings: [r.name], revenue: sales });
    }
  }
  for (const g of groups) {
    if (g.spellings.length > 1) {
      g.canonical = g.spellings.slice().sort((a, b) => b.length - a.length)[0];
    }
  }
  groups.sort((a, b) => b.revenue - a.revenue);
  return groups;
}

function SalesTab({ data, isVisible, fyStart, fyEnd }: TabProps) {
  const { kpi, monthlyTrend, topDrugsBySales, topDrugsByProfit, referralAnalysis, topPatients, table } = data;

  // ── Visibility gates ─────────────────────────────────────────────────────
  // Existing keys are reused. Mappings for the redesigned tab:
  //   pharma_total_sales         → Net sales KPI tile
  //   pharma_total_cogs          → COGS KPI tile
  //   pharma_total_profit        → Gross profit KPI tile
  //   pharma_profit_margin       → "X% margin" sub-line under Gross profit
  //   pharma_total_bills         → Total bills KPI tile
  //   pharma_unique_patients     → orphaned in this tab (data was always 0)
  //   pharma_monthly_sales_trend → "How sales convert to profit" hero card
  //   pharma_sales_vs_cogs       → also gates the hero card (same content)
  //   pharma_top_drugs_sales     → combined Top drugs card
  //   pharma_top_drugs_profit    → also gates the combined Top drugs card
  //   pharma_referral_analysis   → Top referring doctors card
  //   pharma_top_patients        → orphaned (not in redesigned layout)
  //   pharma_sales_table         → Sales details table + outlier alert
  const showNetSales        = isVisible('pharma_total_sales');
  const showCogs            = isVisible('pharma_total_cogs');
  const showGrossProfit     = isVisible('pharma_total_profit');
  const showMarginSub       = isVisible('pharma_profit_margin');
  const showBills           = isVisible('pharma_total_bills');
  const showHero            = isVisible('pharma_monthly_sales_trend') || isVisible('pharma_sales_vs_cogs');
  const showTopDrugs        = isVisible('pharma_top_drugs_sales') || isVisible('pharma_top_drugs_profit');
  const showReferrals       = isVisible('pharma_referral_analysis');
  const showTable           = isVisible('pharma_sales_table');

  // ── Derived KPI values ──────────────────────────────────────────────────
  const netSales       = Number(kpi?.totalNetSales ?? Math.max(0, (Number(kpi?.totalSales) || 0) - (Number(kpi?.totalTax) || 0))) || 0;
  const totalCogs      = Number(kpi?.totalCogs) || 0;
  const grossProfit    = Number(kpi?.totalGrossProfit ?? kpi?.totalProfit) || 0;
  const grossMarginPct = netSales > 0 ? (grossProfit / netSales) * 100 : 0;
  const totalBills     = Number(kpi?.totalBills) || 0;
  const avgBill        = totalBills > 0 ? netSales / totalBills : 0;
  const grossSales     = Number(kpi?.totalSales) || 0;
  const totalTax       = Number(kpi?.totalTax) || 0;
  const reportedProfit = kpi?.reportedProfit != null ? Number(kpi.reportedProfit) : null;
  const overstatedBy   = reportedProfit != null ? reportedProfit - grossProfit : 0;

  // ── Per-row enrichment (drives table + outliers + per-drug aggregates) ──
  type EnrichedRow = Record<string, any> & {
    _sales: number; _tax: number; _cogs: number;
    _netSales: number; _grossProfit: number; _marginPct: number;
    _isLoss: boolean; _isLowMargin: boolean;
  };
  const enriched = useMemo<EnrichedRow[]>(() => {
    return (table || []).map((r: any): EnrichedRow => {
      const sales      = Number(r.sales_amount) || 0;
      const tax        = Number(r.sales_tax) || 0;
      const cogs       = Number(r.purchase_amount) || 0;
      const ns         = sales - tax;
      const profit     = ns - cogs;
      const marginPct  = ns > 0 ? (profit / ns) * 100 : 0;
      const isLoss     = profit < 0;
      const isLowMargin = !isLoss && ns > 0 && marginPct < LOW_MARGIN_THRESHOLD;
      return {
        ...r,
        _sales: sales, _tax: tax, _cogs: cogs,
        _netSales: ns, _grossProfit: profit,
        _marginPct: marginPct,
        _isLoss: isLoss, _isLowMargin: isLowMargin,
      };
    });
  }, [table]);

  const lowMarginRows = useMemo(() => enriched.filter((r: EnrichedRow) => r._isLowMargin), [enriched]);
  const lowMarginCount = lowMarginRows.length;
  const lowMarginRevenue = useMemo(
    () => lowMarginRows.reduce((s: number, r: EnrichedRow) => s + r._sales, 0),
    [lowMarginRows],
  );

  // Per-drug aggregates derived from enriched rows. Used by:
  //   • Hero card highest/lowest margin SKU
  //   • Top drugs combined card
  //   • Outlier alert pills (top 5 outlier drugs by sales value)
  type DrugAgg = { name: string; revenue: number; netSales: number; profit: number; margin: number };
  const drugAggregates = useMemo<DrugAgg[]>(() => {
    const acc = new Map<string, { revenue: number; netSales: number; profit: number }>();
    for (const r of enriched) {
      const e = acc.get(r.drug_name) || { revenue: 0, netSales: 0, profit: 0 };
      e.revenue += r._sales;
      e.netSales += r._netSales;
      e.profit += r._grossProfit;
      acc.set(r.drug_name, e);
    }
    const out: DrugAgg[] = [];
    for (const [name, v] of acc) {
      out.push({
        name, revenue: v.revenue, netSales: v.netSales, profit: v.profit,
        margin: v.netSales > 0 ? (v.profit / v.netSales) * 100 : 0,
      });
    }
    return out;
  }, [enriched]);

  // Highest/lowest margin SKUs — only consider drugs with positive net sales
  // so a single zero-sales row doesn't hijack either extreme.
  const drugsWithPositiveSales = useMemo(
    () => drugAggregates.filter(d => d.netSales > 0),
    [drugAggregates],
  );
  const highestMarginSKU = drugsWithPositiveSales.length > 0
    ? drugsWithPositiveSales.reduce((m, d) => d.margin > m.margin ? d : m)
    : null;
  const lowestMarginSKU = drugsWithPositiveSales.length > 0
    ? drugsWithPositiveSales.reduce((m, d) => d.margin < m.margin ? d : m)
    : null;

  // Top outlier drugs by sales value, for the alert callout pills.
  const topOutlierDrugs = useMemo(() => {
    const acc = new Map<string, { sales: number; netSales: number; profit: number }>();
    for (const r of lowMarginRows) {
      const e = acc.get(r.drug_name) || { sales: 0, netSales: 0, profit: 0 };
      e.sales += r._sales;
      e.netSales += r._netSales;
      e.profit += r._grossProfit;
      acc.set(r.drug_name, e);
    }
    const out: Array<{ name: string; sales: number; margin: number }> = [];
    for (const [name, v] of acc) {
      out.push({ name, sales: v.sales, margin: v.netSales > 0 ? (v.profit / v.netSales) * 100 : 0 });
    }
    return out.sort((a, b) => b.sales - a.sales).slice(0, 5);
  }, [lowMarginRows]);

  // ── Period label for hero subtitle ──────────────────────────────────────
  const periodLabel = useMemo(() => {
    if (!monthlyTrend || monthlyTrend.length === 0) return '';
    if (monthlyTrend.length === 1) return getMonthLabel(monthlyTrend[0].month);
    return `${getMonthLabel(monthlyTrend[0].month)} – ${getMonthLabel(monthlyTrend[monthlyTrend.length - 1].month)}`;
  }, [monthlyTrend]);

  // ── Combined Top Drugs (sortable) ───────────────────────────────────────
  const [drugSort, setDrugSort] = useState<'revenue' | 'profit' | 'margin'>('revenue');
  const [showAllDrugs, setShowAllDrugs] = useState(false);

  // Server's topDrugsBySales / topDrugsByProfit are still used as a coverage
  // fallback for periods where the table was truncated to 200 rows. We
  // prefer per-drug aggregates from enriched rows when available, but merge
  // in any names from the server lists that didn't appear in the table.
  const combinedDrugs = useMemo<DrugAgg[]>(() => {
    const byName = new Map<string, DrugAgg>();
    for (const d of drugAggregates) byName.set(d.name, d);

    // Fallback: server's topDrugsBySales has GST-inclusive sales but no profit
    // breakdown for the whole list, so merge with topDrugsByProfit by name.
    const profitByName = new Map<string, { profit: number; margin: number }>();
    for (const d of topDrugsByProfit || []) {
      profitByName.set(d.name, {
        profit: Number(d.grossProfit ?? d.profit) || 0,
        margin: Number(d.marginPct) || 0,
      });
    }
    for (const d of topDrugsBySales || []) {
      if (byName.has(d.name)) continue;
      const pp = profitByName.get(d.name);
      const revenue = Number(d.sales) || 0;
      const profit = pp?.profit ?? 0;
      const margin = pp?.margin ?? 0;
      byName.set(d.name, {
        name: d.name,
        revenue,
        netSales: margin !== 0 && profit !== 0 ? profit / (margin / 100) : revenue,
        profit, margin,
      });
    }
    return Array.from(byName.values());
  }, [drugAggregates, topDrugsBySales, topDrugsByProfit]);

  const sortedDrugs = useMemo(() => {
    const list = combinedDrugs.slice();
    if (drugSort === 'revenue')      list.sort((a, b) => b.revenue - a.revenue);
    else if (drugSort === 'profit')  list.sort((a, b) => b.profit - a.profit);
    else                              list.sort((a, b) => b.margin - a.margin);
    return list;
  }, [combinedDrugs, drugSort]);

  const visibleDrugs = showAllDrugs ? sortedDrugs : sortedDrugs.slice(0, 7);

  // ── Doctor fuzzy-merge for referral card ────────────────────────────────
  const mergedReferrals = useMemo(() => mergeReferrals(referralAnalysis || []), [referralAnalysis]);
  const dupGroups = mergedReferrals.filter(g => g.spellings.length > 1);
  const dupCount = dupGroups.reduce((s, g) => s + (g.spellings.length - 1), 0);
  const sampleDupSpellings = dupGroups[0]?.spellings.slice(0, 3).join(' / ') || '';
  const topReferrers = mergedReferrals.slice(0, 5);
  const maxRefRevenue = topReferrers[0]?.revenue || 1;
  const REFERRER_BAR_COLORS = ['#BA7517', '#EF9F27', '#FAC775', '#FAC775', '#FAC775'];

  // ── Sales table state ───────────────────────────────────────────────────
  const [outliersOnly, setOutliersOnly] = useState(false);
  const [showAllCols, setShowAllCols] = useState(false);
  const tableRows = outliersOnly ? lowMarginRows : enriched;

  // ── KPI strip layout ────────────────────────────────────────────────────
  // 5 tiles in the redesigned spec — Gross Margin % is folded into the Gross
  // Profit sub-line, Unique Patients is dropped, Outlier Sales replaces it.
  const kpiVisible = [showNetSales, showCogs, showGrossProfit, showBills, true /* outlier always */]
    .filter(Boolean).length;
  const kpiColCls: Record<number, string> = {
    1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5',
  };

  // Hero math — only render the bar if we have a positive net-sales base.
  const cogsPct   = netSales > 0 ? (totalCogs / netSales) * 100 : 0;
  const profitPct = netSales > 0 ? (grossProfit / netSales) * 100 : 0;
  const heroEligible = netSales > 0 && (totalCogs > 0 || grossProfit !== 0);

  return (
    <div>
      {/* ── KPI strip (5 tinted cards) ─────────────────────────────────── */}
      {kpiVisible > 0 && (
        <div className={`grid grid-cols-2 md:grid-cols-3 ${kpiColCls[kpiVisible] || 'lg:grid-cols-5'} gap-4 mb-6`}>
          {showNetSales && (
            <PurchaseKPI tone="green" label="Net sales (ex-GST)" value={formatINR(netSales)} sub="Top-line revenue" />
          )}
          {showCogs && (
            <PurchaseKPI tone="blue" label="COGS (ex-GST)" value={formatINR(totalCogs)} sub="Net purchase rate" />
          )}
          {showGrossProfit && (
            <PurchaseKPI
              tone="purple"
              label="Gross profit"
              value={formatINR(grossProfit)}
              sub={showMarginSub && netSales > 0 ? `${grossMarginPct.toFixed(2)}% margin` : 'Net Sales − COGS'}
            />
          )}
          {showBills && (
            <PurchaseKPI
              tone="amber"
              label="Total bills"
              value={formatNumber(totalBills)}
              sub={avgBill > 0 ? `avg ${formatINR(Math.round(avgBill))}` : undefined}
            />
          )}
          <PurchaseKPI
            tone="coral"
            label="Outlier sales"
            value={formatNumber(lowMarginCount)}
            sub={`below ${LOW_MARGIN_THRESHOLD}% margin`}
          />
        </div>
      )}

      {/* ── GST sanity-check callout ────────────────────────────────────── */}
      {kpi && grossSales > 0 && totalTax > 0 && (
        <div className="rounded-xl px-5 py-4 mb-6 bg-emerald-500/10 border border-emerald-500/15">
          <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
            GST sanity check passed ✓
          </p>
          <p className="text-[12px] text-emerald-700/90 dark:text-emerald-400/80 mt-1.5 leading-relaxed">
            {reportedProfit != null ? (
              <>
                Source-system &quot;profit&quot; was overstated by{' '}
                <span className="font-medium">{formatINR(Math.round(overstatedBy))}</span>
                {' '}— exactly matches the GST collected on{' '}
                <span className="font-medium">{formatINR(grossSales)}</span> gross sales.
                Your true gross profit is{' '}
                <span className="font-medium">{formatINR(Math.round(grossProfit))}</span>, not{' '}
                <span className="font-medium">{formatINR(Math.round(reportedProfit))}</span>.
                Operating expenses (rent, salaries, expiries) still need deduction for net profit.
              </>
            ) : (
              <>
                <span className="font-medium">{formatINR(totalTax)}</span> GST was collected on{' '}
                <span className="font-medium">{formatINR(grossSales)}</span> gross sales — that's a govt
                liability, not income. Your true gross profit (ex-GST) is{' '}
                <span className="font-medium">{formatINR(Math.round(grossProfit))}</span>.
                Operating expenses (rent, salaries, expiries) still need deduction for net profit.
              </>
            )}
          </p>
        </div>
      )}

      {/* ── "How sales convert to profit" hero card ─────────────────────── */}
      {showHero && heroEligible && (
        <div className="card mb-6">
          <div className="flex items-start justify-between gap-3 mb-1">
            <h3 className="text-base font-medium text-theme-heading">How sales convert to profit</h3>
            {periodLabel && (
              <p className="text-[13px] text-theme-faint shrink-0">{periodLabel} · ex-GST</p>
            )}
          </div>
          <p className="text-[13px] text-theme-secondary mt-0.5 mb-5">
            For every ₹100 of net sales,{' '}
            <span className="text-theme-heading">₹{cogsPct.toFixed(2)}</span> covers the cost of goods and{' '}
            <span className="text-theme-heading">₹{profitPct.toFixed(2)}</span> is gross profit
          </p>

          {/* Stacked bar: COGS + Gross Profit = Net Sales (100%). */}
          <div className="flex h-[32px] rounded-md overflow-hidden">
            <div
              className="flex items-center px-3 text-[12px] font-medium text-white whitespace-nowrap overflow-hidden"
              style={{ width: `${Math.max(0, cogsPct)}%`, backgroundColor: '#185FA5' }}
              title={`COGS: ${formatINR(totalCogs)} (${cogsPct.toFixed(2)}%)`}
            >
              {cogsPct >= 18 ? `COGS · ${formatINR(totalCogs)} · ${cogsPct.toFixed(2)}%`
                : cogsPct >= 8 ? `COGS · ${cogsPct.toFixed(0)}%`
                : ''}
            </div>
            <div
              className="flex items-center px-3 text-[12px] font-medium text-white whitespace-nowrap overflow-hidden"
              style={{ width: `${Math.max(0, profitPct)}%`, backgroundColor: '#1D9E75' }}
              title={`Gross profit: ${formatINR(grossProfit)} (${profitPct.toFixed(2)}%)`}
            >
              {profitPct >= 18 ? `Profit · ${formatINR(grossProfit)} · ${profitPct.toFixed(2)}%`
                : profitPct >= 6 ? `Profit · ${profitPct.toFixed(2)}%`
                : ''}
            </div>
          </div>
          <div className="flex justify-between mt-1.5 text-[11px] text-theme-faint">
            <span>₹0</span>
            <span>Net sales: {formatINR(netSales)}</span>
          </div>

          {/* Three breakdown columns. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-5 pt-4 border-t border-dark-400/20">
            <div>
              <p className="text-[11px] uppercase tracking-[0.5px] text-theme-muted mb-1">Avg margin / bill</p>
              <p className="text-base font-medium text-theme-heading tabular-nums">
                {totalBills > 0 ? formatINR(Math.round(grossProfit / totalBills)) : '—'}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.5px] text-theme-muted mb-1">Highest margin SKU</p>
              {highestMarginSKU ? (
                <p className="text-sm font-medium text-theme-heading">
                  <span className="text-emerald-700 dark:text-emerald-400 tabular-nums">{highestMarginSKU.margin.toFixed(1)}%</span>{' '}
                  <span className="text-theme-secondary text-[13px]">{highestMarginSKU.name}</span>
                </p>
              ) : <p className="text-sm text-theme-faint">—</p>}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.5px] text-theme-muted mb-1">Lowest margin SKU</p>
              {lowestMarginSKU ? (
                <p className="text-sm font-medium text-theme-heading">
                  <span className="text-red-700 dark:text-red-400 tabular-nums">{lowestMarginSKU.margin.toFixed(1)}%</span>{' '}
                  <span className="text-theme-secondary text-[13px]">{lowestMarginSKU.name}</span>
                </p>
              ) : <p className="text-sm text-theme-faint">—</p>}
            </div>
          </div>
        </div>
      )}

      {/* ── Outlier alert callout ──────────────────────────────────────── */}
      {showTable && lowMarginCount > 0 && (
        <div className="rounded-xl px-5 py-4 mb-6 bg-rose-500/10 border border-rose-500/15">
          <p className="text-sm font-medium text-rose-900 dark:text-rose-200">
            ⚠ {formatNumber(lowMarginCount)} sale{lowMarginCount === 1 ? '' : 's'} below {LOW_MARGIN_THRESHOLD}% margin
            {lowMarginRevenue > 0 ? ` — ${formatINR(Math.round(lowMarginRevenue))} in revenue at risk` : ''}
          </p>
          <p className="text-[12px] text-rose-700/90 dark:text-rose-400/80 mt-1.5 leading-relaxed">
            High-value injectables and slow-movers are selling at near-zero margin. Either MRP needs revision
            or these are loss-leaders that should be re-priced.
          </p>
          {topOutlierDrugs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {topOutlierDrugs.map(d => (
                <span
                  key={d.name}
                  className="inline-block px-2 py-1 text-[11px] rounded-md bg-white/90 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200 border border-rose-200/60 dark:border-rose-500/20"
                >
                  {d.name} · {d.margin.toFixed(1)}%
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── "Top drugs by revenue and profit" combined card ──────────── */}
      {showTopDrugs && combinedDrugs.length > 0 && (
        <div className="card mb-6">
          <div className="flex items-start justify-between gap-3 mb-1">
            <div>
              <h3 className="text-base font-medium text-theme-heading">Top drugs by revenue and profit</h3>
              <p className="text-[13px] text-theme-faint mt-0.5">
                High revenue doesn't always mean high profit — see margin column
              </p>
            </div>
            <select
              value={drugSort}
              onChange={e => setDrugSort(e.target.value as 'revenue' | 'profit' | 'margin')}
              className="text-[12px] bg-transparent border border-dark-400/30 rounded-md px-2 py-1 text-theme-secondary"
            >
              <option value="revenue">Sort: revenue</option>
              <option value="profit">Sort: profit</option>
              <option value="margin">Sort: margin</option>
            </select>
          </div>

          <div className="mt-4">
            <div className="grid grid-cols-[1fr_110px_110px_90px] gap-x-4 px-1 pb-2 text-[11px] uppercase tracking-[0.5px] text-theme-muted border-b border-dark-400/20">
              <span>Drug</span>
              <span className="text-right">Revenue</span>
              <span className="text-right">Gross profit</span>
              <span className="text-right">Margin</span>
            </div>
            <div className="divide-y divide-dark-400/10">
              {visibleDrugs.map(d => {
                const tone = salesMarginTone(d.margin);
                return (
                  <div
                    key={d.name}
                    className="grid grid-cols-[1fr_110px_110px_90px] gap-x-4 items-center px-1 py-2.5 text-sm"
                  >
                    <span className="text-theme-primary truncate">{d.name}</span>
                    <span className="text-theme-heading text-right tabular-nums">{formatINR(d.revenue)}</span>
                    <span className={`text-right tabular-nums ${d.profit < 0 ? 'text-red-700 dark:text-red-400' : 'text-theme-heading'}`}>
                      {formatINR(Math.round(d.profit))}
                    </span>
                    <span className="text-right">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] border ${SALES_MARGIN_PILL[tone]}`}>
                        {d.margin.toFixed(1)}%
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
            {sortedDrugs.length > 7 && (
              <button
                onClick={() => setShowAllDrugs(v => !v)}
                className="mt-3 text-[12px] text-theme-faint hover:text-theme-secondary transition-colors"
              >
                {showAllDrugs ? 'Show fewer' : `+ ${sortedDrugs.length - 7} more · view all`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Top referring doctors (with fuzzy-merge data-quality warning) ── */}
      {showReferrals && mergedReferrals.length > 0 && (
        <div className="card mb-6">
          <h3 className="text-base font-medium text-theme-heading">Top referring doctors</h3>
          <p className="text-[13px] text-theme-faint mt-0.5 mb-4">By referred revenue</p>

          {dupGroups.length > 0 && (
            <div className="rounded-md px-3 py-2 mb-4 bg-amber-500/10 border border-amber-500/15 text-[12px] text-amber-800 dark:text-amber-300 leading-relaxed">
              <span className="font-medium">⚠ {dupCount} doctor name{dupCount === 1 ? '' : 's'} look like duplicate{dupCount === 1 ? '' : 's'}</span>
              {sampleDupSpellings ? <> — {sampleDupSpellings} may be the same person.</> : '.'}
              {' '}Standardize the names to get accurate referral revenue.
            </div>
          )}

          <div className="space-y-3">
            {topReferrers.map((g, i) => {
              const width = Math.max(2, (g.revenue / maxRefRevenue) * 100);
              const barColor = REFERRER_BAR_COLORS[Math.min(i, REFERRER_BAR_COLORS.length - 1)];
              return (
                <div key={g.canonical}>
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span className="text-sm font-medium text-theme-primary truncate">
                      {g.canonical}
                      {g.spellings.length > 1 && (
                        <span
                          className="ml-2 text-[11px] text-theme-faint"
                          title={`Merged spellings: ${g.spellings.join(', ')}`}
                        >
                          ({g.spellings.length} spellings merged)
                        </span>
                      )}
                    </span>
                    <span className="text-sm text-theme-heading shrink-0 tabular-nums">{formatINR(g.revenue)}</span>
                  </div>
                  <div className="h-[6px] rounded-full bg-amber-500/10 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: barColor }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Sales details table ──────────────────────────────────────────── */}
      {showTable && (table?.length || 0) > 0 && (() => {
        const baseCols: ColumnDef<typeof enriched[number]>[] = [
          { key: 'bill_no', header: 'Bill #', cellClassName: 'font-mono text-xs', width: 'max-w-[110px]' },
          { key: 'bill_date', header: 'Date', type: 'date' },
          { key: 'patient_name', header: 'Patient', cellClassName: 'truncate max-w-[120px]' },
          { key: 'drug_name', header: 'Drug', cellClassName: 'truncate max-w-[180px]' },
          { key: 'qty', header: 'Qty', type: 'number', format: 'number' },
          { key: 'sales', header: 'Sales (incl. GST)', type: 'number', accessor: r => r._sales, render: r => formatINR(r._sales) },
        ];
        const extraCols: ColumnDef<typeof enriched[number]>[] = [
          { key: 'tax', header: 'GST', type: 'number', accessor: r => r._tax, render: r => formatINR(r._tax) },
          { key: 'netSales', header: 'Net Sales', type: 'number', accessor: r => r._netSales, render: r => formatINR(r._netSales) },
        ];
        const tailCols: ColumnDef<typeof enriched[number]>[] = [
          { key: 'grossProfit', header: 'Profit', type: 'number', accessor: r => r._grossProfit,
            render: r => <span className={r._grossProfit >= 0 ? 'text-theme-heading' : 'text-red-700 dark:text-red-400'}>{formatINR(Math.round(r._grossProfit))}</span> },
          { key: 'marginPct', header: 'Margin', type: 'number', accessor: r => r._marginPct,
            render: r => {
              if (r._netSales <= 0) return <span className="text-theme-faint">—</span>;
              const m = r._marginPct;
              const isLow = r._isLowMargin;
              const cls = isLow ? 'text-red-700 dark:text-red-400 font-medium'
                : m >= 20 ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-theme-secondary';
              return (
                <span className={cls}>
                  {isLow && <AlertTriangle size={11} className="inline mr-1 align-text-bottom" />}
                  {m.toFixed(1)}%
                </span>
              );
            } },
          { key: 'referred_by', header: 'Referred By', cellClassName: 'truncate max-w-[120px]' },
        ];
        const cols = showAllCols ? [...baseCols, ...extraCols, ...tailCols] : [...baseCols, ...tailCols];

        return (
          <div className="card mb-6">
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
              <div>
                <h3 className="text-base font-medium text-theme-heading">Sales details</h3>
                <p className="text-[13px] text-theme-faint">
                  {formatNumber(enriched.length)} line item{enriched.length === 1 ? '' : 's'}
                  {lowMarginCount > 0 ? ` · ${formatNumber(lowMarginCount)} outlier${lowMarginCount === 1 ? '' : 's'} flagged` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {lowMarginCount > 0 && (
                  <button
                    onClick={() => setOutliersOnly(v => !v)}
                    className={`text-[12px] px-3 py-1.5 rounded-md border transition-colors flex items-center gap-1.5 ${
                      outliersOnly
                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30'
                        : 'bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20 hover:bg-rose-500/15'
                    }`}
                    title="Show only rows below the low-margin threshold"
                  >
                    <AlertTriangle size={12} />
                    Outliers only{outliersOnly ? ' ✓' : ''}
                  </button>
                )}
                <button
                  onClick={() => setShowAllCols(v => !v)}
                  className="text-[12px] px-3 py-1.5 rounded-md border border-dark-400/30 text-theme-faint hover:text-theme-secondary transition-colors"
                  title="Toggle GST and Net Sales columns"
                >
                  {showAllCols ? 'Hide' : 'Show'} GST cols
                </button>
                <button
                  onClick={() => exportFromDb('pharma-sales', PHARMA_SALES_EXPORT_COLUMNS, 'Sales_Details', fyStart, fyEnd)}
                  className="btn btn-sm btn-ghost flex items-center gap-1.5 text-xs text-theme-faint hover:text-accent-500"
                  title="Download XLSX"
                >
                  <Download size={14} /> Download
                </button>
              </div>
            </div>
            <DataTable
              columns={cols}
              rows={tableRows}
              pageSize={15}
              searchPlaceholder="Search drug, patient, bill..."
              rowClassName={r => r._isLoss ? 'bg-rose-500/10' : r._isLowMargin ? 'bg-rose-500/5' : ''}
            />
          </div>
        );
      })()}

      {/* Top patients card was retired in the May 2026 redesign. The
          `pharma_top_patients` admin toggle is now orphaned in this tab; it
          has no effect on rendering. The variable is kept referenced so an
          accidental "remove unused" pass doesn't drop the destructure. */}
      {false && topPatients && null}
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

function CrossTab({ data, isVisible, startMonth, endMonth }: {
  data: any; isVisible: (key: string) => boolean;
  startMonth?: string | null; endMonth?: string | null;
}) {
  const cross     = data.crossInsights || {};
  const purchases = data.purchases || {};
  const sales     = data.sales || {};
  const stock     = data.stock || {};

  const [statusFilter, setStatusFilter] = useState<'all' | 'healthy' | 'sitting' | 'leaking' | 'dead'>('all');

  const anyVisible = [
    'pharma_cross_kpis', 'pharma_margin_leak', 'pharma_money_cycle',
    'pharma_stockist_sellthrough', 'pharma_days_of_cover',
    'pharma_anomaly_buckets', 'pharma_product_cross_table',
  ].some(isVisible);
  if (!anyVisible) return null;

  // ── Period length in days ─────────────────────────────────────────
  // Used by Days-of-cover and aggregate velocity calculations. Falls
  // back to 30 if the period selector hasn't supplied months.
  const periodDays = (() => {
    if (!startMonth || !endMonth) return 30;
    const [sy, sm] = startMonth.split('-').map(Number);
    const [ey, em] = endMonth.split('-').map(Number);
    if (!sy || !sm || !ey || !em) return 30;
    const start = new Date(sy, sm - 1, 1);
    const end = new Date(ey, em, 0); // last day of end month
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
  })();

  // ── Per-drug aggregates ───────────────────────────────────────────
  // The cross payload only carries top-N per-drug rows. To compute
  // margins and units sold per drug we walk the detail tables that
  // come back with the same response (purchases.table, sales.table)
  // and group by drug_name.
  type Agg = {
    name: string;
    bought: number;        // net_purchase_value summed
    boughtGross: number;   // purchase_value summed (incl. tax)
    boughtMarginNum: number; // weighted margin numerator
    boughtMarginDen: number; // weighted margin denominator
    freeQty: number;
    sold: number;          // net sales summed (sales_amount − sales_tax)
    soldGross: number;     // sales_amount summed
    soldUnits: number;
    cogs: number;          // purchase_amount summed (from sales.table = cost of sold goods)
    stockQty: number;
    stockValue: number;
    stockistName?: string; // single most-purchased stockist for this drug
  };
  const aggByDrug = new Map<string, Agg>();
  const ensure = (name: string): Agg => {
    let a = aggByDrug.get(name);
    if (!a) {
      a = { name, bought: 0, boughtGross: 0, boughtMarginNum: 0, boughtMarginDen: 0,
            freeQty: 0, sold: 0, soldGross: 0, soldUnits: 0, cogs: 0,
            stockQty: 0, stockValue: 0 };
      aggByDrug.set(name, a);
    }
    return a;
  };

  // Walk purchases.table for per-drug bought / margin / free qty.
  const stockistByDrug = new Map<string, Map<string, number>>();
  for (const r of (purchases.table || []) as any[]) {
    if (!r.drug_name) continue;
    const a = ensure(r.drug_name);
    a.bought       += r.net_purchase_value || 0;
    a.boughtGross  += r.purchase_value || 0;
    const margin    = r.profit_pct || 0;
    const weight    = r.net_purchase_value || 0;
    a.boughtMarginNum += margin * weight;
    a.boughtMarginDen += weight;
    a.freeQty      += r.free_qty || 0;
    if (r.stockiest_name) {
      let sm = stockistByDrug.get(r.drug_name);
      if (!sm) { sm = new Map(); stockistByDrug.set(r.drug_name, sm); }
      sm.set(r.stockiest_name, (sm.get(r.stockiest_name) || 0) + (r.net_purchase_value || 0));
    }
  }
  // Pick the dominant stockist per drug (largest spend share).
  for (const [drug, sm] of stockistByDrug) {
    let best = ''; let bestVal = -1;
    for (const [s, v] of sm) if (v > bestVal) { best = s; bestVal = v; }
    const a = aggByDrug.get(drug);
    if (a) a.stockistName = best;
  }

  // Walk sales.table for per-drug sold / units / cogs.
  for (const r of (sales.table || []) as any[]) {
    if (!r.drug_name) continue;
    const a = ensure(r.drug_name);
    const tax     = r.sales_tax || 0;
    const gross   = r.sales_amount || 0;
    const net     = Math.max(0, gross - tax);
    a.soldGross += gross;
    a.sold      += net;
    a.soldUnits += r.qty || 0;
    a.cogs      += r.purchase_amount || 0;
  }

  // Stock totals by drug (use API's per-drug topProducts plus aggregate
  // unknown remainder is implicitly handled by zero-fill).
  for (const r of (stock.topProducts || []) as any[]) {
    if (!r.name) continue;
    const a = ensure(r.name);
    a.stockValue = r.value || 0;
    a.stockQty   = r.qty || 0;
  }

  // Cross payload provides additional drugs (purchasedNotSold etc.)
  // even when the detail tables didn't include them — make sure those
  // appear too with at least bought/sold totals.
  for (const r of (cross.topCrossProducts || []) as any[]) {
    if (!r.name) continue;
    const a = ensure(r.name);
    if (a.bought === 0) a.bought = r.purchases || 0;
    if (a.sold   === 0) a.sold   = r.sales || 0;
    if (a.soldUnits === 0) a.soldUnits = r.salesQty || 0;
  }
  for (const r of (cross.purchasedNotSold || []) as any[]) {
    if (!r.name) continue;
    const a = ensure(r.name);
    if (a.bought === 0) a.bought = r.purchases || 0;
  }
  for (const r of (cross.soldNotPurchased || []) as any[]) {
    if (!r.name) continue;
    const a = ensure(r.name);
    if (a.sold === 0)      a.sold = r.sales || 0;
    if (a.soldUnits === 0) a.soldUnits = r.salesQty || 0;
  }

  // ── Per-drug derived metrics ─────────────────────────────────────
  type Row = Agg & {
    pMargin: number;       // purchase margin %
    sMargin: number;       // sale margin %
    leakPp: number;        // pp drop
    lostRupees: number;    // approximate margin lost in rupees
    sellThruPct: number;   // sold ÷ bought × 100
    status: 'healthy' | 'sitting' | 'leaking' | 'dead';
  };
  const rows: Row[] = [];
  for (const a of aggByDrug.values()) {
    const pMargin = a.boughtMarginDen > 0 ? a.boughtMarginNum / a.boughtMarginDen : 0;
    const sMargin = a.sold > 0 ? Math.max(0, ((a.sold - a.cogs) / a.sold) * 100) : 0;
    const leakPp  = pMargin - sMargin;
    const lostRupees = a.sold > 0 && leakPp > 0 ? (leakPp / 100) * a.sold : 0;
    const sellThruPct = a.bought > 0 ? (a.sold / a.bought) * 100 : (a.sold > 0 ? 999 : 0);

    let status: Row['status'];
    if (a.bought > 0 && a.sold === 0) status = 'sitting';
    else if (a.bought === 0 && a.sold === 0 && a.stockValue > 0) status = 'dead';
    else if (a.sold > 0 && pMargin > 0 && sMargin < 0.5 * pMargin) status = 'leaking';
    else status = 'healthy';

    rows.push({ ...a, pMargin, sMargin, leakPp, lostRupees, sellThruPct, status });
  }

  // ── Aggregate KPI values ─────────────────────────────────────────
  // Sell-through (period): drugs in BOTH purchases and sales this period.
  const matched = rows.filter(r => r.bought > 0 && r.sold > 0);
  const matchedBought = matched.reduce((s, r) => s + r.bought, 0);
  const matchedSold   = matched.reduce((s, r) => s + r.sold,   0);
  const periodSellThruPct = matchedBought > 0 ? (matchedSold / matchedBought) * 100 : 0;

  // Margin retained: weighted avg sale margin / weighted avg purchase margin.
  const totalNetSales = sales.kpi?.totalNetSales ?? Math.max(0, (sales.kpi?.totalSales || 0) - (sales.kpi?.totalTax || 0));
  const aggSaleMarginPct = sales.kpi?.grossMarginPct ?? sales.kpi?.profitMargin ?? 0;
  const aggPurchaseMarginNum = rows.reduce((s, r) => s + r.boughtMarginNum, 0);
  const aggPurchaseMarginDen = rows.reduce((s, r) => s + r.boughtMarginDen, 0);
  const aggPurchaseMarginPct = aggPurchaseMarginDen > 0 ? aggPurchaseMarginNum / aggPurchaseMarginDen : 0;
  const marginRetainedPct = aggPurchaseMarginPct > 0 ? (aggSaleMarginPct / aggPurchaseMarginPct) * 100 : 0;

  // Margin leakage: SKUs where leak > 5pp; rupee value summed.
  const leakSkus = rows.filter(r => r.leakPp > 5 && r.sold > 0);
  const leakRupees = leakSkus.reduce((s, r) => s + r.lostRupees, 0);

  // Aggregate days-of-cover: live stock value ÷ daily sales velocity (₹).
  const liveStockValue = (stock.expiryZones || []).filter((z: any) => z.name !== 'Expired')
    .reduce((s: number, z: any) => s + (z.value || 0), 0);
  const dailySalesValue = totalNetSales / periodDays;
  const aggDaysOfCover = dailySalesValue > 0 ? Math.floor(liveStockValue / dailySalesValue) : null;

  // ── Margin leak hero — top 5 by lost rupees ─────────────────────
  const leakTop = [...leakSkus]
    .filter(r => r.leakPp > 10) // brief: > 10pp threshold for the callout list
    .sort((a, b) => b.lostRupees - a.lostRupees)
    .slice(0, 5);

  // ── Money cycle — top 6 by bought ───────────────────────────────
  const moneyCycle = [...rows]
    .filter(r => r.bought > 0 || r.sold > 0 || r.stockValue > 0)
    .sort((a, b) => b.bought - a.bought)
    .slice(0, 6);

  // ── Days of cover — fastest movers (top 8 ascending) ────────────
  const daysOfCover = rows
    .filter(r => r.soldUnits > 0 && r.stockQty > 0)
    .map(r => {
      const velocity = r.soldUnits / periodDays;
      const daysLeft = velocity > 0 ? Math.floor(r.stockQty / velocity) : null;
      return { ...r, velocity, daysLeft };
    })
    .filter(r => r.daysLeft != null)
    .sort((a, b) => (a.daysLeft as number) - (b.daysLeft as number))
    .slice(0, 8);

  // ── Anomaly buckets ─────────────────────────────────────────────
  const purchasedNotSold = (cross.purchasedNotSold || []) as any[];
  const soldFromOldStock = (cross.soldNotPurchased || []) as any[];
  const purchasedNotSoldValue = purchasedNotSold.reduce((s, r) => s + (r.purchases || 0), 0);
  const soldFromOldStockValue = soldFromOldStock.reduce((s, r) => s + (r.sales || 0), 0);
  const purchasedNotSoldTop = [...purchasedNotSold].sort((a, b) => (b.purchases || 0) - (a.purchases || 0)).slice(0, 2);
  const soldFromOldStockTop = [...soldFromOldStock].sort((a, b) => (b.sales || 0) - (a.sales || 0)).slice(0, 2);

  // ── Master cross-report — filtered + sorted ─────────────────────
  const masterAll = [...rows].sort((a, b) => b.bought - a.bought);
  const masterFiltered = statusFilter === 'all' ? masterAll : masterAll.filter(r => r.status === statusFilter);
  const masterVisible = masterFiltered.slice(0, 15);

  // ── Pill style helpers ──────────────────────────────────────────
  const statusStyles: Record<Row['status'], { bg: string; text: string; dot: string; label: string }> = {
    healthy: { bg: 'rgb(99 153 34 / 0.10)',  text: 'text-emerald-800 dark:text-emerald-200', dot: '#639922', label: 'Healthy' },
    sitting: { bg: 'rgb(186 117 23 / 0.10)', text: 'text-amber-800 dark:text-amber-200',    dot: '#BA7517', label: 'Sitting' },
    leaking: { bg: 'rgb(226 75 74 / 0.10)',  text: 'text-rose-800 dark:text-rose-200',      dot: '#E24B4A', label: 'Leaking' },
    dead:    { bg: 'rgb(100 116 139 / 0.12)', text: 'text-slate-700 dark:text-slate-300',   dot: '#64748b', label: 'Dead' },
  };
  const daysOfCoverPill = (days: number | null) => {
    if (days == null)  return { bg: 'rgb(148 163 184 / 0.15)', text: 'text-slate-700 dark:text-slate-300' };
    if (days <= 7)     return { bg: 'rgb(226 75 74 / 0.12)',  text: 'text-rose-800 dark:text-rose-200' };
    if (days <= 14)    return { bg: 'rgb(186 117 23 / 0.12)', text: 'text-amber-800 dark:text-amber-200' };
    return { bg: 'rgb(99 153 34 / 0.12)', text: 'text-emerald-800 dark:text-emerald-200' };
  };

  return (
    <div>
      {/* ── KPI strip — 5 cross-tab metrics ─────────────────────
          Drops the original 4 KPIs which were narrow snapshots.
          The new strip frames the cross-tab story: how much of
          what we bought has sold, how much margin we kept, where
          we're leaking, how long current stock lasts, and how
          much is dead. */}
      {isVisible('pharma_cross_kpis') && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-4">
          <PurchaseKPI
            tone="teal"
            label="Sell-through (period)"
            value={`${periodSellThruPct.toFixed(0)}%`}
            sub={`${formatINR(matchedSold)} sold of ${formatINR(matchedBought)} bought`}
          />
          <PurchaseKPI
            tone="blue"
            label="Margin retained"
            value={`${marginRetainedPct.toFixed(0)}%`}
            sub={`${aggSaleMarginPct.toFixed(2)}% sold vs ${aggPurchaseMarginPct.toFixed(2)}% bought`}
          />
          <PurchaseKPI
            tone="coral"
            label="Margin leakage"
            value={formatINR(Math.round(leakRupees))}
            sub={`across ${formatNumber(leakSkus.length)} outlier SKU${leakSkus.length === 1 ? '' : 's'}`}
          />
          <PurchaseKPI
            tone="amber"
            label="Stock days of cover"
            value={aggDaysOfCover != null ? `${formatNumber(aggDaysOfCover)} days` : '—'}
            sub="at current sales pace"
          />
          <PurchaseKPI
            tone="purple"
            label="Dead stock"
            value="—"
            sub="needs 90-day sales lookback"
          />
        </div>
      )}

      {/* ── Margin leak hero callout ──────────────────────────────
          The single biggest signal in the redesign: drugs purchased
          at healthy margins but sold near zero. Hidden when nothing
          qualifies. */}
      {isVisible('pharma_margin_leak') && leakTop.length > 0 && (
        <div
          className="mb-4 rounded-xl"
          style={{
            background: 'rgb(163 45 45 / 0.08)',
            borderLeft: '4px solid #A32D2D',
            padding: '1rem 1.25rem',
          }}
        >
          <p className="text-[14px] font-medium text-rose-900 dark:text-rose-200 flex items-center gap-1.5">
            <AlertTriangle size={14} className="shrink-0" />
            {formatINR(Math.round(leakTop.reduce((s, r) => s + r.lostRupees, 0)))} in margin leaked across {leakSkus.length} SKU{leakSkus.length === 1 ? '' : 's'} this period
          </p>
          <p className="text-[12px] text-rose-800 dark:text-rose-300/90 mt-1.5 leading-relaxed">
            These products were purchased at healthy margins but sold at near-zero margin. Either MRP needs
            revision, the source-system has a pricing error, or these are unintentional loss-leaders.
          </p>
          <div className="mt-3 rounded-md overflow-hidden" style={{ background: 'rgb(255 255 255 / 0.7)' }}>
            <div
              className="grid grid-cols-[1fr_90px_90px_90px_120px] gap-3 px-3 py-2 text-[11px] uppercase tracking-[0.5px]"
              style={{ background: 'rgb(247 193 193 / 0.7)', color: '#501313' }}
            >
              <span>Drug</span>
              <span className="text-right">Bought at</span>
              <span className="text-right">Sold at</span>
              <span className="text-right">Leak</span>
              <span className="text-right">Lost ₹</span>
            </div>
            {leakTop.map((r, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_90px_90px_90px_120px] gap-3 px-3 py-2 text-[12px]"
                style={{ borderTop: i === 0 ? 'none' : '0.5px solid rgb(163 45 45 / 0.15)', color: '#501313' }}
              >
                <span className="truncate" title={r.name}>{r.name}</span>
                <span className="text-right">{r.pMargin.toFixed(1)}%</span>
                <span className={`text-right ${r.sMargin < 5 ? 'font-medium' : ''}`} style={{ color: r.sMargin < 5 ? '#A32D2D' : undefined }}>
                  {r.sMargin.toFixed(1)}%
                </span>
                <span className="text-right" style={{ color: '#A32D2D' }}>−{r.leakPp.toFixed(1)} pp</span>
                <span className="text-right font-medium">{formatINR(Math.round(r.lostRupees))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Money cycle — Bought → In Stock → Sold → Profit ────── */}
      {isVisible('pharma_money_cycle') && moneyCycle.length > 0 && (
        <div
          className="mb-4 rounded-xl p-5"
          style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
        >
          <h3 className="text-base font-medium text-theme-heading">The money cycle — what happens to every rupee bought</h3>
          <p className="text-[13px] text-theme-secondary mt-0.5">Top 6 by purchase value</p>
          <p className="text-[13px] text-theme-faint mt-1">Track the supplier → shelf → cash flow per drug.</p>

          <div className="mt-4">
            <div className="grid grid-cols-[1fr_120px_120px_120px_120px_110px] gap-3 px-2 pb-2 text-[12px] uppercase tracking-[0.5px] text-theme-faint border-b" style={{ borderColor: 'var(--mt-border)' }}>
              <span>Drug</span>
              <span className="text-right">Bought</span>
              <span className="text-right">In stock</span>
              <span className="text-right">Sold</span>
              <span className="text-right">Profit</span>
              <span className="text-right">Cycle</span>
            </div>
            {moneyCycle.map((r, i) => {
              const profit = Math.max(0, r.sold - r.cogs);
              const profitDanger = r.sold > 0 && profit < 0.01 * r.sold;
              const s = statusStyles[r.status];
              return (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_120px_120px_120px_120px_110px] gap-3 px-2 py-2.5 items-center text-[13px]"
                  style={{ borderTop: i === 0 ? 'none' : '0.5px solid var(--mt-border)' }}
                >
                  <span className="text-theme-heading truncate" title={r.name}>{r.name}</span>
                  <span className="text-right">
                    <span className="text-theme-heading">{formatINR(r.bought)}</span>
                    {r.freeQty > 0 && (
                      <span className="block text-[11px] text-emerald-700 dark:text-emerald-400">+{formatNumber(r.freeQty)} free</span>
                    )}
                  </span>
                  <span className="text-right text-theme-secondary">{formatINR(r.stockValue)}</span>
                  <span className="text-right text-theme-heading">{formatINR(r.sold)}</span>
                  <span className={`text-right font-medium ${profitDanger ? 'text-rose-700 dark:text-rose-300' : 'text-theme-heading'}`}>
                    {formatINR(profit)}
                  </span>
                  <span className="text-right">
                    <span className={`inline-flex items-center gap-1 rounded-md text-[11px] ${s.text}`}
                          style={{ background: s.bg, padding: '2px 8px' }}>
                      <span className="inline-block rounded-full" style={{ width: '6px', height: '6px', background: s.dot }} />
                      {s.label}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-3 mt-4 text-[11px] text-theme-faint">
            {(['healthy', 'sitting', 'leaking', 'dead'] as const).map(k => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className="inline-block rounded-sm" style={{ width: '8px', height: '8px', background: statusStyles[k].dot }} />
                <span className="capitalize">{statusStyles[k].label}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Stockist sell-through — backend-blocked stub ─────────
          Computing this honestly requires batch-to-sale linkage
          (which stockist's batch was drawn down by which sale).
          The current schema doesn't track that. Documented in
          CROSS_REPORT_BACKEND.md. */}
      {isVisible('pharma_stockist_sellthrough') && (
        <div
          className="mb-4 rounded-xl p-5"
          style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
        >
          <h3 className="text-base font-medium text-theme-heading">Which suppliers' stock actually sells</h3>
          <p className="text-[13px] text-theme-secondary mt-0.5">Sell-through % per stockist</p>
          <div
            className="mt-3 rounded-md p-4 text-[13px] text-theme-secondary"
            style={{ background: 'rgb(148 163 184 / 0.10)', border: '0.5px dashed var(--mt-border)' }}
          >
            <p className="font-medium text-theme-heading">Backend join required</p>
            <p className="mt-1 text-theme-faint">
              Computing per-stockist sell-through honestly needs a batch-to-sale lineage
              (which stockist supplied each batch, and which batch each sale drew from).
              The current schema doesn't track this. See <code className="text-[12px]">CROSS_REPORT_BACKEND.md</code>
              {' '}for the SQL and endpoint changes needed.
            </p>
          </div>
        </div>
      )}

      {/* ── Days of cover — when will I run out? ─────────────────── */}
      {isVisible('pharma_days_of_cover') && daysOfCover.length > 0 && (
        <div
          className="mb-4 rounded-xl p-5"
          style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
        >
          <h3 className="text-base font-medium text-theme-heading">Days of cover — when will I run out?</h3>
          <p className="text-[13px] text-theme-secondary mt-0.5">Stock ÷ daily sales velocity</p>
          <p className="text-[13px] text-theme-faint mt-1">Reorder the items in red before they hit zero.</p>

          <div className="mt-4">
            <div className="grid grid-cols-[1fr_100px_120px_100px] gap-3 px-2 pb-2 text-[12px] uppercase tracking-[0.5px] text-theme-faint border-b" style={{ borderColor: 'var(--mt-border)' }}>
              <span>Drug</span>
              <span className="text-right">Stock qty</span>
              <span className="text-right">Daily sales</span>
              <span className="text-right">Days left</span>
            </div>
            {daysOfCover.map((r, i) => {
              const days = r.daysLeft as number;
              const pill = daysOfCoverPill(days);
              const isUrgent = days <= 7;
              return (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_100px_120px_100px] gap-3 px-2 py-2.5 items-center text-[13px]"
                  style={{
                    borderTop: i === 0 ? 'none' : '0.5px solid var(--mt-border)',
                    background: isUrgent ? 'rgb(226 75 74 / 0.05)' : undefined,
                  }}
                >
                  <span className="text-theme-heading truncate" title={r.name}>{r.name}</span>
                  <span className="text-right text-theme-secondary">{formatNumber(r.stockQty)}</span>
                  <span className="text-right text-theme-secondary">{r.velocity.toFixed(1)} / day</span>
                  <span className="text-right">
                    <span className={`inline-flex items-center gap-1 rounded-md text-[11px] ${pill.text}`}
                          style={{ background: pill.bg, padding: '2px 8px' }}>
                      {isUrgent && <AlertTriangle size={10} />} {days} day{days === 1 ? '' : 's'}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Anomaly buckets ──────────────────────────────────────── */}
      {isVisible('pharma_anomaly_buckets') && (
        <div
          className="mb-4 rounded-xl p-5"
          style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
        >
          <h3 className="text-base font-medium text-theme-heading">Anomaly buckets</h3>
          <p className="text-[13px] text-theme-secondary mt-0.5">Products that don't follow the normal buy → stock → sell cycle</p>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-4">
            {/* Tile 1: Purchased, not sold (amber) */}
            <div
              className="rounded-md p-4"
              style={{ background: 'rgb(186 117 23 / 0.10)', border: '0.5px solid rgb(186 117 23 / 0.25)' }}
            >
              <p className="text-[11px] uppercase tracking-[0.5px] text-amber-800 dark:text-amber-300">Purchased, not sold</p>
              <p className="text-[18px] font-medium text-amber-900 dark:text-amber-200 mt-1">
                {formatNumber(purchasedNotSold.length)} SKU{purchasedNotSold.length === 1 ? '' : 's'} · {formatINR(purchasedNotSoldValue)}
              </p>
              <p className="text-[12px] text-amber-800 dark:text-amber-300 mt-1">
                Bought this period, zero sales yet — capital tied up.
              </p>
              {purchasedNotSoldTop.length > 0 && (
                <p className="text-[11px] text-amber-800 dark:text-amber-300 mt-3 pt-3" style={{ borderTop: '0.5px solid rgb(186 117 23 / 0.20)' }}>
                  <span className="opacity-70">Top:</span>{' '}
                  {purchasedNotSoldTop.map((p, i) => (
                    <span key={i}>
                      {i > 0 ? ' · ' : ''}{p.name} ({formatINR(p.purchases || 0)})
                    </span>
                  ))}
                </p>
              )}
            </div>

            {/* Tile 2: Sold from old stock (purple) */}
            <div
              className="rounded-md p-4"
              style={{ background: 'rgb(139 92 246 / 0.10)', border: '0.5px solid rgb(139 92 246 / 0.25)' }}
            >
              <p className="text-[11px] uppercase tracking-[0.5px] text-purple-700 dark:text-purple-300">Sold from old stock</p>
              <p className="text-[18px] font-medium text-purple-900 dark:text-purple-200 mt-1">
                {formatNumber(soldFromOldStock.length)} SKU{soldFromOldStock.length === 1 ? '' : 's'} · {formatINR(soldFromOldStockValue)}
              </p>
              <p className="text-[12px] text-purple-700 dark:text-purple-300 mt-1">
                Sold this period but no purchase — drawing from prior inventory.
              </p>
              {soldFromOldStockTop.length > 0 && (
                <p className="text-[11px] text-purple-700 dark:text-purple-300 mt-3 pt-3" style={{ borderTop: '0.5px solid rgb(139 92 246 / 0.20)' }}>
                  <span className="opacity-70">Top:</span>{' '}
                  {soldFromOldStockTop.map((p, i) => (
                    <span key={i}>
                      {i > 0 ? ' · ' : ''}{p.name} ({formatINR(p.sales || 0)})
                    </span>
                  ))}
                </p>
              )}
            </div>

            {/* Tile 3: Dead stock — backend-blocked stub */}
            <div
              className="rounded-md p-4"
              style={{ background: 'rgb(226 75 74 / 0.08)', border: '0.5px dashed rgb(226 75 74 / 0.30)' }}
            >
              <p className="text-[11px] uppercase tracking-[0.5px] text-rose-800 dark:text-rose-300">Dead stock (no sales 90d)</p>
              <p className="text-[14px] text-rose-800 dark:text-rose-300 mt-2">Backend join required</p>
              <p className="text-[12px] text-rose-700 dark:text-rose-300/90 mt-1">
                Needs a 90-day sales lookback the API doesn't currently expose.
                See <code className="text-[11px]">CROSS_REPORT_BACKEND.md</code>.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Master product cross-report table ──────────────────── */}
      {isVisible('pharma_product_cross_table') && masterAll.length > 0 && (
        <div
          className="mb-6 rounded-xl p-5"
          style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
        >
          <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
            <div>
              <h3 className="text-base font-medium text-theme-heading">Product cross-report</h3>
              <p className="text-[13px] text-theme-secondary mt-0.5">
                {formatNumber(masterFiltered.length)} of {formatNumber(masterAll.length)} products with full purchase × stock × sales view
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as any)}
                className="text-[12px] rounded-md px-2 py-1.5"
                style={{ background: 'var(--mt-bg-app)', border: '0.5px solid var(--mt-border)', color: 'var(--mt-text)' }}
              >
                <option value="all">All statuses</option>
                <option value="healthy">Healthy</option>
                <option value="sitting">Sitting</option>
                <option value="leaking">Leaking</option>
                <option value="dead">Dead</option>
              </select>
            </div>
          </div>

          {/* Horizontal scroll wrapper. The 8-column table needs ~880px to
              breathe; below that the user gets a horizontal scroll inside
              the card instead of clipped pills or column collisions. The
              footer counter + legend stay outside the wrapper so they
              always read at the card's natural width. */}
          <div style={{ overflowX: 'auto' }}>
            <div
              className="grid grid-cols-[minmax(220px,2.4fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(80px,0.9fr)_minmax(80px,0.9fr)_minmax(90px,1fr)_minmax(90px,1fr)] gap-2 pb-2 text-[11px] uppercase tracking-[0.5px] text-theme-faint border-b"
              style={{ borderColor: 'var(--mt-border)', minWidth: 880 }}
            >
              <span style={{ paddingLeft: 6, paddingRight: 6 }}>Drug</span>
              <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right">Bought</span>
              <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right">Stock</span>
              <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right">Sold</span>
              <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right">P-margin</span>
              <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right">S-margin</span>
              <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right">Sell-thru</span>
              <span style={{ paddingLeft: 6, paddingRight: 18 }} className="text-right">Status</span>
            </div>
            {masterVisible.map((r, i) => {
              const rowBg =
                r.status === 'leaking' ? 'rgb(226 75 74 / 0.05)' :
                r.status === 'sitting' ? 'rgb(186 117 23 / 0.05)' :
                r.status === 'dead'    ? 'rgb(100 116 139 / 0.06)' :
                undefined;
              const s = statusStyles[r.status];
              return (
                <div
                  key={i}
                  className="grid grid-cols-[minmax(220px,2.4fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(80px,0.9fr)_minmax(80px,0.9fr)_minmax(90px,1fr)_minmax(90px,1fr)] gap-2 py-2 items-center text-[12px]"
                  style={{
                    borderTop: i === 0 ? 'none' : '0.5px solid var(--mt-border)',
                    background: rowBg,
                    minWidth: 880,
                  }}
                >
                  <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-theme-heading truncate" title={r.name}>{r.name}</span>
                  <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right text-theme-secondary">{formatINR(r.bought)}</span>
                  <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right text-theme-secondary">{formatINR(r.stockValue)}</span>
                  <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right text-theme-secondary">{formatINR(r.sold)}</span>
                  <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right text-theme-secondary">{r.pMargin.toFixed(1)}%</span>
                  <span style={{ paddingLeft: 6, paddingRight: 6 }} className={`text-right ${r.sMargin < 5 && r.sold > 0 ? 'font-medium text-rose-700 dark:text-rose-300' : 'text-theme-secondary'}`}>
                    {r.sMargin.toFixed(1)}%
                  </span>
                  <span style={{ paddingLeft: 6, paddingRight: 6 }} className="text-right text-theme-secondary">
                    {r.sellThruPct === 999 ? '—' : `${r.sellThruPct > 999 ? '999+' : r.sellThruPct.toFixed(0)}%`}
                  </span>
                  <span style={{ paddingLeft: 6, paddingRight: 18 }} className={`text-right text-[10px] font-medium ${s.text}`}>{s.label}</span>
                </div>
              );
            })}
          </div>

          {masterFiltered.length > masterVisible.length && (
            <p className="mt-3 text-[12px] text-theme-faint">
              + {masterFiltered.length - masterVisible.length} more row{masterFiltered.length - masterVisible.length === 1 ? '' : 's'}
            </p>
          )}
          <p className="mt-2 text-[11px] text-theme-faint">
            P-margin = purchase margin · S-margin = sale margin · Sell-through &gt; 100% = drawing from old stock
          </p>
        </div>
      )}
    </div>
  );
}
