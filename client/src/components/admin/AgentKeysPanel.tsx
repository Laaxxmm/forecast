// ─────────────────────────────────────────────────────────────────────────────
// AgentKeysPanel — Admin Portal tab for minting/listing/revoking sync-agent
// API keys, plus a Tally Cloud Access quick-start guide so operators can set
// up the Electron agent inside a TallyPrime Cloud Access VM without a support
// call.
//
// Backing endpoints (all in server/src/routes/auth.ts):
//   POST   /auth/agent-keys          → { apiKey, prefix, ... }   (shown once)
//   GET    /auth/agent-keys?clientSlug=...
//   DELETE /auth/agent-keys/:id       → soft-revoke
//
// Auth: super_admin only (server enforces). The panel is only rendered from
// AdminPage, which itself is SuperAdminRoute-gated.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import {
  KeyRound, Copy, Trash2, Plus, CheckCircle, AlertTriangle, Shield,
  Building2, Clock, ExternalLink, Monitor, Download, Server, Link as LinkIcon,
} from 'lucide-react';
import api from '../../api/client';

/* ─── Types ──────────────────────────────────────────────── */

interface Client {
  id: number;
  slug: string;
  name: string;
  is_active: number;
}

interface AgentKey {
  id: number;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/* ─── Tone helpers (mirrors AdminPage) ──────────────────── */

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
};

/* ─── Utils ──────────────────────────────────────────────── */

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(then).toLocaleDateString();
}

function serverUrlForInstall(): string {
  // Best-effort: what the user's browser thinks the backend is. The sync-agent
  // needs an HTTPS URL it can reach from inside the Tally Cloud VM, which is
  // almost always this exact origin minus the /api suffix.
  if (typeof window === 'undefined') return '';
  return `${window.location.protocol}//${window.location.host}`;
}

/* ═══════════════════════════════════════════════════════════
   MAIN PANEL
   ═══════════════════════════════════════════════════════════ */

export default function AgentKeysPanel() {
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [error, setError] = useState<string>('');
  const [newKey, setNewKey] = useState<{ plaintext: string; prefix: string; label: string } | null>(null);

  const selectedClient = clients.find(c => c.slug === selectedSlug) || null;

  // Load clients (super_admin → all active)
  useEffect(() => {
    api.get('/admin/clients')
      .then(r => {
        const active = (r.data || []).filter((c: Client) => c.is_active);
        setClients(active);
        if (active.length > 0) setSelectedSlug(active[0].slug);
      })
      .catch(e => setError(e.response?.data?.error || 'Failed to load clients'));
  }, []);

  const loadKeys = useCallback((slug: string) => {
    if (!slug) return;
    setLoadingKeys(true);
    setError('');
    api.get('/auth/agent-keys', { params: { clientSlug: slug } })
      .then(r => setKeys(r.data?.keys || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to load keys'))
      .finally(() => setLoadingKeys(false));
  }, []);

  useEffect(() => {
    if (selectedSlug) loadKeys(selectedSlug);
  }, [selectedSlug, loadKeys]);

  const handleGenerate = async (label: string) => {
    setError('');
    try {
      const res = await api.post('/auth/agent-keys', { clientSlug: selectedSlug, label });
      setNewKey({ plaintext: res.data.apiKey, prefix: res.data.prefix, label: res.data.label || label || '' });
      loadKeys(selectedSlug);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to mint key');
    }
  };

  const handleRevoke = async (id: number) => {
    if (!confirm('Revoke this agent key? The sync-agent using it will stop syncing immediately.')) return;
    try {
      await api.delete(`/auth/agent-keys/${id}`);
      loadKeys(selectedSlug);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to revoke key');
    }
  };

  return (
    <div className="space-y-6">
      <TallyCloudQuickStart selectedClient={selectedClient} serverUrl={serverUrlForInstall()} />

      {/* Client picker + generate */}
      <div className="mt-card p-5">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>
              Client
            </label>
            <select
              value={selectedSlug}
              onChange={e => setSelectedSlug(e.target.value)}
              className="mt-input text-sm w-full"
            >
              {clients.length === 0 && <option value="">No active clients</option>}
              {clients.map(c => (
                <option key={c.id} value={c.slug}>{c.name}  ({c.slug})</option>
              ))}
            </select>
          </div>
          <div className="flex-shrink-0">
            <GenerateKeyButton disabled={!selectedSlug} onGenerate={handleGenerate} />
          </div>
        </div>
        {error && (
          <p className="text-xs mt-3 flex items-center gap-1.5" style={{ color: TONES.danger.fg }}>
            <AlertTriangle size={12} /> {error}
          </p>
        )}
      </div>

      {/* One-time reveal modal */}
      {newKey && (
        <KeyRevealModal
          plaintext={newKey.plaintext}
          prefix={newKey.prefix}
          label={newKey.label}
          clientName={selectedClient?.name || selectedSlug}
          onClose={() => setNewKey(null)}
        />
      )}

      {/* Keys table */}
      <div className="mt-card">
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid var(--mt-border)' }}
        >
          <div>
            <h3 className="mt-heading text-sm flex items-center gap-2">
              <KeyRound size={14} style={{ color: TONES.accent.fg }} />
              Agent keys
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
              {selectedClient ? selectedClient.name : '—'}
              {keys.length > 0 && ` · ${keys.filter(k => !k.revokedAt).length} active`}
            </p>
          </div>
        </div>

        {loadingKeys ? (
          <p className="text-sm py-8 text-center" style={{ color: 'var(--mt-text-faint)' }}>
            Loading…
          </p>
        ) : keys.length === 0 ? (
          <div className="py-10 text-center">
            <KeyRound size={24} className="mx-auto mb-2" style={{ color: 'var(--mt-text-faint)' }} />
            <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>
              No keys yet. Click <span style={{ color: TONES.accent.fg }}>Generate key</span> to create the first one.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--mt-text-faint)', background: 'var(--mt-bg-muted)' }}>
                  <th className="text-left font-medium px-5 py-2.5 text-xs uppercase tracking-wider">Prefix</th>
                  <th className="text-left font-medium px-5 py-2.5 text-xs uppercase tracking-wider">Label</th>
                  <th className="text-left font-medium px-5 py-2.5 text-xs uppercase tracking-wider">Created</th>
                  <th className="text-left font-medium px-5 py-2.5 text-xs uppercase tracking-wider">Last used</th>
                  <th className="text-left font-medium px-5 py-2.5 text-xs uppercase tracking-wider">Status</th>
                  <th className="text-right font-medium px-5 py-2.5 text-xs uppercase tracking-wider"></th>
                </tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <KeyRow key={k.id} k={k} onRevoke={() => handleRevoke(k.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── KeyRow ─────────────────────────────────────────────── */

function KeyRow({ k, onRevoke }: { k: AgentKey; onRevoke: () => void }) {
  const [hover, setHover] = useState(false);
  const revoked = !!k.revokedAt;
  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover && !revoked ? 'var(--mt-bg-muted)' : 'transparent',
        opacity: revoked ? 0.55 : 1,
        borderTop: '1px solid var(--mt-border)',
      }}
    >
      <td className="px-5 py-3 font-mono text-xs" style={{ color: 'var(--mt-text)' }}>{k.prefix}…</td>
      <td className="px-5 py-3" style={{ color: 'var(--mt-text)' }}>{k.label || '—'}</td>
      <td className="px-5 py-3 text-xs" style={{ color: 'var(--mt-text-muted)' }}>{relativeTime(k.createdAt)}</td>
      <td className="px-5 py-3 text-xs" style={{ color: 'var(--mt-text-muted)' }}>
        {k.lastUsedAt ? (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} /> {relativeTime(k.lastUsedAt)}
          </span>
        ) : (
          <span style={{ color: 'var(--mt-text-faint)' }}>Never</span>
        )}
      </td>
      <td className="px-5 py-3">
        {revoked ? (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full"
            style={{ color: TONES.danger.fg, background: TONES.danger.soft }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: TONES.danger.fg }} />
            Revoked
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full"
            style={{ color: TONES.accent.fg, background: TONES.accent.soft }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: TONES.accent.fg }} />
            Active
          </span>
        )}
      </td>
      <td className="px-5 py-3 text-right">
        {!revoked && (
          <button
            onClick={onRevoke}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{
              color: TONES.danger.fg,
              border: `1px solid ${TONES.danger.border}`,
              background: 'transparent',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = TONES.danger.soft)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Trash2 size={12} /> Revoke
          </button>
        )}
      </td>
    </tr>
  );
}

/* ─── GenerateKeyButton (inline label form) ──────────────── */

function GenerateKeyButton({
  disabled, onGenerate,
}: {
  disabled: boolean;
  onGenerate: (label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="mt-btn-gradient text-sm inline-flex items-center gap-1.5"
      >
        <Plus size={14} /> Generate key
      </button>
    );
  }

  return (
    <div className="flex items-end gap-2">
      <div className="min-w-[220px]">
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>
          Label (optional)
        </label>
        <input
          autoFocus
          type="text"
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="e.g. Tally Cloud VM"
          className="mt-input text-sm"
          onKeyDown={e => {
            if (e.key === 'Enter') { onGenerate(label.trim()); setOpen(false); setLabel(''); }
            if (e.key === 'Escape') { setOpen(false); setLabel(''); }
          }}
        />
      </div>
      <button
        onClick={() => { onGenerate(label.trim()); setOpen(false); setLabel(''); }}
        className="mt-btn-gradient text-sm"
      >
        Generate
      </button>
      <button
        onClick={() => { setOpen(false); setLabel(''); }}
        className="mt-btn-soft text-sm"
      >
        Cancel
      </button>
    </div>
  );
}

/* ─── KeyRevealModal (shown once, after mint) ────────────── */

function KeyRevealModal({
  plaintext, prefix, label, clientName, onClose,
}: {
  plaintext: string;
  prefix: string;
  label: string;
  clientName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked — user can still select-copy from the textarea
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 px-4"
      style={{ background: 'color-mix(in srgb, #000 60%, transparent)' }}
    >
      <div
        className="mt-card w-full max-w-2xl p-6"
        style={{ background: 'var(--mt-bg-raised)', border: `1px solid ${TONES.accent.border}` }}
      >
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center"
            style={{ background: TONES.accent.soft, border: `1px solid ${TONES.accent.border}` }}
          >
            <CheckCircle size={18} style={{ color: TONES.accent.fg }} />
          </div>
          <div>
            <h3 className="mt-heading text-base">Agent key generated</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
              {clientName}
              {label ? ` · ${label}` : ''}
              {` · prefix ${prefix}`}
            </p>
          </div>
        </div>

        <div
          className="rounded-xl p-3 mb-3"
          style={{ background: 'var(--mt-bg-app)', border: '1px solid var(--mt-border)' }}
        >
          <textarea
            readOnly
            value={plaintext}
            onFocus={e => e.currentTarget.select()}
            className="w-full font-mono text-sm resize-none bg-transparent border-0 outline-none"
            rows={2}
            style={{ color: 'var(--mt-text)' }}
          />
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs flex items-center gap-1.5" style={{ color: TONES.amber.fg }}>
            <AlertTriangle size={12} /> This key is shown exactly once. Copy it now — we only store a hash.
          </p>
          <div className="flex gap-2">
            <button onClick={copy} className="mt-btn-soft text-sm inline-flex items-center gap-1.5">
              <Copy size={13} /> {copied ? 'Copied!' : 'Copy key'}
            </button>
            <button onClick={onClose} className="mt-btn-gradient text-sm">
              I've saved it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── TallyCloudQuickStart card ──────────────────────────── */
//
// Guides a super_admin through the exact Tally Cloud Access flow we validated:
//   1. Enable Tally XML port 9000 inside the VM
//   2. Install the sync-agent .exe inside the VM
//   3. Paste agent key + server URL
//   4. Map companies → (branch, stream)

function TallyCloudQuickStart({
  selectedClient, serverUrl,
}: {
  selectedClient: Client | null;
  serverUrl: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-card">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 transition-all"
        style={{ borderBottom: open ? '1px solid var(--mt-border)' : 'none' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{ background: TONES.blue.soft, border: `1px solid ${TONES.blue.border}` }}
          >
            <Server size={16} style={{ color: TONES.blue.fg }} />
          </div>
          <div className="text-left">
            <h3 className="mt-heading text-sm">Connect TallyPrime Cloud Access</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
              4-step setup for Tally running on a hosted Windows VM
            </p>
          </div>
        </div>
        <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      {open && (
        <div className="p-5 space-y-4">
          <Step
            n={1}
            title="Enable Tally's XML port (inside the Cloud VM)"
            body={
              <ul className="text-xs space-y-1 list-disc ml-4" style={{ color: 'var(--mt-text-muted)' }}>
                <li>RDP into your Tally Cloud Access VM and launch TallyPrime.</li>
                <li>Press <Kbd>F1</Kbd> → Settings → Connectivity → Client/Server configuration.</li>
                <li>Set <b>TallyPrime acts as: Both</b>, <b>Enable ODBC: Yes</b>, <b>Port: 9000</b>. Save with <Kbd>Ctrl</Kbd>+<Kbd>A</Kbd>.</li>
                <li>
                  Verify: open any browser in the VM → <Code>http://localhost:9000</Code> → you should see{' '}
                  <Code>&lt;RESPONSE&gt;TallyPrime Server is Running&lt;/RESPONSE&gt;</Code>.
                </li>
              </ul>
            }
          />
          <Step
            n={2}
            title="Generate an agent key for this client"
            body={
              <p className="text-xs" style={{ color: 'var(--mt-text-muted)' }}>
                Pick {selectedClient ? <b>{selectedClient.name}</b> : 'a client'} below and click <b>Generate key</b>. Copy the <Code>vcfo_live_…</Code> key — it is shown only once.
              </p>
            }
          />
          <Step
            n={3}
            title="Install the VCFO Sync Agent inside the Cloud VM"
            body={
              <ul className="text-xs space-y-1 list-disc ml-4" style={{ color: 'var(--mt-text-muted)' }}>
                <li>
                  Build the installer on your machine (one-time):{' '}
                  <Code>cd sync-agent &amp;&amp; npm install &amp;&amp; npm run dist</Code> → produces{' '}
                  <Code>sync-agent/release/VCFO Sync Setup 0.3.1.exe</Code>.
                </li>
                <li>
                  Copy the <Code>.exe</Code> into the Tally Cloud VM (the Cloud Access client maps your local drives — use <b>Disk (D:)</b> to drag it across).
                </li>
                <li>Run the installer inside the VM. The agent starts as a tray icon.</li>
              </ul>
            }
          />
          <Step
            n={4}
            title="Configure the agent"
            body={
              <div className="space-y-2">
                <ul className="text-xs space-y-1 list-disc ml-4" style={{ color: 'var(--mt-text-muted)' }}>
                  <li>Open the agent's tray icon → Settings.</li>
                  <li>Tally Host: <Code>localhost</Code> · Tally Port: <Code>9000</Code>.</li>
                  <li>Server URL: <Code>{serverUrl || 'https://your-magna-tracker-domain'}</Code></li>
                  <li>Paste the agent key from step 2 and click <b>Link client</b>.</li>
                  <li>Map each Tally company → (branch, stream) when prompted.</li>
                  <li>Kick off the first sync. Watch the <b>Last used</b> column below turn green.</li>
                </ul>
                <p className="text-xs flex items-start gap-1.5 pt-1" style={{ color: TONES.amber.fg }}>
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <span>
                    The agent only syncs while your Windows session inside the Cloud VM is alive. If Tally Cloud Access signs you out on idle, reconnect or ask Tally to keep the session warm.
                  </span>
                </p>
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
        style={{
          background: TONES.accent.soft,
          border: `1px solid ${TONES.accent.border}`,
          color: TONES.accent.fg,
        }}
      >
        {n}
      </div>
      <div className="flex-1">
        <h4 className="text-sm font-medium mb-1.5" style={{ color: 'var(--mt-text)' }}>{title}</h4>
        {body}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="px-1.5 py-0.5 rounded text-[10px] font-mono"
      style={{
        background: 'var(--mt-bg-muted)',
        border: '1px solid var(--mt-border)',
        color: 'var(--mt-text)',
      }}
    >
      {children}
    </kbd>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="px-1.5 py-0.5 rounded text-[11px] font-mono"
      style={{
        background: 'var(--mt-bg-muted)',
        border: '1px solid var(--mt-border)',
        color: 'var(--mt-text)',
      }}
    >
      {children}
    </code>
  );
}

// Currently unused imports are silenced at call-site; keep them here so a
// future revision that e.g. links to the agent download URL doesn't have to
// re-import.
void Monitor; void Download; void LinkIcon; void Building2; void ExternalLink; void Shield;
