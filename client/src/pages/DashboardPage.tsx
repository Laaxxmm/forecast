import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, Area, AreaChart } from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber, getMonthLabel } from '../utils/format';
import {
  TrendingUp, TrendingDown, Users, IndianRupee, Pill, Stethoscope, Activity,
  BarChart3, Briefcase, RefreshCcw, GraduationCap, Store, Globe, Warehouse,
  UtensilsCrossed, Truck, ChefHat, ShoppingBag, FlaskConical
} from 'lucide-react';

const ICON_MAP: Record<string, any> = {
  Stethoscope, Pill, BarChart3, Briefcase, RefreshCcw, GraduationCap,
  Store, Globe, Warehouse, UtensilsCrossed, Truck, ChefHat, ShoppingBag,
  FlaskConical, TrendingUp, Users, IndianRupee, Activity,
};

interface OverviewData {
  fy: any;
  clinic: any;
  pharmacy: any;
  combined: any;
}

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899'];

function KPICard({ title, value, subtitle, icon: Icon, trend, color = 'accent', onClick }: {
  title: string; value: string; subtitle?: string; icon: any; trend?: number; color?: string; onClick?: () => void;
}) {
  const colorMap: Record<string, { bg: string; icon: string; glow: string }> = {
    accent: { bg: 'bg-accent-500/10', icon: 'text-accent-400', glow: 'border-accent-500/20' },
    blue: { bg: 'bg-blue-500/10', icon: 'text-blue-400', glow: 'border-blue-500/20' },
    purple: { bg: 'bg-purple-500/10', icon: 'text-purple-400', glow: 'border-purple-500/20' },
    amber: { bg: 'bg-amber-500/10', icon: 'text-amber-400', glow: 'border-amber-500/20' },
  };
  const c = colorMap[color] || colorMap.accent;

  return (
    <div className={`card border ${c.glow}${onClick ? ' cursor-pointer hover:scale-[1.02] transition-transform' : ''}`} onClick={onClick}>
      <div className="flex items-start justify-between mb-4">
        <div className={`p-2.5 rounded-xl ${c.bg}`}>
          <Icon size={20} className={c.icon} />
        </div>
        {trend !== undefined && (
          <div className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg ${
            trend >= 0
              ? 'text-emerald-400 bg-emerald-500/10'
              : 'text-red-400 bg-red-500/10'
          }`}>
            {trend >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {trend >= 0 ? '+' : ''}{trend.toFixed(1)}%
          </div>
        )}
      </div>
      <p className="text-xs text-theme-faint font-medium uppercase tracking-wide">{title}</p>
      <p className="text-2xl font-bold text-theme-heading mt-1">{value}</p>
      {subtitle && <p className="text-xs text-theme-faint mt-2">{subtitle}</p>}
    </div>
  );
}

function getStreamData(streamName: string, data: OverviewData): {
  revenue: number; subtitle: string; trend?: number; detailPath?: string;
} {
  const lower = streamName.toLowerCase();

  if (lower === 'clinic') {
    return {
      revenue: data.clinic.total_revenue || 0,
      subtitle: `${formatNumber(data.clinic.total_transactions || 0)} transactions`,
      trend: data.clinic.budget_total > 0
        ? ((data.clinic.total_revenue - data.clinic.budget_total) / data.clinic.budget_total) * 100
        : undefined,
      detailPath: '/clinic',
    };
  }

  if (lower === 'pharmacy') {
    return {
      revenue: data.pharmacy.total_sales || 0,
      subtitle: `${formatNumber(data.pharmacy.total_transactions || 0)} transactions`,
      trend: data.pharmacy.budget_total > 0
        ? ((data.pharmacy.total_sales - data.pharmacy.budget_total) / data.pharmacy.budget_total) * 100
        : undefined,
      detailPath: '/pharmacy',
    };
  }

  // For streams without actual data yet, show placeholder
  return {
    revenue: 0,
    subtitle: 'No data imported yet',
    trend: undefined,
    detailPath: undefined,
  };
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OverviewData | null>(null);
  const [streams, setStreams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/overview').then(res => {
      setData(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
    api.get('/streams').then(res => setStreams(res.data)).catch(() => {});
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto mb-3" />
        <span className="text-theme-faint text-sm">Loading dashboard...</span>
      </div>
    </div>
  );

  if (!data) return (
    <div className="text-center py-20">
      <Activity size={40} className="mx-auto text-theme-faint mb-3" />
      <span className="text-theme-faint">No data available</span>
    </div>
  );

  // Build monthly trend data
  const monthlyMap: Record<string, any> = {};
  (data.clinic.monthly || []).forEach((r: any) => {
    if (!monthlyMap[r.bill_month]) monthlyMap[r.bill_month] = { month: r.bill_month, clinic: 0, pharmacy: 0 };
    monthlyMap[r.bill_month].clinic += r.total_revenue;
  });
  (data.pharmacy.monthly || []).forEach((r: any) => {
    if (!monthlyMap[r.bill_month]) monthlyMap[r.bill_month] = { month: r.bill_month, clinic: 0, pharmacy: 0 };
    monthlyMap[r.bill_month].pharmacy = r.total_sales;
  });
  const trendData = Object.values(monthlyMap).sort((a: any, b: any) => a.month.localeCompare(b.month))
    .map((d: any) => ({ ...d, label: getMonthLabel(d.month), total: d.clinic + d.pharmacy }));

  // Dept pie data
  const deptMap: Record<string, number> = {};
  (data.clinic.monthly || []).forEach((r: any) => {
    deptMap[r.department] = (deptMap[r.department] || 0) + r.total_revenue;
  });
  const pieData = Object.entries(deptMap).map(([name, value]) => ({ name, value }));

  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-theme-heading">Actuals</h1>
        <p className="text-theme-faint mt-1 text-sm">{data.fy?.label || 'All Time'} Overview</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {/* Total Revenue card - always shown */}
        <KPICard
          title="Total Revenue"
          value={formatINR(data.combined.total_revenue)}
          subtitle="All streams"
          icon={IndianRupee}
          color="accent"
          trend={data.combined.total_budget > 0
            ? ((data.combined.total_revenue - data.combined.total_budget) / data.combined.total_budget) * 100
            : undefined}
        />

        {/* Dynamic stream cards */}
        {streams.length > 0 ? (
          streams.map((stream: any) => {
            const streamData = getStreamData(stream.name, data);
            const StreamIcon = ICON_MAP[stream.icon] || BarChart3;
            return (
              <KPICard
                key={stream.id}
                title={`${stream.name} Revenue`}
                value={formatINR(streamData.revenue)}
                subtitle={streamData.subtitle}
                icon={StreamIcon}
                color={stream.color}
                trend={streamData.trend}
                onClick={streamData.detailPath ? () => navigate(streamData.detailPath!) : undefined}
              />
            );
          })
        ) : (
          <div className="card border border-dashed border-slate-700 flex items-center justify-center col-span-1 md:col-span-1">
            <p className="text-sm text-theme-faint text-center">Configure revenue streams in Admin Panel</p>
          </div>
        )}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
        {/* Monthly Revenue Trend */}
        <div className="card lg:col-span-2">
          <h3 className="text-sm font-semibold text-theme-heading mb-1">Monthly Revenue Trend</h3>
          <p className="text-xs text-theme-faint mb-6">Clinic vs Pharmacy revenue breakdown</p>
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={trendData} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip
                  formatter={(v: number) => formatINR(v)}
                  contentStyle={{ backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '12px' }}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <Legend />
                <Bar dataKey="clinic" name="Clinic" fill="#3b82f6" radius={[6, 6, 0, 0]} />
                <Bar dataKey="pharmacy" name="Pharmacy" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-theme-faint">
              <div className="text-center">
                <Activity size={32} className="mx-auto mb-2" />
                <p className="text-sm">Import data to see trends</p>
              </div>
            </div>
          )}
        </div>

        {/* Clinic Revenue Split */}
        <div className="card">
          <h3 className="text-sm font-semibold text-theme-heading mb-1">Revenue Split</h3>
          <p className="text-xs text-theme-faint mb-6">By department</p>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={95}
                  dataKey="value"
                  strokeWidth={0}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip
                  formatter={(v: number) => formatINR(v)}
                  contentStyle={{ backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '12px' }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-theme-faint">
              <p className="text-sm">No data</p>
            </div>
          )}
        </div>
      </div>

      {/* Pharmacy Profit Trend */}
      {data.pharmacy.monthly?.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-theme-heading mb-1">Pharmacy Profit Trend</h3>
          <p className="text-xs text-theme-faint mb-6">Sales, COGS & Profit over time</p>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={data.pharmacy.monthly.map((r: any) => ({
              ...r,
              label: getMonthLabel(r.bill_month),
            }))}>
              <defs>
                <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip
                formatter={(v: number) => formatINR(v)}
                contentStyle={{ backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '12px' }}
                labelStyle={{ color: '#94a3b8' }}
              />
              <Legend />
              <Area type="monotone" dataKey="total_sales" name="Sales" stroke="#3b82f6" strokeWidth={2} fill="url(#salesGrad)" />
              <Area type="monotone" dataKey="total_profit" name="Profit" stroke="#10b981" strokeWidth={2} fill="url(#profitGrad)" />
              <Line type="monotone" dataKey="total_purchase_cost" name="COGS" stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="5 5" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
