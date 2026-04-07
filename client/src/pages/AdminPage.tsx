import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import {
  Building2, Users, UserPlus, Plus, Edit3, Power, ChevronRight, ArrowLeft,
  Eye, EyeOff, CheckCircle, XCircle, Plug, Shield, Trash2
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
          <h1 className="text-2xl font-bold text-white">Admin Panel</h1>
          <p className="text-slate-500 mt-1 text-sm">Manage clients, users, and integrations</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('clients')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
            tab === 'clients'
              ? 'bg-accent-500 text-white shadow-glow'
              : 'bg-dark-700 text-slate-400 border border-dark-400/50 hover:border-dark-300'
          }`}
        >
          <Building2 size={16} /> Clients
        </button>
        <button
          onClick={() => setTab('team')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
            tab === 'team'
              ? 'bg-accent-500 text-white shadow-glow'
              : 'bg-dark-700 text-slate-400 border border-dark-400/50 hover:border-dark-300'
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
          <h3 className="font-semibold text-white">All Clients</h3>
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={14} /> Add Client
          </button>
        </div>

        {loading ? (
          <div className="text-center py-8">
            <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
          </div>
        ) : clients.length === 0 ? (
          <p className="text-slate-600 text-center py-8">No clients yet. Create your first client above.</p>
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
                    <span className="font-medium text-white">{client.name}</span>
                    <span className="text-xs text-slate-600">({client.slug})</span>
                    {client.is_active ? (
                      <span className="badge-success text-[10px]">Active</span>
                    ) : (
                      <span className="badge-danger text-[10px]">Inactive</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-slate-500 flex items-center gap-1">
                      <Users size={11} /> {client.user_count} user{client.user_count !== 1 ? 's' : ''}
                    </span>
                    {client.integrations && (
                      <span className="text-xs text-slate-500">
                        {client.integrations.split(',').join(', ')}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight size={16} className="text-slate-600 group-hover:text-accent-400 transition-colors" />
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  const autoSlug = (n: string) => {
    setName(n);
    setSlug(n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  };

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.post('/admin/clients', { slug, name });
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
            <p className="text-sm text-slate-500">{result.name}</p>
          </div>
        </div>
        <div className="bg-dark-600 rounded-xl p-4 mb-4">
          <p className="text-sm text-slate-300 mb-1">Default login credentials:</p>
          <p className="text-white font-mono text-sm">Username: <span className="text-accent-400">admin</span></p>
          <p className="text-white font-mono text-sm">Password: <span className="text-accent-400">admin123</span></p>
          <p className="text-xs text-amber-400 mt-2">Change this password immediately after first login!</p>
        </div>
        <button onClick={onCreated} className="btn-primary text-sm">Done</button>
      </div>
    );
  }

  return (
    <div className="card mb-6">
      <h3 className="font-semibold text-white mb-4">Create New Client</h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-1.5">Client Name</label>
          <input type="text" value={name} onChange={e => autoSlug(e.target.value)}
            placeholder="e.g. Apollo Healthcare" className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-1.5">Slug (URL identifier)</label>
          <input type="text" value={slug} onChange={e => setSlug(e.target.value)}
            placeholder="e.g. apollo-healthcare" className="input font-mono" />
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
  const [loading, setLoading] = useState(true);
  const [showAddUser, setShowAddUser] = useState(false);

  const loadDetail = useCallback(() => {
    Promise.all([
      api.get(`/admin/clients/${slug}`),
      api.get(`/admin/clients/${slug}/integrations`),
    ]).then(([clientRes, intRes]) => {
      setClient(clientRes.data);
      setUsers(clientRes.data.users || []);
      setIntegrations(intRes.data.catalog || []);
      setLoading(false);
    });
  }, [slug]);

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

  if (loading) return (
    <div className="text-center py-12">
      <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto" />
    </div>
  );

  return (
    <div>
      {/* Header */}
      <button onClick={onBack} className="flex items-center gap-2 text-sm text-slate-400 hover:text-accent-400 mb-4 transition-colors">
        <ArrowLeft size={14} /> Back to clients
      </button>

      <div className="card mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent-500/10 flex items-center justify-center">
              <Building2 size={22} className="text-accent-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">{client.name}</h2>
              <p className="text-sm text-slate-500 font-mono">{client.slug}</p>
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
            <h3 className="font-semibold text-white flex items-center gap-2">
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
            <p className="text-slate-600 text-center py-6 text-sm">No users</p>
          ) : (
            <div className="space-y-2">
              {users.map(user => (
                <div key={user.id} className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-dark-600 border border-dark-400/30">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-200">{user.display_name}</span>
                      <span className="text-[10px] font-mono text-slate-500">@{user.username}</span>
                    </div>
                    <span className={`text-[10px] font-medium ${user.role === 'admin' ? 'text-amber-400' : 'text-slate-500'}`}>
                      {user.role}
                    </span>
                  </div>
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
              ))}
            </div>
          )}
        </div>

        {/* Integrations */}
        <div className="card">
          <h3 className="font-semibold text-white flex items-center gap-2 mb-4">
            <Plug size={16} /> Integrations
          </h3>
          <div className="space-y-2">
            {integrations.map(int => (
              <div key={int.key} className="flex items-center justify-between px-3 py-3 rounded-xl bg-dark-600 border border-dark-400/30">
                <div>
                  <span className="text-sm font-medium text-slate-200">{int.name}</span>
                  <p className="text-xs text-slate-500 mt-0.5">{int.description}</p>
                </div>
                <button
                  onClick={() => toggleIntegration(int.key, int.enabled)}
                  className={`relative w-10 h-5 rounded-full transition-all ${
                    int.enabled ? 'bg-accent-500' : 'bg-dark-400'
                  }`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                    int.enabled ? 'left-5.5 left-[22px]' : 'left-0.5'
                  }`} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
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

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.post(`/admin/clients/${slug}/users`, { username, password, display_name: displayName, role });
      onAdded();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed');
    }
    setSaving(false);
  };

  return (
    <div className="bg-dark-600 rounded-xl p-4 mb-4 border border-dark-400/50">
      <h4 className="text-sm font-semibold text-white mb-3">Add New User</h4>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Display Name</label>
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="John Doe" className="input text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="john" className="input text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Strong password" className="input text-sm pr-9" />
            <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Role</label>
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

  const loadTeam = useCallback(() => {
    api.get('/admin/team').then(res => {
      setTeam(res.data);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadTeam(); }, [loadTeam]);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-white flex items-center gap-2">
            <Shield size={16} /> Team Members
          </h3>
          <p className="text-xs text-slate-500 mt-1">Super admins who can access all clients</p>
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
        <p className="text-slate-600 text-center py-8 text-sm">No team members</p>
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
                    <span className="text-sm font-medium text-slate-200">{member.display_name}</span>
                    <span className="text-[10px] font-mono text-slate-500">@{member.username}</span>
                  </div>
                  <span className="text-[10px] font-medium text-purple-400">{member.role}</span>
                </div>
              </div>
              <span className={`text-xs px-2 py-1 rounded-lg ${
                member.is_active
                  ? 'text-emerald-400 bg-emerald-500/10'
                  : 'text-red-400 bg-red-500/10'
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

// ─── Add Team Member Form ───────────────────────────────────────────────────

function AddTeamMemberForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.post('/admin/team', { username, password, display_name: displayName, role: 'super_admin' });
      onAdded();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed');
    }
    setSaving(false);
  };

  return (
    <div className="bg-dark-600 rounded-xl p-4 mb-4 border border-dark-400/50">
      <h4 className="text-sm font-semibold text-white mb-3">Add Team Member</h4>
      <p className="text-xs text-slate-500 mb-3">Team members are super admins with access to all clients.</p>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Display Name</label>
          <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Jane Smith" className="input text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="jane" className="input text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Password</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Strong password" className="input text-sm pr-9" />
            <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
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
