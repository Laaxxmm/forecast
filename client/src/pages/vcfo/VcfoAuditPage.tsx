import { useState, useEffect, useCallback } from 'react';
import { Shield, Check, Clock, AlertTriangle, Plus, ChevronDown, ChevronRight, Sprout, X, MessageSquare } from 'lucide-react';
import api from '../../api/client';

interface Milestone {
  id: number;
  name: string;
  sort_order: number;
}

interface MilestoneStatus {
  status: string;
  due_date: string | null;
  completion_date: string | null;
  assigned_to: string;
  notes: string;
}

interface Observation {
  id: number;
  company_id: number;
  fy_year: number;
  title: string;
  description: string;
  severity: string;
  category: string;
  recommendation: string;
  mgmt_response: string;
  status: string;
  assigned_to: string;
  due_date: string;
  resolution_date: string;
  created_at: string;
}

const milestoneStatuses = [
  { value: 'pending', label: 'Pending', color: 'bg-gray-500/10 text-gray-400 border-gray-500/30' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  { value: 'completed', label: 'Completed', color: 'bg-green-500/10 text-green-400 border-green-500/30' },
  { value: 'blocked', label: 'Blocked', color: 'bg-red-500/10 text-red-400 border-red-500/30' },
];

const severityColors: Record<string, string> = {
  high: 'bg-red-500/15 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  low: 'bg-green-500/15 text-green-400 border-green-500/30',
};

const obsStatusColors: Record<string, string> = {
  open: 'bg-red-500/10 text-red-400',
  in_progress: 'bg-blue-500/10 text-blue-400',
  resolved: 'bg-green-500/10 text-green-400',
  closed: 'bg-gray-500/10 text-gray-400',
};

export default function VcfoAuditPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [fyYear, setFyYear] = useState<number>(new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1);
  const [view, setView] = useState<'milestones' | 'observations'>('milestones');

  // Milestones state
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, MilestoneStatus>>({});
  const [seeding, setSeeding] = useState(false);

  // Observations state
  const [observations, setObservations] = useState<Observation[]>([]);
  const [showAddObs, setShowAddObs] = useState(false);
  const [obsForm, setObsForm] = useState({ title: '', description: '', severity: 'medium', category: '', recommendation: '', assigned_to: '', due_date: '' });
  const [expandedObs, setExpandedObs] = useState<Set<number>>(new Set());

  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => {
    api.get('/vcfo/companies').then(r => {
      setCompanies(r.data);
      if (r.data.length > 0) setCompanyId(String(r.data[0].id));
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
    api.post('/vcfo/audit/milestones/seed')
      .then(() => loadData())
      .catch(() => {})
      .finally(() => setSeeding(false));
  };

  const addObservation = () => {
    if (!obsForm.title.trim()) return;
    api.post('/vcfo/audit/observations', {
      ...obsForm, company_id: parseInt(companyId), fy_year: fyYear,
    }).then(() => {
      setObsForm({ title: '', description: '', severity: 'medium', category: '', recommendation: '', assigned_to: '', due_date: '' });
      setShowAddObs(false);
      loadData();
    }).catch(() => {});
  };

  const updateObservation = (id: number, updates: Partial<Observation>) => {
    api.put(`/vcfo/audit/observations/${id}`, updates).then(() => loadData()).catch(() => {});
  };

  const toggleObs = (id: number) => {
    setExpandedObs(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const completedMilestones = milestones.filter(m => {
    const key = `${m.id}-${companyId}-${fyYear}`;
    return statusMap[key]?.status === 'completed';
  }).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-theme-heading flex items-center gap-2">
            <Shield size={22} className="text-accent-400" />
            Audit Tracker
          </h1>
          <p className="text-sm text-theme-muted mt-0.5">Milestones & observations tracking for audit engagements</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setView('milestones')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${view === 'milestones' ? 'bg-accent-500 text-white' : 'bg-dark-600 text-theme-muted'}`}>
            Milestones
          </button>
          <button onClick={() => setView('observations')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${view === 'observations' ? 'bg-accent-500 text-white' : 'bg-dark-600 text-theme-muted'}`}>
            Observations
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-theme-muted mb-1">Company</label>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)}
              className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30 min-w-[180px]">
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-theme-muted mb-1">Financial Year</label>
            <select value={fyYear} onChange={e => setFyYear(parseInt(e.target.value))}
              className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30">
              {Array.from({ length: 5 }, (_, i) => {
                const y = new Date().getFullYear() - i;
                return <option key={y} value={y}>FY {y}-{(y + 1).toString().slice(2)}</option>;
              })}
            </select>
          </div>
        </div>
      </div>

      {/* Summary */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
            <div className="text-xs text-theme-muted mb-1">Milestone Progress</div>
            <div className="text-lg font-bold text-theme-heading">{completedMilestones}/{milestones.length}</div>
            {milestones.length > 0 && (
              <div className="mt-2 h-1.5 bg-dark-500 rounded-full overflow-hidden">
                <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${(completedMilestones / milestones.length) * 100}%` }} />
              </div>
            )}
          </div>
          <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
            <div className="text-xs text-theme-muted mb-1">Open Observations</div>
            <div className="text-lg font-bold text-red-400">{summary.observations?.open || 0}</div>
          </div>
          <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
            <div className="text-xs text-theme-muted mb-1">High Severity</div>
            <div className="text-lg font-bold text-amber-400">{summary.observations?.high || 0}</div>
          </div>
          <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
            <div className="text-xs text-theme-muted mb-1">Resolved</div>
            <div className="text-lg font-bold text-green-400">{summary.observations?.resolved || 0}</div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-400"></div>
        </div>
      )}

      {/* Milestones View */}
      {!loading && view === 'milestones' && (
        <div className="space-y-3">
          {milestones.length === 0 && (
            <div className="text-center py-12">
              <Shield size={32} className="mx-auto mb-3 text-theme-faint" />
              <p className="text-theme-muted text-sm mb-4">No audit milestones configured</p>
              <button onClick={seedMilestones} disabled={seeding}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-accent-500/20 text-accent-400 rounded-lg hover:bg-accent-500/30 transition-colors disabled:opacity-50">
                <Sprout size={16} /> {seeding ? 'Seeding...' : 'Seed Default Milestones'}
              </button>
            </div>
          )}

          {milestones.map((ms, idx) => {
            const key = `${ms.id}-${companyId}-${fyYear}`;
            const status = statusMap[key]?.status || 'pending';
            const statusObj = milestoneStatuses.find(s => s.value === status) || milestoneStatuses[0];

            return (
              <div key={ms.id} className="bg-dark-700 rounded-xl border border-dark-400/30 p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${status === 'completed' ? 'bg-green-500/15 text-green-400' : 'bg-dark-600 text-theme-muted'}`}>
                    {status === 'completed' ? <Check size={16} /> : idx + 1}
                  </div>
                  <span className={`text-sm font-medium ${status === 'completed' ? 'text-theme-faint line-through' : 'text-theme-primary'}`}>
                    {ms.name}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {milestoneStatuses.map(s => (
                    <button key={s.value}
                      onClick={() => updateMilestoneStatus(ms.id, s.value)}
                      className={`px-2.5 py-1 text-[10px] font-medium rounded-lg border transition-colors ${status === s.value ? s.color : 'border-transparent text-theme-faint hover:text-theme-muted'}`}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Observations View */}
      {!loading && view === 'observations' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => setShowAddObs(!showAddObs)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-accent-500/20 text-accent-400 rounded-lg hover:bg-accent-500/30 transition-colors">
              {showAddObs ? <X size={14} /> : <Plus size={14} />}
              {showAddObs ? 'Cancel' : 'Add Observation'}
            </button>
          </div>

          {/* Add Observation Form */}
          {showAddObs && (
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-theme-muted mb-1">Title *</label>
                  <input value={obsForm.title} onChange={e => setObsForm(p => ({ ...p, title: e.target.value }))}
                    className="w-full bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30" />
                </div>
                <div>
                  <label className="block text-xs text-theme-muted mb-1">Category</label>
                  <input value={obsForm.category} onChange={e => setObsForm(p => ({ ...p, category: e.target.value }))}
                    placeholder="e.g., Taxation, Compliance"
                    className="w-full bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs text-theme-muted mb-1">Description</label>
                  <textarea value={obsForm.description} onChange={e => setObsForm(p => ({ ...p, description: e.target.value }))}
                    rows={3} className="w-full bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30" />
                </div>
                <div>
                  <label className="block text-xs text-theme-muted mb-1">Severity</label>
                  <select value={obsForm.severity} onChange={e => setObsForm(p => ({ ...p, severity: e.target.value }))}
                    className="w-full bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30">
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-theme-muted mb-1">Assigned To</label>
                  <input value={obsForm.assigned_to} onChange={e => setObsForm(p => ({ ...p, assigned_to: e.target.value }))}
                    className="w-full bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs text-theme-muted mb-1">Recommendation</label>
                  <textarea value={obsForm.recommendation} onChange={e => setObsForm(p => ({ ...p, recommendation: e.target.value }))}
                    rows={2} className="w-full bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30" />
                </div>
              </div>
              <button onClick={addObservation}
                className="px-4 py-2 text-sm font-medium bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors">
                Add Observation
              </button>
            </div>
          )}

          {/* Observations List */}
          {observations.length === 0 && !showAddObs && (
            <div className="text-center py-12 text-theme-muted text-sm">
              <MessageSquare size={32} className="mx-auto mb-3 text-theme-faint" />
              No audit observations for this company and financial year.
            </div>
          )}

          {observations.map(obs => {
            const isExpanded = expandedObs.has(obs.id);
            return (
              <div key={obs.id} className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-hidden">
                <button onClick={() => toggleObs(obs.id)}
                  className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-dark-600/50 transition-colors text-left">
                  {isExpanded ? <ChevronDown size={16} className="text-theme-faint flex-shrink-0" /> : <ChevronRight size={16} className="text-theme-faint flex-shrink-0" />}
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${severityColors[obs.severity] || severityColors.medium}`}>
                    {obs.severity}
                  </span>
                  <span className="text-sm font-medium text-theme-primary flex-1 truncate">{obs.title}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${obsStatusColors[obs.status] || obsStatusColors.open}`}>
                    {obs.status.replace('_', ' ')}
                  </span>
                  {obs.category && <span className="text-xs text-theme-faint">{obs.category}</span>}
                </button>

                {isExpanded && (
                  <div className="border-t border-dark-400/30 px-5 py-4 space-y-3">
                    {obs.description && (
                      <div>
                        <div className="text-[10px] text-theme-faint uppercase mb-1">Description</div>
                        <p className="text-xs text-theme-secondary">{obs.description}</p>
                      </div>
                    )}
                    {obs.recommendation && (
                      <div>
                        <div className="text-[10px] text-theme-faint uppercase mb-1">Recommendation</div>
                        <p className="text-xs text-theme-secondary">{obs.recommendation}</p>
                      </div>
                    )}
                    {obs.mgmt_response && (
                      <div>
                        <div className="text-[10px] text-theme-faint uppercase mb-1">Management Response</div>
                        <p className="text-xs text-theme-secondary">{obs.mgmt_response}</p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-3 pt-2 border-t border-dark-400/20">
                      {obs.assigned_to && (
                        <span className="text-xs text-theme-muted">Assigned: <span className="text-theme-primary">{obs.assigned_to}</span></span>
                      )}
                      {obs.due_date && (
                        <span className="text-xs text-theme-muted">Due: <span className="text-theme-primary">{obs.due_date}</span></span>
                      )}
                      <span className="text-xs text-theme-faint ml-auto">{new Date(obs.created_at).toLocaleDateString('en-IN')}</span>
                    </div>

                    {/* Status update buttons */}
                    <div className="flex gap-2 pt-2">
                      {['open', 'in_progress', 'resolved', 'closed'].map(s => (
                        <button key={s}
                          onClick={() => updateObservation(obs.id, { status: s as any })}
                          className={`px-2.5 py-1 text-[10px] font-medium rounded-lg transition-colors ${obs.status === s ? obsStatusColors[s] + ' ring-1 ring-current' : 'bg-dark-600 text-theme-faint hover:text-theme-muted'}`}>
                          {s.replace('_', ' ')}
                        </button>
                      ))}
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
