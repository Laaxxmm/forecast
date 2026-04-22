import { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import api from '../api/client';
import { formatINR, getMonthLabel } from '../utils/format';
import ClinicAnalytics from '../components/dashboard/ClinicAnalytics';
import PharmacyAnalytics from '../components/dashboard/PharmacyAnalytics';
import { buildPeriodOptions } from '../components/dashboard/dashboardUtils';
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
  const iconTone: Record<string, { bg: string; fg: string; ring: string }> = {
    accent: {
      bg: 'color-mix(in srgb, #10b981 14%, transparent)',
      fg: '#10b981',
      ring: 'color-mix(in srgb, #10b981 30%, transparent)',
    },
    blue: {
      bg: 'color-mix(in srgb, #3b82f6 14%, transparent)',
      fg: '#3b82f6',
      ring: 'color-mix(in srgb, #3b82f6 30%, transparent)',
    },
    purple: {
      bg: 'color-mix(in srgb, #8b5cf6 14%, transparent)',
      fg: '#8b5cf6',
      ring: 'color-mix(in srgb, #8b5cf6 30%, transparent)',
    },
    amber: {
      bg: 'color-mix(in srgb, #f59e0b 14%, transparent)',
      fg: '#f59e0b',
      ring: 'color-mix(in srgb, #f59e0b 30%, transparent)',
    },
  };
  const tone = iconTone[color] || iconTone.accent;
  const trendPositive = trend !== undefined && trend >= 0;

  return (
    <div
      className={`mt-kpi group ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between mb-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-200 group-hover:scale-[1.04]"
          style={{
            background: tone.bg,
            boxShadow: `inset 0 0 0 1px ${tone.ring}`,
          }}
        >
          <Icon size={18} style={{ color: tone.fg }} />
        </div>
        {trend !== undefined && (
          <span
            className={`mt-pill ${trendPositive ? 'mt-pill--success' : 'mt-pill--danger'}`}
          >
            {trendPositive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {trendPositive ? '+' : ''}{trend.toFixed(1)}%
          </span>
        )}
      </div>
      <p className="mt-kpi__label">{title}</p>
      <p className="mt-kpi__value">{value}</p>
      {subtitle && <p className="mt-kpi__sub">{subtitle}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState('current_month');

  // Active stream filter (set by sidebar or KPI card click)
  const activeStreamId = localStorage.getItem('stream_id');
  const activeStreamName = localStorage.getItem('stream_name');

  const selectStream = (id: string | null, name: string) => {
    if (id) {
      localStorage.setItem('stream_id', id);
      localStorage.setItem('stream_name', name);
    } else {
      localStorage.removeItem('stream_id');
      localStorage.removeItem('stream_name');
    }
    window.location.reload();
  };

  // Period filter
  const periodOptions = useMemo(() => {
    if (!data?.fy?.start_date) return [];
    return buildPeriodOptions(data.fy.start_date);
  }, [data?.fy?.start_date]);

  const currentPeriod = useMemo(() => {
    return periodOptions.find(p => p.value === selectedPeriod) || null;
  }, [periodOptions, selectedPeriod]);

  const periodStartMonth = currentPeriod?.months?.[0] || null;
  const periodEndMonth = currentPeriod?.months?.[currentPeriod.months.length - 1] || null;

  useEffect(() => {
    const params: Record<string, string> = {};
    if (periodStartMonth) params.startMonth = periodStartMonth;
    if (periodEndMonth) params.endMonth = periodEndMonth;

    setLoading(true);
    api.get('/dashboard/overview', { params }).then(res => {
      setData(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [periodStartMonth, periodEndMonth]);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center">
        <div
          className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-3"
          style={{
            borderColor: 'var(--mt-accent-soft)',
            borderTopColor: 'var(--mt-accent)',
          }}
        />
        <span className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>Loading dashboard...</span>
      </div>
    </div>
  );

  if (!data) return (
    <div className="text-center py-20">
      <Activity size={40} className="mx-auto mb-3" style={{ color: 'var(--mt-text-faint)' }} />
      <span style={{ color: 'var(--mt-text-faint)' }}>No data available</span>
    </div>
  );

  const streams: any[] = data.streams || [];

  // Stream mode detection
  const isAllStreams = !activeStreamId;
  const isClinicStream = !isAllStreams && streams.some((s: any) =>
    String(s.id) === activeStreamId &&
    ((s.name || '').toLowerCase().includes('clinic') || (s.name || '').toLowerCase().includes('health'))
  );
  const isPharmaStream = !isAllStreams && streams.some((s: any) =>
    String(s.id) === activeStreamId &&
    (s.name || '').toLowerCase().includes('pharma')
  );
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
    return entry ? !!entry.is_visible : true;
  };

  // Pharmacy stream visibility helper
  const pharmaStream = streams.find((s: any) => {
    const n = (s.name || '').toLowerCase();
    return n.includes('pharma');
  });
  const pharmaStreamId = pharmaStream ? String(pharmaStream.id) : null;
  const isPharmaVisible = (key: string) => {
    if (!pharmaStreamId) return false;
    const entry = chartVis.find((v: any) => v.element_key === key && v.scope === pharmaStreamId);
    return entry ? !!entry.is_visible : true; // default visible for pharmacy
  };

  // Filter streams for charts when a specific stream is selected
  const chartStreams = activeStreamId
    ? streams.filter((s: any) => String(s.id) === activeStreamId)
    : streams;

  // Build monthly trend data from stream monthly breakdowns
  const monthlyMap: Record<string, any> = {};
  for (const stream of chartStreams) {
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
  const pieData = chartStreams
    .filter(s => s.total_revenue > 0)
    .map(s => ({ name: s.name, value: s.total_revenue }));

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="mt-heading text-2xl">Actuals</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--mt-text-faint)' }}>
            {activeStreamName
              ? `${activeStreamName} \u2014 ${currentPeriod?.label || data.fy?.label || 'All Time'}`
              : `${currentPeriod?.label || data.fy?.label || 'All Time'} Overview`}
          </p>
        </div>
        {periodOptions.length > 0 && (
          <select
            data-tour="period-filter"
            value={selectedPeriod}
            onChange={e => setSelectedPeriod(e.target.value)}
            className="mt-input"
            style={{ width: '16rem', padding: '8px 12px' }}
          >
            {periodOptions.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        )}
      </div>

      {/* KPI Cards — only in "All" mode */}
      {isAllStreams && (
        <div data-tour="kpi-cards" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {data.cards && data.cards.length > 0 ? (
            data.cards.map((card: any) => {
              const CardIcon = ICON_MAP[card.icon] || BarChart3;
              return (
                <KPICard
                  key={card.id}
                  title={card.title}
                  value={formatINR(card.value)}
                  subtitle={card.subtitle === 'No data yet' ? card.subtitle :
                    card.budget > 0 ? `vs ${formatINR(card.budget)} forecast` :
                    card.subtitle || undefined}
                  icon={CardIcon}
                  color={card.color || 'accent'}
                  trend={card.trend}
                  onClick={card.card_type === 'total'
                    ? undefined
                    : card.stream_id
                      ? () => selectStream(String(card.stream_id), card.title.replace(' Revenue', '') || card.title)
                      : undefined}
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
                    subtitle={stream.total_revenue > 0 ? `vs ${formatINR(stream.budget_total)} forecast` : 'No data yet'}
                    icon={StreamIcon}
                    color={stream.color || 'blue'}
                    trend={trend}
                    onClick={() => selectStream(String(stream.id), stream.name)}
                  />
                );
              })}
              {streams.length === 0 && (
                <div
                  className="flex items-center justify-center p-6 rounded-2xl"
                  style={{
                    border: '1px dashed var(--mt-border)',
                    background: 'var(--mt-bg-muted)',
                  }}
                >
                  <p className="text-sm text-center" style={{ color: 'var(--mt-text-faint)' }}>
                    Configure revenue streams in Admin Panel
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Charts Row — hidden when clinic/pharmacy stream is active */}
      {!isClinicStream && !isPharmaStream && (showTrend || showPie) && (
        <div className={`grid grid-cols-1 ${showTrend && showPie ? 'lg:grid-cols-3' : ''} gap-5 mb-6`}>
          {showTrend && (
            <div className={`mt-card p-5 ${showPie ? 'lg:col-span-2' : ''}`}>
              <h3 className="mt-heading text-sm mb-1">Monthly Revenue Trend</h3>
              <p className="text-xs mb-6" style={{ color: 'var(--mt-text-faint)' }}>
                Revenue breakdown by stream
              </p>
              {trendData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={trendData} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--mt-border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }} axisLine={false} tickLine={false} />
                    <Tooltip
                      formatter={(v: number) => formatINR(v)}
                      contentStyle={{
                        backgroundColor: 'var(--mt-bg-raised)',
                        border: '1px solid var(--mt-border)',
                        borderRadius: '12px',
                        color: 'var(--mt-text-primary)',
                      }}
                      labelStyle={{ color: 'var(--mt-text-muted)' }}
                    />
                    <Legend wrapperStyle={{ color: 'var(--mt-text-muted)', fontSize: 12 }} />
                    {chartStreams.map((stream: any, i: number) => {
                      const key = stream.name.toLowerCase().replace(/\s+/g, '_');
                      return (
                        <Bar key={stream.id} dataKey={key} name={stream.name} fill={BAR_COLORS[i % BAR_COLORS.length]} radius={[6, 6, 0, 0]} />
                      );
                    })}
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[300px]" style={{ color: 'var(--mt-text-faint)' }}>
                  <div className="text-center">
                    <Activity size={32} className="mx-auto mb-2" />
                    <p className="text-sm">Import data to see trends</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {showPie && (
            <div className="mt-card p-5">
              <h3 className="mt-heading text-sm mb-1">Revenue Split</h3>
              <p className="text-xs mb-6" style={{ color: 'var(--mt-text-faint)' }}>By stream</p>
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
                      contentStyle={{
                        backgroundColor: 'var(--mt-bg-raised)',
                        border: '1px solid var(--mt-border)',
                        borderRadius: '12px',
                        color: 'var(--mt-text-primary)',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[300px]" style={{ color: 'var(--mt-text-faint)' }}>
                  <p className="text-sm">No data</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Clinic Analytics — only when clinic stream is active */}
      {isClinicStream && clinicStreamId && <ClinicAnalytics isVisible={isClinicVisible} startMonth={periodStartMonth} endMonth={periodEndMonth} />}

      {/* Pharmacy Analytics — only when pharmacy stream is active */}
      {isPharmaStream && pharmaStreamId && <PharmacyAnalytics isVisible={isPharmaVisible} startMonth={periodStartMonth} endMonth={periodEndMonth} />}
    </div>
  );
}
