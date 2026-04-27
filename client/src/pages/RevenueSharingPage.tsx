import { useEffect, useState } from 'react';
import api from '../api/client';
import { formatINR } from '../utils/format';
import { canWriteForecast } from '../utils/roles';
import {
  PieChart as PieIcon, IndianRupee, Users, Building2, ChevronDown, ChevronRight,
  Plus, Trash2, Settings2, Eye,
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
          <PieIcon size={18} style={{ color: 'var(--mt-accent-text)' }} />
          <h1 className="mt-heading text-lg">Revenue Sharing</h1>
        </div>
        <div
          className="flex gap-1 rounded-lg p-0.5"
          style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
        >
          {(['dashboard', 'rules'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-3 py-1.5 text-xs font-medium rounded-md transition"
              style={{
                background: tab === t ? 'var(--mt-accent-soft)' : 'transparent',
                color: tab === t ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)',
              }}
            >
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
  if (!data || data.doctors.length === 0) return (
    <div className="text-center py-10 text-sm" style={{ color: 'var(--mt-text-muted)' }}>
      No revenue data found. Import actuals to see sharing breakdown.
    </div>
  );

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
      <div className="mt-card p-0 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: 'var(--mt-bg-muted)' }}>
              <th className="text-left px-3 py-2.5 text-[10px] font-medium uppercase w-[200px]" style={{ color: 'var(--mt-text-faint)' }}>Doctor</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Revenue</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Doctor Share</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Magna Share</th>
              <th className="text-right px-3 py-2.5 text-[10px] font-medium uppercase w-[80px]" style={{ color: 'var(--mt-text-faint)' }}>Doctor %</th>
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
            <tr
              className="font-semibold"
              style={{ background: 'var(--mt-bg-muted)', borderTop: '1px solid var(--mt-border)' }}
            >
              <td className="px-3 py-2.5" style={{ color: 'var(--mt-text-heading)' }}>Total</td>
              <td className="px-3 py-2.5 text-right mt-num" style={{ color: 'var(--mt-text-heading)' }}>{formatINR(grandTotals.revenue)}</td>
              <td className="px-3 py-2.5 text-right mt-num" style={{ color: 'var(--mt-warn-text)' }}>{formatINR(grandTotals.doctor_share)}</td>
              <td className="px-3 py-2.5 text-right mt-num" style={{ color: '#14b8a6' }}>{formatINR(grandTotals.magna_share)}</td>
              <td className="px-3 py-2.5 text-right mt-num" style={{ color: 'var(--mt-text-muted)' }}>{100 - grandTotals.magna_pct}%</td>
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
      <tr
        className="cursor-pointer transition-colors"
        style={{ borderTop: '1px solid var(--mt-border)' }}
        onClick={onToggle}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--mt-bg-muted)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      >
        <td className="px-3 py-2.5 font-medium flex items-center gap-1.5" style={{ color: 'var(--mt-text-heading)' }}>
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {doc.doctor_name}
          {!doc.has_any_rule && (
            <span className="mt-pill mt-pill--warn mt-pill-sm">No rules</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right mt-num" style={{ color: 'var(--mt-text-secondary)' }}>{formatINR(doc.totals.revenue)}</td>
        <td className="px-3 py-2.5 text-right mt-num" style={{ color: 'var(--mt-warn-text)' }}>{formatINR(doc.totals.doctor_share)}</td>
        <td className="px-3 py-2.5 text-right mt-num" style={{ color: '#14b8a6' }}>{formatINR(doc.totals.magna_share)}</td>
        <td className="px-3 py-2.5 text-right">
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
            style={{
              background: doc.totals.doctor_pct >= 70 ? 'color-mix(in srgb, #f59e0b 12%, transparent)' : 'color-mix(in srgb, #14b8a6 12%, transparent)',
              color: doc.totals.doctor_pct >= 70 ? 'var(--mt-warn-text)' : '#14b8a6',
            }}
          >
            {doc.totals.doctor_pct}%
          </span>
        </td>
      </tr>
      {isExpanded && doc.categories.map(cat => (
        <tr
          key={cat.category}
          style={{ background: 'var(--mt-bg-muted)' }}
        >
          <td className="pl-8 pr-3 py-1.5 text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
            {cat.category}
            {!cat.has_rule && <span className="ml-1 text-[9px]" style={{ color: 'var(--mt-danger-text)' }}>(no rule)</span>}
          </td>
          <td className="px-3 py-1.5 text-right mt-num" style={{ color: 'var(--mt-text-faint)' }}>{formatINR(cat.revenue)}</td>
          <td className="px-3 py-1.5 text-right mt-num" style={{ color: 'var(--mt-warn-text)', opacity: 0.7 }}>{formatINR(cat.doctor_share)}</td>
          <td className="px-3 py-1.5 text-right mt-num" style={{ color: '#14b8a6', opacity: 0.7 }}>{formatINR(cat.magna_share)}</td>
          <td className="px-3 py-1.5 text-right mt-num" style={{ color: 'var(--mt-text-faint)' }}>{cat.doctor_pct}/{cat.magna_pct}</td>
        </tr>
      ))}
    </>
  );
}

function SummaryCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string; color: string }) {
  const toneMap: Record<string, { fg: string; soft: string; border: string }> = {
    accent: { fg: '#10b981', soft: 'color-mix(in srgb, #10b981 12%, transparent)', border: 'color-mix(in srgb, #10b981 30%, transparent)' },
    amber:  { fg: '#f59e0b', soft: 'color-mix(in srgb, #f59e0b 12%, transparent)', border: 'color-mix(in srgb, #f59e0b 30%, transparent)' },
    teal:   { fg: '#14b8a6', soft: 'color-mix(in srgb, #14b8a6 12%, transparent)', border: 'color-mix(in srgb, #14b8a6 30%, transparent)' },
    blue:   { fg: '#3b82f6', soft: 'color-mix(in srgb, #3b82f6 12%, transparent)', border: 'color-mix(in srgb, #3b82f6 30%, transparent)' },
  };
  const tone = toneMap[color] || toneMap.accent;
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: tone.soft, border: `1px solid ${tone.border}` }}
    >
      <Icon size={14} style={{ color: tone.fg }} />
      <p className="text-base font-bold mt-1 mt-num" style={{ color: 'var(--mt-text-heading)' }}>{value}</p>
      <p className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>{label}</p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  RULES TAB
// ══════════════════════════════════════════════════════════════════════
function RulesTab() {
  // canEdit mirrors the server's requireRole('admin', 'operational_head') gate
  // (plus implicit super_admin override). When false we hide every editing
  // affordance — the Add form, the doctor/category dropdowns, and the trash
  // icons. Server still enforces 403 even if the UI is bypassed.
  const canEdit = canWriteForecast();
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
      {/* View-only banner for non-admin / non-operational_head roles. The
          backend mutations are gated independently — this is purely UX. */}
      {!canEdit && (
        <div
          className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
          style={{
            background: 'var(--mt-info-soft)',
            border: '1px solid var(--mt-info-border)',
            color: 'var(--mt-info-text)',
          }}
        >
          <Eye size={14} className="mt-0.5 shrink-0" />
          <span>
            <strong>View only.</strong> Contact your admin to edit revenue-sharing rules.
          </span>
        </div>
      )}

      {/* Service Categories */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Settings2 size={14} style={{ color: 'var(--mt-text-muted)' }} />
          <h2 className="mt-heading text-sm">Service Categories</h2>
        </div>
        <div className="mt-card p-0 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: 'var(--mt-bg-muted)' }}>
                <th className="text-left px-3 py-2 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Name</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Source</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Department</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Keyword</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Mode</th>
                <th className="text-right px-3 py-2 text-[10px] font-medium uppercase" style={{ color: 'var(--mt-text-faint)' }}>Priority</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c: any) => (
                <tr key={c.id} style={{ borderTop: '1px solid var(--mt-border)' }}>
                  <td className="px-3 py-1.5 font-medium" style={{ color: 'var(--mt-text-heading)' }}>{c.name}</td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--mt-text-faint)' }}>{c.source}</td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--mt-text-faint)' }}>{c.match_department || '—'}</td>
                  <td className="px-3 py-1.5 font-mono" style={{ color: 'var(--mt-text-faint)' }}>{c.match_keyword || '—'}</td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--mt-text-faint)' }}>{c.match_mode}</td>
                  <td className="px-3 py-1.5 text-right" style={{ color: 'var(--mt-text-secondary)' }}>{c.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sharing Rules */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Users size={14} style={{ color: 'var(--mt-text-muted)' }} />
          <h2 className="mt-heading text-sm">Doctor Sharing Rules</h2>
        </div>

        {/* Add rule form — admin / operational_head only */}
        {canEdit && (
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <select value={newRule.doctor_id} onChange={e => setNewRule(p => ({ ...p, doctor_id: e.target.value }))}
              className="mt-input text-xs w-48" style={{ padding: '6px 10px' }}>
              <option value="">Select doctor...</option>
              {doctors.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select value={newRule.category_id} onChange={e => setNewRule(p => ({ ...p, category_id: e.target.value }))}
              className="mt-input text-xs w-40" style={{ padding: '6px 10px' }}>
              <option value="">Category...</option>
              {categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="flex items-center gap-1">
              <input type="number" min="0" max="100" placeholder="Dr %" value={newRule.doctor_pct}
                onChange={e => setNewRule(p => ({ ...p, doctor_pct: e.target.value }))}
                className="mt-input text-xs w-20 text-center" style={{ padding: '6px 10px' }} />
              <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>/</span>
              <span className="text-xs w-12 text-center" style={{ color: 'var(--mt-text-muted)' }}>
                {newRule.doctor_pct ? `${100 - Number(newRule.doctor_pct)}%` : '—'}
              </span>
            </div>
            <button onClick={addRule} className="mt-btn-soft text-xs flex items-center gap-1">
              <Plus size={12} /> Add
            </button>
          </div>
        )}

        {/* Rules grouped by doctor */}
        <div className="space-y-2">
          {Object.entries(rulesByDoctor).map(([docName, docRules]) => (
            <div key={docName} className="mt-card p-3">
              <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--mt-text-heading)' }}>{docName}</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
                {docRules.map((r: any) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between rounded-md px-2.5 py-1.5"
                    style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
                  >
                    <div>
                      <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>{r.category_name}</span>
                      <div className="text-xs font-semibold">
                        <span className="mt-num" style={{ color: 'var(--mt-warn-text)' }}>{r.doctor_pct}%</span>
                        <span className="mx-0.5" style={{ color: 'var(--mt-text-faint)' }}>/</span>
                        <span className="mt-num" style={{ color: '#14b8a6' }}>{r.magna_pct}%</span>
                      </div>
                    </div>
                    {canEdit && (
                      <button
                        onClick={() => deleteRule(r.id)}
                        className="p-1 transition-colors"
                        style={{ color: 'var(--mt-text-faint)' }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-danger-text)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
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
      <div
        className="w-5 h-5 border-2 rounded-full animate-spin"
        style={{ borderColor: 'var(--mt-accent-soft)', borderTopColor: 'var(--mt-accent)' }}
      />
    </div>
  );
}
