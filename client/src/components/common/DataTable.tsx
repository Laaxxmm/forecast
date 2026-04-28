// ─────────────────────────────────────────────────────────────────────────────
// Shared DataTable component
//
// Drop-in replacement for hand-written <table> blocks across the app. Provides:
//   • Global search box (searches across all filterable columns)
//   • Per-column filter popovers (text contains / number min-max / date from-to)
//   • Active filter chips with one-click removal
//   • Click-to-sort column headers (asc → desc → none)
//   • Pagination
//   • Row-level styling hook (rowClassName) for things like loss-row tinting
//   • Custom cell rendering preserved via the `render` prop on each column
//
// Filtering is client-side. The current tables in this app are all under a few
// thousand rows, so this is fine.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState, useRef, useEffect } from 'react';
import { Search, Filter, X, ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatINR, formatNumber } from '../../utils/format';

export type ColumnType = 'text' | 'number' | 'date' | 'custom';
export type ColumnFormat = 'currency' | 'number' | 'percent' | 'date';
export type Align = 'left' | 'center' | 'right';

export interface ColumnDef<T = any> {
  /** Stable key — used for filter state, sort state, and React keys. */
  key: string;
  /** Display text in the column header. */
  header: string;
  /** Column type drives the filter UI. `custom` disables filtering and sorting. Default 'text'. */
  type?: ColumnType;
  /**
   * Extracts the filterable/sortable value from a row.
   * Defaults to `row[key]`. Override when the cell is a computed value
   * (e.g. Gross Profit derived from sales − tax − cogs).
   */
  accessor?: (row: T) => string | number | Date | null | undefined;
  /** Custom cell renderer. Defaults to formatted accessor value. */
  render?: (row: T) => React.ReactNode;
  /** Auto-format hint when no `render` is provided. */
  format?: ColumnFormat;
  /** Tailwind class applied to the <th>/<td> for width control. */
  width?: string;
  /** Cell text alignment. Default 'left' (auto-right for currency/number/percent). */
  align?: Align;
  /** Disable filtering on this column (e.g. action-button columns). Default true. */
  filterable?: boolean;
  /** Disable sorting on this column. Default = filterable. */
  sortable?: boolean;
  /** Optional className applied to the <td> for this column. */
  cellClassName?: string;
}

export interface DataTableProps<T = any> {
  columns: ColumnDef<T>[];
  rows: T[];
  /** Default 50. Pass 0 to disable pagination. */
  pageSize?: number;
  /** Show the global search box at the top. Default true. */
  globalSearch?: boolean;
  /** Initial sort. */
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** Empty-state message when filters produce no rows. */
  emptyMessage?: string;
  /** Row-level CSS class hook (e.g. tint loss-making rows). */
  rowClassName?: (row: T) => string | undefined;
  /** Optional toolbar content rendered above the table (right-aligned). */
  toolbar?: React.ReactNode;
  /** 'compact' uses tighter padding. Default 'normal'. */
  density?: 'compact' | 'normal';
  /** Placeholder for the global search input. */
  searchPlaceholder?: string;
}

type ColumnFilter =
  | { type: 'text'; contains: string }
  | { type: 'number'; min?: number; max?: number }
  | { type: 'date'; from?: string; to?: string };

type SortState = { key: string; dir: 'asc' | 'desc' };

// ─── Format helpers ────────────────────────────────────────────────────────

function formatCell(value: unknown, format?: ColumnFormat): React.ReactNode {
  if (value == null || value === '') return '—';
  switch (format) {
    case 'currency':
      return formatINR(Number(value) || 0);
    case 'number':
      return formatNumber(Number(value) || 0);
    case 'percent':
      return `${Number(value).toFixed(1)}%`;
    case 'date':
      return String(value);
    default:
      return String(value);
  }
}

function defaultAlign(col: ColumnDef): Align {
  if (col.align) return col.align;
  if (col.format === 'currency' || col.format === 'number' || col.format === 'percent') return 'right';
  return 'left';
}

// ─── Filter / sort logic ───────────────────────────────────────────────────

function getValue<T>(col: ColumnDef<T>, row: T): any {
  if (col.accessor) return col.accessor(row);
  return (row as any)[col.key];
}

function matchesFilter(value: any, filter: ColumnFilter): boolean {
  if (filter.type === 'text') {
    if (!filter.contains) return true;
    if (value == null) return false;
    return String(value).toLowerCase().includes(filter.contains.toLowerCase());
  }
  if (filter.type === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) return false;
    if (filter.min != null && n < filter.min) return false;
    if (filter.max != null && n > filter.max) return false;
    return true;
  }
  if (filter.type === 'date') {
    if (value == null) return false;
    const s = String(value);
    if (filter.from && s < filter.from) return false;
    if (filter.to && s > filter.to) return false;
    return true;
  }
  return true;
}

function applyFilters<T>(
  rows: T[],
  columns: ColumnDef<T>[],
  globalQuery: string,
  perColumn: Record<string, ColumnFilter>,
): T[] {
  const q = globalQuery.trim().toLowerCase();
  const filterableCols = columns.filter(c => c.type !== 'custom' && c.filterable !== false);
  return rows.filter(row => {
    if (q) {
      const hit = filterableCols.some(c => {
        const v = getValue(c, row);
        return v != null && String(v).toLowerCase().includes(q);
      });
      if (!hit) return false;
    }
    for (const [key, filter] of Object.entries(perColumn)) {
      const col = columns.find(c => c.key === key);
      if (!col) continue;
      if (!matchesFilter(getValue(col, row), filter)) return false;
    }
    return true;
  });
}

function applySort<T>(rows: T[], columns: ColumnDef<T>[], sort: SortState | null): T[] {
  if (!sort) return rows;
  const col = columns.find(c => c.key === sort.key);
  if (!col) return rows;
  const sorted = [...rows].sort((a, b) => {
    const va = getValue(col, a);
    const vb = getValue(col, b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    return String(va).localeCompare(String(vb));
  });
  return sort.dir === 'asc' ? sorted : sorted.reverse();
}

// ─── Filter popover ────────────────────────────────────────────────────────

interface FilterPopoverProps {
  column: ColumnDef;
  current: ColumnFilter | undefined;
  onChange: (filter: ColumnFilter | null) => void;
  onClose: () => void;
}

function FilterPopover({ column, current, onChange, onClose }: FilterPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const type = column.type || 'text';

  // Close on click-outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className="absolute top-full left-0 mt-1 z-30 p-3 rounded-lg shadow-lg min-w-[200px]"
      style={{
        background: 'var(--mt-bg-raised)',
        border: '1px solid var(--mt-border-strong, var(--mt-border))',
        boxShadow: 'var(--mt-shadow-pop)',
      }}
      onClick={e => e.stopPropagation()}
    >
      {type === 'text' && (
        <input
          type="text"
          autoFocus
          placeholder="Contains..."
          value={current?.type === 'text' ? current.contains : ''}
          onChange={e => onChange(e.target.value ? { type: 'text', contains: e.target.value } : null)}
          className="mt-input text-xs w-full"
          style={{ padding: '6px 10px' }}
        />
      )}
      {type === 'number' && (
        <div className="space-y-1.5">
          <input
            type="number"
            placeholder="Min"
            value={current?.type === 'number' ? (current.min ?? '') : ''}
            onChange={e => {
              const min = e.target.value === '' ? undefined : Number(e.target.value);
              const max = current?.type === 'number' ? current.max : undefined;
              onChange(min == null && max == null ? null : { type: 'number', min, max });
            }}
            className="mt-input text-xs w-full"
            style={{ padding: '6px 10px' }}
          />
          <input
            type="number"
            placeholder="Max"
            value={current?.type === 'number' ? (current.max ?? '') : ''}
            onChange={e => {
              const max = e.target.value === '' ? undefined : Number(e.target.value);
              const min = current?.type === 'number' ? current.min : undefined;
              onChange(min == null && max == null ? null : { type: 'number', min, max });
            }}
            className="mt-input text-xs w-full"
            style={{ padding: '6px 10px' }}
          />
        </div>
      )}
      {type === 'date' && (
        <div className="space-y-1.5">
          <label className="block text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>From</label>
          <input
            type="date"
            value={current?.type === 'date' ? (current.from ?? '') : ''}
            onChange={e => {
              const from = e.target.value || undefined;
              const to = current?.type === 'date' ? current.to : undefined;
              onChange(from == null && to == null ? null : { type: 'date', from, to });
            }}
            className="mt-input text-xs w-full"
            style={{ padding: '6px 10px' }}
          />
          <label className="block text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>To</label>
          <input
            type="date"
            value={current?.type === 'date' ? (current.to ?? '') : ''}
            onChange={e => {
              const to = e.target.value || undefined;
              const from = current?.type === 'date' ? current.from : undefined;
              onChange(from == null && to == null ? null : { type: 'date', from, to });
            }}
            className="mt-input text-xs w-full"
            style={{ padding: '6px 10px' }}
          />
        </div>
      )}
      <button
        onClick={() => { onChange(null); onClose(); }}
        className="mt-2 text-[10px] hover:underline"
        style={{ color: 'var(--mt-text-faint)' }}
      >
        Clear
      </button>
    </div>
  );
}

// ─── Active filter chip ────────────────────────────────────────────────────

function describeFilter(col: ColumnDef, f: ColumnFilter): string {
  if (f.type === 'text') return `${col.header}: "${f.contains}"`;
  if (f.type === 'number') {
    if (f.min != null && f.max != null) return `${col.header}: ${f.min}–${f.max}`;
    if (f.min != null) return `${col.header} ≥ ${f.min}`;
    if (f.max != null) return `${col.header} ≤ ${f.max}`;
  }
  if (f.type === 'date') {
    if (f.from && f.to) return `${col.header}: ${f.from} → ${f.to}`;
    if (f.from) return `${col.header} ≥ ${f.from}`;
    if (f.to) return `${col.header} ≤ ${f.to}`;
  }
  return col.header;
}

// ─── Main component ────────────────────────────────────────────────────────

export function DataTable<T = any>({
  columns,
  rows,
  pageSize = 50,
  globalSearch = true,
  defaultSort,
  emptyMessage = 'No matching rows',
  rowClassName,
  toolbar,
  density = 'normal',
  searchPlaceholder = 'Search...',
}: DataTableProps<T>) {
  const [globalQuery, setGlobalQuery] = useState('');
  const [perColumn, setPerColumn] = useState<Record<string, ColumnFilter>>({});
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>(defaultSort || null);
  const [page, setPage] = useState(0);

  // Reset page when filters change
  const filteredRows = useMemo(
    () => applyFilters(rows, columns, globalQuery, perColumn),
    [rows, columns, globalQuery, perColumn]
  );
  const sortedRows = useMemo(
    () => applySort(filteredRows, columns, sort),
    [filteredRows, columns, sort]
  );

  useEffect(() => {
    setPage(0);
  }, [globalQuery, perColumn, sort, rows]);

  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(sortedRows.length / pageSize)) : 1;
  const pageRows = pageSize > 0
    ? sortedRows.slice(page * pageSize, (page + 1) * pageSize)
    : sortedRows;

  const cellPad = density === 'compact' ? 'px-2 py-1' : 'px-3 py-2';

  function setColumnFilter(key: string, filter: ColumnFilter | null) {
    setPerColumn(prev => {
      const next = { ...prev };
      if (filter == null) delete next[key];
      else next[key] = filter;
      return next;
    });
  }

  function toggleSort(key: string) {
    const col = columns.find(c => c.key === key);
    if (!col || col.sortable === false || col.type === 'custom') return;
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }

  const activeFilterChips = Object.entries(perColumn).map(([key, f]) => {
    const col = columns.find(c => c.key === key);
    if (!col) return null;
    return (
      <span
        key={key}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium"
        style={{
          background: 'var(--mt-accent-soft)',
          color: 'var(--mt-accent-text)',
          border: '1px solid var(--mt-accent-border)',
        }}
      >
        {describeFilter(col, f)}
        <button
          onClick={() => setColumnFilter(key, null)}
          className="hover:opacity-70"
          aria-label={`Clear ${col.header} filter`}
        >
          <X size={10} />
        </button>
      </span>
    );
  });

  return (
    <div>
      {/* Toolbar — global search + active filter chips + caller toolbar */}
      {(globalSearch || toolbar || activeFilterChips.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {globalSearch && (
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--mt-text-faint)' }}
              />
              <input
                type="text"
                value={globalQuery}
                onChange={e => setGlobalQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="mt-input text-xs pl-8 w-64"
                style={{ padding: '6px 10px 6px 30px' }}
              />
            </div>
          )}
          {activeFilterChips}
          {(globalQuery || activeFilterChips.length > 0) && (
            <button
              onClick={() => { setGlobalQuery(''); setPerColumn({}); }}
              className="text-[10px] hover:underline"
              style={{ color: 'var(--mt-text-faint)' }}
            >
              Clear all
            </button>
          )}
          {toolbar && <div className="ml-auto">{toolbar}</div>}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--mt-border)' }}>
              {columns.map(col => {
                const align = defaultAlign(col);
                const isSorted = sort?.key === col.key;
                const filterable = col.type !== 'custom' && col.filterable !== false;
                const sortable = filterable && col.sortable !== false;
                return (
                  <th
                    key={col.key}
                    className={`${cellPad} text-${align} text-[10px] font-medium uppercase relative ${col.width || ''}`}
                    style={{ color: 'var(--mt-text-faint)' }}
                  >
                    <div className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''}`}>
                      <button
                        onClick={() => sortable && toggleSort(col.key)}
                        className={`flex items-center gap-1 ${sortable ? 'hover:text-theme-secondary cursor-pointer' : 'cursor-default'}`}
                        style={{ color: isSorted ? 'var(--mt-text-primary)' : 'inherit' }}
                      >
                        {col.header}
                        {isSorted && (sort.dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                      </button>
                      {filterable && (
                        <button
                          onClick={() => setOpenFilter(openFilter === col.key ? null : col.key)}
                          className="hover:text-theme-secondary"
                          style={{ color: perColumn[col.key] ? 'var(--mt-accent-text)' : 'inherit' }}
                          aria-label={`Filter ${col.header}`}
                        >
                          <Filter size={10} />
                        </button>
                      )}
                    </div>
                    {openFilter === col.key && (
                      <FilterPopover
                        column={col}
                        current={perColumn[col.key]}
                        onChange={f => setColumnFilter(col.key, f)}
                        onClose={() => setOpenFilter(null)}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-xs"
                  style={{ color: 'var(--mt-text-faint)' }}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pageRows.map((row, i) => {
                const extra = rowClassName?.(row) || '';
                return (
                  <tr
                    key={i}
                    className={`hover:bg-dark-600/30 ${extra}`}
                    style={{ borderBottom: '1px solid var(--mt-border)' }}
                  >
                    {columns.map(col => {
                      const align = defaultAlign(col);
                      const value = col.render ? col.render(row) : formatCell(getValue(col, row), col.format);
                      return (
                        <td
                          key={col.key}
                          className={`${cellPad} text-${align} ${col.cellClassName || ''} ${col.width || ''}`}
                        >
                          {value}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer — row count + pagination */}
      {(sortedRows.length > 0 || rows.length > 0) && (
        <div
          className="flex items-center justify-between mt-3 pt-3 text-xs"
          style={{ borderTop: '1px solid var(--mt-border)', color: 'var(--mt-text-faint)' }}
        >
          <span>
            {sortedRows.length === rows.length
              ? `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`
              : `${sortedRows.length} of ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
          </span>
          {pageSize > 0 && totalPages > 1 && (
            <div className="flex items-center gap-2">
              <span>Page {page + 1} of {totalPages}</span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-1 rounded hover:bg-dark-600/40 disabled:opacity-30"
                  style={{ color: 'var(--mt-text-muted)' }}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="p-1 rounded hover:bg-dark-600/40 disabled:opacity-30"
                  style={{ color: 'var(--mt-text-muted)' }}
                  aria-label="Next page"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DataTable;
