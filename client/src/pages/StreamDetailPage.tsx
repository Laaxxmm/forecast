import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../api/client';
import { formatINR, getMonthLabel } from '../utils/format';
import { ArrowLeft, IndianRupee, TrendingUp, Activity, BarChart3 } from 'lucide-react';

export default function StreamDetailPage() {
  const { streamId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [streamName, setStreamName] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!streamId) return;
    Promise.all([
      api.get(`/actuals/stream/${streamId}/summary`),
      api.get('/streams'),
    ]).then(([summaryRes, streamsRes]) => {
      setData(summaryRes.data);
      const stream = streamsRes.data.find((s: any) => String(s.id) === streamId);
      setStreamName(stream?.name || `Stream ${streamId}`);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [streamId]);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div
        className="w-8 h-8 border-2 rounded-full animate-spin mx-auto"
        style={{ borderColor: 'var(--mt-accent-soft)', borderTopColor: 'var(--mt-accent)' }}
      />
    </div>
  );

  const totals = data?.totals || {};
  const monthly = data?.monthly || [];

  // Aggregate monthly revenue for chart
  const monthlyRevenue: Record<string, number> = {};
  for (const entry of monthly) {
    if (entry.category === 'revenue') {
      monthlyRevenue[entry.month] = (monthlyRevenue[entry.month] || 0) + entry.total;
    }
  }
  const chartData = Object.entries(monthlyRevenue)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, total]) => ({ month, label: getMonthLabel(month), total }));

  const grossProfit = (totals.total_revenue || 0) - (totals.total_costs || 0);

  const kpiTones = {
    accent: { fg: '#10b981', soft: 'color-mix(in srgb, #10b981 12%, transparent)', border: 'color-mix(in srgb, #10b981 30%, transparent)' },
    blue:   { fg: '#3b82f6', soft: 'color-mix(in srgb, #3b82f6 12%, transparent)', border: 'color-mix(in srgb, #3b82f6 30%, transparent)' },
    emerald:{ fg: '#059669', soft: 'color-mix(in srgb, #059669 12%, transparent)', border: 'color-mix(in srgb, #059669 30%, transparent)' },
  };

  const renderKpi = (tone: { fg: string; soft: string; border: string }, Icon: any, label: string, value: string) => (
    <div className="mt-kpi" style={{ border: `1px solid ${tone.border}` }}>
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: tone.soft, boxShadow: `inset 0 0 0 1px ${tone.border}` }}
        >
          <Icon size={18} style={{ color: tone.fg }} />
        </div>
      </div>
      <p className="mt-kpi__label">{label}</p>
      <p className="mt-kpi__value mt-num">{value}</p>
    </div>
  );

  return (
    <div className="animate-fade-in">
      <button
        onClick={() => navigate('/actuals')}
        className="flex items-center gap-2 text-sm mb-5 transition-colors"
        style={{ color: 'var(--mt-text-muted)' }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-accent-text)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-muted)'; }}
      >
        <ArrowLeft size={15} /> Back to Dashboard
      </button>

      <div className="mb-8">
        <h1 className="mt-heading text-2xl">{streamName} Details</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--mt-text-faint)' }}>Revenue and cost breakdown</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
        {renderKpi(kpiTones.accent, IndianRupee, 'Total Revenue', formatINR(totals.total_revenue || 0))}
        {renderKpi(kpiTones.blue, BarChart3, 'Direct Costs', formatINR(totals.total_costs || 0))}
        {renderKpi(kpiTones.emerald, TrendingUp, 'Gross Profit', formatINR(grossProfit))}
      </div>

      {/* Monthly Chart */}
      <div className="mt-card p-5">
        <h3 className="mt-heading text-sm mb-1">Monthly Revenue</h3>
        <p className="text-xs mb-6" style={{ color: 'var(--mt-text-faint)' }}>{streamName} revenue over time</p>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--mt-border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: 'var(--mt-text-faint)' }} axisLine={false} tickLine={false} />
              <Tooltip
                formatter={(v: number) => formatINR(v)}
                contentStyle={{ backgroundColor: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)', borderRadius: '12px' }}
              />
              <Bar dataKey="total" name="Revenue" fill="#10b981" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[300px]" style={{ color: 'var(--mt-text-faint)' }}>
            <div className="text-center">
              <Activity size={32} className="mx-auto mb-2" />
              <p className="text-sm">No data imported yet</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
