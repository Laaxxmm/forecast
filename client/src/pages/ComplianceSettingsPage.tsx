// Compliance service registry — the "which services do we file for this
// client?" page. Each row is a service (GST, TDS, PF, …). Toggling a service
// on opens an inline config block; saving persists the registration details
// AND spawns the first batch of tracker rows in /vcfo/compliances via the
// service→catalog mapping on the server. Toggling off soft-cancels pending
// tracker rows (status='cancelled') — filed history is kept.
//
// Scope comes from the sidebar. With a branch picked we show:
//   - state-scope services for that branch's state (GST, TDS, PT, MCA, IT, Advance Tax)
//   - branch-scope services for that branch (PF, ESI, licences, LWF, manual)
// With no branch picked we show every configured service across scopes —
// read-only in that mode (enabling requires a scope).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Building2, CheckCircle2, ChevronDown, ChevronRight, Globe2,
  Save, Settings as SettingsIcon, Zap, Loader2,
} from 'lucide-react';
import api from '../api/client';

interface ServiceDef {
  key: string;
  name: string;
  category: string;
  scope: 'state' | 'branch';
  hasPreference?: boolean;
  preferenceOptions?: string[];
  defaultPreference?: string;
  description?: string;
}

interface ServiceRow {
  id: number;
  service_key: string;
  scope_type: 'state' | 'branch';
  state: string | null;
  branch_id: number;
  enabled: 0 | 1;
  registration_no: string | null;
  registration_date: string | null;
  reg_type: string | null;
  status_label: string | null;
  preference: string | null;
  assignee: string | null;
  reviewer: string | null;
  frequency_override: string | null;
  start_day: number | null;
  end_day: number | null;
  amount: number | null;
  notes: string | null;
}

interface Branch {
  id: number;
  name: string;
  code?: string | null;
  city?: string | null;
  state?: string | null;
}

type Scope = { branchId: number | null; branchName?: string; state?: string };

// Tone helpers
type Tone = { fg: string; soft: string; border: string };
const tone = (hex: string): Tone => ({
  fg: hex,
  soft: `color-mix(in srgb, ${hex} 14%, transparent)`,
  border: `color-mix(in srgb, ${hex} 32%, transparent)`,
});

const CATEGORY_TONE: Record<string, Tone> = {
  GST:     tone('#6366f1'), // indigo
  MCA:     tone('#8b5cf6'), // purple
  TDS:     tone('#0ea5e9'), // sky
  Labour:  tone('#f43f5e'), // rose
  Licence: tone('#14b8a6'), // teal
  IT:      tone('#f59e0b'), // amber
  Other:   tone('#71717a'), // zinc
};

export default function ComplianceSettingsPage() {
  const [defs, setDefs] = useState<ServiceDef[]>([]);
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [scope, setScope] = useState<Scope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const sidebarBranchId = (() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('branch_id') : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isNaN(n) ? null : n;
  })();

  const reload = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.get('/vcfo/compliance-services/definitions').then(r => r.data as ServiceDef[]),
      api.get('/vcfo/compliance-services').then(r => r.data as { scope: Scope | null; rows: ServiceRow[] }),
      api.get('/vcfo/compliances/branches').then(r => r.data as Branch[]),
    ])
      .then(([d, list, bs]) => {
        setDefs(d);
        setRows(list.rows);
        setScope(list.scope);
        setBranches(bs);
        setLoading(false);
      })
      .catch(err => {
        setError(err?.response?.data?.error || err?.message || 'Failed to load');
        setLoading(false);
      });
  };
  useEffect(reload, [sidebarBranchId]);

  const sidebarBranch = sidebarBranchId != null ? branches.find(b => b.id === sidebarBranchId) || null : null;
  const scopeReadOnly = sidebarBranchId == null;

  const visibleDefs = useMemo(() => {
    if (scopeReadOnly) return defs;
    if (!sidebarBranch) return [];
    return defs;
  }, [defs, scopeReadOnly, sidebarBranch]);

  const rowFor = (def: ServiceDef): ServiceRow | null => {
    if (scopeReadOnly) {
      return rows.find(r => r.service_key === def.key) || null;
    }
    if (!sidebarBranch) return null;
    if (def.scope === 'state') {
      const st = (sidebarBranch.state || '').toUpperCase();
      return rows.find(r => r.service_key === def.key && r.scope_type === 'state' && (r.state || '') === st) || null;
    }
    return rows.find(r => r.service_key === def.key && r.scope_type === 'branch' && r.branch_id === sidebarBranch.id) || null;
  };

  const scopeLabel = (def: ServiceDef): string => {
    if (!sidebarBranch) return def.scope === 'state' ? 'per state' : 'per branch';
    if (def.scope === 'state') return `State · ${sidebarBranch.state || '—'}`;
    return `Branch · ${sidebarBranch.name}`;
  };

  return (
    <div className="compliance-settings animate-fade-in">
      {/* Top bar */}
      <div
        className="-mx-4 -mt-4 px-4 md:-mx-8 md:-mt-8 md:px-8 py-3 mb-4"
        style={{
          background: 'var(--mt-bg-raised)',
          borderBottom: '1px solid var(--mt-border)',
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link
              to="/vcfo/compliances"
              className="flex items-center gap-1 text-xs transition-colors"
              style={{ color: 'var(--mt-text-muted)' }}
            >
              <ArrowLeft size={14} />
              Compliances
            </Link>
            <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>/</span>
            <SettingsIcon size={16} style={{ color: 'var(--mt-accent)' }} />
            <h1 className="mt-heading text-sm md:text-base" style={{ color: 'var(--mt-text-heading)' }}>
              Service Settings
            </h1>
            <span
              className="text-[11px] ml-1 px-2 py-0.5 rounded-lg"
              style={{
                color: 'var(--mt-text-muted)',
                background: 'var(--mt-bg-muted)',
                border: '1px solid var(--mt-border)',
              }}
            >
              {scopeReadOnly
                ? 'All branches (pick a branch to enable)'
                : sidebarBranch
                  ? `${sidebarBranch.name}${sidebarBranch.state ? ` · ${sidebarBranch.state}` : ''}`
                  : 'Selected branch'}
            </span>
          </div>
          {flash && (
            <span className="mt-pill mt-pill--success flex items-center gap-1">
              <CheckCircle2 size={12} />
              {flash}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="mt-card p-10 text-center">
          <p style={{ color: 'var(--mt-text-muted)' }}>Loading…</p>
        </div>
      ) : error ? (
        <div
          className="rounded-2xl p-10 text-center"
          style={{
            background: 'var(--mt-bg-raised)',
            border: '1px solid color-mix(in srgb, #ef4444 30%, transparent)',
          }}
        >
          <p className="font-medium" style={{ color: 'var(--mt-danger-text)' }}>{error}</p>
        </div>
      ) : (
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: 'var(--mt-bg-raised)',
            border: '1px solid var(--mt-border)',
            boxShadow: 'var(--mt-shadow-card)',
          }}
        >
          <div
            className="grid grid-cols-[48px_1.6fr_120px_1fr_100px] items-center px-4 py-2.5 text-[10px] uppercase tracking-wider font-medium"
            style={{
              borderBottom: '1px solid var(--mt-border)',
              background: 'var(--mt-bg-subtle)',
              color: 'var(--mt-text-faint)',
            }}
          >
            <div></div>
            <div>Service</div>
            <div>Category</div>
            <div>Details</div>
            <div className="text-right">Scope</div>
          </div>
          {visibleDefs.map(def => {
            const row = rowFor(def);
            const isOn = row?.enabled === 1;
            const isOpen = expandedKey === def.key;
            return (
              <ServiceRowBlock
                key={def.key}
                def={def}
                row={row}
                isOn={isOn}
                isOpen={isOpen}
                scopeReadOnly={scopeReadOnly}
                sidebarBranch={sidebarBranch || null}
                busyKey={busyKey}
                scopeLabel={scopeLabel(def)}
                onToggleExpand={() => setExpandedKey(isOpen ? null : def.key)}
                onCollapse={() => setExpandedKey(null)}
                onEnableStart={() => setExpandedKey(def.key)}
                onDisable={() => disableService(def, row)}
                onSaved={next => {
                  setExpandedKey(null);
                  setFlash(next);
                  setTimeout(() => setFlash(null), 2500);
                  reload();
                }}
                setBusy={b => setBusyKey(b ? def.key : null)}
              />
            );
          })}
        </div>
      )}
    </div>
  );

  async function disableService(def: ServiceDef, row: ServiceRow | null) {
    if (!row) return;
    if (!confirm(
      `Disable ${def.name}? Any pending tracker rows for this scope will be cancelled (filed history is kept). You can re-enable later.`,
    )) return;
    try {
      setBusyKey(def.key);
      const { data } = await api.post('/vcfo/compliance-services/disable', {
        serviceKey: def.key,
        scope: {
          branchId: row.branch_id,
          state: row.state,
        },
      });
      setFlash(`${def.name} disabled — ${data?.cancelled ?? 0} pending tracker rows cancelled.`);
      setTimeout(() => setFlash(null), 2500);
      reload();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to disable');
    } finally {
      setBusyKey(null);
    }
  }
}

interface ServiceRowBlockProps {
  def: ServiceDef;
  row: ServiceRow | null;
  isOn: boolean;
  isOpen: boolean;
  scopeReadOnly: boolean;
  sidebarBranch: Branch | null;
  busyKey: string | null;
  scopeLabel: string;
  onToggleExpand: () => void;
  onCollapse: () => void;
  onEnableStart: () => void;
  onDisable: () => void;
  onSaved: (msg: string) => void;
  setBusy: (b: boolean) => void;
}

function ServiceRowBlock({
  def, row, isOn, isOpen, scopeReadOnly, sidebarBranch, busyKey, scopeLabel,
  onToggleExpand, onCollapse, onEnableStart, onDisable, onSaved, setBusy,
}: ServiceRowBlockProps) {
  const [hoverTitle, setHoverTitle] = useState(false);
  const categoryTone = CATEGORY_TONE[def.category] || CATEGORY_TONE.Other;

  return (
    <div
      className="transition-colors"
      style={{
        borderBottom: '1px solid var(--mt-border)',
        background: isOpen ? 'var(--mt-bg-subtle)' : 'transparent',
      }}
    >
      <div className="grid grid-cols-[48px_1.6fr_120px_1fr_100px] items-center px-4 py-3 gap-2">
        <div className="flex items-center">
          <Toggle
            on={isOn}
            disabled={scopeReadOnly || busyKey === def.key}
            onChange={next => {
              if (next) onEnableStart();
              else onDisable();
            }}
          />
        </div>
        <div className="min-w-0">
          <button
            onClick={onToggleExpand}
            onMouseEnter={() => setHoverTitle(true)}
            onMouseLeave={() => setHoverTitle(false)}
            className="flex items-center gap-1.5 text-left w-full"
          >
            {isOpen
              ? <ChevronDown size={14} style={{ color: 'var(--mt-text-faint)' }} />
              : <ChevronRight size={14} style={{ color: 'var(--mt-text-faint)' }} />}
            <span
              className="text-sm font-medium transition-colors"
              style={{
                color: hoverTitle ? 'var(--mt-accent-text)' : 'var(--mt-text-heading)',
              }}
            >
              {def.name}
            </span>
            {isOn && (
              <CheckCircle2 size={12} style={{ color: 'var(--mt-accent)' }} className="shrink-0" />
            )}
          </button>
          {def.description && (
            <p
              className="text-[11px] ml-5 mt-0.5 truncate"
              style={{ color: 'var(--mt-text-faint)' }}
            >
              {def.description}
            </p>
          )}
        </div>
        <div>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
            style={{
              background: categoryTone.soft,
              color: categoryTone.fg,
              border: `1px solid ${categoryTone.border}`,
            }}
          >
            {def.category}
          </span>
        </div>
        <div className="min-w-0 text-xs" style={{ color: 'var(--mt-text-muted)' }}>
          {row?.registration_no ? (
            <DetailsInline row={row} def={def} />
          ) : (
            <span className="italic" style={{ color: 'var(--mt-text-faint)' }}>Not registered</span>
          )}
        </div>
        <div className="text-right">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
            style={{
              background: 'var(--mt-bg-muted)',
              color: 'var(--mt-text-faint)',
              border: '1px solid var(--mt-border)',
            }}
          >
            {def.scope === 'state' ? <Globe2 size={10} /> : <Building2 size={10} />}
            {scopeLabel}
          </span>
        </div>
      </div>
      {isOpen && (
        <ConfigPanel
          def={def}
          row={row}
          scopeReadOnly={scopeReadOnly}
          sidebarBranch={sidebarBranch}
          onCancel={onCollapse}
          onSaved={onSaved}
          busy={busyKey === def.key}
          setBusy={setBusy}
        />
      )}
    </div>
  );
}

function DetailsInline({ row, def }: { row: ServiceRow; def: ServiceDef }) {
  const bits: string[] = [];
  if (row.registration_no) bits.push(row.registration_no);
  if (row.reg_type) bits.push(row.reg_type);
  if (row.preference) bits.push(cap(row.preference));
  if (row.registration_date) bits.push(`Since ${formatShortDate(row.registration_date)}`);
  if (def.hasPreference && !row.preference) bits.push('— pref not set');
  return <span className="truncate block">{bits.join(' · ')}</span>;
}

function Toggle({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="relative w-9 h-5 rounded-full transition-colors"
      style={{
        background: on ? 'var(--mt-accent)' : 'var(--mt-bg-muted)',
        border: `1px solid ${on ? 'var(--mt-accent-border)' : 'var(--mt-border)'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform"
        style={{
          background: '#ffffff',
          boxShadow: '0 1px 3px rgba(15,23,42,0.25)',
          transform: on ? 'translateX(16px)' : 'translateX(0)',
        }}
      />
    </button>
  );
}

interface ConfigPanelProps {
  def: ServiceDef;
  row: ServiceRow | null;
  scopeReadOnly: boolean;
  sidebarBranch: Branch | null;
  onCancel: () => void;
  onSaved: (msg: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}

function ConfigPanel({ def, row, scopeReadOnly, sidebarBranch, onCancel, onSaved, busy, setBusy }: ConfigPanelProps) {
  const [registrationNo, setRegistrationNo] = useState(row?.registration_no || '');
  const [registrationDate, setRegistrationDate] = useState(row?.registration_date || '');
  const [regType, setRegType] = useState(row?.reg_type || (def.key === 'gst' ? 'Regular' : ''));
  const [statusLabel, setStatusLabel] = useState(row?.status_label || 'Active');
  const [preference, setPreference] = useState(row?.preference || def.defaultPreference || '');
  const [assignee, setAssignee] = useState(row?.assignee || '');
  const [reviewer, setReviewer] = useState(row?.reviewer || '');
  const [amount, setAmount] = useState<string>(row?.amount != null ? String(row.amount) : '');
  const [notes, setNotes] = useState(row?.notes || '');

  const disabledSubmit = scopeReadOnly || !sidebarBranch || busy;

  const submit = async (enable: boolean) => {
    if (!sidebarBranch) {
      alert('Pick a branch from the sidebar first to configure services.');
      return;
    }
    const scope = {
      branchId: sidebarBranch.id,
      state: def.scope === 'state' ? (sidebarBranch.state || null) : null,
    };
    const config = {
      registrationNo: registrationNo.trim() || null,
      registrationDate: registrationDate || null,
      regType: regType.trim() || null,
      statusLabel: statusLabel.trim() || null,
      preference: def.hasPreference ? (preference || null) : null,
      assignee: assignee.trim() || null,
      reviewer: reviewer.trim() || null,
      amount: amount.trim() ? Number(amount) : null,
      notes: notes.trim() || null,
    };
    try {
      setBusy(true);
      if (enable) {
        const { data } = await api.post('/vcfo/compliance-services/enable', {
          serviceKey: def.key,
          scope,
          config,
        });
        onSaved(`${def.name} enabled — ${data?.spawned ?? 0} tracker row(s) created.`);
      } else {
        await api.put('/vcfo/compliance-services', {
          serviceKey: def.key,
          scope,
          config,
        });
        onSaved(`${def.name} settings saved.`);
      }
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="px-4 pb-4 pt-1"
      style={{ borderTop: '1px solid var(--mt-border)' }}
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        <Field label={
          def.key === 'gst' ? 'GSTIN'
          : def.key === 'tds' ? 'TAN'
          : def.key === 'pf' ? 'PF Establishment Code'
          : def.key === 'esi' ? 'ESI Code'
          : 'Registration No.'
        }>
          <input
            className="mt-input text-xs"
            style={{ padding: '6px 10px' }}
            value={registrationNo}
            onChange={e => setRegistrationNo(e.target.value)}
            placeholder="—"
          />
        </Field>
        <Field label="Date of Registration">
          <input
            type="date"
            className="mt-input text-xs"
            style={{ padding: '6px 10px' }}
            value={registrationDate}
            onChange={e => setRegistrationDate(e.target.value)}
          />
        </Field>
        <Field label="Type">
          <input
            className="mt-input text-xs"
            style={{ padding: '6px 10px' }}
            value={regType}
            onChange={e => setRegType(e.target.value)}
            placeholder={def.key === 'gst' ? 'Regular / Composition' : '—'}
          />
        </Field>
        <Field label="Status">
          <select
            className="mt-input text-xs"
            style={{ padding: '6px 10px' }}
            value={statusLabel}
            onChange={e => setStatusLabel(e.target.value)}
          >
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Cancelled">Cancelled</option>
          </select>
        </Field>
        {def.hasPreference && (
          <Field label="Filing Preference">
            <select
              className="mt-input text-xs"
              style={{ padding: '6px 10px' }}
              value={preference}
              onChange={e => setPreference(e.target.value)}
            >
              <option value="">—</option>
              {def.preferenceOptions?.map(p => (
                <option key={p} value={p}>{cap(p)}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Assignee">
          <input
            className="mt-input text-xs"
            style={{ padding: '6px 10px' }}
            value={assignee}
            onChange={e => setAssignee(e.target.value)}
          />
        </Field>
        <Field label="Reviewer">
          <input
            className="mt-input text-xs"
            style={{ padding: '6px 10px' }}
            value={reviewer}
            onChange={e => setReviewer(e.target.value)}
          />
        </Field>
        <Field label="Typical Fee / Amount (₹)">
          <input
            type="number"
            className="mt-input text-xs"
            style={{ padding: '6px 10px' }}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="optional"
          />
        </Field>
        <Field label="Notes" full>
          <textarea
            rows={2}
            className="mt-input text-xs"
            style={{ padding: '6px 10px' }}
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
        <p className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
          {row?.enabled === 1
            ? 'This service is active. Saving updates settings without touching existing trackers.'
            : 'Enabling will create the recurring tracker rows for this service. '}
          {def.description}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="mt-btn-ghost text-xs"
            style={{ padding: '6px 12px' }}
          >
            Cancel
          </button>
          {row?.enabled === 1 ? (
            <button
              onClick={() => submit(false)}
              disabled={disabledSubmit}
              className="mt-btn-soft text-xs"
              style={{ padding: '6px 12px' }}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save settings
            </button>
          ) : (
            <button
              onClick={() => submit(true)}
              disabled={disabledSubmit}
              className="mt-btn-gradient text-xs"
              style={{ padding: '6px 12px' }}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              Enable & create trackers
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={full ? 'md:col-span-3' : ''}>
      <label
        className="block text-[10px] uppercase tracking-wider font-medium mb-1"
        style={{ color: 'var(--mt-text-faint)' }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatShortDate(d: string): string {
  const [y, m, day] = d.split('-');
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y.slice(2)}`;
}
