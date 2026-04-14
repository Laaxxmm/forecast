import { useEffect, useState } from 'react';
import { Plus, Trash2, Save, X, Edit2, Info, Link2 } from 'lucide-react';
import api from '../../api/client';

// ── Types ──
interface Mapping {
  id: number;
  forecast_category: string;
  tally_group_name: string;
  ledger_filter: string | null;
}

// Fixed forecast categories. Kept in sync with ForecastModulePage's
// category tabs — any new category there should be added here too.
const CATEGORIES: { value: string; label: string }[] = [
  { value: 'revenue', label: 'Revenue' },
  { value: 'direct_costs', label: 'Direct Costs' },
  { value: 'personnel', label: 'Personnel' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'assets', label: 'Assets' },
];

interface Props {
  readOnly?: boolean;
}

export default function CategoryMappingEditor({ readOnly = false }: Props) {
  const [rows, setRows] = useState<Mapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Partial<Mapping>>({});
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<Partial<Mapping>>({
    forecast_category: 'revenue',
    tally_group_name: '',
    ledger_filter: '',
  });
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.get('/forecast-module/category-mapping')
      .then(res => setRows(res.data))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const startEdit = (row: Mapping) => {
    setEditingId(row.id);
    setDraft({ ...row, ledger_filter: row.ledger_filter ?? '' });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft({});
    setError(null);
  };

  const saveEdit = async () => {
    if (!editingId || !draft.forecast_category || !draft.tally_group_name) {
      setError('Category and Tally group are required');
      return;
    }
    try {
      await api.put(`/forecast-module/category-mapping/${editingId}`, {
        forecast_category: draft.forecast_category,
        tally_group_name: draft.tally_group_name,
        ledger_filter: draft.ledger_filter || null,
      });
      setEditingId(null);
      setDraft({});
      setError(null);
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to save');
    }
  };

  const removeRow = async (id: number) => {
    if (!confirm('Delete this mapping?')) return;
    try {
      await api.delete(`/forecast-module/category-mapping/${id}`);
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to delete');
    }
  };

  const addRow = async () => {
    if (!newRow.forecast_category || !newRow.tally_group_name) {
      setError('Category and Tally group are required');
      return;
    }
    try {
      await api.post('/forecast-module/category-mapping', {
        forecast_category: newRow.forecast_category,
        tally_group_name: newRow.tally_group_name,
        ledger_filter: newRow.ledger_filter || null,
      });
      setAdding(false);
      setNewRow({ forecast_category: 'revenue', tally_group_name: '', ledger_filter: '' });
      setError(null);
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to add');
    }
  };

  const categoryLabel = (v: string) =>
    CATEGORIES.find(c => c.value === v)?.label ?? v;

  // Group by category for visual grouping
  const grouped: Record<string, Mapping[]> = {};
  for (const r of rows) {
    if (!grouped[r.forecast_category]) grouped[r.forecast_category] = [];
    grouped[r.forecast_category].push(r);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link2 size={18} className="text-accent-400" />
            <h2 className="text-lg font-bold text-theme-primary">Category Mapping</h2>
          </div>
          <p className="text-xs text-theme-muted mt-1 max-w-2xl">
            Link each forecast category to the Tally groups that roll up into
            it. Used by Budget vs Actual to fetch the right ledger totals from
            Tally for each forecast line.
          </p>
        </div>
        {!readOnly && !adding && (
          <button
            onClick={() => { setAdding(true); setError(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-500/20 text-accent-400 hover:bg-accent-500/30 transition"
          >
            <Plus size={14} /> Add mapping
          </button>
        )}
      </div>

      {/* Info banner — explains ledger_filter */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-dark-700/50 border border-dark-400/40 text-xs text-theme-muted">
        <Info size={14} className="mt-0.5 text-theme-faint flex-shrink-0" />
        <div>
          <span className="font-medium text-theme-secondary">Ledger filter</span> is
          optional. Use it when a forecast category only covers part of a Tally
          group — e.g. <span className="font-mono text-theme-secondary">Salary%,Wages%</span> to
          scope "Personnel" to payroll ledgers under Indirect Expenses.
          Comma-separated <span className="font-mono text-theme-secondary">LIKE</span> patterns.
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="p-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="hover:text-red-300"><X size={12} /></button>
        </div>
      )}

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-dark-700/50">
              <th className="text-left px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase w-[160px]">Forecast Category</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase">Tally Group</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase w-[260px]">Ledger Filter</th>
              {!readOnly && <th className="text-right px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase w-[120px]">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={readOnly ? 3 : 4} className="px-3 py-6 text-center text-theme-muted">Loading…</td></tr>
            ) : rows.length === 0 && !adding ? (
              <tr><td colSpan={readOnly ? 3 : 4} className="px-3 py-6 text-center text-theme-muted">No mappings yet. Defaults are seeded on new tenants — click "Add mapping" to create one.</td></tr>
            ) : (
              CATEGORIES.map(cat => {
                const groupRows = grouped[cat.value] || [];
                if (groupRows.length === 0) return null;
                return groupRows.map((r, idx) => {
                  const isEditing = editingId === r.id;
                  return (
                    <tr key={r.id} className="border-t border-dark-400/30 hover:bg-dark-700/30">
                      <td className="px-3 py-2 text-theme-secondary">
                        {idx === 0 && !isEditing && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-accent-500/10 text-accent-400 text-[11px] font-medium">
                            {cat.label}
                          </span>
                        )}
                        {isEditing && (
                          <select
                            value={draft.forecast_category}
                            onChange={e => setDraft(d => ({ ...d, forecast_category: e.target.value }))}
                            className="input text-xs px-2 py-1 w-full"
                          >
                            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                          </select>
                        )}
                        {!isEditing && idx !== 0 && <span className="text-theme-faint">·</span>}
                      </td>
                      <td className="px-3 py-2 text-theme-secondary">
                        {isEditing ? (
                          <input
                            value={draft.tally_group_name || ''}
                            onChange={e => setDraft(d => ({ ...d, tally_group_name: e.target.value }))}
                            className="input text-xs px-2 py-1 w-full"
                            placeholder="e.g. Sales Accounts"
                          />
                        ) : r.tally_group_name}
                      </td>
                      <td className="px-3 py-2 text-theme-secondary font-mono text-[11px]">
                        {isEditing ? (
                          <input
                            value={draft.ledger_filter || ''}
                            onChange={e => setDraft(d => ({ ...d, ledger_filter: e.target.value }))}
                            className="input text-xs px-2 py-1 w-full font-mono"
                            placeholder="optional — e.g. Salary%,Wages%"
                          />
                        ) : r.ledger_filter || <span className="text-theme-faint italic">—</span>}
                      </td>
                      {!readOnly && (
                        <td className="px-3 py-2 text-right">
                          {isEditing ? (
                            <div className="flex gap-1 justify-end">
                              <button onClick={saveEdit} className="p-1 text-accent-400 hover:bg-accent-500/20 rounded" title="Save"><Save size={14} /></button>
                              <button onClick={cancelEdit} className="p-1 text-theme-muted hover:bg-dark-600 rounded" title="Cancel"><X size={14} /></button>
                            </div>
                          ) : (
                            <div className="flex gap-1 justify-end">
                              <button onClick={() => startEdit(r)} className="p-1 text-theme-muted hover:text-accent-400 hover:bg-dark-600 rounded" title="Edit"><Edit2 size={14} /></button>
                              <button onClick={() => removeRow(r.id)} className="p-1 text-theme-muted hover:text-red-400 hover:bg-dark-600 rounded" title="Delete"><Trash2 size={14} /></button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                });
              })
            )}
            {/* New row inline form */}
            {adding && !readOnly && (
              <tr className="border-t border-dark-400/30 bg-accent-500/5">
                <td className="px-3 py-2">
                  <select
                    value={newRow.forecast_category}
                    onChange={e => setNewRow(r => ({ ...r, forecast_category: e.target.value }))}
                    className="input text-xs px-2 py-1 w-full"
                  >
                    {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <input
                    value={newRow.tally_group_name || ''}
                    onChange={e => setNewRow(r => ({ ...r, tally_group_name: e.target.value }))}
                    className="input text-xs px-2 py-1 w-full"
                    placeholder="e.g. Sales Accounts"
                    autoFocus
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    value={newRow.ledger_filter || ''}
                    onChange={e => setNewRow(r => ({ ...r, ledger_filter: e.target.value }))}
                    className="input text-xs px-2 py-1 w-full font-mono"
                    placeholder="optional — e.g. Salary%,Wages%"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex gap-1 justify-end">
                    <button onClick={addRow} className="p-1 text-accent-400 hover:bg-accent-500/20 rounded" title="Add"><Save size={14} /></button>
                    <button onClick={() => { setAdding(false); setError(null); }} className="p-1 text-theme-muted hover:bg-dark-600 rounded" title="Cancel"><X size={14} /></button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Unknown categories fallback — any categories in DB that aren't in the fixed list */}
      {(() => {
        const knownCats = new Set(CATEGORIES.map(c => c.value));
        const unknown = rows.filter(r => !knownCats.has(r.forecast_category));
        if (unknown.length === 0) return null;
        return (
          <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded p-2">
            {unknown.length} mapping{unknown.length !== 1 ? 's' : ''} use an unknown forecast category: {[...new Set(unknown.map(r => r.forecast_category))].join(', ')}. These won't match any P&L bucket — consider editing or deleting.
          </div>
        );
      })()}
    </div>
  );
}
