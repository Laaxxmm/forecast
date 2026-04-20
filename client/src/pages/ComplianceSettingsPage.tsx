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

const CATEGORY_CHIP: Record<string, string> = {
  GST: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  MCA: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
  TDS: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  Labour: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  Licence: 'bg-teal-500/10 text-teal-300 border-teal-500/20',
  IT: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  Other: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20',
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
    // With a branch picked, show all services — state-scope ones are
    // implicitly tied to the branch's state; branch-scope ones to the branch.
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
      <div className="bg-dark-800 border-b border-dark-400/30 -mx-4 -mt-4 px-4 md:-mx-8 md:-mt-8 md:px-8 py-3 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link
              to="/vcfo/compliances"
              className="flex items-center gap-1 text-xs text-theme-faint hover:text-theme-secondary transition-colors"
            >
              <ArrowLeft size={14} />
              Compliances
            </Link>
            <span className="text-theme-faint text-xs">/</span>
            <SettingsIcon size={16} className="text-accent-400" />
            <h1 className="text-sm md:text-base font-semibold text-theme-heading">Service Settings</h1>
            <span className="text-[11px] text-theme-faint ml-1 px-2 py-0.5 bg-dark-700 rounded-lg">
              {scopeReadOnly
                ? 'All branches (pick a branch to enable)'
                : sidebarBranch
                  ? `${sidebarBranch.name}${sidebarBranch.state ? ` · ${sidebarBranch.state}` : ''}`
                  : 'Selected branch'}
            </span>
          </div>
          {flash && (
            <span className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2 py-1 flex items-center gap-1">
              <CheckCircle2 size={12} />
              {flash}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-10 text-center">
          <p className="text-theme-muted">Loading…</p>
        </div>
      ) : error ? (
        <div className="bg-dark-800 border border-red-500/30 rounded-2xl p-10 text-center">
          <p className="text-red-400 font-medium">{error}</p>
        </div>
      ) : (
        <div className="bg-dark-800 border border-dark-400/30 rounded-2xl overflow-hidden">
          <div className="grid grid-cols-[48px_1.6fr_120px_1fr_100px] items-center px-4 py-2.5 border-b border-dark-400/30 bg-dark-700/40 text-[10px] uppercase tracking-wider text-theme-faint font-medium">
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
              <div key={def.key} className={`border-b border-dark-400/20 last:border-b-0 transition-colors ${isOpen ? 'bg-dark-700/30' : ''}`}>
                <div className="grid grid-cols-[48px_1.6fr_120px_1fr_100px] items-center px-4 py-3 gap-2">
                  <div className="flex items-center">
                    <Toggle
                      on={isOn}
                      disabled={scopeReadOnly || busyKey === def.key}
                      onChange={next => {
                        if (next) {
                          setExpandedKey(def.key);
                        } else {
                          disableService(def, row);
                        }
                      }}
                    />
                  </div>
                  <div className="min-w-0">
                    <button
                      onClick={() => setExpandedKey(isOpen ? null : def.key)}
                      className="flex items-center gap-1.5 text-left w-full group"
                    >
                      {isOpen ? <ChevronDown size={14} className="text-theme-faint" /> : <ChevronRight size={14} className="text-theme-faint" />}
                      <span className="text-sm font-medium text-theme-heading group-hover:text-accent-300 transition-colors">{def.name}</span>
                      {isOn && <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />}
                    </button>
                    {def.description && (
                      <p className="text-[11px] text-theme-faint ml-5 mt-0.5 truncate">{def.description}</p>
                    )}
                  </div>
                  <div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${CATEGORY_CHIP[def.category] || CATEGORY_CHIP.Other}`}>
                      {def.category}
                    </span>
                  </div>
                  <div className="min-w-0 text-xs text-theme-muted">
                    {row?.registration_no ? (
                      <DetailsInline row={row} def={def} />
                    ) : (
                      <span className="text-theme-faint italic">Not registered</span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-700 text-theme-faint border border-dark-400/40 inline-flex items-center gap-1">
                      {def.scope === 'state' ? <Globe2 size={10} /> : <Building2 size={10} />}
                      {scopeLabel(def)}
                    </span>
                  </div>
                </div>
                {isOpen && (
                  <ConfigPanel
                    def={def}
                    row={row}
                    scopeReadOnly={scopeReadOnly}
                    sidebarBranch={sidebarBranch || null}
                    onCancel={() => setExpandedKey(null)}
                    onSaved={next => {
                      setExpandedKey(null);
                      setFlash(next);
                      setTimeout(() => setFlash(null), 2500);
                      reload();
                    }}
                    busy={busyKey === def.key}
                    setBusy={b => setBusyKey(b ? def.key : null)}
                  />
                )}
              </div>
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
      className={`relative w-9 h-5 rounded-full transition-colors ${on ? 'bg-emerald-500/80' : 'bg-dark-600 border border-dark-400/50'} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-md transition-transform ${on ? 'translate-x-4' : ''}`}
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
    <div className="px-4 pb-4 pt-1 border-t border-dark-400/20">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        <Field label={def.key === 'gst' ? 'GSTIN' : def.key === 'tds' ? 'TAN' : def.key === 'pf' ? 'PF Establishment Code' : def.key === 'esi' ? 'ESI Code' : 'Registration No.'}>
          <input
            className="input text-xs py-1.5 w-full"
            value={registrationNo}
            onChange={e => setRegistrationNo(e.target.value)}
            placeholder="—"
          />
        </Field>
        <Field label="Date of Registration">
          <input
            type="date"
            className="input text-xs py-1.5 w-full"
            value={registrationDate}
            onChange={e => setRegistrationDate(e.target.value)}
          />
        </Field>
        <Field label="Type">
          <input
            className="input text-xs py-1.5 w-full"
            value={regType}
            onChange={e => setRegType(e.target.value)}
            placeholder={def.key === 'gst' ? 'Regular / Composition' : '—'}
          />
        </Field>
        <Field label="Status">
          <select
            className="input text-xs py-1.5 w-full"
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
              className="input text-xs py-1.5 w-full"
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
          <input className="input text-xs py-1.5 w-full" value={assignee} onChange={e => setAssignee(e.target.value)} />
        </Field>
        <Field label="Reviewer">
          <input className="input text-xs py-1.5 w-full" value={reviewer} onChange={e => setReviewer(e.target.value)} />
        </Field>
        <Field label="Typical Fee / Amount (₹)">
          <input
            type="number"
            className="input text-xs py-1.5 w-full"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="optional"
          />
        </Field>
        <Field label="Notes" full>
          <textarea
            rows={2}
            className="input text-xs py-1.5 w-full"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
        <p className="text-[11px] text-theme-faint">
          {row?.enabled === 1
            ? 'This service is active. Saving updates settings without touching existing trackers.'
            : 'Enabling will create the recurring tracker rows for this service. '}
          {def.description}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium text-theme-secondary bg-dark-700 border border-dark-400/50 hover:bg-dark-600 rounded-xl transition-colors"
          >
            Cancel
          </button>
          {row?.enabled === 1 ? (
            <button
              onClick={() => submit(false)}
              disabled={disabledSubmit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-500/15 text-accent-300 border border-accent-500/30 hover:bg-accent-500/25 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save settings
            </button>
          ) : (
            <button
              onClick={() => submit(true)}
              disabled={disabledSubmit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
      <label className="block text-[10px] uppercase tracking-wider text-theme-faint font-medium mb-1">{label}</label>
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
