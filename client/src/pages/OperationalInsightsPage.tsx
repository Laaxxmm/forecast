import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber } from '../utils/format';
import {
  Activity, Users, ShoppingBag,
  AlertTriangle, Info, ArrowUp, ArrowDown, Minus, Download,
} from 'lucide-react';
import InsightDownloadPanel from '../components/dashboard/InsightDownloadPanel';

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

// Tone helpers
type Tone = { fg: string; soft: string; border: string };
const tone = (hex: string): Tone => ({
  fg: hex,
  soft: `color-mix(in srgb, ${hex} 14%, transparent)`,
  border: `color-mix(in srgb, ${hex} 32%, transparent)`,
});
const TONES: Record<string, Tone> = {
  accent: tone('#10b981'),
  blue:   tone('#3b82f6'),
  amber:  tone('#f59e0b'),
  danger: tone('#ef4444'),
};

// RAG → tone mapping
const RAG_TONE: Record<string, Tone> = {
  GREEN: TONES.accent,
  AMBER: TONES.amber,
  RED:   TONES.danger,
  GREY:  { fg: 'var(--mt-text-muted)', soft: 'var(--mt-bg-muted)', border: 'var(--mt-border)' },
};

const RAG_LABEL: Record<string, string> = {
  GREEN: 'On Track',
  AMBER: 'Needs Attention',
  RED:   'Behind Target',
  GREY:  'No Target',
};

function fmtVal(v: number, unit: string) {
  if (unit === 'currency') return formatINR(v);
  if (unit === 'percent') return `${v}%`;
  return formatNumber(v);
}

function TrendBadge({ current, previous }: { current: number; previous: number }) {
  if (!previous || !current) return null;
  const pct = ((current - previous) / previous) * 100;
  const up = pct >= 0;
  const t = up ? TONES.accent : TONES.danger;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded"
      style={{ background: t.soft, color: t.fg, border: `1px solid ${t.border}` }}
    >
      {up ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
      {Math.abs(Math.round(pct))}%
    </span>
  );
}

function VariationBadge({ actual, forecast }: { actual: number; forecast: number }) {
  if (!forecast) return null;
  const diff = actual - forecast;
  const pct = (diff / forecast) * 100;
  const positive = diff >= 0;
  const t = positive ? TONES.accent : TONES.danger;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded"
      style={{ background: t.soft, color: t.fg, border: `1px solid ${t.border}` }}
    >
      {positive ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
      {Math.abs(Math.round(pct * 10) / 10)}%
    </span>
  );
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

export default function OperationalInsightsPage() {
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const clientName = typeof window !== 'undefined' ? (localStorage.getItem('client_name') || '') : '';

  useEffect(() => {
    api.get('/dashboard/operational-insights')
      .then(r => { setData(r.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
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

  const { streams, combined, actions, daysElapsed, daysInMonth, daysRemaining } = data;
  const dailyTargetLine = combined.targetRevenue > 0 ? Math.round(combined.targetRevenue / daysInMonth) : 0;
  const ragTone = RAG_TONE[combined.rag] || RAG_TONE.GREY;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1400px] mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1
            className="mt-heading text-lg flex items-center gap-2"
            style={{ color: 'var(--mt-text-heading)' }}
          >
            <Activity size={20} style={{ color: 'var(--mt-accent)' }} />
            Operational Insights
          </h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-muted)' }}>
            {data.monthLabel} &middot; Day {daysElapsed} of {daysInMonth} &middot; {daysRemaining} days remaining
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DownloadButton onClick={() => setDownloadOpen(true)} />
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold"
            style={{
              background: ragTone.soft,
              color: ragTone.fg,
              border: `1px solid ${ragTone.border}`,
            }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: ragTone.fg, boxShadow: `0 0 6px ${ragTone.fg}` }}
            />
            {RAG_LABEL[combined.rag] || 'No Target'}
          </div>
        </div>
      </div>

      <InsightDownloadPanel
        open={downloadOpen}
        onClose={() => setDownloadOpen(false)}
        data={data}
        clientName={clientName}
      />

      {/* Combined Overview Bar */}
      {combined.targetRevenue > 0 && (
        <div className="mt-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium" style={{ color: 'var(--mt-text-muted)' }}>
              Combined Revenue Progress
            </span>
            <span className="text-xs mt-num" style={{ color: 'var(--mt-text-faint)' }}>
              {formatINR(combined.mtdRevenue)} / {formatINR(combined.targetRevenue)}
            </span>
          </div>
          <div
            className="relative h-5 rounded-full overflow-hidden"
            style={{ background: 'var(--mt-bg-muted)' }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-all"
              style={{
                width: `${Math.min((combined.mtdRevenue / combined.targetRevenue) * 100, 100)}%`,
                background: `linear-gradient(90deg, ${TONES.accent.fg}, ${TONES.accent.fg}dd)`,
              }}
            />
            {combined.projectedRevenue > 0 && (
              <div
                className="absolute top-0 bottom-0 w-0.5"
                style={{
                  left: `${Math.min((combined.projectedRevenue / combined.targetRevenue) * 100, 100)}%`,
                  background: 'var(--mt-text-heading)',
                  opacity: 0.55,
                }}
                title={`Projected: ${formatINR(combined.projectedRevenue)}`}
              />
            )}
          </div>
          <div className="flex justify-between mt-1.5 text-[10px] mt-num" style={{ color: 'var(--mt-text-faint)' }}>
            <span>MTD: {Math.round((combined.mtdRevenue / combined.targetRevenue) * 100)}%</span>
            <span>
              Projected: {formatINR(combined.projectedRevenue)} (
              {Math.round((combined.projectedRevenue / combined.targetRevenue) * 100)}%)
            </span>
          </div>
        </div>
      )}

      {/* Unified KPI Grid — 4 columns: Clinic categories + Pharmacy */}
      {(() => {
        const clinicStream = streams.find(s => s.name.toLowerCase().includes('clinic'));
        const pharmacyStream = streams.find(s => s.name.toLowerCase().includes('pharma'));
        const clinicCats = clinicStream
          ? ([...new Set(clinicStream.cards.map(c => c.category).filter(Boolean))] as string[])
          : [];
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {clinicCats.map(cat => (
              <div key={cat} className="space-y-2">
                <div
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--mt-text-muted)' }}
                >
                  {cat}
                </div>
                {clinicStream!.cards.filter(c => c.category === cat).map(card => (
                  <PaceCard key={card.label} card={card} />
                ))}
              </div>
            ))}
            {pharmacyStream && (
              <div className="space-y-2">
                <div
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--mt-text-muted)' }}
                >
                  Pharmacy
                </div>
                {pharmacyStream.cards.map(card => (
                  <PaceCard key={card.label} card={card} />
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Per-stream Weekly + Chart */}
      {streams.map(stream => (
        <StreamSection
          key={stream.streamId}
          stream={stream}
          dailyTargetLine={dailyTargetLine}
        />
      ))}

      {/* Action Items */}
      {actions.length > 0 && (
        <div className="space-y-2">
          <h2 className="mt-heading text-sm" style={{ color: 'var(--mt-text-heading)' }}>Action Items</h2>
          {actions.map((a, i) => {
            const t =
              a.severity === 'RED' ? TONES.danger :
              a.severity === 'AMBER' ? TONES.amber :
              TONES.blue;
            const Icon = a.severity === 'RED' || a.severity === 'AMBER' ? AlertTriangle : Info;
            return (
              <div
                key={i}
                className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-xs"
                style={{
                  background: t.soft,
                  border: `1px solid ${t.border}`,
                  color: t.fg,
                }}
              >
                <Icon size={14} className="mt-0.5 shrink-0" />
                <span>{a.message}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StreamSection({ stream, dailyTargetLine }: {
  stream: StreamData; dailyTargetLine: number;
}) {
  const isClinic = stream.name.toLowerCase().includes('clinic');
  const StreamIcon = isClinic ? Users : ShoppingBag;

  return (
    <div className="space-y-3">
      <h2
        className="mt-heading text-sm flex items-center gap-2"
        style={{ color: 'var(--mt-text-heading)' }}
      >
        <StreamIcon size={16} style={{ color: 'var(--mt-accent)' }} />
        {stream.name}
      </h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <WeeklyComparison stream={stream} isClinic={isClinic} />
        <DailyChart stream={stream} isClinic={isClinic} dailyTargetLine={dailyTargetLine} />
      </div>
    </div>
  );
}

function PaceCard({ card }: { card: CardData }) {
  const pct = card.target > 0 ? (card.mtd / card.target) * 100 : 0;
  const gapPositive = card.requiredRate <= card.dailyRate;
  const ragTone = RAG_TONE[card.rag] || RAG_TONE.GREY;

  return (
    <div className="mt-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] font-medium uppercase tracking-wider"
          style={{ color: 'var(--mt-text-muted)' }}
        >
          {card.label}
        </span>
        {card.rag !== 'GREY' && (
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: ragTone.fg, boxShadow: `0 0 6px ${ragTone.fg}` }}
          />
        )}
        {card.rag === 'GREY' && card.lastMonthMtd > 0 && (
          <TrendBadge current={card.mtd} previous={card.lastMonthMtd} />
        )}
      </div>
      <div
        className="text-xl font-bold mt-num"
        style={{ color: 'var(--mt-text-heading)' }}
      >
        {fmtVal(card.mtd, card.unit)}
      </div>
      {card.target > 0 && card.unit !== 'percent' && (
        <>
          <div className="flex items-center justify-between text-[10px]">
            <span style={{ color: 'var(--mt-text-faint)' }}>
              Target: <span className="mt-num">{fmtVal(card.target, card.unit)}</span>
            </span>
            <TrendBadge current={card.mtd} previous={card.lastMonthMtd} />
          </div>
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ background: 'var(--mt-bg-muted)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(pct, 100)}%`,
                background: ragTone.fg,
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-1 text-[10px]">
            <div>
              <div style={{ color: 'var(--mt-text-muted)' }}>Pace</div>
              <div className="mt-num" style={{ color: 'var(--mt-text-secondary)' }}>
                {fmtVal(card.dailyRate, card.unit)}/day
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--mt-text-muted)' }}>Need</div>
              <div
                className="mt-num"
                style={{ color: gapPositive ? TONES.accent.fg : TONES.amber.fg }}
              >
                {fmtVal(card.requiredRate, card.unit)}/day
              </div>
            </div>
          </div>
        </>
      )}
      {card.target > 0 && card.unit === 'percent' && (
        <div className="flex items-center justify-between text-[10px]">
          <span style={{ color: 'var(--mt-text-faint)' }}>
            Forecast: <span className="mt-num">{card.target}%</span>
          </span>
          <VariationBadge actual={card.mtd} forecast={card.target} />
        </div>
      )}
      {card.target === 0 && card.unit !== 'percent' && (
        <div className="grid grid-cols-2 gap-1 text-[10px]">
          <div>
            <div style={{ color: 'var(--mt-text-muted)' }}>Pace</div>
            <div className="mt-num" style={{ color: 'var(--mt-text-secondary)' }}>
              {fmtVal(card.dailyRate, card.unit)}/day
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--mt-text-muted)' }}>Projected</div>
            <div className="mt-num" style={{ color: 'var(--mt-text-secondary)' }}>
              {fmtVal(card.projected, card.unit)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WeeklyComparison({ stream, isClinic }: { stream: StreamData; isClinic: boolean }) {
  const tw = stream.thisWeek;
  const lw = stream.lastWeek;

  const rows = isClinic ? [
    { label: 'Patients', cur: tw.patients, prev: lw.patients, unit: 'count' as const },
    { label: 'Revenue', cur: tw.revenue, prev: lw.revenue, unit: 'currency' as const },
    { label: 'Avg Ticket', cur: tw.avgTicket, prev: lw.avgTicket, unit: 'currency' as const },
  ] : [
    { label: 'Transactions', cur: tw.transactions, prev: lw.transactions, unit: 'count' as const },
    { label: 'Sales', cur: tw.revenue, prev: lw.revenue, unit: 'currency' as const },
    { label: 'Profit', cur: tw.profit, prev: lw.profit, unit: 'currency' as const },
    { label: 'Avg Ticket', cur: tw.avgTicket, prev: lw.avgTicket, unit: 'currency' as const },
  ];

  return (
    <div className="mt-card p-3">
      <h3
        className="text-xs font-semibold mb-2"
        style={{ color: 'var(--mt-text-muted)' }}
      >
        This Week vs Last Week
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr
            className="text-[10px] uppercase"
            style={{ color: 'var(--mt-text-faint)' }}
          >
            <th className="text-left py-1 font-medium">Metric</th>
            <th className="text-right py-1 font-medium">This Week</th>
            <th className="text-right py-1 font-medium">Last Week</th>
            <th className="text-right py-1 font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const delta = r.prev > 0 ? ((r.cur - r.prev) / r.prev) * 100 : 0;
            const up = delta >= 0;
            return (
              <tr
                key={r.label}
                style={{ borderTop: '1px solid var(--mt-border)' }}
              >
                <td className="py-1.5" style={{ color: 'var(--mt-text-secondary)' }}>
                  {r.label}
                </td>
                <td
                  className="py-1.5 text-right font-medium mt-num"
                  style={{ color: 'var(--mt-text-heading)' }}
                >
                  {fmtVal(r.cur, r.unit)}
                </td>
                <td
                  className="py-1.5 text-right mt-num"
                  style={{ color: 'var(--mt-text-faint)' }}
                >
                  {fmtVal(r.prev, r.unit)}
                </td>
                <td className="py-1.5 text-right">
                  {r.prev > 0 ? (
                    <span
                      className="inline-flex items-center gap-0.5 mt-num"
                      style={{ color: up ? TONES.accent.fg : TONES.danger.fg }}
                    >
                      {up ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                      {Math.abs(Math.round(delta))}%
                    </span>
                  ) : (
                    <Minus size={10} className="ml-auto" style={{ color: 'var(--mt-text-faint)' }} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DailyChart({ stream, isClinic }: { stream: StreamData; isClinic: boolean; dailyTargetLine: number }) {
  const chartData = stream.daily.map(d => ({
    date: d.date.slice(8, 10),
    [isClinic ? 'Patients' : 'Revenue']: isClinic ? (d.patients || 0) : d.revenue,
  }));

  const dataKey = isClinic ? 'Patients' : 'Revenue';
  const barColor = isClinic ? TONES.accent.fg : TONES.blue.fg;

  return (
    <div className="mt-card p-3">
      <h3
        className="text-xs font-semibold mb-2"
        style={{ color: 'var(--mt-text-muted)' }}
      >
        Daily {isClinic ? 'Patients' : 'Revenue'} — {stream.name}
      </h3>
      {chartData.length === 0 ? (
        <div
          className="text-xs text-center py-6"
          style={{ color: 'var(--mt-text-faint)' }}
        >
          No daily data yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -15 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--mt-border)"
            />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--mt-text-faint)' }} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--mt-text-faint)' }} />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--mt-bg-raised)',
                border: '1px solid var(--mt-border)',
                borderRadius: '10px',
                fontSize: '11px',
                boxShadow: 'var(--mt-shadow-pop)',
              }}
              labelStyle={{ color: 'var(--mt-text-muted)' }}
              itemStyle={{ color: 'var(--mt-text-primary)' }}
              formatter={(value: number) => isClinic ? formatNumber(value) : formatINR(value)}
            />
            <Bar dataKey={dataKey} fill={barColor} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
