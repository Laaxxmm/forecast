// ─────────────────────────────────────────────────────────────────────────────
// Operational Insights — pace-adjusted target tracking
//
// Answers "are we going to hit this month's target, and what should we do
// today to get back on pace?". Distinct from the Actuals page (current
// state) and the per-tab redesigns (Pharmacy Purchases / Sales & Profit /
// Stock & Expiry / Cross-Report / Clinic).
//
// All status colours and deltas are pace-adjusted: projected end-of-month
// attainment, NOT raw mtd-vs-full-target. Thresholds (project pct):
//   • ≥ 90 → green / "On track"
//   • 75–90 → amber / "On pace, watch"
//   • 60–75 → amber / "On pace, slow start"
//   • < 60  → red   / "Behind target"
//
// The server already computes per-card `projected = dailyRate × daysInMonth`
// and a `rag` value, but its thresholds were 95/80 (too tight on green,
// too loose on amber). We re-derive the status here so the methodology
// lives in one place and matches the rest of the page.
//
// Sections that need backend data we don't have yet (3-month historical
// day-N comparison, pharmacy outlier rupee leak in this endpoint) are
// documented in INSIGHTS_BACKEND.md. The dependent UI sections gracefully
// hide rather than fabricate numbers.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber, formatCompact } from '../utils/format';
import { Activity, Download } from 'lucide-react';
import InsightDownloadPanel from '../components/dashboard/InsightDownloadPanel';
import SyncIndicator from '../components/common/SyncIndicator';

// ─── Types (server contract) ─────────────────────────────────────────────────

interface CardData {
  label: string; mtd: number; target: number; projected: number;
  dailyRate: number; requiredRate: number; rag: string;
  lastMonthMtd: number; unit: string;
  category?: string;
}
interface WeekData { patients: number; revenue: number; transactions: number; profit: number; avgTicket: number; }
interface StreamData {
  name: string; streamId: number; icon: string; color: string;
  cards: CardData[]; thisWeek: WeekData; lastWeek: WeekData;
  daily: { date: string; patients?: number; revenue: number; transactions?: number; profit?: number }[];
}
interface InsightsData {
  month: string; monthLabel: string;
  daysElapsed: number; daysInMonth: number; daysRemaining: number;
  streams: StreamData[];
  combined: { mtdRevenue: number; targetRevenue: number; projectedRevenue: number; rag: string };
  actions: { severity: string; stream: string; message: string }[];
}

// ─── Status / tone helpers ──────────────────────────────────────────────────

type Status = 'green' | 'amber' | 'red' | 'grey';

function statusByProjected(projectedPct: number, hasTarget: boolean): Status {
  if (!hasTarget || !isFinite(projectedPct)) return 'grey';
  if (projectedPct >= 90) return 'green';
  if (projectedPct >= 60) return 'amber';
  return 'red';
}

function cardProjectedPct(card: CardData): number {
  if (!card.target || card.target <= 0) return 0;
  return (card.projected / card.target) * 100;
}

function headerStatus(pct: number, hasTarget: boolean): { label: string; status: Status } {
  if (!hasTarget) return { label: 'No target', status: 'grey' };
  if (pct >= 90) return { label: 'On track', status: 'green' };
  if (pct >= 75) return { label: 'On pace, watch', status: 'amber' };
  if (pct >= 60) return { label: 'On pace, slow start', status: 'amber' };
  return { label: 'Behind target', status: 'red' };
}

const STATUS_DOT: Record<Status, string> = {
  green: '#1D9E75',
  amber: '#BA7517',
  red:   '#A32D2D',
  grey:  '#94A3B8',
};

const STATUS_PILL: Record<Status, { bg: string; color: string }> = {
  green: { bg: '#EAF3DE', color: '#173404' },
  amber: { bg: '#FAEEDA', color: '#412402' },
  red:   { bg: '#FCEBEB', color: '#501313' },
  grey:  { bg: 'var(--mt-bg-muted)', color: 'var(--mt-text-muted)' },
};

const STATUS_BAR: Record<Status, string> = {
  green: '#1D9E75',
  amber: '#EF9F27',
  red:   '#E25555',
  grey:  '#CBD5E1',
};

// Tinted KPI palette for the 5-card summary strip + gross-margin strip.
type Tone = { bg: string; border: string; label: string; value: string; sub: string };
const KPI_TONES: Record<'teal' | 'blue' | 'coral' | 'amber' | 'purple' | 'green' | 'red', Tone> = {
  teal:   { bg: '#E1F5EE', border: 'rgba(15,110,86,0.18)', label: '#0F6E56', value: '#04342C', sub: 'rgba(15,110,86,0.78)' },
  blue:   { bg: '#E6F1FB', border: 'rgba(4,44,83,0.18)',   label: '#1D4ED8', value: '#042C53', sub: 'rgba(29,78,216,0.78)' },
  coral:  { bg: '#FCEBEB', border: 'rgba(80,19,19,0.18)',  label: '#A32D2D', value: '#501313', sub: 'rgba(163,45,45,0.78)' },
  amber:  { bg: '#FAEEDA', border: 'rgba(99,56,6,0.18)',   label: '#854F0B', value: '#412402', sub: 'rgba(133,79,11,0.78)' },
  purple: { bg: '#EEEDFE', border: 'rgba(38,33,92,0.18)',  label: '#5B4DBE', value: '#26215C', sub: 'rgba(91,77,190,0.78)' },
  green:  { bg: '#E1F5EE', border: 'rgba(15,110,86,0.18)', label: '#0F6E56', value: '#04342C', sub: 'rgba(15,110,86,0.78)' },
  red:    { bg: '#FCEBEB', border: 'rgba(80,19,19,0.18)',  label: '#A32D2D', value: '#501313', sub: 'rgba(163,45,45,0.78)' },
};

function fmtVal(v: number, unit: string) {
  if (unit === 'currency') return formatINR(v);
  if (unit === 'percent') return `${v}%`;
  return formatNumber(v);
}

function compactInr(v: number): string {
  return `₹${formatCompact(v)}`;
}

function DownloadButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
      style={{
        background: hover ? 'var(--mt-bg-muted)' : 'var(--mt-bg-raised)',
        color: hover ? 'var(--mt-text-primary)' : 'var(--mt-text-secondary)',
        border: '1px solid var(--mt-border)',
      }}
      title="Download operational insight report"
    >
      <Download size={14} />
      <span className="hidden sm:inline">Download Insight</span>
    </button>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function OperationalInsightsPage() {
  const [data, setData] = useState<InsightsData | null>(null);
  const [clinicData, setClinicData] = useState<any | null>(null);
  const [pharmaData, setPharmaData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const clientName = typeof window !== 'undefined' ? (localStorage.getItem('client_name') || '') : '';
  const branchName = typeof window !== 'undefined' ? (localStorage.getItem('branch_name') || '') : '';
  const branchState = typeof window !== 'undefined' ? (localStorage.getItem('branch_state') || '') : '';

  const monthOptions = useMemo(() => {
    const now = new Date();
    const todayMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const opts: { value: string; label: string }[] = [];
    for (let i = 0; i <= 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthLabel = `${names[d.getMonth()]} '${String(d.getFullYear()).slice(-2)}`;
      const label = value === todayMonth
        ? `Current month (${monthLabel})`
        : (i === 1 ? `Last month (${monthLabel})` : monthLabel);
      opts.push({ value, label });
    }
    return opts;
  }, []);

  const [selectedMonth, setSelectedMonth] = useState<string>(() => monthOptions[0].value);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    api.get('/dashboard/operational-insights', { params: { month: selectedMonth }, signal: ctl.signal })
      .then(r => {
        if (ctl.signal.aborted) return;
        setData(r.data); setLoading(false);
      })
      .catch(() => {
        if (ctl.signal.aborted) return;
        setLoading(false);
      });
    return () => ctl.abort();
  }, [selectedMonth]);

  // Sub-tab data for the Recovery Levers card (clinic cross-sell math +
  // pharmacy margin-leak rupees). Same period scope as the headline data.
  // Loads independently — the page renders without it, the levers card
  // simply hides any lever that depends on missing data.
  useEffect(() => {
    const ctl = new AbortController();
    if (!data?.month) return;
    const [y, m] = data.month.split('-');
    const startMonth = `${y}-${m}`;
    const endMonth = startMonth;
    api.get('/dashboard/clinic-analytics', { params: { startMonth, endMonth }, signal: ctl.signal })
      .then(r => { if (!ctl.signal.aborted) setClinicData(r.data); })
      .catch(() => {});
    api.get('/dashboard/pharmacy-analytics', { params: { startMonth, endMonth }, signal: ctl.signal })
      .then(r => { if (!ctl.signal.aborted) setPharmaData(r.data); })
      .catch(() => {});
    return () => ctl.abort();
  }, [data?.month]);

  if (loading && !data) return (
    <div className="flex items-center justify-center py-20">
      <div
        className="w-6 h-6 rounded-full animate-spin"
        style={{
          border: '2px solid color-mix(in srgb, var(--mt-accent) 30%, transparent)',
          borderTopColor: 'var(--mt-accent)',
        }}
      />
    </div>
  );

  if (!data || data.streams.length === 0) return (
    <div className="p-6 text-center text-sm" style={{ color: 'var(--mt-text-muted)' }}>
      No data available. Import actuals to see insights.
    </div>
  );

  const { streams, combined, daysElapsed, daysInMonth, daysRemaining } = data;
  const todayMonthStr = (() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
  })();
  const isClosedPeriod = data.month !== todayMonthStr && daysRemaining === 0;

  // ── Headline pace numbers ──────────────────────────────────────────────
  const earned   = combined.mtdRevenue;
  const target   = combined.targetRevenue;
  const projected = combined.projectedRevenue;
  const hasTarget = target > 0;
  const projectedAttainmentPct = hasTarget ? (projected / target) * 100 : 0;
  const earnedPct   = hasTarget ? (earned / target) * 100 : 0;
  const elapsedPct  = daysInMonth > 0 ? (daysElapsed / daysInMonth) * 100 : 0;
  const gap = Math.max(0, target - earned);
  const gapPerDay = daysRemaining > 0 ? Math.round(gap / daysRemaining) : 0;
  const dailyNeed = daysInMonth > 0 ? Math.round(target / daysInMonth) : 0;

  const status = headerStatus(projectedAttainmentPct, hasTarget);

  // Streams at risk = projected attainment < 90%, weighted by stream-level
  // revenue cards (consultation/diagnostics/other revenue/pharmacy sales).
  // Visit counts and gross-margin cards are not included so the count
  // matches the headline rupee story.
  const allRevenueCards: { stream: string; card: CardData; status: Status }[] = [];
  for (const s of streams) {
    for (const c of s.cards) {
      const isRevenueCard = c.unit === 'currency' && c.label.toLowerCase().includes('revenue')
        || c.unit === 'currency' && c.label.toLowerCase() === 'sales';
      if (!isRevenueCard) continue;
      const pct = cardProjectedPct(c);
      allRevenueCards.push({
        stream: c.category || s.name,
        card: c,
        status: statusByProjected(pct, c.target > 0),
      });
    }
  }
  const streamsAtRisk = allRevenueCards.filter(x => x.status !== 'green' && x.status !== 'grey');
  const totalRevenueCards = allRevenueCards.length;

  // ── Combined daily progression (clinic + pharmacy summed per day) ──────
  // `isToday` flags the live current day so the chart can render its bar
  // with the in-progress hatched pattern. Only fires for live months —
  // past months have daysRemaining === 0 and no day is in progress.
  type DayPoint = { day: number; date: string; revenue: number; isFuture: boolean; isToday: boolean };
  const dailyMap = new Map<string, number>();
  for (const s of streams) {
    for (const d of s.daily) {
      dailyMap.set(d.date, (dailyMap.get(d.date) || 0) + (Number(d.revenue) || 0));
    }
  }
  const [year, month] = data.month.split('-').map(Number);
  const dailyProgression: DayPoint[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isFuture = d > daysElapsed;
    // Today = the most-recent past-or-current day on a live month. For
    // closed periods (daysRemaining === 0) we never flag a day as today.
    const isToday = !isFuture && d === daysElapsed && daysRemaining > 0;
    dailyProgression.push({
      day: d,
      date,
      revenue: dailyMap.get(date) || 0,
      isFuture,
      isToday,
    });
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1400px] mx-auto animate-fade-in">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2" style={{ fontSize: 22, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
            <Activity size={20} style={{ color: 'var(--mt-accent)' }} />
            Operational insights
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--mt-text-muted)' }}>
            {isClosedPeriod
              ? `${data.monthLabel} · Closed period · Final values`
              : `${data.monthLabel} · Day ${daysElapsed} of ${daysInMonth}${daysRemaining > 0 ? ' · in progress' : ''} · ${daysRemaining} days remaining · ${Math.round(elapsedPct)}% of month elapsed`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Sync indicator — only meaningful for live month data; for
              closed periods every day is finalised. */}
          {daysRemaining > 0 && (
            <SyncIndicator streams={data.streams} />
          )}
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="text-sm rounded-lg px-3 py-1.5 cursor-pointer"
            style={{
              background: 'var(--mt-bg-raised)',
              color: 'var(--mt-text-heading)',
              border: '1px solid var(--mt-border)',
            }}
            title="Switch the period under review"
          >
            {monthOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <DownloadButton onClick={() => setDownloadOpen(true)} />
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm"
            style={{
              background: STATUS_PILL[status.status].bg,
              color: STATUS_PILL[status.status].color,
              border: `1px solid ${STATUS_DOT[status.status]}33`,
              fontWeight: 500,
            }}
            title={hasTarget
              ? `Projected end-of-month attainment: ${projectedAttainmentPct.toFixed(1)}%`
              : 'No target set for this period'}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: STATUS_DOT[status.status] }} />
            {status.label}
          </div>
        </div>
      </div>

      <InsightDownloadPanel
        open={downloadOpen}
        onClose={() => setDownloadOpen(false)}
        data={data}
        clientName={clientName}
        branchName={branchName}
        branchState={branchState}
      />

      {/* ── 5-card summary KPI strip ─────────────────────────────────────── */}
      {hasTarget && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-3">
          <SummaryKpi
            tone="teal"
            label="EARNED SO FAR"
            value={formatINR(earned)}
            sub={`${earnedPct.toFixed(1)}% of ${formatINR(target)} target`}
          />
          <SummaryKpi
            tone="blue"
            label="PROJECTED MONTH-END"
            value={formatINR(projected)}
            sub={`${projectedAttainmentPct.toFixed(1)}% at current pace`}
          />
          <SummaryKpi
            tone="coral"
            label="GAP TO TARGET"
            value={formatINR(gap)}
            sub={daysRemaining > 0 ? `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} · ${formatINR(gapPerDay)}/day needed` : 'Period closed'}
          />
          <SummaryKpi
            tone="amber"
            label="STREAMS AT RISK"
            value={`${streamsAtRisk.length} of ${totalRevenueCards}`}
            sub={streamsAtRisk.length > 0
              ? streamsAtRisk.slice(0, 3).map(x => x.stream).join(', ') + (streamsAtRisk.length > 3 ? ', …' : '')
              : 'All revenue streams on pace'}
          />
        </div>
      )}

      {/* ── Combined Revenue Progress (with markers) ─────────────────────── */}
      {hasTarget && (
        <ProgressCard
          earned={earned}
          target={target}
          projected={projected}
          earnedPct={earnedPct}
          elapsedPct={elapsedPct}
          projectedPct={projectedAttainmentPct}
          dayInProgress={daysRemaining > 0}
        />
      )}

      {/* ── Stream grid 4×2 (Visits / Revenue) + Pharmacy (Sales / Gross Profit) ── */}
      <StreamGrid streams={streams} />

      {/* ── Pharmacy Gross Margin full-width strip ───────────────────────── */}
      <PharmacyGrossMarginStrip streams={streams} />

      {/* ── Recovery Levers ─────────────────────────────────────────────── */}
      <RecoveryLevers
        streams={streams}
        clinicData={clinicData}
        pharmaData={pharmaData}
        gap={gap}
        daysRemaining={daysRemaining}
        hasTarget={hasTarget}
      />

      {/* ── Daily progression chart ─────────────────────────────────────── */}
      {daysElapsed >= 2 ? (
        <DailyProgressionChart
          dailyProgression={dailyProgression}
          dailyNeed={dailyNeed}
          monthLabel={data.monthLabel}
          year={year}
          month={month}
          daysInMonth={daysInMonth}
        />
      ) : (
        <div
          className="px-4 py-3 rounded-lg text-[12px]"
          style={{ background: 'var(--mt-bg-muted)', color: 'var(--mt-text-faint)' }}
        >
          Daily progression will appear after 2+ days of data.
        </div>
      )}
      {/* Per-stream weekly comparison and daily charts have been retired —
          weekly comparisons live in the Weekly Insight PDF and daily
          revenue trends are covered by the Daily Progression chart above. */}
    </div>
  );
}

// ─── Summary KPI tile ──────────────────────────────────────────────────────

function SummaryKpi({ tone, label, value, sub }: {
  tone: keyof typeof KPI_TONES;
  label: string;
  value: string;
  sub: string;
}) {
  const t = KPI_TONES[tone];
  return (
    <div
      className="rounded-md p-3"
      style={{ background: t.bg, border: `1px solid ${t.border}` }}
    >
      <p
        className="text-[11px]"
        style={{ color: t.label, letterSpacing: '0.5px', textTransform: 'uppercase', fontWeight: 500 }}
      >
        {label}
      </p>
      <p className="mt-1 tabular-nums" style={{ fontSize: 20, fontWeight: 500, color: t.value, lineHeight: 1.25 }}>
        {value}
      </p>
      <p className="text-[11px] mt-1" style={{ color: t.sub }}>{sub}</p>
    </div>
  );
}

// ─── Combined Revenue Progress ─────────────────────────────────────────────

function ProgressCard({ earned, target, projected, earnedPct, elapsedPct, projectedPct: projPct, dayInProgress }: {
  earned: number;
  target: number;
  projected: number;
  earnedPct: number;
  elapsedPct: number;
  projectedPct: number;
  /** When today is the live current day — adds an "in progress" tag to
   *  the Today marker label so the user knows that position is the
   *  partial day-so-far, not a finalised mid-month checkpoint. */
  dayInProgress: boolean;
}) {
  const earnedClamp = Math.min(100, Math.max(0, earnedPct));
  const elapsedClamp = Math.min(100, Math.max(0, elapsedPct));
  const projClamp = Math.min(100, Math.max(0, projPct));
  const verbHas = projPct >= 100 ? 'beat' : 'end';
  const verbAt  = projPct >= 100 ? 'over' : 'at';
  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 500, color: 'var(--mt-text-heading)' }}>Combined revenue progress</h3>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
            At current pace you'll {verbHas} the month {verbAt} {formatINR(Math.round(projected))} ({projPct.toFixed(1)}% of target)
          </p>
        </div>
        <p className="text-[13px] tabular-nums shrink-0" style={{ color: 'var(--mt-text-secondary)' }}>
          {formatINR(earned)} / {formatINR(target)}
        </p>
      </div>
      {/* Bar with two markers — Today (black) + Projected end (amber).
          Label positions are clamped at the edges so the text never spills
          off the card: at <=5% the label anchors left, at >=95% it anchors
          right (translateX(-100%)), otherwise it stays centred under the
          marker line. */}
      <div className="relative" style={{ paddingTop: 28, paddingBottom: 28 }}>
        {(() => {
          // Helper: pick the right transform + textAlign based on position.
          // At extremes we drop the centring so the label stays inside the
          // card; the 4-6px vertical gap to the marker line is achieved
          // with the paddingTop/paddingBottom on this wrapper.
          const labelStyle = (pct: number, baseColor: string, weight: number, anchor: 'top' | 'bottom') => {
            const style: React.CSSProperties = {
              position: 'absolute',
              left: `${pct}%`,
              fontSize: 10,
              color: baseColor,
              whiteSpace: 'nowrap',
              fontWeight: weight,
            };
            if (anchor === 'top') style.top = 0; else style.bottom = 0;
            if (pct <= 5)        { style.transform = 'none';                style.textAlign = 'left'; }
            else if (pct >= 95)  { style.transform = 'translateX(-100%)';   style.textAlign = 'right'; }
            else                 { style.transform = 'translateX(-50%)';    style.textAlign = 'center'; }
            return style;
          };
          return (
            <>
              <div style={labelStyle(elapsedClamp, 'var(--mt-text-secondary)', 400, 'top')}>
                Today ({elapsedClamp.toFixed(0)}%){dayInProgress ? ' · in progress' : ''}
              </div>
              {/* The bar itself */}
              <div className="relative h-[20px] rounded-full overflow-hidden" style={{ background: 'var(--mt-bg-muted)' }}>
                {/* Earned fill */}
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${earnedClamp}%`, background: '#1D9E75' }}
                />
                {/* Today vertical line (black, solid) */}
                <div
                  className="absolute top-0 bottom-0"
                  style={{ left: `${elapsedClamp}%`, width: 2, background: 'var(--mt-text-heading)' }}
                />
                {/* Projected end vertical line (amber, solid) */}
                <div
                  className="absolute top-0 bottom-0"
                  style={{ left: `${projClamp}%`, width: 2, background: '#BA7517' }}
                />
              </div>
              <div style={labelStyle(projClamp, '#BA7517', 500, 'bottom')}>
                Projected end ({projClamp.toFixed(0)}%)
              </div>
            </>
          );
        })()}
      </div>
      {/* Inline legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-1 text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-2 rounded-sm" style={{ background: '#1D9E75' }} />
          Earned ({earnedPct.toFixed(0)}%)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-[2px] h-3" style={{ background: 'var(--mt-text-heading)' }} />
          Today's position ({elapsedPct.toFixed(0)}%)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-[2px] h-3" style={{ background: '#BA7517' }} />
          Projected end ({projPct.toFixed(0)}%)
        </span>
      </div>
    </div>
  );
}

// ─── Stream grid ───────────────────────────────────────────────────────────

function StreamGrid({ streams }: { streams: StreamData[] }) {
  // Build the column structure:
  //   Clinic streams contribute one column per category (Consultation /
  //   Diagnostics / Other Revenue) with [Visits, Revenue] cards.
  //   Pharmacy contributes one column with [Sales, Gross Profit] cards
  //   (Gross Margin moves out to its own full-width strip below).
  type Column = { label: string; cards: CardData[] };
  const cols: Column[] = [];
  const clinic = streams.find(s => s.name.toLowerCase().includes('clinic') || s.name.toLowerCase().includes('health'));
  const pharma = streams.find(s => s.name.toLowerCase().includes('pharma'));

  if (clinic) {
    const cats = [...new Set(clinic.cards.map(c => c.category).filter(Boolean))] as string[];
    for (const cat of cats) {
      cols.push({ label: cat, cards: clinic.cards.filter(c => c.category === cat) });
    }
  }
  if (pharma) {
    cols.push({
      label: pharma.name,
      cards: pharma.cards.filter(c => c.unit !== 'percent'), // exclude Gross Margin
    });
  }

  if (cols.length === 0) return null;

  // Pharmacy MTD bill count — needed for the Sales card's avg-ticket
  // sub-line. The server doesn't surface a Bills card, but it returns
  // per-day `transactions` in `pharma.daily[]`, which sums to MTD bills.
  const pharmaBillCount = pharma
    ? pharma.daily.reduce((s, d) => s + (Number(d.transactions) || 0), 0)
    : 0;

  // Avg-ticket sub-line generator. Returns undefined for any card that
  // shouldn't show one (per the spec — visits cards, Other Revenue, and
  // pharmacy Gross Profit don't get the sub-line). Returning undefined
  // is what gates the render in PaceCard.
  function avgTicketSubLine(card: CardData, col: Column): string | undefined {
    // Consultation / Diagnostics Revenue → revenue ÷ visits in same column.
    if (
      card.unit === 'currency'
      && card.label === 'Revenue'
      && (col.label === 'Consultation' || col.label === 'Diagnostics')
    ) {
      const visitsCard = col.cards.find(c => c.label === 'Visits');
      const visits = Number(visitsCard?.mtd) || 0;
      if (visits > 0 && card.mtd > 0) {
        return `₹${Math.round(card.mtd / visits).toLocaleString('en-IN')} avg ticket`;
      }
    }
    // Pharmacy Sales → sales ÷ pharmacy bill count.
    if (card.unit === 'currency' && card.label === 'Sales' && pharmaBillCount > 0 && card.mtd > 0) {
      return `₹${Math.round(card.mtd / pharmaBillCount).toLocaleString('en-IN')} avg ticket`;
    }
    return undefined;
  }

  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}
    >
      {cols.map(col => (
        <div key={col.label} className="space-y-2">
          <p
            className="text-[11px]"
            style={{
              color: 'var(--mt-text-muted)',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              fontWeight: 500,
            }}
          >
            {col.label}
          </p>
          {col.cards.map(card => (
            <PaceCard
              key={card.label}
              card={card}
              subLine={avgTicketSubLine(card, col)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function PaceCard({ card, subLine }: { card: CardData; subLine?: string }) {
  const pct = cardProjectedPct(card);
  const status = statusByProjected(pct, card.target > 0);
  const earnedPct = card.target > 0 ? (card.mtd / card.target) * 100 : 0;
  // Need text colour: red if pace is significantly below need, amber if
  // moderately, default if pace meets or exceeds need.
  const needRatio = card.requiredRate > 0 ? card.dailyRate / card.requiredRate : 1;
  const needColor = needRatio >= 1 ? 'var(--mt-text-secondary)'
    : needRatio >= 0.7 ? '#854F0B'
    : '#A32D2D';

  return (
    <div
      className="rounded-xl"
      style={{
        background: 'var(--mt-bg-surface)',
        border: '1px solid var(--mt-border)',
        padding: '1rem',
      }}
    >
      {/* Top row: label + status dot */}
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[11px]"
          style={{
            color: 'var(--mt-text-muted)',
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          {card.label}
        </span>
        {status !== 'grey' && (
          <span className="w-2 h-2 rounded-full" style={{ background: STATUS_DOT[status] }} />
        )}
      </div>
      {/* Big number */}
      <div className="mt-1 tabular-nums" style={{ fontSize: 24, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
        {fmtVal(card.mtd, card.unit)}
      </div>
      {card.target > 0 && card.unit !== 'percent' && (
        <>
          {/* Target + projected pill */}
          <div className="flex items-center justify-between gap-2 mt-2 text-[11px]">
            <span style={{ color: 'var(--mt-text-faint)' }}>
              Target: <span className="tabular-nums">{fmtVal(card.target, card.unit)}</span>
            </span>
            <span
              className="rounded-md tabular-nums"
              style={{
                background: STATUS_PILL[status].bg,
                color: STATUS_PILL[status].color,
                padding: '1px 6px',
                fontWeight: 500,
                fontSize: 11,
              }}
            >
              {pct.toFixed(0)}% projected
            </span>
          </div>
          {/* Progress bar (4px) — uses earned %, coloured by status */}
          <div className="h-[4px] mt-2 rounded-full overflow-hidden" style={{ background: 'var(--mt-bg-muted)' }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(earnedPct, 100)}%`,
                background: STATUS_BAR[status],
              }}
            />
          </div>
          {/* Pace / Need footer */}
          <div
            className="grid grid-cols-2 gap-2 mt-2.5 pt-2.5"
            style={{ borderTop: '1px solid var(--mt-border)' }}
          >
            <div>
              <p className="text-[10px]" style={{ color: 'var(--mt-text-muted)' }}>PACE</p>
              <p className="text-[12px] tabular-nums" style={{ color: 'var(--mt-text-secondary)', fontWeight: 500 }}>
                {fmtVal(card.dailyRate, card.unit)}/day
              </p>
            </div>
            <div>
              <p className="text-[10px]" style={{ color: 'var(--mt-text-muted)' }}>NEED</p>
              <p className="text-[12px] tabular-nums" style={{ color: needColor, fontWeight: 500 }}>
                {fmtVal(card.requiredRate, card.unit)}/day
              </p>
            </div>
          </div>
        </>
      )}
      {card.target === 0 && card.unit !== 'percent' && (
        <div className="grid grid-cols-2 gap-2 mt-2.5 pt-2.5 text-[11px]" style={{ borderTop: '1px solid var(--mt-border)' }}>
          <div>
            <p className="text-[10px]" style={{ color: 'var(--mt-text-muted)' }}>PACE</p>
            <p className="text-[12px] tabular-nums" style={{ color: 'var(--mt-text-secondary)', fontWeight: 500 }}>
              {fmtVal(card.dailyRate, card.unit)}/day
            </p>
          </div>
          <div>
            <p className="text-[10px]" style={{ color: 'var(--mt-text-muted)' }}>PROJECTED</p>
            <p className="text-[12px] tabular-nums" style={{ color: 'var(--mt-text-secondary)', fontWeight: 500 }}>
              {fmtVal(card.projected, card.unit)}
            </p>
          </div>
        </div>
      )}
      {/* Avg-ticket sub-line — provided by StreamGrid for the cards that
          carry a ticket-style metric (Consultation/Diagnostics Revenue,
          Pharmacy Sales). Hidden when the denominator is zero so the
          card never shows ₹0 / NaN. */}
      {subLine && (
        <p
          className="text-[11px] tabular-nums"
          style={{ marginTop: 6, color: 'var(--mt-text-faint)' }}
        >
          {subLine}
        </p>
      )}
    </div>
  );
}

// ─── Pharmacy Gross Margin strip ───────────────────────────────────────────

function PharmacyGrossMarginStrip({ streams }: { streams: StreamData[] }) {
  const pharma = streams.find(s => s.name.toLowerCase().includes('pharma'));
  if (!pharma) return null;
  const gm = pharma.cards.find(c => c.unit === 'percent' && c.label.toLowerCase().includes('margin'));
  if (!gm) return null;

  const current = Number(gm.mtd) || 0;
  const forecast = Number(gm.target) || 0;
  const ratioToForecast = forecast > 0 ? current / forecast : 0;
  const status: Status = !forecast ? 'grey'
    : ratioToForecast >= 1 ? 'green'
    : ratioToForecast >= 0.6 ? 'amber'
    : 'red';
  const t = KPI_TONES[status === 'red' ? 'red' : status === 'amber' ? 'amber' : status === 'green' ? 'green' : 'teal'];

  const delta = forecast > 0 ? ((current - forecast) / forecast) * 100 : 0;
  const description = (() => {
    if (status === 'green') return 'Margin meeting forecast — quality of revenue is healthy.';
    if (status === 'amber') return 'Margin slightly below forecast. Watch outlier pricing on high-volume SKUs.';
    return 'Margin meaningfully below forecast. Re-price low-margin SKUs or review discount policy.';
  })();

  return (
    <div
      className="rounded-xl flex flex-col md:flex-row md:items-center md:justify-between gap-3"
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        padding: '14px 18px',
      }}
    >
      <div>
        <div className="flex items-center gap-2">
          <span
            className="text-[11px]"
            style={{
              color: t.label,
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              fontWeight: 500,
            }}
          >
            Pharmacy gross margin
          </span>
          <span className="w-2 h-2 rounded-full" style={{ background: STATUS_DOT[status] }} />
        </div>
        <p className="text-[12px] mt-1" style={{ color: t.sub, lineHeight: 1.5 }}>
          Quality indicator across pharmacy sales — measures how much of every rupee in sales becomes profit. {description}
        </p>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <div>
          <p className="text-[10px]" style={{ color: t.label, letterSpacing: '0.5px', textTransform: 'uppercase' }}>CURRENT</p>
          <p className="tabular-nums" style={{ fontSize: 22, fontWeight: 500, color: t.value }}>
            {current.toFixed(2)}%
          </p>
        </div>
        <div style={{ width: 1, height: 40, background: t.border }} />
        <div>
          <p className="text-[10px]" style={{ color: t.label, letterSpacing: '0.5px', textTransform: 'uppercase' }}>FORECAST</p>
          <p className="tabular-nums" style={{ fontSize: 14, color: t.value, fontWeight: 500 }}>
            {forecast.toFixed(2)}%
          </p>
        </div>
        {forecast > 0 && (
          <span
            className="rounded-md tabular-nums"
            style={{
              background: 'rgba(255,255,255,0.85)',
              color: t.value,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {delta >= 0 ? '+' : ''}{delta.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Recovery Levers ───────────────────────────────────────────────────────

function RecoveryLevers({ streams, clinicData, pharmaData, gap, daysRemaining, hasTarget }: {
  streams: StreamData[];
  clinicData: any | null;
  pharmaData: any | null;
  gap: number;
  daysRemaining: number;
  hasTarget: boolean;
}) {
  if (!hasTarget || gap <= 0 || daysRemaining <= 0) return null;

  type Lever = {
    key: string;
    tone: 'blue' | 'purple' | 'amber';
    category: string;
    title: string;
    description: string;
    rupeeImpact: number;
  };
  const levers: Lever[] = [];

  // ── Lever 1 — Volume push on the most-lagging revenue card ──
  // Find the revenue/sales card with the worst projected attainment that
  // still has a non-zero target. Frame the action in the underlying
  // visits/sales unit so it's concrete.
  const candidates: { stream: StreamData; card: CardData; pct: number; label: string }[] = [];
  for (const s of streams) {
    for (const c of s.cards) {
      if (!c.target) continue;
      if (c.unit === 'percent') continue;
      const pct = cardProjectedPct(c);
      const labelStream = c.category || s.name;
      candidates.push({ stream: s, card: c, pct, label: labelStream });
    }
  }
  const laggard = candidates.sort((a, b) => a.pct - b.pct)[0];
  if (laggard) {
    const c = laggard.card;
    const dailyShortfall = Math.max(0, c.requiredRate - c.dailyRate);
    let recovered = 0;
    let title = '';
    if (c.unit === 'count') {
      const visitsNeededExtra = Math.ceil(dailyShortfall);
      const avgTicket = laggard.stream.thisWeek.avgTicket || 0;
      recovered = visitsNeededExtra * Math.max(0, avgTicket) * daysRemaining;
      title = `Add ${visitsNeededExtra} ${c.label.toLowerCase()}/day to ${laggard.label}`;
    } else {
      recovered = dailyShortfall * daysRemaining;
      title = `Lift ${laggard.label} ${c.label.toLowerCase()} by ${formatINR(Math.round(dailyShortfall))}/day`;
    }
    if (recovered > 0) {
      levers.push({
        key: 'volume',
        tone: 'blue',
        category: 'Volume',
        title,
        description: `Closes about ${formatINR(Math.round(recovered))} of the gap over the remaining ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`,
        rupeeImpact: recovered,
      });
    }
  }

  // ── Lever 2 — Cross-sell on appointment-only patients ──
  // Math: count appointment-only patients × avg revenue per cross-sold
  // patient. Conservative — assumes a 30% conversion if we wanted to be
  // more defensible, but per the redesign brief we surface the full
  // opportunity and let the user discount it themselves.
  if (clinicData?.patientFlow) {
    const apptOnly = Number(clinicData.patientFlow.apptOnly) || 0;
    const crossToBoth = Number(clinicData.patientFlow.crossToBoth) || 0;
    const crossToBothRevenue = Number(clinicData.patientFlow.crossToBothRevenue) || 0;
    const avgCrossRevenue = crossToBoth > 0 ? crossToBothRevenue / crossToBoth : 0;
    const opportunity = apptOnly * avgCrossRevenue;
    if (apptOnly > 0 && avgCrossRevenue > 0 && opportunity > 0) {
      levers.push({
        key: 'cross-sell',
        tone: 'purple',
        category: 'Cross-sell',
        title: `Cross-sell to ${formatNumber(apptOnly)} appointment-only patients`,
        description: `Each cross-sold patient adds ~${formatINR(Math.round(avgCrossRevenue))} on average — full conversion would lift the period by ~${formatINR(Math.round(opportunity))}.`,
        rupeeImpact: opportunity,
      });
    }
  }

  // ── Lever 3 — Margin fix on outlier pharmacy SKUs ──
  // Pulls low-margin (< 5%) sales rupees from the pharmacy sales table.
  // The realistic recovery isn't the full leak — re-pricing typically
  // recovers part of it; we surface the leak number itself so the user
  // can size the action without us having to invent a recovery rate.
  if (pharmaData?.sales?.table?.length) {
    let leakRupees = 0;
    const skus = new Set<string>();
    for (const r of pharmaData.sales.table) {
      const sales = Number(r.sales_amount) || 0;
      const tax   = Number(r.sales_tax) || 0;
      const cogs  = Number(r.purchase_amount) || 0;
      const ns    = sales - tax;
      if (ns <= 0) continue;
      const profit = ns - cogs;
      if (profit < 0) continue;
      const margin = (profit / ns) * 100;
      if (margin < 5) {
        leakRupees += sales;
        if (r.drug_name) skus.add(String(r.drug_name));
      }
    }
    if (leakRupees > 0 && skus.size > 0) {
      levers.push({
        key: 'margin-fix',
        tone: 'amber',
        category: 'Margin fix',
        title: `Re-price ${formatNumber(skus.size)} outlier pharmacy SKU${skus.size === 1 ? '' : 's'}`,
        description: `${formatINR(Math.round(leakRupees))} of pharmacy revenue is selling below 5% margin. Pricing review on these SKUs converts low-quality sales into gross profit.`,
        rupeeImpact: leakRupees,
      });
    }
  }

  if (levers.length === 0) return null;

  const combinedUpside = levers.reduce((s, l) => s + l.rupeeImpact, 0);
  const fullyCloses = combinedUpside >= gap;

  const TONE_BG: Record<Lever['tone'], { bg: string; label: string; title: string; sub: string; border: string }> = {
    blue:   { bg: '#E6F1FB', label: '#1D4ED8', title: '#042C53', sub: 'rgba(4,44,83,0.78)',   border: 'rgba(29,78,216,0.18)' },
    purple: { bg: '#EEEDFE', label: '#5B4DBE', title: '#26215C', sub: 'rgba(38,33,92,0.78)',  border: 'rgba(91,77,190,0.18)' },
    amber:  { bg: '#FAEEDA', label: '#854F0B', title: '#412402', sub: 'rgba(133,79,11,0.78)', border: 'rgba(99,56,6,0.18)' },
  };

  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}>
      <div className="mb-1">
        <h3 style={{ fontSize: 16, fontWeight: 500, color: 'var(--mt-text-heading)' }}>What can close the gap?</h3>
        <p className="text-[13px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
          {formatINR(Math.round(gap))} gap · {daysRemaining} day{daysRemaining === 1 ? '' : 's'} left · ranked by realistic impact
        </p>
      </div>
      <div
        className="grid gap-3 mt-4"
        style={{ gridTemplateColumns: `repeat(${Math.min(3, levers.length)}, minmax(0, 1fr))` }}
      >
        {levers.map((l, i) => {
          const tone = TONE_BG[l.tone];
          return (
            <div
              key={l.key}
              className="rounded-md"
              style={{ background: tone.bg, border: `1px solid ${tone.border}`, padding: 14 }}
            >
              <p
                className="text-[11px]"
                style={{ color: tone.label, letterSpacing: '0.5px', textTransform: 'uppercase', fontWeight: 500 }}
              >
                LEVER {i + 1} · {l.category.toUpperCase()}
              </p>
              <p style={{ fontSize: 14, fontWeight: 500, color: tone.title, marginTop: 4 }}>
                {l.title}
              </p>
              <p className="text-[11px] mt-2" style={{ color: tone.sub, lineHeight: 1.5 }}>
                {l.description}
              </p>
            </div>
          );
        })}
      </div>
      {/* Footer summary */}
      <div
        className="mt-4 pt-3 text-[12px]"
        style={{ borderTop: '1px solid var(--mt-border)', color: 'var(--mt-text-faint)' }}
      >
        {fullyCloses
          ? `Combined upside if all three levers executed: ~${formatINR(Math.round(combinedUpside))} — fully closes the gap.`
          : `Combined upside if all three levers executed: ~${formatINR(Math.round(combinedUpside))}. Still ${formatINR(Math.round(Math.max(0, gap - combinedUpside)))} short — target may need revisiting in next forecast cycle.`}
      </div>
    </div>
  );
}

// ─── Daily progression chart ───────────────────────────────────────────────

function DailyProgressionChart({ dailyProgression, dailyNeed, monthLabel, year, month, daysInMonth }: {
  dailyProgression: { day: number; date: string; revenue: number; isFuture: boolean; isToday: boolean }[];
  dailyNeed: number;
  monthLabel: string;
  year: number;
  month: number;
  daysInMonth: number;
}) {
  // Annotate the chart data so future days render as low-opacity grey
  // bars (consistent placeholder height) while completed days render as
  // their actual revenue. Recharts can't conditionally style cells based
  // on data alone, so the actual coloring is done via <Cell> below.
  // Today (the live current day) carries `isToday` so the bar can render
  // with the in-progress hatched pattern, plus an asterisk on the X-axis
  // tick to flag it.
  const chartData = dailyProgression.map(d => ({
    day: String(d.day),
    revenue: d.revenue,
    isFuture: d.isFuture,
    isToday: d.isToday,
  }));
  const todayDayLabel = chartData.find(d => d.isToday)?.day;

  // Show every 5th tick + day 1 + last day + today, to avoid label
  // crowding on narrow viewports while still flagging today.
  const tickInterval = (idx: number) => {
    if (idx === 0) return true;
    if (idx === daysInMonth - 1) return true;
    if (chartData[idx]?.isToday) return true;
    return idx % 5 === 0;
  };

  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 500, color: 'var(--mt-text-heading)' }}>
            Daily progression vs needed pace
          </h3>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
            {monthLabel} · bars show actual; dashed line shows needed daily pace to hit target
          </p>
        </div>
        {dailyNeed > 0 && (
          <p className="text-[12px] tabular-nums shrink-0" style={{ color: '#BA7517', fontWeight: 500 }}>
            Need: {formatINR(dailyNeed)}/day
          </p>
        )}
      </div>
      <div className="mt-4">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            {/* In-progress hatched pattern. Defined inside the SVG via
                Recharts' direct child <defs> so the url(#…) reference
                from the Cell fill resolves within the same document. */}
            <defs>
              <pattern
                id="ip-stripe-green"
                patternUnits="userSpaceOnUse"
                width="8"
                height="8"
                patternTransform="rotate(45)"
              >
                <rect width="8" height="8" fill="#1D9E75" fillOpacity="0.35" />
                <rect width="4" height="8" fill="#1D9E75" />
              </pattern>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--mt-border)" vertical={false} />
            <XAxis
              dataKey="day"
              tick={(props: any) => {
                const { x, y, payload, index } = props;
                if (!tickInterval(index)) return <text x={x} y={y} />;
                const isToday = chartData[index]?.isToday;
                return (
                  <text
                    x={x}
                    y={y + 12}
                    textAnchor="middle"
                    fontSize={10}
                    fill={isToday ? 'var(--mt-text-secondary)' : 'var(--mt-text-faint)'}
                    fontWeight={isToday ? 500 : 400}
                  >
                    {payload.value}{isToday ? '*' : ''}
                  </text>
                );
              }}
              interval={0}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--mt-text-faint)' }}
              tickFormatter={(v: number) => formatCompact(v)}
              width={42}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--mt-bg-raised)',
                border: '1px solid var(--mt-border)',
                borderRadius: '10px',
                fontSize: '11px',
                boxShadow: 'var(--mt-shadow-pop)',
              }}
              labelFormatter={(label) => `${monthLabel.split(' ')[0]} ${label}`}
              formatter={(value: number, _name, props: any) => {
                const p = props.payload;
                if (p?.isFuture) return ['Future day', 'Day'];
                if (p?.isToday) {
                  return [`${formatINR(value)} · day in progress, final after 11 PM sync`, 'Revenue'];
                }
                return [formatINR(value), 'Revenue'];
              }}
            />
            {dailyNeed > 0 && (
              <ReferenceLine
                y={dailyNeed}
                stroke="#BA7517"
                strokeDasharray="4 4"
                strokeWidth={2}
                label={{
                  value: `Need ${compactInr(dailyNeed)}/day`,
                  position: 'right',
                  fill: '#BA7517',
                  fontSize: 11,
                  fontWeight: 500,
                }}
              />
            )}
            <Bar dataKey="revenue" radius={[3, 3, 0, 0]}>
              {chartData.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.isFuture ? '#B4B2A9' : d.isToday ? 'url(#ip-stripe-green)' : '#1D9E75'}
                  fillOpacity={d.isFuture ? 0.3 : 1}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-2 rounded-sm" style={{ background: '#1D9E75' }} />
          Actual (completed days)
        </span>
        {todayDayLabel != null && (
          <span className="inline-flex items-center gap-1.5">
            <HatchedSwatch color="#1D9E75" />
            In progress (today, partial)
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-2 rounded-sm" style={{ background: '#B4B2A9', opacity: 0.45 }} />
          Future days
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-4"
            style={{ height: 0, borderTop: '2px dashed #BA7517' }}
          />
          Daily need to hit target
        </span>
      </div>
      {/* Suppress unused-imports warning for `year`/`month` — reserved for
          future use if we cross-fade between months. */}
      <span className="hidden">{year}-{month}</span>
    </div>
  );
}

// Tiny SVG swatch that mirrors the in-progress hatched pattern used in
// the chart. Inline so legends elsewhere can paste the same swatch
// without mounting an extra Recharts SVG.
function HatchedSwatch({ color }: { color: string }) {
  const id = `hs-${color.replace('#', '')}`;
  return (
    <svg width="12" height="8" aria-hidden="true">
      <defs>
        <pattern id={id} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={color} fillOpacity="0.35" />
          <rect width="3" height="6" fill={color} />
        </pattern>
      </defs>
      <rect width="12" height="8" rx="1" fill={`url(#${id})`} />
    </svg>
  );
}

// Per-stream weekly + daily sections were removed in the May 2026 polish
// pass. Weekly comparisons now live in the Weekly Insight PDF; the
// month-wide daily revenue trend is covered by DailyProgressionChart
// above. Per-stream signals (visits, revenue, sales, gross profit) live
// in the 4×2 stream grid — augmented with Avg Ticket sub-lines on the
// Consultation / Diagnostics Revenue cards and the Pharmacy Sales card.
