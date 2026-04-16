import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import {
  Building2, Users, UserPlus, Plus, Power, ArrowLeft,
  Eye, EyeOff, CheckCircle, Plug, Shield, Trash2, Copy, KeyRound, BarChart3,
  MapPin, GitBranch, Layers, Search, Activity, Globe, ChevronRight, ChevronDown,
  ChevronUp, LayoutDashboard, Edit2, Calendar, Stethoscope, Upload, Server, BookOpen,
} from 'lucide-react';

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

type Tab = 'clients' | 'team';
type ClientDetailTab = 'users' | 'modules' | 'integrations' | 'streams' | 'dashboard_cards' | 'branches' | 'assigned_team';

/* ─── Main Page ──────────────────────────────────────────── */

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('clients');
  const isOwner = localStorage.getItem('is_owner') === '1';

  // Build tab list — only owner sees Team tab
  const tabs = [
    { key: 'clients' as Tab, label: 'Clients', icon: Building2 },
    ...(isOwner ? [{ key: 'team' as Tab, label: 'Team', icon: Shield }] : []),
  ];

  return (
    <div className="animate-fade-in max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-accent-500 to-accent-600 flex items-center justify-center shadow-lg shadow-accent-500/20">
            <Shield size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-theme-heading">Admin Panel</h1>
            <p className="text-theme-faint text-sm">Manage clients, users, and platform settings</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-dark-400/30 mb-6">
        <div className="flex gap-0">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-5 py-3.5 text-sm font-medium border-b-2 transition-all ${
                tab === t.key
                  ? 'border-accent-500 text-accent-400'
                  : 'border-transparent text-theme-faint hover:text-theme-secondary'
              }`}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'clients' && <ClientsPanel />}
      {tab === 'team' && isOwner && <TeamPanel />}
    </div>
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

  return (
    <div>
      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-dark-700/60 rounded-2xl p-5 border border-dark-400/20">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-theme-faint uppercase tracking-wider">Total Clients</span>
            <div className="w-8 h-8 rounded-xl bg-accent-500/10 flex items-center justify-center">
              <Building2 size={15} className="text-accent-400" />
            </div>
          </div>
          <div className="text-3xl font-bold text-theme-heading">{clients.length}</div>
          <p className="text-xs text-theme-faint mt-1">{activeCount} active</p>
        </div>
        <div className="bg-dark-700/60 rounded-2xl p-5 border border-dark-400/20">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-theme-faint uppercase tracking-wider">Total Users</span>
            <div className="w-8 h-8 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <Users size={15} className="text-blue-400" />
            </div>
          </div>
          <div className="text-3xl font-bold text-theme-heading">{totalUsers}</div>
          <p className="text-xs text-theme-faint mt-1">Across all clients</p>
        </div>
        <div className="bg-dark-700/60 rounded-2xl p-5 border border-dark-400/20">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-theme-faint uppercase tracking-wider">Status</span>
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center">
              <Activity size={15} className="text-emerald-400" />
            </div>
          </div>
          <div className="text-3xl font-bold text-emerald-400">Live</div>
          <p className="text-xs text-theme-faint mt-1">Platform operational</p>
        </div>
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
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search clients..."
            className="input pl-9 text-sm py-2"
          />
        </div>
        {isOwner && (
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={15} /> New Client
          </button>
        )}
      </div>

      {/* Client List */}
      {loading ? (
        <div className="text-center py-16">
          <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-dark-700/30 rounded-2xl border border-dark-400/20">
          <Building2 size={32} className="text-theme-faint mx-auto mb-3" />
          <p className="text-theme-muted text-sm font-medium">{search ? 'No matching clients' : 'No clients yet'}</p>
          <p className="text-theme-faint text-xs mt-1">{search ? 'Try a different search term' : 'Create your first client to get started'}</p>
        </div>
      ) : (
        <div className="bg-dark-700/40 rounded-2xl border border-dark-400/20 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-dark-400/30">
                <th className="text-left py-3 px-5 text-xs font-semibold text-theme-faint uppercase tracking-wider">Client</th>
                <th className="text-left py-3 px-5 text-xs font-semibold text-theme-faint uppercase tracking-wider">Users</th>
                <th className="text-left py-3 px-5 text-xs font-semibold text-theme-faint uppercase tracking-wider">Integrations</th>
                <th className="text-left py-3 px-5 text-xs font-semibold text-theme-faint uppercase tracking-wider">Status</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(client => (
                <tr
                  key={client.id}
                  onClick={() => setSelectedSlug(client.slug)}
                  className="border-b border-dark-400/15 hover:bg-dark-600/50 cursor-pointer transition-colors group"
                >
                  <td className="py-3.5 px-5">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-accent-500/10 flex items-center justify-center flex-shrink-0">
                        <Building2 size={16} className="text-accent-400" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-theme-heading">{client.name}</div>
                        <div className="text-[11px] text-theme-faint font-mono">{client.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3.5 px-5">
                    <span className="text-sm text-theme-secondary">{client.user_count}</span>
                  </td>
                  <td className="py-3.5 px-5">
                    {client.integrations ? (
                      <div className="flex gap-1.5 flex-wrap">
                        {client.integrations.split(',').map(i => (
                          <span key={i} className="text-[10px] bg-dark-500 text-theme-muted px-2 py-0.5 rounded-full">{i.trim()}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-theme-faint">None</span>
                    )}
                  </td>
                  <td className="py-3.5 px-5">
                    {client.is_active ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-400 bg-red-500/10 px-2.5 py-1 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-2">
                    <ChevronRight size={16} className="text-theme-faint group-hover:text-accent-400 transition-colors" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
      <div className="bg-dark-700/60 rounded-2xl border border-accent-500/30 p-6 mb-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-2xl bg-accent-500/15 flex items-center justify-center">
            <CheckCircle size={20} className="text-accent-400" />
          </div>
          <div>
            <h3 className="font-semibold text-accent-300 text-base">Client Created</h3>
            <p className="text-sm text-theme-faint">{result.name}</p>
          </div>
        </div>
        <div className="bg-dark-800 rounded-xl p-4 mb-5 border border-dark-400/20">
          <p className="text-xs font-medium text-theme-faint uppercase tracking-wider mb-2">Default Login Credentials</p>
          <p className="text-theme-heading font-mono text-sm">Username: <span className="text-accent-400">admin</span></p>
          <p className="text-theme-heading font-mono text-sm">Password: <span className="text-accent-400">admin123</span></p>
          <p className="text-xs text-amber-400 mt-3 flex items-center gap-1">Change this password immediately after first login</p>
        </div>
        <button onClick={onCreated} className="btn-primary text-sm">Done</button>
      </div>
    );
  }

  return (
    <div className="bg-dark-700/60 rounded-2xl border border-dark-400/20 p-6 mb-6">
      <h3 className="font-semibold text-theme-heading text-base mb-5">Create New Client</h3>
      <div className="grid grid-cols-2 gap-4 mb-5">
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1.5">Client Name</label>
          <input type="text" value={name} onChange={e => autoSlug(e.target.value)}
            placeholder="e.g. Acme Corp" className="input" />
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1.5">Slug (URL identifier)</label>
          <input type="text" value={slug} onChange={e => setSlug(e.target.value)}
            placeholder="e.g. apollo-healthcare" className="input font-mono" />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-theme-muted mb-2">Industry</label>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {industries.map((ind: any) => (
              <button
                key={ind.key}
                type="button"
                onClick={() => setIndustry(ind.key)}
                className={`text-left px-3 py-2.5 rounded-xl border transition-all ${
                  industry === ind.key
                    ? 'border-accent-500 bg-accent-500/10 text-accent-400'
                    : 'border-dark-400/30 bg-dark-600/50 text-theme-muted hover:border-dark-300'
                }`}
              >
                <div className="text-sm font-medium">{ind.label}</div>
                <div className="text-[10px] text-theme-faint mt-0.5">{ind.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Team Member Assignment — Dropdown */}
      {teamMembers.filter(m => !m.is_owner).length > 0 && (
        <div className="mb-5">
          <label className="block text-xs font-medium text-theme-muted mb-1.5">Assign Team Members</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMemberDropdown(!showMemberDropdown)}
              className="w-full flex items-center justify-between input text-sm cursor-pointer"
            >
              <span className={selectedMembers.size > 0 ? 'text-theme-heading' : 'text-theme-faint'}>
                {selectedMembers.size > 0
                  ? teamMembers.filter(m => selectedMembers.has(m.id)).map(m => m.display_name).join(', ')
                  : 'Select team members...'}
              </span>
              <ChevronRight size={14} className={`text-theme-faint transition-transform ${showMemberDropdown ? 'rotate-90' : ''}`} />
            </button>
            {showMemberDropdown && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-dark-700 border border-dark-400/30 rounded-xl shadow-xl z-50 max-h-48 overflow-y-auto">
                {teamMembers.filter(m => !m.is_owner && m.is_active).map(member => (
                  <label
                    key={member.id}
                    className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-dark-600/70 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedMembers.has(member.id)}
                      onChange={() => toggleMember(member.id)}
                      className="w-3.5 h-3.5 rounded border-dark-300 text-accent-500 focus:ring-accent-500 bg-dark-800"
                    />
                    <span className="text-sm font-medium text-theme-heading">{member.display_name}</span>
                    <span className="text-[11px] font-mono text-theme-faint">@{member.username}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2.5 rounded-xl mb-4 text-sm">{error}</div>
      )}
      <div className="flex gap-3">
        <button onClick={create} disabled={saving || !name || !slug} className="btn-primary text-sm">
          {saving ? 'Creating...' : 'Create Client'}
        </button>
        <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
      </div>
    </div>
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

  if (loading) return (
    <div className="text-center py-16">
      <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
    </div>
  );

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
      <button onClick={onBack} className="flex items-center gap-2 text-sm text-theme-muted hover:text-accent-400 mb-5 transition-colors">
        <ArrowLeft size={15} /> Back to clients
      </button>

      {/* Client Header */}
      <div className="bg-dark-700/60 rounded-2xl border border-dark-400/20 p-6 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-accent-500/20 to-accent-600/10 flex items-center justify-center border border-accent-500/20">
              <Building2 size={24} className="text-accent-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-theme-heading">{client.name}</h2>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-sm text-theme-faint font-mono">{client.slug}</span>
                <span className="text-dark-300">·</span>
                <select
                  value={client.industry || 'custom'}
                  onChange={e => changeIndustry(e.target.value)}
                  className="text-sm bg-transparent text-theme-secondary border-none cursor-pointer hover:text-accent-400 transition-colors p-0"
                >
                  {industries.map((ind: any) => (
                    <option key={ind.key} value={ind.key}>{ind.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {client.is_active ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Active
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400 bg-red-500/10 px-3 py-1.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                Inactive
              </span>
            )}
            <button
              onClick={toggleActive}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
                client.is_active
                  ? 'text-red-400 hover:bg-red-500/10 border border-red-500/20'
                  : 'text-accent-400 hover:bg-accent-500/10 border border-accent-500/20'
              }`}
            >
              <Power size={14} />
              {client.is_active ? 'Deactivate' : 'Activate'}
            </button>
            {isOwnerUser && (
              <button
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
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-all"
              >
                <Trash2 size={14} />
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Detail Tabs */}
      <div className="border-b border-dark-400/30 mb-6">
        <div className="flex gap-0">
          {detailTabs.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-2 px-4 py-3 text-[13px] font-medium border-b-2 transition-all ${
                activeTab === t.key
                  ? 'border-accent-500 text-accent-400'
                  : 'border-transparent text-theme-faint hover:text-theme-secondary'
              }`}
            >
              <t.icon size={14} />
              {t.label}
              {t.count !== undefined && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  activeTab === t.key ? 'bg-accent-500/15 text-accent-400' : 'bg-dark-500 text-theme-faint'
                }`}>{t.count}</span>
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
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setResetResult(null)}>
          <div className="bg-dark-700 rounded-2xl p-6 max-w-sm w-full mx-4 border border-dark-400/30 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle size={18} className="text-emerald-400" />
              <h3 className="font-semibold text-theme-heading">Password Reset</h3>
            </div>
            <p className="text-sm text-theme-muted mb-3">New credentials for <span className="text-accent-400 font-medium">@{resetResult.username}</span></p>
            <div className="bg-dark-800 rounded-xl p-3 font-mono text-sm text-theme-heading mb-4 flex items-center justify-between border border-dark-400/20">
              <span>{resetResult.password}</span>
              <button onClick={() => navigator.clipboard.writeText(resetResult.password)} className="text-theme-muted hover:text-accent-400 transition-colors" title="Copy">
                <Copy size={14} />
              </button>
            </div>
            <p className="text-xs text-amber-400 mb-4">Save this password — it won't be shown again</p>
            <button onClick={() => setResetResult(null)} className="btn-primary text-sm w-full">Done</button>
          </div>
        </div>
      )}
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
        <p className="text-sm text-theme-faint">Manage user accounts for this client</p>
        <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2 text-sm">
          <UserPlus size={14} /> Add User
        </button>
      </div>

      {showAdd && (
        <AddUserForm slug={slug} onAdded={() => { setShowAdd(false); onReload(); }} onCancel={() => setShowAdd(false)} />
      )}

      {users.length === 0 ? (
        <div className="text-center py-12 bg-dark-700/30 rounded-2xl border border-dark-400/20">
          <Users size={28} className="text-theme-faint mx-auto mb-2" />
          <p className="text-theme-muted text-sm">No users yet</p>
        </div>
      ) : (
        <div className="bg-dark-700/40 rounded-2xl border border-dark-400/20 overflow-hidden">
          {users.map((user, i) => (
            <div key={user.id} className={`flex items-center justify-between px-5 py-3.5 ${i < users.length - 1 ? 'border-b border-dark-400/15' : ''}`}>
              <div className="flex items-center gap-3">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold ${
                  user.role === 'admin' ? 'bg-amber-500/10 text-amber-400' : 'bg-dark-500 text-theme-muted'
                }`}>
                  {user.display_name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-theme-heading">{user.display_name}</span>
                    <span className="text-[11px] font-mono text-theme-faint">@{user.username}</span>
                  </div>
                  <span className={`text-[10px] font-semibold uppercase tracking-wider ${user.role === 'admin' ? 'text-amber-400' : 'text-theme-faint'}`}>
                    {user.role}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAccessUser(user)}
                  className="text-xs px-2.5 py-1.5 rounded-lg text-accent-400 hover:text-accent-300 bg-accent-500/10 hover:bg-accent-500/15 transition-all flex items-center gap-1"
                >
                  <MapPin size={11} /> Access
                </button>
                <button
                  onClick={() => resetPassword(user.id, user.username)}
                  className="text-xs px-2.5 py-1.5 rounded-lg text-theme-muted hover:text-theme-secondary bg-dark-600 hover:bg-dark-500 transition-all flex items-center gap-1"
                >
                  <KeyRound size={11} /> Reset PW
                </button>
                <button
                  onClick={() => toggleUserActive(user.id, user.is_active)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all ${
                    user.is_active
                      ? 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20'
                      : 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
                  }`}
                >
                  {user.is_active ? 'Active' : 'Disabled'}
                </button>
                <button
                  onClick={async () => {
                    if (!confirm(`Delete user "${user.display_name}" (@${user.username})? This cannot be undone.`)) return;
                    await api.delete(`/admin/clients/${slug}/users/${user.id}`);
                    onReload();
                  }}
                  className="text-xs p-1.5 rounded-lg text-theme-faint hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
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

/* ─── User Access Modal ─────────────────────────────────── */

function UserAccessModal({ slug, user, onClose }: { slug: string; user: ClientUser; onClose: () => void }) {
  const [branches, setBranches] = useState<any[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [access, setAccess] = useState<Set<string>>(new Set()); // "branchId-streamId"
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

  // Group branches by state
  const stateGroups = new Map<string, any[]>();
  for (const b of branches) {
    const st = b.state || '';
    if (!stateGroups.has(st)) stateGroups.set(st, []);
    stateGroups.get(st)!.push(b);
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-dark-700 rounded-2xl p-6 max-w-lg w-full mx-4 border border-dark-400/30 shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-theme-heading mb-1">Branch & Stream Access</h3>
        <p className="text-sm text-theme-faint mb-4">
          Configure access for <span className="text-accent-400 font-medium">{user.display_name}</span>
        </p>

        {loading ? (
          <div className="text-center py-8">
            <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
          </div>
        ) : streams.length === 0 ? (
          <p className="text-sm text-theme-faint py-4">No streams configured. Add streams to the client first.</p>
        ) : (
          <div className="flex-1 overflow-y-auto mb-4">
            {/* Header row */}
            <div className="flex items-center gap-2 mb-2 px-1">
              <div className="w-28 text-[10px] font-semibold text-theme-faint uppercase">Branch</div>
              {streams.map((s: any) => (
                <div key={s.id} className="flex-1 text-center text-[10px] font-semibold text-theme-faint uppercase truncate">{s.name}</div>
              ))}
            </div>
            {/* Branch rows grouped by state */}
            {Array.from(stateGroups.entries()).map(([stateName, stateBranches]) => (
              <div key={stateName || '__none'}>
                {stateName && (
                  <div className="text-[10px] font-bold text-theme-faint uppercase tracking-wider px-1 pt-2 pb-1">{stateName}</div>
                )}
                {stateBranches.map((branch: any) => {
                  const branchKeys = streams.map((s: any) => `${branch.id}-${s.id}`);
                  const allChecked = branchKeys.every(k => access.has(k));
                  return (
                    <div key={branch.id} className="flex items-center gap-2 py-1.5 px-1 rounded-lg hover:bg-dark-600/50">
                      <button
                        onClick={() => toggleBranch(branch.id)}
                        className={`w-28 text-left text-xs font-medium truncate ${allChecked ? 'text-accent-400' : 'text-theme-secondary'}`}
                        title="Toggle all streams"
                      >
                        {branch.name}
                      </button>
                      {streams.map((stream: any) => (
                        <div key={stream.id} className="flex-1 flex justify-center">
                          <input
                            type="checkbox"
                            checked={access.has(`${branch.id}-${stream.id}`)}
                            onChange={() => toggleAccess(branch.id, stream.id)}
                            className="w-4 h-4 rounded border-dark-300 text-accent-500 focus:ring-accent-500 bg-dark-800"
                          />
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-dark-400/30">
          <span className="text-xs text-theme-faint">{access.size} permissions</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
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
      <p className="text-sm text-theme-faint mb-4">Enable or disable modules for this client</p>
      <div className="grid grid-cols-2 gap-3">
        {allModules.map(mod => {
          const m = modules.find(x => x.module_key === mod.key);
          const enabled = !!m?.is_enabled;
          return (
            <div key={mod.key} className={`rounded-2xl p-5 border transition-all ${
              enabled
                ? 'bg-accent-500/5 border-accent-500/20'
                : 'bg-dark-700/40 border-dark-400/20'
            }`}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-2xl">{mod.icon}</span>
                <button
                  onClick={async () => {
                    await api.put(`/admin/clients/${slug}/modules/${mod.key}`, { is_enabled: !enabled });
                    onReload();
                  }}
                  className={`relative w-11 h-6 rounded-full transition-all ${enabled ? 'bg-accent-500' : 'bg-dark-400'}`}
                >
                  <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow-sm ${enabled ? 'left-[24px]' : 'left-1'}`} />
                </button>
              </div>
              <h4 className={`text-sm font-semibold ${enabled ? 'text-theme-heading' : 'text-theme-muted'}`}>{mod.name}</h4>
              <p className="text-xs text-theme-faint mt-1">{mod.desc}</p>
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
      <div key={int.key} className="flex items-center justify-between px-5 py-4 rounded-2xl bg-dark-700/40 border border-dark-400/20">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${int.enabled ? 'bg-accent-500/10' : 'bg-dark-500'}`}>
            <Icon size={16} className={int.enabled ? 'text-accent-400' : 'text-theme-faint'} />
          </div>
          <div>
            <span className="text-sm font-medium text-theme-heading">{int.name}</span>
            <p className="text-xs text-theme-faint">{int.description}</p>
          </div>
        </div>
        <button
          onClick={async () => {
            await api.put(`/admin/clients/${slug}/integrations/${int.key}`, { is_enabled: !int.enabled });
            onReload();
          }}
          className={`relative w-11 h-6 rounded-full transition-all ${int.enabled ? 'bg-accent-500' : 'bg-dark-400'}`}
        >
          <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow-sm ${int.enabled ? 'left-[24px]' : 'left-1'}`} />
        </button>
      </div>
    );
  };

  return (
    <div>
      {coreItems.length > 0 && (
        <>
          <p className="text-xs font-medium text-theme-faint uppercase tracking-wide mb-3">Settings</p>
          <div className="space-y-2 mb-6">{coreItems.map(renderItem)}</div>
        </>
      )}
      <p className="text-xs font-medium text-theme-faint uppercase tracking-wide mb-3">Integrations</p>
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
        <p className="text-sm text-theme-faint">Revenue streams drive the dashboard KPI cards</p>
        <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2 text-sm">
          <Plus size={14} /> Add Stream
        </button>
      </div>

      {showAdd && (
        <div className="bg-dark-700/60 rounded-2xl p-5 mb-4 border border-dark-400/20">
          <h4 className="text-sm font-semibold text-theme-heading mb-3">New Revenue Stream</h4>
          <div className="flex gap-3 mb-3">
            <div className="flex-1">
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g. Consulting, Dine-in" className="input text-sm" />
            </div>
            <select value={color} onChange={e => setColor(e.target.value)} className="input text-sm w-28">
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
              className="btn-primary text-xs"
            >Add</button>
            <button onClick={() => setShowAdd(false)} className="btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      {streams.length === 0 ? (
        <div className="text-center py-12 bg-dark-700/30 rounded-2xl border border-dark-400/20">
          <BarChart3 size={28} className="text-theme-faint mx-auto mb-2" />
          <p className="text-theme-muted text-sm">No revenue streams configured</p>
        </div>
      ) : (
        <div className="bg-dark-700/40 rounded-2xl border border-dark-400/20 overflow-hidden">
          {streams.map((stream: any, i: number) => (
            <div key={stream.id} className={`flex items-center justify-between px-5 py-3.5 ${i < streams.length - 1 ? 'border-b border-dark-400/15' : ''}`}>
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${
                  stream.color === 'blue' ? 'bg-blue-400' :
                  stream.color === 'purple' ? 'bg-purple-400' :
                  stream.color === 'amber' ? 'bg-amber-400' : 'bg-accent-400'
                }`} />
                <span className="text-sm font-medium text-theme-heading">{stream.name}</span>
              </div>
              <button
                onClick={async () => {
                  if (!confirm(`Delete stream "${stream.name}"?`)) return;
                  await api.delete(`/admin/clients/${slug}/streams/${stream.id}`);
                  onReload();
                }}
                className="text-theme-faint hover:text-red-400 p-1.5 hover:bg-red-500/10 rounded-lg transition-all"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Dashboard Config Section (Tabbed: Total + per-stream) ── */

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

  if (loading) return <div className="text-center py-8 text-theme-faint text-sm">Loading configuration...</div>;

  const currentScope = scopes[activeScope] || { cards: [], charts: [], tables: [] };

  const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
    healthplix: { label: 'Healthplix', color: 'bg-teal-500/10 text-teal-400' },
    oneglance: { label: 'OneGlance', color: 'bg-orange-500/10 text-orange-400' },
  };

  const renderToggleItem = (item: any, type: 'card' | 'chart', badge?: string) => {
    const isCard = type === 'card';
    const isVisCard = item._source === 'chart_visibility';
    const id = (isCard && !isVisCard) ? `card-${item.id}` : `chart-${item.id}`;
    const isSaving = saving === id;
    const isVisible = !!item.is_visible;
    const label = (isCard && !isVisCard) ? item.title : item.element_label;
    const description = item.description || '';
    const source = item.source ? SOURCE_LABELS[item.source] : null;

    return (
      <div key={`${item._source || type}-${item.id}`} className="flex items-center justify-between px-4 py-3 border-b border-dark-400/10 last:border-0">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={() => (isCard && !isVisCard) ? toggleCard(item) : isCard ? toggleCard(item) : toggleChart(item)}
            disabled={isSaving}
            className={`p-1.5 rounded-lg transition-all shrink-0 ${
              isVisible
                ? 'text-accent-400 bg-accent-500/10 hover:bg-accent-500/20'
                : 'text-theme-faint bg-dark-500 hover:bg-dark-400'
            } ${isSaving ? 'opacity-50' : ''}`}
          >
            {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-theme-heading">{label}</span>
              {badge && (
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                  badge === 'System' ? 'bg-accent-500/10 text-accent-400' :
                  badge === 'Auto' ? 'bg-blue-500/10 text-blue-400' :
                  'bg-purple-500/10 text-purple-400'
                }`}>{badge}</span>
              )}
              {source && (
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${source.color}`}>
                  {source.label}
                </span>
              )}
            </div>
            {description && (
              <p className="text-[11px] text-theme-faint mt-0.5 leading-relaxed">{description}</p>
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
          className="flex items-center gap-2 w-full text-left px-1 py-2 text-sm font-semibold text-theme-heading hover:text-accent-400 transition-colors"
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {title}
          <span className="text-[10px] text-theme-faint font-normal ml-1">
            ({items.filter(i => i.is_visible).length}/{items.length} visible)
          </span>
        </button>
        {!isCollapsed && (
          items.length > 0 ? (
            <div className="bg-dark-700/40 rounded-xl border border-dark-400/20 overflow-hidden">
              {items.map(item => renderToggleItem(item, type, getBadge?.(item)))}
            </div>
          ) : (
            <div className="bg-dark-700/30 rounded-xl border border-dark-400/20 px-4 py-6 text-center">
              <p className="text-xs text-theme-faint">No {title.toLowerCase()} configured</p>
            </div>
          )
        )}
      </div>
    );
  };

  return (
    <div>
      <p className="text-sm text-theme-faint mb-4">Configure which elements appear on the Actuals dashboard</p>

      {/* Scope sub-tabs */}
      <div className="flex gap-1 mb-5 bg-dark-700/40 rounded-xl p-1 border border-dark-400/20">
        {scopeTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveScope(tab.key)}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
              activeScope === tab.key
                ? 'bg-accent-500/15 text-accent-400 shadow-sm'
                : 'text-theme-faint hover:text-theme-secondary hover:bg-dark-500/50'
            }`}
          >
            {tab.label}
            {tab.source && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                tab.source === 'healthplix' ? 'bg-teal-500/15 text-teal-400' : 'bg-orange-500/15 text-orange-400'
              }`}>
                {tab.source === 'healthplix' ? 'Healthplix' : 'OneGlance'}
              </span>
            )}
          </button>
        ))}
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

  // Load access data for all active branches
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
    // Build updated stream_users from current state
    const updatedStreams = current.streams.map(s => {
      if (s.id !== streamId) return { stream_id: s.id, user_ids: s.user_ids };
      const newIds = s.user_ids.includes(userId)
        ? s.user_ids.filter(id => id !== userId)
        : [...s.user_ids, userId];
      return { stream_id: s.id, user_ids: newIds };
    });
    // Optimistic update
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
      // Revert on error
      const res = await api.get(`/admin/clients/${slug}/branches/${branchId}/users`);
      setBranchAccess(prev => ({ ...prev, [branchId]: { is_restricted: res.data.is_restricted, user_ids: res.data.user_ids, streams: res.data.streams || [] } }));
    }
    setSavingBranch(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-theme-faint">
          {client?.is_multi_branch
            ? 'Multi-branch enabled — data is separated by branch'
            : 'Single-branch mode — enable multi-branch to manage locations'}
        </p>
        {!client?.is_multi_branch ? (
          <button
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
            disabled={enabling}
            className="flex items-center gap-1.5 text-sm text-amber-400 font-medium border border-amber-500/20 px-3.5 py-2 rounded-xl hover:bg-amber-500/10 transition-all"
          >
            <MapPin size={14} /> {enabling ? 'Enabling...' : 'Enable Multi-Branch'}
          </button>
        ) : (
          <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={14} /> Add Branch
          </button>
        )}
      </div>

      {showAdd && (
        <div className="bg-dark-700/60 rounded-2xl p-5 mb-4 border border-dark-400/20">
          <h4 className="text-sm font-semibold text-theme-heading mb-3">New Branch</h4>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <label className="block text-xs font-medium text-theme-muted mb-1">Branch Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Koramangala Clinic" className="input text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-theme-muted mb-1">State</label>
              <select value={state} onChange={e => { setState(e.target.value); setCity(''); }} className="input text-sm">
                <option value="">Select state</option>
                {Object.keys(INDIAN_STATES_CITIES).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-theme-muted mb-1">City</label>
              <select value={city} onChange={e => setCity(e.target.value)} className="input text-sm" disabled={!state}>
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
              className="btn-primary text-xs"
            >Add Branch</button>
            <button onClick={() => setShowAdd(false)} className="btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      {branches.length === 0 ? (
        <div className="text-center py-12 bg-dark-700/30 rounded-2xl border border-dark-400/20">
          <GitBranch size={28} className="text-theme-faint mx-auto mb-2" />
          <p className="text-theme-muted text-sm">
            {client?.is_multi_branch ? 'No branches configured' : 'Enable multi-branch to add locations'}
          </p>
        </div>
      ) : (
        <div className="bg-dark-700/40 rounded-2xl border border-dark-400/20 overflow-hidden">
          {branches.map((branch: any, i: number) => {
            const access = branchAccess[branch.id];
            const isRestricted = access?.is_restricted ?? false;
            const assignedIds = access?.user_ids ?? [];
            const isSaving = savingBranch === branch.id;
            const isExpanded = expandedBranch === branch.id;

            return (
              <div key={branch.id} className={`${i < branches.length - 1 ? 'border-b border-dark-400/15' : ''}`}>
                <div className="flex items-center justify-between px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-accent-500/10">
                      <MapPin size={15} className="text-accent-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-theme-heading">{branch.name}</span>
                        <span className="text-[10px] font-mono text-theme-faint">{branch.code}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-theme-faint">
                        {branch.state && <span>{branch.state}</span>}
                        {branch.state && branch.city && <span className="text-dark-300">·</span>}
                        {branch.city && <span>{branch.city}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {client?.is_multi_branch && (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-theme-faint">Restrict Access</span>
                        <button
                          onClick={() => handleToggleRestrict(branch.id)}
                          disabled={isSaving}
                          className={`relative w-10 h-5.5 rounded-full transition-all ${isRestricted ? 'bg-amber-500' : 'bg-dark-400'} ${isSaving ? 'opacity-50' : ''}`}
                          style={{ width: 40, height: 22 }}
                        >
                          <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-all shadow-sm ${isRestricted ? 'left-[21px]' : 'left-[3px]'}`} />
                        </button>
                      </div>
                    )}
                    {isRestricted && (
                      <button
                        onClick={() => setExpandedBranch(isExpanded ? null : branch.id)}
                        className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500/15 transition-all"
                      >
                        <Users size={11} />
                        <span>{assignedIds.length} user{assignedIds.length !== 1 ? 's' : ''}</span>
                        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      </button>
                    )}
                    <button
                      onClick={() => setEditingBranch({ ...branch })}
                      className="text-theme-faint hover:text-blue-400 p-1.5 hover:bg-blue-500/10 rounded-lg transition-all"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Permanently delete branch "${branch.name}"? This cannot be undone.`)) return;
                        await api.delete(`/admin/clients/${slug}/branches/${branch.id}`);
                        onReload();
                      }}
                      className="text-theme-faint hover:text-red-400 p-1.5 hover:bg-red-500/10 rounded-lg transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Edit branch inline form */}
                {editingBranch?.id === branch.id && (
                  <div className="px-5 pb-4 pt-0">
                    <div className="bg-dark-600/40 rounded-xl border border-dark-400/20 p-4">
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        <div>
                          <label className="block text-xs font-medium text-theme-muted mb-1">Branch Name</label>
                          <input type="text" value={editingBranch.name} onChange={e => setEditingBranch({ ...editingBranch, name: e.target.value })} className="input text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-theme-muted mb-1">State</label>
                          <select value={editingBranch.state || ''} onChange={e => setEditingBranch({ ...editingBranch, state: e.target.value, city: '' })} className="input text-sm">
                            <option value="">Select state</option>
                            {Object.keys(INDIAN_STATES_CITIES).map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-theme-muted mb-1">City</label>
                          <select value={editingBranch.city || ''} onChange={e => setEditingBranch({ ...editingBranch, city: e.target.value })} className="input text-sm" disabled={!editingBranch.state}>
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
                          className="btn-primary text-xs"
                        >Save</button>
                        <button onClick={() => setEditingBranch(null)} className="btn-secondary text-xs">Cancel</button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Expanded per-stream user assignments */}
                {isExpanded && isRestricted && branch.is_active && (
                  <div className="px-5 pb-4 pt-0">
                    <div className="ml-12">
                      <p className="text-[11px] text-theme-faint mb-3">
                        Assign users to each revenue stream <span className="text-theme-muted">(admins always have full access)</span>
                      </p>
                      {(access?.streams ?? []).length === 0 ? (
                        <div className="bg-dark-600/40 rounded-xl border border-dark-400/20 p-3">
                          <p className="text-[11px] text-amber-400/80">No revenue streams configured for this branch. Add streams in the Revenue Streams tab first.</p>
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {(access?.streams ?? []).map(stream => (
                            <div key={stream.id} className="bg-dark-600/40 rounded-xl border border-dark-400/20 overflow-hidden">
                              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-dark-400/15">
                                <div className="flex items-center gap-2">
                                  <Layers size={13} className="text-accent-400" />
                                  <span className="text-xs font-semibold text-theme-heading">{stream.name}</span>
                                </div>
                                <span className="text-[10px] text-theme-faint">{stream.user_ids.length} of {nonAdminUsers.length} users</span>
                              </div>
                              <div className="p-2.5 space-y-0.5 max-h-40 overflow-y-auto">
                                {nonAdminUsers.map(user => {
                                  const isAssigned = stream.user_ids.includes(user.id);
                                  return (
                                    <label
                                      key={user.id}
                                      className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer transition-all ${
                                        isAssigned ? 'bg-accent-500/10' : 'hover:bg-dark-500/50'
                                      } ${isSaving ? 'opacity-50 pointer-events-none' : ''}`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={isAssigned}
                                        onChange={() => handleStreamUserToggle(branch.id, stream.id, user.id)}
                                        className="w-3.5 h-3.5 rounded border-dark-300 text-accent-500 focus:ring-accent-500/30"
                                      />
                                      <span className="text-sm text-theme-secondary">{user.display_name}</span>
                                      <span className="text-[10px] text-theme-faint">@{user.username}</span>
                                    </label>
                                  );
                                })}
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

  if (loading) return (
    <div className="text-center py-16">
      <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
    </div>
  );

  const nonOwnerTeam = allTeam.filter(m => !m.is_owner && m.is_active);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-theme-faint">Team members assigned to manage this client</p>
        {!editing && (
          <button onClick={() => setEditing(true)} className="btn-primary flex items-center gap-2 text-sm">
            <Users size={14} /> Edit Assignments
          </button>
        )}
      </div>

      {editing ? (
        <div className="bg-dark-700/60 rounded-2xl border border-dark-400/20 p-5 mb-4">
          <h4 className="text-sm font-semibold text-theme-heading mb-3">Select Team Members</h4>
          {nonOwnerTeam.length === 0 ? (
            <p className="text-sm text-theme-faint py-4">No team members available. Add team members in the Team tab first.</p>
          ) : (
            <div className="space-y-1.5 mb-4">
              {nonOwnerTeam.map(member => (
                <label
                  key={member.id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all ${
                    selectedIds.has(member.id)
                      ? 'bg-accent-500/10 border border-accent-500/20'
                      : 'bg-dark-600/50 border border-transparent hover:bg-dark-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(member.id)}
                    onChange={() => toggleMember(member.id)}
                    className="w-4 h-4 rounded border-dark-300 text-accent-500 focus:ring-accent-500 bg-dark-800"
                  />
                  <div>
                    <span className="text-sm font-medium text-theme-heading">{member.display_name}</span>
                    <span className="text-[11px] font-mono text-theme-faint ml-2">@{member.username}</span>
                  </div>
                </label>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between pt-3 border-t border-dark-400/30">
            <span className="text-xs text-theme-faint">{selectedIds.size} selected</span>
            <div className="flex gap-2">
              <button onClick={() => { setEditing(false); setSelectedIds(new Set(assigned.map((m: any) => m.id))); }} className="btn-secondary text-xs">Cancel</button>
              <button onClick={save} disabled={saving} className="btn-primary text-xs">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : assigned.length === 0 ? (
        <div className="text-center py-12 bg-dark-700/30 rounded-2xl border border-dark-400/20">
          <Shield size={28} className="text-theme-faint mx-auto mb-2" />
          <p className="text-theme-muted text-sm">No team members assigned</p>
          <p className="text-theme-faint text-xs mt-1">Click "Edit Assignments" to assign team members</p>
        </div>
      ) : (
        <div className="bg-dark-700/40 rounded-2xl border border-dark-400/20 overflow-hidden">
          {assigned.map((member: any, i: number) => (
            <div key={member.id} className={`flex items-center justify-between px-5 py-3.5 ${i < assigned.length - 1 ? 'border-b border-dark-400/15' : ''}`}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-purple-500/10 flex items-center justify-center">
                  <Shield size={15} className="text-purple-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-theme-heading">{member.display_name}</span>
                    <span className="text-[11px] font-mono text-theme-faint">@{member.username}</span>
                  </div>
                </div>
              </div>
              <span className={`text-[10px] font-medium px-2.5 py-1 rounded-full ${
                member.is_active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
              }`}>
                {member.is_active ? 'Active' : 'Disabled'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Reset Password Modal (shared) ────────────────────── */

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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-dark-700 rounded-2xl p-6 max-w-sm w-full mx-4 border border-dark-400/30 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-theme-heading mb-2">Reset Password</h3>
        <p className="text-sm text-theme-muted mb-4">
          Reset password for <span className="text-accent-400 font-medium">@{username}</span>?
        </p>

        <div className="space-y-2 mb-4">
          <label className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all ${
            mode === 'auto' ? 'bg-accent-500/10 border border-accent-500/20' : 'bg-dark-600/50 border border-transparent hover:bg-dark-600'
          }`}>
            <input type="radio" checked={mode === 'auto'} onChange={() => setMode('auto')} className="w-3.5 h-3.5 text-accent-500" />
            <span className="text-sm text-theme-heading">Generate random password</span>
          </label>
          <label className={`flex items-start gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all ${
            mode === 'custom' ? 'bg-accent-500/10 border border-accent-500/20' : 'bg-dark-600/50 border border-transparent hover:bg-dark-600'
          }`}>
            <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} className="w-3.5 h-3.5 mt-0.5 text-accent-500" />
            <div className="flex-1">
              <span className="text-sm text-theme-heading">Set custom password</span>
              {mode === 'custom' && (
                <div className="mt-2">
                  <div className="relative">
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={customPw}
                      onChange={e => { setCustomPw(e.target.value); setError(''); }}
                      placeholder="Min 8 chars, letter + number"
                      className="input text-sm w-full pr-9"
                      autoFocus
                    />
                    <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-theme-faint hover:text-theme-secondary">
                      {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
                </div>
              )}
            </div>
          </label>
        </div>

        <div className="flex gap-2">
          <button onClick={onCancel} className="btn-secondary text-sm flex-1">Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={mode === 'custom' && !customPw}
            className="btn-primary text-sm flex-1"
          >
            Reset Password
          </button>
        </div>
      </div>
    </div>
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
      <div className="bg-dark-700/60 rounded-2xl p-5 mb-4 border border-accent-500/30">
        <div className="flex items-center gap-3 mb-3">
          <CheckCircle size={18} className="text-accent-400" />
          <h4 className="text-sm font-semibold text-accent-300">User Created</h4>
        </div>
        <div className="bg-dark-800 rounded-xl p-3 mb-3 border border-dark-400/20">
          <p className="text-theme-heading font-mono text-sm">Username: <span className="text-accent-400">@{created.username}</span></p>
          <div className="flex items-center justify-between mt-1">
            <p className="text-theme-heading font-mono text-sm">Password: <span className="text-accent-400">{created.password}</span></p>
            <button onClick={() => navigator.clipboard.writeText(created.password)} className="text-theme-muted hover:text-accent-400"><Copy size={14} /></button>
          </div>
          <p className="text-theme-heading font-mono text-sm mt-1">Role: <span className={created.role === 'admin' ? 'text-amber-400' : 'text-theme-muted'}>{created.role}</span></p>
        </div>
        <p className="text-xs text-amber-400 mb-3">Save these credentials — the password won't be shown again</p>
        <button onClick={onAdded} className="btn-primary text-xs">Done</button>
      </div>
    );
  }

  return (
    <div className="bg-dark-700/60 rounded-2xl p-5 mb-4 border border-dark-400/20">
      <h4 className="text-sm font-semibold text-theme-heading mb-3">Add New User</h4>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1">Display Name</label>
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="John Doe" className="input text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1">Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="john" className="input text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1">Password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Min 8 chars, letter + number" className="input text-sm pr-9" />
            <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-theme-faint hover:text-theme-secondary">
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1">Role</label>
          <select value={role} onChange={e => setRole(e.target.value as 'user' | 'admin')} className="input text-sm">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !username || !password || !displayName} className="btn-primary text-xs">
          {saving ? 'Adding...' : 'Add User'}
        </button>
        <button onClick={onCancel} className="btn-secondary text-xs">Cancel</button>
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
        <p className="text-sm text-theme-faint">Manage your team and assign clients to each member</p>
        <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2 text-sm">
          <UserPlus size={14} /> Add Member
        </button>
      </div>

      {showAdd && (
        <AddTeamMemberForm onAdded={() => { setShowAdd(false); loadTeam(); }} onCancel={() => setShowAdd(false)} />
      )}

      {loading ? (
        <div className="text-center py-16">
          <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
        </div>
      ) : team.length === 0 ? (
        <div className="text-center py-16 bg-dark-700/30 rounded-2xl border border-dark-400/20">
          <Shield size={32} className="text-theme-faint mx-auto mb-2" />
          <p className="text-theme-muted text-sm">No team members</p>
        </div>
      ) : (
        <div className="bg-dark-700/40 rounded-2xl border border-dark-400/20 overflow-hidden">
          {team.map((member, i) => (
            <div key={member.id} className={`flex items-center justify-between px-5 py-4 ${i < team.length - 1 ? 'border-b border-dark-400/15' : ''}`}>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                  member.is_owner ? 'bg-amber-500/10' : 'bg-purple-500/10'
                }`}>
                  <Shield size={17} className={member.is_owner ? 'text-amber-400' : 'text-purple-400'} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-theme-heading">{member.display_name}</span>
                    <span className="text-[11px] font-mono text-theme-faint">@{member.username}</span>
                    {member.is_owner ? (
                      <span className="text-[10px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full uppercase tracking-wider">Owner</span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-theme-faint">
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
                  <button
                    onClick={() => setAssignMember(member)}
                    className="text-xs px-2.5 py-1.5 rounded-lg text-accent-400 hover:text-accent-300 bg-accent-500/10 hover:bg-accent-500/15 transition-all flex items-center gap-1"
                  >
                    <Building2 size={11} /> Assign Clients
                  </button>
                )}
                <button
                  onClick={() => setResetConfirm({ id: member.id, username: member.username })}
                  className="text-xs px-2.5 py-1.5 rounded-lg text-theme-muted hover:text-theme-secondary bg-dark-600 hover:bg-dark-500 transition-all flex items-center gap-1"
                >
                  <KeyRound size={11} /> Reset PW
                </button>
                {!member.is_owner && (
                  <button
                    onClick={() => toggleMemberActive(member.id, member.is_active)}
                    className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all ${
                      member.is_active
                        ? 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20'
                        : 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
                    }`}
                  >
                    {member.is_active ? 'Active' : 'Disabled'}
                  </button>
                )}
                {member.is_owner && (
                  <span className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400">
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
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setResetResult(null)}>
          <div className="bg-dark-700 rounded-2xl p-6 max-w-sm w-full mx-4 border border-dark-400/30 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle size={18} className="text-emerald-400" />
              <h3 className="font-semibold text-theme-heading">Password Reset</h3>
            </div>
            <p className="text-sm text-theme-muted mb-3">New credentials for <span className="text-accent-400 font-medium">@{resetResult.username}</span></p>
            <div className="bg-dark-800 rounded-xl p-3 font-mono text-sm text-theme-heading mb-4 flex items-center justify-between border border-dark-400/20">
              <span>{resetResult.password}</span>
              <button onClick={() => navigator.clipboard.writeText(resetResult.password)} className="text-theme-muted hover:text-accent-400"><Copy size={14} /></button>
            </div>
            <p className="text-xs text-amber-400 mb-4">Save this password — it won't be shown again</p>
            <button onClick={() => setResetResult(null)} className="btn-primary text-sm w-full">Done</button>
          </div>
        </div>
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-dark-700 rounded-2xl p-6 max-w-md w-full mx-4 border border-dark-400/30 shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-theme-heading mb-1">Assign Clients</h3>
        <p className="text-sm text-theme-faint mb-4">
          Select which clients <span className="text-accent-400 font-medium">{member.display_name}</span> can access
        </p>

        {loading ? (
          <div className="text-center py-8">
            <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-1 mb-4 pr-1">
            {allClients.filter(c => c.is_active).map(client => (
              <label
                key={client.id}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all ${
                  assignedIds.has(client.id)
                    ? 'bg-accent-500/10 border border-accent-500/20'
                    : 'bg-dark-600/50 border border-transparent hover:bg-dark-600'
                }`}
              >
                <input
                  type="checkbox"
                  checked={assignedIds.has(client.id)}
                  onChange={() => toggle(client.id)}
                  className="w-4 h-4 rounded border-dark-300 text-accent-500 focus:ring-accent-500 bg-dark-800"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-theme-heading">{client.name}</div>
                  <div className="text-[11px] text-theme-faint font-mono">{client.slug}</div>
                </div>
                <span className="text-[10px] text-theme-faint">{client.user_count} users</span>
              </label>
            ))}
            {allClients.filter(c => c.is_active).length === 0 && (
              <p className="text-center text-theme-faint text-sm py-4">No active clients</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-3 border-t border-dark-400/30">
          <span className="text-xs text-theme-faint">{assignedIds.size} selected</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
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
      <div className="bg-dark-700/60 rounded-2xl p-5 mb-4 border border-accent-500/30">
        <div className="flex items-center gap-3 mb-3">
          <CheckCircle size={18} className="text-accent-400" />
          <h4 className="text-sm font-semibold text-accent-300">Team Member Created</h4>
        </div>
        <div className="bg-dark-800 rounded-xl p-3 mb-3 border border-dark-400/20">
          <p className="text-theme-heading font-mono text-sm">Username: <span className="text-accent-400">@{created.username}</span></p>
          <div className="flex items-center justify-between mt-1">
            <p className="text-theme-heading font-mono text-sm">Password: <span className="text-accent-400">{created.password}</span></p>
            <button onClick={() => navigator.clipboard.writeText(created.password)} className="text-theme-muted hover:text-accent-400"><Copy size={14} /></button>
          </div>
        </div>
        <p className="text-xs text-amber-400 mb-3">Save these credentials — the password won't be shown again</p>
        <button onClick={onAdded} className="btn-primary text-xs">Done</button>
      </div>
    );
  }

  return (
    <div className="bg-dark-700/60 rounded-2xl p-5 mb-4 border border-dark-400/20">
      <h4 className="text-sm font-semibold text-theme-heading mb-3">Add Team Member</h4>
      <p className="text-xs text-theme-faint mb-3">New team members need client assignments to access client data</p>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1">Display Name</label>
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Jane Smith" className="input text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1">Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="jane" className="input text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1">Password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Strong password" className="input text-sm pr-9" />
            <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-theme-faint hover:text-theme-secondary">
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !username || !password || !displayName} className="btn-primary text-xs">
          {saving ? 'Adding...' : 'Add Member'}
        </button>
        <button onClick={onCancel} className="btn-secondary text-xs">Cancel</button>
      </div>
    </div>
  );
}
