/**
 * Company Groups — manage logical groupings of Tally companies
 */
import { useState, useEffect, useCallback } from 'react';
import { Building2, Plus, Trash2, Users, Edit3, Check, X } from 'lucide-react';
import api from '../../api/client';

interface Company {
  id: number;
  name: string;
  state?: string;
  city?: string;
  location?: string;
  entity_type?: string;
}

interface Group {
  id: number;
  name: string;
  description: string;
  member_count: number;
  members: Company[];
}

export default function CompanyGroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

  // Member management
  const [managingId, setManagingId] = useState<number | null>(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<number[]>([]);
  const [savingMembers, setSavingMembers] = useState(false);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const fetchGroups = useCallback(() => {
    api.get('/vcfo/groups').then(r => setGroups(r.data || [])).catch(() => {});
  }, []);

  const fetchCompanies = useCallback(() => {
    api.get('/vcfo/companies').then(r => setCompanies(r.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get('/vcfo/groups').then(r => setGroups(r.data || [])),
      api.get('/vcfo/companies').then(r => setCompanies(r.data || [])),
    ]).catch(() => {}).finally(() => setLoading(false));
  }, []);

  /* ---------- Create ---------- */
  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.post('/vcfo/groups', { name: newName.trim(), description: newDesc.trim() });
      setNewName(''); setNewDesc(''); setShowCreate(false);
      fetchGroups();
    } catch { /* swallow */ }
    setCreating(false);
  };

  /* ---------- Edit ---------- */
  const startEdit = (g: Group) => {
    setEditingId(g.id); setEditName(g.name); setEditDesc(g.description || '');
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    try {
      await api.put(`/vcfo/groups/${editingId}`, { name: editName.trim(), description: editDesc.trim() });
      fetchGroups();
    } catch { /* swallow */ }
    setEditingId(null);
  };

  /* ---------- Delete ---------- */
  const confirmDelete = async (id: number) => {
    try { await api.delete(`/vcfo/groups/${id}`); fetchGroups(); } catch { /* swallow */ }
    setDeletingId(null);
  };

  /* ---------- Members ---------- */
  const openMembers = (g: Group) => {
    setManagingId(g.id);
    setSelectedCompanyIds(g.members.map(m => m.id));
  };
  const closeMembers = () => { setManagingId(null); setSelectedCompanyIds([]); };
  const toggleCompany = (id: number) => {
    setSelectedCompanyIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const saveMembers = async () => {
    if (managingId === null) return;
    setSavingMembers(true);
    try {
      await api.put(`/vcfo/groups/${managingId}/members`, { company_ids: selectedCompanyIds });
      fetchGroups();
    } catch { /* swallow */ }
    setSavingMembers(false);
    closeMembers();
  };

  /* ---------- Render ---------- */
  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" />
      </div>
    );
  }

  const managedGroup = groups.find(g => g.id === managingId);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-dark-700 border border-dark-400/30 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-theme-heading flex items-center gap-2">
            <Building2 className="w-5 h-5 text-indigo-400" />
            Company Groups
          </h1>
          <p className="text-xs text-theme-faint mt-0.5">
            Organize Tally companies into logical groups for consolidated reporting
          </p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setNewName(''); setNewDesc(''); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> New Group
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="bg-dark-700 border border-dark-400/30 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-theme-heading">Create New Group</h2>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Group name"
            className="w-full bg-dark-600 border border-dark-400/40 rounded-lg px-3 py-2 text-sm text-theme-body placeholder-theme-faint focus:outline-none focus:border-indigo-500"
          />
          <input
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full bg-dark-600 border border-dark-400/40 rounded-lg px-3 py-2 text-sm text-theme-body placeholder-theme-faint focus:outline-none focus:border-indigo-500"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              <Check className="w-4 h-4" /> {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dark-600 hover:bg-dark-500 text-theme-muted text-sm transition-colors"
            >
              <X className="w-4 h-4" /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Groups list */}
      {groups.length === 0 && (
        <div className="bg-dark-700 border border-dark-400/30 rounded-xl p-10 text-center">
          <Users className="w-10 h-10 text-theme-faint mx-auto mb-3" />
          <p className="text-theme-muted text-sm">No groups created yet. Click "New Group" to get started.</p>
        </div>
      )}

      <div className="grid gap-4">
        {groups.map(g => (
          <div key={g.id} className="bg-dark-700 border border-dark-400/30 rounded-xl p-5">
            {/* Group header row */}
            {editingId === g.id ? (
              /* Inline edit mode */
              <div className="space-y-2">
                <input
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="w-full bg-dark-600 border border-dark-400/40 rounded-lg px-3 py-1.5 text-sm text-theme-body focus:outline-none focus:border-indigo-500"
                />
                <input
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                  placeholder="Description"
                  className="w-full bg-dark-600 border border-dark-400/40 rounded-lg px-3 py-1.5 text-sm text-theme-body placeholder-theme-faint focus:outline-none focus:border-indigo-500"
                />
                <div className="flex gap-2">
                  <button onClick={saveEdit} className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors">
                    <Check className="w-3.5 h-3.5" /> Save
                  </button>
                  <button onClick={cancelEdit} className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-dark-600 hover:bg-dark-500 text-theme-muted text-xs transition-colors">
                    <X className="w-3.5 h-3.5" /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Display mode */
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-theme-heading truncate">{g.name}</h3>
                    <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 text-[10px] font-bold">
                      <Users className="w-3 h-3" /> {g.member_count}
                    </span>
                  </div>
                  {g.description && (
                    <p className="text-xs text-theme-faint mt-0.5">{g.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => openMembers(g)} title="Manage members"
                    className="p-1.5 rounded-md hover:bg-dark-600 text-theme-faint hover:text-indigo-400 transition-colors">
                    <Users className="w-4 h-4" />
                  </button>
                  <button onClick={() => startEdit(g)} title="Edit group"
                    className="p-1.5 rounded-md hover:bg-dark-600 text-theme-faint hover:text-amber-400 transition-colors">
                    <Edit3 className="w-4 h-4" />
                  </button>
                  {deletingId === g.id ? (
                    <div className="flex items-center gap-1 ml-1">
                      <span className="text-[10px] text-red-400 font-medium">Delete?</span>
                      <button onClick={() => confirmDelete(g.id)}
                        className="p-1 rounded bg-red-600 hover:bg-red-500 text-white transition-colors">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setDeletingId(null)}
                        className="p-1 rounded bg-dark-600 hover:bg-dark-500 text-theme-muted transition-colors">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setDeletingId(g.id)} title="Delete group"
                      className="p-1.5 rounded-md hover:bg-dark-600 text-theme-faint hover:text-red-400 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Member pills */}
            {editingId !== g.id && g.members && g.members.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-dark-400/20">
                {g.members.map(m => (
                  <span key={m.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-dark-600 text-theme-body text-[11px]">
                    <Building2 className="w-3 h-3 text-theme-faint" />
                    {m.name}
                    {m.entity_type && <span className="text-theme-faint">({m.entity_type})</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Member management modal overlay */}
      {managingId !== null && managedGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-dark-700 border border-dark-400/30 rounded-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
            {/* Modal header */}
            <div className="p-5 border-b border-dark-400/20">
              <h2 className="text-sm font-bold text-theme-heading">
                Manage Members — {managedGroup.name}
              </h2>
              <p className="text-[11px] text-theme-faint mt-0.5">
                Select companies to include in this group
              </p>
            </div>

            {/* Company list */}
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              {companies.length === 0 && (
                <p className="text-theme-muted text-sm text-center py-6">No companies available.</p>
              )}
              {companies.map(c => {
                const checked = selectedCompanyIds.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                      checked ? 'bg-indigo-500/10 border border-indigo-500/30' : 'hover:bg-dark-600 border border-transparent'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCompany(c.id)}
                      className="w-4 h-4 rounded border-dark-400 bg-dark-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-theme-body">{c.name}</span>
                      {(c.city || c.state || c.entity_type) && (
                        <span className="text-[10px] text-theme-faint ml-2">
                          {[c.entity_type, c.city, c.state].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            {/* Modal footer */}
            <div className="p-4 border-t border-dark-400/20 flex items-center justify-between">
              <span className="text-[11px] text-theme-faint">
                {selectedCompanyIds.length} selected
              </span>
              <div className="flex gap-2">
                <button
                  onClick={closeMembers}
                  className="px-3 py-1.5 rounded-lg bg-dark-600 hover:bg-dark-500 text-theme-muted text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveMembers}
                  disabled={savingMembers}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium transition-colors"
                >
                  <Check className="w-4 h-4" /> {savingMembers ? 'Saving...' : 'Save Members'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
