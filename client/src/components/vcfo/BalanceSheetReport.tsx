import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import api from '../../api/client';
import { getMonthLabel } from '../../pages/ForecastModulePage';
import StatementSearch, { filterSectionTree } from '../common/StatementSearch';
import {
  LOCATION_PALETTE,
  buildLocationGroups,
  buildSeparatorSet,
  fmtCell,
  separatorStyle,
  type LocationGroupResult,
} from './locationGrouping';

// Format "2027-03-31" → "31 Mar 2027" for the BS as-of header.
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatAsOfDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

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
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!companyId && !companyIds) {
      setData(null);
      return;
    }
    if (!asOf) return;
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

  // ── Hooks must run on every render — see React error #310 ────────────────
  // Hoisted above the loading / error / no-data early returns so the hook
  // count stays stable across data-state transitions.
  const allSections = data?.sections ?? [];
  const { sections, expandKeys } = useMemo(
    () => filterSectionTree(allSections, search),
    [allSections, search]
  );
  const effectiveExpanded = useMemo(() => {
    if (!search.trim()) return expanded;
    const next = new Set(expanded);
    expandKeys.forEach(k => next.add(k));
    return next;
  }, [expanded, expandKeys, search]);
  // Location-grouping useMemos hoisted here (above the early returns) so
  // the hook count stays stable across data-state transitions. Null-safe
  // against `data` so the loading-state render doesn't crash.
  const groupResult: LocationGroupResult | null = useMemo(
    () => data ? buildLocationGroups(data.columns, data.columnLabels, !!data.bifurcated) : null,
    [data],
  );
  const separatorAfterCol = useMemo(() => buildSeparatorSet(groupResult), [groupResult]);

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

  const { columns, totals, view: reportView, bifurcated, columnLabels } = data;
  const liabilities = sections.filter(s => s.side === 'liability');
  const assets = sections.filter(s => s.side === 'asset');
  const labelFor = (col: string): string => {
    if (columnLabels && columnLabels[col]) return columnLabels[col];
    if (bifurcated) return col === 'total' ? 'Total' : col;
    return reportView === 'monthly' ? getMonthLabel(col) : 'Closing';
  };
  const showTrailingTotal = !bifurcated && reportView === 'monthly';

  // `groupResult` + `separatorAfterCol` are computed above the early returns
  // (so the hook count stays stable). Here we only derive the display-order
  // array, which is plain reassignment, not a hook.
  const displayCols = groupResult ? groupResult.displayOrder : columns;
  const companyCount = data.companies?.length ?? columns.filter(c => c !== 'total').length;

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
    const isOpen = effectiveExpanded.has(row.key);
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
          {displayCols.map(c => (
            <td
              key={c}
              className={`px-4 py-2 text-right font-mono ${isParent ? 'text-theme-primary font-semibold' : 'text-theme-secondary text-[13px]'}`}
              style={separatorStyle(separatorAfterCol, c)}
            >
              {fmtCell(row.values[c])}
            </td>
          ))}
          {showTrailingTotal && (
            <td className={`px-4 py-2 text-right font-mono ${isParent ? 'text-theme-primary font-semibold' : 'text-theme-secondary text-[13px]'}`}>
              {fmtCell(row.grandTotal)}
            </td>
          )}
        </tr>
        {hasChildren && isOpen && row.children!.map(ch => renderRow(ch, depth + 1))}
      </Fragment>
    );
  };

  const renderSide = (title: string, rows: BSSection[], total: Record<string, number>, accent: string) => (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      {/* Card header — title on left, optional sub-line on right with the
          company count + grouping descriptor. Mirrors the P&L card. */}
      <div className="px-5 py-3 border-b border-dark-400/30 flex items-center justify-between">
        <h3 className={`text-sm font-semibold ${accent}`}>{title}</h3>
        {bifurcated && (
          <span className="text-[11px] text-theme-faint">
            Across {companyCount} {companyCount === 1 ? 'company' : 'companies'} · grouped by location
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 1000 }}>
          <thead className="bg-dark-700">
            {groupResult ? (
              <>
                <tr className="text-xs font-semibold text-theme-muted uppercase tracking-wide">
                  <th
                    rowSpan={2}
                    className="text-left px-4 py-2.5 border-b border-dark-400/30 sticky left-0 bg-dark-700 z-10"
                  >
                    Particulars
                  </th>
                  {groupResult.groups.map(g => (
                    <th
                      key={g.location}
                      colSpan={g.cells.length}
                      className="px-2 py-2 text-center border-b border-dark-400/30"
                      style={{
                        background: LOCATION_PALETTE[g.paletteIndex],
                        color: '#1f2937',
                        borderRight: '0.5px solid rgba(148, 163, 184, 0.25)',
                        fontSize: 11,
                      }}
                    >
                      {g.location}
                    </th>
                  ))}
                  {groupResult.unparsedCols.map(c => (
                    <th key={c} rowSpan={2} className="text-right px-4 py-2.5 border-b border-dark-400/30 whitespace-nowrap">
                      {labelFor(c)}
                    </th>
                  ))}
                  {groupResult.totalCol && (
                    <th rowSpan={2} className="text-right px-4 py-2.5 border-b border-dark-400/30">
                      Total
                    </th>
                  )}
                </tr>
                <tr className="text-[10px] font-normal text-theme-secondary uppercase tracking-wide">
                  {groupResult.groups.flatMap(g =>
                    g.cells.map((cell, i) => (
                      <th
                        key={cell.col}
                        className="text-right px-3 py-1.5 border-b border-dark-400/30"
                        style={{
                          background: LOCATION_PALETTE[g.paletteIndex],
                          color: '#374151',
                          borderRight: i === g.cells.length - 1 ? '0.5px solid rgba(148, 163, 184, 0.25)' : undefined,
                        }}
                      >
                        {cell.entityType}
                      </th>
                    ))
                  )}
                </tr>
              </>
            ) : (
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
            )}
          </thead>
          <tbody>
            {rows.map(row => renderRow(row, 0))}
          </tbody>
          <tfoot>
            <tr className="bg-dark-700/80">
              <td className="px-4 py-2.5 font-semibold text-theme-primary sticky left-0 bg-dark-700/80">Total</td>
              {displayCols.map(c => (
                <td
                  key={c}
                  className={`px-4 py-2.5 text-right font-mono font-semibold ${accent}`}
                  style={separatorStyle(separatorAfterCol, c)}
                >
                  {fmtCell(total[c])}
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
      {/* Top header — two-column layout. Left names the report + scope;
          right shows the as-of date in human format. Mirrors the P&L
          card header structure for consistency across vCFO tabs. */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[18px] font-medium text-theme-primary leading-tight">Balance Sheet</h3>
          <div className="text-[11px] text-theme-faint mt-0.5">
            {bifurcated
              ? `Across ${companyCount} ${companyCount === 1 ? 'company' : 'companies'} · grouped by location`
              : reportView === 'monthly' ? 'Monthly view' : 'Yearly view'}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[14px] font-medium text-theme-primary">As of {formatAsOfDate(data.asOfDate)}</div>
        </div>
      </div>
      <StatementSearch
        value={search}
        onChange={setSearch}
        placeholder="Find line item in Balance Sheet…"
        resultLabel={`${sections.length} of ${allSections.length} sections`}
      />
      {renderSide('Liabilities & Equity', liabilities, totals.totalLiabilities, 'text-rose-300')}
      {renderSide('Assets', assets, totals.totalAssets, 'text-emerald-300')}
    </div>
  );
}
