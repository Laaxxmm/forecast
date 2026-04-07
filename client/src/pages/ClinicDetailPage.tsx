import { useEffect, useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber, getMonthLabel, ragColor } from '../utils/format';

export default function ClinicDetailPage() {
  const [fys, setFYs] = useState<any[]>([]);
  const [selectedFY, setSelectedFY] = useState<number | null>(null);
  const [actuals, setActuals] = useState<any[]>([]);
  const [doctors, setDoctors] = useState<any[]>([]);
  const [variance, setVariance] = useState<any[]>([]);
  const [selectedStream, setSelectedStream] = useState('all');

  useEffect(() => {
    api.get('/settings/fy').then(res => {
      setFYs(res.data);
      const active = res.data.find((f: any) => f.is_active);
      if (active) setSelectedFY(active.id);
    });
  }, []);

  useEffect(() => {
    if (!selectedFY) return;
    Promise.all([
      api.get('/actuals/clinic', { params: { fy_id: selectedFY } }),
      api.get('/actuals/clinic/doctors', { params: { fy_id: selectedFY } }),
      api.get('/dashboard/variance', { params: { fy_id: selectedFY, business_unit: 'CLINIC' } }),
    ]).then(([actRes, docRes, varRes]) => {
      setActuals(actRes.data); setDoctors(docRes.data); setVariance(varRes.data);
    });
  }, [selectedFY]);

  const monthlyMap: Record<string, any> = {};
  actuals.forEach(r => {
    if (!monthlyMap[r.bill_month]) monthlyMap[r.bill_month] = { month: r.bill_month, label: getMonthLabel(r.bill_month), total: 0, footfall: 0 };
    monthlyMap[r.bill_month][r.department] = r.total_revenue;
    monthlyMap[r.bill_month][`${r.department}_count`] = r.transaction_count;
    monthlyMap[r.bill_month].total += r.total_revenue;
    monthlyMap[r.bill_month].footfall += r.transaction_count;
  });
  const monthlyData = Object.values(monthlyMap).sort((a: any, b: any) => a.month.localeCompare(b.month));

  const doctorMap: Record<string, { name: string; revenue: number; count: number }> = {};
  doctors.forEach(d => {
    if (!doctorMap[d.billed_doctor]) doctorMap[d.billed_doctor] = { name: d.billed_doctor, revenue: 0, count: 0 };
    doctorMap[d.billed_doctor].revenue += d.total_revenue;
    doctorMap[d.billed_doctor].count += d.transaction_count;
  });
  const doctorList = Object.values(doctorMap).sort((a, b) => b.revenue - a.revenue);

  const revenueVariance = variance.filter(v => v.metric === 'revenue');
  const streamNames = useMemo(() => {
    return [...new Set(revenueVariance.map(v => v.item_name || v.dept_name || 'Other'))];
  }, [revenueVariance]);

  const bvaChartData = useMemo(() => {
    const filtered = selectedStream === 'all' ? revenueVariance : revenueVariance.filter(v => (v.item_name || v.dept_name || 'Other') === selectedStream);
    const monthMap: Record<string, { month: string; label: string; budget: number; actual: number }> = {};
    filtered.forEach(v => {
      if (!monthMap[v.month]) monthMap[v.month] = { month: v.month, label: getMonthLabel(v.month), budget: 0, actual: 0 };
      monthMap[v.month].budget += v.amount || 0;
      monthMap[v.month].actual += v.actual_amount || 0;
    });
    return Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));
  }, [revenueVariance, selectedStream]);

  const bvaSummary = useMemo(() => {
    const totalBudget = bvaChartData.reduce((s, d) => s + d.budget, 0);
    const totalActual = bvaChartData.reduce((s, d) => s + d.actual, 0);
    const varianceAmt = totalActual - totalBudget;
    const variancePct = totalBudget > 0 ? (varianceAmt / totalBudget) * 100 : 0;
    return { totalBudget, totalActual, varianceAmt, variancePct };
  }, [bvaChartData]);

  const chartTooltipStyle = { backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '12px' };

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Clinic Details</h1>
          <p className="text-slate-500 mt-1 text-sm">Department-wise performance & doctor analytics</p>
        </div>
        <select value={selectedFY || ''} onChange={e => setSelectedFY(Number(e.target.value))} className="input w-48">
          {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
        </select>
      </div>

      {/* Revenue Chart */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-white mb-1">Monthly Revenue by Department</h3>
        <p className="text-xs text-slate-500 mb-6">Stacked breakdown across departments</p>
        {monthlyData.length > 0 ? (
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={chartTooltipStyle} />
              <Legend />
              <Bar dataKey="APPOINTMENT" name="Appointments" fill="#10b981" stackId="a" radius={[0, 0, 0, 0]} />
              <Bar dataKey="LAB TEST" name="Lab Tests" fill="#3b82f6" stackId="a" radius={[0, 0, 0, 0]} />
              <Bar dataKey="OTHER SERVICES" name="Other Services" fill="#8b5cf6" stackId="a" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-slate-600 text-center py-16 text-sm">Import Healthplix data to see clinic details</p>
        )}
      </div>

      {/* Budget vs Actual */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-white mb-1">Budget vs Actual</h3>
            <p className="text-xs text-slate-500">Performance against forecast</p>
          </div>
          {streamNames.length > 0 && (
            <select value={selectedStream} onChange={e => setSelectedStream(e.target.value)} className="input w-56 text-sm">
              <option value="all">All Streams</option>
              {streamNames.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
        </div>

        {bvaChartData.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-dark-600 rounded-xl p-3.5 text-center">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Budget</p>
                <p className="text-lg font-bold text-slate-200">{formatINR(bvaSummary.totalBudget)}</p>
              </div>
              <div className="bg-dark-600 rounded-xl p-3.5 text-center">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Actual</p>
                <p className="text-lg font-bold text-accent-400">{formatINR(bvaSummary.totalActual)}</p>
              </div>
              <div className={`rounded-xl p-3.5 text-center ${
                bvaSummary.variancePct >= -5 ? 'bg-emerald-500/10' : bvaSummary.variancePct >= -15 ? 'bg-amber-500/10' : 'bg-red-500/10'
              }`}>
                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Variance</p>
                <p className={`text-lg font-bold ${
                  bvaSummary.variancePct >= -5 ? 'text-emerald-400' : bvaSummary.variancePct >= -15 ? 'text-amber-400' : 'text-red-400'
                }`}>{bvaSummary.variancePct.toFixed(1)}%</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={bvaChartData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={chartTooltipStyle} />
                <Legend />
                <Bar dataKey="budget" name="Budget" fill="#475569" radius={[6, 6, 0, 0]} />
                <Bar dataKey="actual" name="Actual" fill="#10b981" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </>
        ) : (
          <p className="text-slate-600 text-center py-16 text-sm">Set a budget in Forecast to see comparison</p>
        )}
      </div>

      {/* Doctor Performance */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-1">Doctor Performance</h3>
        <p className="text-xs text-slate-500 mb-4">Revenue and transactions by doctor</p>
        {doctorList.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-400/50">
                  <th className="text-left py-3 px-2 text-slate-500 font-medium text-xs uppercase tracking-wider">Doctor</th>
                  <th className="text-right py-3 px-2 text-slate-500 font-medium text-xs uppercase tracking-wider">Revenue</th>
                  <th className="text-right py-3 px-2 text-slate-500 font-medium text-xs uppercase tracking-wider">Transactions</th>
                  <th className="text-right py-3 px-2 text-slate-500 font-medium text-xs uppercase tracking-wider">Avg/Txn</th>
                </tr>
              </thead>
              <tbody>
                {doctorList.map(d => (
                  <tr key={d.name} className="border-b border-dark-400/30 hover:bg-dark-600/50 transition-colors">
                    <td className="py-3 px-2 font-medium text-slate-200">{d.name}</td>
                    <td className="py-3 px-2 text-right text-slate-300">{formatINR(d.revenue)}</td>
                    <td className="py-3 px-2 text-right text-slate-400">{formatNumber(d.count)}</td>
                    <td className="py-3 px-2 text-right text-accent-400">{formatINR(Math.round(d.revenue / d.count))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-slate-600 text-center py-8 text-sm">No doctor data</p>
        )}
      </div>
    </div>
  );
}
