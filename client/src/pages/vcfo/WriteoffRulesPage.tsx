/**
 * Writeoff Rules — Manage expense addback / income deduction rules
 * Rule types: addback_expense, deduct_income, percentage_addback, percentage_deduct
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, X, Pencil, Trash2, ToggleLeft, ToggleRight, Search } from 'lucide-react';
import api from '../../api/client';

interface Group {
  id: number;
  name: string;
  companies?: { id: number; name: string }[];
}

interface WriteoffRule {
  id: number;
  group_id: number;
  rule_name: string;
  rule_type: 'addback_expense' | 'deduct_income' | 'percentage_addback' | 'percentage_deduct';
  company_ids: number[];
  ledger_names: string[];
  config: any;
  is_active: boolean;
  affects_dashboard: boolean;
}

const ruleTypeLabels: Record<string, string> = {
  addback_expense: 'Addback Expense',
  deduct_income: 'Deduct Income',
  percentage_addback: '% Addback',
  percentage_deduct: '% Deduct',
};

const ruleTypeColors: Record<string, string> = {
  addback_expense: 'bg-emerald-500/15 text-emerald-400',
  deduct_income: 'bg-red-500/15 text-red-400',
  percentage_addback: 'bg-teal-500/15 text-teal-400',
  percentage_deduct: 'bg-orange-500/15 text-orange-400',
};

const defaultForm = (): Omit<WriteoffRule, 'id' | 'is_active'> => ({
  group_id: 0,
  rule_name: '',
  rule_type: 'addback_expense',
  company_ids: [],
  ledger_names: [],
  config: {},
  affects_dashboard: true,
});

export default function WriteoffRulesPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string>('');
  const [rules, setRules] = useState<WriteoffRule[]>([]);
  const [loading, setLoading] = useState(false);

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(defaultForm());
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  // Ledger search state
  const [ledgerQuery, setLedgerQuery] = useState('');
  const [ledgerResults, setLedgerResults] = useState<string[]>([]);
  const [ledgerSearching, setLedgerSearching] = useState(false);
  const [showLedgerDropdown, setShowLedgerDropdown] = useState(false);
  const ledgerSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ledgerRef = useRef<HTMLDivElement>(null);

  const selectedGroup = groups.find(g => String(g.id) === groupId);
  const companies = selectedGroup?.companies || [];

  useEffect(() => {
    api.get('/vcfo/groups').then(r => {
      const g = r.data || [];
      setGroups(g);
      if (g.length > 0) setGroupId(String(g[0].id));
    }).catch(() => {});
  }, []);

  const loadRules = useCallback(() => {
    if (!groupId) return;
    setLoading(true);
    api.get('/vcfo/writeoff-rules', { params: { groupId } })
      .then(r => setRules(r.data || []))
      .catch(() => setRules([]))
      .finally(() => setLoading(false));
  }, [groupId]);

  useEffect(() => { loadRules(); }, [loadRules]);

  // Click outside to close ledger dropdown
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ledgerRef.current && !ledgerRef.current.contains(e.target as Node)) {
        setShowLedgerDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const searchLedgers = (q: string) => {
    setLedgerQuery(q);
    if (ledgerSearchTimer.current) clearTimeout(ledgerSearchTimer.current);
    if (q.length < 2) {
      setLedgerResults([]);
      setShowLedgerDropdown(false);
      return;
    }
    ledgerSearchTimer.current = setTimeout(() => {
      setLedgerSearching(true);
      api.get('/vcfo/ledgers/for-writeoff', { params: { groupId, q } })
        .then(r => {
          setLedgerResults(r.data || []);
          setShowLedgerDropdown(true);
        })
        .catch(() => setLedgerResults([]))
        .finally(() => setLedgerSearching(false));
    }, 300);
  };

  const addLedger = (name: string) => {
    if (!form.ledger_names.includes(name)) {
      setForm(prev => ({ ...prev, ledger_names: [...prev.ledger_names, name] }));
    }
    setLedgerQuery('');
    setShowLedgerDropdown(false);
  };

  const removeLedger = (name: string) => {
    setForm(prev => ({ ...prev, ledger_names: prev.ledger_names.filter(n => n !== name) }));
  };

  const toggleCompany = (companyId: number) => {
    setForm(prev => {
      const ids = [...prev.company_ids];
      const idx = ids.indexOf(companyId);
      if (idx >= 0) ids.splice(idx, 1);
      else ids.push(companyId);
      return { ...prev, company_ids: ids };
    });
  };

  const openAdd = () => {
    const f = defaultForm();
    f.group_id = parseInt(groupId);
    setForm(f);
    setEditingId(null);
    setShowModal(true);
  };

  const openEdit = (rule: WriteoffRule) => {
    setForm({
      group_id: rule.group_id,
      rule_name: rule.rule_name,
      rule_type: rule.rule_type,
      company_ids: [...(rule.company_ids || [])],
      ledger_names: [...(rule.ledger_names || [])],
      config: { ...(rule.config || {}) },
      affects_dashboard: rule.affects_dashboard,
    });
    setEditingId(rule.id);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingId(null);
    setForm(defaultForm());
    setLedgerQuery('');
    setLedgerResults([]);
    setShowLedgerDropdown(false);
  };

  const saveRule = async () => {
    if (!form.rule_name.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/vcfo/writeoff-rules/${editingId}`, form);
      } else {
        await api.post('/vcfo/writeoff-rules', form);
      }
      closeModal();
      loadRules();
    } catch {
      // handled silently
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (id: number) => {
    try {
      await api.put(`/vcfo/writeoff-rules/${id}/toggle`);
      setRules(prev => prev.map(r => r.id === id ? { ...r, is_active: !r.is_active } : r));
    } catch {
      // handled silently
    }
  };

  const deleteRule = async (id: number) => {
    try {
      await api.delete(`/vcfo/writeoff-rules/${id}`);
      setDeleteConfirm(null);
      loadRules();
    } catch {
      // handled silently
    }
  };

  const isPercentType = form.rule_type === 'percentage_addback' || form.rule_type === 'percentage_deduct';

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="card-tv p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-theme-heading">Writeoff Rules</h1>
            <p className="text-xs text-theme-faint mt-0.5">Expense addback and income deduction rules</p>
          </div>
          <div className="flex items-center gap-3">
            <select value={groupId} onChange={e => setGroupId(e.target.value)} className="tv-input min-w-[180px]">
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <button onClick={openAdd} className="tv-tab active inline-flex items-center gap-1.5">
              <Plus size={13} /> Add Rule
            </button>
          </div>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" />
        </div>
      )}

      {/* Empty */}
      {!loading && rules.length === 0 && (
        <div className="bg-dark-700 rounded-xl p-12 text-center">
          <p className="text-theme-faint text-sm mb-2">No writeoff rules configured for this group.</p>
          <p className="text-theme-faint text-xs">Click "Add Rule" to create one.</p>
        </div>
      )}

      {/* Rules list */}
      {!loading && rules.length > 0 && (
        <div className="space-y-3">
          {rules.map(rule => (
            <div key={rule.id} className="bg-dark-700 rounded-xl overflow-hidden">
              <div className="flex items-center gap-4 px-5 py-4">
                {/* Toggle */}
                <button onClick={() => toggleRule(rule.id)} className="flex-shrink-0" title={rule.is_active ? 'Active' : 'Inactive'}>
                  {rule.is_active
                    ? <ToggleRight size={22} className="text-emerald-400" />
                    : <ToggleLeft size={22} className="text-theme-faint" />
                  }
                </button>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-semibold ${rule.is_active ? 'text-theme-heading' : 'text-theme-faint line-through'}`}>
                      {rule.rule_name}
                    </span>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${ruleTypeColors[rule.rule_type] || 'bg-indigo-500/15 text-indigo-400'}`}>
                      {ruleTypeLabels[rule.rule_type]}
                    </span>
                    {rule.affects_dashboard && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/15 text-amber-400">
                        Dashboard
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                    {(rule.ledger_names || []).length > 0 && (
                      <span className="text-xs text-theme-faint">
                        {rule.ledger_names.length} ledger{rule.ledger_names.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {(rule.company_ids || []).length > 0 && (
                      <span className="text-xs text-theme-faint">
                        {rule.company_ids.length} company{rule.company_ids.length !== 1 ? 'ies' : ''}
                      </span>
                    )}
                    {rule.config?.percentage != null && (
                      <span className="text-xs text-theme-faint">{rule.config.percentage}%</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => openEdit(rule)}
                    className="p-2 rounded text-theme-faint hover:text-indigo-400 hover:bg-[rgb(var(--c-dark-600))] transition-colors">
                    <Pencil size={14} />
                  </button>
                  {deleteConfirm === rule.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => deleteRule(rule.id)}
                        className="px-2 py-1 text-[10px] font-semibold rounded bg-red-600 text-white hover:bg-red-500 transition-colors">
                        Confirm
                      </button>
                      <button onClick={() => setDeleteConfirm(null)}
                        className="px-2 py-1 text-[10px] font-semibold rounded text-theme-faint hover:text-theme-primary transition-colors">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setDeleteConfirm(rule.id)}
                      className="p-2 rounded text-theme-faint hover:text-red-400 hover:bg-[rgb(var(--c-dark-600))] transition-colors">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-dark-700 rounded-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'rgb(var(--c-dark-400) / 0.3)' }}>
              <h2 className="text-sm font-bold text-theme-heading">{editingId ? 'Edit Rule' : 'Add Writeoff Rule'}</h2>
              <button onClick={closeModal} className="p-1 rounded text-theme-faint hover:text-theme-primary transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-4">
              {/* Rule Name */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Rule Name *</label>
                <input value={form.rule_name} onChange={e => setForm(p => ({ ...p, rule_name: e.target.value }))}
                  placeholder="e.g., Director salary addback" className="tv-input w-full" />
              </div>

              {/* Rule Type */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Rule Type</label>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(ruleTypeLabels).map(([key, label]) => (
                    <button key={key} onClick={() => setForm(p => ({ ...p, rule_type: key as WriteoffRule['rule_type'] }))}
                      className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                        form.rule_type === key ? 'bg-indigo-600 text-white' : 'text-theme-faint hover:text-theme-primary hover:bg-[rgb(var(--c-dark-600))]'
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Companies multi-select */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Companies</label>
                <div className="flex flex-wrap gap-2">
                  {companies.map(c => {
                    const selected = form.company_ids.includes(c.id);
                    return (
                      <button key={c.id} onClick={() => toggleCompany(c.id)}
                        className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                          selected ? 'bg-indigo-600 text-white' : 'text-theme-faint hover:text-theme-primary hover:bg-[rgb(var(--c-dark-600))]'
                        }`}>
                        {c.name}
                      </button>
                    );
                  })}
                </div>
                {companies.length === 0 && (
                  <p className="text-[10px] text-theme-faint mt-1">No companies in this group</p>
                )}
              </div>

              {/* Ledger Names — search multi-select */}
              <div ref={ledgerRef}>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Ledger Names</label>

                {/* Selected ledgers */}
                {form.ledger_names.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {form.ledger_names.map(name => (
                      <span key={name} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-indigo-500/15 text-indigo-400">
                        {name}
                        <button onClick={() => removeLedger(name)} className="hover:text-red-400 transition-colors">
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Search input */}
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint" />
                  <input value={ledgerQuery} onChange={e => searchLedgers(e.target.value)}
                    onFocus={() => { if (ledgerResults.length > 0) setShowLedgerDropdown(true); }}
                    placeholder="Search ledgers..." className="tv-input w-full pl-8" />
                  {ledgerSearching && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="animate-spin rounded-full h-3.5 w-3.5 border-b border-indigo-400" />
                    </div>
                  )}
                </div>

                {/* Dropdown */}
                {showLedgerDropdown && ledgerResults.length > 0 && (
                  <div className="mt-1 rounded-lg bg-dark-600 border max-h-40 overflow-y-auto" style={{ borderColor: 'rgb(var(--c-dark-400) / 0.3)' }}>
                    {ledgerResults.filter(n => !form.ledger_names.includes(n)).map(name => (
                      <button key={name} onClick={() => addLedger(name)}
                        className="w-full text-left px-3 py-2 text-xs text-theme-secondary hover:bg-[rgb(var(--c-dark-500))] hover:text-theme-primary transition-colors">
                        {name}
                      </button>
                    ))}
                    {ledgerResults.filter(n => !form.ledger_names.includes(n)).length === 0 && (
                      <div className="px-3 py-2 text-xs text-theme-faint">All results already selected</div>
                    )}
                  </div>
                )}
                {showLedgerDropdown && ledgerResults.length === 0 && ledgerQuery.length >= 2 && !ledgerSearching && (
                  <div className="mt-1 rounded-lg bg-dark-600 border px-3 py-2 text-xs text-theme-faint" style={{ borderColor: 'rgb(var(--c-dark-400) / 0.3)' }}>
                    No ledgers found
                  </div>
                )}
              </div>

              {/* Percentage field for percentage types */}
              {isPercentType && (
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Percentage (%)</label>
                  <input type="number" step="0.01" value={form.config.percentage || ''}
                    onChange={e => setForm(p => ({ ...p, config: { ...p.config, percentage: parseFloat(e.target.value) || 0 } }))}
                    className="tv-input w-full" placeholder="0.00" />
                </div>
              )}

              {/* Affects Dashboard */}
              <div className="flex items-center">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.affects_dashboard} onChange={e => setForm(p => ({ ...p, affects_dashboard: e.target.checked }))}
                    className="rounded border-gray-600 bg-dark-600 text-indigo-500 focus:ring-indigo-500" />
                  <span className="text-xs text-theme-secondary">Affects Dashboard</span>
                </label>
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 px-5 py-4 border-t" style={{ borderColor: 'rgb(var(--c-dark-400) / 0.3)' }}>
              <button onClick={closeModal} className="px-4 py-2 text-xs font-semibold rounded text-theme-faint hover:text-theme-primary transition-colors">
                Cancel
              </button>
              <button onClick={saveRule} disabled={saving || !form.rule_name.trim()}
                className="tv-tab active px-4 py-2 disabled:opacity-40">
                {saving ? 'Saving...' : editingId ? 'Update Rule' : 'Create Rule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
