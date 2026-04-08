/**
 * Allocation Rules — Manage inter-company allocation rules
 * Rule types: fixed, ratio, percent_income
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, X, Pencil, Trash2, ToggleLeft, ToggleRight, GripVertical } from 'lucide-react';
import api from '../../api/client';

interface Group {
  id: number;
  name: string;
  companies?: { id: number; name: string }[];
}

interface AllocationRule {
  id: number;
  group_id: number;
  rule_name: string;
  rule_type: 'fixed' | 'ratio' | 'percent_income';
  config: any;
  sort_order: number;
  is_active: boolean;
  affects_dashboard: boolean;
}

const ruleTypeLabels: Record<string, string> = {
  fixed: 'Fixed Amount',
  ratio: 'Ratio Split',
  percent_income: '% of Income',
};

const emptyConfig = (type: string) => {
  switch (type) {
    case 'fixed':
      return { from_company_id: '', to_company_id: '', amount: 0, from_date: '', to_date: '', expense_label: '' };
    case 'ratio':
      return { company_ratios: [{ company_id: '', ratio: 1 }], expense_label: '' };
    case 'percent_income':
      return { percentage: 0, source_company_ids: [], target_company_id: '', expense_label: '' };
    default:
      return {};
  }
};

const defaultForm = (): Omit<AllocationRule, 'id' | 'is_active'> => ({
  group_id: 0,
  rule_name: '',
  rule_type: 'fixed',
  config: emptyConfig('fixed'),
  sort_order: 0,
  affects_dashboard: true,
});

export default function AllocationRulesPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string>('');
  const [rules, setRules] = useState<AllocationRule[]>([]);
  const [loading, setLoading] = useState(false);

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(defaultForm());
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  // Derive companies from selected group
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
    api.get('/vcfo/allocation-rules', { params: { groupId } })
      .then(r => setRules(r.data || []))
      .catch(() => setRules([]))
      .finally(() => setLoading(false));
  }, [groupId]);

  useEffect(() => { loadRules(); }, [loadRules]);

  const openAdd = () => {
    const f = defaultForm();
    f.group_id = parseInt(groupId);
    f.sort_order = rules.length + 1;
    setForm(f);
    setEditingId(null);
    setShowModal(true);
  };

  const openEdit = (rule: AllocationRule) => {
    setForm({
      group_id: rule.group_id,
      rule_name: rule.rule_name,
      rule_type: rule.rule_type,
      config: { ...rule.config },
      sort_order: rule.sort_order,
      affects_dashboard: rule.affects_dashboard,
    });
    setEditingId(rule.id);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingId(null);
    setForm(defaultForm());
  };

  const handleTypeChange = (type: string) => {
    setForm(prev => ({
      ...prev,
      rule_type: type as AllocationRule['rule_type'],
      config: emptyConfig(type),
    }));
  };

  const updateConfig = (key: string, value: any) => {
    setForm(prev => ({ ...prev, config: { ...prev.config, [key]: value } }));
  };

  const saveRule = async () => {
    if (!form.rule_name.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/vcfo/allocation-rules/${editingId}`, form);
      } else {
        await api.post('/vcfo/allocation-rules', form);
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
      await api.put(`/vcfo/allocation-rules/${id}/toggle`);
      setRules(prev => prev.map(r => r.id === id ? { ...r, is_active: !r.is_active } : r));
    } catch {
      // handled silently
    }
  };

  const deleteRule = async (id: number) => {
    try {
      await api.delete(`/vcfo/allocation-rules/${id}`);
      setDeleteConfirm(null);
      loadRules();
    } catch {
      // handled silently
    }
  };

  // Ratio helpers
  const addRatio = () => {
    const ratios = [...(form.config.company_ratios || []), { company_id: '', ratio: 1 }];
    updateConfig('company_ratios', ratios);
  };
  const removeRatio = (idx: number) => {
    const ratios = [...(form.config.company_ratios || [])];
    ratios.splice(idx, 1);
    updateConfig('company_ratios', ratios);
  };
  const updateRatio = (idx: number, key: string, val: any) => {
    const ratios = [...(form.config.company_ratios || [])];
    ratios[idx] = { ...ratios[idx], [key]: val };
    updateConfig('company_ratios', ratios);
  };

  // Percent income source toggle
  const toggleSource = (companyId: number) => {
    const sources = [...(form.config.source_company_ids || [])];
    const idx = sources.indexOf(companyId);
    if (idx >= 0) sources.splice(idx, 1);
    else sources.push(companyId);
    updateConfig('source_company_ids', sources);
  };

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="card-tv p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-theme-heading">Allocation Rules</h1>
            <p className="text-xs text-theme-faint mt-0.5">Inter-company cost and revenue allocations</p>
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
          <p className="text-theme-faint text-sm mb-2">No allocation rules configured for this group.</p>
          <p className="text-theme-faint text-xs">Click "Add Rule" to create one.</p>
        </div>
      )}

      {/* Rules list */}
      {!loading && rules.length > 0 && (
        <div className="space-y-3">
          {rules.map(rule => (
            <div key={rule.id} className="bg-dark-700 rounded-xl overflow-hidden">
              <div className="flex items-center gap-4 px-5 py-4">
                <GripVertical size={14} className="text-theme-faint flex-shrink-0" />

                {/* Toggle */}
                <button onClick={() => toggleRule(rule.id)} className="flex-shrink-0" title={rule.is_active ? 'Active' : 'Inactive'}>
                  {rule.is_active
                    ? <ToggleRight size={22} className="text-emerald-400" />
                    : <ToggleLeft size={22} className="text-theme-faint" />
                  }
                </button>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-semibold ${rule.is_active ? 'text-theme-heading' : 'text-theme-faint line-through'}`}>
                      {rule.rule_name}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-400">
                      {ruleTypeLabels[rule.rule_type]}
                    </span>
                    {rule.affects_dashboard && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/15 text-amber-400">
                        Dashboard
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-theme-faint mt-1">
                    {rule.rule_type === 'fixed' && (
                      <>Fixed {new Intl.NumberFormat('en-IN').format(rule.config?.amount || 0)} &middot; {rule.config?.expense_label || 'No label'}</>
                    )}
                    {rule.rule_type === 'ratio' && (
                      <>{(rule.config?.company_ratios || []).length} companies &middot; {rule.config?.expense_label || 'No label'}</>
                    )}
                    {rule.rule_type === 'percent_income' && (
                      <>{rule.config?.percentage || 0}% of income &middot; {rule.config?.expense_label || 'No label'}</>
                    )}
                  </p>
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
              <h2 className="text-sm font-bold text-theme-heading">{editingId ? 'Edit Rule' : 'Add Allocation Rule'}</h2>
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
                  placeholder="e.g., Shared office rent" className="tv-input w-full" />
              </div>

              {/* Rule Type */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Rule Type</label>
                <div className="flex gap-1">
                  {Object.entries(ruleTypeLabels).map(([key, label]) => (
                    <button key={key} onClick={() => handleTypeChange(key)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                        form.rule_type === key ? 'bg-indigo-600 text-white' : 'text-theme-faint hover:text-theme-primary hover:bg-[rgb(var(--c-dark-600))]'
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Config: Fixed */}
              {form.rule_type === 'fixed' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">From Company</label>
                      <select value={form.config.from_company_id || ''} onChange={e => updateConfig('from_company_id', parseInt(e.target.value) || '')} className="tv-input w-full">
                        <option value="">Select...</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">To Company</label>
                      <select value={form.config.to_company_id || ''} onChange={e => updateConfig('to_company_id', parseInt(e.target.value) || '')} className="tv-input w-full">
                        <option value="">Select...</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Amount</label>
                    <input type="number" value={form.config.amount || ''} onChange={e => updateConfig('amount', parseFloat(e.target.value) || 0)}
                      className="tv-input w-full" placeholder="0" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">From Date</label>
                      <input type="date" value={form.config.from_date || ''} onChange={e => updateConfig('from_date', e.target.value)} className="tv-input w-full" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">To Date</label>
                      <input type="date" value={form.config.to_date || ''} onChange={e => updateConfig('to_date', e.target.value)} className="tv-input w-full" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Expense Label</label>
                    <input value={form.config.expense_label || ''} onChange={e => updateConfig('expense_label', e.target.value)}
                      placeholder="e.g., Office Rent Allocation" className="tv-input w-full" />
                  </div>
                </>
              )}

              {/* Config: Ratio */}
              {form.rule_type === 'ratio' && (
                <>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Company Ratios</label>
                    <div className="space-y-2">
                      {(form.config.company_ratios || []).map((cr: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-2">
                          <select value={cr.company_id || ''} onChange={e => updateRatio(idx, 'company_id', parseInt(e.target.value) || '')}
                            className="tv-input flex-1">
                            <option value="">Select company...</option>
                            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                          <input type="number" value={cr.ratio || ''} onChange={e => updateRatio(idx, 'ratio', parseFloat(e.target.value) || 0)}
                            className="tv-input w-20" placeholder="Ratio" />
                          <button onClick={() => removeRatio(idx)} className="p-1 text-theme-faint hover:text-red-400 transition-colors">
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button onClick={addRatio}
                      className="mt-2 text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1 transition-colors">
                      <Plus size={12} /> Add Company
                    </button>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Expense Label</label>
                    <input value={form.config.expense_label || ''} onChange={e => updateConfig('expense_label', e.target.value)}
                      placeholder="e.g., Shared Utilities" className="tv-input w-full" />
                  </div>
                </>
              )}

              {/* Config: Percent Income */}
              {form.rule_type === 'percent_income' && (
                <>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Percentage (%)</label>
                    <input type="number" step="0.01" value={form.config.percentage || ''} onChange={e => updateConfig('percentage', parseFloat(e.target.value) || 0)}
                      className="tv-input w-full" placeholder="0.00" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Source Companies</label>
                    <div className="flex flex-wrap gap-2">
                      {companies.map(c => {
                        const selected = (form.config.source_company_ids || []).includes(c.id);
                        return (
                          <button key={c.id} onClick={() => toggleSource(c.id)}
                            className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                              selected ? 'bg-indigo-600 text-white' : 'text-theme-faint hover:text-theme-primary hover:bg-[rgb(var(--c-dark-600))]'
                            }`}>
                            {c.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Target Company</label>
                    <select value={form.config.target_company_id || ''} onChange={e => updateConfig('target_company_id', parseInt(e.target.value) || '')}
                      className="tv-input w-full">
                      <option value="">Select...</option>
                      {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Expense Label</label>
                    <input value={form.config.expense_label || ''} onChange={e => updateConfig('expense_label', e.target.value)}
                      placeholder="e.g., Management Fee" className="tv-input w-full" />
                  </div>
                </>
              )}

              {/* Sort order & Dashboard */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Sort Order</label>
                  <input type="number" value={form.sort_order || ''} onChange={e => setForm(p => ({ ...p, sort_order: parseInt(e.target.value) || 0 }))}
                    className="tv-input w-full" />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.affects_dashboard} onChange={e => setForm(p => ({ ...p, affects_dashboard: e.target.checked }))}
                      className="rounded border-gray-600 bg-dark-600 text-indigo-500 focus:ring-indigo-500" />
                    <span className="text-xs text-theme-secondary">Affects Dashboard</span>
                  </label>
                </div>
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
