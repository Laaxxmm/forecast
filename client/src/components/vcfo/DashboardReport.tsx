import { useEffect, useState } from 'react';
import api from '../../api/client';
import { formatRs, formatRsCompact } from '../../pages/ForecastModulePage';
import KpiCard from './dashboard/KpiCard';
import TrendCard from './dashboard/TrendCard';
import CompositionCard from './dashboard/CompositionCard';
import PartyTopCard from './dashboard/PartyTopCard';
import CashFlowSnapshotCard from './dashboard/CashFlowSnapshotCard';
import TrustBar from './dashboard/TrustBar';
import WeeklyChangeCard from './dashboard/WeeklyChangeCard';

interface DashboardPayload {
  period: { from: string; to: string };
  prior:  { from: string; to: string };
  scope:  { companyIds: number[]; consolidated: boolean; companyCount: number };
  kpis: {
    revenue:     { value: number; prior: number; deltaPct: number };
    grossProfit: { value: number; prior: number; deltaPct: number; marginPct: number };
    netProfit:   { value: number; prior: number; deltaPct: number; marginPct: number };
    cashAndBank: { value: number; asOf: string };
  };
  trend: {
    columns: string[];
    revenue: Record<string, number>;
    netProfit: Record<string, number>;
  };
  composition: {
    revenue: number; directCosts: number; indirectIncome: number;
    indirectExpenses: number; grossProfit: number; netProfit: number;
  };
  cashAndBank: {
    asOf: string; total: number;
    ledgers: Array<{ name: string; group: 'Cash-in-Hand' | 'Bank Accounts'; balance: number }>;
  };
  receivables: { total: number; top: Array<PartyEntry> };
  payables:    { total: number; top: Array<PartyEntry> };
  cashFlow: {
    opening: number;
    operating: number; investing: number; financing: number;
    netChange: number; closingCash: number;
  };
  perCompany?: Array<{ id: number; name: string; revenue: number; netProfit: number }>;
  weekly: {
    revenue: { last7d: number; prior7d: number; deltaPct: number | null };
    netCash: { current: number; weekAgo: number; delta: number };
    windows: { last7dFrom: string; last7dTo: string; prior7dFrom: string; prior7dTo: string };
  };
}

export interface PartyEntry {
  party: string;
  amount: number;
  /** Age in days of the oldest contributing voucher entry — Phase 2 aging proxy. */
  oldestEntryDays: number | null;
}

interface Props {
  companyId: number | null;
  companyIds?: string | null;
  from: string;
  to: string;
}

/**
 * Dashboard — the default landing tab inside VcfoModulePage. One fetch
 * pulls everything; the layout fans out into a 5-row vertical stack
 * answering the three questions a CFO opens this page to ask:
 *   (1) Is the data trustworthy?           — Row 0 trust bar
 *   (2) How are we performing right now?   — Rows 1–3 (KPIs, trend, P&L, cash)
 *   (3) What needs my attention this week? — Row 4 (receivables, payables)
 *
 * The parent page handles the toolbar (FY / period / company / bifurcate)
 * and the top-tab nav, so this component is pure content.
 */
export default function DashboardReport({ companyId, companyIds, from, to }: Props) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId && !companyIds) { setData(null); return; }
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    const params: Record<string, any> = { from, to };
    if (companyId) params.companyId = companyId;
    else if (companyIds) params.companyIds = companyIds;
    api
      .get('/vcfo/dashboard', { params })
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.error || err?.message || 'Failed to load dashboard'))
      .finally(() => setLoading(false));
  }, [companyId, companyIds, from, to]);

  if (!companyId && !companyIds) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">Select a company to view the Dashboard.</p>
      </div>
    );
  }

  if (loading || !data) {
    return <DashboardSkeleton />;
  }

  if (error) {
    return (
      <div
        className="rounded-2xl p-8 text-center"
        style={{
          background: 'var(--mt-bg-raised)',
          border: '1px solid var(--mt-danger-border)',
          boxShadow: 'var(--mt-shadow-card)',
        }}
      >
        <p className="mb-2 font-medium" style={{ color: 'var(--mt-danger-text)' }}>Couldn't load dashboard.</p>
        <p className="text-sm mb-3" style={{ color: 'var(--mt-text-faint)' }}>{error}</p>
      </div>
    );
  }

  // ── Derived values used in Row 1 KPIs ─────────────────────────────
  const netCash = data.cashAndBank.total;
  const accountCount = data.cashAndBank.ledgers.length;
  const workingCapitalGap = data.receivables.total - data.payables.total;

  const priorRevenue = data.kpis.revenue.prior;
  const priorGrossProfit = data.kpis.grossProfit.prior;
  const currentMargin = data.kpis.grossProfit.marginPct;
  const priorMargin = priorRevenue > 0 ? (priorGrossProfit / priorRevenue) * 100 : null;
  const marginPts = priorMargin !== null ? currentMargin - priorMargin : null;

  const headlineLabel = `Headline · ${data.period.from} to ${data.period.to}`;

  return (
    <div className="space-y-3 md:space-y-4">
      {/* Row 0 — Trust bar (auto-hides when sync is healthy) */}
      <TrustBar />

      {/* Row 1 — Headline KPIs */}
      <div>
        <div
          className="text-[11px] uppercase font-semibold mb-2"
          style={{ color: 'var(--mt-text-faint)', letterSpacing: '0.5px' }}
        >
          {headlineLabel}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          <KpiCard
            label="Revenue"
            value={data.kpis.revenue.value}
            deltaPct={data.kpis.revenue.deltaPct}
            prior={data.kpis.revenue.prior}
            sublabel={`vs ${data.prior.from} → ${data.prior.to}`}
          />
          <KpiCard
            label="Gross margin"
            value={currentMargin}
            valueOverride={`${currentMargin.toFixed(1)}%`}
            deltaPct={marginPts}
            prior={priorRevenue}
            deltaUnit="pts"
            sublabel={priorMargin !== null
              ? `Prior ${priorMargin.toFixed(1)}% · Gross profit ${formatRsCompact(data.kpis.grossProfit.value)}`
              : `Gross profit ${formatRsCompact(data.kpis.grossProfit.value)}`}
          />
          <KpiCard
            label="Net cash position"
            value={netCash}
            tone={netCash < 0 ? 'negative' : 'neutral'}
            sublabel={netCash < 0
              ? `${accountCount} ${accountCount === 1 ? 'account' : 'accounts'} · likely OD`
              : `Across ${accountCount} ${accountCount === 1 ? 'account' : 'accounts'}`}
            tooltip={<NetCashTooltip ledgers={data.cashAndBank.ledgers} asOf={data.cashAndBank.asOf} />}
          />
          <KpiCard
            label="Working capital gap"
            value={workingCapitalGap}
            tone={workingCapitalGap < 0 ? 'negative' : 'neutral'}
            borderTone={workingCapitalGap < 0 ? 'danger' : undefined}
            sublabel={`Receivables ${formatRsCompact(data.receivables.total)} · Payables ${formatRsCompact(data.payables.total)}`}
          />
        </div>
      </div>

      {/* Row 2 — Performance over time (full width) */}
      <TrendCard
        columns={data.trend.columns}
        revenue={data.trend.revenue}
        netProfit={data.trend.netProfit}
      />

      {/* Row 3 — P&L story | Cash story */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        <CompositionCard {...data.composition} />
        <CashFlowSnapshotCard {...data.cashFlow} />
      </div>

      {/* Row 4 — Working capital action board */}
      <div>
        <div
          className="text-[11px] uppercase font-semibold mb-2"
          style={{ color: 'var(--mt-text-faint)', letterSpacing: '0.5px' }}
        >
          Action board · Working capital
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
          <PartyTopCard
            title="Money owed to us"
            subtitle="Sundry Debtors"
            entityLabel="customers"
            total={data.receivables.total}
            entries={data.receivables.top}
          />
          <PartyTopCard
            title="Money we owe"
            subtitle="Sundry Creditors"
            entityLabel="vendors"
            total={data.payables.total}
            entries={data.payables.top}
          />
        </div>
      </div>

      {/* Row 5 — What changed this week */}
      <WeeklyChangeCard
        revenue={data.weekly.revenue}
        netCash={data.weekly.netCash}
        windows={data.weekly.windows}
      />
    </div>
  );
}

/** Per-account breakdown rendered inside the Net Cash Position popover. */
function NetCashTooltip({
  ledgers, asOf,
}: {
  ledgers: Array<{ name: string; group: 'Cash-in-Hand' | 'Bank Accounts'; balance: number }>;
  asOf: string;
}) {
  if (ledgers.length === 0) {
    return <div className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>No ledgers found.</div>;
  }
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-semibold mb-2" style={{ color: 'var(--mt-text-faint)' }}>
        Per account · As of {asOf}
      </div>
      <div className="space-y-1">
        {ledgers.map((l) => (
          <div key={`${l.group}-${l.name}`} className="flex items-center justify-between gap-3 text-[11px]">
            <span className="truncate" title={l.name} style={{ color: 'var(--mt-text-secondary)' }}>{l.name}</span>
            <span
              className="font-mono shrink-0"
              style={{ color: l.balance < 0 ? 'var(--mt-danger-text)' : 'var(--mt-text-primary)' }}
            >
              {formatRs(l.balance)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pulse-skeleton placeholder while the fetch is in flight. */
function DashboardSkeleton() {
  const block = (h: string) => (
    <div className="mt-card p-4 animate-pulse" style={{ minHeight: h }}>
      <div className="h-3 w-24 rounded mb-3" style={{ background: 'var(--mt-bg-muted)' }} />
      <div className="h-7 w-32 rounded" style={{ background: 'var(--mt-bg-muted)' }} />
    </div>
  );
  return (
    <div className="space-y-3 md:space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {block('72px')}{block('72px')}{block('72px')}{block('72px')}
      </div>
      {block('260px')}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        {block('260px')}{block('260px')}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        {block('260px')}{block('260px')}
      </div>
    </div>
  );
}
