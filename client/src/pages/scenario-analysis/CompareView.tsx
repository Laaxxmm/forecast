import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileText, Building2, Banknote } from 'lucide-react';
import api from '../../api/client';
import { FY, Scenario, ForecastItem, getFYMonths } from '../ForecastModulePage';
import {
  buildPnLRows, buildBalanceSheetRows, buildCashFlowRows,
  formatNum, StatementBlock,
} from '../../utils/financialStatements';
import ScenarioPicker from '../../components/scenario-analysis/ScenarioPicker';

interface Props {
  disabled: boolean;
  fy: FY | null;
  scenarios: Scenario[];
}

interface ScenarioData {
  scenario: Scenario;
  items: ForecastItem[];
  values: Record<number, Record<string, number>>;
  benefitsPct: number;
}

type StatementKey = 'pnl' | 'bs' | 'cf';
const STATEMENTS: { key: StatementKey; label: string; icon: any }[] = [
  { key: 'pnl', label: 'Profit & Loss', icon: FileText },
  { key: 'bs', label: 'Balance Sheet', icon: Building2 },
  { key: 'cf', label: 'Cash Flow', icon: Banknote },
];

export default function CompareView({ disabled, fy, scenarios }: Props) {
  const [params, setParams] = useSearchParams();
  const [statement, setStatement] = useState<StatementKey>('pnl');
  const [viewMode, setViewMode] = useState<'monthly' | 'yearly'>('yearly');
  const [data, setData] = useState<ScenarioData[]>([]);
  const [loading, setLoading] = useState(false);

  // URL-driven selection so the view is shareable.
  const selectedIds = useMemo(() => {
    const raw = params.get('scenarios') || '';
    return raw.split(',').map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0);
  }, [params]);
  const baseId = useMemo(() => {
    const raw = params.get('base');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : (selectedIds[0] ?? null);
  }, [params, selectedIds]);

  const updateSelection = (ids: number[], base: number | null) => {
    const next = new URLSearchParams(params);
    if (ids.length) next.set('scenarios', ids.join(',')); else next.delete('scenarios');
    if (base != null) next.set('base', String(base)); else next.delete('base');
    setParams(next, { replace: true });
  };

  // Auto-default the picker when nothing is in URL: pick first 2 scenarios.
  useEffect(() => {
    if (disabled || scenarios.length < 2) return;
    if (selectedIds.length === 0) {
      const ids = scenarios.slice(0, 2).map(s => s.id);
      updateSelection(ids, ids[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, scenarios.length]);

  // A stable id-keyed map of the parent's scenarios so the load effect doesn't
  // re-fire when the parent re-renders with a fresh array reference but the
  // same data.
  const scenariosById = useMemo(() => {
    const m = new Map<number, Scenario>();
    for (const s of scenarios) m.set(s.id, s);
    return m;
  }, [scenarios.map(s => `${s.id}:${s.name}:${s.is_default}`).join('|')]);

  // Load items / values / settings for each selected scenario in parallel.
  // Effect deps intentionally exclude the `scenarios` array reference so a
  // parent re-render doesn't trigger refetches when nothing material changed.
  useEffect(() => {
    if (disabled || selectedIds.length === 0) { setData([]); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all(selectedIds.map(async id => {
      const scenario = scenariosById.get(id);
      if (!scenario) return null;
      const [itemsRes, valuesRes, settingsRes] = await Promise.all([
        api.get('/forecast-module/items', { params: { scenario_id: id } }),
        api.get('/forecast-module/values', { params: { scenario_id: id } }),
        api.get('/forecast-module/settings', { params: { scenario_id: id } }),
      ]);
      if (cancelled) return null;
      const valuesMap: Record<number, Record<string, number>> = {};
      (valuesRes.data || []).forEach((v: any) => {
        if (!valuesMap[v.item_id]) valuesMap[v.item_id] = {};
        valuesMap[v.item_id][v.month] = v.amount;
      });
      const benefitsPct = Number(settingsRes.data?.employee_benefits_pct ?? 0);
      return { scenario, items: itemsRes.data || [], values: valuesMap, benefitsPct };
    })).then(results => {
      if (cancelled) return;
      setData(results.filter((r): r is ScenarioData => !!r));
    }).catch(e => {
      console.error('CompareView load failed:', e);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, selectedIds.join(','), scenariosById]);

  if (disabled) return null;
  if (scenarios.length < 2) {
    return <EmptyState />;
  }

  const months = fy ? getFYMonths(fy.start_date) : [];

  // Build the statement block once per scenario, using the picked statement type.
  const blocks: { scenario: Scenario; block: StatementBlock }[] = data.map(d => ({
    scenario: d.scenario,
    block: statement === 'pnl'
      ? buildPnLRows(d.items, d.values, months, d.benefitsPct)
      : statement === 'bs'
        ? buildBalanceSheetRows(d.items, d.values, months)
        : buildCashFlowRows(d.items, d.values, months),
  }));

  const baseIdx = blocks.findIndex(b => b.scenario.id === baseId);

  return (
    <div className="flex flex-col gap-4">
      <ScenarioPicker
        scenarios={scenarios}
        selected={selectedIds}
        baseId={baseId}
        onChange={updateSelection}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <div
          className="flex overflow-hidden"
          style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)', borderRadius: 10 }}
        >
          <button
            onClick={() => setViewMode('yearly')}
            className="px-3 py-1.5 text-xs font-medium"
            style={{
              color: viewMode === 'yearly' ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
              background: viewMode === 'yearly' ? 'var(--mt-accent-soft)' : 'transparent',
            }}
          >Yearly</button>
          <button
            onClick={() => setViewMode('monthly')}
            className="px-3 py-1.5 text-xs font-medium"
            style={{
              color: viewMode === 'monthly' ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
              background: viewMode === 'monthly' ? 'var(--mt-accent-soft)' : 'transparent',
            }}
          >Monthly</button>
        </div>
      </div>

      {loading && (
        <div style={{ color: 'var(--mt-text-muted)', fontSize: 13 }}>Loading scenario data…</div>
      )}

      {!loading && blocks.length >= 2 && (
        <ComparisonTable
          blocks={blocks}
          baseIdx={baseIdx >= 0 ? baseIdx : 0}
          viewMode={viewMode}
          months={months}
        />
      )}

      {!loading && blocks.length === 1 && (
        <div style={{ color: 'var(--mt-text-muted)', fontSize: 13 }}>
          Pick a second scenario from the picker above.
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="px-6 py-12 rounded-lg text-center"
      style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--mt-text-heading)', marginBottom: 4 }}>
        Need at least 2 scenarios to compare
      </div>
      <div style={{ fontSize: 13, color: 'var(--mt-text-muted)' }}>
        Create another scenario in the <strong>Manage</strong> tab to start comparing.
      </div>
    </div>
  );
}

interface ComparisonTableProps {
  blocks: { scenario: Scenario; block: StatementBlock }[];
  baseIdx: number;
  viewMode: 'monthly' | 'yearly';
  months: string[];
}

function ComparisonTable({ blocks, baseIdx, viewMode, months }: ComparisonTableProps) {
  const base = blocks[baseIdx];
  const others = blocks.filter((_, i) => i !== baseIdx);
  const labels = base.block.rows.map(r => String(r[0] ?? ''));
  const meta = base.block.meta;

  // For each block, collapse to a single yearly value or expand to all months.
  // Use the existing rows where the last column is already the FY total
  // (P&L and CF have a Total column at index = months.length + 1; BS has no
  // Total column — it ends at the last month). We treat the last column as
  // the yearly value either way.
  const yearlyValueAt = (block: StatementBlock, rowIdx: number): number => {
    const row = block.rows[rowIdx];
    if (!row) return 0;
    const last = row[row.length - 1];
    return typeof last === 'number' ? last : 0;
  };
  const monthlyValueAt = (block: StatementBlock, rowIdx: number, monthIdx: number): number => {
    const row = block.rows[rowIdx];
    if (!row) return 0;
    // Column 0 is the label; columns 1..months.length are months; last (if present) is Total.
    const v = row[monthIdx + 1];
    return typeof v === 'number' ? v : 0;
  };

  const isPercent = (i: number) => !!meta[i]?.isPercent;

  if (viewMode === 'yearly') {
    return (
      <div
        className="rounded-lg overflow-x-auto"
        style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
      >
        <table className="w-full text-sm" style={{ minWidth: 640 }}>
          <thead>
            <tr style={{ background: 'var(--mt-bg-raised)' }}>
              <th className="text-left px-4 py-2 font-medium sticky left-0" style={{ background: 'var(--mt-bg-raised)', color: 'var(--mt-text-muted)', minWidth: 240 }}>
                Line item
              </th>
              <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--mt-text-muted)' }}>
                {base.scenario.name} <span style={{ fontSize: 10, color: 'var(--mt-text-faint)' }}>(base)</span>
              </th>
              {others.map(o => (
                <th key={o.scenario.id} colSpan={3} className="text-right px-4 py-2 font-medium" style={{ color: 'var(--mt-text-muted)', borderLeft: '1px solid var(--mt-border)' }}>
                  {o.scenario.name}
                </th>
              ))}
            </tr>
            <tr style={{ background: 'var(--mt-bg-raised)', fontSize: 11 }}>
              <th className="sticky left-0" style={{ background: 'var(--mt-bg-raised)' }} />
              <th />
              {others.map(o => (
                <Fragment key={`hdr-${o.scenario.id}`}>
                  <th className="text-right px-2 py-1 font-normal" style={{ color: 'var(--mt-text-faint)', borderLeft: '1px solid var(--mt-border)' }}>Value</th>
                  <th className="text-right px-2 py-1 font-normal" style={{ color: 'var(--mt-text-faint)' }}>∆</th>
                  <th className="text-right px-2 py-1 font-normal" style={{ color: 'var(--mt-text-faint)' }}>∆%</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label, i) => {
              const m = meta[i] || {};
              const isSection = m.isSection;
              const isTotal = m.isTotal;
              const pct = isPercent(i);

              const baseVal = yearlyValueAt(base.block, i);
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
                  <td className="px-4 py-1.5 sticky left-0" style={{
                    background: isTotal ? 'color-mix(in srgb, var(--mt-accent) 6%, var(--mt-bg-surface))' :
                                 isSection ? 'var(--mt-bg-raised)' : 'var(--mt-bg-surface)',
                    color: 'var(--mt-text-heading)',
                    whiteSpace: 'nowrap',
                  }}>
                    {label}
                  </td>
                  <td className="px-4 py-1.5 text-right mt-num" style={{ color: 'var(--mt-text-heading)' }}>
                    {isSection ? '' : formatNum(baseVal, pct)}
                  </td>
                  {others.map(o => {
                    const v = yearlyValueAt(o.block, i);
                    const delta = pct ? (v - baseVal) : (v - baseVal);
                    const dPct = baseVal !== 0 ? ((v - baseVal) / Math.abs(baseVal)) * 100 : 0;
                    return (
                      <Fragment key={`row-${i}-${o.scenario.id}`}>
                        <td className="px-2 py-1.5 text-right mt-num" style={{ borderLeft: '1px solid var(--mt-border)', color: 'var(--mt-text-heading)' }}>
                          {isSection ? '' : formatNum(v, pct)}
                        </td>
                        <td className="px-2 py-1.5 text-right mt-num" style={{ color: deltaColor(delta) }}>
                          {isSection ? '' : formatNum(delta, pct)}
                        </td>
                        <td className="px-2 py-1.5 text-right mt-num" style={{ color: deltaColor(delta) }}>
                          {isSection || baseVal === 0 ? '' : formatNum(dPct, true)}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // Monthly mode: show the months for each scenario stacked. Keep it scannable
  // by limiting to base + first non-base scenario; if more are picked, show a
  // hint to switch to yearly.
  if (others.length > 1) {
    return (
      <div
        className="px-4 py-3 rounded-lg text-sm"
        style={{
          background: 'color-mix(in srgb, #3b82f6 10%, transparent)',
          border: '1px solid color-mix(in srgb, #3b82f6 30%, transparent)',
          color: 'var(--mt-text-heading)',
        }}
      >
        Monthly comparison renders only base + 1 other scenario at a time. Switch to Yearly to see all selected scenarios at once.
      </div>
    );
  }
  const other = others[0];
  return (
    <div
      className="rounded-lg overflow-x-auto"
      style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
    >
      <table className="w-full text-sm" style={{ minWidth: 720 }}>
        <thead>
          <tr style={{ background: 'var(--mt-bg-raised)' }}>
            <th className="text-left px-4 py-2 font-medium sticky left-0" style={{ background: 'var(--mt-bg-raised)', color: 'var(--mt-text-muted)', minWidth: 200 }}>
              Line item
            </th>
            {months.map((_, i) => (
              <th key={`m-${i}`} className="text-right px-2 py-2 font-medium" style={{ color: 'var(--mt-text-muted)', fontSize: 11 }}>
                {String(base.block.header[i + 1] ?? '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, i) => {
            const m = meta[i] || {};
            const pct = isPercent(i);
            const isSection = m.isSection;
            const isTotal = m.isTotal;
            const baseRow = (
              <tr
                key={`b-${i}`}
                style={{
                  borderTop: '1px solid var(--mt-border)',
                  background: isTotal ? 'color-mix(in srgb, var(--mt-accent) 6%, transparent)' :
                               isSection ? 'var(--mt-bg-raised)' : 'transparent',
                  fontWeight: isSection || isTotal ? 600 : 400,
                }}
              >
                <td className="px-4 py-1.5 sticky left-0" style={{
                  background: isTotal ? 'color-mix(in srgb, var(--mt-accent) 6%, var(--mt-bg-surface))' :
                               isSection ? 'var(--mt-bg-raised)' : 'var(--mt-bg-surface)',
                  whiteSpace: 'nowrap',
                  color: 'var(--mt-text-heading)',
                }}>
                  {label} <span style={{ fontSize: 10, color: 'var(--mt-text-faint)', fontWeight: 400 }}>· {base.scenario.name}</span>
                </td>
                {months.map((_, mi) => (
                  <td key={`b-${i}-${mi}`} className="px-2 py-1.5 text-right mt-num" style={{ color: 'var(--mt-text-heading)' }}>
                    {isSection ? '' : formatNum(monthlyValueAt(base.block, i, mi), pct)}
                  </td>
                ))}
              </tr>
            );
            const otherRow = (
              <tr
                key={`o-${i}`}
                style={{
                  background: isSection ? 'var(--mt-bg-raised)' : 'transparent',
                  fontWeight: isSection || isTotal ? 600 : 400,
                }}
              >
                <td className="px-4 py-1.5 sticky left-0" style={{
                  background: isTotal ? 'color-mix(in srgb, var(--mt-accent) 6%, var(--mt-bg-surface))' :
                               isSection ? 'var(--mt-bg-raised)' : 'var(--mt-bg-surface)',
                  whiteSpace: 'nowrap',
                  color: 'var(--mt-text-heading)',
                }}>
                  {label} <span style={{ fontSize: 10, color: 'var(--mt-text-faint)', fontWeight: 400 }}>· {other.scenario.name}</span>
                </td>
                {months.map((_, mi) => {
                  const v = monthlyValueAt(other.block, i, mi);
                  const b = monthlyValueAt(base.block, i, mi);
                  const delta = v - b;
                  return (
                    <td key={`o-${i}-${mi}`} className="px-2 py-1.5 text-right mt-num" style={{ color: deltaColor(delta) }}>
                      {isSection ? '' : formatNum(v, pct)}
                    </td>
                  );
                })}
              </tr>
            );
            return [baseRow, otherRow];
          }).flat()}
        </tbody>
      </table>
    </div>
  );
}

function deltaColor(d: number): string {
  if (d === 0) return 'var(--mt-text-muted)';
  // Up is good for revenue/margins; we don't know the row semantics here, so
  // green = positive, red = negative. Reader infers semantics from the row label.
  return d > 0 ? '#16a34a' : '#dc2626';
}
