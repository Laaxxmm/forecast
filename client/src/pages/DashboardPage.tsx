import { useEffect, useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber, getMonthLabel } from '../utils/format';
import { TrendingUp, TrendingDown, Users, IndianRupee, Pill, Stethoscope } from 'lucide-react';

interface OverviewData {
  fy: any;
  clinic: any;
  pharmacy: any;
  combined: any;
}

const COLORS = ['#0d9488', '#06b6d4', '#6366f1', '#f59e0b'];

function KPICard({ title, value, subtitle, icon: Icon, trend }: {
  title: string; value: string; subtitle?: string; icon: any; trend?: number;
}) {
  return (
    <div className="card flex items-start gap-4">
      <div className="p-3 rounded-lg bg-primary-50 text-primary-600">
        <Icon size={24} />
      </div>
      <div>
        <p className="text-sm text-slate-500">{title}</p>
        <p className="text-2xl font-bold text-slate-800 mt-1">{value}</p>
        {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
        {trend !== undefined && (
          <div className={`flex items-center gap-1 mt-1 text-xs ${trend >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
            {trend >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            {trend >= 0 ? '+' : ''}{trend.toFixed(1)}% vs budget
          </div>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/overview').then(res => {
      setData(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-20 text-slate-400">Loading dashboard...</div>;
  if (!data) return <div className="text-center py-20 text-slate-400">No data available</div>;

  const clinicBudgetVar = data.clinic.budget_total > 0
    ? ((data.clinic.total_revenue - data.clinic.budget_total) / data.clinic.budget_total) * 100 : undefined;
  const pharmaBudgetVar = data.pharmacy.budget_total > 0
    ? ((data.pharmacy.total_sales - data.pharmacy.budget_total) / data.pharmacy.budget_total) * 100 : undefined;

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
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800">Actuals</h1>
        <p className="text-slate-500 mt-1">{data.fy?.label || 'All Time'} Overview</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <KPICard
          title="Total Revenue"
          value={formatINR(data.combined.total_revenue)}
          subtitle="Clinic + Pharmacy"
          icon={IndianRupee}
          trend={data.combined.total_budget > 0
            ? ((data.combined.total_revenue - data.combined.total_budget) / data.combined.total_budget) * 100
            : undefined}
        />
        <KPICard
          title="Clinic Revenue"
          value={formatINR(data.clinic.total_revenue || 0)}
          subtitle={`${formatNumber(data.clinic.total_transactions || 0)} transactions`}
          icon={Stethoscope}
          trend={clinicBudgetVar}
        />
        <KPICard
          title="Pharmacy Sales"
          value={formatINR(data.pharmacy.total_sales || 0)}
          subtitle={`${formatNumber(data.pharmacy.total_transactions || 0)} transactions`}
          icon={Pill}
          trend={pharmaBudgetVar}
        />
        <KPICard
          title="Unique Patients"
          value={formatNumber(data.clinic.unique_patients || 0)}
          subtitle="Clinic patients"
          icon={Users}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <div className="card lg:col-span-2">
          <h3 className="text-lg font-semibold text-slate-800 mb-4">Monthly Revenue Trend</h3>
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => formatINR(v)} />
                <Legend />
                <Bar dataKey="clinic" name="Clinic" fill="#0d9488" radius={[4, 4, 0, 0]} />
                <Bar dataKey="pharmacy" name="Pharmacy" fill="#06b6d4" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-slate-400 text-center py-16">Import data to see trends</p>
          )}
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold text-slate-800 mb-4">Clinic Revenue Split</h3>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" outerRadius={100} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => formatINR(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-slate-400 text-center py-16">No data</p>
          )}
        </div>
      </div>

      {data.pharmacy.monthly?.length > 0 && (
        <div className="card">
          <h3 className="text-lg font-semibold text-slate-800 mb-4">Pharmacy Profit Trend</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.pharmacy.monthly.map((r: any) => ({
              ...r,
              label: getMonthLabel(r.bill_month),
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v: number) => formatINR(v)} />
              <Legend />
              <Line type="monotone" dataKey="total_sales" name="Sales" stroke="#0d9488" strokeWidth={2} />
              <Line type="monotone" dataKey="total_purchase_cost" name="COGS" stroke="#f59e0b" strokeWidth={2} />
              <Line type="monotone" dataKey="total_profit" name="Profit" stroke="#10b981" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
