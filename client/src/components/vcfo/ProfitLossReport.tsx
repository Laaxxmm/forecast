import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ChevronDown, Calculator, AlertTriangle, ArrowRight } from 'lucide-react';
import api from '../../api/client';
import { formatRs, getMonthLabel } from '../../pages/ForecastModulePage';
import StatementSearch, { filterSectionTree } from '../common/StatementSearch';
import {
  LOCATION_PALETTE,
  buildLocationGroups,
  buildSeparatorSet,
  fmtCell as fmtCellShared,
  separatorStyle,
  type LocationGroupResult,
} from './locationGrouping';

// ─── Adjustment types (mirrored from server vcfo-allocation-engine.ts) ──
interface AdjustmentEvent {
  ruleId: number;
  ruleName: string;
  ruleKind: 'pool_split' | 'cross_charge' | 'add_back';
  sourceCol: string;
  sourceLabel: string;
  destinationCol: string;
  destinationLabel: string;
  targetSectionKey: string;
  amount: number;
  basisNote?: string;
}

interface AdjustmentsBlock {
  events: AdjustmentEvent[];
  warnings: string[];
  adjusted: PLStatement;
}

// ─── Period-name formatting ───────────────────────────────────────────────
// Replaces the raw-ISO "2026-04-01 → 2027-03-31" in the card header with
// the same human-friendly string the picker shows in its selection bar.

const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function lastDayOfMonth(y: number, m1: number): number { return new Date(y, m1, 0).getDate(); }

function fyLabelFor(fromIso: string): string {
  const d = new Date(fromIso + 'T00:00:00');
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `FY ${String(y).slice(-2)}-${String(y + 1).slice(-2)}`;
}

/** Returns { name, subLine } for the period header. Single-month selection
 *  intentionally returns an empty subLine — the name itself already conveys
 *  the date (e.g. "September 2026"). */
function formatPeriodHeader(fromIso: string, toIso: string): { name: string; subLine: string } {
  const f = new Date(fromIso + 'T00:00:00');
  const t = new Date(toIso + 'T00:00:00');
  const fy = fyLabelFor(fromIso);
  const sameYear = f.getFullYear() === t.getFullYear();
  const sameMonth = sameYear && f.getMonth() === t.getMonth();

  // Single calendar month (Day-1 → last day of same month).
  if (sameMonth && f.getDate() === 1 && t.getDate() === lastDayOfMonth(t.getFullYear(), t.getMonth() + 1)) {
    return { name: `${FULL_MONTHS[f.getMonth()]} ${f.getFullYear()}`, subLine: '' };
  }

  // Indian-FY quarter spans (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar).
  const QUARTERS: Array<{ q: number; startMonth: number; endMonth: number; startYear: 'fy' | 'fyPlus1'; endYear: 'fy' | 'fyPlus1' }> = [
    { q: 1, startMonth: 3, endMonth: 5, startYear: 'fy', endYear: 'fy' },
    { q: 2, startMonth: 6, endMonth: 8, startYear: 'fy', endYear: 'fy' },
    { q: 3, startMonth: 9, endMonth: 11, startYear: 'fy', endYear: 'fy' },
    { q: 4, startMonth: 0, endMonth: 2, startYear: 'fyPlus1', endYear: 'fyPlus1' },
  ];
  const fyYear = parseInt(fyLabelFor(fromIso).slice(3, 5), 10) + 2000;
  for (const q of QUARTERS) {
    const startYearVal = q.startYear === 'fy' ? fyYear : fyYear + 1;
    const endYearVal = q.endYear === 'fy' ? fyYear : fyYear + 1;
    const expectedFrom = `${startYearVal}-${pad2(q.startMonth + 1)}-01`;
    const expectedTo = `${endYearVal}-${pad2(q.endMonth + 1)}-${pad2(lastDayOfMonth(endYearVal, q.endMonth + 1))}`;
    if (fromIso === expectedFrom && toIso === expectedTo) {
      const name = `Q${q.q} · ${SHORT_MONTHS[q.startMonth]}–${SHORT_MONTHS[q.endMonth]} ${endYearVal}`;
      const subLine = `${SHORT_MONTHS[q.startMonth]} ${startYearVal} – ${SHORT_MONTHS[q.endMonth]} ${endYearVal}`;
      return { name, subLine };
    }
  }

  // Full FY (Apr-1 → Mar-31 of fy+1).
  const fyStart = `${fyYear}-04-01`;
  const fyEnd = `${fyYear + 1}-03-31`;
  if (fromIso === fyStart && toIso === fyEnd) {
    return { name: `Full year · ${fy}`, subLine: `Apr ${fyYear} – Mar ${fyYear + 1}` };
  }

  // Anything else → Custom.
  const fmt = (d: Date) => `${pad2(d.getDate())} ${SHORT_MONTHS[d.getMonth()]}`;
  const name = `Custom · ${fmt(f)} – ${fmt(t)} ${t.getFullYear()}`;
  const subLine = `${fmt(f)} ${f.getFullYear()} – ${fmt(t)} ${t.getFullYear()}`;
  return { name, subLine };
}

// Local alias so the existing call sites (`fmtCell(...)`) keep compiling
// without churning the JSX diff. Shared implementation lives in
// ./locationGrouping.ts.
const fmtCell = fmtCellShared;

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
    stockOpening?: Record<string, number>;
    stockClosing?: Record<string, number>;
    cogs?: Record<string, number>;
  };
  grandTotals: {
    revenue: number;
    directCosts: number;
    indirectIncome: number;
    indirectExpenses: number;
    grossProfit: number;
    netProfit: number;
    stockOpening?: number;
    stockClosing?: number;
    cogs?: number;
  };
  /** Present when /profit-loss was called with ?withAdjustments=1. */
  adjustments?: AdjustmentsBlock;
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
  const [search, setSearch] = useState('');

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
    if (bifurcate) {
      params.bifurcate = 'true';
      // Adjustments only kick in for bifurcated views; ask for them at the
      // same time so the page can render the "true P&L" card below the
      // books table without a second round-trip.
      params.withAdjustments = '1';
    }
    api
      .get('/vcfo/profit-loss', { params })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, companyIds, from, to, view, bifurcate]);

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
  // Location-grouping useMemos also live above the early returns. Null-safe
  // against `data` so the first render (data still loading) doesn't crash.
  const groupResult = useMemo(
    () => data ? buildLocationGroups(data.columns, data.columnLabels, !!data.bifurcated) : null,
    [data],
  );
  const separatorAfterCol = useMemo(() => buildSeparatorSet(groupResult), [groupResult]);

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

  const { columns, computed, view: reportView, bifurcated, columnLabels } = data;
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

  // Show the COGS breakdown rows (Opening/Closing Stock + COGS subtotal) only
  // when this tenant actually carries inventory. Service-only companies
  // (clinics with zero Stock-in-Hand) skip it to avoid visual noise.
  const hasStock = columns.some(c =>
    (computed.stockOpening?.[c] ?? 0) !== 0 ||
    (computed.stockClosing?.[c] ?? 0) !== 0,
  );

  // `groupResult` + `separatorAfterCol` are computed above the early returns
  // (so the hook count stays stable across data-state transitions). Here we
  // only derive the display-order array, which is plain reassignment, not a
  // hook.
  const displayCols = groupResult ? groupResult.displayOrder : columns;

  // Period header strings (replaces the raw-ISO `from → to` line).
  const periodHeader = formatPeriodHeader(data.period.from, data.period.to);
  const companyCount = data.companies?.length ?? columns.filter(c => c !== 'total').length;

  const renderRow = (section: PLSection, depth: number): ReactNode => {
    const hasChildren = !!(section.children && section.children.length > 0);
    const isOpen = effectiveExpanded.has(section.key);
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
          {displayCols.map(c => (
            <td
              key={c}
              className={`px-4 py-2 text-right font-mono ${
                isParent ? 'font-semibold' : 'font-normal text-[13px]'
              } ${rowTextColor(section.isExpense)}`}
              style={separatorAfterCol.has(c) ? { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' } : undefined}
            >
              {fmtCell(section.values[c])}
            </td>
          ))}
          {showTrailingTotal && (
            <td
              className={`px-4 py-2 text-right font-mono ${
                isParent ? 'font-semibold' : 'font-normal text-[13px]'
              } ${rowTextColor(section.isExpense)}`}
            >
              {fmtCell(section.grandTotal)}
            </td>
          )}
        </tr>
        {hasChildren && isOpen &&
          section.children!.map(child => renderRow(child, depth + 1))}
      </Fragment>
    );
  };

  // Helper to render one card. Used twice: books (the as-booked view) and,
  // when allocation rules are present, the "true P&L" adjusted view below.
  // The two cards share the same column layout & search state but pull
  // their numbers from different statements. The renderer takes a triple
  // (sections, computed, grandTotals) so the same JSX renders either the
  // base PL or the post-rule adjusted PL without duplication.
  const renderCard = (
    src: { sections: PLSection[]; computed: PLStatement['computed']; grandTotals: PLStatement['grandTotals'] },
    title: string,
    subtitle: string | null,
    showSearch: boolean,
    highlight: boolean = false,
  ) => {
    const filtered = filterSectionTree(src.sections, search);
    const cardSections = filtered.sections;
    return (
    <div className={`bg-dark-800 border ${highlight ? 'border-accent-500/40' : 'border-dark-400/30'} rounded-2xl shadow-elev-2 overflow-hidden`}>
      {/* Card header — two-column layout. Left side identifies the report
          and the scope (company count + grouping); right side names the
          active period and its date range in human-friendly format. */}
      <div className="px-5 py-4 border-b border-dark-400/30 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[18px] font-medium text-theme-primary leading-tight">{title}</h3>
          <div className="text-[11px] text-theme-faint mt-0.5">
            {subtitle ?? (bifurcated
              ? `Across ${companyCount} ${companyCount === 1 ? 'company' : 'companies'} · grouped by location`
              : reportView === 'monthly' ? 'Monthly view' : 'Yearly view')}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[14px] font-medium text-theme-primary">{periodHeader.name}</div>
          {periodHeader.subLine && (
            <div className="text-[11px] text-theme-faint mt-0.5">{periodHeader.subLine}</div>
          )}
        </div>
      </div>
      {showSearch && (
      <div className="px-5 pt-3">
        <StatementSearch
          value={search}
          onChange={setSearch}
          placeholder="Find line item in P&L…"
          resultLabel={`${cardSections.length} of ${src.sections.length} sections`}
        />
      </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 1000 }}>
          <thead className="bg-dark-700">
            {groupResult ? (
              <>
                {/* Row 1: Particulars (spans both rows) + one cell per
                    location with colspan=cells.length. Tinted bg cycled
                    through LOCATION_PALETTE. Unparsed columns + the
                    optional 'total' column get a plain top header. */}
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
                {/* Row 2: Clinic / Pharmacy sub-headers under each location. */}
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
            {/* Sections render in order: Revenue, Direct Costs, Indirect Income,
                Indirect Expenses. The COGS breakdown (Opening Stock / Closing
                Stock / COGS subtotal) is injected immediately AFTER Direct
                Costs since COGS is conceptually `Direct Costs + Opening −
                Closing` — it belongs with the trading-account block, not
                after the indirect P&L items. Only renders for inventory-
                carrying tenants (hasStock). Negative values pass through
                unclamped to surface Tally data-quality signals. */}
            {cardSections.flatMap(section => {
              const sectionNode = renderRow(section, 0);
              if (!(hasStock && section.key === 'directCosts')) return sectionNode;
              return [
                sectionNode,
                <tr key="cogs-opening-stock" className="border-b border-dark-400/20 hover:bg-dark-600/20">
                  <td className="py-2 sticky left-0 bg-dark-800 font-normal text-[13px] text-rose-300" style={{ paddingLeft: 16, paddingRight: 16 }}>
                    <span className="inline-flex items-center gap-1.5">
                      <span style={{ width: 14, display: 'inline-block' }} />
                      + Opening Stock
                    </span>
                  </td>
                  {displayCols.map(c => {
                    const v = src.computed.stockOpening?.[c] ?? 0;
                    return (
                      <td
                        key={c}
                        className={`px-4 py-2 text-right font-mono font-normal text-[13px] ${v < 0 ? 'text-amber-400' : 'text-rose-300'}`}
                        style={separatorAfterCol.has(c) ? { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' } : undefined}
                      >
                        {fmtCell(v)}
                      </td>
                    );
                  })}
                  {showTrailingTotal && (
                    <td className="px-4 py-2 text-right font-mono font-normal text-[13px] text-rose-300">
                      {fmtCell(src.grandTotals.stockOpening)}
                    </td>
                  )}
                </tr>,
                <tr key="cogs-closing-stock" className="border-b border-dark-400/20 hover:bg-dark-600/20">
                  <td className="py-2 sticky left-0 bg-dark-800 font-normal text-[13px] text-emerald-300" style={{ paddingLeft: 16, paddingRight: 16 }}>
                    <span className="inline-flex items-center gap-1.5">
                      <span style={{ width: 14, display: 'inline-block' }} />
                      − Closing Stock
                    </span>
                  </td>
                  {displayCols.map(c => {
                    const v = src.computed.stockClosing?.[c] ?? 0;
                    return (
                      <td
                        key={c}
                        className={`px-4 py-2 text-right font-mono font-normal text-[13px] ${v < 0 ? 'text-amber-400' : 'text-emerald-300'}`}
                        style={separatorAfterCol.has(c) ? { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' } : undefined}
                      >
                        {fmtCell(v)}
                      </td>
                    );
                  })}
                  {showTrailingTotal && (
                    <td className="px-4 py-2 text-right font-mono font-normal text-[13px] text-emerald-300">
                      {fmtCell(src.grandTotals.stockClosing)}
                    </td>
                  )}
                </tr>,
                <tr key="cogs-subtotal" className="border-b border-dark-400/30 bg-dark-700/30">
                  <td className="px-4 py-2 font-semibold text-rose-200 sticky left-0 bg-dark-700/30">COGS</td>
                  {displayCols.map(c => (
                    <td
                      key={c}
                      className="px-4 py-2 text-right text-rose-200 font-mono font-semibold"
                      style={separatorAfterCol.has(c) ? { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' } : undefined}
                    >
                      {fmtCell(src.computed.cogs?.[c])}
                    </td>
                  ))}
                  {showTrailingTotal && (
                    <td className="px-4 py-2 text-right text-rose-200 font-mono font-semibold">
                      {fmtCell(src.grandTotals.cogs)}
                    </td>
                  )}
                </tr>,
              ];
            })}

            {/* Gross Profit line */}
            <tr className="bg-dark-700/50 border-b border-accent-500/30">
              <td className="px-4 py-2.5 font-semibold text-accent-300 sticky left-0 bg-dark-700/50">Gross Profit</td>
              {displayCols.map(c => (
                <td
                  key={c}
                  className="px-4 py-2.5 text-right text-accent-300 font-mono font-semibold"
                  style={separatorAfterCol.has(c) ? { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' } : undefined}
                >
                  {fmtCell(src.computed.grossProfit[c])}
                </td>
              ))}
              {showTrailingTotal && (
                <td className="px-4 py-2.5 text-right text-accent-300 font-mono font-semibold">
                  {fmtCell(src.grandTotals.grossProfit)}
                </td>
              )}
            </tr>

            {/* Gross Margin line */}
            <tr className="border-b border-dark-400/20">
              <td className="px-4 py-1.5 text-xs text-theme-faint sticky left-0 bg-dark-800">Gross Margin (%)</td>
              {displayCols.map(c => (
                <td
                  key={c}
                  className="px-4 py-1.5 text-right text-theme-faint font-mono text-xs"
                  style={separatorAfterCol.has(c) ? { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' } : undefined}
                >
                  {(src.computed.grossMargin[c] ?? 0).toFixed(2)}%
                </td>
              ))}
              {showTrailingTotal && <td></td>}
            </tr>
          </tbody>
          <tfoot>
            <tr className="bg-accent-500/10 border-t-2 border-accent-500/50">
              <td className="px-4 py-3 font-bold text-accent-300 sticky left-0 bg-accent-500/10">Net Profit</td>
              {displayCols.map(c => (
                <td
                  key={c}
                  className="px-4 py-3 text-right text-accent-300 font-mono font-bold"
                  style={separatorAfterCol.has(c) ? { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' } : undefined}
                >
                  {fmtCell(src.computed.netProfit[c])}
                </td>
              ))}
              {showTrailingTotal && (
                <td className="px-4 py-3 text-right text-accent-300 font-mono font-bold">
                  {fmtCell(src.grandTotals.netProfit)}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
    );
  };

  // Books table + (optional) Adjustments block + Adjusted "true P&L" table.
  // The adjustments block + adjusted card only render when the server
  // returned an `adjustments` payload (i.e. bifurcated view with rules
  // defined and enabled in this tenant).
  return (
    <div className="space-y-6">
      {renderCard(
        { sections: data.sections, computed, grandTotals: data.grandTotals },
        'Profit & Loss',
        null,
        true,
      )}
      {data.adjustments && data.adjustments.events.length > 0 && (
        <AdjustmentsBlockCard
          adjustments={data.adjustments}
          columnLabels={data.columnLabels}
          groupResult={groupResult}
          displayCols={displayCols}
          labelFor={labelFor}
          showTrailingTotal={showTrailingTotal}
          baseNetProfit={computed.netProfit}
        />
      )}
      {data.adjustments && data.adjustments.events.length > 0 && (
        <DeltaVsBooksCard
          base={{ netProfit: computed.netProfit, columns: data.columns }}
          adjusted={{ netProfit: data.adjustments.adjusted.computed.netProfit }}
          columnLabels={data.columnLabels}
          groupResult={groupResult}
        />
      )}
      {data.adjustments && data.adjustments.events.length > 0 && (
        renderCard(
          {
            sections: data.adjustments.adjusted.sections,
            computed: data.adjustments.adjusted.computed,
            grandTotals: data.adjustments.adjusted.grandTotals,
          },
          'True P&L (after adjustments)',
          `${data.adjustments.events.length} adjustment${data.adjustments.events.length === 1 ? '' : 's'} applied · ${companyCount} ${companyCount === 1 ? 'company' : 'companies'}`,
          false,
          true,
        )
      )}
      {data.adjustments && data.adjustments.events.length === 0 && (
        <div className="bg-dark-800 border border-dark-400/30 rounded-2xl px-5 py-4 text-sm text-theme-faint flex items-center justify-between">
          <span>
            No cost-allocation adjustments applied to this period. The view above is your true P&amp;L.
          </span>
          <Link to="/vcfo/cost-allocation" className="inline-flex items-center gap-1 text-accent-400 hover:text-accent-300 text-xs">
            <Calculator size={12} /> Manage rules
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── Adjustments Block card ──────────────────────────────────────────────
// Columnar table in the same shape as the P&L above (Particulars sticky +
// location-grouped company columns + Total). One row per rule, with each
// cell showing the NET adjustment delta at that company column.
//
// The "NET delta" is computed by summing all events for that (ruleId, col).
// The engine emits a "(pool drained)" event with -pool at the source so
// summing yields the true net impact (source loses pool, source gets back
// its kept share if it's also a destination, other destinations get their
// allocated share — sum at source = -(pool) + (kept share), sum at other
// dest = +(allocated share)).
//
// Sign convention: cells show the EXPENSE-side delta (matches the P&L
// table's expense rows). Positive = more expense at that company,
// negative = less expense at that company.

function AdjustmentsBlockCard(props: {
  adjustments: AdjustmentsBlock;
  columnLabels: Record<string, string> | undefined;
  groupResult: LocationGroupResult | null;
  displayCols: string[];
  labelFor: (col: string) => string;
  showTrailingTotal: boolean;
  baseNetProfit: Record<string, number>;
}) {
  const { adjustments, groupResult, displayCols, labelFor, showTrailingTotal, baseNetProfit } = props;
  const events = adjustments.events;
  const adjustedNetProfit = adjustments.adjusted.computed.netProfit;

  // Build per-rule per-column NET deltas by summing events.
  interface RuleSummary {
    ruleId: number;
    ruleName: string;
    ruleKind: 'pool_split' | 'cross_charge' | 'add_back';
    perCol: Record<string, number>;
  }
  const ruleSummaries: RuleSummary[] = [];
  const byRule = new Map<number, RuleSummary>();
  for (const ev of events) {
    // For multi-branch rules the engine prefixes the rule name with the
    // branch label (e.g. "Rent · BTM"). We want one ROW per rule (not per
    // branch), so peel that prefix off and aggregate.
    const dotIdx = ev.ruleName.indexOf(' · ');
    const ruleHeadline = dotIdx > 0 ? ev.ruleName.slice(0, dotIdx) : ev.ruleName;
    if (!byRule.has(ev.ruleId)) {
      const summary: RuleSummary = {
        ruleId: ev.ruleId,
        ruleName: ruleHeadline,
        ruleKind: ev.ruleKind,
        perCol: {},
      };
      byRule.set(ev.ruleId, summary);
      ruleSummaries.push(summary);
    }
    const s = byRule.get(ev.ruleId)!;
    s.perCol[ev.destinationCol] = (s.perCol[ev.destinationCol] || 0) + ev.amount;
  }

  // Compute the column-wise totals across all rules (renders as a footer row).
  const totalsPerCol: Record<string, number> = {};
  for (const s of ruleSummaries) {
    for (const [col, val] of Object.entries(s.perCol)) {
      totalsPerCol[col] = (totalsPerCol[col] || 0) + val;
    }
  }

  // Em-dash for zero cells (matches the P&L table convention).
  const fmtAdj = (v: number | undefined): string => {
    const n = Math.round(v || 0);
    if (n === 0) return '—';
    const sign = n < 0 ? '−' : '+';
    return `${sign}${formatRs(Math.abs(n))}`;
  };
  const toneClass = (v: number | undefined): string => {
    const n = v || 0;
    if (n === 0) return 'text-theme-faint';
    return n < 0 ? 'text-emerald-300' : 'text-rose-300';
  };

  // Net Profit is INCOME, so the colour convention flips vs the expense-delta
  // rows above: positive NP = good (emerald), negative = loss (rose). Values
  // are absolute rupees (not signed deltas).
  const fmtNP = (v: number | undefined): string => {
    const n = Math.round(v || 0);
    if (n === 0) return '—';
    return n < 0 ? `−${formatRs(Math.abs(n))}` : formatRs(n);
  };
  const npTone = (v: number | undefined): string => {
    const n = v || 0;
    if (n === 0) return 'text-theme-faint';
    return n < 0 ? 'text-rose-300' : 'text-emerald-300';
  };

  return (
    <div className="bg-dark-800 border border-amber-500/25 rounded-2xl shadow-elev-2 overflow-hidden">
      <div className="px-5 py-4 border-b border-dark-400/30 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[18px] font-medium text-theme-primary leading-tight flex items-center gap-2">
            <Calculator size={16} className="text-amber-400" />
            Adjustments
          </h3>
          <div className="text-[11px] text-theme-faint mt-0.5">
            {ruleSummaries.length} {ruleSummaries.length === 1 ? 'rule' : 'rules'} applied · cell = expense delta at that company (negative = expense reduced, positive = expense added)
          </div>
        </div>
        <Link to="/vcfo/cost-allocation" className="inline-flex items-center gap-1 text-accent-400 hover:text-accent-300 text-xs shrink-0">
          Manage rules <ArrowRight size={12} />
        </Link>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 1000 }}>
          <thead className="bg-dark-700">
            {groupResult ? (
              <>
                {/* Same two-row location-grouped header as the P&L. */}
                <tr className="text-xs font-semibold text-theme-muted uppercase tracking-wide">
                  <th
                    rowSpan={2}
                    className="text-left px-4 py-2.5 border-b border-dark-400/30 sticky left-0 bg-dark-700 z-10"
                  >
                    Rule
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
                <th className="text-left px-4 py-2.5 border-b border-dark-400/30 sticky left-0 bg-dark-700 z-10">Rule</th>
                {displayCols.map(c => (
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
            {ruleSummaries.map(s => (
              <tr key={s.ruleId} className="border-b border-dark-400/20 hover:bg-dark-600/20">
                <td className="py-2 sticky left-0 bg-dark-800 font-medium text-[13px] text-theme-primary" style={{ paddingLeft: 16, paddingRight: 16 }}>
                  <span className="inline-flex items-center gap-1.5">
                    {s.ruleName}
                    <span className={`px-1.5 py-0.5 rounded text-[9px] ${
                      s.ruleKind === 'add_back' ? 'bg-emerald-500/15 text-emerald-300'
                        : s.ruleKind === 'pool_split' ? 'bg-blue-500/15 text-blue-300'
                        : 'bg-purple-500/15 text-purple-300'}`}>
                      {s.ruleKind === 'add_back' ? 'Add-back' : s.ruleKind === 'pool_split' ? 'Pool split' : 'Cross-charge'}
                    </span>
                  </span>
                </td>
                {displayCols.map(c => (
                  <td
                    key={c}
                    className={`px-4 py-2 text-right font-mono text-[13px] ${toneClass(s.perCol[c])}`}
                    style={separatorBetweenLocationGroups(groupResult, c)}
                  >
                    {fmtAdj(s.perCol[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            {ruleSummaries.length > 1 && (
              <tr className="bg-dark-700/50 border-t-2 border-amber-500/30">
                <td className="px-4 py-2.5 font-semibold text-amber-300 sticky left-0 bg-dark-700/50 text-[13px]">
                  Net adjustments
                </td>
                {displayCols.map(c => (
                  <td
                    key={c}
                    className={`px-4 py-2.5 text-right font-mono font-semibold text-[13px] ${toneClass(totalsPerCol[c])}`}
                    style={separatorBetweenLocationGroups(groupResult, c)}
                  >
                    {fmtAdj(totalsPerCol[c])}
                  </td>
                ))}
              </tr>
            )}
            {/* Bottom line: books NP → adjusted NP, so the management view's
                effect on each company's profit reads off directly here. */}
            <tr className={`border-t border-dark-400/30 ${ruleSummaries.length > 1 ? '' : 'border-t-2 border-amber-500/30'}`}>
              <td className="px-4 py-2 text-theme-faint sticky left-0 bg-dark-800 text-[12px]">
                Net Profit · books
              </td>
              {displayCols.map(c => (
                <td
                  key={c}
                  className="px-4 py-2 text-right font-mono text-[12px] text-theme-faint"
                  style={separatorBetweenLocationGroups(groupResult, c)}
                >
                  {fmtNP(baseNetProfit[c])}
                </td>
              ))}
            </tr>
            <tr className="bg-accent-500/10 border-t border-accent-500/40">
              <td className="px-4 py-3 font-bold text-accent-300 sticky left-0 bg-accent-500/10 text-[13px]">
                Net Profit · after adjustments
              </td>
              {displayCols.map(c => (
                <td
                  key={c}
                  className={`px-4 py-3 text-right font-mono font-bold text-[13px] ${npTone(adjustedNetProfit[c])}`}
                  style={separatorBetweenLocationGroups(groupResult, c)}
                >
                  {fmtNP(adjustedNetProfit[c])}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {adjustments.warnings.length > 0 && (
        <div className="px-5 py-4 border-t border-dark-400/30">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-300 text-xs space-y-1">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle size={12} /> Engine warnings
            </div>
            <ul className="list-disc pl-4 space-y-0.5">
              {adjustments.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline separator-after-column style used by the Adjustments table.
 *  Mirrors the P&L's `separatorAfterCol` Set lookup but takes the groupResult
 *  directly so the Adjustments table doesn't need to be re-given the Set. */
function separatorBetweenLocationGroups(groupResult: LocationGroupResult | null, col: string): React.CSSProperties | undefined {
  if (!groupResult) return undefined;
  for (const g of groupResult.groups) {
    const last = g.cells[g.cells.length - 1];
    if (last && last.col === col) return { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' };
  }
  return undefined;
}

// ─── Delta vs Books card ─────────────────────────────────────────────────
// Compact card showing per-column Net Profit movement (adjusted − books).
// Positive deltas in emerald (gained money), negative in rose (gave money up).
// Companies are ordered to mirror the location-grouped table layout so the
// eye can scan the same column the user just looked at above.

function DeltaVsBooksCard(props: {
  base: { netProfit: Record<string, number>; columns: string[] };
  adjusted: { netProfit: Record<string, number> };
  columnLabels: Record<string, string> | undefined;
  groupResult: LocationGroupResult | null;
}) {
  const { base, adjusted, columnLabels, groupResult } = props;

  // Skip the 'total' column — it's zero-sum across cost-allocation rules.
  // We surface per-company deltas only.
  const ordered = (groupResult ? groupResult.displayOrder : base.columns).filter(c => c !== 'total');

  const labelOf = (col: string) => columnLabels?.[col] || col;
  const deltas = ordered.map(col => ({
    col,
    delta: (adjusted.netProfit[col] || 0) - (base.netProfit[col] || 0),
    baseNP: base.netProfit[col] || 0,
    adjustedNP: adjusted.netProfit[col] || 0,
  }));

  const maxAbsDelta = Math.max(1, ...deltas.map(d => Math.abs(d.delta)));
  const movers = deltas.filter(d => Math.abs(d.delta) > 1).length;

  return (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      <div className="px-5 py-4 border-b border-dark-400/30">
        <h3 className="text-[18px] font-medium text-theme-primary leading-tight">Net Profit Delta (vs books)</h3>
        <div className="text-[11px] text-theme-faint mt-0.5">
          {movers} {movers === 1 ? 'company' : 'companies'} shifted by allocation rules · positive = gained, negative = absorbed
        </div>
      </div>
      <div className="px-5 py-4">
        <div className="space-y-1.5">
          {deltas.map(d => {
            const pct = (Math.abs(d.delta) / maxAbsDelta) * 100;
            const isPositive = d.delta > 0;
            const isZero = Math.abs(d.delta) <= 1;
            return (
              <div key={d.col} className="grid grid-cols-[1fr_auto_120px_auto] gap-2 items-center text-xs">
                <span className="text-theme-muted truncate">{labelOf(d.col)}</span>
                <span className={`font-mono ${isZero ? 'text-theme-faint' : isPositive ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {isZero ? '—' : `${isPositive ? '+' : '−'}${formatRs(Math.abs(d.delta))}`}
                </span>
                <div className="relative h-1.5 bg-dark-700 rounded-full">
                  <div
                    className={`absolute top-0 h-full rounded-full ${isPositive ? 'bg-emerald-400/60' : 'bg-rose-400/60'}`}
                    style={{
                      width: `${pct / 2}%`,
                      // Centre the bar at 50%; positive grows right, negative grows left.
                      left: isPositive ? '50%' : `${50 - pct / 2}%`,
                    }}
                  />
                  <div className="absolute top-0 h-full w-px bg-dark-400/60" style={{ left: '50%' }} />
                </div>
                <span className="text-theme-faint font-mono text-right" style={{ minWidth: 60 }}>
                  → {formatRs(d.adjustedNP)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
