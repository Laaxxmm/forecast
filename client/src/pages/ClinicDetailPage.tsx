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
      setActuals(actRes.data);
      setDoctors(docRes.data);
      setVariance(varRes.data);
    });
  }, [selectedFY]);

  // Build monthly data for department chart
  const monthlyMap: Record<string, any> = {};
  actuals.forEach(r => {
    if (!monthlyMap[r.bill_month]) monthlyMap[r.bill_month] = { month: r.bill_month, label: getMonthLabel(r.bill_month), total: 0, footfall: 0 };
    monthlyMap[r.bill_month][r.department] = r.total_revenue;
    monthlyMap[r.bill_month][`${r.department}_count`] = r.transaction_count;
    monthlyMap[r.bill_month].total += r.total_revenue;
    monthlyMap[r.bill_month].footfall += r.transaction_count;
  });
  const monthlyData = Object.values(monthlyMap).sort((a: any, b: any) => a.month.localeCompare(b.month));

  // Aggregate doctors
  const doctorMap: Record<string, { name: string; revenue: number; count: number }> = {};
  doctors.forEach(d => {
    if (!doctorMap[d.billed_doctor]) doctorMap[d.billed_doctor] = { name: d.billed_doctor, revenue: 0, count: 0 };
    doctorMap[d.billed_doctor].revenue += d.total_revenue;
    doctorMap[d.billed_doctor].count += d.transaction_count;
  });
  const doctorList = Object.values(doctorMap).sort((a, b) => b.revenue - a.revenue);

  // Get unique revenue stream names from variance data
  const revenueVariance = variance.filter(v => v.metric === 'revenue');
  const streamNames = useMemo(() => {
    const names = [...new Set(revenueVariance.map(v => v.item_name || v.dept_name || 'Other'))];
    return names;
  }, [revenueVariance]);

  // Build chart data for Budget vs Actual
  const bvaChartData = useMemo(() => {
    const filtered = selectedStream === 'all'
      ? revenueVariance
      : revenueVariance.filter(v => (v.item_name || v.dept_name || 'Other') === selectedStream);

    // Group by month, summing budget and actual
    const monthMap: Record<string, { month: string; label: string; budget: number; actual: number }> = {};
    filtered.forEach(v => {
      if (!monthMap[v.month]) {
        monthMap[v.month] = { month: v.month, label: getMonthLabel(v.month), budget: 0, actual: 0 };
      }
      monthMap[v.month].budget += v.amount || 0;
      monthMap[v.month].actual += v.actual_amount || 0;
    });

    return Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));
  }, [revenueVariance, selectedStream]);

  // Calculate summary stats for selected stream
  const bvaSummary = useMemo(() => {
    const totalBudget = bvaChartData.reduce((s, d) => s + d.budget, 0);
    const totalActual = bvaChartData.reduce((s, d) => s + d.actual, 0);
    const varianceAmt = totalActual - totalBudget;
    const variancePct = totalBudget > 0 ? (varianceAmt / totalBudget) * 100 : 0;
    return { totalBudget, totalActual, varianceAmt, variancePct };
  }, [bvaChartData]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Clinic Details</h1>
          <p className="text-slate-500 mt-1">Department-wise performance & doctor analytics</p>
        </div>
        <select value={selectedFY || ''} onChange={e => setSelectedFY(Number(e.target.value))} className="input w-48">
          {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
        </select>
      </div>

      {/* Revenue Chart */}
      <div className="card mb-6">
        <h3 className="font-semibold text-slate-800 mb-4">Monthly Revenue by Department</h3>
        {monthlyData.length > 0 ? (
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v: number) => formatINR(v)} />
              <Legend />
              <Bar dataKey="APPOINTMENT" name="Appointments" fill="#0d9488" stackId="a" />
              <Bar dataKey="LAB TEST" name="Lab Tests" fill="#06b6d4" stackId="a" />
              <Bar dataKey="OTHER SERVICES" name="Other Services" fill="#6366f1" stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-slate-400 text-center py-16">Import Healthplix data to see clinic details</p>
        )}
      </div>

      {/* Budget vs Actual Chart */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-slate-800">Budget vs Actual</h3>
          {streamNames.length > 0 && (
            <select
              value={selectedStream}
              onChange={e => setSelectedStream(e.target.value)}
              className="input w-56 text-sm"
            >
              <option value="all">All Streams</option>
              {streamNames.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
        </div>

        {bvaChartData.length > 0 ? (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-slate-50 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500 mb-1">Budget</p>
                <p className="text-lg font-bold text-slate-700">{formatINR(bvaSummary.totalBudget)}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3 text-center">
                <p className="text-xs text-slate-500 mb-1">Actual</p>
                <p className="text-lg font-bold text-emerald-600">{formatINR(bvaSummary.totalActual)}</p>
              </div>
              <div className={`rounded-lg p-3 text-center ${bvaSummary.variancePct >= -5 ? 'bg-emerald-50' : bvaSummary.variancePct >= -15 ? 'bg-amber-50' : 'bg-red-50'}`}>
                <p className="text-xs text-slate-500 mb-1">Variance</p>
                <p className={`text-lg font-bold ${bvaSummary.variancePct >= -5 ? 'text-emerald-600' : bvaSummary.variancePct >= -15 ? 'text-amber-600' : 'text-red-600'}`}>
                  {bvaSummary.variancePct.toFixed(1)}%
                </p>
              </div>
            </div>

            {/* Chart */}
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={bvaChartData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => formatINR(v)} />
                <Legend />
                <Bar dataKey="budget" name="Budget" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="actual" name="Actual" fill="#0d9488" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </>
        ) : (
          <p className="text-slate-400 text-center py-16">Set a budget in Forecast to see comparison</p>
        )}
      </div>

      {/* Doctor Performance */}
      <div className="card mb-6">
        <h3 className="font-semibold text-slate-800 mb-4">Doctor Performance</h3>
        {doctorList.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-2 px-2">Doctor</th>
                <th className="text-right py-2 px-2">Revenue</th>
                <th className="text-right py-2 px-2">Transactions</th>
                <th className="text-right py-2 px-2">Avg/Txn</th>
              </tr>
            </thead>
            <tbody>
              {doctorList.map(d => (
                <tr key={d.name} className="border-b border-slate-100">
                  <td className="py-2 px-2 font-medium">{d.name}</td>
                  <td className="py-2 px-2 text-right">{formatINR(d.revenue)}</td>
                  <td className="py-2 px-2 text-right">{formatNumber(d.count)}</td>
                  <td className="py-2 px-2 text-right">{formatINR(Math.round(d.revenue / d.count))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-slate-400 text-center py-8">No doctor data</p>
        )}
      </div>
    </div>
  );
}
