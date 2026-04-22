// VCFO Accounting Tracker page.
//
// Month-end close checklist for the CFO/accountant workflow:
//   accountant claims → does the work → uploads supporting files → submits
//   reviewer (client admin / super_admin) → approves or rejects with reason
//
// Visual language: Vision-Indefine (see client/src/index.css `.mt-*` tokens).
// The page renders a horizontal "close meter" across all statuses, three
// tone cards (review queue / due this week / overdue), a filter chip row,
// then task cards grouped by category. Opening a card reveals the side
// drawer with files, events and role-gated actions.
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
  CheckCircle2, ClipboardList, Clock, Download, Eye, FileText, Hand,
  Plus, RefreshCw, RotateCcw, Search, Trash2, Upload, X, XCircle,
  AlertTriangle, Send, Paperclip,
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

// ─── Category & status presentation ────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  bank:        'Bank & Treasury',
  receivables: 'Receivables',
  payables:    'Payables',
  payroll:     'Payroll',
  tax:         'Tax (GST/TDS/IT)',
  fa:          'Fixed Assets',
  inventory:   'Inventory',
  ledger:      'Ledger Scrutiny',
  reporting:   'Reporting & MIS',
  governance:  'Governance',
};

// Category colour palette — mirrors the Vision-Indefine spec. Each entry is
// rendered as a subtle chip using foreground+soft-background+border tokens.
interface CatColour { fg: string; bg: string; bd: string; }
const CATEGORY_COLOURS: Record<string, CatColour> = {
  bank:        { fg: '#0369a1', bg: 'rgba(14,165,233,0.10)',  bd: 'rgba(14,165,233,0.22)' },
  receivables: { fg: '#047857', bg: 'rgba(16,185,129,0.10)',  bd: 'rgba(16,185,129,0.22)' },
  payables:    { fg: '#b45309', bg: 'rgba(245,158,11,0.10)',  bd: 'rgba(245,158,11,0.25)' },
  payroll:     { fg: '#be123c', bg: 'rgba(244,63,94,0.10)',   bd: 'rgba(244,63,94,0.22)' },
  tax:         { fg: '#4338ca', bg: 'rgba(99,102,241,0.10)',  bd: 'rgba(99,102,241,0.22)' },
  fa:          { fg: '#a21caf', bg: 'rgba(217,70,239,0.10)',  bd: 'rgba(217,70,239,0.22)' },
  inventory:   { fg: '#c2410c', bg: 'rgba(249,115,22,0.10)',  bd: 'rgba(249,115,22,0.22)' },
  ledger:      { fg: '#0f766e', bg: 'rgba(20,184,166,0.10)',  bd: 'rgba(20,184,166,0.22)' },
  reporting:   { fg: '#0e7490', bg: 'rgba(6,182,212,0.10)',   bd: 'rgba(6,182,212,0.22)' },
  governance:  { fg: '#6d28d9', bg: 'rgba(139,92,246,0.10)',  bd: 'rgba(139,92,246,0.22)' },
};
// Dark-theme foregrounds are a shade lighter so they read on dark cards.
const CATEGORY_COLOURS_DARK: Record<string, string> = {
  bank: '#7dd3fc', receivables: '#6ee7b7', payables: '#fcd34d', payroll: '#fda4af',
  tax: '#a5b4fc', fa: '#f0abfc', inventory: '#fdba74', ledger: '#5eead4',
  reporting: '#67e8f9', governance: '#c4b5fd',
};

function categoryColour(cat: string): CatColour {
  const c = CATEGORY_COLOURS[cat] || CATEGORY_COLOURS.governance;
  return {
    fg: `var(--mt-cat-${cat}-fg, ${c.fg})`,
    bg: c.bg,
    bd: c.bd,
  };
}

const STATUS_LABEL: Record<string, string> = {
  pending:     'Pending',
  in_progress: 'In progress',
  submitted:   'Submitted',
  approved:    'Approved',
  rejected:    'Rejected',
  cancelled:   'Cancelled',
};

function statusPillClass(status: string, isOverdue?: number): string {
  if (isOverdue) return 'mt-pill mt-pill--danger';
  switch (status) {
    case 'approved':    return 'mt-pill mt-pill--success';
    case 'submitted':   return 'mt-pill mt-pill--info';
    case 'in_progress': return 'mt-pill mt-pill--warn';
    case 'rejected':    return 'mt-pill mt-pill--danger';
    case 'cancelled':   return 'mt-pill mt-pill--neutral';
    default:            return 'mt-pill mt-pill--neutral';
  }
}

// ─── Date helpers ──────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
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

function daysBetween(a: string, b: Date): number {
  const [y, m, d] = a.slice(0, 10).split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return 0;
  const ad = Date.UTC(y, m - 1, d);
  const bd = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ad - bd) / (1000 * 60 * 60 * 24));
}

type PeriodType = 'monthly' | 'quarterly' | 'annual';

function currentMonthLabel(): { label: string; start: string; end: string } {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const monthName = d.toLocaleString('en-IN', { month: 'short' });
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const last = new Date(y, m + 1, 0).getDate();
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { label: `${monthName} ${y}`, start, end };
}

function currentQuarterLabel(): { label: string; start: string; end: string } {
  const d = new Date();
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  let qNum: number, qStart: number, qEnd: number, qYearStart: number, qYearEnd: number;
  if (m >= 4 && m <= 6)       { qNum = 1; qStart = 4;  qEnd = 6;  qYearStart = y; qYearEnd = y; }
  else if (m >= 7 && m <= 9)  { qNum = 2; qStart = 7;  qEnd = 9;  qYearStart = y; qYearEnd = y; }
  else if (m >= 10 && m <= 12){ qNum = 3; qStart = 10; qEnd = 12; qYearStart = y; qYearEnd = y; }
  else                        { qNum = 4; qStart = 1;  qEnd = 3;  qYearStart = y; qYearEnd = y; }
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

// ═══════════════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════════════

export default function AccountingTrackerPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [periodType, setPeriodType] = useState<PeriodType>('monthly');
  type ChipFilter = 'all' | 'submitted' | 'in_progress' | 'pending' | 'approved' | 'overdue';
  const [chipFilter, setChipFilter] = useState<ChipFilter>('all');
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

  // ── Derived summary counts (drive the close meter + tone cards) ──────
  const summary = useMemo(() => {
    let pending = 0, inProgress = 0, submitted = 0, approved = 0,
        rejected = 0, cancelled = 0, overdue = 0;
    const today = new Date();
    let dueThisWeek = 0;
    for (const t of tasks) {
      if (t.status === 'approved')         approved++;
      else if (t.status === 'submitted')   submitted++;
      else if (t.status === 'in_progress') inProgress++;
      else if (t.status === 'rejected')    rejected++;
      else if (t.status === 'cancelled')   cancelled++;
      else                                 pending++;
      if (t.is_overdue) overdue++;
      if (!['approved', 'cancelled'].includes(t.status)) {
        const gap = daysBetween(t.due_date, today);
        if (gap >= 0 && gap <= 7) dueThisWeek++;
      }
    }
    const total = tasks.length;
    const percent = total > 0 ? Math.round((approved / total) * 100) : 0;
    return { pending, inProgress, submitted, approved, rejected, cancelled, overdue, dueThisWeek, total, percent };
  }, [tasks]);

  // Close deadline = period_end + 10 days. Show countdown until then.
  const deadlineInfo = useMemo(() => {
    const { end, label } = periodInfo;
    const [y, m, d] = end.split('-').map(n => parseInt(n, 10));
    const deadline = new Date(y, m - 1, d);
    deadline.setDate(deadline.getDate() + 10);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return {
      label,
      deadline,
      days,
      text: days > 0
        ? `${days} day${days === 1 ? '' : 's'} to deadline`
        : days === 0
          ? 'deadline today'
          : `${Math.abs(days)} day${days === -1 ? '' : 's'} past deadline`,
      overdue: days < 0,
    };
  }, [periodInfo]);

  // ── Filtering ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter(t => {
      if (categoryFilter !== 'all' && t.category !== categoryFilter) return false;
      if (needle && !(t.title.toLowerCase().includes(needle) || t.period_label.toLowerCase().includes(needle))) return false;
      switch (chipFilter) {
        case 'submitted':   return t.status === 'submitted';
        case 'in_progress': return t.status === 'in_progress';
        case 'pending':     return !t.assignee_user_id && t.status === 'pending';
        case 'approved':    return t.status === 'approved';
        case 'overdue':     return !!t.is_overdue;
        default:            return true;
      }
    });
  }, [tasks, chipFilter, categoryFilter, search]);

  const grouped = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of filtered) {
      const k = t.category;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    // Sort by preferred category order, then alpha
    const order = ['bank', 'tax', 'payables', 'receivables', 'payroll', 'fa',
                   'inventory', 'ledger', 'reporting', 'governance'];
    return Array.from(m.entries()).sort((a, b) => {
      const ai = order.indexOf(a[0]); const bi = order.indexOf(b[0]);
      if (ai !== -1 && bi !== -1) return ai - bi;
      return a[0].localeCompare(b[0]);
    });
  }, [filtered]);

  // ── Actions ──────────────────────────────────────────────────────────
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

  const fullPageAction = (task: Task) => {
    if (task.status === 'submitted' && canAdmin) return { label: 'Review & decide', fn: () => setSelectedTaskId(task.id), primary: true };
    if (task.status === 'pending' && !task.assignee_user_id) return { label: 'Claim', fn: () => claimTask(task.id), primary: false };
    if (task.status === 'in_progress' || task.status === 'rejected') return { label: 'Submit for review', fn: () => submitTask(task.id), primary: task.status === 'in_progress' };
    if (task.status === 'approved') return { label: 'View', fn: () => setSelectedTaskId(task.id), primary: false };
    return { label: 'Open', fn: () => setSelectedTaskId(task.id), primary: false };
  };

  return (
    <div className="min-h-full w-full">
      {/* ═════ Header + close meter + tone cards + filter chips ═════ */}
      <div className="sticky top-0 z-20" style={{ background: 'var(--mt-bg-app)' }}>
        {/* Top title row */}
        <div className="px-4 md:px-6 pt-4 pb-3 flex items-center gap-3 flex-wrap">
          <ClipboardList size={18} style={{ color: 'var(--mt-accent-text)' }} />
          <h1 className="text-base font-semibold" style={{ color: 'var(--mt-text-heading)' }}>
            Accounting Tracker
          </h1>

          {/* Period picker (month / quarter / FY) */}
          <div
            className="ml-3 inline-flex items-center rounded-xl overflow-hidden"
            style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
          >
            {(['monthly', 'quarterly', 'annual'] as PeriodType[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriodType(p)}
                className="px-2.5 py-1.5 text-xs font-medium transition-colors"
                style={{
                  color: periodType === p ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)',
                  background: periodType === p ? 'var(--mt-accent-soft)' : 'transparent',
                }}
              >
                {p === 'monthly' ? 'Month' : p === 'quarterly' ? 'Quarter' : 'FY'}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={reloadTasks}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl transition-colors"
              style={{
                background: 'var(--mt-bg-raised)',
                color: 'var(--mt-text-secondary)',
                border: '1px solid var(--mt-border-strong)',
              }}
              title="Refresh"
            >
              <RefreshCw size={13} /> Refresh
            </button>
            {canAdmin && (
              <button
                onClick={generatePeriod}
                disabled={generating}
                className="mt-btn-gradient"
                style={{ fontSize: '12px', padding: '7px 13px' }}
              >
                <Plus size={13} /> {generating ? 'Generating…' : `Generate ${periodInfo.label}`}
              </button>
            )}
          </div>
        </div>

        {/* ── Close meter card (full-width) ───────────────────────────── */}
        <div className="px-4 md:px-6 pb-3">
          <CloseMeterCard
            periodLabel={deadlineInfo.label}
            deadlineText={deadlineInfo.text}
            deadlineOverdue={deadlineInfo.overdue}
            percent={summary.percent}
            approved={summary.approved}
            total={summary.total}
            summary={summary}
          />

          {/* Tone cards row — review queue / due this week / overdue */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-3">
            <ToneCard
              tone="info"
              icon={<Eye size={14} />}
              label="Review queue"
              value={summary.submitted}
              hint={summary.submitted === 1 ? 'ready for review' : 'ready for review'}
              onClick={() => setChipFilter('submitted')}
              active={chipFilter === 'submitted'}
            />
            <ToneCard
              tone="warn"
              icon={<Clock size={14} />}
              label="Due this week"
              value={summary.dueThisWeek}
              hint="within 7 days"
            />
            <ToneCard
              tone="danger"
              icon={<AlertTriangle size={14} />}
              label="Overdue"
              value={summary.overdue}
              hint="action needed"
              onClick={() => setChipFilter('overdue')}
              active={chipFilter === 'overdue'}
            />
          </div>
        </div>

        {/* Filter chip row + search */}
        <div className="px-4 md:px-6 pb-3 flex items-center gap-2 flex-wrap">
          {([
            { key: 'all',         label: 'All',        count: summary.total },
            { key: 'submitted',   label: 'Submitted',  count: summary.submitted },
            { key: 'in_progress', label: 'Working',    count: summary.inProgress },
            { key: 'pending',     label: 'Unclaimed',  count: summary.pending },
            { key: 'approved',    label: 'Approved',   count: summary.approved },
            { key: 'overdue',     label: 'Overdue',    count: summary.overdue },
          ] as { key: ChipFilter; label: string; count: number }[]).map(f => (
            <button
              key={f.key}
              onClick={() => setChipFilter(f.key)}
              className={`mt-chip ${chipFilter === f.key ? 'mt-chip--active' : ''}`}
              type="button"
            >
              <span>{f.label}</span>
              <span className="mt-num" style={{ fontSize: 11, opacity: 0.85 }}>{f.count}</span>
            </button>
          ))}

          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="ml-1 text-xs rounded-lg px-2 py-1.5"
            style={{
              background: 'var(--mt-bg-raised)',
              color: 'var(--mt-text-secondary)',
              border: '1px solid var(--mt-border)',
            }}
          >
            <option value="all">All categories</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>

          <div
            className="flex items-center gap-1.5 flex-1 min-w-[180px] px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
          >
            <Search size={12} style={{ color: 'var(--mt-text-faint)' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tasks…"
              className="flex-1 bg-transparent outline-none text-xs"
              style={{ color: 'var(--mt-text-primary)' }}
            />
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--mt-border)' }} />
      </div>

      {/* ═════ Body — grouped task grid ═════ */}
      <div className="p-4 md:p-6" style={{ background: 'var(--mt-bg-app)' }}>
        {loading && <p style={{ color: 'var(--mt-text-muted)' }}>Loading tasks…</p>}
        {error && (
          <div
            className="p-3 text-xs rounded-lg"
            style={{
              background: 'var(--mt-danger-soft)',
              color: 'var(--mt-danger-text)',
              border: '1px solid var(--mt-danger-border)',
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && tasks.length === 0 && (
          <EmptyState canAdmin={canAdmin} catalogSize={catalog.length} onGenerate={generatePeriod} periodLabel={periodInfo.label} />
        )}

        {!loading && !error && tasks.length > 0 && filtered.length === 0 && (
          <div
            className="p-6 text-center rounded-xl"
            style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
          >
            <p style={{ color: 'var(--mt-text-muted)' }}>No tasks match these filters.</p>
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="space-y-5">
            {grouped.map(([cat, group]) => {
              const c = categoryColour(cat);
              return (
                <div key={cat}>
                  <div className="flex items-center gap-2.5 mb-2.5">
                    <span
                      className="inline-flex items-center"
                      style={{
                        padding: '3px 8px',
                        borderRadius: 5,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        color: c.fg,
                        background: c.bg,
                        border: `1px solid ${c.bd}`,
                      }}
                    >
                      {CATEGORY_LABEL[cat] || cat}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
                      {group.length} task{group.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div
                    className="grid gap-2.5"
                    style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
                  >
                    {group.map(t => (
                      <TaskCardMini
                        key={t.id}
                        task={t}
                        catColour={c}
                        action={fullPageAction(t)}
                        onOpen={() => setSelectedTaskId(t.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═════ Drawer ═════ */}
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

// ═══════════════════════════════════════════════════════════════════════
// Close meter card — full-width horizontal stacked bar segmented by status.
// ═══════════════════════════════════════════════════════════════════════
function CloseMeterCard({
  periodLabel, deadlineText, deadlineOverdue, percent, approved, total, summary,
}: {
  periodLabel: string;
  deadlineText: string;
  deadlineOverdue: boolean;
  percent: number;
  approved: number;
  total: number;
  summary: { pending: number; inProgress: number; submitted: number; approved: number; overdue: number };
}) {
  const segments = [
    { k: 'approved',    v: summary.approved,   label: 'Approved',  c: '#10b981', fg: '#d1fae5' },
    { k: 'submitted',   v: summary.submitted,  label: 'In review', c: '#3b82f6', fg: '#dbeafe' },
    { k: 'in_progress', v: summary.inProgress, label: 'Working',   c: '#f59e0b', fg: '#fef3c7' },
    { k: 'pending',     v: summary.pending,    label: 'Unclaimed', c: 'rgba(148,163,184,0.6)', fg: '#e2e8f0' },
    { k: 'overdue',     v: summary.overdue,    label: 'Overdue',   c: '#ef4444', fg: '#fecaca' },
  ].filter(s => s.v > 0);

  const totalValue = segments.reduce((n, s) => n + s.v, 0) || 1;

  return (
    <div className="mt-card" style={{ padding: 18 }}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--mt-text-faint)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {periodLabel} close · {deadlineText}
          </span>
          <span className={`mt-pill ${deadlineOverdue ? 'mt-pill--danger' : percent >= 100 ? 'mt-pill--success' : 'mt-pill--info'}`}>
            {percent}% complete
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="mt-num mt-heading" style={{ fontSize: 24, lineHeight: 1 }}>{approved}</span>
          <span style={{ fontSize: 13, color: 'var(--mt-text-faint)' }}>/ {total} tasks</span>
        </div>
      </div>

      {/* Stacked horizontal bar */}
      <div
        className="flex overflow-hidden"
        style={{
          height: 44,
          borderRadius: 10,
          border: '1px solid var(--mt-border-strong)',
          background: 'var(--mt-bg-subtle)',
        }}
      >
        {total === 0 ? (
          <div
            className="flex-1 flex items-center justify-center"
            style={{ color: 'var(--mt-text-faint)', fontSize: 11, fontWeight: 500 }}
          >
            No tasks yet — generate this period to begin tracking.
          </div>
        ) : segments.length === 0 ? (
          <div
            className="flex-1 flex items-center justify-center"
            style={{ color: 'var(--mt-text-faint)', fontSize: 11 }}
          >
            Nothing in play yet.
          </div>
        ) : (
          segments.map((s, i) => (
            <div
              key={s.k}
              style={{
                flex: s.v / totalValue,
                background: `linear-gradient(180deg, ${s.c}ee, ${s.c}aa)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderLeft: i > 0 ? '1px solid rgba(0,0,0,0.18)' : 'none',
                minWidth: 48,
              }}
              title={`${s.label}: ${s.v}`}
            >
              <div style={{ textAlign: 'center', padding: '0 6px' }}>
                <div className="mt-num" style={{ fontSize: 15, fontWeight: 800, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.35)', lineHeight: 1 }}>
                  {s.v}
                </div>
                <div style={{ fontSize: 9, fontWeight: 700, color: s.fg, letterSpacing: '0.04em', textTransform: 'uppercase', marginTop: 2 }}>
                  {s.label}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Tone card — small summary card with icon + count + hint.
// ═══════════════════════════════════════════════════════════════════════
function ToneCard({
  tone, icon, label, value, hint, onClick, active,
}: {
  tone: 'accent' | 'info' | 'warn' | 'danger';
  icon: React.ReactNode;
  label: string;
  value: number;
  hint: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const cls = `mt-tone-card mt-tone-card--${tone}`;
  const content = (
    <>
      <div className="mt-tone-icon">{icon}</div>
      <div className="flex-1 min-w-0">
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {label}
        </div>
        <div className="flex items-baseline gap-1.5 mt-0.5">
          <span className="mt-num mt-heading" style={{ fontSize: 18, lineHeight: 1, color: 'inherit' }}>{value}</span>
          <span style={{ fontSize: 10.5, color: 'var(--mt-text-muted)' }}>{hint}</span>
        </div>
      </div>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cls}
        style={{
          textAlign: 'left',
          cursor: 'pointer',
          transition: 'filter .15s ease, box-shadow .15s ease',
          ...(active ? { boxShadow: '0 0 0 2px var(--mt-accent-border)' } : {}),
        }}
      >
        {content}
      </button>
    );
  }
  return <div className={cls}>{content}</div>;
}

// ═══════════════════════════════════════════════════════════════════════
// TaskCardMini — 4-stage pipeline bar + stage labels + waiting panel.
// ═══════════════════════════════════════════════════════════════════════
function TaskCardMini({
  task, catColour, action, onOpen,
}: {
  task: Task;
  catColour: CatColour;
  action: { label: string; fn: () => void; primary: boolean };
  onOpen: () => void;
}) {
  const stages = ['pending', 'in_progress', 'submitted', 'approved'] as const;
  const currentIdx = task.status === 'rejected' ? 1 : stages.indexOf(task.status as typeof stages[number]);
  const isOverdue = !!task.is_overdue;

  const stageLabels = ['Pending', 'Working', 'Review', 'Done'];

  const waitingText = (() => {
    if (task.status === 'approved')   return 'Closed & approved';
    if (task.status === 'rejected')   return 'Returned — rework needed';
    if (task.status === 'cancelled')  return 'Cancelled';
    if (task.status === 'submitted')  return task.reviewer_name ? `Awaiting ${task.reviewer_name}` : 'Awaiting reviewer';
    if (task.status === 'in_progress')return 'Working on it';
    return 'Waiting for claim';
  })();

  const assigneeInitials = task.assignee_name
    ? task.assignee_name.split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase()
    : '?';

  // Days late vs due date (for the overdue badge)
  const daysLate = useMemo(() => {
    if (!isOverdue) return 0;
    return Math.abs(daysBetween(task.due_date, new Date()));
  }, [isOverdue, task.due_date]);

  return (
    <div
      className="rounded-2xl p-3.5 flex flex-col"
      style={{
        background: 'var(--mt-bg-raised)',
        border: `1px solid ${isOverdue ? 'rgba(239,68,68,0.3)' : 'var(--mt-border)'}`,
        boxShadow: 'var(--mt-shadow-card)',
      }}
    >
      {/* Pipeline bar */}
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left"
        style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <div className="flex gap-[3px] mb-2.5">
          {stages.map((s, i) => {
            const done = i < currentIdx;
            const active = i === currentIdx;
            const bg = done
              ? '#10b981'
              : active
                ? (isOverdue ? '#ef4444' : '#10b981')
                : 'rgba(148,163,184,0.22)';
            return (
              <div key={s} style={{ flex: 1, height: 3, borderRadius: 999, background: bg }} />
            );
          })}
        </div>
        <div className="flex justify-between mb-2.5" style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          {stageLabels.map((l, i) => (
            <span
              key={l}
              style={{
                color:
                  i < currentIdx
                    ? 'var(--mt-accent-text)'
                    : i === currentIdx
                      ? (isOverdue ? 'var(--mt-danger-text)' : 'var(--mt-accent-text)')
                      : 'var(--mt-text-faint)',
              }}
            >
              {l}
            </span>
          ))}
        </div>

        {/* Category chip + period + priority */}
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          <span
            style={{
              padding: '3px 7px',
              borderRadius: 5,
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: catColour.fg,
              background: catColour.bg,
              border: `1px solid ${catColour.bd}`,
            }}
          >
            {(CATEGORY_LABEL[task.category] || task.category).split(' ')[0]}
          </span>
          <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--mt-text-faint)' }}>
            {task.period_label}
          </span>
          {task.priority === 'critical' && (
            <span className="mt-pill mt-pill--danger mt-pill-sm">Critical</span>
          )}
          {task.priority === 'high' && (
            <span className="mt-pill mt-pill--warn mt-pill-sm">High</span>
          )}
        </div>

        {/* Title */}
        <div
          className="mb-2.5"
          style={{
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 1.35,
            color: 'var(--mt-text-heading)',
            letterSpacing: '-0.01em',
          }}
        >
          {task.title}
        </div>
      </button>

      {/* Assignee-waiting panel */}
      <div
        className="flex items-center gap-2 mb-2.5"
        style={{
          padding: '7px 10px',
          background: 'var(--mt-bg-muted)',
          borderRadius: 8,
        }}
      >
        <div className="mt-avatar" style={{ width: 22, height: 22, fontSize: 9 }}>
          {assigneeInitials}
        </div>
        <div className="flex-1 min-w-0">
          <div style={{ fontSize: 10, lineHeight: 1.2, color: 'var(--mt-text-faint)' }}>
            {waitingText}
          </div>
          <div
            className="truncate"
            style={{ fontSize: 11.5, fontWeight: 500, lineHeight: 1.2, color: 'var(--mt-text-primary)', marginTop: 1 }}
          >
            {task.assignee_name || 'Unassigned'}
          </div>
        </div>
        {isOverdue ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: 'var(--mt-danger-text)',
              background: 'var(--mt-danger-soft)',
              border: '1px solid var(--mt-danger-border)',
              padding: '2px 6px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              letterSpacing: '0.02em',
            }}
          >
            {daysLate}D LATE
          </span>
        ) : (
          <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--mt-text-muted)', whiteSpace: 'nowrap' }}>
            Due {fmtDateShort(task.due_date)}
          </span>
        )}
        {task.file_count ? (
          <span
            className="inline-flex items-center gap-0.5"
            style={{ fontSize: 10, color: 'var(--mt-text-faint)', whiteSpace: 'nowrap' }}
          >
            <Paperclip size={10} /> {task.file_count}
          </span>
        ) : null}
      </div>

      {/* Full-width next-action button */}
      <button
        type="button"
        onClick={action.fn}
        className={action.primary ? 'mt-btn-gradient' : ''}
        style={
          action.primary
            ? { width: '100%', fontSize: 11.5, padding: '7px 10px' }
            : {
                width: '100%',
                padding: '7px 10px',
                borderRadius: 8,
                fontSize: 11.5,
                fontWeight: 600,
                background: 'transparent',
                color: 'var(--mt-text-secondary)',
                border: '1px solid var(--mt-border-strong)',
                cursor: 'pointer',
                transition: 'background-color .12s ease',
              }
        }
      >
        {action.label}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// EmptyState
// ═══════════════════════════════════════════════════════════════════════
function EmptyState({
  canAdmin, catalogSize, onGenerate, periodLabel,
}: { canAdmin: boolean; catalogSize: number; onGenerate: () => void; periodLabel: string }) {
  return (
    <div
      className="p-8 text-center rounded-2xl"
      style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
    >
      <ClipboardList size={28} className="mx-auto mb-2" style={{ color: 'var(--mt-text-faint)' }} />
      <p className="font-medium mb-1" style={{ color: 'var(--mt-text-primary)' }}>
        No tasks for this branch yet.
      </p>
      <p className="text-sm mb-3" style={{ color: 'var(--mt-text-faint)' }}>
        The catalogue has {catalogSize} CFO-grade month/quarter/year-end tasks ready to spin up.
      </p>
      {canAdmin && (
        <button
          onClick={onGenerate}
          className="mt-btn-gradient"
          style={{ fontSize: 12 }}
        >
          <Plus size={13} /> Generate {periodLabel}
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// TaskDrawer — right-hand detail pane. Preserved from the previous version
// with a light restyle onto the Vision tokens.
// ═══════════════════════════════════════════════════════════════════════
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

  const canClaim   = task && !task.assignee_user_id && ['pending', 'in_progress', 'rejected'].includes(task.status);
  const canSubmit  = task && isAssignee && ['pending', 'in_progress', 'rejected'].includes(task.status);
  const canApprove = task && canAdmin && task.status === 'submitted';
  const canReject  = task && canAdmin && task.status === 'submitted';
  const canReopen  = task && canAdmin && task.status === 'approved';
  const canDelete  = task && canAdmin;
  const canUpload  = task && (canAdmin || isAssignee);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) props.onUpload(e.dataTransfer.files);
  };

  const cat = task ? categoryColour(task.category) : null;

  return (
    <>
      <div className="fixed inset-0 z-40" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={props.onClose} />
      <aside
        className="fixed right-0 top-0 bottom-0 z-50 w-full md:w-[640px] overflow-y-auto"
        style={{
          background: 'var(--mt-bg-surface)',
          borderLeft: '1px solid var(--mt-border-strong)',
          boxShadow: 'var(--mt-shadow-pop)',
        }}
      >
        <div
          className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 backdrop-blur"
          style={{
            background: 'color-mix(in srgb, var(--mt-bg-surface) 95%, transparent)',
            borderBottom: '1px solid var(--mt-border)',
          }}
        >
          <ClipboardList size={16} style={{ color: 'var(--mt-accent-text)' }} />
          <span className="text-sm font-semibold flex-1 truncate" style={{ color: 'var(--mt-text-heading)' }}>
            {task?.title || 'Loading…'}
          </span>
          <button
            onClick={props.onClose}
            className="p-1.5 rounded-lg"
            style={{ color: 'var(--mt-text-faint)', background: 'transparent' }}
            onMouseOver={e => { e.currentTarget.style.background = 'var(--mt-bg-muted)'; }}
            onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={16} />
          </button>
        </div>

        {loading && <p className="p-4 text-sm" style={{ color: 'var(--mt-text-muted)' }}>Loading…</p>}

        {!loading && task && cat && (
          <div className="p-4 space-y-4">
            {/* Header meta */}
            <div className="flex flex-wrap items-center gap-2">
              <span
                style={{
                  padding: '3px 8px',
                  borderRadius: 5,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  color: cat.fg,
                  background: cat.bg,
                  border: `1px solid ${cat.bd}`,
                }}
              >
                {CATEGORY_LABEL[task.category] || task.category}
              </span>
              <span className={statusPillClass(task.status, task.is_overdue)}>
                {task.is_overdue ? 'Overdue' : STATUS_LABEL[task.status]}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>{task.period_label}</span>
              <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>· Due {fmtDate(task.due_date)}</span>
              <span className="text-[11px] capitalize" style={{ color: 'var(--mt-text-faint)' }}>· {task.frequency}</span>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              {canClaim && (
                <ActionButton icon={<Hand size={13} />} label="Claim" onClick={props.onClaim} tone="warn" />
              )}
              {canSubmit && (
                <ActionButton icon={<Send size={13} />} label="Submit for review" onClick={props.onSubmit} tone="info" primary />
              )}
              {canApprove && (
                <ActionButton icon={<CheckCircle2 size={13} />} label="Approve" onClick={props.onApprove} tone="success" primary />
              )}
              {canReject && (
                <ActionButton icon={<XCircle size={13} />} label="Reject" onClick={props.onReject} tone="danger" />
              )}
              {canReopen && (
                <ActionButton icon={<RotateCcw size={13} />} label="Reopen" onClick={props.onReopen} tone="neutral" />
              )}
              {canDelete && (
                <ActionButton icon={<Trash2 size={13} />} label="Delete" onClick={props.onDelete} tone="danger-muted" />
              )}
            </div>

            {/* Meta grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <MetaRow label="Assignee" value={task.assignee_name || '— (unclaimed)'} />
              <MetaRow label="Reviewer" value={task.reviewer_name || '—'} />
              <MetaRow label="Period"   value={`${fmtDate(task.period_start)} → ${fmtDate(task.period_end)}`} />
              <MetaRow label="Priority" value={<span className="capitalize">{task.priority}</span>} />
              <MetaRow label="Created"  value={fmtDateTime(task.created_at)} />
              <MetaRow label="Updated"  value={fmtDateTime(task.updated_at)} />
              {task.submitted_at && <MetaRow label="Submitted" value={fmtDateTime(task.submitted_at)} />}
              {task.approved_at  && <MetaRow label="Approved"  value={fmtDateTime(task.approved_at)} />}
              {task.rejected_at  && <MetaRow label="Rejected"  value={fmtDateTime(task.rejected_at)} />}
            </div>

            {task.notes && (
              <div>
                <h4 className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--mt-text-faint)' }}>Notes</h4>
                <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--mt-text-primary)' }}>{task.notes}</p>
              </div>
            )}
            {task.submission_note && (
              <div
                style={{
                  padding: '11px 13px',
                  borderRadius: 10,
                  background: 'var(--mt-info-soft)',
                  borderLeft: '3px solid var(--mt-info)',
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: 'var(--mt-text-primary)',
                }}
              >
                <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--mt-info-text)' }}>Submission note</div>
                {task.submission_note}
              </div>
            )}
            {task.rejection_reason && (
              <div
                style={{
                  padding: '11px 13px',
                  borderRadius: 10,
                  background: 'var(--mt-danger-soft)',
                  borderLeft: '3px solid #ef4444',
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: 'var(--mt-text-primary)',
                }}
              >
                <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--mt-danger-text)' }}>Rejection reason</div>
                {task.rejection_reason}
              </div>
            )}

            {/* Files */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>
                  Attachments {task.files?.length ? `(${task.files.length})` : ''}
                </h4>
                {canUpload && (
                  <>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-lg"
                      style={{
                        background: 'var(--mt-bg-raised)',
                        color: 'var(--mt-text-secondary)',
                        border: '1px solid var(--mt-border-strong)',
                      }}
                    >
                      <Upload size={11} /> Upload
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={e => { props.onUpload(e.target.files); e.target.value = ''; }}
                    />
                  </>
                )}
              </div>
              {canUpload && (
                <div
                  onDragOver={e => { e.preventDefault(); setDragActive(true); }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                  className="p-3 mb-2 text-center text-xs transition-colors"
                  style={{
                    borderRadius: 10,
                    border: `2px dashed ${dragActive ? 'var(--mt-accent-border)' : 'var(--mt-border-strong)'}`,
                    background: dragActive ? 'var(--mt-accent-soft)' : 'transparent',
                    color: dragActive ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                  }}
                >
                  Drag &amp; drop files here, or click Upload. Allowed: xlsx, xls, csv, pdf, png, jpg, docx. Max 25 MB / file.
                </div>
              )}
              {task.files && task.files.length > 0 ? (
                <ul className="space-y-1">
                  {task.files.map(f => (
                    <li
                      key={f.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
                      style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
                    >
                      <FileText size={13} style={{ color: 'var(--mt-accent-text)' }} />
                      <span className="text-xs truncate flex-1" style={{ color: 'var(--mt-text-primary)' }}>{f.original_name}</span>
                      <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>{fmtBytes(f.size_bytes)}</span>
                      {f.uploaded_by_name && <span className="text-[10px] hidden md:inline" style={{ color: 'var(--mt-text-muted)' }}>· {f.uploaded_by_name}</span>}
                      <button
                        onClick={() => props.onDownloadFile(f.id, f.original_name)}
                        className="p-1 rounded"
                        style={{ color: 'var(--mt-text-faint)' }}
                        title="Download"
                      >
                        <Download size={12} />
                      </button>
                      {(canAdmin || (currentUserId && f.uploaded_by_user_id === currentUserId)) && (
                        <button
                          onClick={() => props.onDeleteFile(f.id)}
                          className="p-1 rounded"
                          style={{ color: 'var(--mt-danger-text)' }}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs italic" style={{ color: 'var(--mt-text-faint)' }}>No attachments yet.</p>
              )}
            </div>

            {/* Events timeline */}
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--mt-text-faint)' }}>
                Activity {task.events?.length ? `(${task.events.length})` : ''}
              </h4>
              {task.events && task.events.length > 0 ? (
                <ol className="space-y-1.5">
                  {task.events.map(ev => (
                    <li key={ev.id} className="flex items-start gap-2 text-xs">
                      <span className="w-1.5 h-1.5 mt-1.5 rounded-full shrink-0" style={{ background: 'var(--mt-accent)' }} />
                      <div className="flex-1">
                        <div style={{ color: 'var(--mt-text-primary)' }}>
                          <span className="font-medium capitalize">{ev.event_type.replace(/_/g, ' ')}</span>
                          {ev.from_status && ev.to_status && (
                            <span style={{ color: 'var(--mt-text-faint)' }}> · {ev.from_status} → {ev.to_status}</span>
                          )}
                          {ev.actor_name && (
                            <span style={{ color: 'var(--mt-text-muted)' }}> · by {ev.actor_name}</span>
                          )}
                        </div>
                        {ev.note && <div className="italic" style={{ color: 'var(--mt-text-muted)' }}>{ev.note}</div>}
                        <div className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>{fmtDateTime(ev.created_at)}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs italic" style={{ color: 'var(--mt-text-faint)' }}>No events recorded yet.</p>
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
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>{label}</div>
      <div className="text-sm" style={{ color: 'var(--mt-text-primary)' }}>{value}</div>
    </div>
  );
}

function ActionButton({
  icon, label, onClick, tone, primary,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone: 'neutral' | 'warn' | 'info' | 'success' | 'danger' | 'danger-muted';
  primary?: boolean;
}) {
  if (primary && tone === 'success') {
    return (
      <button onClick={onClick} className="mt-btn-gradient" type="button">
        {icon} {label}
      </button>
    );
  }
  const toneStyle: Record<string, { bg: string; color: string; border: string; hover: string }> = {
    neutral:       { bg: 'var(--mt-bg-raised)',   color: 'var(--mt-text-secondary)', border: 'var(--mt-border-strong)', hover: 'var(--mt-bg-muted)' },
    warn:          { bg: 'var(--mt-warn-soft)',   color: 'var(--mt-warn-text)',      border: 'var(--mt-warn-border)',   hover: 'var(--mt-warn-soft)' },
    info:          { bg: 'var(--mt-info-soft)',   color: 'var(--mt-info-text)',      border: 'var(--mt-info-border)',   hover: 'var(--mt-info-soft)' },
    success:       { bg: 'var(--mt-accent-soft)', color: 'var(--mt-accent-text)',    border: 'var(--mt-accent-border)', hover: 'var(--mt-accent-soft)' },
    danger:        { bg: 'var(--mt-danger-soft)', color: 'var(--mt-danger-text)',    border: 'var(--mt-danger-border)', hover: 'var(--mt-danger-soft)' },
    'danger-muted':{ bg: 'transparent',           color: 'var(--mt-danger-text)',    border: 'var(--mt-danger-border)', hover: 'var(--mt-danger-soft)' },
  };
  const t = toneStyle[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg"
      style={{ background: t.bg, color: t.color, border: `1px solid ${t.border}` }}
    >
      {icon} {label}
    </button>
  );
}
