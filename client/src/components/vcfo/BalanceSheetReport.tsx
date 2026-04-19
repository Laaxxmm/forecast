import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatRs, getMonthLabel } from '../../pages/ForecastModulePage';

interface BSSection {
  key: string;
  label: string;
  side: 'asset' | 'liability';
  values: Record<string, number>;
  grandTotal: number;
}

interface BSStatement {
  asOfDate: string;
  view: 'yearly' | 'monthly';
  columns: string[];
  sections: BSSection[];
  totals: {
    totalAssets: Record<string, number>;
    totalLiabilities: Record<string, number>;
  };
}

interface Props {
  companyId: number | null;
  asOf: string;
  view: 'yearly' | 'monthly';
  from?: string;
}

export default function BalanceSheetReport({ companyId, asOf, view, from }: Props) {
  const [data, setData] = useState<BSStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    const params: Record<string, any> = { companyId, asOf, view };
    if (from) params.from = from;
    api
      .get('/vcfo/balance-sheet', { params })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, asOf, view, from]);

  if (!companyId) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">Select a company to view the Balance Sheet.</p>
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

  const { columns, sections, totals, view: reportView } = data;
  const liabilities = sections.filter(s => s.side === 'liability');
  const assets = sections.filter(s => s.side === 'asset');
  const labelFor = (col: string) => (reportView === 'monthly' ? getMonthLabel(col) : 'Closing');

  const renderSide = (title: string, rows: BSSection[], total: Record<string, number>, accent: string) => (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      <div className="px-5 py-3 border-b border-dark-400/30 flex items-center justify-between">
        <h3 className={`text-sm font-semibold ${accent}`}>{title}</h3>
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
            {rows.map(row => (
              <tr key={row.key} className="border-b border-dark-400/20 hover:bg-dark-600/30 transition-colors">
                <td className="px-4 py-2 text-theme-primary sticky left-0 bg-dark-800">{row.label}</td>
                {columns.map(c => (
                  <td key={c} className="px-4 py-2 text-right text-theme-secondary font-mono">
                    {formatRs(row.values[c] || 0)}
                  </td>
                ))}
                {reportView === 'monthly' && (
                  <td className="px-4 py-2 text-right text-theme-primary font-mono font-semibold">
                    {formatRs(row.grandTotal)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-dark-700/80">
              <td className="px-4 py-2.5 font-semibold text-theme-primary sticky left-0 bg-dark-700/80">Total</td>
              {columns.map(c => (
                <td key={c} className={`px-4 py-2.5 text-right font-mono font-semibold ${accent}`}>
                  {formatRs(total[c] || 0)}
                </td>
              ))}
              {reportView === 'monthly' && <td></td>}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-theme-faint">As of {data.asOfDate} · {reportView === 'monthly' ? 'Monthly view' : 'Yearly view'}</span>
      </div>
      {renderSide('Liabilities & Equity', liabilities, totals.totalLiabilities, 'text-rose-300')}
      {renderSide('Assets', assets, totals.totalAssets, 'text-emerald-300')}
    </div>
  );
}
