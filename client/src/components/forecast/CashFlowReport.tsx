import { useMemo, useState } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  viewMode: 'monthly' | 'yearly';
  settings: Record<string, any>;
}

export default function CashFlowReport({ items, allValues, months, viewMode: _viewMode, settings: _settings }: Props) {
  const [view, setView] = useState<'flow' | 'balance'>('flow');

  const rows = useMemo(() => {
    let cumulativeCash = 0;
    return months.map(m => {
      const revenue = items.filter(i => i.category === 'revenue').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const directCosts = items.filter(i => i.category === 'direct_costs').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const personnel = items.filter(i => i.category === 'personnel').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const expenses = items.filter(i => i.category === 'expenses').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const taxes = items.filter(i => i.category === 'taxes').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const assets = items.filter(i => i.category === 'assets').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const dividends = items.filter(i => i.category === 'dividends').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);

      const cashFromOps = revenue - directCosts - personnel - expenses - taxes;
      const cashFromInvesting = -assets;
      const cashFromFinancing = -dividends;
      const netCashFlow = cashFromOps + cashFromInvesting + cashFromFinancing;
      cumulativeCash += netCashFlow;

      return {
        month: m,
        revenue,
        directCosts,
        personnel,
        expenses,
        taxes,
        cashFromOps,
        assets,
        cashFromInvesting,
        dividends,
        cashFromFinancing,
        netCashFlow,
        cashBalance: cumulativeCash,
      };
    });
  }, [items, allValues, months]);

  const chartData = rows.map(r => ({
    month: getMonthLabel(r.month),
    'Cash Flow': r.netCashFlow,
    'Cash Balance': r.cashBalance,
  }));

  type CFRow = { label: string; key: string; isHeader?: boolean; isTotal?: boolean; indent?: number };
  const cfRows: CFRow[] = [
    { label: 'Cash from Operations', key: 'ops_header', isHeader: true },
    { label: 'Cash Receipts (Revenue)', key: 'revenue', indent: 1 },
    { label: 'Direct Costs Paid', key: 'directCosts', indent: 1 },
    { label: 'Personnel Paid', key: 'personnel', indent: 1 },
    { label: 'Expenses Paid', key: 'expenses', indent: 1 },
    { label: 'Taxes Paid', key: 'taxes', indent: 1 },
    { label: 'Net Cash from Operations', key: 'cashFromOps', isTotal: true },
    { label: 'Cash from Investing', key: 'inv_header', isHeader: true },
    { label: 'Assets Purchased', key: 'assets', indent: 1 },
    { label: 'Net Cash from Investing', key: 'cashFromInvesting', isTotal: true },
    { label: 'Cash from Financing', key: 'fin_header', isHeader: true },
    { label: 'Dividends Paid', key: 'dividends', indent: 1 },
    { label: 'Net Cash from Financing', key: 'cashFromFinancing', isTotal: true },
    { label: 'Net Cash Flow', key: 'netCashFlow', isTotal: true },
    { label: 'Cash Balance', key: 'cashBalance', isTotal: true },
  ];

  const getVal = (row: CFRow, month: string): number => {
    const r = rows.find(x => x.month === month);
    if (!r) return 0;
    return (r as any)[row.key] || 0;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">Projected Cash Flow</h2>
        <div className="flex bg-dark-500 rounded-lg p-1">
          <button
            onClick={() => setView('flow')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${view === 'flow' ? 'bg-dark-700 shadow-sm text-accent-400' : 'text-slate-500'}`}
          >Cash Flow</button>
          <button
            onClick={() => setView('balance')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${view === 'balance' ? 'bg-dark-700 shadow-sm text-accent-400' : 'text-slate-500'}`}
          >Cash Balance</button>
        </div>
      </div>

      {/* Chart */}
      <div className="card mb-4">
        <h3 className="text-sm font-semibold text-slate-400 mb-3">{view === 'flow' ? 'Cash Flow' : 'Cash Balance'}</h3>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            {view === 'balance' ? (
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="Cash Balance" stroke="#0d9488" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            ) : (
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="Cash Flow" fill="#0d9488" radius={[4, 4, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: months.length * 100 + 280 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-slate-400 sticky left-0 bg-dark-600 z-10 min-w-[250px]">Cash Flow</th>
              {months.map(m => (
                <th key={m} className="text-right py-3 px-3 font-semibold text-slate-400 whitespace-nowrap min-w-[100px]">{getMonthLabel(m)}</th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-slate-400 bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {cfRows.map(row => {
              if (row.isHeader) {
                return (
                  <tr key={row.key} className="bg-dark-600 border-b border-dark-400/50">
                    <td className="py-2.5 px-4 font-semibold text-slate-300 sticky left-0 bg-dark-600 z-10">{row.label}</td>
                    <td colSpan={months.length + 1} />
                  </tr>
                );
              }
              const rowTotal = months.reduce((sum, m) => sum + getVal(row, m), 0);
              return (
                <tr key={row.key} className={`border-b border-dark-400/30 ${row.isTotal ? 'font-semibold bg-dark-600/50' : ''}`}>
                  <td className={`py-2 px-4 text-slate-300 sticky left-0 z-10 ${row.isTotal ? 'bg-dark-600/50' : 'bg-dark-700'} ${row.indent ? 'pl-8' : ''}`}>
                    {row.label}
                  </td>
                  {months.map(m => {
                    const val = getVal(row, m);
                    return (
                      <td key={m} className={`text-right py-2 px-3 tabular-nums ${val < 0 ? 'text-red-400' : 'text-slate-300'}`}>
                        {val !== 0 ? formatRs(val) : <span className="text-slate-300">-</span>}
                      </td>
                    );
                  })}
                  <td className={`text-right py-2 px-4 tabular-nums bg-dark-600 ${rowTotal < 0 ? 'text-red-400' : 'text-white'}`}>
                    {row.key === 'cashBalance' ? formatRs(rows[rows.length - 1]?.cashBalance || 0) : formatRs(rowTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
