import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatRs, getMonthLabel } from '../../pages/ForecastModulePage';

interface PLSection {
  key: string;
  label: string;
  isExpense: boolean;
  values: Record<string, number>;
  grandTotal: number;
}

interface PLStatement {
  period: { from: string; to: string };
  view: 'yearly' | 'monthly';
  columns: string[];
  sections: PLSection[];
  computed: {
    grossProfit: Record<string, number>;
    grossMargin: Record<string, number>;
    netProfit: Record<string, number>;
  };
  grandTotals: {
    revenue: number;
    directIncome: number;
    purchase: number;
    directExpenses: number;
    indirectExpenses: number;
    indirectIncome: number;
    grossProfit: number;
    netProfit: number;
  };
}

interface Props {
  companyId: number | null;
  from: string;
  to: string;
  view: 'yearly' | 'monthly';
}

export default function ProfitLossReport({ companyId, from, to, view }: Props) {
  const [data, setData] = useState<PLStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .get('/vcfo/profit-loss', { params: { companyId, from, to, view } })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, from, to, view]);

  if (!companyId) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">Select a company to view the Profit &amp; Loss statement.</p>
      </div>
    );
  }
  if (loading) return <div className="text-theme-muted py-8 text-center">Loading…</div>;
  if (error) return <div className="text-red-400 py-8 text-center">{error}</div>;
  if (!data || data.sections.length === 0) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">
          No data for this period. Run Sync Now in the VCFO Sync desktop agent to pull fresh data.
        </p>
      </div>
    );
  }

  const { columns, sections, computed, view: reportView } = data;
  const labelFor = (col: string) => (reportView === 'monthly' ? getMonthLabel(col) : 'Total');

  const rowClasses = (isExpense: boolean) =>
    isExpense
      ? 'text-rose-300'
      : 'text-emerald-300';

  return (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      <div className="px-5 py-3 border-b border-dark-400/30 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme-primary">Profit &amp; Loss</h3>
        <span className="text-xs text-theme-faint">
          {data.period.from} → {data.period.to} · {reportView === 'monthly' ? 'Monthly view' : 'Yearly view'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-dark-700">
            <tr className="text-xs font-semibold text-theme-muted uppercase tracking-wide">
              <th className="text-left px-4 py-2.5 border-b border-dark-400/30 sticky left-0 bg-dark-700 z-10">Particulars</th>
              {columns.map(c => (
                <th key={c} className="text-right px-4 py-2.5 border-b border-dark-400/30 whitespace-nowrap">
                  {labelFor(c)}
                </th>
              ))}
              {reportView === 'monthly' && (
                <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Total</th>
              )}
            </tr>
          </thead>
          <tbody>
            {sections.map(section => (
              <tr
                key={section.key}
                className="border-b border-dark-400/20 hover:bg-dark-600/30 transition-colors"
              >
                <td className={`px-4 py-2 font-medium sticky left-0 bg-dark-800 ${rowClasses(section.isExpense)}`}>
                  {section.label}
                </td>
                {columns.map(c => (
                  <td
                    key={c}
                    className={`px-4 py-2 text-right font-mono ${rowClasses(section.isExpense)}`}
                  >
                    {formatRs(section.values[c] || 0)}
                  </td>
                ))}
                {reportView === 'monthly' && (
                  <td className={`px-4 py-2 text-right font-mono font-semibold ${rowClasses(section.isExpense)}`}>
                    {formatRs(section.grandTotal)}
                  </td>
                )}
              </tr>
            ))}

            {/* Gross Profit line */}
            <tr className="bg-dark-700/50 border-b border-accent-500/30">
              <td className="px-4 py-2.5 font-semibold text-accent-300 sticky left-0 bg-dark-700/50">Gross Profit</td>
              {columns.map(c => (
                <td key={c} className="px-4 py-2.5 text-right text-accent-300 font-mono font-semibold">
                  {formatRs(computed.grossProfit[c] || 0)}
                </td>
              ))}
              {reportView === 'monthly' && (
                <td className="px-4 py-2.5 text-right text-accent-300 font-mono font-semibold">
                  {formatRs(data.grandTotals.grossProfit)}
                </td>
              )}
            </tr>

            {/* Gross Margin line */}
            <tr className="border-b border-dark-400/20">
              <td className="px-4 py-1.5 text-xs text-theme-faint sticky left-0 bg-dark-800">Gross Margin (%)</td>
              {columns.map(c => (
                <td key={c} className="px-4 py-1.5 text-right text-theme-faint font-mono text-xs">
                  {(computed.grossMargin[c] ?? 0).toFixed(2)}%
                </td>
              ))}
              {reportView === 'monthly' && <td></td>}
            </tr>
          </tbody>
          <tfoot>
            <tr className="bg-accent-500/10 border-t-2 border-accent-500/50">
              <td className="px-4 py-3 font-bold text-accent-300 sticky left-0 bg-accent-500/10">Net Profit</td>
              {columns.map(c => (
                <td key={c} className="px-4 py-3 text-right text-accent-300 font-mono font-bold">
                  {formatRs(computed.netProfit[c] || 0)}
                </td>
              ))}
              {reportView === 'monthly' && (
                <td className="px-4 py-3 text-right text-accent-300 font-mono font-bold">
                  {formatRs(data.grandTotals.netProfit)}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
