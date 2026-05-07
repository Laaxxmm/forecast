import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, X, Edit2, Info, Link2, AlertTriangle, Sparkles } from 'lucide-react';
import api from '../../api/client';
import MultiSelectChips from './MultiSelectChips';

// ── Types ──
interface Mapping {
  id: number;
  forecast_category: string;
  tally_group_name: string;
  ledger_filter: string | null;
}

interface TallyGroup {
  name: string;
  companyCount: number;
  ledgerCount: number;
  side: 'BS' | 'PL' | null;
}

interface TallyLedger {
  name: string;
  companies: string[];
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

/**
 * A `ledger_filter` string is "advanced" when it uses SQL LIKE wildcards.
 * Plain comma-separated names map cleanly to the multi-select. Wildcards
 * (% or _) are kept as a free-text pattern so power-users keep their
 * regex-y mappings — and we offer a one-click "expand to ledgers" button
 * that converts the wildcard to the currently matching ledger names.
 */
function isWildcardFilter(filter: string | null | undefined): boolean {
  if (!filter) return false;
  return /[%_\[]/.test(filter);
}

function filterToList(filter: string | null | undefined): string[] {
  if (!filter) return [];
  return filter.split(',').map(s => s.trim()).filter(Boolean);
}

function listToFilter(list: string[]): string | null {
  const cleaned = list.map(s => s.trim()).filter(Boolean);
  return cleaned.length === 0 ? null : cleaned.join(',');
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

  // ── Tally group + ledger pickers ───────────────────────────────────────
  const [groups, setGroups] = useState<TallyGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  // Per-group ledger cache: groupName -> ledgers[].
  const [ledgerCache, setLedgerCache] = useState<Record<string, TallyLedger[]>>({});
  const [ledgerLoading, setLedgerLoading] = useState<string | null>(null);
  // Which row is using the advanced (wildcard) filter input — keyed by row id
  // for existing rows, '__new' for the add form. When undefined, the row
  // shows the multi-select.
  const [advanced, setAdvanced] = useState<Set<string>>(new Set());

  const loadMappings = () => {
    setLoading(true);
    api.get('/forecast-module/category-mapping')
      .then(res => setRows(res.data))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(loadMappings, []);

  useEffect(() => {
    setGroupsLoading(true);
    api.get('/forecast-module/tally-groups')
      .then(res => setGroups(res.data || []))
      .catch(() => setGroups([]))
      .finally(() => setGroupsLoading(false));
  }, []);

  // Lazy-load ledgers for a given top-level group on first request.
  const ensureLedgers = async (groupName: string) => {
    if (!groupName || ledgerCache[groupName]) return;
    setLedgerLoading(groupName);
    try {
      const res = await api.get(`/forecast-module/tally-groups/${encodeURIComponent(groupName)}/ledgers`);
      setLedgerCache(c => ({ ...c, [groupName]: res.data || [] }));
    } catch {
      setLedgerCache(c => ({ ...c, [groupName]: [] }));
    } finally {
      setLedgerLoading(null);
    }
  };

  // ── Edit / save / add ───────────────────────────────────────────────────
  const startEdit = (row: Mapping) => {
    setEditingId(row.id);
    setDraft({ ...row, ledger_filter: row.ledger_filter ?? '' });
    setError(null);
    if (row.tally_group_name) ensureLedgers(row.tally_group_name);
    // If existing filter has wildcards, default to advanced mode for that row.
    setAdvanced(prev => {
      const next = new Set(prev);
      const key = String(row.id);
      if (isWildcardFilter(row.ledger_filter)) next.add(key);
      else next.delete(key);
      return next;
    });
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
      loadMappings();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to save');
    }
  };

  const removeRow = async (id: number) => {
    if (!confirm('Delete this mapping?')) return;
    try {
      await api.delete(`/forecast-module/category-mapping/${id}`);
      loadMappings();
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
      setAdvanced(prev => { const n = new Set(prev); n.delete('__new'); return n; });
      setError(null);
      loadMappings();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to add');
    }
  };

  /**
   * Convert a wildcard filter to its currently-matching ledger names. Used
   * by the "Convert to multi-select" affordance when a user opens an old
   * mapping that still has Salary%-style patterns.
   */
  const expandWildcardFilter = async (groupName: string, filter: string): Promise<string[]> => {
    try {
      const res = await api.post(
        `/forecast-module/tally-groups/${encodeURIComponent(groupName)}/expand-filter`,
        { filter },
      );
      return res.data?.matches || [];
    } catch {
      return [];
    }
  };

  const categoryLabel = (v: string) =>
    CATEGORIES.find(c => c.value === v)?.label ?? v;
  void categoryLabel;

  // Group by category for visual grouping
  const grouped: Record<string, Mapping[]> = {};
  for (const r of rows) {
    if (!grouped[r.forecast_category]) grouped[r.forecast_category] = [];
    grouped[r.forecast_category].push(r);
  }

  // Memoised group dropdown options
  const groupOptions = useMemo(() => groups.map(g => ({
    value: g.name,
    label: g.name,
    side: g.side,
    hint: `${g.ledgerCount} ledger${g.ledgerCount === 1 ? '' : 's'}${g.companyCount > 1 ? ` · ${g.companyCount} companies` : ''}`,
  })), [groups]);

  const knownGroupSet = useMemo(() => new Set(groups.map(g => g.name)), [groups]);

  // Build options for the ledger multi-select for a given group.
  const ledgerOptionsFor = (groupName: string) => {
    const list = ledgerCache[groupName] || [];
    return list.map(l => ({
      value: l.name,
      label: l.name,
      hint: l.companies.length > 1 ? `${l.companies.length} companies` : (l.companies[0] || ''),
    }));
  };

  // Renders the Tally Group dropdown.
  const renderGroupSelect = (
    value: string,
    onChange: (v: string) => void,
  ) => (
    <select
      value={value || ''}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v);
        if (v) ensureLedgers(v);
      }}
      className="input text-xs px-2 py-1 w-full"
      disabled={groupsLoading}
    >
      <option value="">{groupsLoading ? 'Loading…' : 'Pick a Tally group…'}</option>
      {groupOptions.map(g => (
        <option key={g.value} value={g.value}>
          {g.label}{g.side ? ` (${g.side})` : ''}{g.hint ? ` — ${g.hint}` : ''}
        </option>
      ))}
      {/* If the saved group isn't in the current options (e.g. renamed in
          Tally), still surface it so the user can re-pick. */}
      {value && !knownGroupSet.has(value) && (
        <option value={value}>{value} (not currently synced)</option>
      )}
    </select>
  );

  // Renders the Ledger Filter cell — multi-select OR advanced text input
  // OR a hint about wildcard mode. `key` is row id (for existing) or
  // '__new' (for the add form).
  const renderLedgerFilter = (
    rowKey: string,
    groupName: string,
    filter: string,
    onChange: (next: string) => void,
  ) => {
    const isAdvanced = advanced.has(rowKey);
    if (!groupName) {
      return <span className="text-theme-faint italic text-[11px]">Pick a Tally group first</span>;
    }
    if (isAdvanced) {
      return (
        <div className="flex items-center gap-1.5">
          <input
            value={filter}
            onChange={(e) => onChange(e.target.value)}
            className="input text-xs px-2 py-1 flex-1 font-mono"
            placeholder="optional — e.g. Salary%,Wages%"
          />
          <button
            type="button"
            className="p-1 rounded hover:bg-dark-600"
            title="Convert wildcard pattern to currently matching ledgers"
            style={{ color: 'var(--mt-accent-text)' }}
            onClick={async () => {
              const matches = await expandWildcardFilter(groupName, filter);
              if (matches.length > 0) {
                onChange(matches.join(','));
                setAdvanced(prev => { const n = new Set(prev); n.delete(rowKey); return n; });
              }
            }}
          >
            <Sparkles size={12} />
          </button>
        </div>
      );
    }
    const options = ledgerOptionsFor(groupName);
    const selected = filterToList(filter);
    return (
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0">
          <MultiSelectChips
            options={options}
            selected={selected}
            onChange={(values) => onChange(listToFilter(values) || '')}
            placeholder="All ledgers in this group"
            loading={ledgerLoading === groupName}
            emptyText="No ledgers found in this group"
          />
        </div>
        <button
          type="button"
          className="p-1 rounded hover:bg-dark-600 text-theme-faint hover:text-theme-secondary"
          title="Switch to wildcard pattern (advanced)"
          onClick={() => setAdvanced(prev => { const n = new Set(prev); n.add(rowKey); return n; })}
        >
          <span className="text-[10px] font-mono">%</span>
        </button>
      </div>
    );
  };

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

      {/* Info banner — explains ledger filter */}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-dark-700/50 border border-dark-400/40 text-xs text-theme-muted">
        <Info size={14} className="mt-0.5 text-theme-faint flex-shrink-0" />
        <div>
          <span className="font-medium text-theme-secondary">Ledger filter</span> is
          optional. Leave it empty to include every ledger under the chosen
          Tally group. Pick specific ledgers to scope the mapping — e.g. only
          payroll ledgers under <span className="font-mono text-theme-secondary">Indirect Expenses</span> for "Personnel".
          The small <span className="font-mono text-theme-secondary">%</span> button
          switches to wildcard-pattern mode for power users.
        </div>
      </div>

      {/* Empty Tally-data warning */}
      {!groupsLoading && groups.length === 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <div>
            No Tally groups found. Run the <span className="font-medium">VCFO Sync desktop agent</span> against your Tally
            ERP to populate the chart of accounts before creating mappings.
          </div>
        </div>
      )}

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
              <th className="text-left px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase w-[260px]">Tally Group</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase">Ledger Filter</th>
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
                  const groupMissing = !!r.tally_group_name && !knownGroupSet.has(r.tally_group_name);
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
                          renderGroupSelect(
                            draft.tally_group_name || '',
                            (v) => setDraft(d => ({ ...d, tally_group_name: v, ledger_filter: '' })),
                          )
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            {r.tally_group_name}
                            {groupMissing && (
                              <span
                                className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded"
                                style={{ background: 'var(--mt-warn-soft)', color: 'var(--mt-warn-text)' }}
                                title="This group isn't in any currently synced company"
                              >
                                <AlertTriangle size={10} className="mr-0.5" /> not synced
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-theme-secondary text-[11px]">
                        {isEditing ? (
                          renderLedgerFilter(
                            String(r.id),
                            draft.tally_group_name || '',
                            draft.ledger_filter || '',
                            (v) => setDraft(d => ({ ...d, ledger_filter: v })),
                          )
                        ) : r.ledger_filter ? (
                          isWildcardFilter(r.ledger_filter) ? (
                            <span className="font-mono text-[11px]" style={{ color: 'var(--mt-text-secondary)' }}>{r.ledger_filter}</span>
                          ) : (
                            <span className="inline-flex flex-wrap gap-1">
                              {filterToList(r.ledger_filter).map(name => (
                                <span
                                  key={name}
                                  className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded"
                                  style={{
                                    background: 'var(--mt-accent-soft)',
                                    color: 'var(--mt-accent-text)',
                                    border: '1px solid var(--mt-accent-border)',
                                  }}
                                >
                                  {name}
                                </span>
                              ))}
                            </span>
                          )
                        ) : (
                          <span className="text-theme-faint italic">All ledgers in group</span>
                        )}
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
                  {renderGroupSelect(
                    newRow.tally_group_name || '',
                    (v) => setNewRow(r => ({ ...r, tally_group_name: v, ledger_filter: '' })),
                  )}
                </td>
                <td className="px-3 py-2">
                  {renderLedgerFilter(
                    '__new',
                    newRow.tally_group_name || '',
                    newRow.ledger_filter || '',
                    (v) => setNewRow(r => ({ ...r, ledger_filter: v })),
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex gap-1 justify-end">
                    <button onClick={addRow} className="p-1 text-accent-400 hover:bg-accent-500/20 rounded" title="Add"><Save size={14} /></button>
                    <button
                      onClick={() => {
                        setAdding(false);
                        setError(null);
                        setAdvanced(prev => { const n = new Set(prev); n.delete('__new'); return n; });
                      }}
                      className="p-1 text-theme-muted hover:bg-dark-600 rounded"
                      title="Cancel"
                    ><X size={14} /></button>
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
