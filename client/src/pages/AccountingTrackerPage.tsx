// VCFO Accounting Tracker page.
//
// Month-end close checklist for the CFO/accountant workflow:
//   accountant claims → does the work → uploads supporting files → submits
//   reviewer (client admin / super_admin) → approves or rejects with reason
//
// Branch & stream context flows through the axios client via X-Branch-Id /
// X-Stream-Id headers (see client.ts). The server's resolveBranch middleware
// scopes results to the current branch; this page just renders whatever the
// backend returns and offers admin-only actions (generate / approve / reject /
// delete) gated on role from localStorage.
//
// Audit trail: every status transition writes a vcfo_accounting_task_events
// row in the same transaction as the status UPDATE. The task drawer surfaces
// the last 50 events.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2, ClipboardList, Clock, Download, FileText, Hand,
  Plus, RefreshCw, RotateCcw, Trash2, Upload, X, XCircle,
  AlertTriangle, Send, ChevronRight, Filter, Paperclip,
} from 'lucide-react';
import api from '../api/client';

interface CatalogEntry {
  id: number;
  key: string;
  name: string;
  category: string;
  frequency: 'monthly' | 'quarterly' | 'half-yearly' | 'annual';
  default_due_day: number | null;
  default_due_month: number | null;
  default_assignee_role: string | null;
  description: string | null;
  checklist: string | null;
  is_active: number;
  sort_order: number;
}

interface TaskFile {
  id: number;
  original_name: string;
  stored_name: string;
  size_bytes: number;
  mime_type: string | null;
  uploaded_at: string;
  uploaded_by_user_id: number | null;
  uploaded_by_name: string | null;
}

interface TaskEvent {
  id: number;
  actor_user_id: number | null;
  actor_name: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  created_at: string;
}

interface Task {
  id: number;
  catalog_id: number | null;
  branch_id: number;
  title: string;
  category: string;
  frequency: 'monthly' | 'quarterly' | 'half-yearly' | 'annual';
  period_label: string;
  period_start: string;
  period_end: string;
  due_date: string;
  assignee_user_id: number | null;
  assignee_name: string | null;
  reviewer_user_id: number | null;
  reviewer_name: string | null;
  status: 'pending' | 'in_progress' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  priority: 'low' | 'normal' | 'high' | 'critical';
  notes: string | null;
  submission_note: string | null;
  rejection_reason: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
  file_count?: number;
  event_count?: number;
  is_overdue?: number;
  files?: TaskFile[];
  events?: TaskEvent[];
}

const CATEGORY_LABEL: Record<string, string> = {
  bank: 'Bank & Treasury',
  receivables: 'Receivables',
  payables: 'Payables',
  payroll: 'Payroll',
  tax: 'Tax (GST/TDS/IT)',
  fa: 'Fixed Assets',
  inventory: 'Inventory',
  ledger: 'Ledger Scrutiny',
  reporting: 'Reporting & MIS',
  governance: 'Governance',
};

const CATEGORY_CHIP: Record<string, string> = {
  bank:        'bg-sky-500/10 text-sky-300 border-sky-500/20',
  receivables: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  payables:    'bg-amber-500/10 text-amber-300 border-amber-500/20',
  payroll:     'bg-rose-500/10 text-rose-300 border-rose-500/20',
  tax:         'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  fa:          'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/20',
  inventory:   'bg-orange-500/10 text-orange-300 border-orange-500/20',
  ledger:      'bg-teal-500/10 text-teal-300 border-teal-500/20',
  reporting:   'bg-cyan-500/10 text-cyan-300 border-cyan-500/20',
  governance:  'bg-violet-500/10 text-violet-300 border-violet-500/20',
};

const STATUS_LABEL: Record<string, string> = {
  pending:     'Pending',
  in_progress: 'In progress',
  submitted:   'Submitted',
  approved:    'Approved',
  rejected:    'Rejected',
  cancelled:   'Cancelled',
};

function statusChipClass(status: string, isOverdue?: number): string {
  if (isOverdue) return 'bg-red-500/10 text-red-300 border-red-500/20';
  switch (status) {
    case 'approved':    return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
    case 'submitted':   return 'bg-blue-500/10 text-blue-300 border-blue-500/20';
    case 'in_progress': return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
    case 'rejected':    return 'bg-red-500/10 text-red-300 border-red-500/20';
    case 'cancelled':   return 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20';
    default:            return 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20';
  }
}

function priorityChipClass(p: string): string {
  switch (p) {
    case 'critical': return 'bg-red-500/15 text-red-300 border-red-500/30';
    case 'high':     return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
    case 'low':      return 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20';
    default:         return 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20';
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type PeriodType = 'monthly' | 'quarterly' | 'annual';

function currentMonthLabel(): { label: string; start: string; end: string } {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();           // 0-11
  const monthName = d.toLocaleString('en-IN', { month: 'short' });
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const last = new Date(y, m + 1, 0).getDate();
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { label: `${monthName} ${y}`, start, end };
}

function currentQuarterLabel(): { label: string; start: string; end: string } {
  // Indian fiscal quarters: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar.
  const d = new Date();
  const m = d.getMonth() + 1;        // 1-12
  const y = d.getFullYear();
  let qNum: number, qStart: number, qEnd: number, qYearStart: number, qYearEnd: number;
  if (m >= 4 && m <= 6)  { qNum = 1; qStart = 4;  qEnd = 6;  qYearStart = y;     qYearEnd = y; }
  else if (m >= 7 && m <= 9)  { qNum = 2; qStart = 7;  qEnd = 9;  qYearStart = y;     qYearEnd = y; }
  else if (m >= 10 && m <= 12){ qNum = 3; qStart = 10; qEnd = 12; qYearStart = y;     qYearEnd = y; }
  else                          { qNum = 4; qStart = 1;  qEnd = 3;  qYearStart = y;     qYearEnd = y; }
  const fyStart = m >= 4 ? y : y - 1;
  const fyEnd = fyStart + 1;
  const label = `Q${qNum} FY ${String(fyStart).slice(2)}-${String(fyEnd).slice(2)}`;
  const start = `${qYearStart}-${String(qStart).padStart(2, '0')}-01`;
  const lastDay = new Date(qYearEnd, qEnd, 0).getDate();
  const end = `${qYearEnd}-${String(qEnd).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { label, start, end };
}

function currentFYLabel(): { label: string; start: string; end: string } {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const fyStart = m >= 4 ? y : y - 1;
  const fyEnd = fyStart + 1;
  return {
    label: `FY ${String(fyStart).slice(2)}-${String(fyEnd).slice(2)}`,
    start: `${fyStart}-04-01`,
    end: `${fyEnd}-03-31`,
  };
}

export default function AccountingTrackerPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [periodType, setPeriodType] = useState<PeriodType>('monthly');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'submitted' | 'approved' | 'overdue'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const [generating, setGenerating] = useState(false);

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

  const userRole = typeof window !== 'undefined' ? localStorage.getItem('user_role') : null;
  const userType = typeof window !== 'undefined' ? localStorage.getItem('user_type') : null;
  const canAdmin = userRole === 'admin' || userType === 'super_admin';

  const periodInfo = useMemo(() => {
    if (periodType === 'quarterly') return currentQuarterLabel();
    if (periodType === 'annual')    return currentFYLabel();
    return currentMonthLabel();
  }, [periodType]);

  const reloadTasks = () => {
    setLoading(true);
    setError(null);
    api.get('/vcfo/accounting-tasks')
      .then(r => { setTasks(r.data || []); setLoading(false); })
      .catch(err => {
        setError(err?.response?.data?.error || err?.message || 'Failed to load tasks');
        setLoading(false);
      });
  };

  useEffect(() => {
    api.get('/vcfo/accounting-tasks/catalog')
      .then(r => setCatalog(r.data || []))
      .catch(() => setCatalog([]));
  }, []);

  useEffect(reloadTasks, [sidebarBranchId, sidebarStreamId]);

  // Keep the drawer in sync with the list — if the selected task still exists
  // in the refreshed list, re-fetch its full record; otherwise close the drawer.
  const loadSelected = (id: number) => {
    setDrawerLoading(true);
    api.get(`/vcfo/accounting-tasks/${id}`)
      .then(r => { setSelectedTask(r.data); setDrawerLoading(false); })
      .catch(() => { setSelectedTask(null); setDrawerLoading(false); });
  };

  useEffect(() => {
    if (selectedTaskId) loadSelected(selectedTaskId);
    else setSelectedTask(null);
  }, [selectedTaskId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter(t => {
      if (categoryFilter !== 'all' && t.category !== categoryFilter) return false;
      if (needle && !(t.title.toLowerCase().includes(needle) || t.period_label.toLowerCase().includes(needle))) return false;
      if (statusFilter === 'open')       return !['approved', 'cancelled'].includes(t.status);
      if (statusFilter === 'submitted')  return t.status === 'submitted';
      if (statusFilter === 'approved')   return t.status === 'approved';
      if (statusFilter === 'overdue')    return !!t.is_overdue;
      return true;
    });
  }, [tasks, statusFilter, categoryFilter, search]);

  const summary = useMemo(() => {
    let open = 0, inProgress = 0, submitted = 0, approved = 0, overdue = 0;
    for (const t of tasks) {
      if (t.status === 'approved') approved++;
      else if (t.status === 'submitted') submitted++;
      else if (t.status === 'in_progress') inProgress++;
      else if (!['cancelled'].includes(t.status)) open++;
      if (t.is_overdue) overdue++;
    }
    return { open, inProgress, submitted, approved, overdue };
  }, [tasks]);

  const grouped = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of filtered) {
      const k = t.category;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const generatePeriod = async () => {
    if (!canAdmin) return;
    if (!confirm(`Generate ${periodType} tasks for ${periodInfo.label}? Duplicate (branch + catalog + period) rows are skipped automatically.`)) return;
    setGenerating(true);
    try {
      const r = await api.post('/vcfo/accounting-tasks/generate', {
        period_label: periodInfo.label,
        period_start: periodInfo.start,
        period_end: periodInfo.end,
        frequency: periodType,
      });
      alert(`Created ${r.data?.created ?? 0} tasks, skipped ${r.data?.skipped ?? 0}.`);
      reloadTasks();
    } catch (err: any) {
      alert(`Generate failed: ${err?.response?.data?.error || err?.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const claimTask = async (id: number) => {
    try {
      await api.post(`/vcfo/accounting-tasks/${id}/claim`);
      reloadTasks();
      if (selectedTaskId === id) loadSelected(id);
    } catch (err: any) {
      alert(`Claim failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  const submitTask = async (id: number) => {
    const note = prompt('Optional submission note:', '') ?? '';
    try {
      await api.post(`/vcfo/accounting-tasks/${id}/submit`, { submission_note: note });
      reloadTasks();
      if (selectedTaskId === id) loadSelected(id);
    } catch (err: any) {
      alert(`Submit failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  const approveTask = async (id: number) => {
    if (!confirm('Approve this task? This will mark it as completed for this period.')) return;
    try {
      await api.post(`/vcfo/accounting-tasks/${id}/approve`);
      reloadTasks();
      if (selectedTaskId === id) loadSelected(id);
    } catch (err: any) {
      alert(`Approve failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  const rejectTask = async (id: number) => {
    const reason = prompt('Reason for rejection (min 5 characters):', '');
    if (!reason || reason.trim().length < 5) {
      alert('A rejection reason of at least 5 characters is required.');
      return;
    }
    try {
      await api.post(`/vcfo/accounting-tasks/${id}/reject`, { reason: reason.trim() });
      reloadTasks();
      if (selectedTaskId === id) loadSelected(id);
    } catch (err: any) {
      alert(`Reject failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  const reopenTask = async (id: number) => {
    if (!confirm('Reopen this approved task? It will go back to "In progress".')) return;
    try {
      await api.post(`/vcfo/accounting-tasks/${id}/reopen`);
      reloadTasks();
      if (selectedTaskId === id) loadSelected(id);
    } catch (err: any) {
      alert(`Reopen failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  const deleteTask = async (id: number) => {
    if (!confirm('Delete this task permanently? All attached files will also be removed.')) return;
    try {
      await api.delete(`/vcfo/accounting-tasks/${id}`);
      if (selectedTaskId === id) setSelectedTaskId(null);
      reloadTasks();
    } catch (err: any) {
      alert(`Delete failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  const uploadFiles = async (id: number, files: FileList | null) => {
    if (!files || files.length === 0) return;
    const form = new FormData();
    for (const f of Array.from(files)) form.append('files', f);
    try {
      await api.post(`/vcfo/accounting-tasks/${id}/files`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (selectedTaskId === id) loadSelected(id);
      reloadTasks();
    } catch (err: any) {
      alert(`Upload failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  const downloadFile = async (taskId: number, fileId: number, originalName: string) => {
    try {
      const r = await api.get(`/vcfo/accounting-tasks/${taskId}/files/${fileId}`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = originalName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Download failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  const deleteFile = async (taskId: number, fileId: number) => {
    if (!confirm('Remove this attachment?')) return;
    try {
      await api.delete(`/vcfo/accounting-tasks/${taskId}/files/${fileId}`);
      if (selectedTaskId === taskId) loadSelected(taskId);
      reloadTasks();
    } catch (err: any) {
      alert(`Delete failed: ${err?.response?.data?.error || err?.message}`);
    }
  };

  return (
    <div className="min-h-full w-full">
      {/* Header ───────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-theme-bg/95 backdrop-blur border-b border-dark-400/30">
        <div className="px-4 md:px-6 py-3 flex items-center gap-3 flex-wrap">
          <ClipboardList className="text-accent-400" size={18} />
          <h1 className="text-sm md:text-base font-semibold text-theme-heading">Accounting Tracker</h1>
          <span className="text-[11px] text-theme-faint px-2 py-0.5 bg-dark-700 rounded-lg border border-dark-400/40">
            {tasks.length} task{tasks.length === 1 ? '' : 's'}
          </span>

          {/* Period picker */}
          <div className="ml-4 inline-flex items-center gap-0 bg-dark-700 border border-dark-400/50 rounded-xl overflow-hidden">
            {(['monthly', 'quarterly', 'annual'] as PeriodType[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriodType(p)}
                className={`px-2.5 py-1.5 text-xs font-medium ${periodType === p ? 'bg-accent-500/15 text-accent-400' : 'text-theme-faint hover:text-theme-secondary'}`}
              >
                {p === 'monthly' ? 'Month' : p === 'quarterly' ? 'Quarter' : 'FY'}
              </button>
            ))}
          </div>
          <span className="text-xs text-theme-muted">{periodInfo.label}</span>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={reloadTasks}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-dark-700 text-theme-secondary border border-dark-400/50 hover:bg-dark-600 rounded-xl"
              title="Refresh"
            >
              <RefreshCw size={13} /> Refresh
            </button>
            {canAdmin && (
              <button
                onClick={generatePeriod}
                disabled={generating}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 rounded-xl disabled:opacity-60"
              >
                <Plus size={13} /> {generating ? 'Generating…' : `Generate ${periodInfo.label}`}
              </button>
            )}
          </div>
        </div>

        {/* Summary chips */}
        <div className="px-4 md:px-6 pb-3 flex items-center gap-2 flex-wrap">
          <StatChip icon={<Clock size={12} />} label="Open"        value={summary.open}       tone="zinc" />
          <StatChip icon={<RotateCcw size={12} />} label="In progress" value={summary.inProgress} tone="amber" />
          <StatChip icon={<Send size={12} />} label="Submitted"    value={summary.submitted}  tone="blue" />
          <StatChip icon={<CheckCircle2 size={12} />} label="Approved" value={summary.approved} tone="emerald" />
          <StatChip icon={<AlertTriangle size={12} />} label="Overdue" value={summary.overdue} tone="red" />
        </div>

        {/* Filter bar */}
        <div className="px-4 md:px-6 pb-3 flex items-center gap-2 flex-wrap">
          <Filter size={13} className="text-theme-faint" />
          {(['all', 'open', 'submitted', 'approved', 'overdue'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-[11px] font-medium border rounded-lg capitalize ${statusFilter === s ? 'bg-accent-500/15 text-accent-400 border-accent-500/30' : 'bg-dark-700 text-theme-faint border-dark-400/40 hover:text-theme-secondary'}`}
            >
              {s}
            </button>
          ))}
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="ml-2 bg-dark-700 text-theme-secondary border border-dark-400/50 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent-500/40"
          >
            <option value="all">All categories</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by title or period…"
            className="flex-1 min-w-[180px] bg-dark-700 text-theme-primary border border-dark-400/50 text-xs rounded-lg px-3 py-1.5 placeholder:text-theme-faint focus:outline-none focus:ring-1 focus:ring-accent-500/40"
          />
        </div>
      </div>

      {/* Body ─────────────────────────────────────────────────────────────── */}
      <div className="p-4 md:p-6">
        {loading && <p className="text-theme-muted">Loading tasks…</p>}
        {error && (
          <div className="p-3 text-xs bg-red-500/10 text-red-300 border border-red-500/20 rounded-lg">
            {error}
          </div>
        )}

        {!loading && !error && tasks.length === 0 && (
          <EmptyState canAdmin={canAdmin} catalogSize={catalog.length} onGenerate={generatePeriod} periodLabel={periodInfo.label} />
        )}

        {!loading && !error && tasks.length > 0 && filtered.length === 0 && (
          <div className="p-6 text-center bg-dark-800/30 border border-dark-400/30 rounded-xl">
            <p className="text-theme-muted">No tasks match these filters.</p>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="space-y-6">
            {grouped.map(([cat, group]) => (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`px-2 py-0.5 text-[10px] font-semibold border rounded uppercase tracking-wider ${CATEGORY_CHIP[cat] || CATEGORY_CHIP.governance}`}>
                    {CATEGORY_LABEL[cat] || cat}
                  </span>
                  <span className="text-[11px] text-theme-faint">{group.length} task{group.length === 1 ? '' : 's'}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {group.map(t => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      onOpen={() => setSelectedTaskId(t.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Drawer ───────────────────────────────────────────────────────────── */}
      {selectedTaskId && (
        <TaskDrawer
          taskId={selectedTaskId}
          task={selectedTask}
          loading={drawerLoading}
          canAdmin={canAdmin}
          onClose={() => setSelectedTaskId(null)}
          onClaim={() => claimTask(selectedTaskId)}
          onSubmit={() => submitTask(selectedTaskId)}
          onApprove={() => approveTask(selectedTaskId)}
          onReject={() => rejectTask(selectedTaskId)}
          onReopen={() => reopenTask(selectedTaskId)}
          onDelete={() => deleteTask(selectedTaskId)}
          onUpload={files => uploadFiles(selectedTaskId, files)}
          onDownloadFile={(fileId, name) => downloadFile(selectedTaskId, fileId, name)}
          onDeleteFile={fileId => deleteFile(selectedTaskId, fileId)}
        />
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function StatChip({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: number;
  tone: 'zinc' | 'amber' | 'blue' | 'emerald' | 'red';
}) {
  const tones: Record<string, string> = {
    zinc:    'bg-zinc-500/10 text-zinc-300 border-zinc-500/20',
    amber:   'bg-amber-500/10 text-amber-300 border-amber-500/20',
    blue:    'bg-blue-500/10 text-blue-300 border-blue-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    red:     'bg-red-500/10 text-red-300 border-red-500/20',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium border rounded-lg ${tones[tone]}`}>
      {icon}
      <span>{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="text-left p-3 bg-dark-800/40 border border-dark-400/30 rounded-xl hover:border-accent-500/40 hover:bg-dark-700/40 transition-colors w-full flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className="flex-1 text-sm font-medium text-theme-primary line-clamp-2">{task.title}</span>
        <ChevronRight size={14} className="text-theme-faint mt-0.5 shrink-0" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`px-1.5 py-0.5 text-[10px] font-medium border rounded ${statusChipClass(task.status, task.is_overdue)}`}>
          {task.is_overdue ? 'Overdue' : STATUS_LABEL[task.status]}
        </span>
        {task.priority !== 'normal' && (
          <span className={`px-1.5 py-0.5 text-[10px] font-medium border rounded capitalize ${priorityChipClass(task.priority)}`}>
            {task.priority}
          </span>
        )}
        <span className="text-[11px] text-theme-faint">{task.period_label}</span>
      </div>
      <div className="flex items-center justify-between text-[11px] text-theme-muted">
        <span>Due {fmtDate(task.due_date)}</span>
        <span className="flex items-center gap-2">
          {task.assignee_name && <span className="text-theme-secondary">{task.assignee_name}</span>}
          {task.file_count ? (
            <span className="inline-flex items-center gap-0.5 text-theme-faint">
              <Paperclip size={10} /> {task.file_count}
            </span>
          ) : null}
        </span>
      </div>
    </button>
  );
}

function EmptyState({
  canAdmin, catalogSize, onGenerate, periodLabel,
}: { canAdmin: boolean; catalogSize: number; onGenerate: () => void; periodLabel: string }) {
  return (
    <div className="p-8 text-center bg-dark-800/30 border border-dark-400/30 rounded-xl">
      <ClipboardList size={28} className="mx-auto text-theme-faint mb-2" />
      <p className="text-theme-primary font-medium mb-1">No tasks for this branch yet.</p>
      <p className="text-sm text-theme-faint mb-3">
        The catalogue has {catalogSize} CFO-grade month/quarter/year-end tasks ready to spin up.
      </p>
      {canAdmin && (
        <button
          onClick={onGenerate}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 rounded-xl"
        >
          <Plus size={13} /> Generate {periodLabel}
        </button>
      )}
    </div>
  );
}

function TaskDrawer(props: {
  taskId: number;
  task: Task | null;
  loading: boolean;
  canAdmin: boolean;
  onClose: () => void;
  onClaim: () => void;
  onSubmit: () => void;
  onApprove: () => void;
  onReject: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onUpload: (files: FileList | null) => void;
  onDownloadFile: (fileId: number, name: string) => void;
  onDeleteFile: (fileId: number) => void;
}) {
  const { task, loading, canAdmin } = props;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const userIdRaw = typeof window !== 'undefined' ? localStorage.getItem('user_id') : null;
  const currentUserId = userIdRaw ? parseInt(userIdRaw, 10) : null;
  const isAssignee = task?.assignee_user_id != null && currentUserId != null && task.assignee_user_id === currentUserId;

  const canClaim = task && !task.assignee_user_id && ['pending', 'in_progress', 'rejected'].includes(task.status);
  const canSubmit = task && isAssignee && ['pending', 'in_progress', 'rejected'].includes(task.status);
  const canApprove = task && canAdmin && task.status === 'submitted';
  const canReject = task && canAdmin && task.status === 'submitted';
  const canReopen = task && canAdmin && task.status === 'approved';
  const canDelete = task && canAdmin;
  const canUpload = task && (canAdmin || isAssignee);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) props.onUpload(e.dataTransfer.files);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={props.onClose} />
      <aside className="fixed right-0 top-0 bottom-0 z-50 w-full md:w-[640px] bg-theme-bg border-l border-dark-400/40 shadow-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-theme-bg/95 backdrop-blur border-b border-dark-400/30">
          <ClipboardList size={16} className="text-accent-400" />
          <span className="text-sm font-semibold text-theme-heading flex-1 truncate">
            {task?.title || 'Loading…'}
          </span>
          <button
            onClick={props.onClose}
            className="p-1.5 text-theme-faint hover:text-theme-primary hover:bg-dark-700 rounded-lg"
          >
            <X size={16} />
          </button>
        </div>

        {loading && <p className="p-4 text-theme-muted text-sm">Loading…</p>}

        {!loading && task && (
          <div className="p-4 space-y-4">
            {/* Header meta */}
            <div className="flex flex-wrap items-center gap-2">
              <span className={`px-2 py-0.5 text-[10px] font-semibold border rounded uppercase tracking-wider ${CATEGORY_CHIP[task.category] || CATEGORY_CHIP.governance}`}>
                {CATEGORY_LABEL[task.category] || task.category}
              </span>
              <span className={`px-2 py-0.5 text-[10px] font-medium border rounded ${statusChipClass(task.status, task.is_overdue)}`}>
                {task.is_overdue ? 'Overdue' : STATUS_LABEL[task.status]}
              </span>
              <span className="text-[11px] text-theme-faint">{task.period_label}</span>
              <span className="text-[11px] text-theme-faint">· Due {fmtDate(task.due_date)}</span>
              <span className="text-[11px] text-theme-faint capitalize">· {task.frequency}</span>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              {canClaim && (
                <ActionButton icon={<Hand size={13} />} label="Claim" onClick={props.onClaim} tone="amber" />
              )}
              {canSubmit && (
                <ActionButton icon={<Send size={13} />} label="Submit for review" onClick={props.onSubmit} tone="blue" />
              )}
              {canApprove && (
                <ActionButton icon={<CheckCircle2 size={13} />} label="Approve" onClick={props.onApprove} tone="emerald" />
              )}
              {canReject && (
                <ActionButton icon={<XCircle size={13} />} label="Reject" onClick={props.onReject} tone="red" />
              )}
              {canReopen && (
                <ActionButton icon={<RotateCcw size={13} />} label="Reopen" onClick={props.onReopen} tone="zinc" />
              )}
              {canDelete && (
                <ActionButton icon={<Trash2 size={13} />} label="Delete" onClick={props.onDelete} tone="red-muted" />
              )}
            </div>

            {/* Meta grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <MetaRow label="Assignee" value={task.assignee_name || '— (unclaimed)'} />
              <MetaRow label="Reviewer" value={task.reviewer_name || '—'} />
              <MetaRow label="Period" value={`${fmtDate(task.period_start)} → ${fmtDate(task.period_end)}`} />
              <MetaRow label="Priority" value={<span className="capitalize">{task.priority}</span>} />
              <MetaRow label="Created" value={fmtDateTime(task.created_at)} />
              <MetaRow label="Updated" value={fmtDateTime(task.updated_at)} />
              {task.submitted_at && <MetaRow label="Submitted" value={fmtDateTime(task.submitted_at)} />}
              {task.approved_at && <MetaRow label="Approved"  value={fmtDateTime(task.approved_at)} />}
              {task.rejected_at && <MetaRow label="Rejected"  value={fmtDateTime(task.rejected_at)} />}
            </div>

            {task.notes && (
              <div>
                <h4 className="text-[11px] font-semibold text-theme-faint uppercase tracking-wider mb-1">Notes</h4>
                <p className="text-sm text-theme-primary whitespace-pre-wrap">{task.notes}</p>
              </div>
            )}
            {task.submission_note && (
              <div>
                <h4 className="text-[11px] font-semibold text-theme-faint uppercase tracking-wider mb-1">Submission note</h4>
                <p className="text-sm text-theme-primary whitespace-pre-wrap">{task.submission_note}</p>
              </div>
            )}
            {task.rejection_reason && (
              <div className="p-2 bg-red-500/5 border border-red-500/20 rounded">
                <h4 className="text-[11px] font-semibold text-red-300 uppercase tracking-wider mb-1">Rejection reason</h4>
                <p className="text-sm text-red-200 whitespace-pre-wrap">{task.rejection_reason}</p>
              </div>
            )}

            {/* Files */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] font-semibold text-theme-faint uppercase tracking-wider">
                  Attachments {task.files?.length ? `(${task.files.length})` : ''}
                </h4>
                {canUpload && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-dark-700 text-theme-secondary border border-dark-400/50 hover:bg-dark-600 rounded-lg"
                  >
                    <Upload size={11} /> Upload
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={e => { props.onUpload(e.target.files); e.target.value = ''; }}
                />
              </div>
              {canUpload && (
                <div
                  onDragOver={e => { e.preventDefault(); setDragActive(true); }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                  className={`p-3 mb-2 border-2 border-dashed rounded-lg text-center text-xs transition-colors ${dragActive ? 'border-accent-500/60 bg-accent-500/5 text-accent-300' : 'border-dark-400/40 text-theme-faint'}`}
                >
                  Drag & drop files here, or click Upload. Allowed: xlsx, xls, csv, pdf, png, jpg, docx. Max 25 MB / file.
                </div>
              )}
              {task.files && task.files.length > 0 ? (
                <ul className="space-y-1">
                  {task.files.map(f => (
                    <li key={f.id} className="flex items-center gap-2 px-2 py-1.5 bg-dark-800/40 border border-dark-400/30 rounded-lg">
                      <FileText size={13} className="text-theme-faint shrink-0" />
                      <span className="text-xs text-theme-primary truncate flex-1">{f.original_name}</span>
                      <span className="text-[10px] text-theme-faint">{fmtBytes(f.size_bytes)}</span>
                      {f.uploaded_by_name && <span className="text-[10px] text-theme-muted hidden md:inline">· {f.uploaded_by_name}</span>}
                      <button
                        onClick={() => props.onDownloadFile(f.id, f.original_name)}
                        className="p-1 text-theme-faint hover:text-accent-400 hover:bg-dark-700 rounded"
                        title="Download"
                      >
                        <Download size={12} />
                      </button>
                      {(canAdmin || (currentUserId && f.uploaded_by_user_id === currentUserId)) && (
                        <button
                          onClick={() => props.onDeleteFile(f.id)}
                          className="p-1 text-theme-faint hover:text-red-400 hover:bg-red-500/10 rounded"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-theme-faint italic">No attachments yet.</p>
              )}
            </div>

            {/* Events timeline */}
            <div>
              <h4 className="text-[11px] font-semibold text-theme-faint uppercase tracking-wider mb-2">
                Activity {task.events?.length ? `(${task.events.length})` : ''}
              </h4>
              {task.events && task.events.length > 0 ? (
                <ol className="space-y-1.5">
                  {task.events.map(ev => (
                    <li key={ev.id} className="flex items-start gap-2 text-xs">
                      <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-accent-500/60 shrink-0" />
                      <div className="flex-1">
                        <div className="text-theme-primary">
                          <span className="font-medium capitalize">{ev.event_type.replace(/_/g, ' ')}</span>
                          {ev.from_status && ev.to_status && (
                            <span className="text-theme-faint"> · {ev.from_status} → {ev.to_status}</span>
                          )}
                          {ev.actor_name && (
                            <span className="text-theme-muted"> · by {ev.actor_name}</span>
                          )}
                        </div>
                        {ev.note && <div className="text-theme-muted italic">{ev.note}</div>}
                        <div className="text-[10px] text-theme-faint">{fmtDateTime(ev.created_at)}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-theme-faint italic">No events recorded yet.</p>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-theme-faint uppercase tracking-wider">{label}</div>
      <div className="text-sm text-theme-primary">{value}</div>
    </div>
  );
}

function ActionButton({
  icon, label, onClick, tone,
}: {
  icon: React.ReactNode; label: string; onClick: () => void;
  tone: 'zinc' | 'amber' | 'blue' | 'emerald' | 'red' | 'red-muted';
}) {
  const tones: Record<string, string> = {
    zinc:      'bg-dark-700 text-theme-secondary border-dark-400/50 hover:bg-dark-600',
    amber:     'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/25',
    blue:      'bg-blue-500/15 text-blue-300 border-blue-500/30 hover:bg-blue-500/25',
    emerald:   'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25',
    red:       'bg-red-500/15 text-red-300 border-red-500/30 hover:bg-red-500/25',
    'red-muted': 'bg-dark-700 text-red-300 border-red-500/20 hover:bg-red-500/10',
  };
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold border rounded-lg ${tones[tone]}`}
    >
      {icon} {label}
    </button>
  );
}
