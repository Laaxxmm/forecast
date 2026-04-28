// ─────────────────────────────────────────────────────────────────────────────
// StatementSearch — global "Find in statement" input for financial statements.
//
// Tier D tables (P&L, Balance Sheet, Cash Flow, Trial Balance, Forecast tabs)
// have months as columns and line items as rows, with structural features
// (group headers, subtotals, hierarchy) that don't fit the flat DataTable.
// Per-column filtering also doesn't apply — "show me only rows where Jan was
// over X" isn't a meaningful query for a P&L. So these get a single search
// input that filters the visible rows by line-item label.
//
// Usage in a statement page:
//   const [query, setQuery] = useState('');
//   const visibleRows = useMemo(() =>
//     query
//       ? rows.filter(r => r.label.toLowerCase().includes(query.toLowerCase()))
//       : rowsRespectingExpandedGroups,
//     [query, rows, expanded]
//   );
//   <StatementSearch value={query} onChange={setQuery} />
//   …existing table renders below…
//
// When the search is active, expand/collapse state is bypassed — the user
// sees every matching row regardless of which group it lives under.
// ─────────────────────────────────────────────────────────────────────────────

import { Search, X } from 'lucide-react';

/**
 * Prune a hierarchical section tree to only branches whose label or any
 * descendant matches the query. Used by the vCFO P&L / Balance Sheet / Cash
 * Flow reports which use a `sections` tree of arbitrary depth. When the
 * query is empty, returns the input unchanged.
 *
 * Returns BOTH the pruned tree AND the keys of sections that should be
 * force-expanded so matched descendants are visible.
 */
export function filterSectionTree<
  T extends { key: string; label: string; children?: T[] }
>(
  sections: T[],
  query: string,
): { sections: T[]; expandKeys: Set<string> } {
  const q = query.trim().toLowerCase();
  if (!q) return { sections, expandKeys: new Set() };

  const expandKeys = new Set<string>();

  const walk = (items: T[]): T[] => {
    const out: T[] = [];
    for (const item of items) {
      const labelMatches = item.label.toLowerCase().includes(q);
      const filteredChildren = item.children ? walk(item.children) : undefined;
      const hasMatchingChild = filteredChildren && filteredChildren.length > 0;
      if (labelMatches) {
        // Keep the whole subtree (don't prune children when label matches).
        out.push(item);
        if (item.children) expandKeys.add(item.key);
      } else if (hasMatchingChild) {
        out.push({ ...item, children: filteredChildren });
        expandKeys.add(item.key);
      }
    }
    return out;
  };

  return { sections: walk(sections), expandKeys };
}

interface StatementSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Optional — display alongside the input (e.g. "12 of 47 lines"). */
  resultLabel?: string;
}

export function StatementSearch({ value, onChange, placeholder = 'Find in statement…', resultLabel }: StatementSearchProps) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="relative flex-1 max-w-md">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2"
          style={{ color: 'var(--mt-text-faint)' }}
        />
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="mt-input text-xs w-full"
          style={{ padding: '6px 30px 6px 30px' }}
        />
        {value && (
          <button
            onClick={() => onChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-dark-600/40"
            style={{ color: 'var(--mt-text-faint)' }}
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {resultLabel && value && (
        <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
          {resultLabel}
        </span>
      )}
    </div>
  );
}

export default StatementSearch;
