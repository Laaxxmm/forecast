import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  viewMode: 'monthly' | 'yearly';
  settings: Record<string, any>;
}

function sumCategory(items: ForecastItem[], category: string, allValues: Record<number, Record<string, number>>, month: string): number {
  return items
    .filter(i => i.category === category)
    .reduce((sum, item) => sum + (allValues[item.id]?.[month] || 0), 0);
}

export default function ProfitAndLoss({ items, allValues, months, viewMode, settings }: Props) {
  const revenueItems = items.filter(i => i.category === 'revenue');
  const directCostItems = items.filter(i => i.category === 'direct_costs');
  const personnelItems = items.filter(i => i.category === 'personnel');
  const expenseItems = items.filter(i => i.category === 'expenses');
  const taxItems = items.filter(i => i.category === 'taxes');

  const employeeBenefitsPct = settings.employee_benefits_pct || 0;

  const rows = useMemo(() => {
    return months.map(m => {
      const revenue = sumCategory(items, 'revenue', allValues, m);
      const directCosts = sumCategory(items, 'direct_costs', allValues, m);
      const grossProfit = revenue - directCosts;
      const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

      const personnel = sumCategory(items, 'personnel', allValues, m);
      const employeeTaxes = personnel * (employeeBenefitsPct / 100);
      const expenses = sumCategory(items, 'expenses', allValues, m);
      const totalOpex = personnel + employeeTaxes + expenses;

      const operatingIncome = grossProfit - totalOpex;
      const taxes = sumCategory(items, 'taxes', allValues, m);
      const netProfit = operatingIncome - taxes;

      return { month: m, revenue, directCosts, grossProfit, grossMargin, personnel, employeeTaxes, expenses, totalOpex, operatingIncome, taxes, netProfit };
    });
  }, [items, allValues, months, employeeBenefitsPct]);

  const totals = useMemo(() => {
    const t = { revenue: 0, directCosts: 0, grossProfit: 0, personnel: 0, employeeTaxes: 0, expenses: 0, totalOpex: 0, operatingIncome: 0, taxes: 0, netProfit: 0 };
    rows.forEach(r => {
      t.revenue += r.revenue; t.directCosts += r.directCosts; t.grossProfit += r.grossProfit;
      t.personnel += r.personnel; t.employeeTaxes += r.employeeTaxes; t.expenses += r.expenses;
      t.totalOpex += r.totalOpex; t.operatingIncome += r.operatingIncome; t.taxes += r.taxes; t.netProfit += r.netProfit;
    });
    return t;
  }, [rows]);

  const chartData = rows.map(r => ({
    month: getMonthLabel(r.month),
    Revenue: r.revenue,
    'Net Profit': r.netProfit,
  }));

  type PnLRow = { label: string; key: string; isHeader?: boolean; isTotal?: boolean; indent?: number; pct?: boolean };
  const pnlRows: PnLRow[] = [
    { label: 'Revenue', key: 'revenue', isHeader: true },
    ...revenueItems.map(i => ({ label: i.name, key: `rev_${i.id}`, indent: 1 })),
    { label: 'Total Revenue', key: 'revenue_total', isTotal: true },
    { label: 'Direct Costs', key: 'direct_costs_header', isHeader: true },
    ...directCostItems.map(i => ({ label: i.name, key: `dc_${i.id}`, indent: 1 })),
    { label: 'Total Direct Costs', key: 'direct_costs_total', isTotal: true },
    { label: 'Gross Profit', key: 'grossProfit', isTotal: true },
    { label: 'Gross Margin (%)', key: 'grossMargin', pct: true },
    { label: 'Operating Expenses', key: 'opex_header', isHeader: true },
    ...personnelItems.map(i => ({ label: i.name, key: `pers_${i.id}`, indent: 1 })),
    { label: 'Employee Taxes & Benefits', key: 'employeeTaxes', indent: 1 },
    ...expenseItems.map(i => ({ label: i.name, key: `exp_${i.id}`, indent: 1 })),
    { label: 'Total Operating Expenses', key: 'totalOpex', isTotal: true },
    { label: 'Operating Income', key: 'operatingIncome', isTotal: true },
    { label: 'Taxes', key: 'taxes' },
    { label: 'Net Profit', key: 'netProfit', isTotal: true },
  ];

  const getRowValue = (row: PnLRow, month: string): number => {
    if (row.key.startsWith('rev_')) {
      const id = parseInt(row.key.split('_')[1]);
      return allValues[id]?.[month] || 0;
    }
    if (row.key.startsWith('dc_')) {
      const id = parseInt(row.key.split('_')[1]);
      return allValues[id]?.[month] || 0;
    }
    if (row.key.startsWith('pers_')) {
      const id = parseInt(row.key.split('_')[1]);
      return allValues[id]?.[month] || 0;
    }
    if (row.key.startsWith('exp_')) {
      const id = parseInt(row.key.split('_')[1]);
      return allValues[id]?.[month] || 0;
    }
    const r = rows.find(x => x.month === month);
    if (!r) return 0;
    if (row.key === 'revenue_total') return r.revenue;
    if (row.key === 'direct_costs_total') return r.directCosts;
    if (row.key === 'grossProfit') return r.grossProfit;
    if (row.key === 'grossMargin') return r.grossMargin;
    if (row.key === 'employeeTaxes') return r.employeeTaxes;
    if (row.key === 'totalOpex') return r.totalOpex;
    if (row.key === 'operatingIncome') return r.operatingIncome;
    if (row.key === 'taxes') return r.taxes;
    if (row.key === 'netProfit') return r.netProfit;
    return 0;
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-4">Projected Profit & Loss</h2>

      {/* Chart */}
      <div className="card mb-4">
        <h3 className="text-sm font-semibold text-slate-400 mb-3">Projected Profit & Loss Totals</h3>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" />
              <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(value: number) => [formatRs(value)]} contentStyle={{ borderRadius: 8, fontSize: 12, backgroundColor: '#14141f', borderColor: '#2a2a3d', color: '#e2e8f0' }} />
              <Area type="monotone" dataKey="Revenue" stroke="#0d9488" fill="#0d948820" strokeWidth={2} />
              <Area type="monotone" dataKey="Net Profit" stroke="#6366f1" fill="#6366f120" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* P&L Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: months.length * 100 + 280 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-slate-400 sticky left-0 bg-dark-600 z-10 min-w-[250px]">Profit & Loss</th>
              {months.map(m => (
                <th key={m} className="text-right py-3 px-3 font-semibold text-slate-400 whitespace-nowrap min-w-[100px]">{getMonthLabel(m)}</th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-slate-400 bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {pnlRows.map(row => {
              if (row.isHeader) {
                return (
                  <tr key={row.key} className="bg-dark-600 border-b border-dark-400/50">
                    <td className="py-2.5 px-4 font-semibold text-slate-300 sticky left-0 bg-dark-600 z-10">{row.label}</td>
                    <td colSpan={months.length + 1} />
                  </tr>
                );
              }
              const rowTotal = months.reduce((sum, m) => sum + getRowValue(row, m), 0);
              return (
                <tr key={row.key} className={`border-b border-dark-400/30 ${row.isTotal ? 'font-semibold bg-dark-600/50' : ''}`}>
                  <td className={`py-2 px-4 text-slate-300 sticky left-0 z-10 ${row.isTotal ? 'bg-dark-600/50 font-semibold' : 'bg-dark-700'} ${row.indent ? 'pl-8' : ''}`}>
                    {row.label}
                  </td>
                  {months.map(m => {
                    const val = getRowValue(row, m);
                    return (
                      <td key={m} className={`text-right py-2 px-3 tabular-nums ${val < 0 ? 'text-red-400' : 'text-slate-300'}`}>
                        {row.pct ? `${val.toFixed(1)}%` : (val !== 0 ? formatRs(val) : <span className="text-slate-300">-</span>)}
                      </td>
                    );
                  })}
                  <td className={`text-right py-2 px-4 tabular-nums bg-dark-600 ${rowTotal < 0 ? 'text-red-400' : 'text-white'}`}>
                    {row.pct ? `${(totals.revenue > 0 ? (totals.grossProfit / totals.revenue * 100) : 0).toFixed(1)}%` : formatRs(rowTotal)}
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
