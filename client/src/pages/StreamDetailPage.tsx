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
      <div className="w-8 h-8 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
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

  return (
    <div className="animate-fade-in">
      <button onClick={() => navigate('/actuals')} className="flex items-center gap-2 text-sm text-theme-muted hover:text-accent-400 mb-5 transition-colors">
        <ArrowLeft size={15} /> Back to Dashboard
      </button>

      <div className="mb-8">
        <h1 className="text-2xl font-bold text-theme-heading">{streamName} Details</h1>
        <p className="text-theme-faint mt-1 text-sm">Revenue and cost breakdown</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
        <div className="card border border-accent-500/20">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-xl bg-accent-500/10"><IndianRupee size={20} className="text-accent-400" /></div>
          </div>
          <p className="text-xs text-theme-faint font-medium uppercase">Total Revenue</p>
          <p className="text-2xl font-bold text-theme-heading mt-1">{formatINR(totals.total_revenue || 0)}</p>
        </div>
        <div className="card border border-blue-500/20">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-xl bg-blue-500/10"><BarChart3 size={20} className="text-blue-400" /></div>
          </div>
          <p className="text-xs text-theme-faint font-medium uppercase">Direct Costs</p>
          <p className="text-2xl font-bold text-theme-heading mt-1">{formatINR(totals.total_costs || 0)}</p>
        </div>
        <div className="card border border-emerald-500/20">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10"><TrendingUp size={20} className="text-emerald-400" /></div>
          </div>
          <p className="text-xs text-theme-faint font-medium uppercase">Gross Profit</p>
          <p className="text-2xl font-bold text-theme-heading mt-1">{formatINR(grossProfit)}</p>
        </div>
      </div>

      {/* Monthly Chart */}
      <div className="card">
        <h3 className="text-sm font-semibold text-theme-heading mb-1">Monthly Revenue</h3>
        <p className="text-xs text-theme-faint mb-6">{streamName} revenue over time</p>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip
                formatter={(v: number) => formatINR(v)}
                contentStyle={{ backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '12px' }}
              />
              <Bar dataKey="total" name="Revenue" fill="#10b981" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-[300px] text-theme-faint">
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
