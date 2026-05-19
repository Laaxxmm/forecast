// ─── Location grouping helpers (shared between P&L and Balance Sheet) ───────
// Bifurcated columns arrive as 'co:336' with friendly labels in `columnLabels`
// like "ASHOK NAGAR · PHARMACY". We group these by location alphabetically so
// the user can compare a single location's Clinic and Pharmacy side by side
// instead of hunting across a flat 15-column table.

import { formatRs } from '../../pages/ForecastModulePage';

/** Soft-tinted palette cycled per location to make group boundaries scan. */
export const LOCATION_PALETTE = [
  '#EAF3DE', // green
  '#E6F1FB', // blue
  '#EEEDFE', // purple
  '#FAEEDA', // amber
  '#FAECE7', // coral
];

/** Display-only normalisations for known typos in the source data.
 *  Underlying column keys (co:NNN) stay as-is to avoid breaking the query. */
export const LOCATION_DISPLAY_FIXES: Record<string, string> = {
  'Jubliee Hills': 'Jubilee Hills',
};

export interface ParsedColumnLabel {
  location: string;     // Title-cased + typo-normalised
  entityType: string;   // 'Clinic' | 'Pharmacy' | anything else found
}

/** Parse "ASHOK NAGAR · PHARMACY" → { location: "Ashok Nagar", entityType: "Pharmacy" }. */
export function parseColumnLabel(label: string): ParsedColumnLabel | null {
  const parts = label.split('·').map(s => s.trim());
  if (parts.length !== 2) return null;
  const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const rawLocation = titleCase(parts[0]);
  const location = LOCATION_DISPLAY_FIXES[rawLocation] || rawLocation;
  const entityType = titleCase(parts[1]);
  return { location, entityType };
}

export interface LocationGroup {
  location: string;
  paletteIndex: number;
  cells: Array<{ col: string; entityType: string }>;
}

export interface LocationGroupResult {
  groups: LocationGroup[];
  unparsedCols: string[];
  totalCol: string | null;
  displayOrder: string[];
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
export function buildLocationGroups(
  columns: string[],
  columnLabels: Record<string, string> | undefined,
  bifurcated: boolean,
): LocationGroupResult | null {
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

/** Set of column keys that should get a vertical separator border on their
 *  right edge — one at the end of each location group. */
export function buildSeparatorSet(result: LocationGroupResult | null): Set<string> {
  const set = new Set<string>();
  if (!result) return set;
  for (const g of result.groups) {
    const last = g.cells[g.cells.length - 1];
    if (last) set.add(last.col);
  }
  return set;
}

/** Currency formatter that returns "—" for zero/empty instead of "Rs0".
 *  Negative values still pass through formatRs (we want them visible as a
 *  Tally data-quality signal). */
export function fmtCell(v: number | undefined | null): string {
  const n = Number(v) || 0;
  if (n === 0) return '—';
  return formatRs(n);
}

/** Inline style for a separator-after cell. Use as `style={separatorStyle(set, col)}`. */
export function separatorStyle(set: Set<string>, col: string): React.CSSProperties | undefined {
  if (!set.has(col)) return undefined;
  return { borderRight: '0.5px solid rgba(148, 163, 184, 0.25)' };
}
