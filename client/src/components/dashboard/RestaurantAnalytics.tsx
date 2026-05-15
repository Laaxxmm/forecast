import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatINR, formatNumber } from '../../utils/format';
import { UtensilsCrossed, IndianRupee, ReceiptText, Tag, Truck, ShoppingBag, ChefHat } from 'lucide-react';

interface RestaurantAnalyticsProps {
  isVisible: (key: string) => boolean;
  startMonth?: string | null;
  endMonth?: string | null;
}

interface ChannelRow {
  channel: string;
  orders: number;
  revenue: number;
  gross_revenue: number;
  discount: number;
  tax: number;
  items_sold: number;
  covers: number;
  atv: number;
}

interface RestaurantData {
  hasData: boolean;
  totals?: { revenue: number; orders: number; atv: number; gross_revenue: number; discount: number; tax: number };
  byChannel?: ChannelRow[];
  monthly?: Array<{ month: string; channel: string; orders: number; revenue: number }>;
  period?: { start: string; end: string };
  fy?: { id: number; label: string };
}

// Channel → tile palette. Mirrors the colors picked in industry-templates.ts
// (Dine-in blue, Delivery purple, Catering amber, Takeaway accent/teal) so the
// dashboard reads consistently with the sidebar stream icons.
const CHANNEL_PALETTE: Record<string, { color: string; icon: any }> = {
  'Dine-in':  { color: 'blue',   icon: UtensilsCrossed },
  'Delivery': { color: 'purple', icon: Truck },
  'Takeaway': { color: 'teal',   icon: ShoppingBag },
  'Catering': { color: 'amber',  icon: ChefHat },
};

export default function RestaurantAnalytics({ isVisible, startMonth, endMonth }: RestaurantAnalyticsProps) {
  const [data, setData] = useState<RestaurantData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (startMonth) params.startMonth = startMonth;
    if (endMonth)   params.endMonth   = endMonth;

    // Cancel a prior in-flight fetch when the user switches month — same
    // pattern as ClinicAnalytics to avoid a stale response overwriting fresh
    // data (a slow March fetch resolving after the user picked April).
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

  if (!data?.hasData) return null;

  const { totals, byChannel = [] } = data;
  const totalRev    = totals?.revenue || 0;
  const totalOrders = totals?.orders  || 0;
  const atv         = totals?.atv     || 0;

  // Card-visibility keys live in dashboard_cards (platform DB). Default-true
  // when the row doesn't exist yet so a fresh restaurant tenant sees a
  // populated dashboard before an admin touches the settings.
  const VOLUME_KEYS = ['restaurant_total_orders', 'restaurant_avg_ticket'];
  const VALUE_KEYS  = ['restaurant_total_revenue', 'restaurant_gross_discount'];
  const anyVolume   = VOLUME_KEYS.some(isVisible);
  const anyValue    = VALUE_KEYS.some(isVisible);
  const channelMixVisible = isVisible('restaurant_channel_mix');

  if (!anyVolume && !anyValue && !channelMixVisible) return null;

  return (
    <div className="mt-5">
      <div className="flex items-center gap-2 mb-3">
        <UtensilsCrossed size={16} className="text-blue-400" />
        <h2 className="text-base font-medium text-theme-heading">Restaurant Analytics</h2>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400">Petpooja</span>
      </div>

      {/* ── Value row (revenue + discount) ──────────────────────────── */}
      {anyValue && (
        <div className="mb-4">
          <p className="mb-1.5 text-[12px] uppercase tracking-[0.5px] text-theme-faint">Revenue</p>
          <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-2 gap-2.5">
            {isVisible('restaurant_total_revenue') && (
              <ValueKPI
                label="Net Revenue"
                value={formatINR(totalRev)}
                sub="Ex-tax · gross − discount"
              />
            )}
            {isVisible('restaurant_gross_discount') && (
              <ValueKPI
                label="Discount"
                value={formatINR(totals?.discount || 0)}
                sub={
                  (totals?.gross_revenue || 0) > 0
                    ? `${((totals!.discount / totals!.gross_revenue) * 100).toFixed(1)}% of gross`
                    : '—'
                }
              />
            )}
          </div>
        </div>
      )}

      {/* ── Volume row (orders + ATV) ───────────────────────────────── */}
      {anyVolume && (
        <div className="mb-4">
          <p className="mb-1.5 text-[12px] uppercase tracking-[0.5px] text-theme-faint">Volume</p>
          <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-2 gap-2.5">
            {isVisible('restaurant_total_orders') && (
              <MiniKPI
                label="Orders"
                value={formatNumber(totalOrders)}
                icon={ReceiptText}
                color="blue"
              />
            )}
            {isVisible('restaurant_avg_ticket') && (
              <MiniKPI
                label="Avg Ticket Value"
                value={formatINR(Math.round(atv))}
                icon={Tag}
                color="purple"
                sub={totalOrders > 0 ? `${formatNumber(totalOrders)} orders` : undefined}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Channel mix table ──────────────────────────────────────── */}
      {channelMixVisible && byChannel.length > 0 && (
        <div
          className="rounded-xl p-3 mt-3"
          style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
        >
          <p className="text-[12px] uppercase tracking-[0.5px] text-theme-faint mb-2">Channel Mix</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-theme-faint">
                  <th className="font-normal py-1.5 text-[11px] uppercase tracking-wider">Channel</th>
                  <th className="font-normal py-1.5 text-[11px] uppercase tracking-wider text-right">Orders</th>
                  <th className="font-normal py-1.5 text-[11px] uppercase tracking-wider text-right">Net Revenue</th>
                  <th className="font-normal py-1.5 text-[11px] uppercase tracking-wider text-right">ATV</th>
                  <th className="font-normal py-1.5 text-[11px] uppercase tracking-wider text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {byChannel.map((c) => {
                  const palette = CHANNEL_PALETTE[c.channel] || { color: 'teal', icon: UtensilsCrossed };
                  const Icon = palette.icon;
                  const share = totalRev > 0 ? (c.revenue / totalRev) * 100 : 0;
                  return (
                    <tr
                      key={c.channel}
                      className="border-t"
                      style={{ borderColor: 'var(--mt-border)' }}
                    >
                      <td className="py-2">
                        <span className="inline-flex items-center gap-2">
                          <Icon size={14} className={`text-${palette.color}-400`} />
                          <span className="text-theme-heading">{c.channel}</span>
                        </span>
                      </td>
                      <td className="py-2 text-right text-theme-heading">{formatNumber(c.orders)}</td>
                      <td className="py-2 text-right text-theme-heading">{formatINR(Math.round(c.revenue))}</td>
                      <td className="py-2 text-right text-theme-heading">{formatINR(Math.round(c.atv))}</td>
                      <td className="py-2 text-right text-theme-faint">{share.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniKPI({ label, value, icon: Icon, color, sub }:
  { label: string; value: string; icon: any; color: string; sub?: string }) {
  const colorMap: Record<string, string> = {
    teal:   'bg-teal-500/10 text-teal-400 border-teal-500/20',
    blue:   'bg-blue-500/10 text-blue-400 border-blue-500/20',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    amber:  'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };
  const c = colorMap[color] || colorMap.blue;
  return (
    <div className={`rounded-xl border p-3 ${c.split(' ').slice(2).join(' ')} ${c.split(' ')[0]}`}>
      <Icon size={14} className={c.split(' ')[1]} />
      <p className="text-base font-medium text-theme-heading mt-1">{value}</p>
      <p className="text-[12px] text-theme-faint leading-tight mt-0.5">{label}</p>
      {sub && <p className="text-[11px] text-theme-faint mt-0.5">{sub}</p>}
    </div>
  );
}

function ValueKPI({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      className="rounded-xl p-3"
      style={{ background: 'var(--mt-bg-raised)', border: '0.5px solid var(--mt-border)' }}
    >
      <p className="text-[12px] uppercase tracking-[0.5px] text-theme-faint">{label}</p>
      <p className="text-lg font-medium text-theme-heading mt-1">{value}</p>
      {sub && <p className="text-[11px] text-theme-faint mt-0.5">{sub}</p>}
    </div>
  );
}
