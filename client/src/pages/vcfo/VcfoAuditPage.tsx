/**
 * Audit Tracker — Matches TallyVision's Audit panel
 * Sub-tabs (Milestones/Observations), progress bar, status badges, observation cards
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, X, Sprout } from 'lucide-react';
import api from '../../api/client';

interface Milestone { id: number; name: string; sort_order: number; }
interface MilestoneStatus { status: string; due_date: string | null; completion_date: string | null; assigned_to: string; notes: string; }
interface Observation {
  id: number; company_id: number; fy_year: number; title: string; description: string;
  severity: string; category: string; recommendation: string; mgmt_response: string;
  status: string; assigned_to: string; due_date: string; resolution_date: string; created_at: string;
}

const milestoneStatuses = ['pending', 'in_progress', 'completed', 'blocked'];
const msLabels: Record<string, string> = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed', blocked: 'Blocked' };
const obsStatuses = ['open', 'in_progress', 'resolved', 'closed'];
const obsLabels: Record<string, string> = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed' };

export default function VcfoAuditPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [fyYear, setFyYear] = useState<number>(new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1);
  const [view, setView] = useState<'milestones' | 'observations'>('milestones');

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, MilestoneStatus>>({});
  const [seeding, setSeeding] = useState(false);

  const [observations, setObservations] = useState<Observation[]>([]);
  const [showAddObs, setShowAddObs] = useState(false);
  const [obsForm, setObsForm] = useState({ title: '', description: '', severity: 'medium', category: '', recommendation: '', assigned_to: '', due_date: '' });

  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => {
    api.get('/vcfo/companies').then(r => {
      setCompanies(r.data || []);
      if (r.data?.length > 0) setCompanyId(String(r.data[0].id));
    }).catch(() => {});
  }, []);

  const loadData = useCallback(() => {
    if (!companyId) return;
    setLoading(true);
    const params: any = { companyId, fy: fyYear };
    Promise.all([
      api.get('/vcfo/audit/milestone-status', { params }),
      api.get('/vcfo/audit/observations', { params }),
      api.get('/vcfo/audit/summary', { params: { fy: fyYear } }),
    ]).then(([msRes, obsRes, sumRes]) => {
      setMilestones(msRes.data.milestones || []);
      setStatusMap(msRes.data.statuses || {});
      setObservations(obsRes.data || []);
      setSummary(sumRes.data || null);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [companyId, fyYear]);

  useEffect(() => { loadData(); }, [loadData]);

  const updateMilestoneStatus = (milestoneId: number, status: string) => {
    if (!companyId) return;
    api.put('/vcfo/audit/milestone-status', {
      milestone_id: milestoneId, company_id: parseInt(companyId), fy_year: fyYear, status,
    }).then(() => {
      const key = `${milestoneId}-${companyId}-${fyYear}`;
      setStatusMap(prev => ({ ...prev, [key]: { ...prev[key], status } as MilestoneStatus }));
    }).catch(() => {});
  };

  const seedMilestones = () => {
    setSeeding(true);
    api.post('/vcfo/audit/milestones/seed').then(() => loadData()).finally(() => setSeeding(false));
  };

  const addObservation = () => {
    if (!obsForm.title.trim()) return;
    api.post('/vcfo/audit/observations', { ...obsForm, company_id: parseInt(companyId), fy_year: fyYear })
      .then(() => {
        setObsForm({ title: '', description: '', severity: 'medium', category: '', recommendation: '', assigned_to: '', due_date: '' });
        setShowAddObs(false);
        loadData();
      }).catch(() => {});
  };

  const updateObservation = (id: number, updates: any) => {
    api.put(`/vcfo/audit/observations/${id}`, updates).then(() => loadData()).catch(() => {});
  };

  const completedMs = milestones.filter(m => {
    const key = `${m.id}-${companyId}-${fyYear}`;
    return statusMap[key]?.status === 'completed';
  }).length;
  const progressPct = milestones.length > 0 ? (completedMs / milestones.length) * 100 : 0;

  return (
    <div className="space-y-5">
      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="card-tv p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-theme-heading">Audit Tracker</h1>
            <p className="text-xs text-theme-faint mt-0.5">Milestones & observations for audit engagements</p>
          </div>
          <div className="flex items-center gap-3">
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} className="tv-input min-w-[160px]">
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={fyYear} onChange={e => setFyYear(parseInt(e.target.value))} className="tv-input">
              {Array.from({ length: 5 }, (_, i) => {
                const y = new Date().getFullYear() - i;
                return <option key={y} value={y}>FY {y}-{(y + 1).toString().slice(2)}</option>;
              })}
            </select>
          </div>
        </div>
      </div>

      {/* ── Sub-tabs ────────────────────────────────────────── */}
      <div className="flex gap-1">
        <button onClick={() => setView('milestones')} className={`tv-tab ${view === 'milestones' ? 'active' : ''}`}>Milestones</button>
        <button onClick={() => setView('observations')} className={`tv-tab ${view === 'observations' ? 'active' : ''}`}>Observations</button>
      </div>

      {/* ── Summary Cards ───────────────────────────────────── */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card-tv p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Milestone Progress</div>
            <div className="text-xl font-bold text-theme-heading">{completedMs} / {milestones.length}</div>
            <div className="tv-progress-bar mt-2">
              <div className="tv-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
          <div className="card-tv p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Open Issues</div>
            <div className="text-xl font-bold text-red-400">{summary.observations?.open || 0}</div>
          </div>
          <div className="card-tv p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">High Severity</div>
            <div className="text-xl font-bold text-amber-400">{summary.observations?.high || 0}</div>
          </div>
          <div className="card-tv p-4">
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Resolved</div>
            <div className="text-xl font-bold text-emerald-400">{summary.observations?.resolved || 0}</div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" />
        </div>
      )}

      {/* ═══ Milestones View ════════════════════════════════════ */}
      {!loading && view === 'milestones' && (
        <>
          {milestones.length === 0 ? (
            <div className="card-tv p-12 text-center">
              <p className="text-theme-faint text-sm mb-4">No audit milestones configured</p>
              <button onClick={seedMilestones} disabled={seeding}
                className="tv-tab active inline-flex items-center gap-1.5">
                <Sprout size={14} /> {seeding ? 'Seeding...' : 'Seed Default Milestones'}
              </button>
            </div>
          ) : (
            <div className="card-tv overflow-hidden">
              <table className="tv-table">
                <thead>
                  <tr>
                    <th className="w-12">#</th>
                    <th>Milestone</th>
                    <th className="w-32 text-center">Status</th>
                    <th className="w-40 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {milestones.map((ms, idx) => {
                    const key = `${ms.id}-${companyId}-${fyYear}`;
                    const status = statusMap[key]?.status || 'pending';
                    return (
                      <tr key={ms.id}>
                        <td className="text-center text-theme-faint font-bold">{idx + 1}</td>
                        <td className={`font-medium ${status === 'completed' ? 'line-through text-theme-faint' : ''}`}>{ms.name}</td>
                        <td className="text-center">
                          <span className={`tv-status-badge ${status}`}>{msLabels[status]}</span>
                        </td>
                        <td>
                          <div className="flex justify-center gap-1">
                            {milestoneStatuses.map(s => (
                              <button key={s} onClick={() => updateMilestoneStatus(ms.id, s)}
                                className={`px-2 py-1 text-[9px] font-semibold rounded transition-colors ${
                                  status === s
                                    ? 'bg-indigo-600 text-white'
                                    : 'text-theme-faint hover:text-theme-primary hover:bg-[rgb(var(--c-dark-600))]'
                                }`}>
                                {msLabels[s]}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ═══ Observations View ══════════════════════════════════ */}
      {!loading && view === 'observations' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => setShowAddObs(!showAddObs)}
              className="tv-tab active inline-flex items-center gap-1.5">
              {showAddObs ? <X size={13} /> : <Plus size={13} />}
              {showAddObs ? 'Cancel' : 'Add Observation'}
            </button>
          </div>

          {showAddObs && (
            <div className="card-tv p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Title *</label>
                  <input value={obsForm.title} onChange={e => setObsForm(p => ({ ...p, title: e.target.value }))} className="tv-input w-full" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Category</label>
                  <input value={obsForm.category} onChange={e => setObsForm(p => ({ ...p, category: e.target.value }))} placeholder="e.g., Taxation" className="tv-input w-full" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Description</label>
                  <textarea value={obsForm.description} onChange={e => setObsForm(p => ({ ...p, description: e.target.value }))} rows={3} className="tv-input w-full" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Severity</label>
                  <select value={obsForm.severity} onChange={e => setObsForm(p => ({ ...p, severity: e.target.value }))} className="tv-input w-full">
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Assigned To</label>
                  <input value={obsForm.assigned_to} onChange={e => setObsForm(p => ({ ...p, assigned_to: e.target.value }))} className="tv-input w-full" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Recommendation</label>
                  <textarea value={obsForm.recommendation} onChange={e => setObsForm(p => ({ ...p, recommendation: e.target.value }))} rows={2} className="tv-input w-full" />
                </div>
              </div>
              <button onClick={addObservation} className="tv-tab active">Add Observation</button>
            </div>
          )}

          {observations.length === 0 && !showAddObs && (
            <div className="card-tv p-12 text-center text-theme-faint text-sm">
              No audit observations for this company and financial year.
            </div>
          )}

          {/* Observation cards */}
          {observations.map(obs => (
            <div key={obs.id} className="card-tv overflow-hidden">
              <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'rgb(var(--c-dark-400) / 0.3)' }}>
                <span className={`tv-status-badge tv-severity ${obs.severity}`} style={{ borderRadius: '6px', padding: '3px 10px' }}>
                  {obs.severity.toUpperCase()}
                </span>
                <span className="text-sm font-semibold text-theme-heading flex-1">{obs.title}</span>
                <span className={`tv-status-badge ${obs.status}`}>{obsLabels[obs.status] || obs.status}</span>
                {obs.category && <span className="text-[10px] text-theme-faint border rounded px-2 py-0.5" style={{ borderColor: 'rgb(var(--c-dark-400) / 0.5)' }}>{obs.category}</span>}
              </div>
              <div className="px-5 py-4 space-y-3">
                {obs.description && (
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-theme-faint">Description</span>
                    <p className="text-xs text-theme-secondary mt-1">{obs.description}</p>
                  </div>
                )}
                {obs.recommendation && (
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-theme-faint">Recommendation</span>
                    <p className="text-xs text-theme-secondary mt-1">{obs.recommendation}</p>
                  </div>
                )}
                {obs.mgmt_response && (
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-theme-faint">Management Response</span>
                    <p className="text-xs text-theme-secondary mt-1">{obs.mgmt_response}</p>
                  </div>
                )}
                <div className="flex items-center gap-4 pt-2 border-t" style={{ borderColor: 'rgb(var(--c-dark-400) / 0.2)' }}>
                  {obs.assigned_to && <span className="text-[10px] text-theme-muted">Assigned: <strong className="text-theme-primary">{obs.assigned_to}</strong></span>}
                  {obs.due_date && <span className="text-[10px] text-theme-muted">Due: <strong className="text-theme-primary">{obs.due_date}</strong></span>}
                  <span className="text-[10px] text-theme-faint ml-auto">{new Date(obs.created_at).toLocaleDateString('en-IN')}</span>
                </div>
                {/* Status update */}
                <div className="flex gap-1">
                  {obsStatuses.map(s => (
                    <button key={s} onClick={() => updateObservation(obs.id, { status: s })}
                      className={`px-2.5 py-1 text-[10px] font-semibold rounded transition-colors ${
                        obs.status === s ? 'bg-indigo-600 text-white' : 'text-theme-faint hover:text-theme-primary hover:bg-[rgb(var(--c-dark-600))]'
                      }`}>
                      {obsLabels[s]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
