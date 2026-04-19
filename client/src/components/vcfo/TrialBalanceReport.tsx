import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatRs } from '../../pages/ForecastModulePage';

interface TrialBalanceRow {
  ledgerName: string;
  groupName: string | null;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

interface TrialBalanceReport {
  period: { from: string; to: string };
  rows: TrialBalanceRow[];
  totals: { opening: number; debit: number; credit: number; closing: number };
}

interface Props {
  companyId: number | null;
  companyIds?: string | null;
  from: string;
  to: string;
}

export default function TrialBalanceReport({ companyId, companyIds, from, to }: Props) {
  const [data, setData] = useState<TrialBalanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId && !companyIds) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    const params: Record<string, any> = { from, to };
    if (companyId) params.companyId = companyId;
    else if (companyIds) params.companyIds = companyIds;
    api
      .get('/vcfo/trial-balance', { params })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, companyIds, from, to]);

  if (!companyId && !companyIds) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">Select a company to view the Trial Balance.</p>
      </div>
    );
  }
  if (loading) return <div className="text-theme-muted py-8 text-center">Loading…</div>;
  if (error) return <div className="text-red-400 py-8 text-center">{error}</div>;
  if (!data || data.rows.length === 0) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">
          No data for this period. Run Sync Now in the VCFO Sync desktop agent to pull fresh data.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      <div className="px-5 py-3 border-b border-dark-400/30 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme-primary">Trial Balance</h3>
        <span className="text-xs text-theme-faint">
          {data.period.from} → {data.period.to}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-dark-700">
            <tr className="text-xs font-semibold text-theme-muted uppercase tracking-wide">
              <th className="text-left px-4 py-2.5 border-b border-dark-400/30">Ledger</th>
              <th className="text-left px-4 py-2.5 border-b border-dark-400/30">Group</th>
              <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Opening</th>
              <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Debit</th>
              <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Credit</th>
              <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Closing</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr
                key={`${r.ledgerName}-${i}`}
                className="border-b border-dark-400/20 hover:bg-dark-600/30 transition-colors"
              >
                <td className="px-4 py-2 text-theme-primary">{r.ledgerName}</td>
                <td className="px-4 py-2 text-theme-faint">{r.groupName || '-'}</td>
                <td className="px-4 py-2 text-right text-theme-secondary font-mono">{formatRs(r.opening)}</td>
                <td className="px-4 py-2 text-right text-theme-secondary font-mono">{formatRs(r.debit)}</td>
                <td className="px-4 py-2 text-right text-theme-secondary font-mono">{formatRs(r.credit)}</td>
                <td className="px-4 py-2 text-right text-theme-primary font-mono font-medium">{formatRs(r.closing)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-dark-700/80 font-semibold">
              <td className="px-4 py-2.5 text-theme-primary">Total</td>
              <td></td>
              <td className="px-4 py-2.5 text-right text-theme-primary font-mono">{formatRs(data.totals.opening)}</td>
              <td className="px-4 py-2.5 text-right text-theme-primary font-mono">{formatRs(data.totals.debit)}</td>
              <td className="px-4 py-2.5 text-right text-theme-primary font-mono">{formatRs(data.totals.credit)}</td>
              <td className="px-4 py-2.5 text-right text-theme-primary font-mono">{formatRs(data.totals.closing)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
