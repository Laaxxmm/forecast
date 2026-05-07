import { useEffect, useState } from 'react';
import api from '../../api/client';
import KpiCard from './dashboard/KpiCard';
import TrendCard from './dashboard/TrendCard';
import CompositionCard from './dashboard/CompositionCard';
import CashBankCard from './dashboard/CashBankCard';
import PartyTopCard from './dashboard/PartyTopCard';
import CashFlowSnapshotCard from './dashboard/CashFlowSnapshotCard';
import CompanyContributionCard from './dashboard/CompanyContributionCard';

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
  receivables: { total: number; top: Array<{ party: string; amount: number }> };
  payables:    { total: number; top: Array<{ party: string; amount: number }> };
  cashFlow: {
    operating: number; investing: number; financing: number;
    netChange: number; closingCash: number;
  };
  perCompany?: Array<{ id: number; name: string; revenue: number; netProfit: number }>;
}

interface Props {
  companyId: number | null;
  companyIds?: string | null;
  from: string;
  to: string;
}

/**
 * Dashboard — the default landing tab inside VcfoModulePage. One fetch
 * pulls everything; the layout fans out into eight focused widget cards.
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

  const showPerCompany = data.scope.consolidated && (data.perCompany?.length ?? 0) > 1;

  return (
    <div className="space-y-3 md:space-y-4">
      {/* Row 1 — KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <KpiCard
          label="Revenue"
          value={data.kpis.revenue.value}
          deltaPct={data.kpis.revenue.deltaPct}
          sublabel={`vs ${data.prior.from} → ${data.prior.to}`}
        />
        <KpiCard
          label="Gross Profit"
          value={data.kpis.grossProfit.value}
          deltaPct={data.kpis.grossProfit.deltaPct}
          sublabel={`Margin ${data.kpis.grossProfit.marginPct.toFixed(1)}%`}
        />
        <KpiCard
          label="Net Profit"
          value={data.kpis.netProfit.value}
          deltaPct={data.kpis.netProfit.deltaPct}
          sublabel={`Margin ${data.kpis.netProfit.marginPct.toFixed(1)}%`}
          tone={data.kpis.netProfit.value >= 0 ? 'positive' : 'negative'}
        />
        <KpiCard
          label="Cash & Bank"
          value={data.kpis.cashAndBank.value}
          sublabel={`As of ${data.kpis.cashAndBank.asOf}`}
        />
      </div>

      {/* Row 2 — Trend (8 cols) + Cash & Bank (4 cols) */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:gap-4">
        <div className="md:col-span-8">
          <TrendCard
            columns={data.trend.columns}
            revenue={data.trend.revenue}
            netProfit={data.trend.netProfit}
          />
        </div>
        <div className="md:col-span-4">
          <CashBankCard
            asOf={data.cashAndBank.asOf}
            total={data.cashAndBank.total}
            ledgers={data.cashAndBank.ledgers}
          />
        </div>
      </div>

      {/* Row 3 — Composition + Cash Flow snapshot */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        <CompositionCard {...data.composition} />
        <CashFlowSnapshotCard {...data.cashFlow} />
      </div>

      {/* Row 4 — Receivables + Payables */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        <PartyTopCard
          title="Top 10 Receivables"
          subtitle="Sundry Debtors"
          total={data.receivables.total}
          entries={data.receivables.top}
          color="#10b981"
        />
        <PartyTopCard
          title="Top 10 Payables"
          subtitle="Sundry Creditors"
          total={data.payables.total}
          entries={data.payables.top}
          color="#f59e0b"
        />
      </div>

      {/* Row 5 — Per-company (consolidation, ≥2 companies) */}
      {showPerCompany && (
        <CompanyContributionCard entries={data.perCompany!} />
      )}
    </div>
  );
}

/** Pulse-skeleton placeholder while the fetch is in flight. */
function DashboardSkeleton() {
  const block = (h: string) => (
    <div
      className="mt-card p-4 animate-pulse"
      style={{ minHeight: h }}
    >
      <div className="h-3 w-24 rounded mb-3" style={{ background: 'var(--mt-bg-muted)' }} />
      <div className="h-7 w-32 rounded" style={{ background: 'var(--mt-bg-muted)' }} />
    </div>
  );
  return (
    <div className="space-y-3 md:space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {block('72px')}{block('72px')}{block('72px')}{block('72px')}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:gap-4">
        <div className="md:col-span-8">{block('260px')}</div>
        <div className="md:col-span-4">{block('260px')}</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        {block('220px')}{block('220px')}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
        {block('260px')}{block('260px')}
      </div>
    </div>
  );
}
