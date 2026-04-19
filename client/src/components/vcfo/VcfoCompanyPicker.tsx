import { Building2 } from 'lucide-react';

export interface VcfoCompany {
  id: number;
  name: string;
  location: string;
  entity_type: string;
  branchId: number | null;
  streamId: number | null;
  lastSyncedAt: string | null;
}

interface Props {
  companies: VcfoCompany[];
  /** null = "All companies" (consolidated), number = single company */
  selectedId: number | null;
  /** Passed the new id (null = All). */
  onSelect: (id: number | null) => void;
  loading?: boolean;
  /** When false, hides the "All companies" synthetic option. */
  allowAll?: boolean;
}

/**
 * Quick-switch for the Tally company whose books are currently being shown.
 *
 * With multiple companies in scope, a synthetic "All companies" entry sits
 * at the top of the list and maps to `selectedId = null`; the module page
 * sends `companyIds=all` to the server when this is picked, producing a
 * consolidated report across the whole sidebar-filtered set.
 *
 * Hidden entirely when there's only one company and "All" adds no value.
 */
export default function VcfoCompanyPicker({ companies, selectedId, onSelect, loading, allowAll = true }: Props) {
  // Only one real company AND no "All" option wanted — collapse to a label.
  if (!loading && companies.length === 1 && !allowAll) {
    return (
      <div className="flex items-center gap-1.5 text-xs md:text-sm text-theme-secondary">
        <Building2 size={14} className="text-theme-faint" />
        <span className="font-medium">{companies[0].name}</span>
      </div>
    );
  }

  // Only one real company and "All" is the same thing — still show a label.
  if (!loading && companies.length === 1 && allowAll) {
    return (
      <div className="flex items-center gap-1.5 text-xs md:text-sm text-theme-secondary">
        <Building2 size={14} className="text-theme-faint" />
        <span className="font-medium">{companies[0].name}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Building2 size={14} className="text-theme-faint" />
      <span className="hidden md:inline text-xs text-theme-faint">Showing</span>
      <select
        value={selectedId == null ? '__all__' : String(selectedId)}
        onChange={e => {
          const v = e.target.value;
          if (v === '__all__') onSelect(null);
          else onSelect(Number(v));
        }}
        disabled={loading || companies.length === 0}
        className="input text-xs md:text-sm py-1 md:py-1.5 w-40 md:w-56 disabled:opacity-50"
        title="Switch Tally company"
      >
        {loading && <option value="">Loading…</option>}
        {!loading && companies.length === 0 && <option value="">No companies synced</option>}
        {allowAll && !loading && companies.length > 0 && (
          <option value="__all__">All companies ({companies.length})</option>
        )}
        {companies.map(c => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
