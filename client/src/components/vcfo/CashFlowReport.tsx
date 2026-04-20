import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatRs } from '../../pages/ForecastModulePage';

interface CFLine {
  label: string;
  amount: number;
  values?: Record<string, number>;
}

interface CFStatement {
  period: { from: string; to: string };
  columns?: string[];
  columnLabels?: Record<string, string>;
  bifurcated?: boolean;
  companies?: Array<{ id: number; name: string }>;
  operating: CFLine[];
  operatingTotal: number;
  operatingTotalValues?: Record<string, number>;
  investing: CFLine[];
  investingTotal: number;
  investingTotalValues?: Record<string, number>;
  financing: CFLine[];
  financingTotal: number;
  financingTotalValues?: Record<string, number>;
  netChange: number;
  netChangeValues?: Record<string, number>;
  openingCash: number;
  openingCashValues?: Record<string, number>;
  closingCash: number;
  closingCashValues?: Record<string, number>;
}

interface Props {
  companyId: number | null;
  companyIds?: string | null;
  from: string;
  to: string;
  bifurcate?: boolean;
}

export default function CashFlowReport({ companyId, companyIds, from, to, bifurcate }: Props) {
  const [data, setData] = useState<CFStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId && !companyIds) {
      setData(null);
      return;
    }
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    const params: Record<string, any> = { from, to };
    if (companyId) params.companyId = companyId;
    else if (companyIds) params.companyIds = companyIds;
    if (bifurcate) params.bifurcate = 'true';
    api
      .get('/vcfo/cash-flow', { params })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, companyIds, from, to, bifurcate]);

  if (!companyId && !companyIds) {
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

  const columns = data.columns && data.bifurcated ? data.columns : null;
  const labelFor = (col: string): string => data.columnLabels?.[col] || (col === 'total' ? 'Total' : col);

  // Bifurcated layout — table with one column per company + total.
  if (columns) {
    const renderSection = (
      title: string,
      lines: CFLine[],
      totalValues: Record<string, number> | undefined,
      accent: string,
    ) => (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
        <div className="px-5 py-3 border-b border-dark-400/30">
          <h3 className={`text-sm font-semibold ${accent}`}>{title}</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-dark-700">
              <tr className="text-xs font-semibold text-theme-muted uppercase tracking-wide">
                <th className="text-left px-4 py-2.5 border-b border-dark-400/30 sticky left-0 bg-dark-700 z-10">Activity</th>
                {columns.map(c => (
                  <th key={c} className="text-right px-4 py-2.5 border-b border-dark-400/30 whitespace-nowrap">
                    {labelFor(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td className="px-4 py-3 text-theme-faint italic" colSpan={columns.length + 1}>
                    No activity in this period.
                  </td>
                </tr>
              ) : (
                lines.map((line, i) => (
                  <tr key={`${line.label}-${i}`} className="border-b border-dark-400/20 hover:bg-dark-600/20">
                    <td className="px-4 py-2 text-theme-secondary sticky left-0 bg-dark-800">{line.label}</td>
                    {columns.map(c => {
                      const v = line.values?.[c] ?? (c === 'total' ? line.amount : 0);
                      return (
                        <td
                          key={c}
                          className={`px-4 py-2 text-right font-mono ${v >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
                        >
                          {formatRs(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="bg-dark-700/80">
                <td className="px-4 py-2.5 font-semibold text-theme-primary sticky left-0 bg-dark-700/80">Subtotal</td>
                {columns.map(c => (
                  <td key={c} className={`px-4 py-2.5 text-right font-mono font-semibold ${accent}`}>
                    {formatRs(totalValues?.[c] ?? 0)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    );

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-theme-faint">
            {data.period.from} → {data.period.to} · Indirect method · By company
          </span>
        </div>

        {renderSection('Operating Activities', data.operating, data.operatingTotalValues, 'text-emerald-300')}
        {renderSection('Investing Activities', data.investing, data.investingTotalValues, 'text-sky-300')}
        {renderSection('Financing Activities', data.financing, data.financingTotalValues, 'text-violet-300')}

        <div className="bg-dark-800 border border-accent-500/30 rounded-2xl shadow-elev-2 overflow-hidden">
          <div className="px-5 py-3 border-b border-dark-400/30">
            <h3 className="text-sm font-semibold text-accent-300">Summary</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-dark-700">
                <tr className="text-xs font-semibold text-theme-muted uppercase tracking-wide">
                  <th className="text-left px-4 py-2.5 border-b border-dark-400/30 sticky left-0 bg-dark-700 z-10"></th>
                  {columns.map(c => (
                    <th key={c} className="text-right px-4 py-2.5 border-b border-dark-400/30 whitespace-nowrap">
                      {labelFor(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-dark-400/20">
                  <td className="px-4 py-2 text-theme-secondary sticky left-0 bg-dark-800">Opening Cash &amp; Bank</td>
                  {columns.map(c => (
                    <td key={c} className="px-4 py-2 text-right text-theme-primary font-mono">
                      {formatRs(data.openingCashValues?.[c] ?? 0)}
                    </td>
                  ))}
                </tr>
                <tr className="border-b border-dark-400/20">
                  <td className="px-4 py-2 text-theme-secondary sticky left-0 bg-dark-800">Net Change in Cash</td>
                  {columns.map(c => {
                    const v = data.netChangeValues?.[c] ?? 0;
                    return (
                      <td key={c} className={`px-4 py-2 text-right font-mono font-semibold ${v >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {formatRs(v)}
                      </td>
                    );
                  })}
                </tr>
                <tr className="bg-accent-500/10">
                  <td className="px-4 py-3 font-bold text-accent-300 sticky left-0 bg-accent-500/10">Closing Cash &amp; Bank</td>
                  {columns.map(c => (
                    <td key={c} className="px-4 py-3 text-right text-accent-300 font-mono font-bold">
                      {formatRs(data.closingCashValues?.[c] ?? 0)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // Single-column (consolidated or single-company) layout — original form.
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
                <td className={`px-4 py-2 text-right font-mono ${line.amount >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
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
              <td className={`px-4 py-2 text-right font-mono font-semibold ${data.netChange >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
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
