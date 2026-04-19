import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatRs } from '../../pages/ForecastModulePage';

interface CFLine {
  label: string;
  amount: number;
}

interface CFStatement {
  period: { from: string; to: string };
  operating: CFLine[];
  operatingTotal: number;
  investing: CFLine[];
  investingTotal: number;
  financing: CFLine[];
  financingTotal: number;
  netChange: number;
  openingCash: number;
  closingCash: number;
}

interface Props {
  companyId: number | null;
  from: string;
  to: string;
}

export default function CashFlowReport({ companyId, from, to }: Props) {
  const [data, setData] = useState<CFStatement | null>(null);
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
      .get('/vcfo/cash-flow', { params: { companyId, from, to } })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, from, to]);

  if (!companyId) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">Select a company to view the Cash Flow statement.</p>
      </div>
    );
  }
  if (loading) return <div className="text-theme-muted py-8 text-center">Loading…</div>;
  if (error) return <div className="text-red-400 py-8 text-center">{error}</div>;
  if (!data) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">
          No data for this period. Run Sync Now in the VCFO Sync desktop agent to pull fresh data.
        </p>
      </div>
    );
  }

  const renderSection = (title: string, lines: CFLine[], total: number, accent: string) => (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      <div className="px-5 py-3 border-b border-dark-400/30 flex items-center justify-between">
        <h3 className={`text-sm font-semibold ${accent}`}>{title}</h3>
        <span className={`text-sm font-mono font-semibold ${accent}`}>{formatRs(total)}</span>
      </div>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td className="px-4 py-3 text-theme-faint italic" colSpan={2}>
                No activity in this period.
              </td>
            </tr>
          ) : (
            lines.map((line, i) => (
              <tr
                key={`${line.label}-${i}`}
                className="border-b border-dark-400/20 hover:bg-dark-600/30 transition-colors"
              >
                <td className="px-4 py-2 text-theme-secondary">{line.label}</td>
                <td
                  className={`px-4 py-2 text-right font-mono ${
                    line.amount >= 0 ? 'text-emerald-300' : 'text-rose-300'
                  }`}
                >
                  {formatRs(line.amount)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-theme-faint">
          {data.period.from} → {data.period.to} · Indirect method
        </span>
      </div>

      {renderSection('Operating Activities', data.operating, data.operatingTotal, 'text-emerald-300')}
      {renderSection('Investing Activities', data.investing, data.investingTotal, 'text-sky-300')}
      {renderSection('Financing Activities', data.financing, data.financingTotal, 'text-violet-300')}

      {/* Summary */}
      <div className="bg-dark-800 border border-accent-500/30 rounded-2xl shadow-elev-2 overflow-hidden">
        <div className="px-5 py-3 border-b border-dark-400/30">
          <h3 className="text-sm font-semibold text-accent-300">Summary</h3>
        </div>
        <table className="w-full border-collapse text-sm">
          <tbody>
            <tr className="border-b border-dark-400/20">
              <td className="px-4 py-2 text-theme-secondary">Opening Cash &amp; Bank</td>
              <td className="px-4 py-2 text-right text-theme-primary font-mono">{formatRs(data.openingCash)}</td>
            </tr>
            <tr className="border-b border-dark-400/20">
              <td className="px-4 py-2 text-theme-secondary">Net Change in Cash</td>
              <td
                className={`px-4 py-2 text-right font-mono font-semibold ${
                  data.netChange >= 0 ? 'text-emerald-300' : 'text-rose-300'
                }`}
              >
                {formatRs(data.netChange)}
              </td>
            </tr>
            <tr className="bg-accent-500/10">
              <td className="px-4 py-3 font-bold text-accent-300">Closing Cash &amp; Bank</td>
              <td className="px-4 py-3 text-right text-accent-300 font-mono font-bold">
                {formatRs(data.closingCash)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
