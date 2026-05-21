// ─────────────────────────────────────────────────────────────────────────────
// ZohoBooksPanel — Admin tab to connect Zoho Books accounts (firm-wide or
// per-client), discover each login's organizations, map every org to a tenant
// company, and run syncs. Mirrors AgentKeysPanel's styling + conventions.
//
// Backing endpoints (server/src/routes/zoho.ts, super_admin only except the
// public OAuth callback):
//   GET    /zoho/config-status
//   GET    /zoho/connections            POST /zoho/connections   DELETE /zoho/connections/:id
//   POST   /zoho/connections/:id/authorize   → { authUrl }   (browser navigates there)
//   POST   /zoho/connections/:id/discover
//   GET    /zoho/connections/:id/orgs
//   PUT    /zoho/orgs/:id/target   PUT /zoho/orgs/:id/enabled   POST /zoho/orgs/:id/sync
//
// After consent, Zoho redirects to /api/zoho/oauth/callback which (on the
// server) 302s back to /admin?zoho=connected — this panel reads that query
// param to show a banner and refresh.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Trash2, RefreshCw, Link as LinkIcon, AlertTriangle, CheckCircle,
  Cloud, PlayCircle, ChevronRight, ChevronDown, Building2,
} from 'lucide-react';
import api from '../../api/client';

/* ─── Types ──────────────────────────────────────────────── */

interface Client { id: number; slug: string; name: string; is_active: number; }
interface ConfigStatus { configured: boolean; redirectUri: string | null; }
interface Connection {
  id: number; label: string; dc_region: string; scope: 'firm' | 'client';
  client_id: number | null; client_name: string | null;
  status: string; last_error: string | null;
  org_count: number; enabled_org_count: number;
}
interface OrgMapping {
  id: number; connection_id: number; zoho_org_id: string; zoho_org_name: string | null;
  base_currency: string | null; fiscal_year_start_month: number | null;
  target_client_id: number | null; target_company_name: string | null;
  is_enabled: number; last_synced_at: string | null; last_sync_status: string | null;
  target_client_name?: string | null;
}

/* ─── Tone helpers (mirrors AgentKeysPanel) ─────────────── */

type Tone = { fg: string; soft: string; border: string };
const tone = (hex: string): Tone => ({
  fg: hex,
  soft: `color-mix(in srgb, ${hex} 12%, transparent)`,
  border: `color-mix(in srgb, ${hex} 30%, transparent)`,
});
const TONES = {
  accent: tone('#10b981'),
  blue: tone('#3b82f6'),
  amber: tone('#f59e0b'),
  danger: tone('#ef4444'),
  muted: tone('#64748b'),
};

const REGIONS = [
  { value: 'in', label: 'India (zoho.in)' },
  { value: 'com', label: 'Global (zoho.com)' },
  { value: 'eu', label: 'Europe (zoho.eu)' },
  { value: 'com.au', label: 'Australia (zoho.com.au)' },
  { value: 'jp', label: 'Japan (zoho.jp)' },
];

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(then).toLocaleDateString();
}

function statusTone(status: string): Tone {
  if (status === 'connected') return TONES.accent;
  if (status === 'error') return TONES.danger;
  if (status === 'revoked') return TONES.muted;
  return TONES.amber; // pending
}

/* ═══════════════════════════════════════════════════════════
   MAIN PANEL
   ═══════════════════════════════════════════════════════════ */

export default function ZohoBooksPanel() {
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadConnections = useCallback(() => {
    return api.get('/zoho/connections')
      .then(r => setConnections(r.data?.connections || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to load connections'));
  }, []);

  useEffect(() => {
    // OAuth return banner (server 302s back to /admin?zoho=connected|error).
    const sp = new URLSearchParams(window.location.search);
    const z = sp.get('zoho');
    if (z === 'connected') setBanner({ kind: 'success', msg: 'Zoho account connected. Map its organizations to your clients below.' });
    else if (z === 'error') setBanner({ kind: 'error', msg: `Connection failed: ${sp.get('message') || 'unknown error'}` });
    if (z) {
      sp.delete('zoho'); sp.delete('message'); sp.delete('connection');
      const qs = sp.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }

    Promise.all([
      api.get('/zoho/config-status').then(r => setConfig(r.data)).catch(() => setConfig({ configured: false, redirectUri: null })),
      api.get('/admin/clients').then(r => setClients((r.data || []).filter((c: Client) => c.is_active))).catch(() => {}),
      loadConnections(),
    ]).finally(() => setLoading(false));
  }, [loadConnections]);

  return (
    <div className="space-y-6">
      {/* Intro / config status */}
      <div className="mt-card p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: TONES.blue.soft, border: `1px solid ${TONES.blue.border}` }}>
            <Cloud size={16} style={{ color: TONES.blue.fg }} />
          </div>
          <div className="flex-1">
            <h3 className="mt-heading text-sm">Zoho Books</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
              Connect a Zoho account (your firm's login covers many client orgs, or add a client's own login),
              map each organization to a company, and sync its books into the vCFO + Forecast modules.
            </p>
          </div>
        </div>

        {config && !config.configured && (
          <div className="mt-4 rounded-xl p-3 text-xs flex items-start gap-2"
            style={{ background: TONES.amber.soft, border: `1px solid ${TONES.amber.border}`, color: 'var(--mt-text-muted)' }}>
            <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" style={{ color: TONES.amber.fg }} />
            <span>
              The server is missing Zoho app credentials. Set <code className="font-mono">ZOHO_CLIENT_ID</code>,{' '}
              <code className="font-mono">ZOHO_CLIENT_SECRET</code> and <code className="font-mono">ZOHO_REDIRECT_URI</code>{' '}
              (the redirect URI must be <code className="font-mono">&lt;server&gt;/api/zoho/oauth/callback</code>) in the
              server environment, then reload.
            </span>
          </div>
        )}
      </div>

      {banner && (
        <div className="rounded-xl p-3 text-sm flex items-center gap-2"
          style={{
            background: (banner.kind === 'success' ? TONES.accent : TONES.danger).soft,
            border: `1px solid ${(banner.kind === 'success' ? TONES.accent : TONES.danger).border}`,
            color: (banner.kind === 'success' ? TONES.accent : TONES.danger).fg,
          }}>
          {banner.kind === 'success' ? <CheckCircle size={15} /> : <AlertTriangle size={15} />}
          {banner.msg}
          <button onClick={() => setBanner(null)} className="ml-auto text-xs opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {error && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: TONES.danger.fg }}>
          <AlertTriangle size={12} /> {error}
        </p>
      )}

      <NewConnectionForm clients={clients} disabled={!!config && !config.configured} onCreated={loadConnections} />

      {/* Connections */}
      {loading ? (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--mt-text-faint)' }}>Loading…</p>
      ) : connections.length === 0 ? (
        <div className="mt-card py-10 text-center">
          <Cloud size={24} className="mx-auto mb-2" style={{ color: 'var(--mt-text-faint)' }} />
          <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>
            No connections yet. Add one above, then click <span style={{ color: TONES.accent.fg }}>Connect</span> to authorize it with Zoho.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {connections.map(c => (
            <ConnectionCard key={c.id} connection={c} clients={clients} onChanged={loadConnections} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── New connection form ────────────────────────────────── */

function NewConnectionForm({
  clients, disabled, onCreated,
}: {
  clients: Client[];
  disabled: boolean;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [region, setRegion] = useState('in');
  const [scope, setScope] = useState<'firm' | 'client'>('firm');
  const [clientId, setClientId] = useState<string>('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!label.trim()) { setErr('Label is required'); return; }
    if (scope === 'client' && !clientId) { setErr('Pick a client for a client-scoped connection'); return; }
    setBusy(true); setErr('');
    try {
      await api.post('/zoho/connections', {
        label: label.trim(), region, scope,
        clientId: scope === 'client' ? Number(clientId) : undefined,
      });
      setLabel(''); setScope('firm'); setClientId(''); setRegion('in'); setOpen(false);
      onCreated();
    } catch (e: any) {
      setErr(e.response?.data?.error || 'Failed to create connection');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} disabled={disabled}
        className="mt-btn-gradient text-sm inline-flex items-center gap-1.5">
        <Plus size={14} /> Add connection
      </button>
    );
  }

  return (
    <div className="mt-card p-5 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Label</label>
          <input autoFocus value={label} onChange={e => setLabel(e.target.value)}
            placeholder="e.g. Firm Zoho account" className="mt-input text-sm w-full" />
        </div>
        <div className="min-w-[150px]">
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Region</label>
          <select value={region} onChange={e => setRegion(e.target.value)} className="mt-input text-sm w-full">
            {REGIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="min-w-[150px]">
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Scope</label>
          <select value={scope} onChange={e => setScope(e.target.value as 'firm' | 'client')} className="mt-input text-sm w-full">
            <option value="firm">Firm (many orgs)</option>
            <option value="client">Single client</option>
          </select>
        </div>
        {scope === 'client' && (
          <div className="min-w-[180px]">
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Client</label>
            <select value={clientId} onChange={e => setClientId(e.target.value)} className="mt-input text-sm w-full">
              <option value="">Select client…</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
      </div>
      {err && <p className="text-xs flex items-center gap-1.5" style={{ color: TONES.danger.fg }}><AlertTriangle size={12} /> {err}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy} className="mt-btn-gradient text-sm">{busy ? 'Saving…' : 'Create'}</button>
        <button onClick={() => { setOpen(false); setErr(''); }} className="mt-btn-soft text-sm">Cancel</button>
      </div>
    </div>
  );
}

/* ─── Connection card (with org mapping) ─────────────────── */

function ConnectionCard({
  connection, clients, onChanged,
}: {
  connection: Connection;
  clients: Client[];
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [orgs, setOrgs] = useState<OrgMapping[]>([]);
  const [loadingOrgs, setLoadingOrgs] = useState(false);
  const [busy, setBusy] = useState('');
  const st = statusTone(connection.status);

  const loadOrgs = useCallback(() => {
    setLoadingOrgs(true);
    api.get(`/zoho/connections/${connection.id}/orgs`)
      .then(r => setOrgs(r.data?.mappings || []))
      .finally(() => setLoadingOrgs(false));
  }, [connection.id]);

  useEffect(() => { if (expanded) loadOrgs(); }, [expanded, loadOrgs]);

  const connect = async () => {
    setBusy('connect');
    try {
      const r = await api.post(`/zoho/connections/${connection.id}/authorize`);
      if (r.data?.authUrl) window.location.href = r.data.authUrl;
    } catch (e: any) {
      alert(e.response?.data?.error || 'Failed to start authorization');
      setBusy('');
    }
  };

  const discover = async () => {
    setBusy('discover');
    try {
      await api.post(`/zoho/connections/${connection.id}/discover`);
      if (!expanded) setExpanded(true); else loadOrgs();
      onChanged();
    } catch (e: any) {
      alert(e.response?.data?.error || 'Discovery failed');
    } finally { setBusy(''); }
  };

  const remove = async () => {
    if (!confirm(`Delete connection "${connection.label}"? Its org mappings are removed (synced data stays).`)) return;
    setBusy('delete');
    try { await api.delete(`/zoho/connections/${connection.id}`); onChanged(); }
    catch (e: any) { alert(e.response?.data?.error || 'Delete failed'); setBusy(''); }
  };

  return (
    <div className="mt-card">
      <div className="flex items-center gap-3 px-5 py-4">
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 flex-1 text-left">
          {expanded ? <ChevronDown size={16} style={{ color: 'var(--mt-text-faint)' }} /> : <ChevronRight size={16} style={{ color: 'var(--mt-text-faint)' }} />}
          <div>
            <div className="flex items-center gap-2">
              <span className="mt-heading text-sm">{connection.label}</span>
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full"
                style={{ color: st.fg, background: st.soft }}>{connection.status}</span>
            </div>
            <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
              {connection.scope === 'client' ? `Client: ${connection.client_name || '—'}` : 'Firm account'}
              {` · zoho.${connection.dc_region}`}
              {` · ${connection.enabled_org_count}/${connection.org_count} orgs enabled`}
            </p>
            {connection.status === 'error' && connection.last_error && (
              <p className="text-xs mt-0.5" style={{ color: TONES.danger.fg }}>{connection.last_error}</p>
            )}
          </div>
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={connect} disabled={!!busy} className="mt-btn-gradient text-xs inline-flex items-center gap-1.5">
            <LinkIcon size={12} /> {connection.status === 'connected' ? 'Reconnect' : 'Connect'}
          </button>
          <button onClick={discover} disabled={!!busy || connection.status !== 'connected'}
            className="mt-btn-soft text-xs inline-flex items-center gap-1.5">
            <RefreshCw size={12} className={busy === 'discover' ? 'animate-spin' : ''} /> Discover orgs
          </button>
          <button onClick={remove} disabled={!!busy}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium"
            style={{ color: TONES.danger.fg, border: `1px solid ${TONES.danger.border}` }}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-5 pb-5" style={{ borderTop: '1px solid var(--mt-border)' }}>
          {loadingOrgs ? (
            <p className="text-sm py-6 text-center" style={{ color: 'var(--mt-text-faint)' }}>Loading organizations…</p>
          ) : orgs.length === 0 ? (
            <p className="text-sm py-6 text-center" style={{ color: 'var(--mt-text-faint)' }}>
              No organizations discovered yet. {connection.status === 'connected'
                ? 'Click “Discover orgs”.'
                : 'Connect this account first.'}
            </p>
          ) : (
            <div className="pt-4 space-y-2">
              {orgs.map(o => (
                <OrgRow key={o.id} org={o} clients={clients} onAfterChange={() => { loadOrgs(); onChanged(); }} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Org mapping row ────────────────────────────────────── */

function OrgRow({
  org, clients, onAfterChange,
}: {
  org: OrgMapping;
  clients: Client[];
  onAfterChange: () => void;
}) {
  const [clientId, setClientId] = useState<string>(org.target_client_id ? String(org.target_client_id) : '');
  const [companyName, setCompanyName] = useState<string>(org.target_company_name || org.zoho_org_name || '');
  const [enabled, setEnabled] = useState<boolean>(!!org.is_enabled);
  const [busy, setBusy] = useState('');
  const [syncMsg, setSyncMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const dirty = String(org.target_client_id || '') !== clientId
    || (org.target_company_name || '') !== companyName;

  const saveTarget = async () => {
    setBusy('save');
    try {
      await api.put(`/zoho/orgs/${org.id}/target`, {
        targetClientId: clientId ? Number(clientId) : null,
        targetCompanyName: companyName.trim() || null,
      });
      onAfterChange();
    } catch (e: any) {
      setSyncMsg({ kind: 'error', text: e.response?.data?.error || 'Save failed' });
    } finally { setBusy(''); }
  };

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    try { await api.put(`/zoho/orgs/${org.id}/enabled`, { enabled: next }); }
    catch { setEnabled(!next); }
  };

  const syncNow = async () => {
    setBusy('sync'); setSyncMsg(null);
    try {
      const r = await api.post(`/zoho/orgs/${org.id}/sync`);
      const res = r.data?.result;
      const warn = res?.warnings?.length ? ` · ${res.warnings.length} warning(s)` : '';
      setSyncMsg({ kind: 'success', text: `Synced ${res?.accounts ?? 0} accounts, ${res?.voucherLines ?? 0} entries, ${res?.tbRows ?? 0} TB rows${warn}` });
      onAfterChange();
    } catch (e: any) {
      setSyncMsg({ kind: 'error', text: e.response?.data?.error || 'Sync failed' });
    } finally { setBusy(''); }
  };

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--mt-bg-app)', border: '1px solid var(--mt-border)' }}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px]">
          <div className="flex items-center gap-1.5 mb-1">
            <Building2 size={12} style={{ color: 'var(--mt-text-faint)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{org.zoho_org_name || org.zoho_org_id}</span>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
            {org.base_currency || ''}{org.base_currency ? ' · ' : ''}org {org.zoho_org_id}
          </p>
        </div>

        <div className="min-w-[160px]">
          <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Target client</label>
          <select value={clientId} onChange={e => setClientId(e.target.value)} className="mt-input text-sm w-full">
            <option value="">Select…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div className="min-w-[160px] flex-1">
          <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Company name</label>
          <input value={companyName} onChange={e => setCompanyName(e.target.value)}
            placeholder="vCFO company name" className="mt-input text-sm w-full" />
        </div>

        <div className="flex items-center gap-2">
          {dirty && (
            <button onClick={saveTarget} disabled={!!busy} className="mt-btn-soft text-xs">
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          )}
          <button onClick={toggleEnabled}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium"
            style={{
              color: enabled ? TONES.accent.fg : 'var(--mt-text-faint)',
              background: enabled ? TONES.accent.soft : 'var(--mt-bg-muted)',
              border: `1px solid ${enabled ? TONES.accent.border : 'var(--mt-border)'}`,
            }}>
            {enabled ? 'Enabled' : 'Disabled'}
          </button>
          <button onClick={syncNow} disabled={!!busy || !clientId || !companyName.trim()}
            className="mt-btn-gradient text-xs inline-flex items-center gap-1.5">
            <PlayCircle size={13} className={busy === 'sync' ? 'animate-spin' : ''} /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
          Last sync: {relativeTime(org.last_synced_at)}{org.last_sync_status ? ` · ${org.last_sync_status}` : ''}
        </span>
        {syncMsg && (
          <span className="text-[11px] inline-flex items-center gap-1"
            style={{ color: syncMsg.kind === 'success' ? TONES.accent.fg : TONES.danger.fg }}>
            {syncMsg.kind === 'success' ? <CheckCircle size={11} /> : <AlertTriangle size={11} />} {syncMsg.text}
          </span>
        )}
      </div>
    </div>
  );
}
