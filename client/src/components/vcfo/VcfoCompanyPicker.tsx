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
  selectedId: number | null;
  onSelect: (id: number) => void;
  loading?: boolean;
}

/**
 * Quick-switch for the Tally company whose books are currently being shown.
 *
 * Intentionally presented as a filter ("Showing: <name>"), not a gate — one
 * tenant (the logged-in client) typically has several Tally companies (one
 * per clinic/pharmacy/FY) and the page auto-selects the most recently
 * synced one on load, so this dropdown only matters when switching between
 * them. Hidden entirely when there's only one company to pick.
 */
export default function VcfoCompanyPicker({ companies, selectedId, onSelect, loading }: Props) {
  // With only one company, there's nothing to switch to — collapse the
  // picker into a passive label so it doesn't look like a required input.
  if (!loading && companies.length === 1) {
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
        value={selectedId ?? ''}
        onChange={e => {
          const id = Number(e.target.value);
          if (id) onSelect(id);
        }}
        disabled={loading || companies.length === 0}
        className="input text-xs md:text-sm py-1 md:py-1.5 w-40 md:w-56 disabled:opacity-50"
        title="Switch Tally company"
      >
        {loading && <option value="">Loading…</option>}
        {!loading && companies.length === 0 && <option value="">No companies synced</option>}
        {companies.map(c => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
