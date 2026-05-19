// Cost Allocation rules — the "true management P&L" admin surface.
//
// Tenant-level CRUD for the rules engine that adjusts the books P&L into a
// true-cost view (see services/vcfo-allocation-engine.ts on the server).
//
// Two rule kinds map to the two patterns this client cares about:
//   pool_split   — one source bucket distributed across destinations
//                  (Rent at BTM Clinic split by sqft into BTM Pharmacy)
//   cross_charge — destinations charged X% of their own metric, sum credits
//                  a single provider (Hyderabad lab fees → Jubilee Hills)
//
// MVP scope (this slice): pool_split + ledger source + the three most
// useful methods (weighted_ratio, fixed_pct, equal_split). Cross-charge
// + revenue_share + manual_amounts arrive in slice 2.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Plus, Pencil, Trash2, ToggleLeft, ToggleRight,
  X, Save, AlertTriangle, Calculator, Loader2,
} from 'lucide-react';
import api from '../api/client';

// ─── Types ───────────────────────────────────────────────────────────────

type RuleKind = 'pool_split' | 'cross_charge';
type SourceType = 'ledger' | 'pl_line' | 'custom_amount';
type AllocMethod = 'fixed_pct' | 'equal_split' | 'revenue_share' | 'weighted_ratio' | 'manual_amounts';

interface RuleDestination {
  id?: number;
  destination_company_id: number;
  weight: number;
  weight_basis_label?: string | null;
  sort_order?: number;
}

/** One branch group inside a multi-branch rule. Each carries its own source +
 *  destinations and is treated as an independent pool-split run, sharing
 *  alloc_method + target_pl_section_key with the rule envelope. */
interface BranchConfig {
  label?: string | null;
  source_type: SourceType;
  source_company_id?: number | null;
  source_ledger_name?: string | null;
  source_pl_section_key?: string | null;
  source_custom_amount?: number | null;
  destinations: RuleDestination[];
}

interface Rule {
  id: number;
  name: string;
  description: string | null;
  enabled: 0 | 1;
  effective_from: string | null;
  effective_to: string | null;
  priority: number;
  rule_kind: RuleKind;
  source_type: SourceType | null;
  source_company_id: number | null;
  source_ledger_name: string | null;
  source_pl_section_key: string | null;
  source_custom_amount: number | null;
  provider_company_id: number | null;
  charge_basis_section_key: string | null;
  charge_pct: number | null;
  provider_credit_section_key: string | null;
  alloc_method: AllocMethod | null;
  target_pl_section_key: string | null;
  destinations: RuleDestination[];
  /** Multi-branch mode: non-null array means use these per-branch (source,
   *  destinations) groups instead of rule-level source/destinations. */
  branch_configs?: BranchConfig[] | null;
}

interface Company {
  id: number;
  name: string;
  entity_type?: string | null;
  location?: string | null;
}

interface Ledger {
  name: string;
  group_name: string | null;
  parent_group: string | null;
}

interface SectionNode {
  key: string;
  label: string;
  depth: number;
  isExpense: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const PL_SECTIONS: Array<{ key: string; label: string }> = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'directCosts', label: 'Direct Costs' },
  { key: 'indirectIncome', label: 'Indirect Income' },
  { key: 'indirectExpenses', label: 'Indirect Expenses' },
];

const ALLOC_METHODS: Array<{ key: AllocMethod; label: string; help: string }> = [
  { key: 'weighted_ratio', label: 'Weighted ratio (e.g. sqft)', help: 'Enter a raw basis number per destination — sqft, headcount, anything. Engine normalises.' },
  { key: 'fixed_pct', label: 'Fixed %', help: 'Enter a percentage per destination. Must sum to 100.' },
  { key: 'equal_split', label: 'Equal split', help: 'Distribute equally across all destinations. Weights ignored.' },
  { key: 'revenue_share', label: 'Revenue share', help: 'Distribute in proportion to each destination\'s revenue for the period.' },
  { key: 'manual_amounts', label: 'Manual amounts', help: 'Enter absolute rupees per destination. Difference stays at source.' },
];

/**
 * Render <option> elements for the section dropdowns. Uses the live section
 * tree when available (so nested categories like 'revenue:Sales:Diagnostics'
 * are pickable); falls back to PL_SECTIONS when the tree hasn't loaded yet.
 * Depth ≥ 1 children are visually indented in the option label.
 */
function sectionOptions(tree: SectionNode[]): JSX.Element[] {
  if (tree.length === 0) {
    return PL_SECTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>);
  }
  return tree.map(n => {
    const indent = '  '.repeat(n.depth);
    const arrow = n.depth > 0 ? '↳ ' : '';
    return (
      <option key={n.key} value={n.key} title={n.key}>
        {indent}{arrow}{n.label}
      </option>
    );
  });
}

function emptyRule(): Rule {
  return {
    id: 0,
    name: '',
    description: '',
    enabled: 1,
    effective_from: null,
    effective_to: null,
    priority: 100,
    rule_kind: 'pool_split',
    source_type: 'ledger',
    source_company_id: null,
    source_ledger_name: '',
    source_pl_section_key: 'indirectExpenses',
    source_custom_amount: 0,
    provider_company_id: null,
    charge_basis_section_key: 'revenue',
    charge_pct: 30,
    provider_credit_section_key: 'directCosts',
    alloc_method: 'weighted_ratio',
    target_pl_section_key: 'indirectExpenses',
    destinations: [],
    branch_configs: null,
  };
}

/** Empty branch_config shell — used when "Add another branch" is clicked. */
function emptyBranchConfig(): BranchConfig {
  return {
    label: '',
    source_type: 'ledger',
    source_company_id: null,
    source_ledger_name: '',
    source_pl_section_key: 'indirectExpenses',
    source_custom_amount: 0,
    destinations: [],
  };
}

function companyLabel(c: Company): string {
  if (c.location && c.entity_type) return `${c.name} (${c.location} · ${c.entity_type})`;
  if (c.location) return `${c.name} (${c.location})`;
  return c.name;
}

function summariseSource(r: Rule, companies: Company[]): string {
  if (r.rule_kind === 'cross_charge') {
    const provider = companies.find(c => c.id === r.provider_company_id);
    return `${r.charge_pct?.toFixed(0) || '?'}% → ${provider?.name || 'Provider?'}`;
  }
  // Multi-branch: roll up the count so the row stays readable.
  if (r.branch_configs && r.branch_configs.length > 0) {
    return `${r.branch_configs.length} branches`;
  }
  if (r.source_type === 'ledger') {
    const co = companies.find(c => c.id === r.source_company_id);
    return `${r.source_ledger_name || 'Ledger?'} @ ${co?.name || 'co?'}`;
  }
  if (r.source_type === 'pl_line') {
    const sec = PL_SECTIONS.find(s => s.key === r.source_pl_section_key);
    const co = companies.find(c => c.id === r.source_company_id);
    return `${sec?.label || r.source_pl_section_key} @ ${co?.name || 'co?'}`;
  }
  if (r.source_type === 'custom_amount') {
    return `Custom ₹${(r.source_custom_amount || 0).toLocaleString('en-IN')}`;
  }
  return '—';
}

// ─── Main Page ───────────────────────────────────────────────────────────

export default function CostAllocationPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);

  const loadRules = () => {
    return api.get('/vcfo/cost-allocation-rules').then(res => setRules(res.data));
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([loadRules(), api.get('/vcfo/companies').then(res => setCompanies(res.data))])
      .catch(err => setError(err?.response?.data?.error || 'Failed to load rules'))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (id: number) => {
    api.patch(`/vcfo/cost-allocation-rules/${id}/toggle`).then(loadRules);
  };
  const remove = (id: number) => {
    if (!confirm('Delete this rule? Cannot be undone.')) return;
    api.delete(`/vcfo/cost-allocation-rules/${id}`).then(loadRules);
  };

  const saveRule = async (r: Rule) => {
    if (r.id === 0) {
      await api.post('/vcfo/cost-allocation-rules', r);
    } else {
      await api.put(`/vcfo/cost-allocation-rules/${r.id}`, r);
    }
    setEditingRule(null);
    await loadRules();
  };

  return (
    <div className="min-h-screen bg-dark-900 text-theme-primary">
      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link to="/vcfo/profit-loss" className="inline-flex items-center gap-2 text-theme-faint hover:text-theme-primary text-sm mb-2">
              <ArrowLeft size={14} />
              Back to P&amp;L
            </Link>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Calculator size={22} className="text-accent-400" />
              Cost Allocation Rules
            </h1>
            <p className="text-theme-faint text-sm mt-1 max-w-2xl">
              Rules that adjust the as-booked P&amp;L into a true-cost management view.
              The books table at <code className="text-accent-300">/vcfo/profit-loss</code> stays the audit trail; an adjusted view appears below it.
            </p>
          </div>
          <button
            onClick={() => setEditingRule(emptyRule())}
            className="inline-flex items-center gap-2 bg-accent-500 hover:bg-accent-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            <Plus size={16} /> New rule
          </button>
        </div>

        {loading && <div className="text-theme-faint py-12 text-center"><Loader2 className="animate-spin inline mr-2" size={16} />Loading rules…</div>}
        {error && <div className="text-red-400 py-8 text-center">{error}</div>}

        {!loading && !error && (
          rules.length === 0 ? (
            <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-12 text-center">
              <Calculator size={36} className="mx-auto text-theme-faint mb-3 opacity-40" />
              <p className="text-theme-muted">No rules yet.</p>
              <p className="text-theme-faint text-sm mt-1">
                Click <strong>New rule</strong> to set up your first cost allocation
                — for example, rent split between Clinic and Pharmacy at the same location based on occupied square footage.
              </p>
            </div>
          ) : (
            <div className="bg-dark-800 border border-dark-400/30 rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-dark-700 text-xs font-semibold text-theme-muted uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-4 py-3">Enabled</th>
                    <th className="text-left px-4 py-3">Name</th>
                    <th className="text-left px-4 py-3">Kind</th>
                    <th className="text-left px-4 py-3">Source</th>
                    <th className="text-left px-4 py-3">Method</th>
                    <th className="text-right px-4 py-3">Destinations</th>
                    <th className="text-right px-4 py-3">Priority</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map(r => (
                    <tr key={r.id} className="border-t border-dark-400/20 hover:bg-dark-600/20">
                      <td className="px-4 py-3">
                        <button onClick={() => toggle(r.id)} className="text-accent-400 hover:text-accent-300">
                          {r.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} className="text-theme-faint" />}
                        </button>
                      </td>
                      <td className="px-4 py-3 font-medium">{r.name}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${r.rule_kind === 'pool_split' ? 'bg-blue-500/15 text-blue-300' : 'bg-purple-500/15 text-purple-300'}`}>
                          {r.rule_kind === 'pool_split' ? 'Pool split' : 'Cross-charge'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-theme-muted">{summariseSource(r, companies)}</td>
                      <td className="px-4 py-3 text-theme-muted text-xs">
                        {r.rule_kind === 'pool_split'
                          ? ALLOC_METHODS.find(m => m.key === r.alloc_method)?.label || '—'
                          : `${r.charge_pct?.toFixed(0) || '?'}% cross-charge`}
                      </td>
                      <td className="px-4 py-3 text-right">{r.destinations.length}</td>
                      <td className="px-4 py-3 text-right text-theme-faint">{r.priority}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => setEditingRule(r)} className="text-theme-faint hover:text-accent-300 mr-2"><Pencil size={14} /></button>
                        <button onClick={() => remove(r.id)} className="text-theme-faint hover:text-red-400"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {editingRule && (
          <RuleEditorModal
            initial={editingRule}
            companies={companies}
            onCancel={() => setEditingRule(null)}
            onSave={saveRule}
          />
        )}
      </div>
    </div>
  );
}

// ─── Rule Editor Modal ───────────────────────────────────────────────────

function RuleEditorModal(props: {
  initial: Rule;
  companies: Company[];
  onCancel: () => void;
  onSave: (r: Rule) => Promise<void>;
}) {
  const { initial, companies, onCancel, onSave } = props;
  const [r, setR] = useState<Rule>(initial);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [sectionTree, setSectionTree] = useState<SectionNode[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load ledger picker when source_type=ledger and source_company_id changes.
  useEffect(() => {
    if (r.rule_kind !== 'pool_split' || r.source_type !== 'ledger' || !r.source_company_id) {
      setLedgers([]);
      return;
    }
    api.get(`/vcfo/cost-allocation-rules/_helpers/ledgers/${r.source_company_id}`)
      .then(res => setLedgers(res.data))
      .catch(() => setLedgers([]));
  }, [r.rule_kind, r.source_type, r.source_company_id]);

  // Load section tree once for the dropdown pickers. Stays valid for the
  // editor's lifetime — the section keys are stable across periods (only
  // child-set content changes, not keys themselves).
  useEffect(() => {
    api.get('/vcfo/cost-allocation-rules/_helpers/section-tree')
      .then(res => setSectionTree(res.data))
      .catch(() => setSectionTree([]));
  }, []);

  const set = <K extends keyof Rule>(key: K, val: Rule[K]) => setR(prev => ({ ...prev, [key]: val }));

  const setDest = (idx: number, patch: Partial<RuleDestination>) => {
    setR(prev => ({
      ...prev,
      destinations: prev.destinations.map((d, i) => i === idx ? { ...d, ...patch } : d),
    }));
  };
  const addDest = (companyId: number) => {
    if (r.destinations.some(d => d.destination_company_id === companyId)) return;
    setR(prev => ({
      ...prev,
      destinations: [...prev.destinations, { destination_company_id: companyId, weight: 0, sort_order: prev.destinations.length }],
    }));
  };
  const removeDest = (idx: number) => {
    setR(prev => ({ ...prev, destinations: prev.destinations.filter((_, i) => i !== idx) }));
  };

  const isMultiBranch = !!(r.branch_configs && r.branch_configs.length > 0);

  // Client-side validation.
  const validation = useMemo(() => {
    if (!r.name.trim()) return 'Name is required';
    if (r.effective_from && r.effective_to && r.effective_to < r.effective_from) {
      return 'Effective "to" date must be on or after "from" date';
    }

    if (r.rule_kind === 'pool_split') {
      if (!r.alloc_method) return 'Allocation method is required';

      // Multi-branch validation: each branch self-checks.
      if (isMultiBranch) {
        for (const [i, bc] of (r.branch_configs as BranchConfig[]).entries()) {
          const tag = bc.label?.trim() || `Branch ${i + 1}`;
          if (bc.destinations.length === 0) return `${tag}: at least one destination is required`;
          if (!bc.source_type) return `${tag}: source type is required`;
          if (bc.source_type === 'ledger') {
            if (!bc.source_company_id) return `${tag}: source company is required for ledger source`;
            if (!bc.source_ledger_name?.trim()) return `${tag}: source ledger name is required`;
          } else if (bc.source_type === 'pl_line') {
            if (!bc.source_company_id) return `${tag}: source company is required for P&L line source`;
            if (!bc.source_pl_section_key) return `${tag}: source P&L section is required`;
          }
          if (r.alloc_method === 'fixed_pct') {
            const sum = bc.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
            if (Math.abs(sum - 100) > 0.01) return `${tag}: fixed % destinations must sum to 100 (currently ${sum.toFixed(2)})`;
          }
          if (r.alloc_method === 'weighted_ratio') {
            const sum = bc.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
            if (sum <= 0) return `${tag}: weighted ratio needs at least one non-zero weight`;
          }
        }
        return null;
      }

      // Single-source mode (legacy path).
      if (r.destinations.length === 0) return 'At least one destination is required';
      if (!r.source_type) return 'Source type is required';
      if (r.source_type === 'ledger') {
        if (!r.source_company_id) return 'Source company is required for ledger source';
        if (!r.source_ledger_name?.trim()) return 'Source ledger name is required';
      } else if (r.source_type === 'pl_line') {
        if (!r.source_company_id) return 'Source company is required for P&L line source';
        if (!r.source_pl_section_key) return 'Source P&L section is required';
      }
      if (r.source_company_id && r.destinations.some(d => d.destination_company_id === r.source_company_id)) {
        return 'Source company cannot also be a destination';
      }
      if (r.alloc_method === 'fixed_pct') {
        const sum = r.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
        if (Math.abs(sum - 100) > 0.01) return `Fixed % destinations must sum to 100 (currently ${sum.toFixed(2)})`;
      }
      if (r.alloc_method === 'weighted_ratio') {
        const sum = r.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
        if (sum <= 0) return 'Weighted ratio needs at least one non-zero weight';
      }
    } else {
      if (r.destinations.length === 0) return 'At least one consumer is required';
      if (!r.provider_company_id) return 'Provider company is required';
      if (!r.charge_basis_section_key) return 'Charge basis section is required';
      if (!r.charge_pct || r.charge_pct <= 0 || r.charge_pct > 100) return 'Charge % must be in (0, 100]';
      if (r.destinations.some(d => d.destination_company_id === r.provider_company_id)) {
        return 'Provider cannot also be a destination';
      }
    }
    return null;
  }, [r, isMultiBranch]);

  // Live preview of derived percentages for weighted_ratio.
  const weightSum = useMemo(
    () => r.destinations.reduce((a, d) => a + Number(d.weight || 0), 0),
    [r.destinations],
  );

  // ── Rule-effect preview ──────────────────────────────────────────────
  // Debounced dry-run against the server. Renders below as a small
  // "if you save this, here's the impact" card.
  interface PreviewResult {
    period: { from: string; to: string };
    events: Array<{ ruleName: string; sourceLabel: string; destinationLabel: string; destinationCol: string; amount: number; basisNote?: string }>;
    warnings: string[];
    deltas: Record<string, number>;
    columnLabels: Record<string, string>;
  }
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (validation) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      api.post('/vcfo/cost-allocation-rules/_preview', { rule: r })
        .then(res => setPreview(res.data))
        .catch(err => setPreviewError(err?.response?.data?.error || 'Preview failed'))
        .finally(() => setPreviewLoading(false));
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(r), validation]);

  const submit = async () => {
    if (validation) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(r);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const availableDests = companies.filter(c =>
    !r.destinations.some(d => d.destination_company_id === c.id) &&
    c.id !== r.source_company_id &&
    c.id !== r.provider_company_id
  );

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-12 pb-12 px-4 overflow-y-auto">
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-2xl w-full max-w-3xl">
        <div className="px-5 py-4 border-b border-dark-400/30 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{r.id === 0 ? 'New cost-allocation rule' : `Edit: ${r.name || 'rule'}`}</h3>
          <button onClick={onCancel} className="text-theme-faint hover:text-theme-primary"><X size={18} /></button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Rule kind */}
          <div>
            <label className="block text-xs font-medium text-theme-muted mb-1.5">Rule kind</label>
            <div className="inline-flex bg-dark-700 rounded-lg p-1 text-sm">
              {(['pool_split', 'cross_charge'] as RuleKind[]).map(k => (
                <button
                  key={k}
                  onClick={() => set('rule_kind', k)}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    r.rule_kind === k ? 'bg-accent-500 text-white' : 'text-theme-muted hover:text-theme-primary'
                  }`}
                >
                  {k === 'pool_split' ? 'Pool split' : 'Cross-charge'}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-theme-faint mt-1.5">
              {r.rule_kind === 'pool_split'
                ? 'One source bucket fanned out across destinations (e.g. rent split by sqft).'
                : 'Destinations charged X% of their own metric; sum credits a single provider (e.g. central lab fees).'}
            </p>
          </div>

          {/* Name + description */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-theme-muted mb-1.5">Name *</label>
              <input
                value={r.name}
                onChange={e => set('name', e.target.value)}
                placeholder='e.g. "Rent: BTM split by sqft"'
                className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-theme-muted mb-1.5">Priority</label>
              <input
                type="number"
                value={r.priority}
                onChange={e => set('priority', parseInt(e.target.value) || 100)}
                className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-[10px] text-theme-faint mt-1">Lower number applies first. Default 100.</p>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-theme-muted mb-1.5">Description (optional)</label>
            <input
              value={r.description || ''}
              onChange={e => set('description', e.target.value)}
              className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          {/* Effective window — leave both blank for "always on". Engine
              filters rules by overlap with the requested PL period. */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-theme-muted mb-1.5">Effective from (optional)</label>
              <input
                type="date"
                value={r.effective_from || ''}
                onChange={e => set('effective_from', e.target.value || null)}
                className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-[10px] text-theme-faint mt-1">Blank = always on from the start of time.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-theme-muted mb-1.5">Effective to (optional)</label>
              <input
                type="date"
                value={r.effective_to || ''}
                onChange={e => set('effective_to', e.target.value || null)}
                className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
              />
              <p className="text-[10px] text-theme-faint mt-1">Blank = always on through eternity.</p>
            </div>
          </div>

          {/* Multi-branch mode toggle (pool_split only). Lets one rule cover
              every branch — e.g. one "Rent Adjustment" rule that splits rent
              at each location by that location's sqft ratio. */}
          {r.rule_kind === 'pool_split' && (
            <div className="border-t border-dark-400/30 pt-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isMultiBranch}
                  onChange={e => {
                    if (e.target.checked) {
                      // Switching on: seed the array with one branch built
                      // from whatever rule-level source the user already filled in
                      // (no data lost), so the editor starts populated.
                      const seed: BranchConfig = {
                        label: '',
                        source_type: r.source_type || 'ledger',
                        source_company_id: r.source_company_id,
                        source_ledger_name: r.source_ledger_name,
                        source_pl_section_key: r.source_pl_section_key,
                        source_custom_amount: r.source_custom_amount,
                        destinations: r.destinations,
                      };
                      set('branch_configs', [seed]);
                    } else {
                      // Switching off: collapse the first branch back into
                      // rule-level fields so the single-source form stays usable.
                      const first = r.branch_configs?.[0];
                      if (first) {
                        setR(prev => ({
                          ...prev,
                          source_type: first.source_type,
                          source_company_id: first.source_company_id ?? null,
                          source_ledger_name: first.source_ledger_name ?? null,
                          source_pl_section_key: first.source_pl_section_key ?? null,
                          source_custom_amount: first.source_custom_amount ?? null,
                          destinations: first.destinations,
                          branch_configs: null,
                        }));
                      } else {
                        set('branch_configs', null);
                      }
                    }
                  }}
                  className="mt-0.5 w-4 h-4 accent-accent-500"
                />
                <div>
                  <div className="text-sm font-medium text-theme-primary">Multi-branch mode</div>
                  <div className="text-[11px] text-theme-faint">
                    One rule covers every branch. Add a separate (source → destinations) group per location —
                    e.g. one "Rent Adjustment" rule that splits rent at each branch by its own sqft ratio.
                  </div>
                </div>
              </label>
            </div>
          )}

          {/* Pool-split fields (single-source mode) */}
          {r.rule_kind === 'pool_split' && !isMultiBranch && (
            <>
              <div className="border-t border-dark-400/30 pt-4">
                <h4 className="text-sm font-semibold text-theme-muted mb-3">Source</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-theme-muted mb-1.5">Source type</label>
                    <select
                      value={r.source_type || 'ledger'}
                      onChange={e => set('source_type', e.target.value as SourceType)}
                      className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="ledger">Tally ledger</option>
                      <option value="pl_line">P&amp;L section</option>
                      <option value="custom_amount">Custom amount</option>
                    </select>
                  </div>
                  {r.source_type !== 'custom_amount' && (
                    <div>
                      <label className="block text-xs text-theme-muted mb-1.5">Source company</label>
                      <select
                        value={r.source_company_id || ''}
                        onChange={e => set('source_company_id', e.target.value ? parseInt(e.target.value) : null)}
                        className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
                      >
                        <option value="">— choose company —</option>
                        {companies.map(c => <option key={c.id} value={c.id}>{companyLabel(c)}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                {r.source_type === 'ledger' && (
                  <div className="mt-3">
                    <label className="block text-xs text-theme-muted mb-1.5">Ledger</label>
                    <select
                      value={r.source_ledger_name || ''}
                      onChange={e => set('source_ledger_name', e.target.value)}
                      disabled={!r.source_company_id || ledgers.length === 0}
                      className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
                    >
                      <option value="">— choose ledger —</option>
                      {ledgers.map(l => (
                        <option key={l.name} value={l.name}>
                          {l.name} {l.group_name ? `· ${l.group_name}` : ''}
                        </option>
                      ))}
                    </select>
                    {ledgers.length === 0 && r.source_company_id && (
                      <p className="text-[10px] text-theme-faint mt-1">Loading ledgers…</p>
                    )}
                  </div>
                )}
                {r.source_type === 'pl_line' && (
                  <div className="mt-3">
                    <label className="block text-xs text-theme-muted mb-1.5">P&amp;L section / sub-line</label>
                    <select
                      value={r.source_pl_section_key || 'indirectExpenses'}
                      onChange={e => set('source_pl_section_key', e.target.value)}
                      className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm font-mono"
                    >
                      {sectionOptions(sectionTree)}
                    </select>
                    <p className="text-[10px] text-theme-faint mt-1">
                      The selected section's current value at the source company column is used as the pool.
                      Indented entries are nested sub-lines under their parent.
                    </p>
                  </div>
                )}
                {r.source_type === 'custom_amount' && (
                  <div className="mt-3">
                    <label className="block text-xs text-theme-muted mb-1.5">Custom amount (₹)</label>
                    <input
                      type="number"
                      value={r.source_custom_amount || 0}
                      onChange={e => set('source_custom_amount', parseFloat(e.target.value) || 0)}
                      className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
                    />
                    <p className="text-[10px] text-theme-faint mt-1">
                      Synthetic amount — no source cell is drained. Useful for back-of-envelope reallocations.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Multi-branch editor: per-branch (source → destinations) groups.
              Each branch is a self-contained pool-split run sharing
              alloc_method + target section with the rule envelope below. */}
          {r.rule_kind === 'pool_split' && isMultiBranch && (
            <MultiBranchEditor
              configs={r.branch_configs as BranchConfig[]}
              onChange={configs => set('branch_configs', configs)}
              companies={companies}
              sectionTree={sectionTree}
              allocMethod={r.alloc_method}
            />
          )}

          {/* Distribution section — applies to BOTH single-source and
              multi-branch pool_split rules (shared alloc_method + target). */}
          {r.rule_kind === 'pool_split' && (
            <>
              <div className="border-t border-dark-400/30 pt-4">
                <h4 className="text-sm font-semibold text-theme-muted mb-3">Distribution</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-theme-muted mb-1.5">Method</label>
                    <select
                      value={r.alloc_method || 'weighted_ratio'}
                      onChange={e => set('alloc_method', e.target.value as AllocMethod)}
                      className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
                    >
                      {ALLOC_METHODS.map(m => (
                        <option key={m.key} value={m.key}>{m.label}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-theme-faint mt-1">
                      {ALLOC_METHODS.find(m => m.key === r.alloc_method)?.help}
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-theme-muted mb-1.5">Target P&amp;L section</label>
                    <select
                      value={r.target_pl_section_key || 'indirectExpenses'}
                      onChange={e => set('target_pl_section_key', e.target.value)}
                      className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm font-mono"
                    >
                      {sectionOptions(sectionTree)}
                    </select>
                    <p className="text-[10px] text-theme-faint mt-1">Where the allocated amount lands at each destination.</p>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Cross-charge fields */}
          {r.rule_kind === 'cross_charge' && (
            <div className="border-t border-dark-400/30 pt-4">
              <h4 className="text-sm font-semibold text-theme-muted mb-3">Cross-charge</h4>
              <p className="text-xs text-theme-faint mb-3">
                Each consumer below is charged a percentage of <em>its own</em> metric.
                The sum is credited back to the provider — typically reducing a cost the
                provider already booked centrally (e.g. lab consumables).
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-theme-muted mb-1.5">Provider company</label>
                  <select
                    value={r.provider_company_id || ''}
                    onChange={e => set('provider_company_id', e.target.value ? parseInt(e.target.value) : null)}
                    className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">— choose provider —</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{companyLabel(c)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-theme-muted mb-1.5">Charge basis (P&amp;L line)</label>
                  <select
                    value={r.charge_basis_section_key || 'revenue'}
                    onChange={e => set('charge_basis_section_key', e.target.value)}
                    className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm font-mono"
                  >
                    {sectionOptions(sectionTree)}
                  </select>
                  <p className="text-[10px] text-theme-faint mt-1">
                    The consumer's value on this line is multiplied by Charge %. Indented entries are nested sub-lines.
                  </p>
                </div>
                <div>
                  <label className="block text-xs text-theme-muted mb-1.5">Charge %</label>
                  <input
                    type="number"
                    value={r.charge_pct || 0}
                    onChange={e => set('charge_pct', parseFloat(e.target.value) || 0)}
                    className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-theme-muted mb-1.5">Provider credit lands at</label>
                  <select
                    value={r.provider_credit_section_key || 'directCosts'}
                    onChange={e => set('provider_credit_section_key', e.target.value)}
                    className="w-full bg-dark-700 border border-dark-400/40 rounded-lg px-3 py-2 text-sm font-mono"
                  >
                    {sectionOptions(sectionTree)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Destinations (rule-level — single-source pool_split + all cross_charge).
              Hidden in multi-branch mode: each branch carries its own dests. */}
          {!isMultiBranch && (
          <div className="border-t border-dark-400/30 pt-4">
            <h4 className="text-sm font-semibold text-theme-muted mb-3">
              {r.rule_kind === 'pool_split' ? 'Destinations' : 'Consumers'}
              <span className="text-theme-faint ml-2 font-normal text-[11px]">
                {r.destinations.length} added
              </span>
            </h4>

            {r.alloc_method === 'weighted_ratio' && r.rule_kind === 'pool_split' && r.destinations.length > 0 && (
              <div className="mb-2">
                <label className="text-[11px] text-theme-muted">Weight unit (informational)</label>
                <input
                  value={r.destinations[0]?.weight_basis_label || ''}
                  onChange={e => {
                    const v = e.target.value;
                    setR(prev => ({
                      ...prev,
                      destinations: prev.destinations.map(d => ({ ...d, weight_basis_label: v })),
                    }));
                  }}
                  placeholder='e.g. "sqft" or "headcount"'
                  className="ml-2 bg-dark-700 border border-dark-400/40 rounded px-2 py-1 text-xs"
                />
              </div>
            )}

            {r.destinations.length === 0 ? (
              <p className="text-xs text-theme-faint italic">No destinations added yet.</p>
            ) : (
              <div className="space-y-2">
                {r.destinations.map((d, i) => {
                  const co = companies.find(c => c.id === d.destination_company_id);
                  const derivedPct = weightSum > 0 ? (Number(d.weight || 0) / weightSum) * 100 : 0;
                  return (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <div className="flex-1 px-3 py-2 bg-dark-700 rounded border border-dark-400/40">
                        {co ? companyLabel(co) : `Company #${d.destination_company_id}`}
                      </div>
                      {r.rule_kind === 'pool_split' && r.alloc_method !== 'equal_split' && r.alloc_method !== 'revenue_share' && (
                        <>
                          <input
                            type="number"
                            value={d.weight}
                            onChange={e => setDest(i, { weight: parseFloat(e.target.value) || 0 })}
                            placeholder={r.alloc_method === 'fixed_pct' ? '%' : r.alloc_method === 'weighted_ratio' ? 'sqft' : '₹'}
                            className="w-24 bg-dark-700 border border-dark-400/40 rounded px-2 py-2 text-sm text-right"
                          />
                          <div className="w-20 text-[11px] text-theme-faint text-right">
                            {r.alloc_method === 'weighted_ratio' && weightSum > 0 && (
                              <>≈ {derivedPct.toFixed(1)}%</>
                            )}
                            {r.alloc_method === 'fixed_pct' && '%'}
                          </div>
                        </>
                      )}
                      <button onClick={() => removeDest(i)} className="text-theme-faint hover:text-red-400 p-1">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
                {r.alloc_method === 'fixed_pct' && r.rule_kind === 'pool_split' && (
                  <div className="text-xs text-theme-faint pl-3">
                    Sum: <strong className={Math.abs(weightSum - 100) > 0.01 ? 'text-red-400' : 'text-emerald-400'}>{weightSum.toFixed(2)}%</strong>
                    {Math.abs(weightSum - 100) > 0.01 && <span className="ml-2">— must equal 100</span>}
                  </div>
                )}
              </div>
            )}

            {availableDests.length > 0 && (
              <div className="mt-3">
                <label className="text-[11px] text-theme-muted">Add destination</label>
                <select
                  value=""
                  onChange={e => { if (e.target.value) addDest(parseInt(e.target.value)); }}
                  className="ml-2 bg-dark-700 border border-dark-400/40 rounded px-2 py-1 text-xs"
                >
                  <option value="">— pick a company —</option>
                  {availableDests.map(c => <option key={c.id} value={c.id}>{companyLabel(c)}</option>)}
                </select>
              </div>
            )}
          </div>
          )}

          {/* Preview impact — debounced dry-run against the server */}
          {!validation && (
            <div className="border-t border-dark-400/30 pt-4">
              <h4 className="text-sm font-semibold text-theme-muted mb-2 flex items-center gap-2">
                Preview impact
                {previewLoading && <Loader2 size={12} className="animate-spin text-theme-faint" />}
                {preview && (
                  <span className="text-[10px] font-normal text-theme-faint">
                    on {preview.period.from} → {preview.period.to}
                  </span>
                )}
              </h4>
              {previewError && (
                <p className="text-xs text-amber-300">{previewError}</p>
              )}
              {preview && !previewError && (
                <>
                  {preview.events.length === 0 ? (
                    <p className="text-xs text-theme-faint italic">
                      Engine produced no events. Source resolved to ₹0 or destinations skipped — see warnings below.
                    </p>
                  ) : (
                    <ul className="text-xs space-y-1 max-h-32 overflow-y-auto pr-2">
                      {preview.events.slice(0, 8).map((ev, i) => {
                        const destLabel = preview.columnLabels[ev.destinationCol] || ev.destinationLabel;
                        return (
                          <li key={i} className="flex items-center gap-2 text-theme-muted">
                            {ev.sourceLabel && <span className="text-theme-faint">{preview.columnLabels[ev.sourceLabel] || ev.sourceLabel} →</span>}
                            <span className="text-theme-primary truncate flex-1">{destLabel}</span>
                            <span className={`font-mono ${ev.amount < 0 ? 'text-emerald-400' : 'text-rose-300'}`}>
                              {ev.amount < 0 ? '−' : '+'}₹{Math.abs(ev.amount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </span>
                          </li>
                        );
                      })}
                      {preview.events.length > 8 && (
                        <li className="text-theme-faint italic">…and {preview.events.length - 8} more</li>
                      )}
                    </ul>
                  )}
                  {preview.warnings.length > 0 && (
                    <div className="mt-2 text-[11px] text-amber-300 space-y-0.5">
                      {preview.warnings.slice(0, 3).map((w, i) => (
                        <div key={i} className="flex items-start gap-1">
                          <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                          <span>{w}</span>
                        </div>
                      ))}
                      {preview.warnings.length > 3 && (
                        <div className="text-theme-faint italic">…and {preview.warnings.length - 3} more</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Errors */}
          {(validation || error) && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-300 text-xs flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>{error || validation}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-dark-400/30 flex items-center justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-theme-muted hover:text-theme-primary">Cancel</button>
          <button
            onClick={submit}
            disabled={!!validation || saving}
            className="inline-flex items-center gap-2 bg-accent-500 hover:bg-accent-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {r.id === 0 ? 'Create rule' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Multi-branch editor ─────────────────────────────────────────────────
// Renders one collapsible card per branch_config. Each card carries its
// own source picker (ledger / pl_line / custom_amount) + its own destinations
// table. The rule envelope owns alloc_method + target_pl_section_key, which
// apply to every branch.

function MultiBranchEditor(props: {
  configs: BranchConfig[];
  onChange: (configs: BranchConfig[]) => void;
  companies: Company[];
  sectionTree: SectionNode[];
  allocMethod: AllocMethod | null;
}) {
  const { configs, onChange, companies, sectionTree, allocMethod } = props;

  // Per-branch ledger lists are loaded on demand keyed by source_company_id.
  // Lookups stay cached across renders so the user doesn't see a flash.
  const [ledgerCache, setLedgerCache] = useState<Record<number, Ledger[]>>({});
  useEffect(() => {
    const need = new Set<number>();
    for (const bc of configs) {
      if (bc.source_type === 'ledger' && bc.source_company_id && !ledgerCache[bc.source_company_id]) {
        need.add(bc.source_company_id);
      }
    }
    if (need.size === 0) return;
    for (const cid of need) {
      api.get(`/vcfo/cost-allocation-rules/_helpers/ledgers/${cid}`)
        .then(res => setLedgerCache(prev => ({ ...prev, [cid]: res.data })))
        .catch(() => setLedgerCache(prev => ({ ...prev, [cid]: [] })));
    }
  }, [configs, ledgerCache]);

  const update = (idx: number, patch: Partial<BranchConfig>) => {
    onChange(configs.map((c, i) => i === idx ? { ...c, ...patch } : c));
  };
  const updateDest = (branchIdx: number, destIdx: number, patch: Partial<RuleDestination>) => {
    onChange(configs.map((c, i) => i === branchIdx
      ? { ...c, destinations: c.destinations.map((d, j) => j === destIdx ? { ...d, ...patch } : d) }
      : c));
  };
  const addDest = (branchIdx: number, companyId: number) => {
    onChange(configs.map((c, i) => i === branchIdx
      ? {
          ...c,
          destinations: c.destinations.some(d => d.destination_company_id === companyId)
            ? c.destinations
            : [...c.destinations, { destination_company_id: companyId, weight: 0, sort_order: c.destinations.length }],
        }
      : c));
  };
  const removeDest = (branchIdx: number, destIdx: number) => {
    onChange(configs.map((c, i) => i === branchIdx
      ? { ...c, destinations: c.destinations.filter((_, j) => j !== destIdx) }
      : c));
  };
  const removeBranch = (idx: number) => {
    onChange(configs.filter((_, i) => i !== idx));
  };
  const addBranch = () => {
    onChange([...configs, emptyBranchConfig()]);
  };

  // Auto-suggest a label from the source company when the user picks one
  // and the label is still blank, to keep the cards skim-able.
  const suggestLabel = (bc: BranchConfig): string => {
    if (bc.label?.trim()) return bc.label.trim();
    const co = companies.find(c => c.id === bc.source_company_id);
    return co?.location || co?.name || '';
  };

  return (
    <div className="border-t border-dark-400/30 pt-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-theme-muted">
          Branches
          <span className="text-theme-faint ml-2 font-normal text-[11px]">
            {configs.length} added
          </span>
        </h4>
        <button
          onClick={addBranch}
          className="inline-flex items-center gap-1 text-xs text-accent-400 hover:text-accent-300"
        >
          <Plus size={12} /> Add another branch
        </button>
      </div>

      <div className="space-y-3">
        {configs.map((bc, i) => {
          const ledgers = bc.source_company_id ? (ledgerCache[bc.source_company_id] || []) : [];
          const weightSum = bc.destinations.reduce((a, d) => a + Number(d.weight || 0), 0);
          const availableDests = companies.filter(c =>
            !bc.destinations.some(d => d.destination_company_id === c.id) &&
            c.id !== bc.source_company_id
          );
          return (
            <div key={i} className="bg-dark-700/40 border border-dark-400/40 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2">
                <input
                  value={bc.label || ''}
                  onChange={e => update(i, { label: e.target.value })}
                  placeholder={suggestLabel(bc) || `Branch ${i + 1} label (optional)`}
                  className="flex-1 bg-dark-700 border border-dark-400/40 rounded px-2 py-1 text-sm font-medium"
                />
                <button
                  onClick={() => removeBranch(i)}
                  className="text-theme-faint hover:text-red-400 p-1"
                  title="Remove this branch"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-theme-muted mb-1">Source type</label>
                  <select
                    value={bc.source_type}
                    onChange={e => update(i, { source_type: e.target.value as SourceType })}
                    className="w-full bg-dark-700 border border-dark-400/40 rounded px-2 py-1.5 text-xs"
                  >
                    <option value="ledger">Tally ledger</option>
                    <option value="pl_line">P&amp;L section</option>
                    <option value="custom_amount">Custom amount</option>
                  </select>
                </div>
                {bc.source_type !== 'custom_amount' && (
                  <div>
                    <label className="block text-[11px] text-theme-muted mb-1">Source company</label>
                    <select
                      value={bc.source_company_id || ''}
                      onChange={e => update(i, { source_company_id: e.target.value ? parseInt(e.target.value) : null })}
                      className="w-full bg-dark-700 border border-dark-400/40 rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">— choose company —</option>
                      {companies.map(c => <option key={c.id} value={c.id}>{companyLabel(c)}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {bc.source_type === 'ledger' && (
                <div>
                  <label className="block text-[11px] text-theme-muted mb-1">Ledger</label>
                  <select
                    value={bc.source_ledger_name || ''}
                    onChange={e => update(i, { source_ledger_name: e.target.value })}
                    disabled={!bc.source_company_id || ledgers.length === 0}
                    className="w-full bg-dark-700 border border-dark-400/40 rounded px-2 py-1.5 text-xs disabled:opacity-50"
                  >
                    <option value="">— choose ledger —</option>
                    {ledgers.map(l => (
                      <option key={l.name} value={l.name}>
                        {l.name} {l.group_name ? `· ${l.group_name}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {bc.source_type === 'pl_line' && (
                <div>
                  <label className="block text-[11px] text-theme-muted mb-1">P&amp;L section / sub-line</label>
                  <select
                    value={bc.source_pl_section_key || 'indirectExpenses'}
                    onChange={e => update(i, { source_pl_section_key: e.target.value })}
                    className="w-full bg-dark-700 border border-dark-400/40 rounded px-2 py-1.5 text-xs font-mono"
                  >
                    {sectionOptions(sectionTree)}
                  </select>
                </div>
              )}
              {bc.source_type === 'custom_amount' && (
                <div>
                  <label className="block text-[11px] text-theme-muted mb-1">Custom amount (₹)</label>
                  <input
                    type="number"
                    value={bc.source_custom_amount || 0}
                    onChange={e => update(i, { source_custom_amount: parseFloat(e.target.value) || 0 })}
                    className="w-full bg-dark-700 border border-dark-400/40 rounded px-2 py-1.5 text-xs"
                  />
                </div>
              )}

              {/* Destinations for this branch */}
              <div>
                <div className="text-[11px] text-theme-muted mb-1.5 flex items-center justify-between">
                  <span>
                    Destinations
                    {allocMethod === 'weighted_ratio' && <span className="text-theme-faint ml-1">— enter sqft per company</span>}
                    {allocMethod === 'fixed_pct' && <span className="text-theme-faint ml-1">— enter % per company (must sum to 100)</span>}
                    {allocMethod === 'manual_amounts' && <span className="text-theme-faint ml-1">— enter ₹ per company</span>}
                  </span>
                  <span className="text-theme-faint">({bc.destinations.length})</span>
                </div>
                {bc.destinations.length === 0 ? (
                  <p className="text-[11px] text-theme-faint italic mb-1.5">
                    Pick companies from the dropdown below. Each company gets its own
                    {allocMethod === 'weighted_ratio' ? ' sqft' : allocMethod === 'fixed_pct' ? ' %' : allocMethod === 'manual_amounts' ? ' ₹' : ''} input once added.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {bc.destinations.map((d, j) => {
                      const co = companies.find(c => c.id === d.destination_company_id);
                      const derivedPct = weightSum > 0 ? (Number(d.weight || 0) / weightSum) * 100 : 0;
                      return (
                        <div key={j} className="flex items-center gap-2 text-xs">
                          <div className="flex-1 px-2 py-1.5 bg-dark-700 rounded border border-dark-400/40 truncate">
                            {co ? companyLabel(co) : `Company #${d.destination_company_id}`}
                          </div>
                          {allocMethod !== 'equal_split' && allocMethod !== 'revenue_share' && (
                            <>
                              <input
                                type="number"
                                value={d.weight}
                                onChange={e => updateDest(i, j, { weight: parseFloat(e.target.value) || 0, weight_basis_label: allocMethod === 'weighted_ratio' ? (d.weight_basis_label || 'sqft') : d.weight_basis_label })}
                                placeholder={allocMethod === 'fixed_pct' ? '%' : allocMethod === 'weighted_ratio' ? 'sqft' : '₹'}
                                className="w-24 bg-dark-700 border border-dark-400/40 rounded px-2 py-1.5 text-xs text-right"
                              />
                              <div className="w-16 text-[10px] text-theme-faint text-right">
                                {allocMethod === 'weighted_ratio' && weightSum > 0 && (<>≈ {derivedPct.toFixed(1)}%</>)}
                                {allocMethod === 'fixed_pct' && '%'}
                              </div>
                            </>
                          )}
                          <button onClick={() => removeDest(i, j)} className="text-theme-faint hover:text-red-400 p-1">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      );
                    })}
                    {allocMethod === 'fixed_pct' && (
                      <div className="text-[10px] text-theme-faint pl-2">
                        Sum: <strong className={Math.abs(weightSum - 100) > 0.01 ? 'text-red-400' : 'text-emerald-400'}>{weightSum.toFixed(2)}%</strong>
                      </div>
                    )}
                    {allocMethod === 'weighted_ratio' && weightSum > 0 && (
                      <div className="text-[10px] text-theme-faint pl-2">
                        Total: <strong className="text-theme-secondary">{weightSum.toFixed(0)} sqft</strong>
                        <span className="ml-2">→ engine normalises to percentages on apply.</span>
                      </div>
                    )}
                  </div>
                )}
                {availableDests.length > 0 && (
                  <select
                    value=""
                    onChange={e => { if (e.target.value) addDest(i, parseInt(e.target.value)); }}
                    className="mt-1.5 bg-dark-700 border border-dark-400/40 rounded px-2 py-1 text-[11px]"
                  >
                    <option value="">+ Add destination</option>
                    {availableDests.map(c => <option key={c.id} value={c.id}>{companyLabel(c)}</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {configs.length === 0 && (
        <p className="text-xs text-theme-faint italic">No branches added yet. Click "Add another branch" above.</p>
      )}
    </div>
  );
}
