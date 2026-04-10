import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber, getMonthLabel } from '../utils/format';
import ClinicAnalytics from '../components/dashboard/ClinicAnalytics';
import {
  TrendingUp, TrendingDown, IndianRupee, Activity,
  BarChart3, Briefcase, RefreshCcw, GraduationCap, Store, Globe, Warehouse,
  UtensilsCrossed, Truck, ChefHat, ShoppingBag, FlaskConical, Stethoscope, Pill, Users
} from 'lucide-react';

const ICON_MAP: Record<string, any> = {
  Stethoscope, Pill, BarChart3, Briefcase, RefreshCcw, GraduationCap,
  Store, Globe, Warehouse, UtensilsCrossed, Truck, ChefHat, ShoppingBag,
  FlaskConical, TrendingUp, Users, IndianRupee, Activity,
};

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899'];
const BAR_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#10b981'];

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

export default function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/overview').then(res => {
      setData(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
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

  const streams: any[] = data.streams || [];

  // Chart visibility helper
  const chartVis = data.chartVisibility || [];
  const isChartVisible = (key: string) => {
    const entry = chartVis.find((v: any) => v.element_key === key && v.scope === 'total');
    return entry ? !!entry.is_visible : true; // default visible if no config
  };
  const showTrend = isChartVisible('monthly_revenue_trend');
  const showPie = isChartVisible('revenue_split');

  // Clinic stream visibility helper
  const clinicStream = streams.find((s: any) => {
    const n = (s.name || '').toLowerCase();
    return n.includes('clinic') || n.includes('health');
  });
  const clinicStreamId = clinicStream ? String(clinicStream.id) : null;
  const isClinicVisible = (key: string) => {
    if (!clinicStreamId) return false;
    const entry = chartVis.find((v: any) => v.element_key === key && v.scope === clinicStreamId);
    return entry ? !!entry.is_visible : false;
  };

  // Build monthly trend data from stream monthly breakdowns
  const monthlyMap: Record<string, any> = {};
  for (const stream of streams) {
    for (const entry of (stream.monthly || [])) {
      if (entry.category !== 'revenue') continue;
      if (!monthlyMap[entry.month]) monthlyMap[entry.month] = { month: entry.month };
      const key = stream.name.toLowerCase().replace(/\s+/g, '_');
      monthlyMap[entry.month][key] = (monthlyMap[entry.month][key] || 0) + entry.total;
    }
  }
  const trendData = Object.values(monthlyMap)
    .sort((a: any, b: any) => a.month.localeCompare(b.month))
    .map((d: any) => ({ ...d, label: getMonthLabel(d.month) }));

  // Pie data — revenue per stream
  const pieData = streams
    .filter(s => s.total_revenue > 0)
    .map(s => ({ name: s.name, value: s.total_revenue }));

  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-theme-heading">Actuals</h1>
        <p className="text-theme-faint mt-1 text-sm">{data.fy?.label || 'All Time'} Overview</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {data.cards && data.cards.length > 0 ? (
          data.cards.map((card: any) => {
            const CardIcon = ICON_MAP[card.icon] || BarChart3;
            return (
              <KPICard
                key={card.id}
                title={card.title}
                value={formatINR(card.value)}
                subtitle={card.subtitle === 'No data yet' ? card.subtitle :
                  card.budget > 0 ? `vs ${formatINR(card.budget)} budget` :
                  card.subtitle || undefined}
                icon={CardIcon}
                color={card.color || 'accent'}
                trend={card.trend}
                onClick={card.stream_id ? () => navigate(`/stream/${card.stream_id}`) : undefined}
              />
            );
          })
        ) : (
          <>
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
            {streams.map((stream: any) => {
              const StreamIcon = ICON_MAP[stream.icon] || BarChart3;
              const trend = stream.budget_total > 0
                ? ((stream.total_revenue - stream.budget_total) / stream.budget_total) * 100
                : undefined;
              return (
                <KPICard
                  key={stream.id}
                  title={`${stream.name} Revenue`}
                  value={formatINR(stream.total_revenue)}
                  subtitle={stream.total_revenue > 0 ? `vs ${formatINR(stream.budget_total)} budget` : 'No data yet'}
                  icon={StreamIcon}
                  color={stream.color || 'blue'}
                  trend={trend}
                  onClick={() => navigate(`/stream/${stream.id}`)}
                />
              );
            })}
            {streams.length === 0 && (
              <div className="card border border-dashed border-slate-700 flex items-center justify-center">
                <p className="text-sm text-theme-faint text-center">Configure revenue streams in Admin Panel</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Charts Row */}
      {(showTrend || showPie) && (
        <div className={`grid grid-cols-1 ${showTrend && showPie ? 'lg:grid-cols-3' : ''} gap-5 mb-6`}>
          {showTrend && (
            <div className={`card ${showPie ? 'lg:col-span-2' : ''}`}>
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Monthly Revenue Trend</h3>
              <p className="text-xs text-theme-faint mb-6">Revenue breakdown by stream</p>
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
                    {streams.map((stream: any, i: number) => {
                      const key = stream.name.toLowerCase().replace(/\s+/g, '_');
                      return (
                        <Bar key={stream.id} dataKey={key} name={stream.name} fill={BAR_COLORS[i % BAR_COLORS.length]} radius={[6, 6, 0, 0]} />
                      );
                    })}
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
          )}

          {showPie && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Revenue Split</h3>
              <p className="text-xs text-theme-faint mb-6">By stream</p>
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
          )}
        </div>
      )}

      {/* Clinic Analytics */}
      {clinicStreamId && <ClinicAnalytics isVisible={isClinicVisible} />}
    </div>
  );
}
