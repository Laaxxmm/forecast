import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import {
  Building2, Users, UserPlus, Plus, Edit3, Power, ChevronRight, ArrowLeft,
  Eye, EyeOff, CheckCircle, XCircle, Plug, Shield, Trash2, Copy, KeyRound, BarChart3,
  MapPin, GitBranch, Layers
} from 'lucide-react';

interface Client {
  id: number;
  slug: string;
  name: string;
  is_active: number;
  user_count: number;
  integrations: string | null;
  created_at: string;
}

interface ClientUser {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_active: number;
  created_at: string;
}

interface TeamMember {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_active: number;
  created_at: string;
}

interface Integration {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
}

type Tab = 'clients' | 'team';
type ClientView = 'list' | 'detail';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('clients');
  const navigate = useNavigate();

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-theme-heading">Admin Panel</h1>
          <p className="text-theme-faint mt-1 text-sm">Manage clients, users, and integrations</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('clients')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
            tab === 'clients'
              ? 'bg-accent-500 text-white shadow-glow'
              : 'bg-dark-700 text-theme-muted border border-dark-400/50 hover:border-dark-300'
          }`}
        >
          <Building2 size={16} /> Clients
        </button>
        <button
          onClick={() => setTab('team')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
            tab === 'team'
              ? 'bg-accent-500 text-white shadow-glow'
              : 'bg-dark-700 text-theme-muted border border-dark-400/50 hover:border-dark-300'
          }`}
        >
          <Shield size={16} /> Team Members
        </button>
      </div>

      {tab === 'clients' && <ClientsPanel />}
      {tab === 'team' && <TeamPanel />}
    </div>
  );
}

// ─── Clients Panel ──────────────────────────────────────────────────────────

function ClientsPanel() {
  const [view, setView] = useState<ClientView>('list');
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const loadClients = useCallback(() => {
    api.get('/admin/clients').then(res => {
      setClients(res.data);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadClients(); }, [loadClients]);

  if (view === 'detail' && selectedSlug) {
    return <ClientDetail slug={selectedSlug} onBack={() => { setView('list'); loadClients(); }} />;
  }

  return (
    <>
      {/* Create Client Form */}
      {showCreate && (
        <CreateClientForm
          onCreated={() => { setShowCreate(false); loadClients(); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-theme-heading">All Clients</h3>
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={14} /> Add Client
          </button>
        </div>

        {loading ? (
          <div className="text-center py-8">
            <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
          </div>
        ) : clients.length === 0 ? (
          <p className="text-theme-faint text-center py-8">No clients yet. Create your first client above.</p>
        ) : (
          <div className="space-y-2">
            {clients.map(client => (
              <div
                key={client.id}
                onClick={() => { setSelectedSlug(client.slug); setView('detail'); }}
                className="flex items-center gap-4 px-4 py-3.5 rounded-xl bg-dark-600 hover:bg-dark-500 cursor-pointer transition-all group border border-dark-400/30 hover:border-dark-300"
              >
                <div className="w-10 h-10 rounded-xl bg-accent-500/10 flex items-center justify-center">
                  <Building2 size={18} className="text-accent-400" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-theme-heading">{client.name}</span>
                    <span className="text-xs text-theme-faint">({client.slug})</span>
                    {client.is_active ? (
                      <span className="badge-success text-[10px]">Active</span>
                    ) : (
                      <span className="badge-danger text-[10px]">Inactive</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-theme-faint flex items-center gap-1">
                      <Users size={11} /> {client.user_count} user{client.user_count !== 1 ? 's' : ''}
                    </span>
                    {client.integrations && (
                      <span className="text-xs text-theme-faint">
                        {client.integrations.split(',').join(', ')}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight size={16} className="text-theme-faint group-hover:text-accent-400 transition-colors" />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Create Client Form ─────────────────────────────────────────────────────

function CreateClientForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [industry, setIndustry] = useState('custom');
  const [industries, setIndustries] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  useEffect(() => { api.get('/admin/industries').then(res => setIndustries(res.data)); }, []);

  const autoSlug = (n: string) => {
    setName(n);
    setSlug(n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  };

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.post('/admin/clients', { slug, name, industry });
      setResult(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create client');
    }
    setSaving(false);
  };

  if (result) {
    return (
      <div className="card mb-6 border-accent-500/30">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-accent-500/15 flex items-center justify-center">
            <CheckCircle size={20} className="text-accent-400" />
          </div>
          <div>
            <h3 className="font-semibold text-accent-300">Client Created!</h3>
            <p className="text-sm text-theme-faint">{result.name}</p>
          </div>
        </div>
        <div className="bg-dark-600 rounded-xl p-4 mb-4">
          <p className="text-sm text-theme-secondary mb-1">Default login credentials:</p>
          <p className="text-theme-heading font-mono text-sm">Username: <span className="text-accent-400">admin</span></p>
          <p className="text-theme-heading font-mono text-sm">Password: <span className="text-accent-400">admin123</span></p>
          <p className="text-xs text-amber-400 mt-2">Change this password immediately after first login!</p>
        </div>
        <button onClick={onCreated} className="btn-primary text-sm">Done</button>
      </div>
    );
  }

  return (
    <div className="card mb-6">
      <h3 className="font-semibold text-theme-heading mb-4">Create New Client</h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-theme-muted mb-1.5">Client Name</label>
          <input type="text" value={name} onChange={e => autoSlug(e.target.value)}
            placeholder="e.g. Apollo Healthcare" className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-theme-muted mb-1.5">Slug (URL identifier)</label>
          <input type="text" value={slug} onChange={e => setSlug(e.target.value)}
            placeholder="e.g. apollo-healthcare" className="input font-mono" />
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-theme-muted mb-2">Industry</label>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {industries.map((ind: any) => (
              <button
                key={ind.key}
                type="button"
                onClick={() => setIndustry(ind.key)}
                className={`text-left px-3 py-2.5 rounded-xl border transition-all ${
                  industry === ind.key
                    ? 'border-accent-500 bg-accent-500/10 text-accent-400'
                    : 'border-dark-400/50 bg-dark-600 text-theme-muted hover:border-dark-300'
                }`}
              >
                <div className="text-sm font-medium">{ind.label}</div>
                <div className="text-[10px] text-theme-faint mt-0.5">{ind.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
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

// ─── Client Detail View ─────────────────────────────────────────────────────

function ClientDetail({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [client, setClient] = useState<any>(null);
  const [users, setUsers] = useState<ClientUser[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddUser, setShowAddUser] = useState(false);
  const [showAddStream, setShowAddStream] = useState(false);
  const [newStreamName, setNewStreamName] = useState('');
  const [newStreamColor, setNewStreamColor] = useState('accent');
  const [resetResult, setResetResult] = useState<{username: string; password: string} | null>(null);
  const [industries, setIndustries] = useState<any[]>([]);
  const [clientBranches, setClientBranches] = useState<any[]>([]);
  const [showAddBranch, setShowAddBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchCode, setNewBranchCode] = useState('');
  const [newBranchCity, setNewBranchCity] = useState('');
  const [newBranchManager, setNewBranchManager] = useState('');
  const [enablingMultiBranch, setEnablingMultiBranch] = useState(false);
  const [modules, setModules] = useState<{module_key: string; is_enabled: number}[]>([]);

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

  const changeIndustry = async (newIndustry: string) => {
    await api.put(`/admin/clients/${slug}`, { industry: newIndustry });
    loadDetail();
  };

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const toggleActive = async () => {
    await api.put(`/admin/clients/${slug}`, { is_active: !client.is_active });
    loadDetail();
  };

  const toggleIntegration = async (key: string, enabled: boolean) => {
    await api.put(`/admin/clients/${slug}/integrations/${key}`, { is_enabled: !enabled });
    loadDetail();
  };

  const toggleUserActive = async (userId: number, isActive: number) => {
    await api.put(`/admin/clients/${slug}/users/${userId}`, { is_active: !isActive });
    loadDetail();
  };

  const resetPassword = async (userId: number, username: string) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const newPw = Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    try {
      await api.put(`/admin/clients/${slug}/users/${userId}`, { password: newPw });
      setResetResult({ username, password: newPw });
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to reset password');
    }
  };

  if (loading) return (
    <div className="text-center py-12">
      <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
    </div>
  );

  return (
    <div>
      {/* Header */}
      <button onClick={onBack} className="flex items-center gap-2 text-sm text-theme-muted hover:text-accent-400 mb-4 transition-colors">
        <ArrowLeft size={14} /> Back to clients
      </button>

      <div className="card mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent-500/10 flex items-center justify-center">
              <Building2 size={22} className="text-accent-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-theme-heading">{client.name}</h2>
              <div className="flex items-center gap-2">
                <span className="text-sm text-theme-faint font-mono">{client.slug}</span>
                <span className="text-theme-faint">·</span>
                <select
                  value={client.industry || 'custom'}
                  onChange={e => changeIndustry(e.target.value)}
                  className="text-sm bg-dark-600 text-theme-secondary border border-dark-400/30 rounded-lg px-2 py-0.5 cursor-pointer hover:border-accent-500/30 transition-colors"
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
              <span className="badge-success">Active</span>
            ) : (
              <span className="badge-danger">Inactive</span>
            )}
            <button
              onClick={toggleActive}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition-all ${
                client.is_active
                  ? 'text-red-400 hover:bg-red-500/10 border border-red-500/20'
                  : 'text-accent-400 hover:bg-accent-500/10 border border-accent-500/20'
              }`}
            >
              <Power size={14} />
              {client.is_active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Users */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-theme-heading flex items-center gap-2">
              <Users size={16} /> Users
            </h3>
            <button onClick={() => setShowAddUser(true)} className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-300 font-medium transition-colors">
              <UserPlus size={14} /> Add User
            </button>
          </div>

          {showAddUser && (
            <AddUserForm
              slug={slug}
              onAdded={() => { setShowAddUser(false); loadDetail(); }}
              onCancel={() => setShowAddUser(false)}
            />
          )}

          {users.length === 0 ? (
            <p className="text-theme-faint text-center py-6 text-sm">No users</p>
          ) : (
            <div className="space-y-2">
              {users.map(user => (
                <div key={user.id} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-dark-600 border border-dark-400/30">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-theme-primary">{user.display_name}</span>
                      <span className="text-[10px] font-mono text-theme-faint">@{user.username}</span>
                    </div>
                    <span className={`text-[10px] font-medium ${user.role === 'admin' ? 'text-amber-400' : 'text-theme-faint'}`}>
                      {user.role}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => resetPassword(user.id, user.username)}
                      className="text-xs px-2 py-1 rounded-lg text-theme-muted bg-dark-500 hover:bg-dark-400 transition-all flex items-center gap-1"
                      title="Reset Password"
                    >
                      <KeyRound size={11} /> Reset PW
                    </button>
                    <button
                      onClick={() => toggleUserActive(user.id, user.is_active)}
                      className={`text-xs px-2 py-1 rounded-lg transition-all ${
                        user.is_active
                          ? 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20'
                          : 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
                      }`}
                    >
                      {user.is_active ? 'Active' : 'Disabled'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Integrations */}
        <div className="card">
          <h3 className="font-semibold text-theme-heading flex items-center gap-2 mb-4">
            <Plug size={16} /> Integrations
          </h3>
          <div className="space-y-2">
            {integrations.map(int => (
              <div key={int.key} className="flex items-center justify-between px-3 py-3 rounded-xl bg-dark-600 border border-dark-400/30">
                <div>
                  <span className="text-sm font-medium text-theme-primary">{int.name}</span>
                  <p className="text-xs text-theme-faint mt-0.5">{int.description}</p>
                </div>
                <button
                  onClick={() => toggleIntegration(int.key, int.enabled)}
                  className={`relative w-10 h-5 rounded-full transition-all ${
                    int.enabled ? 'bg-accent-500' : 'bg-dark-400'
                  }`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                    int.enabled ? 'left-[22px]' : 'left-0.5'
                  }`} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Modules */}
        <div className="card">
          <h3 className="font-semibold text-theme-heading flex items-center gap-2 mb-4">
            <Layers size={16} /> Modules
          </h3>
          <p className="text-xs text-theme-faint mb-3">Enable or disable portal modules for this client</p>
          <div className="space-y-2">
            {[
              { key: 'forecast_ops', name: 'Forecast & Operations', desc: 'Build forecasts, link actuals, integrated reports' },
              { key: 'vcfo_portal', name: 'VCFO Portal', desc: 'Comprehensive Virtual CFO portal' },
              { key: 'audit_view', name: 'Audit View', desc: 'Audit support and compliance tools' },
              { key: 'litigation_tool', name: 'Litigation Tool', desc: 'Track notices and prepare legal responses' },
            ].map(mod => {
              const m = modules.find(x => x.module_key === mod.key);
              const enabled = !!m?.is_enabled;
              return (
                <div key={mod.key} className="flex items-center justify-between px-3 py-3 rounded-xl bg-dark-600 border border-dark-400/30">
                  <div>
                    <span className="text-sm font-medium text-theme-primary">{mod.name}</span>
                    <p className="text-xs text-theme-faint mt-0.5">{mod.desc}</p>
                  </div>
                  <button
                    onClick={async () => {
                      await api.put(`/admin/clients/${slug}/modules/${mod.key}`, { is_enabled: !enabled });
                      loadDetail();
                    }}
                    className={`relative w-10 h-5 rounded-full transition-all ${
                      enabled ? 'bg-accent-500' : 'bg-dark-400'
                    }`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                      enabled ? 'left-[22px]' : 'left-0.5'
                    }`} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Revenue Streams */}
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-theme-heading flex items-center gap-2">
                <BarChart3 size={16} /> Revenue Streams
              </h3>
              <p className="text-xs text-theme-faint mt-1">These drive the dashboard KPI cards for this client</p>
            </div>
            <button onClick={() => setShowAddStream(true)} className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-300 font-medium transition-colors">
              <Plus size={14} /> Add Stream
            </button>
          </div>

          {showAddStream && (
            <div className="bg-dark-600 rounded-xl p-4 mb-4 border border-dark-400/50">
              <h4 className="text-sm font-semibold text-theme-heading mb-3">Add Revenue Stream</h4>
              <div className="flex gap-3 mb-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-theme-muted mb-1">Stream Name</label>
                  <input type="text" value={newStreamName} onChange={e => setNewStreamName(e.target.value)}
                    placeholder="e.g. Dine-in, Consulting" className="input text-sm" />
                </div>
                <div className="w-32">
                  <label className="block text-xs font-medium text-theme-muted mb-1">Color</label>
                  <select value={newStreamColor} onChange={e => setNewStreamColor(e.target.value)} className="input text-sm">
                    <option value="accent">Green</option>
                    <option value="blue">Blue</option>
                    <option value="purple">Purple</option>
                    <option value="amber">Amber</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    if (!newStreamName) return;
                    await api.post(`/admin/clients/${slug}/streams`, { name: newStreamName, color: newStreamColor });
                    setNewStreamName(''); setShowAddStream(false); loadDetail();
                  }}
                  disabled={!newStreamName}
                  className="btn-primary text-xs px-3 py-2"
                >Add Stream</button>
                <button onClick={() => setShowAddStream(false)} className="btn-secondary text-xs px-3 py-2">Cancel</button>
              </div>
            </div>
          )}

          {streams.length === 0 ? (
            <p className="text-theme-faint text-center py-6 text-sm">No revenue streams configured</p>
          ) : (
            <div className="space-y-2">
              {streams.map((stream: any) => (
                <div key={stream.id} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-dark-600 border border-dark-400/30">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${
                      stream.color === 'blue' ? 'bg-blue-400' :
                      stream.color === 'purple' ? 'bg-purple-400' :
                      stream.color === 'amber' ? 'bg-amber-400' : 'bg-accent-400'
                    }`} />
                    <span className="text-sm font-medium text-theme-primary">{stream.name}</span>
                  </div>
                  <button
                    onClick={async () => {
                      if (!confirm(`Delete stream "${stream.name}"?`)) return;
                      await api.delete(`/admin/clients/${slug}/streams/${stream.id}`);
                      loadDetail();
                    }}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-1 hover:bg-red-500/10 rounded-lg transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Branches Management */}
      <div className="card mt-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-theme-heading flex items-center gap-2">
              <GitBranch size={16} /> Branches / Locations
            </h3>
            <p className="text-xs text-theme-faint mt-1">
              {client?.is_multi_branch
                ? 'Multi-branch enabled — data is separated by branch'
                : 'Single-branch mode — enable multi-branch to manage locations'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!client?.is_multi_branch ? (
              <button
                onClick={async () => {
                  const name = prompt('Default branch name (e.g. "Head Office"):');
                  if (!name) return;
                  const code = prompt('Branch code (lowercase, e.g. "head-office"):');
                  if (!code) return;
                  setEnablingMultiBranch(true);
                  try {
                    await api.post(`/admin/clients/${slug}/enable-multi-branch`, {
                      default_branch_name: name,
                      default_branch_code: code,
                    });
                    loadDetail();
                  } catch (err: any) {
                    alert(err.response?.data?.error || 'Failed');
                  }
                  setEnablingMultiBranch(false);
                }}
                disabled={enablingMultiBranch}
                className="flex items-center gap-1.5 text-sm text-amber-400 hover:text-amber-300 font-medium transition-colors border border-amber-500/20 px-3 py-1.5 rounded-xl hover:bg-amber-500/10"
              >
                <MapPin size={14} /> {enablingMultiBranch ? 'Enabling...' : 'Enable Multi-Branch'}
              </button>
            ) : (
              <button onClick={() => setShowAddBranch(true)} className="flex items-center gap-1.5 text-sm text-accent-400 hover:text-accent-300 font-medium transition-colors">
                <Plus size={14} /> Add Branch
              </button>
            )}
          </div>
        </div>

        {showAddBranch && (
          <div className="bg-dark-600 rounded-xl p-4 mb-4 border border-dark-400/50">
            <h4 className="text-sm font-semibold text-theme-heading mb-3">Add Branch</h4>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-theme-muted mb-1">Branch Name</label>
                <input type="text" value={newBranchName} onChange={e => setNewBranchName(e.target.value)}
                  placeholder="e.g. Bangalore" className="input text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-theme-muted mb-1">Code</label>
                <input type="text" value={newBranchCode} onChange={e => setNewBranchCode(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="e.g. blr" className="input text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-theme-muted mb-1">City</label>
                <input type="text" value={newBranchCity} onChange={e => setNewBranchCity(e.target.value)}
                  placeholder="optional" className="input text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-theme-muted mb-1">Manager</label>
                <input type="text" value={newBranchManager} onChange={e => setNewBranchManager(e.target.value)}
                  placeholder="optional" className="input text-sm" />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  if (!newBranchName || !newBranchCode) return;
                  await api.post(`/admin/clients/${slug}/branches`, {
                    name: newBranchName, code: newBranchCode,
                    city: newBranchCity || undefined, manager_name: newBranchManager || undefined,
                  });
                  setNewBranchName(''); setNewBranchCode(''); setNewBranchCity(''); setNewBranchManager('');
                  setShowAddBranch(false); loadDetail();
                }}
                disabled={!newBranchName || !newBranchCode}
                className="btn-primary text-xs px-3 py-2"
              >Add Branch</button>
              <button onClick={() => setShowAddBranch(false)} className="btn-secondary text-xs px-3 py-2">Cancel</button>
            </div>
          </div>
        )}

        {clientBranches.length === 0 ? (
          <p className="text-theme-faint text-center py-6 text-sm">
            {client?.is_multi_branch ? 'No branches configured' : 'Enable multi-branch to add locations'}
          </p>
        ) : (
          <div className="space-y-2">
            {clientBranches.map((branch: any) => (
              <div key={branch.id} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-dark-600 border border-dark-400/30">
                <div className="flex items-center gap-3">
                  <MapPin size={14} className={branch.is_active ? 'text-accent-400' : 'text-theme-faint'} />
                  <div>
                    <span className="text-sm font-medium text-theme-primary">{branch.name}</span>
                    <span className="text-[10px] text-theme-faint ml-2 font-mono">{branch.code}</span>
                    {branch.city && <span className="text-[10px] text-theme-faint ml-2">{branch.city}</span>}
                    {branch.manager_name && <span className="text-[10px] text-theme-muted ml-2">· {branch.manager_name}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                    branch.is_active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                  }`}>
                    {branch.is_active ? 'Active' : 'Inactive'}
                  </span>
                  {branch.is_active && (
                    <button
                      onClick={async () => {
                        if (!confirm(`Deactivate branch "${branch.name}"?`)) return;
                        await api.delete(`/admin/clients/${slug}/branches/${branch.id}`);
                        loadDetail();
                      }}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 hover:bg-red-500/10 rounded-lg transition-all"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {resetResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setResetResult(null)}>
          <div className="bg-dark-700 rounded-2xl p-6 max-w-sm w-full mx-4 border border-dark-400/50" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-theme-heading mb-3">Password Reset</h3>
            <p className="text-sm text-theme-muted mb-3">New credentials for <span className="text-accent-400">@{resetResult.username}</span>:</p>
            <div className="bg-dark-600 rounded-xl p-3 font-mono text-sm text-theme-heading mb-4 flex items-center justify-between">
              <span>{resetResult.password}</span>
              <button onClick={() => navigator.clipboard.writeText(resetResult.password)} className="text-theme-muted hover:text-accent-400 transition-colors" title="Copy password">
                <Copy size={14} />
              </button>
            </div>
            <p className="text-xs text-amber-400 mb-4">Save this password — it won't be shown again!</p>
            <button onClick={() => setResetResult(null)} className="btn-primary text-sm w-full">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Add User Form ──────────────────────────────────────────────────────────

function AddUserForm({ slug, onAdded, onCancel }: { slug: string; onAdded: () => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [createdUser, setCreatedUser] = useState<{username: string; password: string} | null>(null);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.post(`/admin/clients/${slug}/users`, { username, password, display_name: displayName, role });
      setCreatedUser({ username, password });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed');
    }
    setSaving(false);
  };

  if (createdUser) {
    return (
      <div className="bg-dark-600 rounded-xl p-4 mb-4 border border-accent-500/30">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-xl bg-accent-500/15 flex items-center justify-center">
            <CheckCircle size={16} className="text-accent-400" />
          </div>
          <h4 className="text-sm font-semibold text-accent-300">User Created!</h4>
        </div>
        <div className="bg-dark-700 rounded-xl p-3 mb-3">
          <p className="text-theme-heading font-mono text-sm">Username: <span className="text-accent-400">@{createdUser.username}</span></p>
          <div className="flex items-center justify-between mt-1">
            <p className="text-theme-heading font-mono text-sm">Password: <span className="text-accent-400">{createdUser.password}</span></p>
            <button onClick={() => navigator.clipboard.writeText(createdUser.password)} className="text-theme-muted hover:text-accent-400 transition-colors" title="Copy password">
              <Copy size={14} />
            </button>
          </div>
        </div>
        <p className="text-xs text-amber-400 mb-3">Save these credentials — the password won't be shown again!</p>
        <button onClick={onAdded} className="btn-primary text-xs px-3 py-2">Done</button>
      </div>
    );
  }

  return (
    <div className="bg-dark-600 rounded-xl p-4 mb-4 border border-dark-400/50">
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
            <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Strong password" className="input text-sm pr-9" />
            <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-theme-faint hover:text-theme-secondary">
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-muted mb-1">Role</label>
          <select value={role} onChange={e => setRole(e.target.value)} className="input text-sm">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !username || !password || !displayName} className="btn-primary text-xs px-3 py-2">
          {saving ? 'Adding...' : 'Add User'}
        </button>
        <button onClick={onCancel} className="btn-secondary text-xs px-3 py-2">Cancel</button>
      </div>
    </div>
  );
}

// ─── Team Panel ─────────────────────────────────────────────────────────────

function TeamPanel() {
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [resetResult, setResetResult] = useState<{username: string; password: string} | null>(null);

  const loadTeam = useCallback(() => {
    api.get('/admin/team').then(res => {
      setTeam(res.data);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadTeam(); }, [loadTeam]);

  const resetPassword = async (id: number, username: string) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const newPw = Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    try {
      await api.put(`/admin/team/${id}`, { password: newPw });
      setResetResult({ username, password: newPw });
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to reset password');
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-theme-heading flex items-center gap-2">
            <Shield size={16} /> Team Members
          </h3>
          <p className="text-xs text-theme-faint mt-1">Super admins who can access all clients</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-2 text-sm">
          <UserPlus size={14} /> Add Member
        </button>
      </div>

      {showAdd && (
        <AddTeamMemberForm
          onAdded={() => { setShowAdd(false); loadTeam(); }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {loading ? (
        <div className="text-center py-8">
          <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
        </div>
      ) : team.length === 0 ? (
        <p className="text-theme-faint text-center py-8 text-sm">No team members</p>
      ) : (
        <div className="space-y-2">
          {team.map(member => (
            <div key={member.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-dark-600 border border-dark-400/30">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-purple-500/10 flex items-center justify-center">
                  <Shield size={16} className="text-purple-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-theme-primary">{member.display_name}</span>
                    <span className="text-[10px] font-mono text-theme-faint">@{member.username}</span>
                  </div>
                  <span className="text-[10px] font-medium text-purple-400">{member.role}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => resetPassword(member.id, member.username)}
                  className="text-xs px-2 py-1 rounded-lg text-theme-muted bg-dark-500 hover:bg-dark-400 transition-all flex items-center gap-1"
                  title="Reset Password"
                >
                  <KeyRound size={11} /> Reset PW
                </button>
                <span className={`text-xs px-2 py-1 rounded-lg ${
                  member.is_active
                    ? 'text-emerald-400 bg-emerald-500/10'
                    : 'text-red-400 bg-red-500/10'
                }`}>
                  {member.is_active ? 'Active' : 'Disabled'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {resetResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setResetResult(null)}>
          <div className="bg-dark-700 rounded-2xl p-6 max-w-sm w-full mx-4 border border-dark-400/50" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-theme-heading mb-3">Password Reset</h3>
            <p className="text-sm text-theme-muted mb-3">New credentials for <span className="text-accent-400">@{resetResult.username}</span>:</p>
            <div className="bg-dark-600 rounded-xl p-3 font-mono text-sm text-theme-heading mb-4 flex items-center justify-between">
              <span>{resetResult.password}</span>
              <button onClick={() => navigator.clipboard.writeText(resetResult.password)} className="text-theme-muted hover:text-accent-400 transition-colors" title="Copy password">
                <Copy size={14} />
              </button>
            </div>
            <p className="text-xs text-amber-400 mb-4">Save this password — it won't be shown again!</p>
            <button onClick={() => setResetResult(null)} className="btn-primary text-sm w-full">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Add Team Member Form ───────────────────────────────────────────────────

function AddTeamMemberForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [createdUser, setCreatedUser] = useState<{username: string; password: string} | null>(null);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.post('/admin/team', { username, password, display_name: displayName, role: 'super_admin' });
      setCreatedUser({ username, password });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed');
    }
    setSaving(false);
  };

  if (createdUser) {
    return (
      <div className="bg-dark-600 rounded-xl p-4 mb-4 border border-accent-500/30">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-xl bg-accent-500/15 flex items-center justify-center">
            <CheckCircle size={16} className="text-accent-400" />
          </div>
          <h4 className="text-sm font-semibold text-accent-300">Team Member Created!</h4>
        </div>
        <div className="bg-dark-700 rounded-xl p-3 mb-3">
          <p className="text-theme-heading font-mono text-sm">Username: <span className="text-accent-400">@{createdUser.username}</span></p>
          <div className="flex items-center justify-between mt-1">
            <p className="text-theme-heading font-mono text-sm">Password: <span className="text-accent-400">{createdUser.password}</span></p>
            <button onClick={() => navigator.clipboard.writeText(createdUser.password)} className="text-theme-muted hover:text-accent-400 transition-colors" title="Copy password">
              <Copy size={14} />
            </button>
          </div>
        </div>
        <p className="text-xs text-amber-400 mb-3">Save these credentials — the password won't be shown again!</p>
        <button onClick={onAdded} className="btn-primary text-xs px-3 py-2">Done</button>
      </div>
    );
  }

  return (
    <div className="bg-dark-600 rounded-xl p-4 mb-4 border border-dark-400/50">
      <h4 className="text-sm font-semibold text-theme-heading mb-3">Add Team Member</h4>
      <p className="text-xs text-theme-faint mb-3">Team members are super admins with access to all clients.</p>
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
        <button onClick={save} disabled={saving || !username || !password || !displayName} className="btn-primary text-xs px-3 py-2">
          {saving ? 'Adding...' : 'Add Team Member'}
        </button>
        <button onClick={onCancel} className="btn-secondary text-xs px-3 py-2">Cancel</button>
      </div>
    </div>
  );
}
