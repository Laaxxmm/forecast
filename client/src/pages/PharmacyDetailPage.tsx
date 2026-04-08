import { useEffect, useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber, getMonthLabel, ragColor } from '../utils/format';

export default function PharmacyDetailPage() {
  const [fys, setFYs] = useState<any[]>([]);
  const [selectedFY, setSelectedFY] = useState<number | null>(null);
  const [sales, setSales] = useState<any[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [variance, setVariance] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/settings/fy').then(res => {
      setFYs(res.data);
      const active = res.data.find((f: any) => f.is_active);
      if (active) setSelectedFY(active.id);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedFY) return;
    Promise.all([
      api.get('/actuals/pharmacy', { params: { fy_id: selectedFY } }),
      api.get('/actuals/pharmacy/purchases', { params: { fy_id: selectedFY } }),
      api.get('/dashboard/variance', { params: { fy_id: selectedFY, business_unit: 'PHARMACY' } }),
    ]).then(([salesRes, purchRes, varRes]) => {
      setSales(salesRes.data); setPurchases(purchRes.data); setVariance(varRes.data);
    });
  }, [selectedFY]);

  const chartData = sales.map(s => ({
    label: getMonthLabel(s.bill_month),
    sales: s.total_sales,
    cogs: s.total_purchase_cost,
    profit: s.total_profit,
    margin: s.profit_margin_pct,
  }));

  const totalSales = sales.reduce((s, r) => s + r.total_sales, 0);
  const totalCOGS = sales.reduce((s, r) => s + r.total_purchase_cost, 0);
  const totalProfit = sales.reduce((s, r) => s + r.total_profit, 0);
  const avgMargin = totalSales > 0 ? (totalProfit / totalSales * 100) : 0;
  const totalQty = sales.reduce((s, r) => s + r.total_qty, 0);
  const totalTxns = sales.reduce((s, r) => s + r.transactions, 0);

  const chartTooltipStyle = { backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '12px' };

  const summaryCards = [
    { label: 'Total Sales', value: formatINR(totalSales), color: 'text-accent-400' },
    { label: 'Total COGS', value: formatINR(totalCOGS), color: 'text-amber-400' },
    { label: 'Gross Profit', value: formatINR(totalProfit), color: 'text-emerald-400' },
    { label: 'Avg Margin', value: `${avgMargin.toFixed(1)}%`, color: 'text-blue-400' },
    { label: 'Units Sold', value: formatNumber(totalQty), color: 'text-purple-400' },
    { label: 'Transactions', value: formatNumber(totalTxns), color: 'text-pink-400' },
  ];

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="text-theme-muted">Loading...</div>
    </div>
  );

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-theme-heading">Pharmacy Details</h1>
          <p className="text-theme-faint mt-1 text-sm">Sales, purchases, and profitability analysis</p>
        </div>
        <select value={selectedFY || ''} onChange={e => setSelectedFY(Number(e.target.value))} className="input w-48">
          {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
        </select>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        {summaryCards.map(item => (
          <div key={item.label} className="card p-4">
            <p className="text-[10px] text-theme-faint uppercase tracking-wider mb-1">{item.label}</p>
            <p className={`text-lg font-bold ${item.color}`}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* Sales vs COGS Chart */}
      <div className="card mb-6">
        <h3 className="text-sm font-semibold text-theme-heading mb-1">Monthly Sales, COGS & Profit</h3>
        <p className="text-xs text-theme-faint mb-6">Revenue breakdown with profitability</p>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={chartTooltipStyle} />
              <Legend />
              <Bar dataKey="sales" name="Sales" fill="#10b981" radius={[6, 6, 0, 0]} />
              <Bar dataKey="cogs" name="COGS" fill="#f59e0b" radius={[6, 6, 0, 0]} />
              <Bar dataKey="profit" name="Profit" fill="#3b82f6" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-theme-faint text-center py-16 text-sm">Import Oneglance sales data to see pharmacy details</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Margin Trend */}
        <div className="card">
          <h3 className="text-sm font-semibold text-theme-heading mb-1">Profit Margin Trend</h3>
          <p className="text-xs text-theme-faint mb-6">Monthly margin percentage</p>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="marginGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 25]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} contentStyle={chartTooltipStyle} />
                <Area type="monotone" dataKey="margin" name="Margin %" stroke="#10b981" strokeWidth={2} fill="url(#marginGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-theme-faint text-center py-8 text-sm">No data</p>
          )}
        </div>

        {/* Budget vs Actual */}
        <div className="card">
          <h3 className="text-sm font-semibold text-theme-heading mb-1">Budget vs Actual</h3>
          <p className="text-xs text-theme-faint mb-4">Variance analysis</p>
          {variance.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-dark-400/50">
                    <th className="text-left py-2.5 px-2 text-theme-faint font-medium text-[10px] uppercase tracking-wider">Month</th>
                    <th className="text-left py-2.5 px-2 text-theme-faint font-medium text-[10px] uppercase tracking-wider">Metric</th>
                    <th className="text-right py-2.5 px-2 text-theme-faint font-medium text-[10px] uppercase tracking-wider">Budget</th>
                    <th className="text-right py-2.5 px-2 text-theme-faint font-medium text-[10px] uppercase tracking-wider">Actual</th>
                    <th className="text-right py-2.5 px-2 text-theme-faint font-medium text-[10px] uppercase tracking-wider">Var %</th>
                    <th className="text-center py-2.5 px-2 text-theme-faint font-medium text-[10px] uppercase tracking-wider">RAG</th>
                  </tr>
                </thead>
                <tbody>
                  {variance.map((v, i) => (
                    <tr key={i} className="border-b border-dark-400/30 hover:bg-dark-600/50 transition-colors">
                      <td className="py-2.5 px-2 text-theme-secondary">{getMonthLabel(v.month)}</td>
                      <td className="py-2.5 px-2 text-theme-muted">{v.metric}</td>
                      <td className="py-2.5 px-2 text-right text-theme-muted">{formatINR(v.amount)}</td>
                      <td className="py-2.5 px-2 text-right text-theme-primary">{formatINR(v.actual_amount)}</td>
                      <td className="py-2.5 px-2 text-right text-theme-secondary">{v.variance_pct.toFixed(1)}%</td>
                      <td className="py-2.5 px-2 text-center">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          v.rag === 'GREEN' ? 'bg-emerald-500/15 text-emerald-400' :
                          v.rag === 'AMBER' ? 'bg-amber-500/15 text-amber-400' :
                          'bg-red-500/15 text-red-400'
                        }`}>{v.rag}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-theme-faint text-center py-8 text-sm">Set a budget to see variance</p>
          )}
        </div>
      </div>
    </div>
  );
}
