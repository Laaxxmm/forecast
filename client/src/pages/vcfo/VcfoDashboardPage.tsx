import { useState, useEffect, useMemo } from 'react';
import api from '../../api/client';
import {
  TrendingUp, TrendingDown, DollarSign, ShoppingCart, ArrowUpRight, ArrowDownRight,
  BarChart3, PieChart, Minus
} from 'lucide-react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  ArcElement, Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Bar, Doughnut, Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler);

interface KPIs {
  revenue: number;
  purchase: number;
  directIncome: number;
  directExpenses: number;
  indirectIncome: number;
  indirectExpenses: number;
  grossProfit: number;
  netProfit: number;
  grossProfitMargin: number;
  netProfitMargin: number;
  stockAdjustment: number;
  operatingExpenses: number;
}

interface Company {
  id: number;
  name: string;
  fy_from: string;
  fy_to: string;
  last_sync_at: string | null;
}

function fmt(val: number): string {
  if (Math.abs(val) >= 10000000) return `₹${(val / 10000000).toFixed(2)} Cr`;
  if (Math.abs(val) >= 100000) return `₹${(val / 100000).toFixed(2)} L`;
  if (Math.abs(val) >= 1000) return `₹${(val / 1000).toFixed(1)} K`;
  return `₹${val.toFixed(0)}`;
}

function getFYDates(): { from: string; to: string } {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

export default function VcfoDashboardPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [topRevenue, setTopRevenue] = useState<any[]>([]);
  const [topExpenses, setTopExpenses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [noData, setNoData] = useState(false);

  const { from, to } = useMemo(getFYDates, []);

  useEffect(() => {
    api.get('/vcfo/companies').then(res => {
      setCompanies(res.data);
      if (res.data.length > 0 && !selectedCompanyId) {
        setSelectedCompanyId(res.data[0].id);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedCompanyId) { setLoading(false); return; }
    setLoading(true);
    const params = { from, to, companyId: selectedCompanyId };
    Promise.all([
      api.get('/vcfo/dashboard/kpi', { params }),
      api.get('/vcfo/dashboard/monthly-trend', { params }),
      api.get('/vcfo/dashboard/top-revenue', { params }),
      api.get('/vcfo/dashboard/top-expenses', { params }),
    ]).then(([kpiRes, trendRes, revRes, expRes]) => {
      if (kpiRes.data.noData) {
        setNoData(true);
        setKpis(null);
      } else {
        setNoData(false);
        setKpis(kpiRes.data.kpis);
      }
      setTrend(trendRes.data);
      setTopRevenue(revRes.data);
      setTopExpenses(expRes.data);
    }).finally(() => setLoading(false));
  }, [selectedCompanyId, from, to]);

  const kpiCards = kpis ? [
    { label: 'Revenue', value: kpis.revenue, icon: TrendingUp, color: 'text-green-400', bg: 'bg-green-500/10' },
    { label: 'Purchases', value: kpis.purchase, icon: ShoppingCart, color: 'text-orange-400', bg: 'bg-orange-500/10' },
    { label: 'Direct Income', value: kpis.directIncome, icon: ArrowUpRight, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    { label: 'Direct Expenses', value: kpis.directExpenses, icon: ArrowDownRight, color: 'text-red-400', bg: 'bg-red-500/10' },
    { label: 'Indirect Income', value: kpis.indirectIncome, icon: ArrowUpRight, color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
    { label: 'Indirect Expenses', value: kpis.indirectExpenses, icon: ArrowDownRight, color: 'text-pink-400', bg: 'bg-pink-500/10' },
    { label: 'Gross Profit', value: kpis.grossProfit, icon: DollarSign, color: kpis.grossProfit >= 0 ? 'text-green-400' : 'text-red-400', bg: kpis.grossProfit >= 0 ? 'bg-green-500/10' : 'bg-red-500/10' },
    { label: 'Net Profit', value: kpis.netProfit, icon: DollarSign, color: kpis.netProfit >= 0 ? 'text-green-400' : 'text-red-400', bg: kpis.netProfit >= 0 ? 'bg-green-500/10' : 'bg-red-500/10' },
    { label: 'GP Margin', value: kpis.grossProfitMargin, icon: BarChart3, color: 'text-purple-400', bg: 'bg-purple-500/10', suffix: '%' },
    { label: 'NP Margin', value: kpis.netProfitMargin, icon: PieChart, color: 'text-amber-400', bg: 'bg-amber-500/10', suffix: '%' },
    { label: 'Stock Adj.', value: kpis.stockAdjustment, icon: Minus, color: 'text-gray-400', bg: 'bg-gray-500/10' },
    { label: 'Operating Exp.', value: kpis.operatingExpenses, icon: TrendingDown, color: 'text-rose-400', bg: 'bg-rose-500/10' },
  ] : [];

  const trendChartData = {
    labels: trend.map(t => {
      const d = new Date(t.month + 'T00:00:00');
      return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    }),
    datasets: [
      {
        label: 'Revenue',
        data: trend.map(t => t.revenue),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16,185,129,0.1)',
        fill: true, tension: 0.3,
      },
      {
        label: 'Expenses',
        data: trend.map(t => t.expenses),
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.1)',
        fill: true, tension: 0.3,
      },
    ],
  };

  const revenueChartData = {
    labels: topRevenue.slice(0, 8).map(r => r.ledger_name.length > 20 ? r.ledger_name.slice(0, 18) + '...' : r.ledger_name),
    datasets: [{
      data: topRevenue.slice(0, 8).map(r => r.total),
      backgroundColor: ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#64748b'],
    }],
  };

  const expenseChartData = {
    labels: topExpenses.slice(0, 8).map(r => r.ledger_name.length > 20 ? r.ledger_name.slice(0, 18) + '...' : r.ledger_name),
    datasets: [{
      data: topExpenses.slice(0, 8).map(r => r.total),
      backgroundColor: ['#ef4444', '#f59e0b', '#ec4899', '#8b5cf6', '#3b82f6', '#06b6d4', '#10b981', '#64748b'],
    }],
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-theme-muted">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-theme-heading">VCFO Dashboard</h1>
          <p className="text-sm text-theme-muted mt-1">Financial overview from Tally</p>
        </div>
        {companies.length > 1 && (
          <select
            value={selectedCompanyId || ''}
            onChange={e => setSelectedCompanyId(Number(e.target.value))}
            className="bg-dark-700 border border-dark-400/30 rounded-lg px-3 py-2 text-sm text-theme-primary"
          >
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>

      {noData ? (
        <div className="bg-dark-700 rounded-2xl p-12 text-center border border-dark-400/30">
          <BarChart3 size={48} className="text-theme-faint mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-theme-heading mb-2">No Data Yet</h2>
          <p className="text-theme-muted text-sm">Sync your Tally data from the Tally Sync page to see your financial dashboard.</p>
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {kpiCards.map((card, i) => {
              const Icon = card.icon;
              return (
                <div key={i} className="bg-dark-700 rounded-xl p-4 border border-dark-400/20">
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`w-8 h-8 rounded-lg ${card.bg} flex items-center justify-center`}>
                      <Icon size={15} className={card.color} />
                    </div>
                  </div>
                  <p className="text-xs text-theme-muted mb-1">{card.label}</p>
                  <p className={`text-lg font-bold ${card.color}`}>
                    {(card as any).suffix === '%' ? `${card.value.toFixed(1)}%` : fmt(card.value)}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Revenue vs Expenses trend */}
            {trend.length > 0 && (
              <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
                <h3 className="text-sm font-semibold text-theme-heading mb-4">Monthly Trend</h3>
                <div className="h-64">
                  <Line data={trendChartData} options={{
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } },
                    scales: {
                      x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(100,116,139,0.1)' } },
                      y: { ticks: { color: '#64748b', font: { size: 10 }, callback: (v: any) => fmt(v) }, grid: { color: 'rgba(100,116,139,0.1)' } },
                    },
                  }} />
                </div>
              </div>
            )}

            {/* Top Revenue Sources */}
            {topRevenue.length > 0 && (
              <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
                <h3 className="text-sm font-semibold text-theme-heading mb-4">Top Revenue Sources</h3>
                <div className="h-64 flex items-center justify-center">
                  <Doughnut data={revenueChartData} options={{
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                      legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 10 }, padding: 8, boxWidth: 12 } },
                    },
                  }} />
                </div>
              </div>
            )}
          </div>

          {/* Top Expenses bar chart */}
          {topExpenses.length > 0 && (
            <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
              <h3 className="text-sm font-semibold text-theme-heading mb-4">Top Expenses</h3>
              <div className="h-64">
                <Bar data={{
                  labels: topExpenses.slice(0, 10).map(r => r.ledger_name.length > 25 ? r.ledger_name.slice(0, 23) + '...' : r.ledger_name),
                  datasets: [{
                    label: 'Amount',
                    data: topExpenses.slice(0, 10).map(r => r.total),
                    backgroundColor: '#ef4444',
                    borderRadius: 6,
                  }],
                }} options={{
                  responsive: true, maintainAspectRatio: false, indexAxis: 'y',
                  plugins: { legend: { display: false } },
                  scales: {
                    x: { ticks: { color: '#64748b', font: { size: 10 }, callback: (v: any) => fmt(v) }, grid: { color: 'rgba(100,116,139,0.1)' } },
                    y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } },
                  },
                }} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
