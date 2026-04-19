import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import api from '../../api/client';
import { formatRs, getMonthLabel } from '../../pages/ForecastModulePage';

interface BSSection {
  key: string;
  label: string;
  side: 'asset' | 'liability';
  values: Record<string, number>;
  grandTotal: number;
  children?: BSSection[];
}

interface BSStatement {
  asOfDate: string;
  view: 'yearly' | 'monthly';
  columns: string[];
  columnLabels?: Record<string, string>;
  bifurcated?: boolean;
  companies?: Array<{ id: number; name: string }>;
  sections: BSSection[];
  totals: {
    totalAssets: Record<string, number>;
    totalLiabilities: Record<string, number>;
  };
}

interface Props {
  companyId: number | null;
  companyIds?: string | null;
  asOf: string;
  view: 'yearly' | 'monthly';
  from?: string;
  bifurcate?: boolean;
}

export default function BalanceSheetReport({ companyId, companyIds, asOf, view, from, bifurcate }: Props) {
  const [data, setData] = useState<BSStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!companyId && !companyIds) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    const params: Record<string, any> = { asOf, view };
    if (companyId) params.companyId = companyId;
    else if (companyIds) params.companyIds = companyIds;
    if (from) params.from = from;
    if (bifurcate) params.bifurcate = 'true';
    api
      .get('/vcfo/balance-sheet', { params })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, companyIds, asOf, view, from, bifurcate]);

  if (!companyId && !companyIds) {
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

  const { columns, sections, totals, view: reportView, bifurcated, columnLabels } = data;
  const liabilities = sections.filter(s => s.side === 'liability');
  const assets = sections.filter(s => s.side === 'asset');
  const labelFor = (col: string): string => {
    if (columnLabels && columnLabels[col]) return columnLabels[col];
    if (bifurcated) return col === 'total' ? 'Total' : col;
    return reportView === 'monthly' ? getMonthLabel(col) : 'Closing';
  };
  const showTrailingTotal = !bifurcated && reportView === 'monthly';

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderRow = (row: BSSection, depth: number): ReactNode => {
    const hasChildren = !!(row.children && row.children.length > 0);
    const isOpen = expanded.has(row.key);
    const paddingLeft = 16 + depth * 20;
    const isParent = depth === 0;

    return (
      <Fragment key={row.key}>
        <tr
          className={`border-b border-dark-400/20 transition-colors ${
            hasChildren ? 'cursor-pointer hover:bg-dark-600/40' : 'hover:bg-dark-600/20'
          }`}
          onClick={hasChildren ? () => toggle(row.key) : undefined}
        >
          <td
            className={`py-2 sticky left-0 bg-dark-800 ${isParent ? 'font-semibold text-theme-primary' : 'font-normal text-[13px] text-theme-secondary'}`}
            style={{ paddingLeft, paddingRight: 16 }}
          >
            <span className="inline-flex items-center gap-1.5">
              {hasChildren ? (
                isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
              ) : (
                <span style={{ width: 14, display: 'inline-block' }} />
              )}
              {row.label}
            </span>
          </td>
          {columns.map(c => (
            <td
              key={c}
              className={`px-4 py-2 text-right font-mono ${isParent ? 'text-theme-primary font-semibold' : 'text-theme-secondary text-[13px]'}`}
            >
              {formatRs(row.values[c] || 0)}
            </td>
          ))}
          {showTrailingTotal && (
            <td className={`px-4 py-2 text-right font-mono ${isParent ? 'text-theme-primary font-semibold' : 'text-theme-secondary text-[13px]'}`}>
              {formatRs(row.grandTotal)}
            </td>
          )}
        </tr>
        {hasChildren && isOpen && row.children!.map(ch => renderRow(ch, depth + 1))}
      </Fragment>
    );
  };

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
              {showTrailingTotal && (
                <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Total</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => renderRow(row, 0))}
          </tbody>
          <tfoot>
            <tr className="bg-dark-700/80">
              <td className="px-4 py-2.5 font-semibold text-theme-primary sticky left-0 bg-dark-700/80">Total</td>
              {columns.map(c => (
                <td key={c} className={`px-4 py-2.5 text-right font-mono font-semibold ${accent}`}>
                  {formatRs(total[c] || 0)}
                </td>
              ))}
              {showTrailingTotal && <td></td>}
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
          As of {data.asOfDate} ·{' '}
          {bifurcated ? 'By company' : reportView === 'monthly' ? 'Monthly view' : 'Yearly view'}
        </span>
      </div>
      {renderSide('Liabilities & Equity', liabilities, totals.totalLiabilities, 'text-rose-300')}
      {renderSide('Assets', assets, totals.totalAssets, 'text-emerald-300')}
    </div>
  );
}
