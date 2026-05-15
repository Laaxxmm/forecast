import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatINR, formatNumber } from '../../utils/format';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, ReferenceLine,
} from 'recharts';
import {
  UtensilsCrossed, Truck, ShoppingBag, ChefHat,
  IndianRupee, ReceiptText, Tag, AlertTriangle, TrendingDown, Users,
} from 'lucide-react';

interface RestaurantAnalyticsProps {
  isVisible: (key: string) => boolean;
  startMonth?: string | null;
  endMonth?: string | null;
}

// ─── Types matching /dashboard/restaurant-analytics payload ──────────────────

interface Channel  { channel: string; revenue: number; orders: number; atv: number; gross_revenue: number; discount: number; tax: number; items_sold: number; covers: number; }
interface DailyDay { date: string; revenue: number; orders: number; dow: number; is_weekend: boolean; is_closed: boolean; }
interface Payment  { method: string; revenue: number; orders: number; pct: number; }
interface Hour     { hour: number; revenue: number; daypart: 'morning'|'lunch'|'dinner'; }
interface Item     { item: string; revenue: number; orders: number; qty: number; pct: number; }
interface Category { category: string; revenue: number; orders: number; pct: number; }
interface Server   { server: string; revenue: number; orders: number; atv: number; }

interface RestaurantData {
  hasData: boolean;
  fy?: { id: number; label: string; start: string; end: string };
  period?: { start: string; end: string; daysWithData: number; totalDays: number };
  totals?: {
    revenue: number; orders: number; atv: number; itemsPerOrder: number;
    dailyAvg: number; discount: number; tax: number; gross_revenue: number; items_sold: number;
    aggregatorRevenue: number; aggregatorCommissionEstimate: number; aggregatorRevenuePct: number;
  };
  byChannel?: Channel[];
  daily?: DailyDay[];
  byPayment?: Payment[];
  byHour?: Hour[];
  topItems?: Item[];
  categories?: Category[];
  servers?: Server[];
  peaks?: {
    peakDay: DailyDay; worstDay: DailyDay; peakHour: Hour;
    dowAvg: { dow: number; avg: number }[];
    daypartPct: { morning: number; lunch: number; dinner: number };
    digitalPct: number; cashPct: number;
    topItemConcentration: number; top5Concentration: number;
  };
}

// ─── Formatting + palette ────────────────────────────────────────────────────

const formatLakhs = (n: number) => `₹${(n / 100000).toFixed(n >= 1000000 ? 1 : 2)}L`;
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const COLOR = {
  green:  { mid: '#1D9E75', dark: '#04342C', light: '#E1F5EE', deeper: '#0F6E56' },
  blue:   { mid: '#185FA5', dark: '#042C53', light: '#E6F1FB' },
  purple: { mid: '#7F77DD', dark: '#534AB7', light: '#EEEDFE' },
  amber:  { mid: '#BA7517', dark: '#412402', light: '#FAEEDA', deeper: '#854F0B' },
  red:    { mid: '#A32D2D', dark: '#501313', light: '#FCEBEB', deeper: '#791F1F' },
  gray:   { mid: '#94a3b8', dark: '#475569', light: '#f1f5f9' },
};

const CHART_TOOLTIP = {
  backgroundColor: '#14141f',
  border: '1px solid #2a2a3d',
  borderRadius: '8px',
  fontSize: '12px',
  padding: '8px 10px',
};

// Format date label for chart x-axis: "5" or "5 Apr" depending on density
const dayLabel = (iso: string) => parseInt(iso.slice(8, 10), 10).toString();
const fullDate = (iso: string) => {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
};

// Channel → icon palette (existing convention)
const CHANNEL_PALETTE: Record<string, { hex: string; icon: any }> = {
  'Dine-in':  { hex: COLOR.green.mid,  icon: UtensilsCrossed },
  'Delivery': { hex: COLOR.purple.mid, icon: Truck },
  'Takeaway': { hex: COLOR.amber.mid,  icon: ShoppingBag },
  'Catering': { hex: COLOR.blue.mid,   icon: ChefHat },
};

// Payment method → palette
const PAYMENT_COLOR = (method: string): string => {
  const m = method.toLowerCase();
  if (m.includes('upi') && !m.includes('other')) return COLOR.green.mid;
  if (m.includes('online'))                       return COLOR.purple.mid;
  if (m.includes('card'))                         return COLOR.blue.mid;
  if (m.includes('other'))                        return COLOR.amber.mid;
  if (m.includes('cash'))                         return COLOR.gray.mid;
  return COLOR.gray.dark;
};

// Category → emoji (spec-suggested set, with extra Kerala-cuisine matches)
const categoryEmoji = (name: string): string => {
  const n = (name || '').toLowerCase();
  if (n.includes('sea food') || n.includes('seafood') || n.includes('fish')) return '🐟';
  if (n.includes('chicken') || n.includes('poultry'))                        return '🍗';
  if (n.includes('beef') || n.includes('mutton') || n.includes('lamb'))      return '🥩';
  if (n.includes('bread') || n.includes('parotta') || n.includes('naan')
      || n.includes('appam') || n.includes('roti'))                          return '🫓';
  if (n.includes('rice'))                                                    return '🍚';
  if (n.includes('palaharam') || n.includes('drink') || n.includes('juice')
      || n.includes('lime') || n.includes('shake') || n.includes('beverage'))return '🍹';
  if (n.includes('combo'))                                                   return '🍱';
  if (n.includes('veg'))                                                     return '🥘';
  return '🍽️';
};

// ─── Narrative composition ───────────────────────────────────────────────────
// Builds 2-3 sentences from actual data, never hardcoded. Order: day-of-week
// pattern → daypart pattern → top-item concentration. Bold key numbers with
// font-weight 500 (handled via <b> in the rendering).

function composeNarrative(data: RestaurantData): { lines: string[] } | null {
  if (!data.peaks || !data.totals || !data.topItems?.length) return null;
  const { dowAvg, daypartPct, topItemConcentration } = data.peaks;
  const lines: string[] = [];

  // 1. Day-of-week variance — describe the peak vs trough day.
  if (dowAvg.length >= 2) {
    const peak  = dowAvg[0];
    const trough = dowAvg[dowAvg.length - 1];
    if (peak.avg > 0 && trough.avg > 0) {
      const ratio = peak.avg / trough.avg;
      if (ratio >= 1.5) {
        lines.push(
          `${WEEKDAY_LONG[peak.dow]}s drive ${ratio.toFixed(1)}× ` +
          `${WEEKDAY_LONG[trough.dow]} revenue (<b>${formatLakhs(peak.avg)}</b> vs ` +
          `<b>${formatLakhs(trough.avg)}</b>).`
        );
      }
    }
  }

  // 2. Daypart pattern — call out whichever is dominant.
  if (daypartPct.lunch > daypartPct.dinner && daypartPct.lunch >= 40) {
    lines.push(`Lunch carries <b>${daypartPct.lunch.toFixed(0)}%</b> of revenue — dinner is ${daypartPct.dinner.toFixed(0)}%.`);
  } else if (daypartPct.dinner > daypartPct.lunch && daypartPct.dinner >= 40) {
    lines.push(`Dinner carries <b>${daypartPct.dinner.toFixed(0)}%</b> of revenue — lunch is ${daypartPct.lunch.toFixed(0)}%.`);
  }

  // 3. Top-item concentration risk if the #1 item is ≥10% of revenue.
  if (topItemConcentration >= 10 && data.topItems[0]) {
    const top = data.topItems[0];
    lines.push(
      `<b>${top.item}</b> alone contributes <b>${formatLakhs(top.revenue)}</b> ` +
      `(${topItemConcentration.toFixed(0)}% of revenue) — concentration risk.`
    );
  }

  return lines.length > 0 ? { lines } : null;
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function RestaurantAnalytics({ isVisible, startMonth, endMonth }: RestaurantAnalyticsProps) {
  const [data, setData] = useState<RestaurantData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (startMonth) params.startMonth = startMonth;
    if (endMonth)   params.endMonth   = endMonth;

    const ctl = new AbortController();
    setLoading(true);
    api.get('/dashboard/restaurant-analytics', { params, signal: ctl.signal }).then(res => {
      if (ctl.signal.aborted) return;
      setData(res.data);
      setLoading(false);
    }).catch(() => {
      if (ctl.signal.aborted) return;
      setLoading(false);
    });
    return () => ctl.abort();
  }, [startMonth, endMonth]);

  if (loading) return (
    <div className="text-center py-6">
      <div className="w-5 h-5 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mx-auto" />
    </div>
  );

  if (!data?.hasData) return (
    <div className="mt-5">
      <SectionHeader />
      <div
        className="rounded-xl px-4 py-6 text-center"
        style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
      >
        <UtensilsCrossed size={28} className="mx-auto mb-2" style={{ color: 'var(--mt-text-faint)' }} />
        <p className="text-theme-heading text-sm font-medium">No Petpooja data for this period yet</p>
        <p className="text-theme-faint text-xs mt-1.5 max-w-md mx-auto leading-relaxed">
          Head to <b>Import Data</b> and upload the
          <i> Item Report With Customer/Order Details</i> export to populate
          this dashboard.
        </p>
      </div>
    </div>
  );

  const totals   = data.totals!;
  const peaks    = data.peaks!;
  const period   = data.period!;
  const daily    = data.daily || [];
  const byChannel= data.byChannel || [];
  const byPayment= data.byPayment || [];
  const byHour   = data.byHour || [];
  const topItems = data.topItems || [];
  const categories = data.categories || [];
  const servers  = data.servers || [];
  const narrative = composeNarrative(data);

  // Avg items per order — bill-line grain / unique bill count
  const itemsPerOrder = totals.itemsPerOrder || 0;

  return (
    <div className="mt-5 space-y-5">
      <SectionHeader />

      {/* ── 1. KPI strip (4 cards) ───────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {isVisible('restaurant_total_revenue') && (
          <KpiCard
            label="Revenue"
            value={formatLakhs(totals.revenue)}
            sub={`${formatNumber(totals.orders)} orders · ${period.daysWithData} days`}
          />
        )}
        {isVisible('restaurant_avg_ticket') && (
          <KpiCard
            label="Avg ticket"
            value={`₹${Math.round(totals.atv).toLocaleString('en-IN')}`}
            sub={`${itemsPerOrder.toFixed(1)} items per order`}
          />
        )}
        {isVisible('restaurant_total_orders') && (
          <KpiCard
            label="Daily average"
            value={formatLakhs(totals.dailyAvg)}
            sub={`${Math.round(totals.orders / Math.max(period.daysWithData, 1))} orders / day`}
          />
        )}
        {/* Commission KPI — red-tinted, the differentiated card per the spec.
            Calculated as 25% × Delivery channel revenue (proxy: Petpooja's
            Area column would let us split Swiggy/Zomato precisely; using
            spec's recommended approximation until Area is parsed). */}
        {isVisible('restaurant_gross_discount') && (
          <CommissionCard
            value={formatLakhs(totals.aggregatorCommissionEstimate)}
            pct={totals.aggregatorRevenuePct}
            zero={totals.aggregatorRevenue === 0}
          />
        )}
      </div>

      {/* ── 2. Narrative callout ─────────────────────────────────────── */}
      {narrative && (
        <div
          className="rounded-xl px-4 py-3"
          style={{
            background: COLOR.amber.light,
            borderLeft: `4px solid ${COLOR.amber.mid}`,
            paddingLeft: 16,
          }}
        >
          <p
            className="text-[11px] uppercase tracking-[0.5px] mb-1.5"
            style={{ color: COLOR.amber.mid, fontWeight: 500 }}
          >
            What this month says
          </p>
          <p
            className="text-[13px] leading-relaxed"
            style={{ color: COLOR.amber.dark, fontWeight: 400 }}
            dangerouslySetInnerHTML={{ __html: narrative.lines.join(' ') }}
          />
        </div>
      )}

      {/* ── 3. Daily revenue chart ───────────────────────────────────── */}
      <Panel>
        <div className="flex items-baseline justify-between mb-1">
          <div>
            <h3 className="text-base font-medium text-theme-heading">
              Daily revenue · {periodLabel(period)}
            </h3>
            <p className="text-[13px] text-theme-faint mt-0.5">
              {peakWeekdayInsight(peaks.dowAvg)}
            </p>
          </div>
          {peaks.peakDay && (
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wider text-theme-faint">Peak</p>
              <p className="text-sm font-medium text-theme-heading">
                {formatLakhs(peaks.peakDay.revenue)}
                <span className="text-[11px] text-theme-faint ml-1.5">
                  · {fullDate(peaks.peakDay.date)} ({WEEKDAY_SHORT[peaks.peakDay.dow]})
                </span>
              </p>
            </div>
          )}
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={daily} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              interval={Math.max(0, Math.floor(daily.length / 8) - 1)}
              tickFormatter={dayLabel}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `₹${(v / 100000).toFixed(0)}L`}
            />
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              labelFormatter={(label: string) => `${fullDate(label)} · ${WEEKDAY_LONG[new Date(label + 'T00:00:00Z').getUTCDay()]}`}
              formatter={(v: number) => [formatINR(v), 'Revenue']}
            />
            <ReferenceLine
              y={totals.dailyAvg}
              stroke={COLOR.amber.mid}
              strokeDasharray="3 3"
              label={{ value: 'Daily avg', fontSize: 10, fill: COLOR.amber.deeper, position: 'right' }}
            />
            <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
              {daily.map((d) => (
                <Cell
                  key={d.date}
                  fill={
                    d.is_closed                                       ? COLOR.gray.light :
                    peaks.worstDay && d.date === peaks.worstDay.date ? COLOR.red.mid    :
                    d.is_weekend                                      ? COLOR.green.mid  :
                    COLOR.blue.mid
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        {/* Legend */}
        <div className="flex items-center gap-4 text-[11px] text-theme-faint mt-2">
          <Swatch color={COLOR.green.mid} label={`Sat / Sun · avg ${formatLakhs(weekendAvg(daily))}`} />
          <Swatch color={COLOR.blue.mid}  label={`Weekday · avg ${formatLakhs(weekdayAvg(daily))}`} />
          {peaks.worstDay && (
            <Swatch color={COLOR.red.mid} label={`Worst day · ${fullDate(peaks.worstDay.date)} (${formatLakhs(peaks.worstDay.revenue)})`} />
          )}
        </div>
      </Panel>

      {/* ── 4. Channel donut + Payment bars (2 cols) ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel>
          <h3 className="text-base font-medium text-theme-heading mb-0.5">Where revenue comes from</h3>
          <p className="text-[13px] text-theme-faint mb-3">Channel mix and Average Order Value</p>
          <div className="flex items-center gap-4">
            <ResponsiveContainer width={150} height={150}>
              <PieChart>
                <Pie
                  data={byChannel.map(c => ({ name: c.channel, value: c.revenue }))}
                  innerRadius={40}
                  outerRadius={65}
                  paddingAngle={2}
                  dataKey="value"
                  stroke="none"
                >
                  {byChannel.map((c, i) => (
                    <Cell key={i} fill={CHANNEL_PALETTE[c.channel]?.hex || COLOR.gray.mid} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={CHART_TOOLTIP}
                  formatter={(v: number, _n, p: any) => [formatINR(v), p.payload.name]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-2">
              {byChannel.map(c => {
                const palette = CHANNEL_PALETTE[c.channel];
                const Icon = palette?.icon || UtensilsCrossed;
                const share = totals.revenue > 0 ? (c.revenue / totals.revenue) * 100 : 0;
                const isDelivery = c.channel === 'Delivery';
                const commission = isDelivery ? c.revenue * 0.25 : 0;
                return (
                  <div key={c.channel}>
                    <div className="flex items-center gap-2">
                      <Icon size={13} style={{ color: palette?.hex }} />
                      <span className="text-sm text-theme-heading font-medium">{c.channel}</span>
                      <span className="text-[12px] text-theme-faint ml-auto">
                        {formatLakhs(c.revenue)} · {share.toFixed(0)}%
                      </span>
                    </div>
                    <p className="text-[11px] text-theme-faint pl-5">
                      AOV ₹{Math.round(c.atv).toLocaleString('en-IN')}
                      {isDelivery && commission > 0 && ` · ~${formatLakhs(commission)} commission`}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>

        <Panel>
          <h3 className="text-base font-medium text-theme-heading mb-0.5">How customers pay</h3>
          <p className="text-[13px] text-theme-faint mb-3">Payment method breakdown</p>
          <div className="space-y-2.5">
            {byPayment.map(p => (
              <div key={p.method}>
                <div className="flex items-center justify-between text-[13px] mb-1">
                  <span className="text-theme-heading">{p.method}</span>
                  <span className="text-theme-faint">
                    {formatLakhs(p.revenue)} · {p.pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full" style={{ background: 'var(--mt-bg-muted)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(p.pct, 100)}%`,
                      background: PAYMENT_COLOR(p.method),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-theme-faint mt-3 pt-2.5" style={{ borderTop: '0.5px solid var(--mt-border)' }}>
            Digital payments: <b style={{ color: COLOR.green.mid, fontWeight: 500 }}>{peaks.digitalPct.toFixed(1)}%</b>
            {' · '}Cash is only {peaks.cashPct.toFixed(1)}%
          </p>
        </Panel>
      </div>

      {/* ── 5. Hourly revenue chart ──────────────────────────────────── */}
      <Panel>
        <div className="flex items-baseline justify-between mb-1">
          <div>
            <h3 className="text-base font-medium text-theme-heading">Revenue by hour</h3>
            <p className="text-[13px] text-theme-faint mt-0.5">{hourlyInsight(peaks)}</p>
          </div>
          {peaks.peakHour && (
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wider text-theme-faint">Peak hour</p>
              <p className="text-sm font-medium" style={{ color: COLOR.green.deeper }}>
                {formatHour(peaks.peakHour.hour)} · {formatLakhs(peaks.peakHour.revenue)}
              </p>
            </div>
          )}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={byHour} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="hour"
              tick={{ fontSize: 10, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={formatHour}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `₹${(v / 100000).toFixed(0)}L`}
            />
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              labelFormatter={(h: number) => formatHour(h)}
              formatter={(v: number) => [formatINR(v), 'Revenue']}
            />
            <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
              {byHour.map(h => (
                <Cell
                  key={h.hour}
                  fill={
                    h.daypart === 'morning' ? COLOR.purple.mid :
                    h.daypart === 'lunch'   ? COLOR.green.mid  :
                    COLOR.amber.mid
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div className="flex items-center gap-4 text-[11px] text-theme-faint mt-2">
          <Swatch color={COLOR.purple.mid} label={`Morning · ${peaks.daypartPct.morning.toFixed(0)}%`} />
          <Swatch color={COLOR.green.mid}  label={`Lunch (12–4 PM) · ${peaks.daypartPct.lunch.toFixed(0)}%`} />
          <Swatch color={COLOR.amber.mid}  label={`Dinner (6–11 PM) · ${peaks.daypartPct.dinner.toFixed(0)}%`} />
        </div>
      </Panel>

      {/* ── 6. Top items table ───────────────────────────────────────── */}
      <Panel>
        <h3 className="text-base font-medium text-theme-heading mb-0.5">
          Top items · what's actually selling
        </h3>
        <p className="text-[13px] text-theme-faint mb-3">
          Top 5 items = <b>{peaks.top5Concentration.toFixed(0)}%</b> of revenue · Top 10 ={' '}
          <b>{topItems.reduce((s, i) => s + i.pct, 0).toFixed(0)}%</b>
        </p>
        <div className="space-y-1.5">
          {topItems.map((item, idx) => {
            const isTop5 = idx < 5;
            const maxRev = topItems[0]?.revenue || 1;
            return (
              <div key={item.item} className="grid grid-cols-12 gap-2 items-center py-1.5"
                   style={{ borderBottom: idx === topItems.length - 1 ? 'none' : '0.5px solid var(--mt-border)' }}>
                <div className="col-span-5 flex items-center gap-2">
                  <span className="text-[11px] text-theme-faint w-4">{idx + 1}.</span>
                  <span className="text-[13px] text-theme-heading font-medium truncate">{item.item}</span>
                </div>
                <div className="col-span-2 text-right text-[13px] text-theme-heading font-medium">
                  {formatLakhs(item.revenue)}
                </div>
                <div className="col-span-2 text-right text-[12px] text-theme-faint">
                  {formatNumber(item.orders)} orders
                </div>
                <div className="col-span-3">
                  <div className="h-1.5 rounded-full" style={{ background: 'var(--mt-bg-muted)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(item.revenue / maxRev) * 100}%`,
                        background: isTop5 ? COLOR.green.mid : COLOR.blue.mid,
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {peaks.topItemConcentration >= 10 && topItems[0] && (
          <p
            className="text-[12px] mt-3 pt-2.5"
            style={{ borderTop: '0.5px solid var(--mt-border)', color: COLOR.amber.deeper }}
          >
            <AlertTriangle size={12} className="inline -mt-0.5 mr-1" />
            <b style={{ fontWeight: 500 }}>Concentration risk:</b>{' '}
            {topItems[0].item} alone is {formatLakhs(topItems[0].revenue)} ({peaks.topItemConcentration.toFixed(0)}% of revenue) —
            supply or pricing shocks on this single item materially move the P&L.
          </p>
        )}
      </Panel>

      {/* ── 7. Category + Server row ─────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel>
          <h3 className="text-base font-medium text-theme-heading mb-0.5">By category</h3>
          <p className="text-[13px] text-theme-faint mb-3">{categoryInsight(categories)}</p>
          <div>
            {categories.map((c, i) => (
              <div
                key={c.category}
                className="flex items-center justify-between py-1.5"
                style={{ borderBottom: i === categories.length - 1 ? 'none' : '0.5px solid var(--mt-border)' }}
              >
                <div className="flex items-center gap-2.5">
                  <span style={{ fontSize: 16 }}>{categoryEmoji(c.category)}</span>
                  <span className="text-[13px] text-theme-heading">{c.category}</span>
                </div>
                <span className="text-[13px] text-theme-faint">
                  {formatLakhs(c.revenue)} · <b style={{ color: 'var(--mt-text-secondary)', fontWeight: 500 }}>{c.pct.toFixed(0)}%</b>
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <h3 className="text-base font-medium text-theme-heading mb-0.5">Server performance · Dine-in</h3>
          <p className="text-[13px] text-theme-faint mb-3">
            <Users size={12} className="inline -mt-0.5 mr-1" />
            Online-channel system users excluded
          </p>
          {servers.length === 0 ? (
            <p className="text-[12px] text-theme-faint py-3 text-center">
              No dine-in server data for this period.
            </p>
          ) : (
            <div>
              <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wider text-theme-faint pb-1.5 mb-1.5"
                   style={{ borderBottom: '0.5px solid var(--mt-border)' }}>
                <div className="col-span-6">Server</div>
                <div className="col-span-3 text-right">Revenue</div>
                <div className="col-span-3 text-right">AOV</div>
              </div>
              {servers.map(s => (
                <div key={s.server} className="grid grid-cols-12 gap-2 items-center py-1.5">
                  <div className="col-span-6 text-[13px] text-theme-heading font-medium truncate">{s.server}</div>
                  <div className="col-span-3 text-right text-[13px] text-theme-heading">{formatLakhs(s.revenue)}</div>
                  <div className="col-span-3 text-right">
                    <AovPill atv={s.atv} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SectionHeader() {
  return (
    <div className="flex items-center gap-2 mb-3">
      <UtensilsCrossed size={16} className="text-blue-400" />
      <h2 className="text-base font-medium text-theme-heading">Restaurant Analytics</h2>
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400">Petpooja</span>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
    >
      {children}
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Panel>
      <p className="text-[11px] uppercase tracking-[0.5px] text-theme-faint">{label}</p>
      <p className="text-[22px] font-medium text-theme-heading mt-1">{value}</p>
      {sub && <p className="text-[11px] text-theme-faint mt-0.5">{sub}</p>}
    </Panel>
  );
}

function CommissionCard({ value, pct, zero }: { value: string; pct: number; zero: boolean }) {
  if (zero) return (
    <div
      className="rounded-xl p-4"
      style={{ background: COLOR.green.light, border: `0.5px solid ${COLOR.green.mid}33` }}
    >
      <p className="text-[11px] uppercase tracking-[0.5px]" style={{ color: COLOR.green.deeper }}>
        Aggregator commission
      </p>
      <p className="text-[22px] font-medium mt-1" style={{ color: COLOR.green.dark }}>₹0</p>
      <p className="text-[11px] mt-0.5" style={{ color: COLOR.green.deeper }}>
        No aggregator orders this period
      </p>
    </div>
  );
  return (
    <div
      className="rounded-xl p-4"
      style={{ background: COLOR.red.light, border: `0.5px solid ${COLOR.red.mid}33` }}
    >
      <p className="text-[11px] uppercase tracking-[0.5px]" style={{ color: COLOR.red.mid }}>
        Aggregator commission
      </p>
      <p className="text-[22px] font-medium mt-1" style={{ color: COLOR.red.dark }}>{value}</p>
      <p className="text-[11px] mt-0.5" style={{ color: COLOR.red.deeper }}>
        <TrendingDown size={11} className="inline -mt-0.5 mr-0.5" />
        {pct.toFixed(0)}% of revenue routed through Swiggy / Zomato (est. 25% take)
      </p>
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function AovPill({ atv }: { atv: number }) {
  const tone = atv >= 900 ? COLOR.green : atv >= 700 ? COLOR.amber : COLOR.red;
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[11px] font-medium"
      style={{ background: tone.light, color: tone.dark }}
    >
      ₹{Math.round(atv).toLocaleString('en-IN')}
    </span>
  );
}

// ─── Insight helpers (small, pure) ──────────────────────────────────────────

function periodLabel(p: { start: string; end: string }) {
  if (p.start === p.end) {
    const [y, m] = p.start.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    return d.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  return `${p.start} – ${p.end}`;
}

function peakWeekdayInsight(dowAvg: { dow: number; avg: number }[]) {
  if (dowAvg.length < 2) return 'Daily revenue across the period';
  const peak  = dowAvg[0];
  const trough = dowAvg[dowAvg.length - 1];
  if (peak.avg <= 0) return 'Daily revenue across the period';
  return `${WEEKDAY_LONG[peak.dow]}s peak (avg ${formatLakhs(peak.avg)}) · ${WEEKDAY_LONG[trough.dow]}s slowest (avg ${formatLakhs(trough.avg)})`;
}

function hourlyInsight(peaks: any) {
  if (!peaks.peakHour) return 'Revenue by hour of day';
  const peakDaypart =
    peaks.peakHour.daypart === 'lunch'  ? 'Lunch crush' :
    peaks.peakHour.daypart === 'dinner' ? 'Dinner peak' :
    'Morning rush';
  return `${peakDaypart} peaks ${formatHour(peaks.peakHour.hour)} · Lunch ${peaks.daypartPct.lunch.toFixed(0)}% · Dinner ${peaks.daypartPct.dinner.toFixed(0)}%`;
}

function categoryInsight(cats: { category: string; pct: number }[]) {
  if (cats.length < 2) return 'Revenue by category';
  const top2 = cats.slice(0, 2);
  const sum = top2.reduce((s, c) => s + c.pct, 0);
  return `${top2.map(c => c.category).join(' + ')} = ${sum.toFixed(0)}% of revenue`;
}

function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

function weekendAvg(daily: DailyDay[]): number {
  const w = daily.filter(d => !d.is_closed && d.is_weekend);
  if (w.length === 0) return 0;
  return w.reduce((s, d) => s + d.revenue, 0) / w.length;
}

function weekdayAvg(daily: DailyDay[]): number {
  const w = daily.filter(d => !d.is_closed && !d.is_weekend);
  if (w.length === 0) return 0;
  return w.reduce((s, d) => s + d.revenue, 0) / w.length;
}
