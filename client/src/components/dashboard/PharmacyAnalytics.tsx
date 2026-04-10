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
  BarChart3, Layers, ArrowRightLeft, Warehouse, Clock,
} from 'lucide-react';

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
}

export default function PharmacyAnalytics({ isVisible }: PharmacyAnalyticsProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('purchases');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    api.get('/dashboard/pharmacy-analytics').then(res => {
      setData(res.data);
      // Auto-select first available tab
      if (res.data?.hasData) {
        if (res.data.hasPurchases) setActiveTab('purchases');
        else if (res.data.hasSales) setActiveTab('sales');
        else if (res.data.hasStock) setActiveTab('stock');
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

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
        <PurchasesTab data={data.purchases} isVisible={isVisible} search={search} setSearch={setSearch} page={page} setPage={setPage} pageSize={PAGE_SIZE} />
      )}
      {activeTab === 'sales' && data.sales && (
        <SalesTab data={data.sales} isVisible={isVisible} search={search} setSearch={setSearch} page={page} setPage={setPage} pageSize={PAGE_SIZE} />
      )}
      {activeTab === 'stock' && data.stock && (
        <StockTab data={data.stock} isVisible={isVisible} search={search} setSearch={setSearch} page={page} setPage={setPage} pageSize={PAGE_SIZE} />
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
}

function PurchasesTab({ data, isVisible, search, setSearch, page, setPage, pageSize }: TabProps) {
  const { kpi, monthlyTrend, topStockists, topManufacturers, topProducts, profitMarginDist, freeQtyAnalysis, table } = data;

  const cardKeys = ['pharma_total_purchase', 'pharma_total_invoices', 'pharma_unique_stockists', 'pharma_unique_products', 'pharma_total_free_qty', 'pharma_total_tax'];
  const chartKeys = ['pharma_monthly_purchase_trend', 'pharma_top_stockists', 'pharma_top_manufacturers', 'pharma_top_purchase_products', 'pharma_profit_margin_dist', 'pharma_free_qty_analysis'];
  const anyCardVisible = cardKeys.some(isVisible);
  const anyChartVisible = chartKeys.some(isVisible);
  const tableVisible = isVisible('pharma_purchase_table');

  const filteredTable = useMemo(() => {
    if (!search || !table) return table || [];
    const s = search.toLowerCase();
    return table.filter((r: any) =>
      (r.drug_name || '').toLowerCase().includes(s) ||
      (r.stockiest_name || '').toLowerCase().includes(s) ||
      (r.invoice_no || '').toLowerCase().includes(s)
    );
  }, [table, search]);

  const trendData = monthlyTrend?.map((m: any) => ({ ...m, label: getMonthLabel(m.month) })) || [];
  const donutData = profitMarginDist?.filter((d: any) => d.count > 0).map((d: any) => ({ name: d.range, value: d.count })) || [];
  const totalPages = Math.ceil(filteredTable.length / pageSize);
  const pageRows = filteredTable.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div>
      {/* KPI Cards */}
      {anyCardVisible && (() => {
        const visibleCount = cardKeys.filter(isVisible).length;
        const cols: Record<number, string> = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6' };
        return (
          <div className={`grid grid-cols-2 md:grid-cols-3 ${cols[visibleCount] || 'lg:grid-cols-6'} gap-4 mb-6`}>
            {isVisible('pharma_total_purchase') && <MiniKPI label="Total Purchase Value" value={formatINR(kpi.totalPurchaseValue)} icon={DollarSign} color="teal" />}
            {isVisible('pharma_total_invoices') && <MiniKPI label="Total Invoices" value={formatNumber(kpi.totalInvoices)} icon={FileText} color="blue" />}
            {isVisible('pharma_unique_stockists') && <MiniKPI label="Unique Stockists" value={formatNumber(kpi.uniqueStockists)} icon={Users} color="purple" />}
            {isVisible('pharma_unique_products') && <MiniKPI label="Unique Products" value={formatNumber(kpi.uniqueProducts)} icon={Package} color="amber" />}
            {isVisible('pharma_total_free_qty') && <MiniKPI label="Free Qty Received" value={formatNumber(kpi.totalFreeQty)} icon={Gift} color="emerald" />}
            {isVisible('pharma_total_tax') && <MiniKPI label="Total Tax" value={formatINR(kpi.totalTax)} icon={BarChart3} color="cyan" />}
          </div>
        );
      })()}

      {/* Charts */}
      {anyChartVisible && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          {/* Monthly Purchase Trend */}
          {isVisible('pharma_monthly_purchase_trend') && trendData.length > 0 && (
            <div className="card lg:col-span-2">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Monthly Purchase Trend</h3>
              <p className="text-xs text-theme-faint mb-4">Purchase value and invoice count over time</p>
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

          {/* Top Stockists */}
          {isVisible('pharma_top_stockists') && topStockists?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Top Stockists</h3>
              <p className="text-xs text-theme-faint mb-4">By purchase value</p>
              <ResponsiveContainer width="100%" height={Math.max(200, topStockists.length * 32)}>
                <BarChart data={topStockists} layout="vertical" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" horizontal={false} />
                  <XAxis type="number" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} width={140} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Bar dataKey="value" fill="#3b82f6" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top Manufacturers */}
          {isVisible('pharma_top_manufacturers') && topManufacturers?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Top Manufacturers</h3>
              <p className="text-xs text-theme-faint mb-4">By purchase value</p>
              <ResponsiveContainer width="100%" height={Math.max(200, topManufacturers.length * 32)}>
                <BarChart data={topManufacturers} layout="vertical" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" horizontal={false} />
                  <XAxis type="number" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} width={140} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Bar dataKey="value" fill="#8b5cf6" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top Products */}
          {isVisible('pharma_top_purchase_products') && topProducts?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Top Products by Purchase</h3>
              <p className="text-xs text-theme-faint mb-4">Highest value purchases</p>
              <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
                {topProducts.map((p: any, i: number) => {
                  const maxVal = topProducts[0]?.value || 1;
                  const width = Math.max(4, (p.value / maxVal) * 100);
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-theme-secondary truncate mr-2">{p.name}</span>
                        <span className="text-theme-heading font-medium shrink-0">{formatINR(p.value)}</span>
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

          {/* Profit Margin Distribution */}
          {isVisible('pharma_profit_margin_dist') && donutData.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Expected Profit Margin Distribution</h3>
              <p className="text-xs text-theme-faint mb-4">Product count by margin bracket</p>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={donutData} cx="50%" cy="50%" innerRadius={55} outerRadius={90} dataKey="value" strokeWidth={0}
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                    {donutData.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={CHART_STYLE} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Free Qty Analysis */}
          {isVisible('pharma_free_qty_analysis') && freeQtyAnalysis?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Free Quantity Analysis</h3>
              <p className="text-xs text-theme-faint mb-4">Stockists providing free goods</p>
              <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
                {freeQtyAnalysis.map((s: any, i: number) => (
                  <div key={i} className="flex items-center justify-between bg-dark-600/50 rounded-lg px-3 py-2">
                    <span className="text-xs text-theme-secondary truncate mr-2">{s.name}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-emerald-400 font-medium">{formatNumber(s.freeQty)} free</span>
                      <span className="text-[10px] text-theme-faint">({s.freePct}% of batch)</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Purchase Table */}
      {tableVisible && table?.length > 0 && (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-theme-heading">Purchase Details</h3>
              <p className="text-xs text-theme-faint">{formatNumber(filteredTable.length)} records</p>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint" />
              <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(() => 0); }}
                placeholder="Search drug, stockist..." className="input text-sm pl-9 w-64" />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-400/20">
                  {['Invoice', 'Date', 'Stockist', 'Drug', 'Batch Qty', 'Free', 'MRP', 'Purchase Val', 'Tax', 'Margin%'].map(h => (
                    <th key={h} className="text-left text-xs font-medium text-theme-faint px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-dark-400/10 hover:bg-dark-600/30">
                    <td className="px-3 py-2 text-theme-secondary font-mono text-xs">{r.invoice_no}</td>
                    <td className="px-3 py-2 text-theme-faint text-xs">{r.invoice_date}</td>
                    <td className="px-3 py-2 text-theme-secondary text-xs truncate max-w-[120px]">{r.stockiest_name}</td>
                    <td className="px-3 py-2 text-theme-heading text-xs truncate max-w-[150px]">{r.drug_name}</td>
                    <td className="px-3 py-2 text-right text-theme-heading">{r.batch_qty}</td>
                    <td className="px-3 py-2 text-right text-emerald-400">{r.free_qty || '-'}</td>
                    <td className="px-3 py-2 text-right text-theme-faint">{formatINR(r.mrp || 0)}</td>
                    <td className="px-3 py-2 text-right text-theme-heading">{formatINR(r.purchase_value || 0)}</td>
                    <td className="px-3 py-2 text-right text-theme-faint">{formatINR(r.tax_amount || 0)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={r.profit_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {r.profit_pct != null ? `${r.profit_pct.toFixed(1)}%` : '-'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination page={page} totalPages={totalPages} setPage={setPage} />
        </div>
      )}
    </div>
  );
}

// ── SALES TAB ────────────────────────────────────────────────────────────────

function SalesTab({ data, isVisible, search, setSearch, page, setPage, pageSize }: TabProps) {
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
          <div className={`grid grid-cols-2 md:grid-cols-3 ${cols[visibleCount] || 'lg:grid-cols-6'} gap-4 mb-6`}>
            {isVisible('pharma_total_sales') && <MiniKPI label="Total Sales" value={formatINR(kpi.totalSales)} icon={TrendingUp} color="teal" />}
            {isVisible('pharma_total_cogs') && <MiniKPI label="Cost of Goods" value={formatINR(kpi.totalCogs)} icon={DollarSign} color="blue" />}
            {isVisible('pharma_total_profit') && <MiniKPI label="Total Profit" value={formatINR(kpi.totalProfit)} icon={TrendingUp} color="emerald" />}
            {isVisible('pharma_profit_margin') && <MiniKPI label="Profit Margin" value={`${kpi.profitMargin}%`} icon={BarChart3} color="purple" />}
            {isVisible('pharma_total_bills') && <MiniKPI label="Total Bills" value={formatNumber(kpi.totalBills)} icon={FileText} color="amber" />}
            {isVisible('pharma_unique_patients') && <MiniKPI label="Unique Patients" value={formatNumber(kpi.uniquePatients)} icon={Users} color="cyan" />}
          </div>
        );
      })()}

      {/* Charts */}
      {anyChartVisible && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          {/* Monthly Sales Trend */}
          {isVisible('pharma_monthly_sales_trend') && trendData.length > 0 && (
            <div className="card lg:col-span-2">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Monthly Sales & Profitability</h3>
              <p className="text-xs text-theme-faint mb-4">Revenue, COGS, and profit trend</p>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={trendData} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Legend />
                  <Bar dataKey="sales" name="Sales" fill="#10b981" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="cogs" name="COGS" fill="#3b82f6" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="profit" name="Profit" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Sales vs COGS Monthly Comparison */}
          {isVisible('pharma_sales_vs_cogs') && trendData.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Sales vs COGS</h3>
              <p className="text-xs text-theme-faint mb-4">Monthly comparison</p>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Legend />
                  <Line type="monotone" dataKey="sales" name="Sales" stroke="#10b981" strokeWidth={2} dot={false} />
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

          {/* Top Drugs by Profit */}
          {isVisible('pharma_top_drugs_profit') && topDrugsByProfit?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Top Drugs by Profit</h3>
              <p className="text-xs text-theme-faint mb-4">Highest profit-generating medicines</p>
              <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
                {topDrugsByProfit.map((d: any, i: number) => {
                  const maxVal = topDrugsByProfit[0]?.profit || 1;
                  const width = Math.max(4, (d.profit / maxVal) * 100);
                  const barColor = d.marginPct >= 30 ? '#10b981' : d.marginPct >= 15 ? '#f59e0b' : '#ef4444';
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-theme-secondary truncate mr-2">{d.name}</span>
                        <span className="text-theme-heading font-medium shrink-0">{formatINR(d.profit)} <span className="text-theme-faint">({d.marginPct}%)</span></span>
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
      {tableVisible && table?.length > 0 && (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-theme-heading">Sales Details</h3>
              <p className="text-xs text-theme-faint">{formatNumber(filteredTable.length)} records</p>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint" />
              <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(() => 0); }}
                placeholder="Search drug, patient..." className="input text-sm pl-9 w-64" />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-400/20">
                  {['Bill #', 'Date', 'Patient', 'Drug', 'Qty', 'Sales', 'COGS', 'Profit', 'Referred By'].map(h => (
                    <th key={h} className="text-left text-xs font-medium text-theme-faint px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-dark-400/10 hover:bg-dark-600/30">
                    <td className="px-3 py-2 text-theme-secondary font-mono text-xs">{r.bill_no}</td>
                    <td className="px-3 py-2 text-theme-faint text-xs">{r.bill_date}</td>
                    <td className="px-3 py-2 text-theme-heading text-xs truncate max-w-[120px]">{r.patient_name}</td>
                    <td className="px-3 py-2 text-theme-secondary text-xs truncate max-w-[150px]">{r.drug_name}</td>
                    <td className="px-3 py-2 text-right text-theme-heading">{r.qty}</td>
                    <td className="px-3 py-2 text-right text-theme-heading">{formatINR(r.sales_amount || 0)}</td>
                    <td className="px-3 py-2 text-right text-theme-faint">{formatINR(r.purchase_amount || 0)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={(r.profit || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{formatINR(r.profit || 0)}</span>
                    </td>
                    <td className="px-3 py-2 text-theme-faint text-xs truncate max-w-[100px]">{r.referred_by || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination page={page} totalPages={totalPages} setPage={setPage} />
        </div>
      )}
    </div>
  );
}

// ── STOCK TAB ────────────────────────────────────────────────────────────────

function StockTab({ data, isVisible, search, setSearch, page, setPage, pageSize }: TabProps) {
  const { kpi, topProducts, expiryZones, table } = data;

  const cardKeys = ['pharma_stock_value', 'pharma_stock_skus', 'pharma_near_expiry', 'pharma_expired_items', 'pharma_total_batches'];
  const chartKeys = ['pharma_expiry_zones', 'pharma_top_stock_products'];
  const anyCardVisible = cardKeys.some(isVisible);
  const anyChartVisible = chartKeys.some(isVisible);
  const tableVisible = isVisible('pharma_stock_table');

  const filteredTable = useMemo(() => {
    if (!search || !table) return table || [];
    const s = search.toLowerCase();
    return table.filter((r: any) =>
      (r.drug_name || '').toLowerCase().includes(s) ||
      (r.batch_no || '').toLowerCase().includes(s)
    );
  }, [table, search]);

  const EXPIRY_COLORS: Record<string, string> = {
    'Expired': '#ef4444',
    'Critical (0-3m)': '#f97316',
    'Warning (3-6m)': '#f59e0b',
    'Safe (6-12m)': '#10b981',
    'Long Term (12m+)': '#3b82f6',
    'Unknown': '#64748b',
  };

  const totalPages = Math.ceil(filteredTable.length / pageSize);
  const pageRows = filteredTable.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div>
      {/* Snapshot Badge */}
      {kpi?.snapshotDate && (
        <div className="flex items-center gap-2 mb-4">
          <Clock size={13} className="text-theme-faint" />
          <span className="text-xs text-theme-faint">Snapshot: {kpi.snapshotDate}</span>
        </div>
      )}

      {/* KPI Cards */}
      {anyCardVisible && (() => {
        const visibleCount = cardKeys.filter(isVisible).length;
        const cols: Record<number, string> = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5' };
        return (
          <div className={`grid grid-cols-2 md:grid-cols-3 ${cols[visibleCount] || 'lg:grid-cols-5'} gap-4 mb-6`}>
            {isVisible('pharma_stock_value') && <MiniKPI label="Total Stock Value" value={formatINR(kpi.totalStockValue)} icon={Warehouse} color="teal" />}
            {isVisible('pharma_stock_skus') && <MiniKPI label="Unique SKUs" value={formatNumber(kpi.totalSkus)} icon={Package} color="blue" />}
            {isVisible('pharma_near_expiry') && <MiniKPI label="Near Expiry" value={formatNumber(kpi.nearExpiry || 0)} icon={AlertTriangle} color="amber" sub="Within 6 months" />}
            {isVisible('pharma_expired_items') && <MiniKPI label="Expired Batches" value={formatNumber(kpi.expired || 0)} icon={AlertTriangle} color="rose" />}
            {isVisible('pharma_total_batches') && <MiniKPI label="Total Batches" value={formatNumber(kpi.totalBatches)} icon={Layers} color="purple" />}
          </div>
        );
      })()}

      {/* Charts */}
      {anyChartVisible && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          {/* Expiry Zone Distribution */}
          {isVisible('pharma_expiry_zones') && expiryZones?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Stock by Expiry Zone</h3>
              <p className="text-xs text-theme-faint mb-4">Batch count and value by expiry timeline</p>
              <div className="flex gap-6">
                <div className="flex-1">
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={expiryZones} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" strokeWidth={0}
                        label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}>
                        {expiryZones.map((z: any, i: number) => (
                          <Cell key={i} fill={EXPIRY_COLORS[z.name] || COLORS[i]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-col justify-center gap-2">
                  {expiryZones.map((z: any, i: number) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: EXPIRY_COLORS[z.name] || COLORS[i] }} />
                      <div>
                        <div className="text-xs text-theme-secondary">{z.name}</div>
                        <div className="text-[10px] text-theme-faint">{z.batches} batches | {formatINR(z.value)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Top Products by Stock Value */}
          {isVisible('pharma_top_stock_products') && topProducts?.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Top Products by Stock Value</h3>
              <p className="text-xs text-theme-faint mb-4">Highest inventory value items</p>
              <ResponsiveContainer width="100%" height={Math.max(200, topProducts.length * 28)}>
                <BarChart data={topProducts.slice(0, 12)} layout="vertical" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" horizontal={false} />
                  <XAxis type="number" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} width={140} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Bar dataKey="value" name="Stock Value" fill="#10b981" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Stock Table */}
      {tableVisible && table?.length > 0 && (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-theme-heading">Stock Details</h3>
              <p className="text-xs text-theme-faint">{formatNumber(filteredTable.length)} items</p>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint" />
              <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(() => 0); }}
                placeholder="Search drug, batch..." className="input text-sm pl-9 w-64" />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-400/20">
                  {['Drug Name', 'Batch', 'Received', 'Expiry', 'Avl Qty', 'Strips', 'Purchase Price', 'Stock Value'].map(h => (
                    <th key={h} className="text-left text-xs font-medium text-theme-faint px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-dark-400/10 hover:bg-dark-600/30">
                    <td className="px-3 py-2 text-theme-heading text-xs truncate max-w-[180px]">{r.drug_name}</td>
                    <td className="px-3 py-2 text-theme-secondary font-mono text-xs">{r.batch_no}</td>
                    <td className="px-3 py-2 text-theme-faint text-xs">{r.received_date || '-'}</td>
                    <td className="px-3 py-2 text-theme-faint text-xs">{r.expiry_date || '-'}</td>
                    <td className="px-3 py-2 text-right text-theme-heading">{formatNumber(r.avl_qty || 0)}</td>
                    <td className="px-3 py-2 text-right text-theme-faint">{r.strips || '-'}</td>
                    <td className="px-3 py-2 text-right text-theme-faint">{formatINR(r.purchase_price || 0)}</td>
                    <td className="px-3 py-2 text-right text-teal-400 font-medium">{formatINR(r.stock_value || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination page={page} totalPages={totalPages} setPage={setPage} />
        </div>
      )}
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
