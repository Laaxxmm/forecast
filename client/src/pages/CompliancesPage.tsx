// VCFO Compliances page.
//
// Branch / stream filtering is driven entirely by the sidebar — the axios
// client already attaches X-Branch-Id / X-Stream-Id headers, and the server's
// resolveBranch middleware populates req.branchId / req.streamId which the
// compliance router uses to scope results.
//
// Applicability model (see server/src/routes/vcfo-compliances.ts for details):
//   - state  — one filing per state GSTIN/TAN/PT registration
//   - branch — one filing per establishment (licences, PF, ESI)
//   - stream — per (branch, stream) combination
//
// Filing a compliance preserves history — the row stays as `filed`, and the
// server inserts a fresh `pending` row for the next period.

import { useEffect, useMemo, useState } from 'react';
import {
  Building2, CalendarCheck, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight,
  Clock, Globe2, List as ListIcon, Plus, Settings, Trash2, X, Layers,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import api from '../api/client';

interface Branch {
  id: number;
  name: string;
  code?: string | null;
  city?: string | null;
  state?: string | null;
}

interface Stream {
  stream_id: number;
  name: string;
  slug?: string | null;
  icon?: string | null;
}

interface CatalogEntry {
  id: number;
  key: string;
  name: string;
  category: string;
  frequency: 'monthly' | 'quarterly' | 'half-yearly' | 'annual';
  default_due_day: number | null;
  default_due_month: number | null;
  state: string | null;
  default_scope: 'state' | 'branch' | 'stream';
  description: string | null;
}

interface Compliance {
  id: number;
  branch_id: number;
  scope_type: 'state' | 'branch' | 'stream';
  state: string | null;
  stream_id: number | null;
  catalog_id: number | null;
  name: string;
  category: string;
  frequency: 'monthly' | 'quarterly' | 'half-yearly' | 'annual';
  due_date: string;
  period_label: string;
  status: 'pending' | 'filed' | 'overdue';
  amount: number | null;
  assignee: string | null;
  notes: string | null;
  filed_at: string | null;
}

type ViewMode = 'list' | 'calendar';

const FREQ_LABEL: Record<string, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  'half-yearly': 'Half-yearly',
  annual: 'Annual',
};

const CATEGORY_CHIP: Record<string, string> = {
  GST: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  TDS: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  Labour: 'bg-orange-500/10 text-orange-300 border-orange-500/20',
  Licence: 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/20',
  IT: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  Other: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20',
};

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24));
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function effectiveStatus(c: Compliance): 'pending' | 'filed' | 'overdue' | 'due-soon' {
  if (c.status === 'filed') return 'filed';
  const d = daysBetween(todayISO(), c.due_date);
  if (d < 0) return 'overdue';
  if (d <= 7) return 'due-soon';
  return 'pending';
}

function statusChip(s: ReturnType<typeof effectiveStatus>): string {
  switch (s) {
    case 'filed':    return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
    case 'overdue':  return 'bg-red-500/10 text-red-300 border-red-500/20';
    case 'due-soon': return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
    default:         return 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20';
  }
}

function statusDotClass(s: ReturnType<typeof effectiveStatus>): string {
  switch (s) {
    case 'filed':    return 'bg-emerald-400';
    case 'overdue':  return 'bg-red-400';
    case 'due-soon': return 'bg-amber-400';
    default:         return 'bg-zinc-400';
  }
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function ScopeChip({ c, branchName, streamName }: { c: Compliance; branchName?: string; streamName?: string }) {
  if (c.scope_type === 'state') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border rounded bg-blue-500/10 text-blue-300 border-blue-500/20" title="State-wide filing">
        <Globe2 size={10} /> {c.state || 'State'}
      </span>
    );
  }
  if (c.scope_type === 'stream') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border rounded bg-purple-500/10 text-purple-300 border-purple-500/20" title="Stream-specific filing">
        <Layers size={10} /> {streamName || 'Stream'}{branchName ? ` · ${branchName}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border rounded bg-zinc-500/10 text-zinc-300 border-zinc-500/20" title="Per-branch filing">
      <Building2 size={10} /> {branchName || 'Branch'}
    </span>
  );
}

export default function CompliancesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [items, setItems] = useState<Compliance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<ViewMode>('list');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'filed' | 'overdue'>('all');
  const [freqFilter, setFreqFilter] = useState<'all' | Compliance['frequency']>('all');

  const [addOpen, setAddOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const userRole = typeof window !== 'undefined' ? localStorage.getItem('user_role') : null;
  const userType = typeof window !== 'undefined' ? localStorage.getItem('user_type') : null;
  const canEdit = userRole === 'admin' || userType === 'super_admin';

  // Current sidebar context (already applied to every API call by the axios
  // client via X-Branch-Id / X-Stream-Id — we mirror it here only for display
  // labels and default scope suggestions in the Add modal).
  const sidebarBranchId = (() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('branch_id') : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isNaN(n) ? null : n;
  })();
  const sidebarStreamId = (() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('stream_id') : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isNaN(n) ? null : n;
  })();
  const sidebarBranch = sidebarBranchId != null ? branches.find(b => b.id === sidebarBranchId) || null : null;

  useEffect(() => {
    api.get('/vcfo/compliances/branches')
      .then(r => setBranches(r.data || []))
      .catch(() => setBranches([]));
  }, []);

  // Catalog is filtered by the currently scoped state (if any).
  useEffect(() => {
    const q = sidebarBranch?.state ? `?state=${encodeURIComponent(sidebarBranch.state)}` : '';
    api.get(`/vcfo/compliances/catalog${q}`)
      .then(r => setCatalog(r.data || []))
      .catch(() => setCatalog([]));
  }, [sidebarBranch?.state]);

  const reload = () => {
    setLoading(true);
    setError(null);
    api.get(`/vcfo/compliances`)
      .then(r => { setItems(r.data || []); setLoading(false); })
      .catch(err => {
        setError(err?.response?.data?.error || err?.message || 'Failed to load');
        setLoading(false);
      });
  };
  // Axios adds X-Branch-Id / X-Stream-Id automatically, so we just reload
  // whenever the sidebar branch or stream changes.
  useEffect(reload, [sidebarBranchId, sidebarStreamId]);

  const filtered = useMemo(() => {
    return items.filter(c => {
      if (freqFilter !== 'all' && c.frequency !== freqFilter) return false;
      if (statusFilter !== 'all') {
        const eff = effectiveStatus(c);
        if (statusFilter === 'pending' && eff !== 'pending' && eff !== 'due-soon') return false;
        if (statusFilter === 'filed' && eff !== 'filed') return false;
        if (statusFilter === 'overdue' && eff !== 'overdue') return false;
      }
      return true;
    });
  }, [items, freqFilter, statusFilter]);

  const summary = useMemo(() => {
    let pending = 0, dueSoon = 0, overdue = 0, filed = 0;
    for (const c of items) {
      const eff = effectiveStatus(c);
      if (eff === 'filed') filed++;
      else if (eff === 'overdue') overdue++;
      else if (eff === 'due-soon') dueSoon++;
      else pending++;
    }
    return { pending, dueSoon, overdue, filed };
  }, [items]);

  const branchById = useMemo(() => {
    const m = new Map<number, Branch>();
    for (const b of branches) m.set(b.id, b);
    return m;
  }, [branches]);

  const markFiled = async (c: Compliance) => {
    if (!canEdit) return;
    if (!confirm(`Mark "${c.name}" — ${c.period_label} as filed? A new pending row will be created for the next period.`)) return;
    try {
      await api.post(`/vcfo/compliances/${c.id}/file`);
      reload();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to file');
    }
  };

  const deleteRow = async (c: Compliance) => {
    if (!canEdit) return;
    if (!confirm(`Delete "${c.name}" — ${c.period_label}? This cannot be undone.`)) return;
    try {
      await api.delete(`/vcfo/compliances/${c.id}`);
      reload();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to delete');
    }
  };

  const contextLabel = (() => {
    if (!sidebarBranchId) return 'All branches';
    const b = sidebarBranch;
    if (!b) return 'Selected branch';
    return `${b.name}${b.state ? ` · ${b.state}` : ''}`;
  })();

  return (
    <div className="compliances-page animate-fade-in">
      <div className="bg-dark-800 border-b border-dark-400/30 -mx-4 -mt-4 px-4 md:-mx-8 md:-mt-8 md:px-8 py-3 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarCheck size={18} className="text-accent-400" />
            <h1 className="text-sm md:text-base font-semibold text-theme-heading">Compliances</h1>
            <span className="text-[11px] text-theme-faint ml-1 px-2 py-0.5 bg-dark-700 rounded-lg">
              {contextLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={freqFilter}
              onChange={e => setFreqFilter(e.target.value as any)}
              className="input text-xs py-1.5"
            >
              <option value="all">All frequencies</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="half-yearly">Half-yearly</option>
              <option value="annual">Annual</option>
            </select>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as any)}
              className="input text-xs py-1.5"
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending / Due soon</option>
              <option value="overdue">Overdue</option>
              <option value="filed">Filed</option>
            </select>
            <div className="flex bg-dark-700 border border-dark-400/50 rounded-xl overflow-hidden">
              <button
                onClick={() => setView('list')}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-all ${view === 'list' ? 'bg-accent-500/15 text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
              >
                <ListIcon size={13} />
                List
              </button>
              <button
                onClick={() => setView('calendar')}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-all ${view === 'calendar' ? 'bg-accent-500/15 text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
              >
                <CalendarDays size={13} />
                Calendar
              </button>
            </div>
            {canEdit && (
              <Link
                to="/vcfo/compliances/settings"
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-dark-700 text-theme-secondary border border-dark-400/50 hover:bg-dark-600 rounded-xl transition-colors"
                title="Manage registered services (GST, TDS, PF, …) and their auto-generated trackers"
              >
                <Settings size={13} />
                Settings
              </Link>
            )}
            {canEdit && (
              <button
                onClick={() => setAddOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-500/15 text-accent-300 border border-accent-500/30 hover:bg-accent-500/25 rounded-xl transition-colors"
              >
                <Plus size={13} />
                Add compliance
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <SummaryCard label="Pending" value={summary.pending} color="zinc" icon={<Clock size={14} />} />
        <SummaryCard label="Due soon (≤7d)" value={summary.dueSoon} color="amber" icon={<Clock size={14} />} />
        <SummaryCard label="Overdue" value={summary.overdue} color="red" icon={<Clock size={14} />} />
        <SummaryCard label="Filed" value={summary.filed} color="emerald" icon={<CheckCircle2 size={14} />} />
      </div>

      {loading ? (
        <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-10 text-center">
          <p className="text-theme-muted">Loading…</p>
        </div>
      ) : error ? (
        <div className="bg-dark-800 border border-red-500/30 rounded-2xl p-10 text-center">
          <p className="text-red-400 font-medium">{error}</p>
        </div>
      ) : view === 'list' ? (
        <ListView
          items={filtered}
          branchById={branchById}
          canEdit={canEdit}
          onFile={markFiled}
          onDelete={deleteRow}
        />
      ) : (
        <CalendarView
          items={filtered}
          branchById={branchById}
          month={calMonth}
          onMonthChange={setCalMonth}
        />
      )}

      {addOpen && (
        <AddModal
          branches={branches}
          defaultBranchId={sidebarBranchId ?? (branches[0]?.id ?? null)}
          catalog={catalog}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); reload(); }}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, color, icon }: { label: string; value: number; color: 'zinc' | 'amber' | 'red' | 'emerald'; icon: React.ReactNode }) {
  const tone = {
    zinc: 'text-zinc-300 bg-zinc-500/10 border-zinc-500/20',
    amber: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
    red: 'text-red-300 bg-red-500/10 border-red-500/20',
    emerald: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
  }[color];
  return (
    <div className={`border rounded-2xl px-4 py-3 ${tone}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider font-semibold opacity-80">{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}

function ListView({
  items,
  branchById,
  canEdit,
  onFile,
  onDelete,
}: {
  items: Compliance[];
  branchById: Map<number, Branch>;
  canEdit: boolean;
  onFile: (c: Compliance) => void;
  onDelete: (c: Compliance) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-10 text-center">
        <p className="text-theme-muted mb-1 font-medium">No compliances match these filters.</p>
        <p className="text-sm text-theme-faint">Use "Add compliance" to create one from the catalog.</p>
      </div>
    );
  }
  return (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs md:text-[13px]">
          <thead className="bg-dark-700/60 text-theme-faint uppercase text-[10px] tracking-wider">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold">Name</th>
              <th className="text-left px-4 py-2.5 font-semibold">Category</th>
              <th className="text-left px-4 py-2.5 font-semibold">Applicability</th>
              <th className="text-left px-4 py-2.5 font-semibold">Frequency</th>
              <th className="text-left px-4 py-2.5 font-semibold">Period</th>
              <th className="text-left px-4 py-2.5 font-semibold">Due date</th>
              <th className="text-left px-4 py-2.5 font-semibold">Status</th>
              <th className="text-right px-4 py-2.5 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-400/30">
            {items.map(c => {
              const eff = effectiveStatus(c);
              const branch = branchById.get(c.branch_id);
              return (
                <tr key={c.id} className="hover:bg-dark-700/40">
                  <td className="px-4 py-2.5 text-theme-primary font-medium">{c.name}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 text-[10px] font-medium border rounded ${CATEGORY_CHIP[c.category] || CATEGORY_CHIP.Other}`}>
                      {c.category}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <ScopeChip c={c} branchName={branch?.name} />
                  </td>
                  <td className="px-4 py-2.5 text-theme-secondary">{FREQ_LABEL[c.frequency]}</td>
                  <td className="px-4 py-2.5 text-theme-secondary">{c.period_label}</td>
                  <td className="px-4 py-2.5 text-theme-secondary">{fmtDate(c.due_date)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium border rounded ${statusChip(eff)}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${statusDotClass(eff)}`} />
                      {eff === 'due-soon' ? 'Due soon' : eff.charAt(0).toUpperCase() + eff.slice(1)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1">
                      {canEdit && eff !== 'filed' && (
                        <button
                          onClick={() => onFile(c)}
                          title="Mark as filed"
                          className="p-1.5 text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
                        >
                          <CheckCircle2 size={14} />
                        </button>
                      )}
                      {canEdit && (
                        <button
                          onClick={() => onDelete(c)}
                          title="Delete"
                          className="p-1.5 text-theme-faint hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CalendarView({
  items,
  branchById,
  month,
  onMonthChange,
}: {
  items: Compliance[];
  branchById: Map<number, Branch>;
  month: { year: number; month: number };
  onMonthChange: (m: { year: number; month: number }) => void;
}) {
  const firstOfMonth = new Date(month.year, month.month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
  const monthLabel = firstOfMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const buckets = new Map<number, Compliance[]>();
  for (const c of items) {
    const [y, m, d] = c.due_date.split('-').map(n => parseInt(n, 10));
    if (y === month.year && m - 1 === month.month) {
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d)!.push(c);
    }
  }

  const cells: Array<{ day: number | null }> = [];
  for (let i = 0; i < startOffset; i++) cells.push({ day: null });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d });
  while (cells.length % 7 !== 0) cells.push({ day: null });

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === month.year && today.getMonth() === month.month;

  return (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-400/30">
        <button
          onClick={() => {
            const m = month.month === 0 ? 11 : month.month - 1;
            const y = month.month === 0 ? month.year - 1 : month.year;
            onMonthChange({ year: y, month: m });
          }}
          className="p-1.5 text-theme-faint hover:text-theme-primary hover:bg-dark-700 rounded-lg transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <h2 className="text-sm font-semibold text-theme-heading">{monthLabel}</h2>
        <button
          onClick={() => {
            const m = month.month === 11 ? 0 : month.month + 1;
            const y = month.month === 11 ? month.year + 1 : month.year;
            onMonthChange({ year: y, month: m });
          }}
          className="p-1.5 text-theme-faint hover:text-theme-primary hover:bg-dark-700 rounded-lg transition-colors"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-7 text-[10px] uppercase tracking-wider text-theme-faint font-semibold border-b border-dark-400/30">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
          <div key={d} className="px-2 py-2 text-center">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((cell, idx) => {
          const dayItems = cell.day ? (buckets.get(cell.day) || []) : [];
          const isToday = isCurrentMonth && cell.day === today.getDate();
          return (
            <div
              key={idx}
              className={`min-h-[88px] border-b border-r border-dark-400/20 p-1.5 ${
                cell.day === null ? 'bg-dark-800/50' : 'bg-dark-800'
              } ${isToday ? 'ring-1 ring-inset ring-accent-500/40' : ''}`}
            >
              {cell.day !== null && (
                <>
                  <div className={`text-[11px] font-semibold mb-1 ${isToday ? 'text-accent-400' : 'text-theme-faint'}`}>
                    {cell.day}
                  </div>
                  <div className="space-y-1">
                    {dayItems.slice(0, 3).map(c => {
                      const eff = effectiveStatus(c);
                      const branch = branchById.get(c.branch_id);
                      const scopeLabel =
                        c.scope_type === 'state'  ? (c.state ? `${c.state}` : 'State')
                      : c.scope_type === 'stream' ? 'Stream'
                      :                             (branch?.name || 'Branch');
                      return (
                        <div
                          key={c.id}
                          title={`${c.name} — ${c.period_label} (${eff}) · ${scopeLabel}`}
                          className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border rounded truncate ${statusChip(eff)}`}
                        >
                          <span className={`w-1 h-1 rounded-full flex-shrink-0 ${statusDotClass(eff)}`} />
                          <span className="truncate">{c.name}</span>
                        </div>
                      );
                    })}
                    {dayItems.length > 3 && (
                      <div className="text-[10px] text-theme-faint px-1">+ {dayItems.length - 3} more</div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddModal({
  branches,
  defaultBranchId,
  catalog,
  onClose,
  onCreated,
}: {
  branches: Branch[];
  defaultBranchId: number | null;
  catalog: CatalogEntry[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [catalogId, setCatalogId] = useState<number | null>(catalog[0]?.id ?? null);
  const [scopeType, setScopeType] = useState<'state' | 'branch' | 'stream'>('branch');
  const [branchId, setBranchId] = useState<number | null>(defaultBranchId);
  const [streamId, setStreamId] = useState<number | null>(null);
  const [branchStreams, setBranchStreams] = useState<Stream[]>([]);
  const [dueDate, setDueDate] = useState<string>('');
  const [periodLabel, setPeriodLabel] = useState<string>('');
  const [assignee, setAssignee] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = catalog.find(c => c.id === catalogId) || null;

  // When the catalog entry changes, suggest its default_scope.
  useEffect(() => {
    if (selected) setScopeType(selected.default_scope || 'branch');
  }, [selected]);

  // Whenever the branch changes, refresh the stream list for stream-scope.
  useEffect(() => {
    if (!branchId) { setBranchStreams([]); setStreamId(null); return; }
    api.get(`/vcfo/compliances/streams?branchId=${branchId}`)
      .then(r => {
        setBranchStreams(r.data || []);
        setStreamId(prev => (r.data || []).some((s: Stream) => s.stream_id === prev) ? prev : null);
      })
      .catch(() => { setBranchStreams([]); setStreamId(null); });
  }, [branchId]);

  // States derived from the client's branches — used when scope = state.
  const availableStates = useMemo(() => {
    const set = new Set<string>();
    for (const b of branches) {
      if (b.state) set.add(b.state.toUpperCase());
    }
    return Array.from(set).sort();
  }, [branches]);

  const selectedBranch = branchId != null ? branches.find(b => b.id === branchId) : null;
  const [state, setState] = useState<string>(selectedBranch?.state?.toUpperCase() || availableStates[0] || '');

  useEffect(() => {
    if (scopeType === 'state' && selectedBranch?.state) {
      setState(selectedBranch.state.toUpperCase());
    }
  }, [scopeType, selectedBranch?.state]);

  const canSubmit = (() => {
    if (!catalogId || !branchId || submitting) return false;
    if (scopeType === 'state' && !state) return false;
    if (scopeType === 'stream' && !streamId) return false;
    return true;
  })();

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const scope: any = { type: scopeType, branchId };
      if (scopeType === 'state') scope.state = state;
      if (scopeType === 'stream') scope.streamId = streamId;
      await api.post('/vcfo/compliances', {
        catalogId,
        scope,
        dueDate: dueDate || undefined,
        periodLabel: periodLabel || undefined,
        assignee: assignee || undefined,
        notes: notes || undefined,
      });
      onCreated();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to create');
      setSubmitting(false);
    }
  };

  const scopeHintText = (() => {
    if (scopeType === 'state') return 'One filing covers every branch in this state (e.g. a single GSTR-1 for Karnataka).';
    if (scopeType === 'branch') return 'Filed separately for each branch (e.g. Drug Licence renewal per outlet).';
    return 'Filed for a specific stream at a branch (e.g. pharmacy-only licence).';
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-dark-800 border border-dark-400/40 rounded-2xl shadow-2xl max-w-lg w-[92%] p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-theme-heading">Add compliance</h3>
            <p className="text-xs text-theme-faint mt-0.5">
              Pick a compliance from the catalog, then choose how it applies.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-theme-faint hover:text-theme-primary hover:bg-dark-700 rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-theme-secondary mb-1">Compliance</label>
            <select
              value={catalogId ?? ''}
              onChange={e => setCatalogId(e.target.value ? Number(e.target.value) : null)}
              className="input text-sm w-full"
            >
              <option value="" disabled>Select a compliance…</option>
              {catalog.map(c => (
                <option key={c.id} value={c.id}>
                  [{c.category}] {c.name} — {FREQ_LABEL[c.frequency]}{c.state ? ` (${c.state})` : ''}
                </option>
              ))}
            </select>
            {selected?.description && (
              <p className="text-[11px] text-theme-faint mt-1">{selected.description}</p>
            )}
          </div>

          {/* Applicability picker */}
          <div>
            <label className="block text-xs text-theme-secondary mb-1.5">Applicability</label>
            <div className="grid grid-cols-3 gap-2">
              {(['state', 'branch', 'stream'] as const).map(t => {
                const active = scopeType === t;
                const Icon = t === 'state' ? Globe2 : t === 'branch' ? Building2 : Layers;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setScopeType(t)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-xl border transition-colors ${
                      active
                        ? 'bg-accent-500/15 text-accent-300 border-accent-500/40'
                        : 'bg-dark-700 text-theme-secondary border-dark-400/50 hover:bg-dark-600'
                    }`}
                  >
                    <Icon size={13} />
                    <span className="capitalize">{t}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-theme-faint mt-1.5">{scopeHintText}</p>
          </div>

          {/* Scope-specific fields */}
          {scopeType === 'state' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-theme-secondary mb-1">State</label>
                <select
                  value={state}
                  onChange={e => setState(e.target.value)}
                  className="input text-sm w-full"
                >
                  <option value="" disabled>Select a state…</option>
                  {availableStates.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-theme-secondary mb-1">Anchor branch</label>
                <select
                  value={branchId ?? ''}
                  onChange={e => setBranchId(e.target.value ? Number(e.target.value) : null)}
                  className="input text-sm w-full"
                >
                  <option value="" disabled>Select a branch in this state…</option>
                  {branches.filter(b => !state || b.state?.toUpperCase() === state).map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {scopeType === 'branch' && (
            <div>
              <label className="block text-xs text-theme-secondary mb-1">Branch</label>
              <select
                value={branchId ?? ''}
                onChange={e => setBranchId(e.target.value ? Number(e.target.value) : null)}
                className="input text-sm w-full"
              >
                <option value="" disabled>Select a branch…</option>
                {branches.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}{b.state ? ` · ${b.state}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {scopeType === 'stream' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-theme-secondary mb-1">Branch</label>
                <select
                  value={branchId ?? ''}
                  onChange={e => setBranchId(e.target.value ? Number(e.target.value) : null)}
                  className="input text-sm w-full"
                >
                  <option value="" disabled>Select a branch…</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-theme-secondary mb-1">Stream</label>
                <select
                  value={streamId ?? ''}
                  onChange={e => setStreamId(e.target.value ? Number(e.target.value) : null)}
                  className="input text-sm w-full"
                  disabled={branchStreams.length === 0}
                >
                  <option value="" disabled>
                    {branchStreams.length === 0 ? 'No streams for this branch' : 'Select a stream…'}
                  </option>
                  {branchStreams.map(s => (
                    <option key={s.stream_id} value={s.stream_id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-theme-secondary mb-1">Due date (optional)</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="input text-sm w-full"
              />
              <p className="text-[10px] text-theme-faint mt-1">Leave blank to auto-derive.</p>
            </div>
            <div>
              <label className="block text-xs text-theme-secondary mb-1">Period label (optional)</label>
              <input
                type="text"
                value={periodLabel}
                onChange={e => setPeriodLabel(e.target.value)}
                placeholder="e.g. Apr 2026"
                className="input text-sm w-full"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-theme-secondary mb-1">Assignee (optional)</label>
            <input
              type="text"
              value={assignee}
              onChange={e => setAssignee(e.target.value)}
              placeholder="Name of responsible person"
              className="input text-sm w-full"
            />
          </div>

          <div>
            <label className="block text-xs text-theme-secondary mb-1">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              className="input text-sm w-full"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-xs text-theme-secondary hover:text-theme-primary hover:bg-dark-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-xs font-medium bg-accent-500/20 text-accent-300 hover:bg-accent-500/30 border border-accent-500/40 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Adding…' : 'Add compliance'}
          </button>
        </div>
      </div>
    </div>
  );
}
