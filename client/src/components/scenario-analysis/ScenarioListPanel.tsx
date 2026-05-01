import { useEffect, useState } from 'react';
import { Plus, Copy, Edit2, Star, Trash2, Check, X } from 'lucide-react';
import api from '../../api/client';
import { FY, Scenario } from '../../pages/ForecastModulePage';
import { canWriteForecast } from '../../utils/roles';

interface Props {
  disabled: boolean;
  fy: FY | null;
  scenarios: Scenario[];
  onReload: () => void;
}

interface ScenarioStats {
  itemCount: number;
}

export default function ScenarioListPanel({ disabled, fy, scenarios, onReload }: Props) {
  const canWrite = canWriteForecast();
  const [stats, setStats] = useState<Record<number, ScenarioStats>>({});
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [duplicateFor, setDuplicateFor] = useState<Scenario | null>(null);
  const [duplicateName, setDuplicateName] = useState('');
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);

  useEffect(() => {
    // Pull item counts for the table — one cheap call per scenario.
    let cancelled = false;
    const next: Record<number, ScenarioStats> = {};
    Promise.all(
      scenarios.map(s =>
        api.get('/forecast-module/items', { params: { scenario_id: s.id } })
          .then(r => { next[s.id] = { itemCount: Array.isArray(r.data) ? r.data.length : 0 }; })
          .catch(() => { next[s.id] = { itemCount: 0 }; })
      )
    ).then(() => {
      if (!cancelled) setStats(next);
    });
    return () => { cancelled = true; };
  }, [scenarios]);

  if (disabled) return null;

  const handleCreate = async () => {
    if (!fy || !createName.trim()) return;
    setCreateBusy(true);
    try {
      await api.post('/forecast-module/scenarios', { fy_id: fy.id, name: createName.trim() });
      setCreateOpen(false);
      setCreateName('');
      onReload();
    } catch (e: any) {
      alert(`Could not create scenario: ${e?.response?.data?.error || e.message}`);
    } finally {
      setCreateBusy(false);
    }
  };

  const handleDuplicate = async () => {
    if (!duplicateFor || !duplicateName.trim()) return;
    setDuplicateBusy(true);
    try {
      await api.post(`/forecast-module/scenarios/${duplicateFor.id}/duplicate`, { name: duplicateName.trim() });
      setDuplicateFor(null);
      setDuplicateName('');
      onReload();
    } catch (e: any) {
      alert(`Could not duplicate: ${e?.response?.data?.error || e.message}`);
    } finally {
      setDuplicateBusy(false);
    }
  };

  const handleRename = async (id: number) => {
    if (!renameValue.trim()) return;
    setPendingId(id);
    try {
      await api.put(`/forecast-module/scenarios/${id}`, { name: renameValue.trim() });
      setRenamingId(null);
      setRenameValue('');
      onReload();
    } catch (e: any) {
      alert(`Rename failed: ${e?.response?.data?.error || e.message}`);
    } finally {
      setPendingId(null);
    }
  };

  const handleSetDefault = async (id: number) => {
    setPendingId(id);
    try {
      await api.put(`/forecast-module/scenarios/${id}/set-default`);
      onReload();
    } catch (e: any) {
      alert(`Set default failed: ${e?.response?.data?.error || e.message}`);
    } finally {
      setPendingId(null);
    }
  };

  const handleDelete = async (s: Scenario) => {
    const isOnly = scenarios.length === 1;
    if (isOnly) {
      alert('You cannot delete the only scenario in this branch & stream. Create another first.');
      return;
    }
    const warn = s.is_default ? '\n\nThis is the default scenario — another scenario will be promoted automatically.' : '';
    if (!window.confirm(`Delete scenario "${s.name}"? This permanently removes its forecast items, values, and linked actuals.${warn}`)) return;
    setPendingId(s.id);
    try {
      await api.delete(`/forecast-module/scenarios/${s.id}`);
      onReload();
    } catch (e: any) {
      alert(`Delete failed: ${e?.response?.data?.error || e.message}`);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--mt-text-heading)' }}>Scenarios</div>
          <div style={{ fontSize: 12, color: 'var(--mt-text-muted)', marginTop: 2 }}>
            Manage forecast scenarios for {fy?.label || 'this fiscal year'}. The default scenario is what dashboards & exports use unless you explicitly switch.
          </div>
        </div>
        {canWrite && (
          <button
            onClick={() => { setCreateName(''); setCreateOpen(true); }}
            className="mt-btn-gradient"
            style={{ padding: '8px 14px', fontSize: 13 }}
            disabled={!fy}
          >
            <Plus size={14} />
            <span>New scenario</span>
          </button>
        )}
      </div>

      {scenarios.length === 0 ? (
        <div
          className="px-6 py-12 rounded-lg text-center"
          style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--mt-text-heading)', marginBottom: 4 }}>
            No scenarios yet
          </div>
          <div style={{ fontSize: 13, color: 'var(--mt-text-muted)' }}>
            {canWrite ? 'Click "New scenario" to start.' : 'Ask an admin to create one.'}
          </div>
        </div>
      ) : (
        <div
          className="rounded-lg overflow-hidden"
          style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
        >
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--mt-bg-raised)', color: 'var(--mt-text-muted)' }}>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium" style={{ width: 110 }}>Default</th>
                <th className="text-right px-4 py-2 font-medium" style={{ width: 110 }}>Items</th>
                <th className="text-left px-4 py-2 font-medium" style={{ width: 140 }}>Created</th>
                <th className="text-right px-4 py-2 font-medium" style={{ width: 220 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map(s => {
                const isRenaming = renamingId === s.id;
                const busy = pendingId === s.id;
                const created = (s as any).created_at
                  ? new Date((s as any).created_at).toLocaleDateString()
                  : '—';
                return (
                  <tr
                    key={s.id}
                    style={{ borderTop: '1px solid var(--mt-border)' }}
                  >
                    <td className="px-4 py-2">
                      {isRenaming ? (
                        <div className="flex items-center gap-2">
                          <input
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            className="mt-input"
                            style={{ padding: '4px 8px', fontSize: 13, width: '100%' }}
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleRename(s.id);
                              if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                            }}
                          />
                          <button
                            onClick={() => handleRename(s.id)}
                            disabled={busy}
                            className="mt-btn-ghost"
                            style={{ padding: 4 }}
                            title="Save"
                          ><Check size={14} /></button>
                          <button
                            onClick={() => { setRenamingId(null); setRenameValue(''); }}
                            className="mt-btn-ghost"
                            style={{ padding: 4 }}
                            title="Cancel"
                          ><X size={14} /></button>
                        </div>
                      ) : (
                        <span style={{ fontWeight: 500, color: 'var(--mt-text-heading)' }}>{s.name}</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {s.is_default ? (
                        <span className="mt-pill mt-pill--success" style={{ fontSize: 11 }}>Default</span>
                      ) : (
                        <span style={{ color: 'var(--mt-text-faint)', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right mt-num" style={{ color: 'var(--mt-text-muted)' }}>
                      {stats[s.id]?.itemCount ?? '…'}
                    </td>
                    <td className="px-4 py-2" style={{ color: 'var(--mt-text-muted)' }}>{created}</td>
                    <td className="px-4 py-2">
                      {canWrite ? (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => { setRenamingId(s.id); setRenameValue(s.name); }}
                            className="mt-btn-ghost"
                            style={{ padding: '4px 8px', fontSize: 12 }}
                            disabled={busy || isRenaming}
                            title="Rename"
                          >
                            <Edit2 size={13} />
                          </button>
                          <button
                            onClick={() => { setDuplicateFor(s); setDuplicateName(`${s.name} (copy)`); }}
                            className="mt-btn-ghost"
                            style={{ padding: '4px 8px', fontSize: 12 }}
                            disabled={busy}
                            title="Duplicate"
                          >
                            <Copy size={13} />
                          </button>
                          <button
                            onClick={() => handleSetDefault(s.id)}
                            className="mt-btn-ghost"
                            style={{ padding: '4px 8px', fontSize: 12, opacity: s.is_default ? 0.4 : 1 }}
                            disabled={busy || !!s.is_default}
                            title={s.is_default ? 'Already default' : 'Make default'}
                          >
                            <Star size={13} />
                          </button>
                          <button
                            onClick={() => handleDelete(s)}
                            className="mt-btn-ghost"
                            style={{
                              padding: '4px 8px',
                              fontSize: 12,
                              color: '#ef4444',
                              // A subtle red-tinted border telegraphs the
                              // destructive action without shouting. Pure
                              // red with no border read as "just a coloured
                              // icon" and was easy to miss as a button.
                              borderColor: 'color-mix(in srgb, #ef4444 30%, transparent)',
                            }}
                            disabled={busy}
                            title="Delete scenario — removes its items, values, and linked actuals. Cannot be undone."
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--mt-text-faint)', fontSize: 12 }}>read-only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* New scenario modal */}
      {createOpen && (
        <Modal title="New scenario" onClose={() => setCreateOpen(false)}>
          <input
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            placeholder="e.g. Optimistic, Q1 plan, Best case"
            className="mt-input w-full"
            style={{ padding: '8px 10px', fontSize: 13 }}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
          />
          <div className="flex items-center justify-end gap-2 mt-4">
            <button onClick={() => setCreateOpen(false)} className="mt-btn-ghost" style={{ padding: '6px 12px', fontSize: 13 }}>Cancel</button>
            <button
              onClick={handleCreate}
              disabled={createBusy || !createName.trim()}
              className="mt-btn-gradient"
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              {createBusy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </Modal>
      )}

      {/* Duplicate modal */}
      {duplicateFor && (
        <Modal
          title={`Duplicate "${duplicateFor.name}"`}
          onClose={() => setDuplicateFor(null)}
        >
          <div style={{ fontSize: 12, color: 'var(--mt-text-muted)', marginBottom: 8 }}>
            Copies all line items, monthly values, and settings into a new scenario.
          </div>
          <input
            value={duplicateName}
            onChange={e => setDuplicateName(e.target.value)}
            placeholder="New scenario name"
            className="mt-input w-full"
            style={{ padding: '8px 10px', fontSize: 13 }}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleDuplicate(); }}
          />
          <div className="flex items-center justify-end gap-2 mt-4">
            <button onClick={() => setDuplicateFor(null)} className="mt-btn-ghost" style={{ padding: '6px 12px', fontSize: 13 }}>Cancel</button>
            <button
              onClick={handleDuplicate}
              disabled={duplicateBusy || !duplicateName.trim()}
              className="mt-btn-gradient"
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              {duplicateBusy ? 'Copying…' : 'Duplicate'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--mt-bg-surface)',
          border: '1px solid var(--mt-border)',
          borderRadius: 12,
          padding: 20,
          width: '100%',
          maxWidth: 420,
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--mt-text-heading)', marginBottom: 12 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}
