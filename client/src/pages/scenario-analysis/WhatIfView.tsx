import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, FileText, Building2, Banknote } from 'lucide-react';
import api from '../../api/client';
import { FY, Scenario, ForecastItem, getFYMonths, formatRs } from '../ForecastModulePage';
import {
  buildPnLRows, buildBalanceSheetRows, buildCashFlowRows,
  formatNum, StatementBlock,
} from '../../utils/financialStatements';
import { WhatIfTweaks, applyTweaks } from '../../utils/whatIfEngine';

interface Props {
  disabled: boolean;
  fy: FY | null;
  scenarios: Scenario[];
}

type StatementKey = 'pnl' | 'bs' | 'cf';
const STATEMENTS: { key: StatementKey; label: string; icon: any }[] = [
  { key: 'pnl', label: 'Profit & Loss', icon: FileText },
  { key: 'bs', label: 'Balance Sheet', icon: Building2 },
  { key: 'cf', label: 'Cash Flow', icon: Banknote },
];

interface SliderDef {
  key: keyof WhatIfTweaks;
  label: string;
  hint: string;
}
const SLIDERS: SliderDef[] = [
  { key: 'revenuePct', label: 'Revenue', hint: 'Scales every revenue line item' },
  { key: 'directCostsPct', label: 'Direct Costs', hint: 'Scales every direct-cost line item' },
  { key: 'personnelPct', label: 'Personnel', hint: 'Scales salaries (benefits track automatically)' },
  { key: 'expensesPct', label: 'Operating Expenses', hint: 'Scales every operating-expense line item' },
  { key: 'taxesPct', label: 'Taxes', hint: 'Scales the income-tax line items' },
];

export default function WhatIfView({ disabled, fy, scenarios }: Props) {
  const [baseId, setBaseId] = useState<number | null>(null);
  const [items, setItems] = useState<ForecastItem[]>([]);
  const [values, setValues] = useState<Record<number, Record<string, number>>>({});
  const [benefitsPct, setBenefitsPct] = useState<number>(0);
  const [tweaks, setTweaks] = useState<WhatIfTweaks>({});
  const [statement, setStatement] = useState<StatementKey>('pnl');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Default to the default scenario if available; else first.
    if (!disabled && baseId == null && scenarios.length > 0) {
      const def = scenarios.find(s => s.is_default) || scenarios[0];
      setBaseId(def.id);
    }
  }, [disabled, scenarios, baseId]);

  useEffect(() => {
    if (disabled || baseId == null) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get('/forecast-module/items', { params: { scenario_id: baseId } }),
      api.get('/forecast-module/values', { params: { scenario_id: baseId } }),
      api.get('/forecast-module/settings', { params: { scenario_id: baseId } }),
    ]).then(([iRes, vRes, sRes]) => {
      if (cancelled) return;
      setItems(iRes.data || []);
      const m: Record<number, Record<string, number>> = {};
      (vRes.data || []).forEach((v: any) => {
        if (!m[v.item_id]) m[v.item_id] = {};
        m[v.item_id][v.month] = v.amount;
      });
      setValues(m);
      setBenefitsPct(Number(sRes.data?.employee_benefits_pct ?? 0));
    }).catch(e => console.error('WhatIfView load failed:', e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [disabled, baseId]);

  // Hooks must be called unconditionally on every render (Rules of Hooks),
  // so `useMemo` lives above the early-return guards below.
  const months = useMemo(() => fy ? getFYMonths(fy.start_date) : [], [fy]);

  // Base (no tweaks) — used as the comparison point for KPI deltas.
  const basePnL = useMemo(
    () => buildPnLRows(items, values, months, benefitsPct),
    [items, values, months, benefitsPct],
  );

  // Tweaked — recomputed on every slider change. Uses applyTweaks to scale
  // category values, then runs the standard row builders.
  const tweaked = useMemo(() => {
    const { items: ti, allValues: tv } = applyTweaks(items, values, tweaks);
    const effBenefits = tweaks.benefitsPctOverride != null && !Number.isNaN(tweaks.benefitsPctOverride)
      ? tweaks.benefitsPctOverride
      : benefitsPct;
    return {
      pnl: buildPnLRows(ti, tv, months, effBenefits),
      bs: buildBalanceSheetRows(ti, tv, months),
      cf: buildCashFlowRows(ti, tv, months),
    };
  }, [items, values, months, benefitsPct, tweaks]);

  if (disabled) return null;
  if (scenarios.length === 0) {
    return (
      <div
        className="px-6 py-12 rounded-lg text-center"
        style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--mt-text-heading)', marginBottom: 4 }}>
          No scenarios yet
        </div>
        <div style={{ fontSize: 13, color: 'var(--mt-text-muted)' }}>
          Create a scenario in the <strong>Manage</strong> tab first.
        </div>
      </div>
    );
  }

  // Memoize the base BS/CF blocks too — they're pure but non-trivial, and
  // get re-read on every render of the preview table.
  const baseBS = useMemo(() => buildBalanceSheetRows(items, values, months), [items, values, months]);
  const baseCF = useMemo(() => buildCashFlowRows(items, values, months), [items, values, months]);

  const baseKpis = extractKpis(basePnL, baseCF);
  const tweakedKpis = extractKpis(tweaked.pnl, tweaked.cf);

  const setSlider = (key: keyof WhatIfTweaks, val: number) => {
    setTweaks(t => ({ ...t, [key]: val }));
  };
  const reset = () => setTweaks({});

  const block: StatementBlock = statement === 'pnl' ? tweaked.pnl
    : statement === 'bs' ? tweaked.bs : tweaked.cf;
  const baseBlock: StatementBlock = statement === 'pnl' ? basePnL
    : statement === 'bs' ? baseBS : baseCF;

  return (
    <div className="flex flex-col gap-4">
      {/* Top row: scenario picker + KPI cards */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span style={{ fontSize: 11, color: 'var(--mt-text-faint)', fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' }}>Base scenario</span>
          <select
            value={baseId ?? ''}
            onChange={e => setBaseId(Number(e.target.value))}
            className="mt-input"
            style={{ padding: '6px 10px', fontSize: 13, minWidth: 200 }}
          >
            {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}{s.is_default ? ' (default)' : ''}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-stretch gap-2">
          <Kpi label="Net Profit" base={baseKpis.netProfit} tweaked={tweakedKpis.netProfit} format={v => formatRs(Math.round(v))} />
          <Kpi label="Net Margin" base={baseKpis.netMargin} tweaked={tweakedKpis.netMargin} format={v => `${v.toFixed(1)}%`} suffix="" />
          <Kpi label="Cash at End" base={baseKpis.cashEnd} tweaked={tweakedKpis.cashEnd} format={v => formatRs(Math.round(v))} />
        </div>
      </div>

      {/* Sliders */}
      <div
        className="rounded-lg p-4"
        style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mt-text-heading)' }}>Sensitivity sliders</div>
            <div style={{ fontSize: 11, color: 'var(--mt-text-muted)' }}>
              Tweaks are applied live and not saved. Reset to clear.
            </div>
          </div>
          <button onClick={reset} className="mt-btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }}>
            <RotateCcw size={12} />
            <span>Reset</span>
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
          {SLIDERS.map(s => (
            <SliderRow
              key={s.key}
              label={s.label}
              hint={s.hint}
              value={Number(tweaks[s.key] || 0)}
              onChange={v => setSlider(s.key, v)}
            />
          ))}
        </div>
      </div>

      {/* Statement preview */}
      <div className="flex items-center gap-2">
        <div
          className="flex overflow-hidden"
          style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)', borderRadius: 10 }}
        >
          {STATEMENTS.map(s => (
            <button
              key={s.key}
              onClick={() => setStatement(s.key)}
              className="px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5"
              style={{
                color: statement === s.key ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                background: statement === s.key ? 'var(--mt-accent-soft)' : 'transparent',
              }}
            >
              <s.icon size={14} />
              {s.label}
            </button>
          ))}
        </div>
        {loading && <span style={{ fontSize: 12, color: 'var(--mt-text-muted)' }}>Loading…</span>}
      </div>

      {!loading && (
        <PreviewTable block={block} baseBlock={baseBlock} />
      )}
    </div>
  );
}

function SliderRow({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--mt-text-heading)' }}>{label}</span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={value}
            onChange={e => onChange(Number(e.target.value) || 0)}
            className="mt-input text-right mt-num"
            style={{ padding: '2px 6px', fontSize: 12, width: 64 }}
            step={1}
          />
          <span style={{ fontSize: 12, color: 'var(--mt-text-muted)' }}>%</span>
        </div>
      </div>
      <input
        type="range"
        min={-50}
        max={50}
        step={1}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
      <div style={{ fontSize: 11, color: 'var(--mt-text-faint)', marginTop: 2 }}>{hint}</div>
    </div>
  );
}

function Kpi({ label, base, tweaked, format }: {
  label: string;
  base: number;
  tweaked: number;
  format: (v: number) => string;
  suffix?: string;
}) {
  const delta = tweaked - base;
  const pct = base !== 0 ? ((tweaked - base) / Math.abs(base)) * 100 : 0;
  const color = delta === 0 ? 'var(--mt-text-muted)' : delta > 0 ? '#16a34a' : '#dc2626';
  return (
    <div
      className="flex flex-col items-end px-3 py-2 rounded-lg"
      style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)', minWidth: 140 }}
    >
      <span style={{ fontSize: 10, color: 'var(--mt-text-faint)', fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</span>
      <span className="mt-num" style={{ fontSize: 16, fontWeight: 600, color: 'var(--mt-text-heading)' }}>{format(tweaked)}</span>
      <span className="mt-num" style={{ fontSize: 11, color }}>
        {delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${format(delta).replace(/^Rs/, '')} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`}
      </span>
    </div>
  );
}

function extractKpis(pnl: StatementBlock, cf: StatementBlock): { netProfit: number; netMargin: number; cashEnd: number } {
  const findRow = (block: StatementBlock, label: string): number => {
    const idx = block.rows.findIndex(r => String(r[0]).trim() === label);
    if (idx < 0) return 0;
    const last = block.rows[idx][block.rows[idx].length - 1];
    return typeof last === 'number' ? last : 0;
  };
  return {
    netProfit: findRow(pnl, 'Net Profit'),
    netMargin: findRow(pnl, 'Net Profit Margin'),
    cashEnd: findRow(cf, 'Cash Balance'),
  };
}

function PreviewTable({ block, baseBlock }: { block: StatementBlock; baseBlock: StatementBlock }) {
  const labels = block.rows.map(r => String(r[0] ?? ''));
  const meta = block.meta;
  const yearlyAt = (b: StatementBlock, i: number): number => {
    const row = b.rows[i];
    if (!row) return 0;
    const last = row[row.length - 1];
    return typeof last === 'number' ? last : 0;
  };

  return (
    <div
      className="rounded-lg overflow-x-auto"
      style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
    >
      <table className="w-full text-sm" style={{ minWidth: 480 }}>
        <thead>
          <tr style={{ background: 'var(--mt-bg-raised)' }}>
            <th className="text-left px-4 py-2 font-medium" style={{ color: 'var(--mt-text-muted)' }}>Line item</th>
            <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--mt-text-muted)' }}>Base</th>
            <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--mt-text-muted)' }}>What-if</th>
            <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--mt-text-muted)' }}>∆</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => {
            const m = meta[i] || {};
            const isSection = m.isSection;
            const isTotal = m.isTotal;
            const pct = !!m.isPercent;
            const base = yearlyAt(baseBlock, i);
            const t = yearlyAt(block, i);
            const delta = t - base;
            return (
              <tr
                key={i}
                style={{
                  borderTop: i === 0 ? 'none' : '1px solid var(--mt-border)',
                  background: isTotal ? 'color-mix(in srgb, var(--mt-accent) 6%, transparent)' :
                               isSection ? 'var(--mt-bg-raised)' : 'transparent',
                  fontWeight: isSection || isTotal ? 600 : 400,
                }}
              >
                <td className="px-4 py-1.5" style={{ whiteSpace: 'nowrap', color: 'var(--mt-text-heading)' }}>{label}</td>
                <td className="px-4 py-1.5 text-right mt-num" style={{ color: 'var(--mt-text-heading)' }}>
                  {isSection ? '' : formatNum(base, pct)}
                </td>
                <td className="px-4 py-1.5 text-right mt-num" style={{ color: 'var(--mt-text-heading)' }}>
                  {isSection ? '' : formatNum(t, pct)}
                </td>
                <td className="px-4 py-1.5 text-right mt-num" style={{ color: delta === 0 ? 'var(--mt-text-muted)' : delta > 0 ? '#16a34a' : '#dc2626' }}>
                  {isSection ? '' : formatNum(delta, pct)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
