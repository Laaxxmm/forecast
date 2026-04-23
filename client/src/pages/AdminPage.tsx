import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import {
  Building2, Users, UserPlus, Plus, Power, ArrowLeft,
  Eye, EyeOff, CheckCircle, Plug, Shield, Trash2, Copy, KeyRound, BarChart3,
  MapPin, GitBranch, Layers, Search, Activity, Globe, ChevronRight, ChevronDown,
  LayoutDashboard, Edit2, Calendar, Stethoscope, Upload, Server, BookOpen,
  ImagePlus,
} from 'lucide-react';
import AgentKeysPanel from '../components/admin/AgentKeysPanel';

/* ─── Types ──────────────────────────────────────────────── */

interface Client {
  id: number; slug: string; name: string; is_active: number;
  user_count: number; integrations: string | null; created_at: string;
}
interface ClientUser {
  id: number; username: string; display_name: string;
  role: string; is_active: number; created_at: string;
}
interface TeamMember {
  id: number; username: string; display_name: string;
  role: string; is_active: number; is_owner: number;
  assigned_client_count: number; created_at: string;
}
interface Integration {
  key: string; name: string; description: string; enabled: boolean; group?: string;
}

type Tab = 'clients' | 'team' | 'agent_keys';
type ClientDetailTab = 'users' | 'modules' | 'integrations' | 'streams' | 'dashboard_cards' | 'branches' | 'assigned_team';

/* ─── Tone helpers ───────────────────────────────────────── */

type Tone = { fg: string; soft: string; border: string };
const tone = (hex: string): Tone => ({
  fg: hex,
  soft: `color-mix(in srgb, ${hex} 12%, transparent)`,
  border: `color-mix(in srgb, ${hex} 30%, transparent)`,
});
const TONES: Record<string, Tone> = {
  accent: tone('#10b981'),
  blue: tone('#3b82f6'),
  purple: tone('#8b5cf6'),
  amber: tone('#f59e0b'),
  teal: tone('#14b8a6'),
  orange: tone('#f97316'),
  danger: tone('#ef4444'),
};

const STREAM_DOT: Record<string, string> = {
  blue: '#3b82f6',
  purple: '#8b5cf6',
  amber: '#f59e0b',
  accent: '#10b981',
};

/* ─── Main Page ──────────────────────────────────────────── */

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('clients');
  const isOwner = localStorage.getItem('is_owner') === '1';

  const tabs = [
    { key: 'clients' as Tab, label: 'Clients', icon: Building2 },
    ...(isOwner ? [{ key: 'team' as Tab, label: 'Team', icon: Shield }] : []),
    { key: 'agent_keys' as Tab, label: 'Agent Keys', icon: KeyRound },
  ];

  return (
    <div className="animate-fade-in max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center shadow-lg"
            style={{
              background: 'linear-gradient(135deg, var(--mt-accent), var(--mt-accent-strong))',
              boxShadow: '0 10px 25px -12px color-mix(in srgb, #10b981 50%, transparent)',
            }}
          >
            <Shield size={20} className="text-white" />
          </div>
          <div>
            <h1 className="mt-heading text-2xl">Admin Panel</h1>
            <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>Manage clients, users, and platform settings</p>
          </div>
        </div>
      </div>

      {/* Platform Logo (owner only) */}
      {isOwner && <PlatformLogoSection />}

      {/* Tabs */}
      <div className="mb-6" style={{ borderBottom: '1px solid var(--mt-border)' }}>
        <div className="flex gap-0">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`mt-tab ${tab === t.key ? 'mt-tab--active' : ''}`}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'clients' && <ClientsPanel />}
      {tab === 'team' && isOwner && <TeamPanel />}
      {tab === 'agent_keys' && <AgentKeysPanel />}
    </div>
  );
}

/* ─── Platform Logo Section (owner only) ─────────────────── */

function PlatformLogoSection() {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api.get('/logo').then(res => setLogoUrl(res.data.platformLogo)).catch(() => {});
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('logo', file);
      const res = await api.post('/admin/logo/platform', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setLogoUrl(res.data.url + '?t=' + Date.now());
    } catch (err: any) {
      alert(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm('Remove platform logo?')) return;
    await api.delete('/admin/logo/platform');
    setLogoUrl(null);
  };

  return (
    <div className="mt-card p-5 mb-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center overflow-hidden"
            style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
          >
            {logoUrl ? (
              <img src={logoUrl} alt="Platform logo" className="w-full h-full object-contain p-1" />
            ) : (
              <BarChart3 size={24} style={{ color: 'var(--mt-accent-text)' }} />
            )}
          </div>
          <div>
            <h3 className="mt-heading text-sm">Platform Logo</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>Shown on login page and sidebar</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium cursor-pointer transition-all"
            style={{
              color: 'var(--mt-accent-text)',
              border: '1px solid var(--mt-accent-border)',
              background: 'transparent',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--mt-accent-soft)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <ImagePlus size={14} />
            {uploading ? 'Uploading...' : 'Upload'}
            <input type="file" accept="image/*" className="hidden" onChange={handleUpload} disabled={uploading} />
          </label>
          {logoUrl && <DangerGhostButton icon={Trash2} label="Remove" onClick={handleRemove} />}
        </div>
      </div>
    </div>
  );
}

/* ─── Small shared UI helpers ───────────────────────────── */

function DangerGhostButton({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all"
      style={{
        color: 'var(--mt-danger-text)',
        border: '1px solid var(--mt-danger-border)',
        background: 'transparent',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--mt-danger-soft)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function StatusPill({ active, size = 'sm' }: { active: boolean; size?: 'sm' | 'md' }) {
  const padding = size === 'md' ? 'px-3 py-1.5' : 'px-2.5 py-1';
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full ${padding}`}
      style={{
        color: active ? 'var(--mt-success-text)' : 'var(--mt-danger-text)',
        background: active ? 'var(--mt-success-soft)' : 'var(--mt-danger-soft)',
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: active ? 'var(--mt-success-text)' : 'var(--mt-danger-text)' }}
      />
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

function GhostToggle({ enabled, onClick, disabled, tone: toneKey = 'accent' }: {
  enabled: boolean; onClick: () => void; disabled?: boolean; tone?: 'accent' | 'amber';
}) {
  const t = toneKey === 'amber' ? TONES.amber : TONES.accent;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="relative rounded-full transition-all"
      style={{
        width: 44,
        height: 24,
        background: enabled ? t.fg : 'var(--mt-bg-muted)',
        border: '1px solid ' + (enabled ? t.border : 'var(--mt-border)'),
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        className="absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all"
        style={{ left: enabled ? 24 : 4 }}
      />
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════
   CLIENTS PANEL
   ═══════════════════════════════════════════════════════════ */

function ClientsPanel() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const isOwner = localStorage.getItem('is_owner') === '1';

  const loadClients = useCallback(() => {
    api.get('/admin/clients').then(res => { setClients(res.data); setLoading(false); });
  }, []);

  useEffect(() => { loadClients(); }, [loadClients]);

  if (selectedSlug) {
    return <ClientDetail slug={selectedSlug} onBack={() => { setSelectedSlug(null); loadClients(); }} />;
  }

  const activeCount = clients.filter(c => c.is_active).length;
  const totalUsers = clients.reduce((s, c) => s + c.user_count, 0);
  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.slug.toLowerCase().includes(search.toLowerCase())
  );

  const stats: Array<{ label: string; value: string | number; sub: string; tone: Tone; icon: any }> = [
    { label: 'Total Clients', value: clients.length, sub: `${activeCount} active`, tone: TONES.accent, icon: Building2 },
    { label: 'Total Users', value: totalUsers, sub: 'Across all clients', tone: TONES.blue, icon: Users },
    { label: 'Status', value: 'Live', sub: 'Platform operational', tone: TONES.accent, icon: Activity },
  ];

  return (
    <div>
      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {stats.map(s => (
          <div key={s.label} className="mt-card p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>
                {s.label}
              </span>
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: s.tone.soft, border: `1px solid ${s.tone.border}` }}
              >
                <s.icon size={15} style={{ color: s.tone.fg }} />
              </div>
            </div>
            <div className="text-3xl font-bold mt-num" style={{ color: s.tone.fg === TONES.accent.fg && s.label === 'Status' ? s.tone.fg : 'var(--mt-text)' }}>
              {s.value}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--mt-text-faint)' }}>{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Create Client */}
      {showCreate && isOwner && (
        <CreateClientForm
          onCreated={() => { setShowCreate(false); loadClients(); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--mt-text-faint)' }} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search clients..."
            className="mt-input pl-9 text-sm"
          />
        </div>
        {isOwner && (
          <button onClick={() => setShowCreate(true)} className="mt-btn-gradient flex items-center gap-2 text-sm">
            <Plus size={15} /> New Client
          </button>
        )}
      </div>

      {/* Client List */}
      {loading ? (
        <LoadingSpinner />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={search ? 'No matching clients' : 'No clients yet'}
          subtitle={search ? 'Try a different search term' : 'Create your first client to get started'}
        />
      ) : (
        <div className="mt-card overflow-hidden p-0">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--mt-border)' }}>
                {['Client', 'Users', 'Integrations', 'Status'].map(h => (
                  <th
                    key={h}
                    className="text-left py-3 px-5 text-xs font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--mt-text-faint)' }}
                  >
                    {h}
                  </th>
                ))}
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((client, idx) => (
                <ClientRow
                  key={client.id}
                  client={client}
                  isLast={idx === filtered.length - 1}
                  onClick={() => setSelectedSlug(client.slug)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClientRow({ client, isLast, onClick }: { client: Client; isLast: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="cursor-pointer transition-colors"
      style={{
        borderBottom: isLast ? 'none' : '1px solid var(--mt-border)',
        background: hover ? 'var(--mt-bg-muted)' : 'transparent',
      }}
    >
      <td className="py-3.5 px-5">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: TONES.accent.soft, border: `1px solid ${TONES.accent.border}` }}
          >
            <Building2 size={16} style={{ color: TONES.accent.fg }} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--mt-text)' }}>{client.name}</div>
            <div className="text-[11px] font-mono" style={{ color: 'var(--mt-text-faint)' }}>{client.slug}</div>
          </div>
        </div>
      </td>
      <td className="py-3.5 px-5">
        <span className="text-sm mt-num" style={{ color: 'var(--mt-text-secondary)' }}>{client.user_count}</span>
      </td>
      <td className="py-3.5 px-5">
        {client.integrations ? (
          <div className="flex gap-1.5 flex-wrap">
            {client.integrations.split(',').map(i => (
              <span
                key={i}
                className="text-[10px] px-2 py-0.5 rounded-full"
                style={{ background: 'var(--mt-bg-muted)', color: 'var(--mt-text-muted)', border: '1px solid var(--mt-border)' }}
              >
                {i.trim()}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>None</span>
        )}
      </td>
      <td className="py-3.5 px-5">
        <StatusPill active={!!client.is_active} />
      </td>
      <td className="py-3.5 px-2">
        <ChevronRight size={16} style={{ color: hover ? TONES.accent.fg : 'var(--mt-text-faint)' }} />
      </td>
    </tr>
  );
}

function LoadingSpinner() {
  return (
    <div className="text-center py-16">
      <div
        className="w-6 h-6 rounded-full animate-spin mx-auto"
        style={{
          border: '2px solid var(--mt-accent-soft)',
          borderTopColor: 'var(--mt-accent)',
        }}
      />
    </div>
  );
}

function EmptyState({ icon: Icon, title, subtitle }: { icon: any; title: string; subtitle?: string }) {
  return (
    <div className="mt-card text-center py-16">
      <Icon size={32} className="mx-auto mb-3" style={{ color: 'var(--mt-text-faint)' }} />
      <p className="text-sm font-medium" style={{ color: 'var(--mt-text-muted)' }}>{title}</p>
      {subtitle && <p className="text-xs mt-1" style={{ color: 'var(--mt-text-faint)' }}>{subtitle}</p>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   CREATE CLIENT FORM
   ═══════════════════════════════════════════════════════════ */

function CreateClientForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [industry, setIndustry] = useState('custom');
  const [industries, setIndustries] = useState<any[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<Set<number>>(new Set());
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    api.get('/admin/industries').then(res => setIndustries(res.data));
    api.get('/admin/team').then(res => setTeamMembers(res.data));
  }, []);

  const autoSlug = (n: string) => {
    setName(n);
    setSlug(n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  };

  const toggleMember = (id: number) => {
    setSelectedMembers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const create = async () => {
    setSaving(true); setError('');
    try {
      const res = await api.post('/admin/clients', {
        slug, name, industry,
        team_member_ids: Array.from(selectedMembers),
      });
      setResult(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create client');
    }
    setSaving(false);
  };

  if (result) {
    return (
      <div
        className="rounded-2xl p-6 mb-6"
        style={{ background: 'var(--mt-bg-raised)', border: `1px solid ${TONES.accent.border}` }}
      >
        <div className="flex items-center gap-3 mb-5">
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center"
            style={{ background: TONES.accent.soft }}
          >
            <CheckCircle size={20} style={{ color: TONES.accent.fg }} />
          </div>
          <div>
            <h3 className="mt-heading text-base" style={{ color: TONES.accent.fg }}>Client Created</h3>
            <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>{result.name}</p>
          </div>
        </div>
        <div
          className="rounded-xl p-4 mb-5"
          style={{ background: 'var(--mt-bg-app)', border: '1px solid var(--mt-border)' }}
        >
          <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--mt-text-faint)' }}>
            Default Login Credentials
          </p>
          <p className="font-mono text-sm" style={{ color: 'var(--mt-text)' }}>
            Username: <span style={{ color: 'var(--mt-accent-text)' }}>admin</span>
          </p>
          <p className="font-mono text-sm" style={{ color: 'var(--mt-text)' }}>
            Password: <span style={{ color: 'var(--mt-accent-text)' }}>admin123</span>
          </p>
          <p className="text-xs mt-3 flex items-center gap-1" style={{ color: TONES.amber.fg }}>
            Change this password immediately after first login
          </p>
        </div>
        <button onClick={onCreated} className="mt-btn-gradient text-sm">Done</button>
      </div>
    );
  }

  return (
    <div className="mt-card p-6 mb-6">
      <h3 className="mt-heading text-base mb-5">Create New Client</h3>
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--mt-text-muted)' }}>Client Name</label>
          <input type="text" value={name} onChange={e => autoSlug(e.target.value)}
            placeholder="e.g. Acme Corp" className="mt-input" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--mt-text-muted)' }}>Slug (URL identifier)</label>
          <input type="text" value={slug} onChange={e => setSlug(e.target.value)}
            placeholder="e.g. apollo-healthcare" className="mt-input font-mono" />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-2" style={{ color: 'var(--mt-text-muted)' }}>Industry</label>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {industries.map((ind: any) => {
              const active = industry === ind.key;
              return (
                <button
                  key={ind.key}
                  type="button"
                  onClick={() => setIndustry(ind.key)}
                  className="text-left px-3 py-2.5 rounded-xl transition-all"
                  style={{
                    border: '1px solid ' + (active ? TONES.accent.border : 'var(--mt-border)'),
                    background: active ? TONES.accent.soft : 'var(--mt-bg-muted)',
                    color: active ? TONES.accent.fg : 'var(--mt-text-muted)',
                  }}
                >
                  <div className="text-sm font-medium">{ind.label}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>{ind.description}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Team Member Assignment */}
      {teamMembers.filter(m => !m.is_owner).length > 0 && (
        <div className="mb-5">
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--mt-text-muted)' }}>Assign Team Members</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMemberDropdown(!showMemberDropdown)}
              className="mt-input w-full flex items-center justify-between text-sm cursor-pointer"
            >
              <span style={{ color: selectedMembers.size > 0 ? 'var(--mt-text)' : 'var(--mt-text-faint)' }}>
                {selectedMembers.size > 0
                  ? teamMembers.filter(m => selectedMembers.has(m.id)).map(m => m.display_name).join(', ')
                  : 'Select team members...'}
              </span>
              <ChevronRight
                size={14}
                className={`transition-transform ${showMemberDropdown ? 'rotate-90' : ''}`}
                style={{ color: 'var(--mt-text-faint)' }}
              />
            </button>
            {showMemberDropdown && (
              <div
                className="absolute left-0 right-0 top-full mt-1 rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto"
                style={{
                  background: 'var(--mt-bg-raised)',
                  border: '1px solid var(--mt-border)',
                  boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
                }}
              >
                {teamMembers.filter(m => !m.is_owner && m.is_active).map(member => (
                  <MemberRow key={member.id} member={member} selected={selectedMembers.has(member.id)} onToggle={() => toggleMember(member.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div
          className="px-4 py-2.5 rounded-xl mb-4 text-sm"
          style={{ background: 'var(--mt-danger-soft)', border: '1px solid var(--mt-danger-border)', color: 'var(--mt-danger-text)' }}
        >
          {error}
        </div>
      )}
      <div className="flex gap-3">
        <button onClick={create} disabled={saving || !name || !slug} className="mt-btn-gradient text-sm">
          {saving ? 'Creating...' : 'Create Client'}
        </button>
        <button onClick={onCancel} className="mt-btn-soft text-sm">Cancel</button>
      </div>
    </div>
  );
}

function MemberRow({ member, selected, onToggle }: { member: TeamMember; selected: boolean; onToggle: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer transition-colors"
      style={{ background: hover ? 'var(--mt-bg-muted)' : 'transparent' }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="w-3.5 h-3.5 rounded"
        style={{ accentColor: 'var(--mt-accent)' }}
      />
      <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{member.display_name}</span>
      <span className="text-[11px] font-mono" style={{ color: 'var(--mt-text-faint)' }}>@{member.username}</span>
    </label>
  );
}

/* ═══════════════════════════════════════════════════════════
   CLIENT DETAIL — Tabbed Layout
   ═══════════════════════════════════════════════════════════ */

function ClientDetail({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [client, setClient] = useState<any>(null);
  const [users, setUsers] = useState<ClientUser[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [industries, setIndustries] = useState<any[]>([]);
  const [clientBranches, setClientBranches] = useState<any[]>([]);
  const [modules, setModules] = useState<{module_key: string; is_enabled: number}[]>([]);
  const [activeTab, setActiveTab] = useState<ClientDetailTab>('users');
  const [resetResult, setResetResult] = useState<{username: string; password: string} | null>(null);
  const [resetConfirm, setResetConfirm] = useState<{userId: number; username: string} | null>(null);
  const [clientLogoUrl, setClientLogoUrl] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);

  const loadDetail = useCallback(() => {
    Promise.all([
      api.get(`/admin/clients/${slug}`),
      api.get(`/admin/clients/${slug}/integrations`),
      api.get(`/admin/clients/${slug}/streams`),
      api.get(`/admin/clients/${slug}/branches`),
      api.get(`/admin/clients/${slug}/modules`),
    ]).then(([clientRes, intRes, streamsRes, branchesRes, modulesRes]) => {
      setClient(clientRes.data);
      setUsers(clientRes.data.users || []);
      setIntegrations(intRes.data.catalog || []);
      setStreams(streamsRes.data);
      setClientBranches(branchesRes.data);
      setModules(modulesRes.data);
      setLoading(false);
    });
  }, [slug]);

  useEffect(() => {
    api.get('/admin/industries').then(res => setIndustries(res.data)).catch(() => {});
  }, []);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  useEffect(() => {
    const checkLogo = async () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'svg', 'webp']) {
        const url = `/api/logos/clients/${slug}.${ext}`;
        try {
          const res = await fetch(url, { method: 'HEAD' });
          if (res.ok) { setClientLogoUrl(url); return; }
        } catch {}
      }
    };
    checkLogo();
  }, [slug]);

  const handleClientLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoUploading(true);
    try {
      const formData = new FormData();
      formData.append('logo', file);
      const res = await api.post(`/admin/logo/client/${slug}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setClientLogoUrl(res.data.url + '?t=' + Date.now());
    } catch (err: any) {
      alert(err.response?.data?.error || 'Upload failed');
    } finally {
      setLogoUploading(false);
    }
  };

  const toggleActive = async () => {
    await api.put(`/admin/clients/${slug}`, { is_active: !client.is_active });
    loadDetail();
  };

  const changeIndustry = async (newIndustry: string) => {
    await api.put(`/admin/clients/${slug}`, { industry: newIndustry });
    loadDetail();
  };

  const resetPassword = async (userId: number, username: string, customPw?: string) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const newPw = customPw || Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    try {
      await api.put(`/admin/clients/${slug}/users/${userId}`, { password: newPw });
      setResetConfirm(null);
      setResetResult({ username, password: newPw });
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to reset password');
    }
  };

  if (loading) return <LoadingSpinner />;

  const isOwnerUser = localStorage.getItem('is_owner') === '1';
  const detailTabs = [
    { key: 'users' as ClientDetailTab, label: 'Users', icon: Users, count: users.length },
    { key: 'modules' as ClientDetailTab, label: 'Modules', icon: Layers },
    { key: 'integrations' as ClientDetailTab, label: 'Integrations', icon: Plug },
    { key: 'streams' as ClientDetailTab, label: 'Revenue Streams', icon: BarChart3, count: streams.length },
    { key: 'dashboard_cards' as ClientDetailTab, label: 'Dashboard', icon: LayoutDashboard },
    { key: 'branches' as ClientDetailTab, label: 'Branches', icon: GitBranch, count: clientBranches.length },
    ...(isOwnerUser ? [{ key: 'assigned_team' as ClientDetailTab, label: 'Team', icon: Shield }] : []),
  ];

  return (
    <div>
      {/* Back button */}
      <BackLink onClick={onBack} />

      {/* Client Header */}
      <div className="mt-card p-6 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative group">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center overflow-hidden"
                style={{
                  background: `linear-gradient(135deg, ${TONES.accent.soft}, color-mix(in srgb, #10b981 5%, transparent))`,
                  border: `1px solid ${TONES.accent.border}`,
                }}
              >
                {clientLogoUrl ? (
                  <img src={clientLogoUrl} alt={client.name} className="w-full h-full object-contain p-1" />
                ) : (
                  <Building2 size={24} style={{ color: TONES.accent.fg }} />
                )}
              </div>
              <label className="absolute inset-0 flex items-center justify-center rounded-2xl opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity" style={{ background: 'rgba(0,0,0,0.5)' }}>
                <ImagePlus size={16} className="text-white" />
                <input type="file" accept="image/*" className="hidden" onChange={handleClientLogoUpload} disabled={logoUploading} />
              </label>
            </div>
            <div>
              <h2 className="mt-heading text-xl">{client.name}</h2>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-sm font-mono" style={{ color: 'var(--mt-text-faint)' }}>{client.slug}</span>
                <span style={{ color: 'var(--mt-text-faint)' }}>·</span>
                <select
                  value={client.industry || 'custom'}
                  onChange={e => changeIndustry(e.target.value)}
                  className="text-sm bg-transparent border-none cursor-pointer transition-colors p-0"
                  style={{ color: 'var(--mt-text-secondary)' }}
                >
                  {industries.map((ind: any) => (
                    <option key={ind.key} value={ind.key}>{ind.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusPill active={!!client.is_active} size="md" />
            <ToggleActiveButton active={!!client.is_active} onClick={toggleActive} />
            {isOwnerUser && (
              <DangerGhostButton
                icon={Trash2}
                label="Delete"
                onClick={async () => {
                  if (!confirm(`DELETE "${client.name}"?\n\nThis will permanently remove the client, all users, and all data. This cannot be undone.`)) return;
                  if (!confirm(`Are you absolutely sure? Type the client slug to confirm.\n\nThis deletes: ${slug}`)) return;
                  try {
                    await api.delete(`/admin/clients/${slug}`);
                    onBack();
                  } catch (err: any) {
                    alert(err.response?.data?.error || 'Failed to delete');
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Detail Tabs */}
      <div className="mb-6" style={{ borderBottom: '1px solid var(--mt-border)' }}>
        <div className="flex gap-0 flex-wrap">
          {detailTabs.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`mt-tab ${activeTab === t.key ? 'mt-tab--active' : ''}`}
            >
              <t.icon size={14} />
              {t.label}
              {t.count !== undefined && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{
                    background: activeTab === t.key ? TONES.accent.soft : 'var(--mt-bg-muted)',
                    color: activeTab === t.key ? TONES.accent.fg : 'var(--mt-text-faint)',
                  }}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'users' && <UsersSection slug={slug} users={users} onReload={loadDetail} resetPassword={(id, username) => setResetConfirm({ userId: id, username })} />}
      {activeTab === 'modules' && <ModulesSection slug={slug} modules={modules} onReload={loadDetail} />}
      {activeTab === 'integrations' && <IntegrationsSection slug={slug} integrations={integrations} onReload={loadDetail} />}
      {activeTab === 'streams' && <StreamsSection slug={slug} streams={streams} onReload={loadDetail} />}
      {activeTab === 'dashboard_cards' && <DashboardConfigSection slug={slug} streams={streams} />}
      {activeTab === 'branches' && <BranchesSection slug={slug} client={client} branches={clientBranches} users={users} onReload={loadDetail} />}
      {activeTab === 'assigned_team' && <TeamAssignmentSection slug={slug} />}

      {/* Password Reset Confirmation Modal */}
      {resetConfirm && (
        <ResetPasswordModal
          username={resetConfirm.username}
          onConfirm={(customPw) => resetPassword(resetConfirm.userId, resetConfirm.username, customPw)}
          onCancel={() => setResetConfirm(null)}
        />
      )}

      {/* Password Reset Result Modal */}
      {resetResult && (
        <PasswordResultModal result={resetResult} onClose={() => setResetResult(null)} />
      )}
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-2 text-sm mb-5 transition-colors"
      style={{ color: hover ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)' }}
    >
      <ArrowLeft size={15} /> Back to clients
    </button>
  );
}

function ToggleActiveButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const base = active ? TONES.danger : TONES.accent;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-all"
      style={{
        color: base.fg,
        border: `1px solid ${base.border}`,
        background: hover ? base.soft : 'transparent',
      }}
    >
      <Power size={14} />
      {active ? 'Deactivate' : 'Activate'}
    </button>
  );
}

function PasswordResultModal({ result, onClose }: { result: { username: string; password: string }; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl"
        style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <CheckCircle size={18} style={{ color: TONES.accent.fg }} />
          <h3 className="mt-heading">Password Reset</h3>
        </div>
        <p className="text-sm mb-3" style={{ color: 'var(--mt-text-muted)' }}>
          New credentials for <span className="font-medium" style={{ color: 'var(--mt-accent-text)' }}>@{result.username}</span>
        </p>
        <div
          className="rounded-xl p-3 font-mono text-sm mb-4 flex items-center justify-between"
          style={{ background: 'var(--mt-bg-app)', border: '1px solid var(--mt-border)', color: 'var(--mt-text)' }}
        >
          <span>{result.password}</span>
          <button
            onClick={() => navigator.clipboard.writeText(result.password)}
            className="transition-colors"
            style={{ color: 'var(--mt-text-muted)' }}
            title="Copy"
          >
            <Copy size={14} />
          </button>
        </div>
        <p className="text-xs mb-4" style={{ color: TONES.amber.fg }}>Save this password — it won't be shown again</p>
        <button onClick={onClose} className="mt-btn-gradient text-sm w-full">Done</button>
      </div>
    </div>
  );
}

/* ─── Users Section ──────────────────────────────────────── */

function UsersSection({ slug, users, onReload, resetPassword }: {
  slug: string; users: ClientUser[]; onReload: () => void;
  resetPassword: (id: number, username: string) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [accessUser, setAccessUser] = useState<ClientUser | null>(null);

  const toggleUserActive = async (userId: number, isActive: number) => {
    await api.put(`/admin/clients/${slug}/users/${userId}`, { is_active: !isActive });
    onReload();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>Manage user accounts for this client</p>
        <button onClick={() => setShowAdd(true)} className="mt-btn-gradient flex items-center gap-2 text-sm">
          <UserPlus size={14} /> Add User
        </button>
      </div>

      {showAdd && (
        <AddUserForm slug={slug} onAdded={() => { setShowAdd(false); onReload(); }} onCancel={() => setShowAdd(false)} />
      )}

      {users.length === 0 ? (
        <EmptyState icon={Users} title="No users yet" />
      ) : (
        <div className="mt-card p-0 overflow-hidden">
          {users.map((user, i) => (
            <UserRow
              key={user.id}
              user={user}
              isLast={i === users.length - 1}
              onManageAccess={() => setAccessUser(user)}
              onResetPassword={() => resetPassword(user.id, user.username)}
              onToggleActive={() => toggleUserActive(user.id, user.is_active)}
              onDelete={async () => {
                if (!confirm(`Delete user "${user.display_name}" (@${user.username})? This cannot be undone.`)) return;
                await api.delete(`/admin/clients/${slug}/users/${user.id}`);
                onReload();
              }}
            />
          ))}
        </div>
      )}

      {/* User Access Modal */}
      {accessUser && (
        <UserAccessModal
          slug={slug}
          user={accessUser}
          onClose={() => { setAccessUser(null); }}
        />
      )}
    </div>
  );
}

function UserRow({ user, isLast, onManageAccess, onResetPassword, onToggleActive, onDelete }: {
  user: ClientUser;
  isLast: boolean;
  onManageAccess: () => void;
  onResetPassword: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const isAdmin = user.role === 'admin';
  const roleTone = isAdmin ? TONES.amber : TONES.accent;
  return (
    <div
      className="flex items-center justify-between px-5 py-3.5"
      style={{ borderBottom: isLast ? 'none' : '1px solid var(--mt-border)' }}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold"
          style={{
            background: isAdmin ? TONES.amber.soft : 'var(--mt-bg-muted)',
            color: isAdmin ? TONES.amber.fg : 'var(--mt-text-muted)',
            border: '1px solid ' + (isAdmin ? TONES.amber.border : 'var(--mt-border)'),
          }}
        >
          {user.display_name.charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{user.display_name}</span>
            <span className="text-[11px] font-mono" style={{ color: 'var(--mt-text-faint)' }}>@{user.username}</span>
          </div>
          <span
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: isAdmin ? roleTone.fg : 'var(--mt-text-faint)' }}
          >
            {user.role}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ToneButton icon={MapPin} label="Access" tone={TONES.accent} onClick={onManageAccess} />
        <MutedButton icon={KeyRound} label="Reset PW" onClick={onResetPassword} />
        <StatusToggleButton active={!!user.is_active} onClick={onToggleActive} />
        <IconHoverButton icon={Trash2} tone={TONES.danger} onClick={onDelete} />
      </div>
    </div>
  );
}

function ToneButton({ icon: Icon, label, tone, onClick }: { icon: any; label: string; tone: Tone; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="text-xs px-2.5 py-1.5 rounded-lg transition-all flex items-center gap-1"
      style={{
        color: tone.fg,
        background: hover ? tone.soft : 'transparent',
        border: `1px solid ${tone.border}`,
      }}
    >
      <Icon size={11} /> {label}
    </button>
  );
}

function MutedButton({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="text-xs px-2.5 py-1.5 rounded-lg transition-all flex items-center gap-1"
      style={{
        color: hover ? 'var(--mt-text)' : 'var(--mt-text-muted)',
        background: hover ? 'var(--mt-bg-muted)' : 'var(--mt-bg-raised)',
        border: '1px solid var(--mt-border)',
      }}
    >
      <Icon size={11} /> {label}
    </button>
  );
}

function StatusToggleButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const t = active ? TONES.accent : TONES.danger;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all"
      style={{
        color: t.fg,
        background: hover ? `color-mix(in srgb, ${t.fg} 20%, transparent)` : t.soft,
        border: `1px solid ${t.border}`,
      }}
    >
      {active ? 'Active' : 'Disabled'}
    </button>
  );
}

function IconHoverButton({ icon: Icon, tone, onClick }: { icon: any; tone: Tone; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="text-xs p-1.5 rounded-lg transition-all"
      style={{
        color: hover ? tone.fg : 'var(--mt-text-faint)',
        background: hover ? tone.soft : 'transparent',
      }}
    >
      <Icon size={13} />
    </button>
  );
}

/* ─── User Access Modal ─────────────────────────────────── */

function UserAccessModal({ slug, user, onClose }: { slug: string; user: ClientUser; onClose: () => void }) {
  const [branches, setBranches] = useState<any[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [access, setAccess] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get(`/admin/clients/${slug}/branches`),
      api.get(`/admin/clients/${slug}/streams`),
      api.get(`/admin/clients/${slug}/users/${user.id}/access`),
    ]).then(([branchRes, streamRes, accessRes]) => {
      setBranches(branchRes.data.filter((b: any) => b.is_active));
      setStreams(streamRes.data);
      const accessSet = new Set<string>();
      for (const a of accessRes.data) {
        accessSet.add(`${a.branch_id}-${a.stream_id}`);
      }
      setAccess(accessSet);
      setLoading(false);
    });
  }, [slug, user.id]);

  const toggleAccess = (branchId: number, streamId: number) => {
    const key = `${branchId}-${streamId}`;
    setAccess(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleBranch = (branchId: number) => {
    const branchKeys = streams.map((s: any) => `${branchId}-${s.id}`);
    const allSelected = branchKeys.every(k => access.has(k));
    setAccess(prev => {
      const next = new Set(prev);
      for (const k of branchKeys) {
        if (allSelected) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    const entries = Array.from(access).map(key => {
      const [bid, sid] = key.split('-').map(Number);
      return { branch_id: bid, stream_id: sid, can_view_consolidated: false };
    });
    try {
      await api.put(`/admin/clients/${slug}/users/${user.id}/access`, { access: entries });
      onClose();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  };

  const stateGroups = new Map<string, any[]>();
  for (const b of branches) {
    const st = b.state || '';
    if (!stateGroups.has(st)) stateGroups.set(st, []);
    stateGroups.get(st)!.push(b);
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl p-6 max-w-lg w-full mx-4 shadow-2xl max-h-[80vh] flex flex-col"
        style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="mt-heading mb-1">Branch & Stream Access</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--mt-text-faint)' }}>
          Configure access for <span className="font-medium" style={{ color: 'var(--mt-accent-text)' }}>{user.display_name}</span>
        </p>

        {loading ? (
          <LoadingSpinner />
        ) : streams.length === 0 ? (
          <p className="text-sm py-4" style={{ color: 'var(--mt-text-faint)' }}>
            No streams configured. Add streams to the client first.
          </p>
        ) : (
          <div className="flex-1 overflow-y-auto mb-4">
            {/* Header row */}
            <div className="flex items-center gap-2 mb-2 px-1">
              <div className="w-28 text-[10px] font-semibold uppercase" style={{ color: 'var(--mt-text-faint)' }}>Branch</div>
              {streams.map((s: any) => (
                <div key={s.id} className="flex-1 text-center text-[10px] font-semibold uppercase truncate" style={{ color: 'var(--mt-text-faint)' }}>{s.name}</div>
              ))}
            </div>
            {Array.from(stateGroups.entries()).map(([stateName, stateBranches]) => (
              <div key={stateName || '__none'}>
                {stateName && (
                  <div className="text-[10px] font-bold uppercase tracking-wider px-1 pt-2 pb-1" style={{ color: 'var(--mt-text-faint)' }}>{stateName}</div>
                )}
                {stateBranches.map((branch: any) => {
                  const branchKeys = streams.map((s: any) => `${branch.id}-${s.id}`);
                  const allChecked = branchKeys.every(k => access.has(k));
                  return (
                    <AccessBranchRow
                      key={branch.id}
                      branch={branch}
                      streams={streams}
                      access={access}
                      allChecked={allChecked}
                      onToggleBranch={() => toggleBranch(branch.id)}
                      onToggleCell={(streamId) => toggleAccess(branch.id, streamId)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid var(--mt-border)' }}>
          <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>{access.size} permissions</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="mt-btn-soft text-sm">Cancel</button>
            <button onClick={save} disabled={saving} className="mt-btn-gradient text-sm">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccessBranchRow({ branch, streams, access, allChecked, onToggleBranch, onToggleCell }: {
  branch: any; streams: any[]; access: Set<string>;
  allChecked: boolean; onToggleBranch: () => void; onToggleCell: (streamId: number) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-2 py-1.5 px-1 rounded-lg"
      style={{ background: hover ? 'var(--mt-bg-muted)' : 'transparent' }}
    >
      <button
        onClick={onToggleBranch}
        className="w-28 text-left text-xs font-medium truncate"
        style={{ color: allChecked ? 'var(--mt-accent-text)' : 'var(--mt-text-secondary)' }}
        title="Toggle all streams"
      >
        {branch.name}
      </button>
      {streams.map((stream: any) => (
        <div key={stream.id} className="flex-1 flex justify-center">
          <input
            type="checkbox"
            checked={access.has(`${branch.id}-${stream.id}`)}
            onChange={() => onToggleCell(stream.id)}
            className="w-4 h-4 rounded"
            style={{ accentColor: 'var(--mt-accent)' }}
          />
        </div>
      ))}
    </div>
  );
}

/* ─── Modules Section ────────────────────────────────────── */

function ModulesSection({ slug, modules, onReload }: {
  slug: string; modules: {module_key: string; is_enabled: number}[]; onReload: () => void;
}) {
  const allModules = [
    { key: 'forecast_ops', name: 'Forecast & Operations', desc: 'Build forecasts, link actuals, integrated reports', icon: '📊' },
    { key: 'vcfo_portal', name: 'VCFO Portal', desc: 'Comprehensive Virtual CFO portal with Tally sync', icon: '💼' },
    { key: 'audit_view', name: 'Audit View', desc: 'Audit support and compliance tools', icon: '🔍' },
    { key: 'litigation_tool', name: 'Litigation Tool', desc: 'Track notices and prepare legal responses', icon: '⚖️' },
    { key: 'user_analysis', name: 'User Analysis', desc: 'Allow regular users to view the Analysis page', icon: '📊' },
    { key: 'user_insights', name: 'User Insights', desc: 'Allow regular users to view the Insights page', icon: '📈' },
  ];

  return (
    <div>
      <p className="text-sm mb-4" style={{ color: 'var(--mt-text-faint)' }}>Enable or disable modules for this client</p>
      <div className="grid grid-cols-2 gap-3">
        {allModules.map(mod => {
          const m = modules.find(x => x.module_key === mod.key);
          const enabled = !!m?.is_enabled;
          return (
            <div
              key={mod.key}
              className="rounded-2xl p-5 transition-all"
              style={{
                background: enabled ? TONES.accent.soft : 'var(--mt-bg-raised)',
                border: `1px solid ${enabled ? TONES.accent.border : 'var(--mt-border)'}`,
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-2xl">{mod.icon}</span>
                <GhostToggle
                  enabled={enabled}
                  onClick={async () => {
                    await api.put(`/admin/clients/${slug}/modules/${mod.key}`, { is_enabled: !enabled });
                    onReload();
                  }}
                />
              </div>
              <h4 className="text-sm font-semibold" style={{ color: enabled ? 'var(--mt-text)' : 'var(--mt-text-muted)' }}>{mod.name}</h4>
              <p className="text-xs mt-1" style={{ color: 'var(--mt-text-faint)' }}>{mod.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Integrations Section ───────────────────────────────── */

const SETTING_ICONS: Record<string, any> = {
  financial_years: Calendar,
  doctors: Stethoscope,
  manual_upload: Upload,
  tally: Server,
  zoho_books: BookOpen,
  healthplix: Stethoscope,
  oneglance: Activity,
  turia: Globe,
};

function IntegrationsSection({ slug, integrations, onReload }: {
  slug: string; integrations: Integration[]; onReload: () => void;
}) {
  const coreItems = integrations.filter(i => i.group === 'core');
  const integrationItems = integrations.filter(i => i.group !== 'core');

  const renderItem = (int: Integration) => {
    const Icon = SETTING_ICONS[int.key] || Globe;
    return (
      <div
        key={int.key}
        className="flex items-center justify-between px-5 py-4 rounded-2xl"
        style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center"
            style={{
              background: int.enabled ? TONES.accent.soft : 'var(--mt-bg-muted)',
              border: '1px solid ' + (int.enabled ? TONES.accent.border : 'var(--mt-border)'),
            }}
          >
            <Icon size={16} style={{ color: int.enabled ? TONES.accent.fg : 'var(--mt-text-faint)' }} />
          </div>
          <div>
            <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{int.name}</span>
            <p className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>{int.description}</p>
          </div>
        </div>
        <GhostToggle
          enabled={int.enabled}
          onClick={async () => {
            await api.put(`/admin/clients/${slug}/integrations/${int.key}`, { is_enabled: !int.enabled });
            onReload();
          }}
        />
      </div>
    );
  };

  return (
    <div>
      {coreItems.length > 0 && (
        <>
          <p className="text-xs font-medium uppercase tracking-wide mb-3" style={{ color: 'var(--mt-text-faint)' }}>Settings</p>
          <div className="space-y-2 mb-6">{coreItems.map(renderItem)}</div>
        </>
      )}
      <p className="text-xs font-medium uppercase tracking-wide mb-3" style={{ color: 'var(--mt-text-faint)' }}>Integrations</p>
      <div className="space-y-2">{integrationItems.map(renderItem)}</div>
    </div>
  );
}

/* ─── Revenue Streams Section ────────────────────────────── */

function StreamsSection({ slug, streams, onReload }: {
  slug: string; streams: any[]; onReload: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('accent');

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>Revenue streams drive the dashboard KPI cards</p>
        <button onClick={() => setShowAdd(true)} className="mt-btn-gradient flex items-center gap-2 text-sm">
          <Plus size={14} /> Add Stream
        </button>
      </div>

      {showAdd && (
        <div className="mt-card p-5 mb-4">
          <h4 className="mt-heading text-sm mb-3">New Revenue Stream</h4>
          <div className="flex gap-3 mb-3">
            <div className="flex-1">
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g. Consulting, Dine-in" className="mt-input text-sm" />
            </div>
            <select value={color} onChange={e => setColor(e.target.value)} className="mt-input text-sm w-28">
              <option value="accent">Green</option>
              <option value="blue">Blue</option>
              <option value="purple">Purple</option>
              <option value="amber">Amber</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                if (!name) return;
                await api.post(`/admin/clients/${slug}/streams`, { name, color });
                setName(''); setShowAdd(false); onReload();
              }}
              disabled={!name}
              className="mt-btn-gradient text-xs"
            >Add</button>
            <button onClick={() => setShowAdd(false)} className="mt-btn-soft text-xs">Cancel</button>
          </div>
        </div>
      )}

      {streams.length === 0 ? (
        <EmptyState icon={BarChart3} title="No revenue streams configured" />
      ) : (
        <div className="mt-card p-0 overflow-hidden">
          {streams.map((stream: any, i: number) => (
            <div
              key={stream.id}
              className="flex items-center justify-between px-5 py-3.5"
              style={{ borderBottom: i < streams.length - 1 ? '1px solid var(--mt-border)' : 'none' }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ background: STREAM_DOT[stream.color] || STREAM_DOT.accent }}
                />
                <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{stream.name}</span>
              </div>
              <IconHoverButton
                icon={Trash2}
                tone={TONES.danger}
                onClick={async () => {
                  if (!confirm(`Delete stream "${stream.name}"?`)) return;
                  await api.delete(`/admin/clients/${slug}/streams/${stream.id}`);
                  onReload();
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Dashboard Config Section ───────────────────────────── */

function DashboardConfigSection({ slug, streams }: { slug: string; streams: any[] }) {
  const [loading, setLoading] = useState(true);
  const [scopes, setScopes] = useState<Record<string, { cards: any[]; charts: any[]; tables: any[] }>>({});
  const [activeScope, setActiveScope] = useState('total');
  const [saving, setSaving] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const STREAM_SOURCES: Record<string, string> = {};
  for (const s of streams) {
    const n = (s.name as string).toLowerCase();
    if (n.includes('clinic') || n.includes('health')) STREAM_SOURCES[String(s.id)] = 'healthplix';
    else if (n.includes('pharma')) STREAM_SOURCES[String(s.id)] = 'oneglance';
  }

  const scopeTabs = [
    { key: 'total', label: 'Total Revenue', source: '' },
    ...streams.map((s: any) => ({ key: String(s.id), label: s.name, source: STREAM_SOURCES[String(s.id)] || '' })),
  ];

  const loadVisibility = useCallback(() => {
    api.get(`/admin/clients/${slug}/dashboard-visibility`).then(res => {
      setScopes(res.data.scopes || {});
      setLoading(false);
    });
  }, [slug]);

  useEffect(() => { loadVisibility(); }, [loadVisibility]);

  const toggleCard = async (card: any) => {
    const isVisCard = card._source === 'chart_visibility';
    const saveKey = isVisCard ? `chart-${card.id}` : `card-${card.id}`;
    setSaving(saveKey);
    if (isVisCard) {
      await api.put(`/admin/clients/${slug}/dashboard-visibility/charts/${card.id}`, { is_visible: !card.is_visible });
    } else {
      await api.put(`/admin/clients/${slug}/dashboard-cards/${card.id}`, { is_visible: !card.is_visible });
    }
    setScopes(prev => {
      const updated = { ...prev };
      for (const key of Object.keys(updated)) {
        updated[key] = {
          ...updated[key],
          cards: updated[key].cards.map(c =>
            (c.id === card.id && c._source === card._source) ? { ...c, is_visible: c.is_visible ? 0 : 1 } : c
          ),
        };
      }
      return updated;
    });
    setSaving(null);
  };

  const toggleChart = async (element: any) => {
    setSaving(`chart-${element.id}`);
    await api.put(`/admin/clients/${slug}/dashboard-visibility/charts/${element.id}`, { is_visible: !element.is_visible });
    setScopes(prev => {
      const updated = { ...prev };
      for (const key of Object.keys(updated)) {
        updated[key] = {
          ...updated[key],
          charts: updated[key].charts.map(e => e.id === element.id ? { ...e, is_visible: e.is_visible ? 0 : 1 } : e),
          tables: updated[key].tables.map(e => e.id === element.id ? { ...e, is_visible: e.is_visible ? 0 : 1 } : e),
        };
      }
      return updated;
    });
    setSaving(null);
  };

  const toggleSection = (section: string) => {
    setCollapsed(prev => ({ ...prev, [section]: !prev[section] }));
  };

  if (loading) return (
    <div className="text-center py-8 text-sm" style={{ color: 'var(--mt-text-faint)' }}>Loading configuration...</div>
  );

  const currentScope = scopes[activeScope] || { cards: [], charts: [], tables: [] };

  const SOURCE_TONES: Record<string, Tone> = {
    healthplix: TONES.teal,
    oneglance: TONES.orange,
  };
  const SOURCE_LABELS: Record<string, string> = {
    healthplix: 'Healthplix',
    oneglance: 'OneGlance',
  };
  const BADGE_TONES: Record<string, Tone> = {
    System: TONES.accent,
    Auto: TONES.blue,
    Custom: TONES.purple,
  };

  const renderToggleItem = (item: any, type: 'card' | 'chart', badge?: string) => {
    const isCard = type === 'card';
    const isVisCard = item._source === 'chart_visibility';
    const id = (isCard && !isVisCard) ? `card-${item.id}` : `chart-${item.id}`;
    const isSaving = saving === id;
    const isVisible = !!item.is_visible;
    const label = (isCard && !isVisCard) ? item.title : item.element_label;
    const description = item.description || '';
    const sourceTone = item.source ? SOURCE_TONES[item.source] : null;
    const sourceLabel = item.source ? SOURCE_LABELS[item.source] : null;
    const badgeTone = badge ? BADGE_TONES[badge] : null;

    return (
      <div
        key={`${item._source || type}-${item.id}`}
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--mt-border)' }}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={() => (isCard && !isVisCard) ? toggleCard(item) : isCard ? toggleCard(item) : toggleChart(item)}
            disabled={isSaving}
            className="p-1.5 rounded-lg transition-all shrink-0"
            style={{
              color: isVisible ? TONES.accent.fg : 'var(--mt-text-faint)',
              background: isVisible ? TONES.accent.soft : 'var(--mt-bg-muted)',
              border: '1px solid ' + (isVisible ? TONES.accent.border : 'var(--mt-border)'),
              opacity: isSaving ? 0.5 : 1,
            }}
          >
            {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{label}</span>
              {badge && badgeTone && (
                <span
                  className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                  style={{ background: badgeTone.soft, color: badgeTone.fg, border: `1px solid ${badgeTone.border}` }}
                >
                  {badge}
                </span>
              )}
              {sourceTone && sourceLabel && (
                <span
                  className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                  style={{ background: sourceTone.soft, color: sourceTone.fg, border: `1px solid ${sourceTone.border}` }}
                >
                  {sourceLabel}
                </span>
              )}
            </div>
            {description && (
              <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--mt-text-faint)' }}>{description}</p>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderSection = (title: string, sectionKey: string, items: any[], type: 'card' | 'chart', getBadge?: (item: any) => string | undefined) => {
    const isCollapsed = collapsed[`${activeScope}-${sectionKey}`];
    return (
      <div className="mb-4">
        <button
          onClick={() => toggleSection(`${activeScope}-${sectionKey}`)}
          className="flex items-center gap-2 w-full text-left px-1 py-2 text-sm font-semibold transition-colors"
          style={{ color: 'var(--mt-text)' }}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {title}
          <span className="text-[10px] font-normal ml-1" style={{ color: 'var(--mt-text-faint)' }}>
            ({items.filter(i => i.is_visible).length}/{items.length} visible)
          </span>
        </button>
        {!isCollapsed && (
          items.length > 0 ? (
            <div className="mt-card p-0 overflow-hidden">
              {items.map(item => renderToggleItem(item, type, getBadge?.(item)))}
            </div>
          ) : (
            <div className="mt-card px-4 py-6 text-center">
              <p className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>No {title.toLowerCase()} configured</p>
            </div>
          )
        )}
      </div>
    );
  };

  return (
    <div>
      <p className="text-sm mb-4" style={{ color: 'var(--mt-text-faint)' }}>Configure which elements appear on the Actuals dashboard</p>

      {/* Scope sub-tabs */}
      <div
        className="flex gap-1 mb-5 rounded-xl p-1"
        style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
      >
        {scopeTabs.map(tab => {
          const active = activeScope === tab.key;
          const sourceTone = tab.source ? SOURCE_TONES[tab.source] : null;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveScope(tab.key)}
              className="px-4 py-2 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5"
              style={{
                background: active ? TONES.accent.soft : 'transparent',
                color: active ? TONES.accent.fg : 'var(--mt-text-faint)',
                border: '1px solid ' + (active ? TONES.accent.border : 'transparent'),
              }}
            >
              {tab.label}
              {tab.source && sourceTone && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded-full"
                  style={{ background: sourceTone.soft, color: sourceTone.fg }}
                >
                  {SOURCE_LABELS[tab.source]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sections */}
      {renderSection(
        'KPI Cards', 'cards', currentScope.cards, 'card',
        (item) => item._source === 'chart_visibility' ? undefined :
          item.card_type === 'total' ? 'System' : item.card_type === 'stream' ? 'Auto' : 'Custom'
      )}
      {renderSection('Charts', 'charts', currentScope.charts, 'chart')}
      {renderSection('Tables', 'tables', currentScope.tables, 'chart')}
    </div>
  );
}

/* ─── Branches Section ───────────────────────────────────── */

const INDIAN_STATES_CITIES: Record<string, string[]> = {
  'Andhra Pradesh': ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Nellore', 'Kurnool', 'Tirupati', 'Kakinada', 'Rajahmundry', 'Anantapur', 'Eluru'],
  'Arunachal Pradesh': ['Itanagar', 'Naharlagun', 'Pasighat', 'Tawang', 'Ziro'],
  'Assam': ['Guwahati', 'Silchar', 'Dibrugarh', 'Jorhat', 'Nagaon', 'Tinsukia', 'Tezpur'],
  'Bihar': ['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur', 'Darbhanga', 'Purnia', 'Arrah'],
  'Chhattisgarh': ['Raipur', 'Bhilai', 'Bilaspur', 'Korba', 'Durg', 'Rajnandgaon'],
  'Goa': ['Panaji', 'Margao', 'Vasco da Gama', 'Mapusa', 'Ponda'],
  'Gujarat': ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar', 'Jamnagar', 'Junagadh', 'Gandhinagar', 'Anand', 'Nadiad'],
  'Haryana': ['Gurugram', 'Faridabad', 'Panipat', 'Ambala', 'Karnal', 'Hisar', 'Rohtak', 'Sonipat'],
  'Himachal Pradesh': ['Shimla', 'Manali', 'Dharamshala', 'Solan', 'Mandi', 'Kullu'],
  'Jharkhand': ['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro', 'Hazaribagh', 'Deoghar'],
  'Karnataka': ['Bangalore', 'Mysore', 'Hubli', 'Mangalore', 'Belgaum', 'Davangere', 'Gulbarga', 'Shimoga', 'Tumkur', 'Udupi'],
  'Kerala': ['Thiruvananthapuram', 'Kochi', 'Kozhikode', 'Thrissur', 'Kollam', 'Palakkad', 'Alappuzha', 'Kannur', 'Kottayam'],
  'Madhya Pradesh': ['Bhopal', 'Indore', 'Jabalpur', 'Gwalior', 'Ujjain', 'Sagar', 'Dewas', 'Satna', 'Ratlam'],
  'Maharashtra': ['Mumbai', 'Pune', 'Nagpur', 'Thane', 'Nashik', 'Aurangabad', 'Solapur', 'Kolhapur', 'Amravati', 'Navi Mumbai'],
  'Manipur': ['Imphal', 'Thoubal', 'Bishnupur', 'Churachandpur'],
  'Meghalaya': ['Shillong', 'Tura', 'Jowai', 'Nongstoin'],
  'Mizoram': ['Aizawl', 'Lunglei', 'Champhai', 'Serchhip'],
  'Nagaland': ['Kohima', 'Dimapur', 'Mokokchung', 'Tuensang', 'Wokha'],
  'Odisha': ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Brahmapur', 'Sambalpur', 'Puri'],
  'Punjab': ['Chandigarh', 'Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Bathinda', 'Mohali'],
  'Rajasthan': ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota', 'Ajmer', 'Bikaner', 'Alwar', 'Bhilwara'],
  'Sikkim': ['Gangtok', 'Namchi', 'Gyalshing', 'Mangan'],
  'Tamil Nadu': ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tirunelveli', 'Erode', 'Vellore', 'Thoothukudi'],
  'Telangana': ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar', 'Khammam', 'Mahbubnagar', 'Secunderabad'],
  'Tripura': ['Agartala', 'Udaipur', 'Dharmanagar', 'Kailasahar'],
  'Uttar Pradesh': ['Lucknow', 'Kanpur', 'Agra', 'Varanasi', 'Meerut', 'Allahabad', 'Ghaziabad', 'Noida', 'Bareilly', 'Aligarh'],
  'Uttarakhand': ['Dehradun', 'Haridwar', 'Rishikesh', 'Haldwani', 'Roorkee', 'Nainital'],
  'West Bengal': ['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri', 'Kharagpur', 'Darjeeling'],
  'Delhi': ['New Delhi', 'Delhi'],
  'Chandigarh': ['Chandigarh'],
  'Puducherry': ['Puducherry', 'Karaikal', 'Mahe', 'Yanam'],
  'Jammu & Kashmir': ['Srinagar', 'Jammu', 'Anantnag', 'Baramulla', 'Udhampur'],
  'Ladakh': ['Leh', 'Kargil'],
};

function BranchesSection({ slug, client, branches, users, onReload }: {
  slug: string; client: any; branches: any[]; users: ClientUser[]; onReload: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [enabling, setEnabling] = useState(false);
  const [editingBranch, setEditingBranch] = useState<any>(null);

  const autoCode = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 20);
  interface StreamAccess { id: number; name: string; user_ids: number[] }
  interface BranchAccessData { is_restricted: boolean; user_ids: number[]; streams: StreamAccess[] }
  const [branchAccess, setBranchAccess] = useState<Record<number, BranchAccessData>>({});
  const [expandedBranch, setExpandedBranch] = useState<number | null>(null);
  const [savingBranch, setSavingBranch] = useState<number | null>(null);

  const nonAdminUsers = users.filter(u => u.role !== 'admin' && u.is_active);

  const loadAccess = useCallback(() => {
    const activeBranches = branches.filter(b => b.is_active);
    if (!client?.is_multi_branch || activeBranches.length === 0) return;
    Promise.all(
      activeBranches.map(b =>
        api.get(`/admin/clients/${slug}/branches/${b.id}/users`).then(res => ({ branchId: b.id, data: res.data }))
      )
    ).then(results => {
      const map: Record<number, BranchAccessData> = {};
      for (const r of results) {
        map[r.branchId] = { is_restricted: r.data.is_restricted, user_ids: r.data.user_ids, streams: r.data.streams || [] };
      }
      setBranchAccess(map);
    });
  }, [slug, branches, client?.is_multi_branch]);

  useEffect(() => { loadAccess(); }, [loadAccess]);

  const handleToggleRestrict = async (branchId: number) => {
    const current = branchAccess[branchId];
    const newRestricted = !current?.is_restricted;
    setSavingBranch(branchId);
    try {
      await api.put(`/admin/clients/${slug}/branches/${branchId}/users`, {
        restrict_access: newRestricted,
        stream_users: [],
      });
      const res = await api.get(`/admin/clients/${slug}/branches/${branchId}/users`);
      setBranchAccess(prev => ({ ...prev, [branchId]: { is_restricted: res.data.is_restricted, user_ids: res.data.user_ids, streams: res.data.streams || [] } }));
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update access');
    }
    setSavingBranch(null);
  };

  const handleStreamUserToggle = async (branchId: number, streamId: number, userId: number) => {
    const current = branchAccess[branchId];
    if (!current) return;
    const updatedStreams = current.streams.map(s => {
      if (s.id !== streamId) return { stream_id: s.id, user_ids: s.user_ids };
      const newIds = s.user_ids.includes(userId)
        ? s.user_ids.filter(id => id !== userId)
        : [...s.user_ids, userId];
      return { stream_id: s.id, user_ids: newIds };
    });
    const optimisticStreams = current.streams.map(s => {
      if (s.id !== streamId) return s;
      const newIds = s.user_ids.includes(userId)
        ? s.user_ids.filter(id => id !== userId)
        : [...s.user_ids, userId];
      return { ...s, user_ids: newIds };
    });
    const allUserIds = [...new Set(optimisticStreams.flatMap(s => s.user_ids))];
    setBranchAccess(prev => ({ ...prev, [branchId]: { is_restricted: true, user_ids: allUserIds, streams: optimisticStreams } }));

    setSavingBranch(branchId);
    try {
      await api.put(`/admin/clients/${slug}/branches/${branchId}/users`, {
        restrict_access: true,
        stream_users: updatedStreams,
      });
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to update');
      const res = await api.get(`/admin/clients/${slug}/branches/${branchId}/users`);
      setBranchAccess(prev => ({ ...prev, [branchId]: { is_restricted: res.data.is_restricted, user_ids: res.data.user_ids, streams: res.data.streams || [] } }));
    }
    setSavingBranch(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>
          {client?.is_multi_branch
            ? 'Multi-branch enabled — data is separated by branch'
            : 'Single-branch mode — enable multi-branch to manage locations'}
        </p>
        {!client?.is_multi_branch ? (
          <MultiBranchEnableButton
            enabling={enabling}
            onClick={async () => {
              const branchName = prompt('Default branch name (e.g. "Head Office"):');
              if (!branchName) return;
              const branchCode = prompt('Branch code (lowercase, e.g. "head-office"):');
              if (!branchCode) return;
              setEnabling(true);
              try {
                await api.post(`/admin/clients/${slug}/enable-multi-branch`, {
                  default_branch_name: branchName, default_branch_code: branchCode,
                });
                onReload();
              } catch (err: any) { alert(err.response?.data?.error || 'Failed'); }
              setEnabling(false);
            }}
          />
        ) : (
          <button onClick={() => setShowAdd(true)} className="mt-btn-gradient flex items-center gap-2 text-sm">
            <Plus size={14} /> Add Branch
          </button>
        )}
      </div>

      {showAdd && (
        <div className="mt-card p-5 mb-4">
          <h4 className="mt-heading text-sm mb-3">New Branch</h4>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Branch Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Koramangala Clinic" className="mt-input text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>State</label>
              <select value={state} onChange={e => { setState(e.target.value); setCity(''); }} className="mt-input text-sm">
                <option value="">Select state</option>
                {Object.keys(INDIAN_STATES_CITIES).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>City</label>
              <select value={city} onChange={e => setCity(e.target.value)} className="mt-input text-sm" disabled={!state}>
                <option value="">Select city</option>
                {(INDIAN_STATES_CITIES[state] || []).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                if (!name) return;
                await api.post(`/admin/clients/${slug}/branches`, {
                  name, code: autoCode(name), state: state || undefined, city: city || undefined,
                });
                setName(''); setState(''); setCity('');
                setShowAdd(false); onReload();
              }}
              disabled={!name}
              className="mt-btn-gradient text-xs"
            >Add Branch</button>
            <button onClick={() => setShowAdd(false)} className="mt-btn-soft text-xs">Cancel</button>
          </div>
        </div>
      )}

      {branches.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title={client?.is_multi_branch ? 'No branches configured' : 'Enable multi-branch to add locations'}
        />
      ) : (
        <div className="mt-card p-0 overflow-hidden">
          {branches.map((branch: any, i: number) => {
            const access = branchAccess[branch.id];
            const isRestricted = access?.is_restricted ?? false;
            const assignedIds = access?.user_ids ?? [];
            const isSaving = savingBranch === branch.id;
            const isExpanded = expandedBranch === branch.id;

            return (
              <div
                key={branch.id}
                style={{ borderBottom: i < branches.length - 1 ? '1px solid var(--mt-border)' : 'none' }}
              >
                <div className="flex items-center justify-between px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center"
                      style={{ background: TONES.accent.soft, border: `1px solid ${TONES.accent.border}` }}
                    >
                      <MapPin size={15} style={{ color: TONES.accent.fg }} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{branch.name}</span>
                        <span className="text-[10px] font-mono" style={{ color: 'var(--mt-text-faint)' }}>{branch.code}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
                        {branch.state && <span>{branch.state}</span>}
                        {branch.state && branch.city && <span>·</span>}
                        {branch.city && <span>{branch.city}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {client?.is_multi_branch && (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>Restrict Access</span>
                        <GhostToggle
                          enabled={isRestricted}
                          disabled={isSaving}
                          onClick={() => handleToggleRestrict(branch.id)}
                          tone="amber"
                        />
                      </div>
                    )}
                    {isRestricted && (
                      <button
                        onClick={() => setExpandedBranch(isExpanded ? null : branch.id)}
                        className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg transition-all"
                        style={{
                          background: TONES.amber.soft,
                          color: TONES.amber.fg,
                          border: `1px solid ${TONES.amber.border}`,
                        }}
                      >
                        <Users size={11} />
                        <span>{assignedIds.length} user{assignedIds.length !== 1 ? 's' : ''}</span>
                        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      </button>
                    )}
                    <IconHoverButton
                      icon={Edit2}
                      tone={TONES.blue}
                      onClick={() => setEditingBranch({ ...branch })}
                    />
                    <IconHoverButton
                      icon={Trash2}
                      tone={TONES.danger}
                      onClick={async () => {
                        if (!confirm(`Permanently delete branch "${branch.name}"? This cannot be undone.`)) return;
                        await api.delete(`/admin/clients/${slug}/branches/${branch.id}`);
                        onReload();
                      }}
                    />
                  </div>
                </div>

                {/* Edit branch inline form */}
                {editingBranch?.id === branch.id && (
                  <div className="px-5 pb-4 pt-0">
                    <div
                      className="rounded-xl p-4"
                      style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
                    >
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        <div>
                          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Branch Name</label>
                          <input type="text" value={editingBranch.name} onChange={e => setEditingBranch({ ...editingBranch, name: e.target.value })} className="mt-input text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>State</label>
                          <select value={editingBranch.state || ''} onChange={e => setEditingBranch({ ...editingBranch, state: e.target.value, city: '' })} className="mt-input text-sm">
                            <option value="">Select state</option>
                            {Object.keys(INDIAN_STATES_CITIES).map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>City</label>
                          <select value={editingBranch.city || ''} onChange={e => setEditingBranch({ ...editingBranch, city: e.target.value })} className="mt-input text-sm" disabled={!editingBranch.state}>
                            <option value="">Select city</option>
                            {(INDIAN_STATES_CITIES[editingBranch.state] || []).map((c: string) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            await api.put(`/admin/clients/${slug}/branches/${editingBranch.id}`, {
                              name: editingBranch.name, code: autoCode(editingBranch.name),
                              state: editingBranch.state || '', city: editingBranch.city || '',
                            });
                            setEditingBranch(null); onReload();
                          }}
                          disabled={!editingBranch.name}
                          className="mt-btn-gradient text-xs"
                        >Save</button>
                        <button onClick={() => setEditingBranch(null)} className="mt-btn-soft text-xs">Cancel</button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Expanded per-stream user assignments */}
                {isExpanded && isRestricted && branch.is_active && (
                  <div className="px-5 pb-4 pt-0">
                    <div className="ml-12">
                      <p className="text-[11px] mb-3" style={{ color: 'var(--mt-text-faint)' }}>
                        Assign users to each revenue stream <span style={{ color: 'var(--mt-text-muted)' }}>(admins always have full access)</span>
                      </p>
                      {(access?.streams ?? []).length === 0 ? (
                        <div
                          className="rounded-xl p-3"
                          style={{ background: TONES.amber.soft, border: `1px solid ${TONES.amber.border}` }}
                        >
                          <p className="text-[11px]" style={{ color: TONES.amber.fg }}>
                            No revenue streams configured for this branch. Add streams in the Revenue Streams tab first.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {(access?.streams ?? []).map(stream => (
                            <div
                              key={stream.id}
                              className="rounded-xl overflow-hidden"
                              style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
                            >
                              <div
                                className="flex items-center justify-between px-3.5 py-2.5"
                                style={{ borderBottom: '1px solid var(--mt-border)' }}
                              >
                                <div className="flex items-center gap-2">
                                  <Layers size={13} style={{ color: TONES.accent.fg }} />
                                  <span className="text-xs font-semibold" style={{ color: 'var(--mt-text)' }}>{stream.name}</span>
                                </div>
                                <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>
                                  {stream.user_ids.length} of {nonAdminUsers.length} users
                                </span>
                              </div>
                              <div className="p-2.5 space-y-0.5 max-h-40 overflow-y-auto">
                                {nonAdminUsers.map(user => (
                                  <StreamUserRow
                                    key={user.id}
                                    user={user}
                                    assigned={stream.user_ids.includes(user.id)}
                                    saving={isSaving}
                                    onToggle={() => handleStreamUserToggle(branch.id, stream.id, user.id)}
                                  />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MultiBranchEnableButton({ enabling, onClick }: { enabling: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={enabling}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-1.5 text-sm font-medium px-3.5 py-2 rounded-xl transition-all"
      style={{
        color: TONES.amber.fg,
        border: `1px solid ${TONES.amber.border}`,
        background: hover ? TONES.amber.soft : 'transparent',
      }}
    >
      <MapPin size={14} /> {enabling ? 'Enabling...' : 'Enable Multi-Branch'}
    </button>
  );
}

function StreamUserRow({ user, assigned, saving, onToggle }: {
  user: ClientUser; assigned: boolean; saving: boolean; onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer transition-all"
      style={{
        background: assigned
          ? TONES.accent.soft
          : hover ? 'var(--mt-bg-raised)' : 'transparent',
        opacity: saving ? 0.5 : 1,
        pointerEvents: saving ? 'none' : 'auto',
      }}
    >
      <input
        type="checkbox"
        checked={assigned}
        onChange={onToggle}
        className="w-3.5 h-3.5 rounded"
        style={{ accentColor: 'var(--mt-accent)' }}
      />
      <span className="text-sm" style={{ color: 'var(--mt-text-secondary)' }}>{user.display_name}</span>
      <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>@{user.username}</span>
    </label>
  );
}

/* ─── Team Assignment Section (Client Detail) ──────────── */

function TeamAssignmentSection({ slug }: { slug: string }) {
  const [assigned, setAssigned] = useState<any[]>([]);
  const [allTeam, setAllTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api.get(`/admin/clients/${slug}/team`),
      api.get('/admin/team'),
    ]).then(([assignedRes, teamRes]) => {
      setAssigned(assignedRes.data);
      setAllTeam(teamRes.data);
      setSelectedIds(new Set(assignedRes.data.map((m: any) => m.id)));
      setLoading(false);
    });
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  const toggleMember = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/admin/clients/${slug}/team`, { team_member_ids: Array.from(selectedIds) });
      setEditing(false);
      load();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save');
    }
    setSaving(false);
  };

  if (loading) return <LoadingSpinner />;

  const nonOwnerTeam = allTeam.filter(m => !m.is_owner && m.is_active);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>Team members assigned to manage this client</p>
        {!editing && (
          <button onClick={() => setEditing(true)} className="mt-btn-gradient flex items-center gap-2 text-sm">
            <Users size={14} /> Edit Assignments
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-card p-5 mb-4">
          <h4 className="mt-heading text-sm mb-3">Select Team Members</h4>
          {nonOwnerTeam.length === 0 ? (
            <p className="text-sm py-4" style={{ color: 'var(--mt-text-faint)' }}>
              No team members available. Add team members in the Team tab first.
            </p>
          ) : (
            <div className="space-y-1.5 mb-4">
              {nonOwnerTeam.map(member => (
                <SelectableMemberRow
                  key={member.id}
                  member={member}
                  selected={selectedIds.has(member.id)}
                  onToggle={() => toggleMember(member.id)}
                />
              ))}
            </div>
          )}
          <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid var(--mt-border)' }}>
            <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>{selectedIds.size} selected</span>
            <div className="flex gap-2">
              <button onClick={() => { setEditing(false); setSelectedIds(new Set(assigned.map((m: any) => m.id))); }} className="mt-btn-soft text-xs">Cancel</button>
              <button onClick={save} disabled={saving} className="mt-btn-gradient text-xs">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : assigned.length === 0 ? (
        <EmptyState
          icon={Shield}
          title="No team members assigned"
          subtitle={'Click "Edit Assignments" to assign team members'}
        />
      ) : (
        <div className="mt-card p-0 overflow-hidden">
          {assigned.map((member: any, i: number) => (
            <div
              key={member.id}
              className="flex items-center justify-between px-5 py-3.5"
              style={{ borderBottom: i < assigned.length - 1 ? '1px solid var(--mt-border)' : 'none' }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center"
                  style={{ background: TONES.purple.soft, border: `1px solid ${TONES.purple.border}` }}
                >
                  <Shield size={15} style={{ color: TONES.purple.fg }} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{member.display_name}</span>
                    <span className="text-[11px] font-mono" style={{ color: 'var(--mt-text-faint)' }}>@{member.username}</span>
                  </div>
                </div>
              </div>
              <span
                className="text-[10px] font-medium px-2.5 py-1 rounded-full"
                style={{
                  background: member.is_active ? TONES.accent.soft : TONES.danger.soft,
                  color: member.is_active ? TONES.accent.fg : TONES.danger.fg,
                }}
              >
                {member.is_active ? 'Active' : 'Disabled'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectableMemberRow({ member, selected, onToggle }: {
  member: TeamMember; selected: boolean; onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all"
      style={{
        background: selected
          ? TONES.accent.soft
          : hover ? 'var(--mt-bg-muted)' : 'var(--mt-bg-raised)',
        border: '1px solid ' + (selected ? TONES.accent.border : 'var(--mt-border)'),
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="w-4 h-4 rounded"
        style={{ accentColor: 'var(--mt-accent)' }}
      />
      <div>
        <span className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{member.display_name}</span>
        <span className="text-[11px] font-mono ml-2" style={{ color: 'var(--mt-text-faint)' }}>@{member.username}</span>
      </div>
    </label>
  );
}

/* ─── Reset Password Modal ──────────────────────────────── */

function ResetPasswordModal({ username, onConfirm, onCancel }: {
  username: string;
  onConfirm: (customPw?: string) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'auto' | 'custom'>('auto');
  const [customPw, setCustomPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');

  const handleConfirm = () => {
    if (mode === 'custom') {
      if (!customPw) return;
      if (customPw.length < 8) { setError('Min 8 characters'); return; }
      if (!/[a-zA-Z]/.test(customPw)) { setError('Must contain a letter'); return; }
      if (!/[0-9]/.test(customPw)) { setError('Must contain a number'); return; }
      onConfirm(customPw);
    } else {
      onConfirm();
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl"
        style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="mt-heading mb-2">Reset Password</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--mt-text-muted)' }}>
          Reset password for <span className="font-medium" style={{ color: 'var(--mt-accent-text)' }}>@{username}</span>?
        </p>

        <div className="space-y-2 mb-4">
          <RadioRow selected={mode === 'auto'} onClick={() => setMode('auto')}>
            <span className="text-sm" style={{ color: 'var(--mt-text)' }}>Generate random password</span>
          </RadioRow>
          <RadioRow selected={mode === 'custom'} onClick={() => setMode('custom')}>
            <div className="flex-1">
              <span className="text-sm" style={{ color: 'var(--mt-text)' }}>Set custom password</span>
              {mode === 'custom' && (
                <div className="mt-2">
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={customPw}
                      onChange={e => { setCustomPw(e.target.value); setError(''); }}
                      placeholder="Min 8 chars, letter + number"
                      className="mt-input text-sm w-full pr-9"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(!showPw)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors"
                      style={{ color: 'var(--mt-text-faint)' }}
                    >
                      {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {error && <p className="text-xs mt-1" style={{ color: TONES.danger.fg }}>{error}</p>}
                </div>
              )}
            </div>
          </RadioRow>
        </div>

        <div className="flex gap-2">
          <button onClick={onCancel} className="mt-btn-soft text-sm flex-1">Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={mode === 'custom' && !customPw}
            className="mt-btn-gradient text-sm flex-1"
          >
            Reset Password
          </button>
        </div>
      </div>
    </div>
  );
}

function RadioRow({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-start gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all"
      style={{
        background: selected
          ? TONES.accent.soft
          : hover ? 'var(--mt-bg-muted)' : 'var(--mt-bg-raised)',
        border: '1px solid ' + (selected ? TONES.accent.border : 'var(--mt-border)'),
      }}
    >
      <input
        type="radio"
        checked={selected}
        onChange={onClick}
        className="w-3.5 h-3.5 mt-0.5"
        style={{ accentColor: 'var(--mt-accent)' }}
      />
      {children}
    </label>
  );
}

/* ─── Add User Form ──────────────────────────────────────── */

function AddUserForm({ slug, onAdded, onCancel }: { slug: string; onAdded: () => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{username: string; password: string; role: string} | null>(null);

  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.post(`/admin/clients/${slug}/users`, { username, password, display_name: displayName, role });
      setCreated({ username, password, role });
    } catch (err: any) { setError(err.response?.data?.error || 'Failed'); }
    setSaving(false);
  };

  if (created) {
    return (
      <div
        className="rounded-2xl p-5 mb-4"
        style={{ background: 'var(--mt-bg-raised)', border: `1px solid ${TONES.accent.border}` }}
      >
        <div className="flex items-center gap-3 mb-3">
          <CheckCircle size={18} style={{ color: TONES.accent.fg }} />
          <h4 className="text-sm font-semibold" style={{ color: TONES.accent.fg }}>User Created</h4>
        </div>
        <div
          className="rounded-xl p-3 mb-3"
          style={{ background: 'var(--mt-bg-app)', border: '1px solid var(--mt-border)' }}
        >
          <p className="font-mono text-sm" style={{ color: 'var(--mt-text)' }}>
            Username: <span style={{ color: TONES.accent.fg }}>@{created.username}</span>
          </p>
          <div className="flex items-center justify-between mt-1">
            <p className="font-mono text-sm" style={{ color: 'var(--mt-text)' }}>
              Password: <span style={{ color: TONES.accent.fg }}>{created.password}</span>
            </p>
            <button
              onClick={() => navigator.clipboard.writeText(created.password)}
              style={{ color: 'var(--mt-text-muted)' }}
            >
              <Copy size={14} />
            </button>
          </div>
          <p className="font-mono text-sm mt-1" style={{ color: 'var(--mt-text)' }}>
            Role: <span style={{ color: created.role === 'admin' ? TONES.amber.fg : 'var(--mt-text-muted)' }}>{created.role}</span>
          </p>
        </div>
        <p className="text-xs mb-3" style={{ color: TONES.amber.fg }}>Save these credentials — the password won't be shown again</p>
        <button onClick={onAdded} className="mt-btn-gradient text-xs">Done</button>
      </div>
    );
  }

  return (
    <div className="mt-card p-5 mb-4">
      <h4 className="mt-heading text-sm mb-3">Add New User</h4>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Display Name</label>
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="John Doe" className="mt-input text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="john" className="mt-input text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Min 8 chars, letter + number" className="mt-input text-sm pr-9" />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--mt-text-faint)' }}
            >
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Role</label>
          <select value={role} onChange={e => setRole(e.target.value as 'user' | 'admin')} className="mt-input text-sm">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      {error && <p className="text-xs mb-2" style={{ color: TONES.danger.fg }}>{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !username || !password || !displayName} className="mt-btn-gradient text-xs">
          {saving ? 'Adding...' : 'Add User'}
        </button>
        <button onClick={onCancel} className="mt-btn-soft text-xs">Cancel</button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TEAM PANEL
   ═══════════════════════════════════════════════════════════ */

function TeamPanel() {
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [resetResult, setResetResult] = useState<{username: string; password: string} | null>(null);
  const [resetConfirm, setResetConfirm] = useState<{id: number; username: string} | null>(null);
  const [assignMember, setAssignMember] = useState<TeamMember | null>(null);

  const loadTeam = useCallback(() => {
    api.get('/admin/team').then(res => { setTeam(res.data); setLoading(false); });
  }, []);

  useEffect(() => { loadTeam(); }, [loadTeam]);

  const resetPassword = async (id: number, username: string, customPw?: string) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const newPw = customPw || Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    try {
      await api.put(`/admin/team/${id}`, { password: newPw });
      setResetConfirm(null);
      setResetResult({ username, password: newPw });
    } catch (err: any) { alert(err.response?.data?.error || 'Failed'); }
  };

  const toggleMemberActive = async (id: number, isActive: number) => {
    await api.put(`/admin/team/${id}`, { is_active: !isActive });
    loadTeam();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>Manage your team and assign clients to each member</p>
        <button onClick={() => setShowAdd(true)} className="mt-btn-gradient flex items-center gap-2 text-sm">
          <UserPlus size={14} /> Add Member
        </button>
      </div>

      {showAdd && (
        <AddTeamMemberForm onAdded={() => { setShowAdd(false); loadTeam(); }} onCancel={() => setShowAdd(false)} />
      )}

      {loading ? (
        <LoadingSpinner />
      ) : team.length === 0 ? (
        <EmptyState icon={Shield} title="No team members" />
      ) : (
        <div className="mt-card p-0 overflow-hidden">
          {team.map((member, i) => (
            <div
              key={member.id}
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: i < team.length - 1 ? '1px solid var(--mt-border)' : 'none' }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{
                    background: member.is_owner ? TONES.amber.soft : TONES.purple.soft,
                    border: `1px solid ${member.is_owner ? TONES.amber.border : TONES.purple.border}`,
                  }}
                >
                  <Shield size={17} style={{ color: member.is_owner ? TONES.amber.fg : TONES.purple.fg }} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold" style={{ color: 'var(--mt-text)' }}>{member.display_name}</span>
                    <span className="text-[11px] font-mono" style={{ color: 'var(--mt-text-faint)' }}>@{member.username}</span>
                    {member.is_owner ? (
                      <span
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider"
                        style={{ background: TONES.amber.soft, color: TONES.amber.fg, border: `1px solid ${TONES.amber.border}` }}
                      >Owner</span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
                      {member.is_owner
                        ? 'All clients'
                        : `${member.assigned_client_count} client${member.assigned_client_count !== 1 ? 's' : ''} assigned`
                      }
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!member.is_owner && (
                  <ToneButton icon={Building2} label="Assign Clients" tone={TONES.accent} onClick={() => setAssignMember(member)} />
                )}
                <MutedButton icon={KeyRound} label="Reset PW" onClick={() => setResetConfirm({ id: member.id, username: member.username })} />
                {!member.is_owner && (
                  <StatusToggleButton active={!!member.is_active} onClick={() => toggleMemberActive(member.id, member.is_active)} />
                )}
                {member.is_owner && (
                  <span
                    className="text-[11px] font-medium px-2.5 py-1 rounded-full"
                    style={{ background: TONES.accent.soft, color: TONES.accent.fg }}
                  >
                    Active
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Assign Clients Modal */}
      {assignMember && (
        <AssignClientsModal
          member={assignMember}
          onClose={() => { setAssignMember(null); loadTeam(); }}
        />
      )}

      {/* Password Reset Confirmation Modal */}
      {resetConfirm && (
        <ResetPasswordModal
          username={resetConfirm.username}
          onConfirm={(customPw) => resetPassword(resetConfirm.id, resetConfirm.username, customPw)}
          onCancel={() => setResetConfirm(null)}
        />
      )}

      {/* Password Reset Result Modal */}
      {resetResult && (
        <PasswordResultModal result={resetResult} onClose={() => setResetResult(null)} />
      )}
    </div>
  );
}

/* ─── Assign Clients Modal ──────────────────────────────── */

function AssignClientsModal({ member, onClose }: { member: TeamMember; onClose: () => void }) {
  const [allClients, setAllClients] = useState<Client[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/admin/clients'),
      api.get(`/admin/team/${member.id}/clients`),
    ]).then(([clientsRes, assignedRes]) => {
      setAllClients(clientsRes.data);
      setAssignedIds(new Set(assignedRes.data.map((c: any) => c.id)));
      setLoading(false);
    });
  }, [member.id]);

  const toggle = (clientId: number) => {
    setAssignedIds(prev => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/admin/team/${member.id}/clients`, { client_ids: Array.from(assignedIds) });
      onClose();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl max-h-[80vh] flex flex-col"
        style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="mt-heading mb-1">Assign Clients</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--mt-text-faint)' }}>
          Select which clients <span className="font-medium" style={{ color: 'var(--mt-accent-text)' }}>{member.display_name}</span> can access
        </p>

        {loading ? (
          <LoadingSpinner />
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1 mb-4 pr-1">
            {allClients.filter(c => c.is_active).map(client => (
              <ClientCheckRow
                key={client.id}
                client={client}
                selected={assignedIds.has(client.id)}
                onToggle={() => toggle(client.id)}
              />
            ))}
            {allClients.filter(c => c.is_active).length === 0 && (
              <p className="text-center text-sm py-4" style={{ color: 'var(--mt-text-faint)' }}>No active clients</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-3" style={{ borderTop: '1px solid var(--mt-border)' }}>
          <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>{assignedIds.size} selected</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="mt-btn-soft text-sm">Cancel</button>
            <button onClick={save} disabled={saving} className="mt-btn-gradient text-sm">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClientCheckRow({ client, selected, onToggle }: { client: Client; selected: boolean; onToggle: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all"
      style={{
        background: selected
          ? TONES.accent.soft
          : hover ? 'var(--mt-bg-muted)' : 'var(--mt-bg-raised)',
        border: '1px solid ' + (selected ? TONES.accent.border : 'var(--mt-border)'),
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="w-4 h-4 rounded"
        style={{ accentColor: 'var(--mt-accent)' }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium" style={{ color: 'var(--mt-text)' }}>{client.name}</div>
        <div className="text-[11px] font-mono" style={{ color: 'var(--mt-text-faint)' }}>{client.slug}</div>
      </div>
      <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>{client.user_count} users</span>
    </label>
  );
}

/* ─── Add Team Member Form ───────────────────────────────── */

function AddTeamMemberForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{username: string; password: string} | null>(null);

  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.post('/admin/team', { username, password, display_name: displayName, role: 'super_admin' });
      setCreated({ username, password });
    } catch (err: any) { setError(err.response?.data?.error || 'Failed'); }
    setSaving(false);
  };

  if (created) {
    return (
      <div
        className="rounded-2xl p-5 mb-4"
        style={{ background: 'var(--mt-bg-raised)', border: `1px solid ${TONES.accent.border}` }}
      >
        <div className="flex items-center gap-3 mb-3">
          <CheckCircle size={18} style={{ color: TONES.accent.fg }} />
          <h4 className="text-sm font-semibold" style={{ color: TONES.accent.fg }}>Team Member Created</h4>
        </div>
        <div
          className="rounded-xl p-3 mb-3"
          style={{ background: 'var(--mt-bg-app)', border: '1px solid var(--mt-border)' }}
        >
          <p className="font-mono text-sm" style={{ color: 'var(--mt-text)' }}>
            Username: <span style={{ color: TONES.accent.fg }}>@{created.username}</span>
          </p>
          <div className="flex items-center justify-between mt-1">
            <p className="font-mono text-sm" style={{ color: 'var(--mt-text)' }}>
              Password: <span style={{ color: TONES.accent.fg }}>{created.password}</span>
            </p>
            <button
              onClick={() => navigator.clipboard.writeText(created.password)}
              style={{ color: 'var(--mt-text-muted)' }}
            >
              <Copy size={14} />
            </button>
          </div>
        </div>
        <p className="text-xs mb-3" style={{ color: TONES.amber.fg }}>Save these credentials — the password won't be shown again</p>
        <button onClick={onAdded} className="mt-btn-gradient text-xs">Done</button>
      </div>
    );
  }

  return (
    <div className="mt-card p-5 mb-4">
      <h4 className="mt-heading text-sm mb-3">Add Team Member</h4>
      <p className="text-xs mb-3" style={{ color: 'var(--mt-text-faint)' }}>New team members need client assignments to access client data</p>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Display Name</label>
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Jane Smith" className="mt-input text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="jane" className="mt-input text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Strong password" className="mt-input text-sm pr-9" />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--mt-text-faint)' }}
            >
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>
      {error && <p className="text-xs mb-2" style={{ color: TONES.danger.fg }}>{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !username || !password || !displayName} className="mt-btn-gradient text-xs">
          {saving ? 'Adding...' : 'Add Member'}
        </button>
        <button onClick={onCancel} className="mt-btn-soft text-xs">Cancel</button>
      </div>
    </div>
  );
}
