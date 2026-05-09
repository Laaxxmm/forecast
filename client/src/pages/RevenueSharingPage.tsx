import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { formatINR } from '../utils/format';
import { canEditRevenueSharing } from '../utils/roles';
import {
  PieChart as PieIcon, IndianRupee, Users, Building2, ChevronDown, ChevronRight,
  Settings2, Eye, Check, Loader2, Link2, Unlink, Plus, AlertCircle,
} from 'lucide-react';

// ── Types ──
interface MonthlyEntry { month: string; revenue: number; doctor_share: number; magna_share: number }
interface CatBreakdown { category: string; revenue: number; doctor_pct: number; magna_pct: number; doctor_share: number; magna_share: number; has_rule: boolean; monthly: MonthlyEntry[]; }
interface DoctorRow { doctor_id: number | null; doctor_name: string; is_unmapped: boolean; raw_aliases: string[]; has_any_rule: boolean; categories: CatBreakdown[]; totals: { revenue: number; doctor_share: number; magna_share: number; doctor_pct: number }; }
interface DashData { fy: any; doctors: DoctorRow[]; allCategories: string[]; grandTotals: { revenue: number; doctor_share: number; magna_share: number; magna_pct: number }; }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
  const [selectedMonth, setSelectedMonth] = useState<string>('all');

  useEffect(() => {
    api.get('/revenue-sharing/dashboard').then(r => { setData(r.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  // Walk the FY range month-by-month so the dropdown lists every month in
  // scope, including ones where no doctor billed anything.
  const monthOptions = useMemo(() => {
    if (!data?.fy?.start_date || !data?.fy?.end_date) return [] as { value: string; label: string }[];
    const [sy, sm] = data.fy.start_date.slice(0, 7).split('-').map(Number);
    const [ey, em] = data.fy.end_date.slice(0, 7).split('-').map(Number);
    const opts: { value: string; label: string }[] = [];
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      const value = `${y}-${String(m).padStart(2, '0')}`;
      opts.push({ value, label: `${MONTH_NAMES[m - 1]} '${String(y).slice(-2)}` });
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return opts;
  }, [data?.fy?.start_date, data?.fy?.end_date]);

  // For a single-month view, slice the per-doctor monthly buckets and
  // re-roll the totals so the cards/table/footer reflect just that month.
  // Doctors and categories with zero revenue in the picked month drop out.
  const view = useMemo(() => {
    if (!data) return null;
    if (selectedMonth === 'all') return data;
    let gRev = 0, gDoc = 0, gMag = 0;
    const doctors: DoctorRow[] = data.doctors.map(doc => {
      let dRev = 0, dDoc = 0, dMag = 0;
      const categories: CatBreakdown[] = doc.categories.map(cat => {
        const m = cat.monthly.find(x => x.month === selectedMonth);
        const revenue = m?.revenue ?? 0;
        const doctor_share = m?.doctor_share ?? 0;
        const magna_share = m?.magna_share ?? 0;
        dRev += revenue; dDoc += doctor_share; dMag += magna_share;
        return { ...cat, revenue, doctor_share, magna_share, monthly: m ? [m] : [] };
      }).filter(c => c.revenue > 0);
      gRev += dRev; gDoc += dDoc; gMag += dMag;
      return {
        ...doc,
        categories: categories.sort((a, b) => b.revenue - a.revenue),
        totals: {
          revenue: dRev,
          doctor_share: dDoc,
          magna_share: dMag,
          doctor_pct: dRev > 0 ? Math.round((dDoc / dRev) * 100) : 0,
        },
      };
    }).filter(d => d.totals.revenue > 0);
    return {
      ...data,
      doctors: doctors.sort((a, b) => b.totals.revenue - a.totals.revenue),
      grandTotals: {
        revenue: gRev,
        doctor_share: gDoc,
        magna_share: gMag,
        magna_pct: gRev > 0 ? Math.round((gMag / gRev) * 100) : 0,
      },
    };
  }, [data, selectedMonth]);

  if (loading) return <Spinner />;
  if (!data || data.doctors.length === 0) return (
    <div className="text-center py-10 text-sm" style={{ color: 'var(--mt-text-muted)' }}>
      No revenue data found. Import actuals to see sharing breakdown.
    </div>
  );

  const { doctors, grandTotals } = view!;
  const monthLabel = selectedMonth === 'all'
    ? 'All months'
    : monthOptions.find(o => o.value === selectedMonth)?.label || selectedMonth;

  return (
    <div className="space-y-4">
      {/* Filter row */}
      <div className="flex items-center justify-end gap-2">
        <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>Period</span>
        <select
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="text-xs rounded-lg px-2.5 py-1.5 cursor-pointer"
          style={{
            background: 'var(--mt-bg-raised)',
            color: 'var(--mt-text-heading)',
            border: '1px solid var(--mt-border)',
          }}
          title="Filter revenue sharing to a specific month"
        >
          <option value="all">All months</option>
          {monthOptions.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <SummaryCard icon={IndianRupee} label="Total Revenue" value={formatINR(grandTotals.revenue)} color="accent" />
        <SummaryCard icon={Users} label="Doctor Payouts" value={formatINR(grandTotals.doctor_share)} color="amber" />
        <SummaryCard icon={Building2} label="Magna Share" value={formatINR(grandTotals.magna_share)} color="teal" />
        <SummaryCard icon={PieIcon} label="Magna %" value={`${grandTotals.magna_pct}%`} color="blue" />
      </div>

      {/* Doctor Breakdown Table */}
      {doctors.length === 0 ? (
        <div className="mt-card p-6 text-center text-xs" style={{ color: 'var(--mt-text-muted)' }}>
          No revenue recorded for {monthLabel}.
        </div>
      ) : (
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
                // Mirror the server's bucket key so a canonical doctor and an
                // unmapped raw name with the same display string can't share
                // an expand-state slot.
                const rowKey = doc.doctor_id != null ? `id:${doc.doctor_id}` : `raw:${doc.doctor_name}`;
                const isExpanded = expanded === rowKey;
                return (
                  <DoctorTableRow key={rowKey} doc={doc} isExpanded={isExpanded}
                    onToggle={() => setExpanded(isExpanded ? null : rowKey)} />
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
      )}
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
          {doc.is_unmapped && (
            <span className="mt-pill mt-pill--warn mt-pill-sm" title="This raw name isn't linked to a canonical doctor — link it from Rules & Config">
              Unmapped
            </span>
          )}
          {!doc.is_unmapped && !doc.has_any_rule && (
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
  // canEdit mirrors the server's requireRole('admin') gate (plus implicit
  // super_admin override). Only admin / CFO can edit revenue-sharing config —
  // operational_head, accountant, and regular users get a read-only view.
  // Server still enforces 403 even if the UI is bypassed.
  const canEdit = canEditRevenueSharing();
  const [categories, setCategories] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [doctors, setDoctors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>('');
  // Slider values mirror the server's stored doctor_pct per category. Edits
  // update this immediately for visual feedback; saves are committed on
  // mouse/touch/key release.
  const [localPcts, setLocalPcts] = useState<Record<number, number>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);

  const reloadDoctors = async () => {
    const r = await api.get('/revenue-sharing/doctors');
    setDoctors(r.data);
  };

  useEffect(() => {
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
  }, []);

  // Reset slider values whenever the picked doctor changes (or the rules list
  // refreshes after a save). Categories without a saved rule default to 0 %.
  useEffect(() => {
    if (!selectedDoctorId) { setLocalPcts({}); return; }
    const doctorId = Number(selectedDoctorId);
    const pcts: Record<number, number> = {};
    for (const r of rules) {
      if (r.doctor_id === doctorId) pcts[r.category_id] = r.doctor_pct;
    }
    setLocalPcts(pcts);
  }, [selectedDoctorId, rules]);

  const saveRule = async (categoryId: number, doctorPct: number) => {
    if (!selectedDoctorId || !canEdit) return;
    const doctorId = Number(selectedDoctorId);
    const existing = rules.find((r: any) => r.doctor_id === doctorId && r.category_id === categoryId);
    // Skip the round-trip when the value didn't actually change — a plain
    // focus + blur or arrow-key tap shouldn't hit the API.
    if (existing && existing.doctor_pct === doctorPct) return;
    setSavingId(categoryId);
    try {
      await api.post('/revenue-sharing/rules', {
        doctor_id: doctorId,
        category_id: categoryId,
        doctor_pct: doctorPct,
      });
      const r = await api.get('/revenue-sharing/rules');
      setRules(r.data);
      setSavedId(categoryId);
      setTimeout(() => setSavedId(s => s === categoryId ? null : s), 1500);
    } catch {
      // Leave localPcts as-is so the user can retry by nudging the slider;
      // the next successful reload will overwrite if needed.
    } finally {
      setSavingId(curr => curr === categoryId ? null : curr);
    }
  };

  if (loading) return <Spinner />;

  const selectedDoctorName = doctors.find((d: any) => String(d.id) === selectedDoctorId)?.name;

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

      {/* Doctor Name Mappings — link raw billed_doctor variants to canonical doctors */}
      <NameMappingsSection
        doctors={doctors}
        canEdit={canEdit}
        onDoctorsChanged={reloadDoctors}
      />

      {/* Doctor Sharing Rules — pick a doctor, then drag a slider per category */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Users size={14} style={{ color: 'var(--mt-text-muted)' }} />
          <h2 className="mt-heading text-sm">Doctor Sharing Rules</h2>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>Doctor</span>
          <select
            value={selectedDoctorId}
            onChange={e => setSelectedDoctorId(e.target.value)}
            className="mt-input text-xs w-64"
            style={{ padding: '6px 10px' }}
          >
            <option value="">Select a doctor…</option>
            {doctors.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {selectedDoctorName && canEdit && (
            <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
              · adjust each category to set the doctor / Magna split
            </span>
          )}
        </div>

        {!selectedDoctorId ? (
          <div className="mt-card p-6 text-center text-xs" style={{ color: 'var(--mt-text-muted)' }}>
            Select a doctor to configure their revenue split per service category.
          </div>
        ) : categories.length === 0 ? (
          <div className="mt-card p-6 text-center text-xs" style={{ color: 'var(--mt-text-muted)' }}>
            No service categories defined.
          </div>
        ) : (
          <div className="mt-card p-0 overflow-hidden">
            {categories.map((cat: any, idx: number) => {
              const pct = localPcts[cat.id] ?? 0;
              const magnaPct = 100 - pct;
              const isSaving = savingId === cat.id;
              const justSaved = savedId === cat.id;
              return (
                <div
                  key={cat.id}
                  className="px-4 py-3"
                  style={{ borderTop: idx > 0 ? '1px solid var(--mt-border)' : 'none' }}
                >
                  <div className="flex items-center gap-3 flex-wrap md:flex-nowrap">
                    <span
                      className="text-xs font-medium shrink-0"
                      style={{ color: 'var(--mt-text-heading)', minWidth: 140 }}
                    >
                      {cat.name}
                    </span>
                    <span
                      className="text-[11px] font-semibold mt-num shrink-0 text-right"
                      style={{ color: 'var(--mt-warn-text)', width: 64 }}
                    >
                      Dr {pct}%
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={pct}
                      disabled={!canEdit}
                      onChange={e => setLocalPcts(prev => ({ ...prev, [cat.id]: Number(e.target.value) }))}
                      onMouseUp={e => saveRule(cat.id, Number((e.currentTarget as HTMLInputElement).value))}
                      onTouchEnd={e => saveRule(cat.id, Number((e.currentTarget as HTMLInputElement).value))}
                      onKeyUp={e => saveRule(cat.id, Number((e.currentTarget as HTMLInputElement).value))}
                      className="flex-1 cursor-pointer"
                      style={{
                        accentColor: 'var(--mt-accent)',
                        minWidth: 160,
                        opacity: canEdit ? 1 : 0.6,
                      }}
                      title={`${pct}% to doctor, ${magnaPct}% to Magna`}
                    />
                    <span
                      className="text-[11px] font-semibold mt-num shrink-0"
                      style={{ color: '#14b8a6', width: 88 }}
                    >
                      Magna {magnaPct}%
                    </span>
                    <span className="text-[10px] shrink-0 flex items-center justify-end gap-1" style={{ width: 68 }}>
                      {isSaving ? (
                        <>
                          <Loader2 size={11} className="animate-spin" style={{ color: 'var(--mt-text-faint)' }} />
                          <span style={{ color: 'var(--mt-text-faint)' }}>Saving</span>
                        </>
                      ) : justSaved ? (
                        <>
                          <Check size={11} style={{ color: 'var(--mt-accent-text)' }} />
                          <span style={{ color: 'var(--mt-accent-text)' }}>Saved</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
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

// ══════════════════════════════════════════════════════════════════════
//  NAME MAPPINGS SECTION
// ══════════════════════════════════════════════════════════════════════
// Two surfaces stacked vertically:
//  1. Unmapped raw names — billing strings without an alias yet, sorted by
//     revenue desc so the highest-impact merges land at the top.
//  2. Existing mappings (collapsible) — alias → canonical doctor, with a
//     dropdown to re-target and an unlink button to remove.
// Both share a "Create new doctor" inline affordance per row so admins can
// spin up a clean canonical name without leaving the page.
interface AliasRow { id: number; alias: string; doctor_id: number; doctor_name: string }
interface UnmappedRow { raw_name: string; revenue: number; source: string }

function NameMappingsSection({
  doctors, canEdit, onDoctorsChanged,
}: {
  doctors: any[];
  canEdit: boolean;
  onDoctorsChanged: () => Promise<void> | void;
}) {
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showMapped, setShowMapped] = useState(false);
  // When a row is in "create new doctor" mode, this holds the alias being
  // mapped + the in-flight name. Only one row can be in this mode at a time.
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newDoctorName, setNewDoctorName] = useState('');

  const reload = async () => {
    setLoading(true);
    try {
      const r = await api.get('/revenue-sharing/aliases');
      setAliases(r.data.aliases || []);
      setUnmapped(r.data.unmapped || []);
    } catch {
      setAliases([]);
      setUnmapped([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const upsertAlias = async (alias: string, doctorId: number) => {
    setBusyKey(alias);
    try {
      await api.post('/revenue-sharing/aliases', { alias, doctor_id: doctorId });
      await reload();
    } finally {
      setBusyKey(null);
    }
  };

  const deleteAlias = async (id: number) => {
    setBusyKey(`unlink:${id}`);
    try {
      await api.delete(`/revenue-sharing/aliases/${id}`);
      await reload();
    } finally {
      setBusyKey(null);
    }
  };

  const createDoctorAndLink = async (alias: string) => {
    const name = newDoctorName.trim();
    if (!name) return;
    setBusyKey(alias);
    try {
      const r = await api.post('/revenue-sharing/doctors', { name });
      if (r.data?.id) {
        await api.post('/revenue-sharing/aliases', { alias, doctor_id: r.data.id });
      }
      await onDoctorsChanged();
      await reload();
      setCreatingFor(null);
      setNewDoctorName('');
    } finally {
      setBusyKey(null);
    }
  };

  const totalUnmappedRevenue = unmapped.reduce((s, u) => s + (u.revenue || 0), 0);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Link2 size={14} style={{ color: 'var(--mt-text-muted)' }} />
        <h2 className="mt-heading text-sm">Doctor Name Mappings</h2>
        <span className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
          · merge billing-name variants under one canonical doctor
        </span>
      </div>

      {loading ? (
        <div className="mt-card p-6 text-center text-xs" style={{ color: 'var(--mt-text-muted)' }}>
          Loading mappings…
        </div>
      ) : (
        <>
          {/* Unmapped — priority surface */}
          {unmapped.length > 0 ? (
            <div className="mt-card p-0 overflow-hidden mb-3">
              <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'var(--mt-warn-soft)', borderBottom: '1px solid var(--mt-border)' }}>
                <AlertCircle size={12} style={{ color: 'var(--mt-warn-text)' }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--mt-warn-text)' }}>
                  {unmapped.length} raw {unmapped.length === 1 ? 'name needs' : 'names need'} mapping · {formatINR(totalUnmappedRevenue)} of revenue
                </span>
              </div>
              {unmapped.map((u, idx) => (
                <MappingRow
                  key={u.raw_name}
                  alias={u.raw_name}
                  revenue={u.revenue}
                  source={u.source}
                  currentDoctorId={null}
                  doctors={doctors}
                  canEdit={canEdit}
                  busy={busyKey === u.raw_name}
                  isCreating={creatingFor === u.raw_name}
                  newDoctorName={newDoctorName}
                  onPickDoctor={id => upsertAlias(u.raw_name, id)}
                  onStartCreate={() => { setCreatingFor(u.raw_name); setNewDoctorName(''); }}
                  onCancelCreate={() => { setCreatingFor(null); setNewDoctorName(''); }}
                  onChangeNewName={setNewDoctorName}
                  onSubmitCreate={() => createDoctorAndLink(u.raw_name)}
                  borderTop={idx > 0}
                />
              ))}
            </div>
          ) : (
            <div className="mt-card p-3 text-center text-xs mb-3" style={{ color: 'var(--mt-text-muted)' }}>
              All raw billing names are mapped — nothing to merge right now.
            </div>
          )}

          {/* Existing mappings — collapsed by default to keep the page tight */}
          {aliases.length > 0 && (
            <div>
              <button
                onClick={() => setShowMapped(s => !s)}
                className="text-xs flex items-center gap-1 mb-2 cursor-pointer"
                style={{ color: 'var(--mt-text-muted)' }}
              >
                {showMapped ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {aliases.length} existing mapping{aliases.length === 1 ? '' : 's'}
              </button>
              {showMapped && (
                <div className="mt-card p-0 overflow-hidden">
                  {aliases.map((a, idx) => (
                    <MappingRow
                      key={a.id}
                      alias={a.alias}
                      revenue={null}
                      source={null}
                      currentDoctorId={a.doctor_id}
                      currentDoctorName={a.doctor_name}
                      doctors={doctors}
                      canEdit={canEdit}
                      busy={busyKey === a.alias || busyKey === `unlink:${a.id}`}
                      isCreating={creatingFor === a.alias}
                      newDoctorName={newDoctorName}
                      onPickDoctor={id => upsertAlias(a.alias, id)}
                      onUnlink={() => deleteAlias(a.id)}
                      onStartCreate={() => { setCreatingFor(a.alias); setNewDoctorName(''); }}
                      onCancelCreate={() => { setCreatingFor(null); setNewDoctorName(''); }}
                      onChangeNewName={setNewDoctorName}
                      onSubmitCreate={() => createDoctorAndLink(a.alias)}
                      borderTop={idx > 0}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MappingRow({
  alias, revenue, source, currentDoctorId, currentDoctorName,
  doctors, canEdit, busy, isCreating, newDoctorName,
  onPickDoctor, onUnlink, onStartCreate, onCancelCreate, onChangeNewName, onSubmitCreate,
  borderTop,
}: {
  alias: string;
  revenue: number | null;
  source: string | null;
  currentDoctorId: number | null;
  currentDoctorName?: string;
  doctors: any[];
  canEdit: boolean;
  busy: boolean;
  isCreating: boolean;
  newDoctorName: string;
  onPickDoctor: (id: number) => void;
  onUnlink?: () => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onChangeNewName: (v: string) => void;
  onSubmitCreate: () => void;
  borderTop: boolean;
}) {
  return (
    <div className="px-3 py-2.5" style={{ borderTop: borderTop ? '1px solid var(--mt-border)' : 'none' }}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate" style={{ color: 'var(--mt-text-heading)' }}>
            {alias}
          </div>
          <div className="text-[10px] mt-0.5 flex items-center gap-2" style={{ color: 'var(--mt-text-faint)' }}>
            {revenue != null && <span className="mt-num">{formatINR(revenue)}</span>}
            {source && <span>· {source}</span>}
            {currentDoctorName && (
              <span>
                · mapped to <strong style={{ color: 'var(--mt-text-secondary)' }}>{currentDoctorName}</strong>
              </span>
            )}
          </div>
        </div>

        {isCreating ? (
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              autoFocus
              value={newDoctorName}
              onChange={e => onChangeNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !busy && newDoctorName.trim()) onSubmitCreate();
                if (e.key === 'Escape') onCancelCreate();
              }}
              placeholder="Canonical doctor name"
              className="mt-input text-xs"
              style={{ padding: '6px 10px', width: 220 }}
              disabled={busy}
            />
            <button
              onClick={onSubmitCreate}
              disabled={busy || !newDoctorName.trim()}
              className="mt-btn-soft text-xs flex items-center gap-1"
              title="Create doctor and link this raw name"
            >
              <Check size={12} /> Create
            </button>
            <button
              onClick={onCancelCreate}
              disabled={busy}
              className="text-[10px] px-1.5 py-1"
              style={{ color: 'var(--mt-text-faint)' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <select
              value={currentDoctorId ?? ''}
              onChange={e => { if (e.target.value) onPickDoctor(Number(e.target.value)); }}
              disabled={!canEdit || busy}
              className="mt-input text-xs"
              style={{ padding: '6px 10px', width: 220 }}
            >
              <option value="">{currentDoctorId ? 'Re-target…' : 'Link to doctor…'}</option>
              {doctors.map((d: any) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            {canEdit && (
              <button
                onClick={onStartCreate}
                disabled={busy}
                className="text-[10px] flex items-center gap-1 px-1.5 py-1"
                style={{ color: 'var(--mt-text-muted)' }}
                title="Create a new canonical doctor for this name"
              >
                <Plus size={11} /> New
              </button>
            )}
            {onUnlink && canEdit && (
              <button
                onClick={onUnlink}
                disabled={busy}
                className="p-1"
                style={{ color: 'var(--mt-text-faint)' }}
                title="Remove this mapping (the raw name will become unmapped)"
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-danger-text)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
              >
                <Unlink size={11} />
              </button>
            )}
            {busy && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--mt-text-faint)' }} />}
          </div>
        )}
      </div>
    </div>
  );
}
