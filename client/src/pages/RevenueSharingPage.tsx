import { useEffect, useState } from 'react';
import api from '../api/client';
import { formatINR, formatNumber } from '../utils/format';
import {
  PieChart as PieIcon, IndianRupee, Users, Building2, ChevronDown, ChevronRight,
  Plus, Trash2, Save, Settings2,
} from 'lucide-react';

// ── Types ──
interface CatBreakdown { category: string; revenue: number; doctor_pct: number; magna_pct: number; doctor_share: number; magna_share: number; has_rule: boolean; monthly: { month: string; revenue: number; doctor_share: number; magna_share: number }[]; }
interface DoctorRow { doctor_name: string; has_any_rule: boolean; categories: CatBreakdown[]; totals: { revenue: number; doctor_share: number; magna_share: number; doctor_pct: number }; }
interface DashData { fy: any; doctors: DoctorRow[]; allCategories: string[]; grandTotals: { revenue: number; doctor_share: number; magna_share: number; magna_pct: number }; }

export default function RevenueSharingPage() {
  const [tab, setTab] = useState<'dashboard' | 'rules'>('dashboard');

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PieIcon size={18} className="text-accent-400" />
          <h1 className="text-lg font-bold text-theme-primary">Revenue Sharing</h1>
        </div>
        <div className="flex gap-1 bg-dark-700 rounded-lg p-0.5">
          {(['dashboard', 'rules'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${tab === t ? 'bg-accent-500/20 text-accent-400' : 'text-theme-muted hover:text-theme-secondary'}`}>
              {t === 'dashboard' ? 'Dashboard' : 'Rules & Config'}
            </button>
          ))}
        </div>
      </div>
      {tab === 'dashboard' ? <DashboardTab /> : <RulesTab />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  DASHBOARD TAB
// ══════════════════════════════════════════════════════════════════════
function DashboardTab() {
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.get('/revenue-sharing/dashboard').then(r => { setData(r.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;
  if (!data || data.doctors.length === 0) return <div className="text-center text-theme-muted py-10 text-sm">No revenue data found. Import actuals to see sharing breakdown.</div>;

  const { doctors, grandTotals } = data;

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <SummaryCard icon={IndianRupee} label="Total Revenue" value={formatINR(grandTotals.revenue)} color="accent" />
        <SummaryCard icon={Users} label="Doctor Payouts" value={formatINR(grandTotals.doctor_share)} color="amber" />
        <SummaryCard icon={Building2} label="Magna Share" value={formatINR(grandTotals.magna_share)} color="teal" />
        <SummaryCard icon={PieIcon} label="Magna %" value={`${grandTotals.magna_pct}%`} color="blue" />
      </div>

      {/* Doctor Breakdown Table */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-dark-700/50">
              <th className="text-left px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase w-[200px]">Doctor</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase">Revenue</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase">Doctor Share</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase">Magna Share</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase w-[80px]">Doctor %</th>
            </tr>
          </thead>
          <tbody>
            {doctors.map(doc => {
              const isExpanded = expanded === doc.doctor_name;
              return (
                <DoctorTableRow key={doc.doctor_name} doc={doc} isExpanded={isExpanded}
                  onToggle={() => setExpanded(isExpanded ? null : doc.doctor_name)} />
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-dark-700/30 font-semibold border-t border-dark-400/30">
              <td className="px-3 py-2.5 text-theme-primary">Total</td>
              <td className="px-3 py-2.5 text-right text-theme-primary">{formatINR(grandTotals.revenue)}</td>
              <td className="px-3 py-2.5 text-right text-amber-400">{formatINR(grandTotals.doctor_share)}</td>
              <td className="px-3 py-2.5 text-right text-teal-400">{formatINR(grandTotals.magna_share)}</td>
              <td className="px-3 py-2.5 text-right text-theme-muted">{100 - grandTotals.magna_pct}%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function DoctorTableRow({ doc, isExpanded, onToggle }: { doc: DoctorRow; isExpanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="border-t border-dark-600/50 hover:bg-dark-600/20 cursor-pointer" onClick={onToggle}>
        <td className="px-3 py-2.5 text-theme-primary font-medium flex items-center gap-1.5">
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {doc.doctor_name}
          {!doc.has_any_rule && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">No rules</span>}
        </td>
        <td className="px-3 py-2.5 text-right text-theme-secondary">{formatINR(doc.totals.revenue)}</td>
        <td className="px-3 py-2.5 text-right text-amber-400">{formatINR(doc.totals.doctor_share)}</td>
        <td className="px-3 py-2.5 text-right text-teal-400">{formatINR(doc.totals.magna_share)}</td>
        <td className="px-3 py-2.5 text-right">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${doc.totals.doctor_pct >= 70 ? 'bg-amber-500/10 text-amber-400' : 'bg-teal-500/10 text-teal-400'}`}>
            {doc.totals.doctor_pct}%
          </span>
        </td>
      </tr>
      {isExpanded && doc.categories.map(cat => (
        <tr key={cat.category} className="bg-dark-700/20">
          <td className="pl-8 pr-3 py-1.5 text-theme-faint text-[11px]">
            {cat.category}
            {!cat.has_rule && <span className="ml-1 text-[9px] text-red-400">(no rule)</span>}
          </td>
          <td className="px-3 py-1.5 text-right text-theme-faint">{formatINR(cat.revenue)}</td>
          <td className="px-3 py-1.5 text-right text-amber-400/70">{formatINR(cat.doctor_share)}</td>
          <td className="px-3 py-1.5 text-right text-teal-400/70">{formatINR(cat.magna_share)}</td>
          <td className="px-3 py-1.5 text-right text-theme-faint">{cat.doctor_pct}/{cat.magna_pct}</td>
        </tr>
      ))}
    </>
  );
}

function SummaryCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = {
    accent: 'bg-accent-500/10 text-accent-400 border-accent-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    teal: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  };
  const c = colorMap[color] || colorMap.accent;
  return (
    <div className={`rounded-lg border p-3 ${c}`}>
      <Icon size={14} className={c.split(' ')[1]} />
      <p className="text-base font-bold text-theme-heading mt-1">{value}</p>
      <p className="text-[10px] text-theme-faint">{label}</p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  RULES TAB
// ══════════════════════════════════════════════════════════════════════
function RulesTab() {
  const [categories, setCategories] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [doctors, setDoctors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRule, setNewRule] = useState({ doctor_id: '', category_id: '', doctor_pct: '' });

  const reload = () => {
    Promise.all([
      api.get('/revenue-sharing/categories'),
      api.get('/revenue-sharing/rules'),
      api.get('/revenue-sharing/doctors'),
    ]).then(([c, r, d]) => {
      setCategories(c.data);
      setRules(r.data);
      setDoctors(d.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { reload(); }, []);

  const addRule = () => {
    if (!newRule.doctor_id || !newRule.category_id || !newRule.doctor_pct) return;
    api.post('/revenue-sharing/rules', {
      doctor_id: Number(newRule.doctor_id),
      category_id: Number(newRule.category_id),
      doctor_pct: Number(newRule.doctor_pct),
    }).then(() => { setNewRule({ doctor_id: '', category_id: '', doctor_pct: '' }); reload(); });
  };

  const deleteRule = (id: number) => {
    api.delete(`/revenue-sharing/rules/${id}`).then(() => reload());
  };

  if (loading) return <Spinner />;

  // Group rules by doctor
  const rulesByDoctor: Record<string, any[]> = {};
  for (const r of rules) {
    if (!rulesByDoctor[r.doctor_name]) rulesByDoctor[r.doctor_name] = [];
    rulesByDoctor[r.doctor_name].push(r);
  }

  return (
    <div className="space-y-5">
      {/* Service Categories */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Settings2 size={14} className="text-theme-muted" />
          <h2 className="text-sm font-semibold text-theme-primary">Service Categories</h2>
        </div>
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-dark-700/50">
                <th className="text-left px-3 py-2 text-[10px] font-medium text-theme-faint uppercase">Name</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium text-theme-faint uppercase">Source</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium text-theme-faint uppercase">Department</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium text-theme-faint uppercase">Keyword</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium text-theme-faint uppercase">Mode</th>
                <th className="text-right px-3 py-2 text-[10px] font-medium text-theme-faint uppercase">Priority</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c: any) => (
                <tr key={c.id} className="border-t border-dark-600/50">
                  <td className="px-3 py-1.5 text-theme-primary font-medium">{c.name}</td>
                  <td className="px-3 py-1.5 text-theme-faint">{c.source}</td>
                  <td className="px-3 py-1.5 text-theme-faint">{c.match_department || '—'}</td>
                  <td className="px-3 py-1.5 text-theme-faint font-mono">{c.match_keyword || '—'}</td>
                  <td className="px-3 py-1.5 text-theme-faint">{c.match_mode}</td>
                  <td className="px-3 py-1.5 text-right text-theme-secondary">{c.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sharing Rules */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Users size={14} className="text-theme-muted" />
          <h2 className="text-sm font-semibold text-theme-primary">Doctor Sharing Rules</h2>
        </div>

        {/* Add rule form */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <select value={newRule.doctor_id} onChange={e => setNewRule(p => ({ ...p, doctor_id: e.target.value }))}
            className="input text-xs py-1.5 w-48">
            <option value="">Select doctor...</option>
            {doctors.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={newRule.category_id} onChange={e => setNewRule(p => ({ ...p, category_id: e.target.value }))}
            className="input text-xs py-1.5 w-40">
            <option value="">Category...</option>
            {categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className="flex items-center gap-1">
            <input type="number" min="0" max="100" placeholder="Dr %" value={newRule.doctor_pct}
              onChange={e => setNewRule(p => ({ ...p, doctor_pct: e.target.value }))}
              className="input text-xs py-1.5 w-20 text-center" />
            <span className="text-[10px] text-theme-faint">/</span>
            <span className="text-xs text-theme-muted w-12 text-center">{newRule.doctor_pct ? `${100 - Number(newRule.doctor_pct)}%` : '—'}</span>
          </div>
          <button onClick={addRule} className="btn btn-sm bg-accent-500/20 text-accent-400 hover:bg-accent-500/30 px-3 py-1.5 rounded-md text-xs flex items-center gap-1">
            <Plus size={12} /> Add
          </button>
        </div>

        {/* Rules grouped by doctor */}
        <div className="space-y-2">
          {Object.entries(rulesByDoctor).map(([docName, docRules]) => (
            <div key={docName} className="card p-3">
              <h3 className="text-xs font-semibold text-theme-primary mb-2">{docName}</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
                {docRules.map((r: any) => (
                  <div key={r.id} className="flex items-center justify-between bg-dark-600/50 rounded-md px-2.5 py-1.5">
                    <div>
                      <span className="text-[10px] text-theme-faint">{r.category_name}</span>
                      <div className="text-xs font-semibold text-theme-primary">
                        <span className="text-amber-400">{r.doctor_pct}%</span>
                        <span className="text-theme-faint mx-0.5">/</span>
                        <span className="text-teal-400">{r.magna_pct}%</span>
                      </div>
                    </div>
                    <button onClick={() => deleteRule(r.id)} className="text-theme-faint hover:text-red-400 p-1"><Trash2 size={11} /></button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-5 h-5 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin" />
    </div>
  );
}
