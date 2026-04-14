import { useEffect, useState, useMemo } from 'react';
import { TrendingUp, TrendingDown, Minus, ExternalLink, Loader2, AlertCircle } from 'lucide-react';
import api from '../../api/client';
import { Scenario, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

interface Props {
  scenario: Scenario | null;
  viewMode: 'monthly' | 'yearly';
}

interface BvAResponse {
  scenario: { id: number; name: string; fy_id: number };
  fy: { id: number; label: string; start_date: string; end_date: string };
  months: string[];
  forecast: Record<string, Record<string, number>>;
  actual: Record<string, Record<string, number>>;
  hasActuals: boolean;
}

// Categories shown in the report. `kind` drives the variance colour:
// 'income' = higher actual is good (green), 'cost' = higher actual is bad (red).
type Kind = 'income' | 'cost';
interface Category {
  key: string;          // forecast_items.category value (or computed id)
  label: string;
  kind: Kind;
  computed?: (f: Record<string, number>, a: Record<string, number>, month: string) => { f: number; a: number };
  isHeader?: boolean;   // computed totals get a heavier visual weight
}

const CATEGORIES: Category[] = [
  { key: 'revenue', label: 'Revenue', kind: 'income' },
  { key: 'direct_costs', label: 'Direct Costs', kind: 'cost' },
  {
    key: 'gross_profit',
    label: 'Gross Profit',
    kind: 'income',
    isHeader: true,
    computed: (f, a, m) => ({
      f: (f['revenue']?.[m] || 0) - (f['direct_costs']?.[m] || 0),
      a: (a['revenue']?.[m] || 0) - (a['direct_costs']?.[m] || 0),
    }),
  },
  { key: 'personnel', label: 'Personnel', kind: 'cost' },
  { key: 'expenses', label: 'Expenses', kind: 'cost' },
  {
    key: 'operating_income',
    label: 'Operating Income',
    kind: 'income',
    isHeader: true,
    computed: (f, a, m) => {
      const grossF = (f['revenue']?.[m] || 0) - (f['direct_costs']?.[m] || 0);
      const grossA = (a['revenue']?.[m] || 0) - (a['direct_costs']?.[m] || 0);
      const opexF = (f['personnel']?.[m] || 0) + (f['expenses']?.[m] || 0);
      const opexA = (a['personnel']?.[m] || 0) + (a['expenses']?.[m] || 0);
      return { f: grossF - opexF, a: grossA - opexA };
    },
  },
  { key: 'assets', label: 'Assets', kind: 'cost' /* over-spend = red */ },
];

function variancePct(forecast: number, actual: number): number | null {
  if (forecast === 0) return actual === 0 ? 0 : null;
  return ((actual - forecast) / Math.abs(forecast)) * 100;
}

// Variance colouring rule: 'income' rows want actual ≥ forecast (positive
// variance is green); 'cost' rows want actual ≤ forecast (positive variance
// is red). Tiny variances stay neutral to avoid noise.
function varianceColour(pct: number | null, kind: Kind): string {
  if (pct === null) return 'text-theme-faint';
  const eps = 0.5; // ±0.5%
  if (Math.abs(pct) <= eps) return 'text-theme-muted';
  const better = kind === 'income' ? pct > 0 : pct < 0;
  return better ? 'text-emerald-400' : 'text-red-400';
}

function VarianceCell({ pct, kind }: { pct: number | null; kind: Kind }) {
  if (pct === null) return <span className="text-theme-faint">—</span>;
  const colour = varianceColour(pct, kind);
  const Icon = Math.abs(pct) <= 0.5 ? Minus : pct > 0 ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 ${colour}`}>
      <Icon size={11} />
      {pct.toFixed(1)}%
    </span>
  );
}

export default function BudgetVsActualReport({ scenario, viewMode }: Props) {
  const [data, setData] = useState<BvAResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scenario || scenario.id === -1) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    api.get('/forecast-module/budget-vs-actual', { params: { scenario_id: scenario.id } })
      .then(res => setData(res.data))
      .catch(e => setError(e?.response?.data?.error || 'Failed to load report'))
      .finally(() => setLoading(false));
  }, [scenario?.id]);

  // Pre-compute (forecast, actual) per (category, month) so render is O(rows × cols).
  const cellData = useMemo(() => {
    if (!data) return null;
    const map: Record<string, Record<string, { f: number; a: number }>> = {};
    for (const cat of CATEGORIES) {
      map[cat.key] = {};
      for (const m of data.months) {
        if (cat.computed) {
          map[cat.key][m] = cat.computed(data.forecast, data.actual, m);
        } else {
          map[cat.key][m] = {
            f: data.forecast[cat.key]?.[m] || 0,
            a: data.actual[cat.key]?.[m] || 0,
          };
        }
      }
      // Yearly total
      let totalF = 0, totalA = 0;
      for (const m of data.months) {
        totalF += map[cat.key][m].f;
        totalA += map[cat.key][m].a;
      }
      map[cat.key]['__total'] = { f: totalF, a: totalA };
    }
    return map;
  }, [data]);

  // Loading / Error / Scenario-missing states
  if (!scenario || scenario.id === -1) {
    return (
      <div className="card p-8 text-center text-theme-muted text-sm">
        Select a scenario to view Budget vs Actual.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="card p-8 flex items-center justify-center gap-2 text-theme-muted text-sm">
        <Loader2 className="animate-spin" size={16} /> Loading Budget vs Actual…
      </div>
    );
  }
  if (error) {
    return (
      <div className="card p-4 flex items-start gap-2 text-red-400 text-sm">
        <AlertCircle size={16} className="mt-0.5" /> {error}
      </div>
    );
  }
  if (!data || !cellData) return null;

  // Empty state — no Tally data synced yet
  if (!data.hasActuals) {
    return (
      <div className="card p-10 flex flex-col items-center justify-center text-center max-w-2xl mx-auto">
        <div className="w-12 h-12 rounded-full bg-accent-500/10 flex items-center justify-center mb-3">
          <ExternalLink className="text-accent-400" size={20} />
        </div>
        <h3 className="text-base font-semibold text-theme-primary mb-1.5">No actuals to compare yet</h3>
        <p className="text-sm text-theme-muted max-w-md mb-5">
          Connect Tally in VCFO Portal to populate trial balance data, then come back here to
          see how your forecast compares against the real numbers.
        </p>
        <a
          href="/vcfo/"
          target="_self"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent-500/20 text-accent-400 hover:bg-accent-500/30 transition"
        >
          Open VCFO Portal <ExternalLink size={14} />
        </a>
      </div>
    );
  }

  const cols: string[] = viewMode === 'yearly' ? ['__total'] : data.months;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-bold text-theme-primary">Budget vs Actual</h2>
          <p className="text-xs text-theme-muted mt-0.5">
            Forecast for <span className="text-theme-secondary">{data.scenario.name}</span> ·{' '}
            {data.fy.label} · variance vs synced Tally totals
          </p>
        </div>
        <a
          href="/forecast/settings/category-mapping"
          className="text-xs text-theme-muted hover:text-accent-400 transition"
        >
          Category mapping →
        </a>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-dark-700/50 border-b border-dark-400/40">
              <th className="text-left px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase sticky left-0 bg-dark-700/50 z-10 w-[180px]">
                Category
              </th>
              <th className="text-left px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase w-[80px]">
                Metric
              </th>
              {cols.map(c => (
                <th key={c} className="text-right px-3 py-2.5 text-[10px] font-medium text-theme-faint uppercase whitespace-nowrap">
                  {c === '__total' ? `${data.fy.label} Total` : getMonthLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map(cat => (
              <CategoryBlock
                key={cat.key}
                cat={cat}
                cols={cols}
                data={cellData[cat.key]}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Footnote */}
      <div className="text-[11px] text-theme-faint px-1">
        Variance = (Actual − Forecast) ÷ |Forecast|. Green favours the forecast; red flags an over- or
        under-shoot depending on the line. Mapping between forecast categories and Tally groups is
        configurable in <a href="/forecast/settings/category-mapping" className="underline hover:text-accent-400">Settings</a>.
      </div>
    </div>
  );
}

// ── Category block — three rows: Forecast, Actual, Variance ──
function CategoryBlock({
  cat,
  cols,
  data,
}: {
  cat: Category;
  cols: string[];
  data: Record<string, { f: number; a: number }>;
}) {
  const headerStyle = cat.isHeader
    ? 'bg-dark-700/30 font-semibold text-theme-primary'
    : 'text-theme-secondary';
  return (
    <>
      {/* Forecast row */}
      <tr className={`border-t border-dark-400/30 ${headerStyle}`}>
        <td rowSpan={3} className={`px-3 py-2 align-middle sticky left-0 z-10 ${cat.isHeader ? 'bg-dark-800' : 'bg-dark-800'}`}>
          <span className={cat.isHeader ? 'text-theme-primary' : 'text-theme-secondary'}>
            {cat.label}
          </span>
        </td>
        <td className="px-3 py-1.5 text-theme-muted text-[11px]">Forecast</td>
        {cols.map(c => (
          <td key={c} className="px-3 py-1.5 text-right text-theme-secondary tabular-nums">
            {formatRs(Math.round(data[c].f))}
          </td>
        ))}
      </tr>
      {/* Actual row */}
      <tr className={headerStyle}>
        <td className="px-3 py-1.5 text-theme-muted text-[11px]">Actual</td>
        {cols.map(c => (
          <td key={c} className="px-3 py-1.5 text-right text-theme-secondary tabular-nums">
            {formatRs(Math.round(data[c].a))}
          </td>
        ))}
      </tr>
      {/* Variance row */}
      <tr className={`${headerStyle} border-b border-dark-400/30`}>
        <td className="px-3 py-1.5 text-theme-muted text-[11px]">Variance</td>
        {cols.map(c => {
          const pct = variancePct(data[c].f, data[c].a);
          return (
            <td key={c} className="px-3 py-1.5 text-right tabular-nums">
              <VarianceCell pct={pct} kind={cat.kind} />
            </td>
          );
        })}
      </tr>
    </>
  );
}
