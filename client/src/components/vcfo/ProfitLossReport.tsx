import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import api from '../../api/client';
import { formatRs, getMonthLabel } from '../../pages/ForecastModulePage';
import StatementSearch, { filterSectionTree } from '../common/StatementSearch';

// ─── Location grouping helpers ────────────────────────────────────────────
// Bifurcated P&L columns arrive as 'co:336' with friendly labels in
// `columnLabels` like "ASHOK NAGAR · PHARMACY". We group these by location
// alphabetically so the user can compare a single location's Clinic and
// Pharmacy side by side instead of hunting across a flat 15-column table.

/** Soft-tinted palette cycled per location to make group boundaries scan. */
const LOCATION_PALETTE = [
  '#EAF3DE', // green
  '#E6F1FB', // blue
  '#EEEDFE', // purple
  '#FAEEDA', // amber
  '#FAECE7', // coral
];

/** Display-only normalisations for known typos in the source data.
 *  Underlying column keys (co:NNN) stay as-is to avoid breaking the query. */
const LOCATION_DISPLAY_FIXES: Record<string, string> = {
  'Jubliee Hills': 'Jubilee Hills',
};

interface ParsedColumnLabel {
  location: string;     // Title-cased + typo-normalised
  entityType: string;   // 'Clinic' | 'Pharmacy' | anything else found
}

/** Parse "ASHOK NAGAR · PHARMACY" → { location: "Ashok Nagar", entityType: "Pharmacy" }. */
function parseColumnLabel(label: string): ParsedColumnLabel | null {
  const parts = label.split('·').map(s => s.trim());
  if (parts.length !== 2) return null;
  const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const rawLocation = titleCase(parts[0]);
  const location = LOCATION_DISPLAY_FIXES[rawLocation] || rawLocation;
  const entityType = titleCase(parts[1]);
  return { location, entityType };
}

interface LocationGroup {
  location: string;
  paletteIndex: number;
  cells: Array<{ col: string; entityType: string }>;
}

/**
 * Build location-grouped column layout. Returns:
 *  - `groups` ordered alphabetically by location, with Clinic before Pharmacy
 *    inside each group; only includes columns that successfully parse as
 *    "<location> · <entityType>".
 *  - `unparsedCols` for any column that didn't match (rendered as-is at the
 *    end, before the optional `totalCol`).
 *  - `totalCol` lifted out so the renderer can put it after the groups.
 *  - `displayOrder` = the new flat column order to iterate in tbody.
 *
 *  If `bifurcated` is false (single-tenant view or monthly columns), the
 *  function returns nothing and the renderer falls back to the original
 *  flat layout — location grouping only makes sense when columns ARE
 *  multiple companies.
 */
function buildLocationGroups(
  columns: string[],
  columnLabels: Record<string, string> | undefined,
  bifurcated: boolean,
): {
  groups: LocationGroup[];
  unparsedCols: string[];
  totalCol: string | null;
  displayOrder: string[];
} | null {
  if (!bifurcated || !columnLabels) return null;
  const groupMap = new Map<string, Array<{ col: string; entityType: string }>>();
  const unparsedCols: string[] = [];
  let totalCol: string | null = null;
  for (const col of columns) {
    if (col === 'total') { totalCol = col; continue; }
    const label = columnLabels[col];
    if (!label) { unparsedCols.push(col); continue; }
    const parsed = parseColumnLabel(label);
    if (!parsed) { unparsedCols.push(col); continue; }
    if (!groupMap.has(parsed.location)) groupMap.set(parsed.location, []);
    groupMap.get(parsed.location)!.push({ col, entityType: parsed.entityType });
  }
  if (groupMap.size === 0) return null;
  const sortedLocations = [...groupMap.keys()].sort((a, b) => a.localeCompare(b));
  const groups: LocationGroup[] = sortedLocations.map((location, i) => {
    const cells = groupMap.get(location)!.sort((a, b) => {
      // Clinic before Pharmacy; other entity types keep insertion order
      // but sort to the end alphabetically.
      const rank = (t: string) => t === 'Clinic' ? 0 : t === 'Pharmacy' ? 1 : 2 + t.charCodeAt(0);
      return rank(a.entityType) - rank(b.entityType);
    });
    return { location, paletteIndex: i % LOCATION_PALETTE.length, cells };
  });
  const displayOrder = [
    ...groups.flatMap(g => g.cells.map(c => c.col)),
    ...unparsedCols,
    ...(totalCol ? [totalCol] : []),
  ];
  return { groups, unparsedCols, totalCol, displayOrder };
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

/** Currency formatter that returns "—" for zero/empty instead of "Rs0".
 *  Negative values still pass through formatRs (we want them visible as a
 *  Tally data-quality signal). */
function fmtCell(v: number | undefined | null): string {
  const n = Number(v) || 0;
  if (n === 0) return '—';
  return formatRs(n);
}

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
    if (bifurcate) params.bifurcate = 'true';
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

  // Try to group columns by location for bifurcated multi-tenant views.
  // null = grouping doesn't apply (single tenant, monthly columns, or
  // columnLabels don't parse) → fall back to flat layout.
  const groupResult = useMemo(
    () => buildLocationGroups(columns, columnLabels, !!bifurcated),
    [columns, columnLabels, bifurcated],
  );
  const displayCols = groupResult ? groupResult.displayOrder : columns;
  // How many vertical separator borders to draw — one at the end of each
  // location group's last sub-cell.
  const separatorAfterCol = useMemo(() => {
    const set = new Set<string>();
    if (!groupResult) return set;
    for (const g of groupResult.groups) {
      const last = g.cells[g.cells.length - 1];
      if (last) set.add(last.col);
    }
    return set;
  }, [groupResult]);

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

  return (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      {/* Card header — two-column layout. Left side identifies the report
          and the scope (company count + grouping); right side names the
          active period and its date range in human-friendly format. */}
      <div className="px-5 py-4 border-b border-dark-400/30 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[18px] font-medium text-theme-primary leading-tight">Profit &amp; Loss</h3>
          <div className="text-[11px] text-theme-faint mt-0.5">
            {bifurcated
              ? `Across ${companyCount} ${companyCount === 1 ? 'company' : 'companies'} · grouped by location`
              : reportView === 'monthly' ? 'Monthly view' : 'Yearly view'}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[14px] font-medium text-theme-primary">{periodHeader.name}</div>
          {periodHeader.subLine && (
            <div className="text-[11px] text-theme-faint mt-0.5">{periodHeader.subLine}</div>
          )}
        </div>
      </div>
      <div className="px-5 pt-3">
        <StatementSearch
          value={search}
          onChange={setSearch}
          placeholder="Find line item in P&L…"
          resultLabel={`${sections.length} of ${allSections.length} sections`}
        />
      </div>
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
            {sections.flatMap(section => {
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
                    const v = computed.stockOpening?.[c] ?? 0;
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
                      {fmtCell(data.grandTotals.stockOpening)}
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
                    const v = computed.stockClosing?.[c] ?? 0;
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
                      {fmtCell(data.grandTotals.stockClosing)}
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
                      {fmtCell(computed.cogs?.[c])}
                    </td>
                  ))}
                  {showTrailingTotal && (
                    <td className="px-4 py-2 text-right text-rose-200 font-mono font-semibold">
                      {fmtCell(data.grandTotals.cogs)}
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
                  {fmtCell(computed.grossProfit[c])}
                </td>
              ))}
              {showTrailingTotal && (
                <td className="px-4 py-2.5 text-right text-accent-300 font-mono font-semibold">
                  {fmtCell(data.grandTotals.grossProfit)}
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
                  {(computed.grossMargin[c] ?? 0).toFixed(2)}%
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
                  {fmtCell(computed.netProfit[c])}
                </td>
              ))}
              {showTrailingTotal && (
                <td className="px-4 py-3 text-right text-accent-300 font-mono font-bold">
                  {fmtCell(data.grandTotals.netProfit)}
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
