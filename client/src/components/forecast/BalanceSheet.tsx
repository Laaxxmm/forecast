import { useMemo } from 'react';
import { ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

interface Props {
  items: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  months: string[];
  viewMode: 'monthly' | 'yearly';
  settings: Record<string, any>;
}

export default function BalanceSheet({ items, allValues, months, viewMode: _viewMode, settings: _settings }: Props) {
  const assetItems = items.filter(i => i.category === 'assets');
  const currentAssets = assetItems.filter(i => i.item_type === 'current');
  const longTermAssets = assetItems.filter(i => i.item_type === 'long_term');

  const rows = useMemo(() => {
    return months.map(m => {
      const totalRevenue = items.filter(i => i.category === 'revenue').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const totalCosts = items.filter(i => i.category === 'direct_costs').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const totalOpex = items.filter(i => i.category === 'expenses' || i.category === 'personnel').reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const netIncome = totalRevenue - totalCosts - totalOpex;

      const currentAssetVal = currentAssets.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);
      const longTermAssetVal = longTermAssets.reduce((s, i) => s + (allValues[i.id]?.[m] || 0), 0);

      return {
        month: m,
        cash: Math.max(netIncome, 0), // Simplified
        currentAssets: currentAssetVal,
        longTermAssets: longTermAssetVal,
        totalAssets: currentAssetVal + longTermAssetVal + Math.max(netIncome, 0),
        retainedEarnings: netIncome,
        totalEquity: netIncome,
        totalLiabilitiesEquity: currentAssetVal + longTermAssetVal + Math.max(netIncome, 0),
      };
    });
  }, [items, allValues, months]);

  type BSRow = { label: string; key: string; isHeader?: boolean; isTotal?: boolean; indent?: number };
  const bsRows: BSRow[] = [
    { label: 'Assets', key: 'assets_header', isHeader: true },
    { label: 'Current Assets', key: 'current_header', isHeader: true },
    { label: 'Cash', key: 'cash', indent: 1 },
    ...currentAssets.map(i => ({ label: i.name, key: `ca_${i.id}`, indent: 1 })),
    { label: 'Total Current Assets', key: 'total_current', isTotal: true },
    { label: 'Long-term Assets', key: 'lt_header', isHeader: true },
    ...longTermAssets.map(i => ({ label: i.name, key: `la_${i.id}`, indent: 1 })),
    { label: 'Total Long-term Assets', key: 'total_lt', isTotal: true },
    { label: 'Total Assets', key: 'total_assets', isTotal: true },
    { label: '', key: 'spacer' },
    { label: 'Liabilities & Equity', key: 'le_header', isHeader: true },
    { label: 'Equity', key: 'equity_header', isHeader: true },
    { label: 'Retained Earnings', key: 'retained', indent: 1 },
    { label: 'Total Equity', key: 'total_equity', isTotal: true },
    { label: 'Total Liabilities & Equity', key: 'total_le', isTotal: true },
  ];

  const getVal = (row: BSRow, month: string): number | null => {
    const r = rows.find(x => x.month === month);
    if (!r) return 0;
    if (row.key.startsWith('ca_')) return allValues[parseInt(row.key.split('_')[1])]?.[month] || 0;
    if (row.key.startsWith('la_')) return allValues[parseInt(row.key.split('_')[1])]?.[month] || 0;
    if (row.key === 'cash') return r.cash;
    if (row.key === 'total_current') return r.cash + r.currentAssets;
    if (row.key === 'total_lt') return r.longTermAssets;
    if (row.key === 'total_assets') return r.totalAssets;
    if (row.key === 'retained') return r.retainedEarnings;
    if (row.key === 'total_equity') return r.totalEquity;
    if (row.key === 'total_le') return r.totalLiabilitiesEquity;
    return null;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">Projected Balance Sheet</h2>
        <div className="flex gap-2">
          <button className="btn-secondary text-sm">Set Initial Balances</button>
          <button className="btn-primary text-sm">Add Financing</button>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: months.length * 100 + 280 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-slate-400 sticky left-0 bg-dark-600 z-10 min-w-[250px]">Balance Sheet</th>
              {months.map(m => (
                <th key={m} className="text-right py-3 px-3 font-semibold text-slate-400 whitespace-nowrap min-w-[100px]">{getMonthLabel(m)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bsRows.map(row => {
              if (row.key === 'spacer') return <tr key={row.key} className="h-4"><td colSpan={months.length + 1} /></tr>;
              if (row.isHeader) {
                return (
                  <tr key={row.key} className="bg-dark-600 border-b border-dark-400/50">
                    <td className="py-2.5 px-4 font-semibold text-slate-300 sticky left-0 bg-dark-600 z-10">{row.label}</td>
                    <td colSpan={months.length} />
                  </tr>
                );
              }
              return (
                <tr key={row.key} className={`border-b border-dark-400/30 ${row.isTotal ? 'font-semibold bg-dark-600/50' : ''}`}>
                  <td className={`py-2 px-4 text-slate-300 sticky left-0 z-10 ${row.isTotal ? 'bg-dark-600/50' : 'bg-dark-700'} ${row.indent ? 'pl-8' : ''}`}>
                    {row.label}
                  </td>
                  {months.map(m => {
                    const val = getVal(row, m);
                    return (
                      <td key={m} className={`text-right py-2 px-3 tabular-nums ${(val || 0) < 0 ? 'text-red-400' : 'text-slate-300'}`}>
                        {val != null && val !== 0 ? formatRs(val) : <span className="text-slate-300">-</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
