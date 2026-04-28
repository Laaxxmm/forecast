import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import api from '../../api/client';
import { formatRs } from '../../pages/ForecastModulePage';
import StatementSearch, { filterSectionTree } from '../common/StatementSearch';

interface CFLine {
  label: string;
  amount: number;
  values?: Record<string, number>;
  children?: CFLine[];
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

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

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const columns = data.columns && data.bifurcated ? data.columns : null;
  const labelFor = (col: string): string => data.columnLabels?.[col] || (col === 'total' ? 'Total' : col);

  // Find-in-statement search prunes the three activity sections (Operating /
  // Investing / Financing) to matching subtrees. Subtotals stay accurate
  // because they come from data.*TotalValues precomputed on the server.
  // CFLine has { label, children? } so it's compatible with filterSectionTree
  // (the helper only reads `key`, `label`, `children`); we synthesize a key
  // from the label to satisfy the type.
  const synth = (lines: CFLine[]): any[] =>
    lines.map((l, i) => ({ ...l, key: `${l.label}-${i}`, children: l.children ? synth(l.children) : undefined }));
  const operating = useMemo(
    () => filterSectionTree(synth(data.operating), search).sections as unknown as CFLine[],
    [data.operating, search]
  );
  const investing = useMemo(
    () => filterSectionTree(synth(data.investing), search).sections as unknown as CFLine[],
    [data.investing, search]
  );
  const financing = useMemo(
    () => filterSectionTree(synth(data.financing), search).sections as unknown as CFLine[],
    [data.financing, search]
  );
  const totalAllLines = data.operating.length + data.investing.length + data.financing.length;
  const totalVisibleLines = operating.length + investing.length + financing.length;

  // Bifurcated layout — table with one column per company + total.
  if (columns) {
    const renderLine = (sectionKey: string, line: CFLine, idx: number, depth: number): ReactNode => {
      const hasChildren = !!(line.children && line.children.length > 0);
      const rowKey = `${sectionKey}:${line.label}-${idx}`;
      const isOpen = expanded.has(rowKey);
      const paddingLeft = 16 + depth * 20;
      const isParent = depth === 0;

      return (
        <Fragment key={rowKey}>
          <tr
            className={`border-b border-dark-400/20 transition-colors ${
              hasChildren ? 'cursor-pointer hover:bg-dark-600/40' : 'hover:bg-dark-600/20'
            }`}
            onClick={hasChildren ? () => toggle(rowKey) : undefined}
          >
            <td
              className={`py-2 sticky left-0 bg-dark-800 ${
                isParent ? 'text-theme-secondary' : 'text-[13px] text-theme-faint'
              }`}
              style={{ paddingLeft, paddingRight: 16 }}
            >
              <span className="inline-flex items-center gap-1.5">
                {hasChildren ? (
                  isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                ) : (
                  <span style={{ width: 14, display: 'inline-block' }} />
                )}
                {line.label}
              </span>
            </td>
            {columns.map(c => {
              const v = line.values?.[c] ?? (c === 'total' ? line.amount : 0);
              return (
                <td
                  key={c}
                  className={`px-4 py-2 text-right font-mono ${
                    isParent ? '' : 'text-[13px]'
                  } ${v >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
                >
                  {formatRs(v)}
                </td>
              );
            })}
          </tr>
          {hasChildren && isOpen && line.children!.map((child, ci) =>
            renderLine(rowKey, child, ci, depth + 1),
          )}
        </Fragment>
      );
    };

    const renderSection = (
      title: string,
      sectionKey: string,
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
                lines.map((line, i) => renderLine(sectionKey, line, i, 0))
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
        <StatementSearch
          value={search}
          onChange={setSearch}
          placeholder="Find activity in Cash Flow…"
          resultLabel={`${totalVisibleLines} of ${totalAllLines} top-level lines`}
        />

        {renderSection('Operating Activities', 'op', operating, data.operatingTotalValues, 'text-emerald-300')}
        {renderSection('Investing Activities', 'inv', investing, data.investingTotalValues, 'text-sky-300')}
        {renderSection('Financing Activities', 'fin', financing, data.financingTotalValues, 'text-violet-300')}

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

  // Single-column (consolidated or single-company) layout.
  const renderLineSingle = (sectionKey: string, line: CFLine, idx: number, depth: number): ReactNode => {
    const hasChildren = !!(line.children && line.children.length > 0);
    const rowKey = `${sectionKey}:${line.label}-${idx}`;
    const isOpen = expanded.has(rowKey);
    const paddingLeft = 16 + depth * 20;
    const isParent = depth === 0;

    return (
      <Fragment key={rowKey}>
        <tr
          className={`border-b border-dark-400/20 transition-colors ${
            hasChildren ? 'cursor-pointer hover:bg-dark-600/40' : 'hover:bg-dark-600/30'
          }`}
          onClick={hasChildren ? () => toggle(rowKey) : undefined}
        >
          <td
            className={`py-2 pr-4 ${isParent ? 'text-theme-secondary' : 'text-[13px] text-theme-faint'}`}
            style={{ paddingLeft }}
          >
            <span className="inline-flex items-center gap-1.5">
              {hasChildren ? (
                isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
              ) : (
                <span style={{ width: 14, display: 'inline-block' }} />
              )}
              {line.label}
            </span>
          </td>
          <td
            className={`px-4 py-2 text-right font-mono ${isParent ? '' : 'text-[13px]'} ${
              line.amount >= 0 ? 'text-emerald-300' : 'text-rose-300'
            }`}
          >
            {formatRs(line.amount)}
          </td>
        </tr>
        {hasChildren && isOpen && line.children!.map((child, ci) =>
          renderLineSingle(rowKey, child, ci, depth + 1),
        )}
      </Fragment>
    );
  };

  const renderSection = (title: string, sectionKey: string, lines: CFLine[], total: number, accent: string) => (
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
            lines.map((line, i) => renderLineSingle(sectionKey, line, i, 0))
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
      <StatementSearch
        value={search}
        onChange={setSearch}
        placeholder="Find activity in Cash Flow…"
        resultLabel={`${totalVisibleLines} of ${totalAllLines} top-level lines`}
      />

      {renderSection('Operating Activities', 'op', operating, data.operatingTotal, 'text-emerald-300')}
      {renderSection('Investing Activities', 'inv', investing, data.investingTotal, 'text-sky-300')}
      {renderSection('Financing Activities', 'fin', financing, data.financingTotal, 'text-violet-300')}

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
