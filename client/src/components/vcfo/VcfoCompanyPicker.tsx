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

export default function VcfoCompanyPicker({ companies, selectedId, onSelect, loading }: Props) {
  return (
    <div className="flex items-center gap-2">
      <Building2 size={14} className="text-theme-faint" />
      <select
        value={selectedId ?? ''}
        onChange={e => {
          const id = Number(e.target.value);
          if (id) onSelect(id);
        }}
        disabled={loading || companies.length === 0}
        className="input text-xs md:text-sm py-1 md:py-1.5 w-40 md:w-56 disabled:opacity-50"
      >
        {loading && <option value="">Loading companies…</option>}
        {!loading && companies.length === 0 && <option value="">No companies synced yet</option>}
        {!loading && companies.length > 0 && selectedId == null && (
          <option value="">Select company…</option>
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
