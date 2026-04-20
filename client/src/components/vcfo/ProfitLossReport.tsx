import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import api from '../../api/client';
import { formatRs, getMonthLabel } from '../../pages/ForecastModulePage';

interface PLSection {
  key: string;
  label: string;
  isExpense: boolean;
  values: Record<string, number>;
  grandTotal: number;
  children?: PLSection[];
}

interface PLStatement {
  period: { from: string; to: string };
  view: 'yearly' | 'monthly';
  columns: string[];
  columnLabels?: Record<string, string>;
  bifurcated?: boolean;
  companies?: Array<{ id: number; name: string }>;
  sections: PLSection[];
  computed: {
    grossProfit: Record<string, number>;
    grossMargin: Record<string, number>;
    netProfit: Record<string, number>;
  };
  grandTotals: {
    revenue: number;
    directCosts: number;
    indirectIncome: number;
    indirectExpenses: number;
    grossProfit: number;
    netProfit: number;
  };
}

interface Props {
  companyId: number | null;
  companyIds?: string | null;
  from: string;
  to: string;
  view: 'yearly' | 'monthly';
  bifurcate?: boolean;
}

export default function ProfitLossReport({ companyId, companyIds, from, to, view, bifurcate }: Props) {
  const [data, setData] = useState<PLStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!companyId && !companyIds) {
      setData(null);
      return;
    }
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    const params: Record<string, any> = { from, to, view };
    if (companyId) params.companyId = companyId;
    else if (companyIds) params.companyIds = companyIds;
    if (bifurcate) params.bifurcate = 'true';
    api
      .get('/vcfo/profit-loss', { params })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, companyIds, from, to, view, bifurcate]);

  if (!companyId && !companyIds) {
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

  const { columns, sections, computed, view: reportView, bifurcated, columnLabels } = data;
  const labelFor = (col: string): string => {
    if (columnLabels && columnLabels[col]) return columnLabels[col];
    if (bifurcated) return col === 'total' ? 'Total' : col;
    return reportView === 'monthly' ? getMonthLabel(col) : 'Total';
  };

  const rowTextColor = (isExpense: boolean) =>
    isExpense ? 'text-rose-300' : 'text-emerald-300';

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // "Total" trailing column only makes sense for single-period monthly view;
  // bifurcation already carries its own `total` column from the server.
  const showTrailingTotal = !bifurcated && reportView === 'monthly';

  const renderRow = (section: PLSection, depth: number): ReactNode => {
    const hasChildren = !!(section.children && section.children.length > 0);
    const isOpen = expanded.has(section.key);
    const paddingLeft = 16 + depth * 20;
    const isParent = depth === 0;

    return (
      <Fragment key={section.key}>
        <tr
          className={`border-b border-dark-400/20 transition-colors ${
            hasChildren ? 'cursor-pointer hover:bg-dark-600/40' : 'hover:bg-dark-600/20'
          }`}
          onClick={hasChildren ? () => toggle(section.key) : undefined}
        >
          <td
            className={`py-2 sticky left-0 bg-dark-800 ${
              isParent ? 'font-semibold' : 'font-normal text-[13px]'
            } ${rowTextColor(section.isExpense)}`}
            style={{ paddingLeft, paddingRight: 16 }}
          >
            <span className="inline-flex items-center gap-1.5">
              {hasChildren ? (
                isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
              ) : (
                <span style={{ width: 14, display: 'inline-block' }} />
              )}
              {section.label}
            </span>
          </td>
          {columns.map(c => (
            <td
              key={c}
              className={`px-4 py-2 text-right font-mono ${
                isParent ? 'font-semibold' : 'font-normal text-[13px]'
              } ${rowTextColor(section.isExpense)}`}
            >
              {formatRs(section.values[c] || 0)}
            </td>
          ))}
          {showTrailingTotal && (
            <td
              className={`px-4 py-2 text-right font-mono ${
                isParent ? 'font-semibold' : 'font-normal text-[13px]'
              } ${rowTextColor(section.isExpense)}`}
            >
              {formatRs(section.grandTotal)}
            </td>
          )}
        </tr>
        {hasChildren && isOpen &&
          section.children!.map(child => renderRow(child, depth + 1))}
      </Fragment>
    );
  };

  return (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      <div className="px-5 py-3 border-b border-dark-400/30 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme-primary">Profit &amp; Loss</h3>
        <span className="text-xs text-theme-faint">
          {data.period.from} → {data.period.to} ·{' '}
          {bifurcated ? 'By company' : reportView === 'monthly' ? 'Monthly view' : 'Yearly view'}
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
              {showTrailingTotal && (
                <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Total</th>
              )}
            </tr>
          </thead>
          <tbody>
            {sections.map(section => renderRow(section, 0))}

            {/* Gross Profit line */}
            <tr className="bg-dark-700/50 border-b border-accent-500/30">
              <td className="px-4 py-2.5 font-semibold text-accent-300 sticky left-0 bg-dark-700/50">Gross Profit</td>
              {columns.map(c => (
                <td key={c} className="px-4 py-2.5 text-right text-accent-300 font-mono font-semibold">
                  {formatRs(computed.grossProfit[c] || 0)}
                </td>
              ))}
              {showTrailingTotal && (
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
              {showTrailingTotal && <td></td>}
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
              {showTrailingTotal && (
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
