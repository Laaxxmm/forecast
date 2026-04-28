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
import { canWriteVcfo } from '../utils/roles';
import DataTable, { type ColumnDef } from '../components/common/DataTable';

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

// Tone helper
type Tone = { fg: string; soft: string; border: string };
const mkTone = (hex: string): Tone => ({
  fg: hex,
  soft: `color-mix(in srgb, ${hex} 14%, transparent)`,
  border: `color-mix(in srgb, ${hex} 32%, transparent)`,
});

const CATEGORY_TONE: Record<string, Tone> = {
  GST:     mkTone('#6366f1'), // indigo
  TDS:     mkTone('#0ea5e9'), // sky
  Labour:  mkTone('#f97316'), // orange
  Licence: mkTone('#d946ef'), // fuchsia
  IT:      mkTone('#10b981'), // emerald
  Other:   mkTone('#71717a'), // zinc
};

const STATUS_TONE: Record<'filed' | 'overdue' | 'due-soon' | 'pending', Tone> = {
  filed:     mkTone('#10b981'),
  overdue:   mkTone('#ef4444'),
  'due-soon': mkTone('#f59e0b'),
  pending:   mkTone('#71717a'),
};

const SCOPE_TONE: Record<'state' | 'stream' | 'branch', Tone> = {
  state:  mkTone('#3b82f6'),
  stream: mkTone('#8b5cf6'),
  branch: mkTone('#71717a'),
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

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function CategoryChip({ category }: { category: string }) {
  const t = CATEGORY_TONE[category] || CATEGORY_TONE.Other;
  return (
    <span
      className="inline-block px-2 py-0.5 text-[10px] font-semibold rounded"
      style={{ background: t.soft, color: t.fg, border: `1px solid ${t.border}` }}
    >
      {category}
    </span>
  );
}

function StatusChip({ status }: { status: ReturnType<typeof effectiveStatus> }) {
  const t = STATUS_TONE[status];
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded"
      style={{ background: t.soft, color: t.fg, border: `1px solid ${t.border}` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.fg }} />
      {status === 'due-soon' ? 'Due soon' : status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function CalendarStatusChip({ c, status }: { c: Compliance; status: ReturnType<typeof effectiveStatus> }) {
  const t = STATUS_TONE[status];
  return (
    <div
      title={`${c.name} — ${c.period_label} (${status})`}
      className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded truncate"
      style={{ background: t.soft, color: t.fg, border: `1px solid ${t.border}` }}
    >
      <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: t.fg }} />
      <span className="truncate">{c.name}</span>
    </div>
  );
}

function ScopeChip({ c, branchName, streamName }: { c: Compliance; branchName?: string; streamName?: string }) {
  const t = SCOPE_TONE[c.scope_type];
  const commonStyle = {
    background: t.soft,
    color: t.fg,
    border: `1px solid ${t.border}`,
  };
  if (c.scope_type === 'state') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded"
        style={commonStyle}
        title="State-wide filing"
      >
        <Globe2 size={10} /> {c.state || 'State'}
      </span>
    );
  }
  if (c.scope_type === 'stream') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded"
        style={commonStyle}
        title="Stream-specific filing"
      >
        <Layers size={10} /> {streamName || 'Stream'}{branchName ? ` · ${branchName}` : ''}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded"
      style={commonStyle}
      title="Per-branch filing"
    >
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

  // admin + accountant + super_admin can edit VCFO compliances.
  // operational_head / legacy `user` cannot see this page at all (route-guarded).
  const canEdit = canWriteVcfo();

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
      <div
        className="-mx-4 -mt-4 px-4 md:-mx-8 md:-mt-8 md:px-8 py-3 mb-4"
        style={{ background: 'var(--mt-bg-raised)', borderBottom: '1px solid var(--mt-border)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarCheck size={18} style={{ color: 'var(--mt-accent-text)' }} />
            <h1 className="mt-heading text-sm md:text-base">Compliances</h1>
            <span
              className="text-[11px] ml-1 px-2 py-0.5 rounded-lg"
              style={{
                background: 'var(--mt-bg-muted)',
                color: 'var(--mt-text-faint)',
                border: '1px solid var(--mt-border)',
              }}
            >
              {contextLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={freqFilter}
              onChange={e => setFreqFilter(e.target.value as any)}
              className="mt-input"
              style={{ fontSize: 12, padding: '6px 10px', width: 'auto' }}
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
              className="mt-input"
              style={{ fontSize: 12, padding: '6px 10px', width: 'auto' }}
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending / Due soon</option>
              <option value="overdue">Overdue</option>
              <option value="filed">Filed</option>
            </select>
            <div
              className="flex rounded-xl overflow-hidden"
              style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
            >
              <button
                onClick={() => setView('list')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors"
                style={{
                  color: view === 'list' ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                  background: view === 'list' ? 'var(--mt-accent-soft)' : 'transparent',
                }}
              >
                <ListIcon size={13} />
                List
              </button>
              <button
                onClick={() => setView('calendar')}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors"
                style={{
                  color: view === 'calendar' ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                  background: view === 'calendar' ? 'var(--mt-accent-soft)' : 'transparent',
                }}
              >
                <CalendarDays size={13} />
                Calendar
              </button>
            </div>
            {canEdit && (
              <Link
                to="/vcfo/compliances/settings"
                className="mt-btn-ghost"
                style={{ padding: '6px 10px', fontSize: 12 }}
                title="Manage registered services (GST, TDS, PF, …) and their auto-generated trackers"
              >
                <Settings size={13} />
                Settings
              </Link>
            )}
            {canEdit && (
              <button
                onClick={() => setAddOpen(true)}
                className="mt-btn-soft"
                style={{ padding: '6px 10px', fontSize: 12 }}
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
        <div className="mt-card p-10 text-center">
          <p style={{ color: 'var(--mt-text-muted)' }}>Loading…</p>
        </div>
      ) : error ? (
        <div
          className="rounded-2xl p-10 text-center"
          style={{
            background: 'var(--mt-bg-surface)',
            border: '1px solid var(--mt-danger-border)',
          }}
        >
          <p className="font-medium" style={{ color: 'var(--mt-danger-text)' }}>{error}</p>
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
  const tone: Record<string, { bg: string; fg: string; border: string }> = {
    zinc: { bg: 'var(--mt-bg-muted)', fg: 'var(--mt-text-secondary)', border: 'var(--mt-border)' },
    amber: { bg: 'var(--mt-warn-soft)', fg: 'var(--mt-warn-text)', border: 'var(--mt-warn-border)' },
    red: { bg: 'var(--mt-danger-soft)', fg: 'var(--mt-danger-text)', border: 'var(--mt-danger-border)' },
    emerald: { bg: 'var(--mt-accent-soft)', fg: 'var(--mt-accent-text)', border: 'var(--mt-accent-border)' },
  };
  const t = tone[color];
  return (
    <div
      className="rounded-2xl px-4 py-3"
      style={{ background: t.bg, color: t.fg, border: `1px solid ${t.border}` }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider font-semibold opacity-80">{label}</span>
        {icon}
      </div>
      <div className="mt-num text-2xl font-bold mt-1">{value}</div>
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
  // Pre-compute the effective status + branch name once per row so the
  // DataTable filter/sort can use them via accessors.
  const enriched = items.map(c => ({
    ...c,
    _eff: effectiveStatus(c),
    _branchName: branchById.get(c.branch_id)?.name || '',
    _freqLabel: FREQ_LABEL[c.frequency] || c.frequency,
  }));

  const cols: ColumnDef<typeof enriched[number]>[] = [
    { key: 'name', header: 'Name', cellClassName: 'font-medium', render: c => (
      <span style={{ color: 'var(--mt-text-primary)' }}>{c.name}</span>
    ) },
    { key: 'category', header: 'Category', render: c => <CategoryChip category={c.category} /> },
    { key: '_branchName', header: 'Applicability', accessor: c => c._branchName,
      render: c => <ScopeChip c={c} branchName={branchById.get(c.branch_id)?.name} /> },
    { key: 'frequency', header: 'Frequency', accessor: c => c._freqLabel,
      render: c => <span style={{ color: 'var(--mt-text-secondary)' }}>{c._freqLabel}</span> },
    { key: 'period_label', header: 'Period',
      render: c => <span style={{ color: 'var(--mt-text-secondary)' }}>{c.period_label}</span> },
    { key: 'due_date', header: 'Due date', type: 'date',
      render: c => <span className="mt-num" style={{ color: 'var(--mt-text-secondary)' }}>{fmtDate(c.due_date)}</span> },
    { key: '_eff', header: 'Status', accessor: c => c._eff, render: c => <StatusChip status={c._eff} /> },
    { key: '_actions', header: 'Actions', type: 'custom', align: 'right', render: c => (
      <div className="inline-flex items-center gap-1">
        {canEdit && c._eff !== 'filed' && (
          <button
            onClick={() => onFile(c)}
            title="Mark as filed"
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--mt-accent-text)' }}
          >
            <CheckCircle2 size={14} />
          </button>
        )}
        {canEdit && (
          <button
            onClick={() => onDelete(c)}
            title="Delete"
            className="p-1.5 rounded transition-colors"
            style={{ color: 'var(--mt-text-faint)' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-danger-text)'; e.currentTarget.style.background = 'var(--mt-danger-soft)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-faint)'; e.currentTarget.style.background = 'transparent'; }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    ) },
  ];

  return (
    <div className="mt-card p-3">
      <DataTable
        columns={cols}
        rows={enriched}
        pageSize={50}
        searchPlaceholder="Search compliance, branch, period..."
        emptyMessage="No compliances match these filters. Use 'Add compliance' to create one from the catalog."
      />
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
    <div className="mt-card overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--mt-border)' }}
      >
        <button
          onClick={() => {
            const m = month.month === 0 ? 11 : month.month - 1;
            const y = month.month === 0 ? month.year - 1 : month.year;
            onMonthChange({ year: y, month: m });
          }}
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--mt-text-faint)' }}
        >
          <ChevronLeft size={16} />
        </button>
        <h2 className="mt-heading text-sm">{monthLabel}</h2>
        <button
          onClick={() => {
            const m = month.month === 11 ? 0 : month.month + 1;
            const y = month.month === 11 ? month.year + 1 : month.year;
            onMonthChange({ year: y, month: m });
          }}
          className="p-1.5 rounded-lg transition-colors"
          style={{ color: 'var(--mt-text-faint)' }}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div
        className="grid grid-cols-7 text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: 'var(--mt-text-faint)', borderBottom: '1px solid var(--mt-border)' }}
      >
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
              className="min-h-[88px] p-1.5"
              style={{
                background: cell.day === null ? 'var(--mt-bg-muted)' : 'var(--mt-bg-raised)',
                borderBottom: '1px solid var(--mt-border)',
                borderRight: '1px solid var(--mt-border)',
                boxShadow: isToday
                  ? 'inset 0 0 0 1px color-mix(in srgb, var(--mt-accent) 40%, transparent)'
                  : undefined,
              }}
            >
              {cell.day !== null && (
                <>
                  <div
                    className="mt-num text-[11px] font-semibold mb-1"
                    style={{ color: isToday ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)' }}
                  >
                    {cell.day}
                  </div>
                  <div className="space-y-1">
                    {dayItems.slice(0, 3).map(c => {
                      const eff = effectiveStatus(c);
                      return <CalendarStatusChip key={c.id} c={c} status={eff} />;
                    })}
                    {dayItems.length > 3 && (
                      <div className="text-[10px] px-1" style={{ color: 'var(--mt-text-faint)' }}>
                        + {dayItems.length - 3} more
                      </div>
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
      <div
        className="mt-card max-w-lg w-[92%] p-6 max-h-[90vh] overflow-y-auto"
        style={{ boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="mt-heading text-base">Add compliance</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
              Pick a compliance from the catalog, then choose how it applies.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--mt-text-faint)' }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Compliance</label>
            <select
              value={catalogId ?? ''}
              onChange={e => setCatalogId(e.target.value ? Number(e.target.value) : null)}
              className="mt-input"
            >
              <option value="" disabled>Select a compliance…</option>
              {catalog.map(c => (
                <option key={c.id} value={c.id}>
                  [{c.category}] {c.name} — {FREQ_LABEL[c.frequency]}{c.state ? ` (${c.state})` : ''}
                </option>
              ))}
            </select>
            {selected?.description && (
              <p className="text-[11px] mt-1" style={{ color: 'var(--mt-text-faint)' }}>{selected.description}</p>
            )}
          </div>

          {/* Applicability picker */}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: 'var(--mt-text-secondary)' }}>Applicability</label>
            <div className="grid grid-cols-3 gap-2">
              {(['state', 'branch', 'stream'] as const).map(t => {
                const active = scopeType === t;
                const Icon = t === 'state' ? Globe2 : t === 'branch' ? Building2 : Layers;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setScopeType(t)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-xl transition-colors"
                    style={{
                      background: active ? 'var(--mt-accent-soft)' : 'var(--mt-bg-raised)',
                      color: active ? 'var(--mt-accent-text)' : 'var(--mt-text-secondary)',
                      border: `1px solid ${active ? 'var(--mt-accent-border)' : 'var(--mt-border)'}`,
                    }}
                  >
                    <Icon size={13} />
                    <span className="capitalize">{t}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] mt-1.5" style={{ color: 'var(--mt-text-faint)' }}>{scopeHintText}</p>
          </div>

          {/* Scope-specific fields */}
          {scopeType === 'state' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>State</label>
                <select
                  value={state}
                  onChange={e => setState(e.target.value)}
                  className="mt-input"
                >
                  <option value="" disabled>Select a state…</option>
                  {availableStates.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Anchor branch</label>
                <select
                  value={branchId ?? ''}
                  onChange={e => setBranchId(e.target.value ? Number(e.target.value) : null)}
                  className="mt-input"
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
              <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Branch</label>
              <select
                value={branchId ?? ''}
                onChange={e => setBranchId(e.target.value ? Number(e.target.value) : null)}
                className="mt-input"
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
                <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Branch</label>
                <select
                  value={branchId ?? ''}
                  onChange={e => setBranchId(e.target.value ? Number(e.target.value) : null)}
                  className="mt-input"
                >
                  <option value="" disabled>Select a branch…</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Stream</label>
                <select
                  value={streamId ?? ''}
                  onChange={e => setStreamId(e.target.value ? Number(e.target.value) : null)}
                  className="mt-input"
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
              <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Due date (optional)</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="mt-input"
              />
              <p className="text-[10px] mt-1" style={{ color: 'var(--mt-text-faint)' }}>Leave blank to auto-derive.</p>
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Period label (optional)</label>
              <input
                type="text"
                value={periodLabel}
                onChange={e => setPeriodLabel(e.target.value)}
                placeholder="e.g. Apr 2026"
                className="mt-input"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Assignee (optional)</label>
            <input
              type="text"
              value={assignee}
              onChange={e => setAssignee(e.target.value)}
              placeholder="Name of responsible person"
              className="mt-input"
            />
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: 'var(--mt-text-secondary)' }}>Notes (optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              className="mt-input"
            />
          </div>

          {error && <p className="text-xs" style={{ color: 'var(--mt-danger-text)' }}>{error}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            disabled={submitting}
            className="mt-btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12 }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="mt-btn-soft"
            style={{ padding: '6px 10px', fontSize: 12 }}
          >
            {submitting ? 'Adding…' : 'Add compliance'}
          </button>
        </div>
      </div>
    </div>
  );
}
