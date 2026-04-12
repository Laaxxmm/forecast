import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import api from '../api/client';
import { formatINR, formatNumber, ragColor } from '../utils/format';
import {
  Activity, TrendingUp, TrendingDown, Users, ShoppingBag, Target,
  AlertTriangle, Info, ArrowUp, ArrowDown, Minus,
} from 'lucide-react';

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

const RAG_DOT: Record<string, string> = {
  GREEN: 'bg-emerald-400', AMBER: 'bg-amber-400', RED: 'bg-red-400', GREY: 'bg-zinc-500',
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
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded ${up ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>
      {up ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
      {Math.abs(Math.round(pct))}%
    </span>
  );
}

export default function OperationalInsightsPage() {
  const [data, setData] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/operational-insights')
      .then(r => { setData(r.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin" />
    </div>
  );

  if (!data || data.streams.length === 0) return (
    <div className="p-6 text-center text-theme-muted">No data available. Import actuals to see insights.</div>
  );

  const { streams, combined, actions, daysElapsed, daysInMonth, daysRemaining } = data;
  const dailyTargetLine = combined.targetRevenue > 0 ? Math.round(combined.targetRevenue / daysInMonth) : 0;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-theme-primary flex items-center gap-2">
            <Activity size={20} className="text-accent-400" />
            Operational Insights
          </h1>
          <p className="text-xs text-theme-muted mt-0.5">
            {data.monthLabel} &middot; Day {daysElapsed} of {daysInMonth} &middot; {daysRemaining} days remaining
          </p>
        </div>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold ${ragColor(combined.rag)}`}>
          <span className={`w-2 h-2 rounded-full ${RAG_DOT[combined.rag]}`} />
          {combined.rag === 'GREEN' ? 'On Track' : combined.rag === 'AMBER' ? 'Needs Attention' : combined.rag === 'RED' ? 'Behind Target' : 'No Target'}
        </div>
      </div>

      {/* Combined Overview Bar */}
      {combined.targetRevenue > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-theme-muted">Combined Revenue Progress</span>
            <span className="text-xs text-theme-faint">
              {formatINR(combined.mtdRevenue)} / {formatINR(combined.targetRevenue)}
            </span>
          </div>
          <div className="relative h-5 bg-dark-600 rounded-full overflow-hidden">
            {/* Actual fill */}
            <div
              className="absolute inset-y-0 left-0 bg-accent-500/70 rounded-full transition-all"
              style={{ width: `${Math.min((combined.mtdRevenue / combined.targetRevenue) * 100, 100)}%` }}
            />
            {/* Projected marker */}
            {combined.projectedRevenue > 0 && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-white/60"
                style={{ left: `${Math.min((combined.projectedRevenue / combined.targetRevenue) * 100, 100)}%` }}
                title={`Projected: ${formatINR(combined.projectedRevenue)}`}
              />
            )}
          </div>
          <div className="flex justify-between mt-1.5 text-[10px] text-theme-faint">
            <span>MTD: {Math.round((combined.mtdRevenue / combined.targetRevenue) * 100)}%</span>
            <span>Projected: {formatINR(combined.projectedRevenue)} ({Math.round((combined.projectedRevenue / combined.targetRevenue) * 100)}%)</span>
          </div>
        </div>
      )}

      {/* Stream Sections */}
      {streams.map(stream => (
        <StreamSection key={stream.streamId} stream={stream} daysInMonth={daysInMonth} daysElapsed={daysElapsed} daysRemaining={daysRemaining} dailyTargetLine={dailyTargetLine} />
      ))}

      {/* Action Items */}
      {actions.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-theme-primary">Action Items</h2>
          {actions.map((a, i) => (
            <div key={i} className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-xs ${
              a.severity === 'RED' ? 'bg-red-500/5 border-red-500/20 text-red-300' :
              a.severity === 'AMBER' ? 'bg-amber-500/5 border-amber-500/20 text-amber-300' :
              'bg-blue-500/5 border-blue-500/20 text-blue-300'
            }`}>
              {a.severity === 'RED' ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> :
               a.severity === 'AMBER' ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> :
               <Info size={14} className="mt-0.5 shrink-0" />}
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StreamSection({ stream, daysInMonth, daysElapsed, daysRemaining, dailyTargetLine }: {
  stream: StreamData; daysInMonth: number; daysElapsed: number; daysRemaining: number; dailyTargetLine: number;
}) {
  const isClinic = stream.name.toLowerCase().includes('clinic');
  const StreamIcon = isClinic ? Users : ShoppingBag;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-theme-primary flex items-center gap-2">
        <StreamIcon size={16} className="text-accent-400" />
        {stream.name}
      </h2>

      {/* KPI Cards */}
      {isClinic ? (
        // Group clinic cards by category: 2 cards per row (Patients + Revenue)
        (() => {
          const categories = [...new Set(stream.cards.map(c => c.category).filter(Boolean))] as string[];
          return (
            <div className="space-y-3">
              {categories.map(cat => (
                <div key={cat}>
                  <div className="text-[11px] font-medium text-theme-muted uppercase tracking-wider mb-1.5">{cat}</div>
                  <div className="grid grid-cols-2 gap-3">
                    {stream.cards.filter(c => c.category === cat).map(card => (
                      <PaceCard key={card.label} card={card} daysInMonth={daysInMonth} daysElapsed={daysElapsed} daysRemaining={daysRemaining} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        })()
      ) : (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          {stream.cards.map(card => (
            <PaceCard key={card.label} card={card} daysInMonth={daysInMonth} daysElapsed={daysElapsed} daysRemaining={daysRemaining} />
          ))}
        </div>
      )}

      {/* Weekly + Chart Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <WeeklyComparison stream={stream} isClinic={isClinic} />
        <DailyChart stream={stream} isClinic={isClinic} dailyTargetLine={dailyTargetLine} />
      </div>
    </div>
  );
}

function PaceCard({ card, daysInMonth, daysElapsed, daysRemaining }: {
  card: CardData; daysInMonth: number; daysElapsed: number; daysRemaining: number;
}) {
  const pct = card.target > 0 ? (card.mtd / card.target) * 100 : 0;
  const gapPositive = card.requiredRate <= card.dailyRate;

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-theme-muted uppercase tracking-wider">{card.label}</span>
        {card.rag !== 'GREY' && <span className={`w-2 h-2 rounded-full ${RAG_DOT[card.rag]}`} />}
        {card.rag === 'GREY' && card.lastMonthMtd > 0 && <TrendBadge current={card.mtd} previous={card.lastMonthMtd} />}
      </div>
      <div className="text-xl font-bold text-theme-primary">{fmtVal(card.mtd, card.unit)}</div>
      {card.target > 0 && (
        <>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-theme-faint">Target: {fmtVal(card.target, card.unit)}</span>
            <TrendBadge current={card.mtd} previous={card.lastMonthMtd} />
          </div>
          {/* Mini progress bar */}
          <div className="h-1.5 bg-dark-600 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${card.rag === 'GREEN' ? 'bg-emerald-500' : card.rag === 'AMBER' ? 'bg-amber-500' : 'bg-red-500'}`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-1 text-[10px] text-theme-faint">
            <div>
              <div className="text-theme-muted">Pace</div>
              <div>{fmtVal(card.dailyRate, card.unit)}/day</div>
            </div>
            <div>
              <div className="text-theme-muted">Need</div>
              <div className={gapPositive ? 'text-emerald-400' : 'text-amber-400'}>{fmtVal(card.requiredRate, card.unit)}/day</div>
            </div>
          </div>
        </>
      )}
      {card.target === 0 && card.unit !== 'percent' && (
        <div className="grid grid-cols-2 gap-1 text-[10px] text-theme-faint">
          <div>
            <div className="text-theme-muted">Pace</div>
            <div>{fmtVal(card.dailyRate, card.unit)}/day</div>
          </div>
          <div>
            <div className="text-theme-muted">Projected</div>
            <div>{fmtVal(card.projected, card.unit)}</div>
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
    <div className="card p-3">
      <h3 className="text-xs font-semibold text-theme-muted mb-2">This Week vs Last Week</h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] text-theme-faint uppercase">
            <th className="text-left py-1 font-medium">Metric</th>
            <th className="text-right py-1 font-medium">This Week</th>
            <th className="text-right py-1 font-medium">Last Week</th>
            <th className="text-right py-1 font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const delta = r.prev > 0 ? ((r.cur - r.prev) / r.prev) * 100 : 0;
            return (
              <tr key={r.label} className="border-t border-dark-600">
                <td className="py-1.5 text-theme-secondary">{r.label}</td>
                <td className="py-1.5 text-right text-theme-primary font-medium">{fmtVal(r.cur, r.unit)}</td>
                <td className="py-1.5 text-right text-theme-faint">{fmtVal(r.prev, r.unit)}</td>
                <td className="py-1.5 text-right">
                  {r.prev > 0 ? (
                    <span className={`inline-flex items-center gap-0.5 ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {delta >= 0 ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                      {Math.abs(Math.round(delta))}%
                    </span>
                  ) : <Minus size={10} className="text-theme-faint ml-auto" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DailyChart({ stream, isClinic, dailyTargetLine }: { stream: StreamData; isClinic: boolean; dailyTargetLine: number }) {
  const chartData = stream.daily.map(d => ({
    date: d.date.slice(8, 10),  // day number
    [isClinic ? 'Patients' : 'Revenue']: isClinic ? (d.patients || 0) : d.revenue,
  }));

  const dataKey = isClinic ? 'Patients' : 'Revenue';
  const barColor = isClinic ? '#10b981' : '#3b82f6';

  // Compute stream-specific daily target
  const streamTarget = stream.cards.find(c => c.label === 'Revenue' || c.label === 'Sales')?.target || 0;
  const streamDailyTarget = streamTarget > 0 ? Math.round(streamTarget / (chartData.length > 0 ? chartData.length + 5 : 30)) : 0;

  return (
    <div className="card p-3">
      <h3 className="text-xs font-semibold text-theme-muted mb-2">
        Daily {isClinic ? 'Patients' : 'Revenue'} — {stream.name}
      </h3>
      {chartData.length === 0 ? (
        <div className="text-xs text-theme-faint text-center py-6">No daily data yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -15 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} />
            <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a3d', borderRadius: '8px', fontSize: '11px' }}
              labelStyle={{ color: '#9ca3af' }}
              formatter={(value: number) => isClinic ? formatNumber(value) : formatINR(value)}
            />
            <Bar dataKey={dataKey} fill={barColor} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
