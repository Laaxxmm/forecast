import { useEffect, useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber, getMonthLabel, ragColor } from '../utils/format';

export default function PharmacyDetailPage() {
  const [fys, setFYs] = useState<any[]>([]);
  const [selectedFY, setSelectedFY] = useState<number | null>(null);
  const [sales, setSales] = useState<any[]>([]);
  const [purchases, setPurchases] = useState<any[]>([]);
  const [variance, setVariance] = useState<any[]>([]);

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
      api.get('/actuals/pharmacy', { params: { fy_id: selectedFY } }),
      api.get('/actuals/pharmacy/purchases', { params: { fy_id: selectedFY } }),
      api.get('/dashboard/variance', { params: { fy_id: selectedFY, business_unit: 'PHARMACY' } }),
    ]).then(([salesRes, purchRes, varRes]) => {
      setSales(salesRes.data);
      setPurchases(purchRes.data);
      setVariance(varRes.data);
    });
  }, [selectedFY]);

  const chartData = sales.map(s => ({
    label: getMonthLabel(s.bill_month),
    sales: s.total_sales,
    cogs: s.total_purchase_cost,
    profit: s.total_profit,
    margin: s.profit_margin_pct,
  }));

  // Totals
  const totalSales = sales.reduce((s, r) => s + r.total_sales, 0);
  const totalCOGS = sales.reduce((s, r) => s + r.total_purchase_cost, 0);
  const totalProfit = sales.reduce((s, r) => s + r.total_profit, 0);
  const avgMargin = totalSales > 0 ? (totalProfit / totalSales * 100) : 0;
  const totalQty = sales.reduce((s, r) => s + r.total_qty, 0);
  const totalTxns = sales.reduce((s, r) => s + r.transactions, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Pharmacy Details</h1>
          <p className="text-slate-500 mt-1">Sales, purchases, and profitability analysis</p>
        </div>
        <select value={selectedFY || ''} onChange={e => setSelectedFY(Number(e.target.value))} className="input w-48">
          {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
        </select>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        {[
          { label: 'Total Sales', value: formatINR(totalSales) },
          { label: 'Total COGS', value: formatINR(totalCOGS) },
          { label: 'Gross Profit', value: formatINR(totalProfit) },
          { label: 'Avg Margin', value: `${avgMargin.toFixed(1)}%` },
          { label: 'Units Sold', value: formatNumber(totalQty) },
          { label: 'Transactions', value: formatNumber(totalTxns) },
        ].map(item => (
          <div key={item.label} className="card p-4">
            <p className="text-xs text-slate-500">{item.label}</p>
            <p className="text-lg font-bold text-slate-800 mt-1">{item.value}</p>
          </div>
        ))}
      </div>

      {/* Sales vs COGS Chart */}
      <div className="card mb-6">
        <h3 className="font-semibold text-slate-800 mb-4">Monthly Sales, COGS & Profit</h3>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v: number) => formatINR(v)} />
              <Legend />
              <Bar dataKey="sales" name="Sales" fill="#0d9488" radius={[4, 4, 0, 0]} />
              <Bar dataKey="cogs" name="COGS" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              <Bar dataKey="profit" name="Profit" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-slate-400 text-center py-16">Import Oneglance sales data to see pharmacy details</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Margin Trend */}
        <div className="card">
          <h3 className="font-semibold text-slate-800 mb-4">Profit Margin Trend</h3>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 25]} tickFormatter={v => `${v}%`} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                <Line type="monotone" dataKey="margin" name="Margin %" stroke="#0d9488" strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-slate-400 text-center py-8">No data</p>
          )}
        </div>

        {/* Budget vs Actual */}
        <div className="card">
          <h3 className="font-semibold text-slate-800 mb-4">Budget vs Actual</h3>
          {variance.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2 px-2">Month</th>
                    <th className="text-left py-2 px-2">Metric</th>
                    <th className="text-right py-2 px-2">Budget</th>
                    <th className="text-right py-2 px-2">Actual</th>
                    <th className="text-right py-2 px-2">Var %</th>
                    <th className="text-center py-2 px-2">RAG</th>
                  </tr>
                </thead>
                <tbody>
                  {variance.map((v, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 px-2">{getMonthLabel(v.month)}</td>
                      <td className="py-2 px-2">{v.metric}</td>
                      <td className="py-2 px-2 text-right">{formatINR(v.amount)}</td>
                      <td className="py-2 px-2 text-right">{formatINR(v.actual_amount)}</td>
                      <td className="py-2 px-2 text-right">{v.variance_pct.toFixed(1)}%</td>
                      <td className="py-2 px-2 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ragColor(v.rag)}`}>
                          {v.rag}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-slate-400 text-center py-8">Set a budget to see variance</p>
          )}
        </div>
      </div>
    </div>
  );
}
