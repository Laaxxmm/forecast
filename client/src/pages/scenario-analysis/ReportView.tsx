import { useEffect, useMemo, useState } from 'react';
import { FileDown, FileText } from 'lucide-react';
import api from '../../api/client';
import { FY, Scenario, ForecastItem, getFYMonths } from '../ForecastModulePage';
import ScenarioPicker from '../../components/scenario-analysis/ScenarioPicker';
import {
  buildComparisonWorkbook, ComparisonScenarioInput,
} from '../../utils/comparisonWorkbook';
import { buildComparisonPdf } from '../../utils/comparisonPdf';

interface Props {
  disabled: boolean;
  fy: FY | null;
  scenarios: Scenario[];
}

export default function ReportView({ disabled, fy, scenarios }: Props) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [baseId, setBaseId] = useState<number | null>(null);
  const [includeDelta, setIncludeDelta] = useState(true);
  const [includeDeltaPct, setIncludeDeltaPct] = useState(true);
  const [data, setData] = useState<ComparisonScenarioInput[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null);

  // Default to the first 2 scenarios on first load.
  useEffect(() => {
    if (disabled || scenarios.length < 2) return;
    if (selectedIds.length === 0) {
      const ids = scenarios.slice(0, 2).map(s => s.id);
      setSelectedIds(ids);
      setBaseId(ids[0]);
    }
  }, [disabled, scenarios.length, selectedIds.length]);

  // Stabilize `scenarios` lookup by id so we don't refetch when the parent
  // re-renders with a fresh array reference but unchanged contents.
  const scenariosById = useMemo(() => {
    const m = new Map<number, Scenario>();
    for (const s of scenarios) m.set(s.id, s);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios.map(s => `${s.id}:${s.name}:${s.is_default}`).join('|')]);

  // Pull the data we need to assemble the report.
  useEffect(() => {
    if (disabled || selectedIds.length < 2) { setData([]); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all(selectedIds.map(async id => {
      const scenario = scenariosById.get(id);
      if (!scenario) return null;
      const [iRes, vRes, sRes] = await Promise.all([
        api.get('/forecast-module/items', { params: { scenario_id: id } }),
        api.get('/forecast-module/values', { params: { scenario_id: id } }),
        api.get('/forecast-module/settings', { params: { scenario_id: id } }),
      ]);
      if (cancelled) return null;
      const valMap: Record<number, Record<string, number>> = {};
      (vRes.data || []).forEach((v: any) => {
        if (!valMap[v.item_id]) valMap[v.item_id] = {};
        valMap[v.item_id][v.month] = v.amount;
      });
      const ci: ComparisonScenarioInput = {
        scenario,
        items: iRes.data as ForecastItem[],
        allValues: valMap,
        benefitsPct: Number(sRes.data?.employee_benefits_pct ?? 0),
      };
      return ci;
    })).then(results => {
      if (cancelled) return;
      setData(results.filter((r): r is ComparisonScenarioInput => !!r));
    }).catch(e => console.error('ReportView load failed:', e))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, selectedIds.join(','), scenariosById]);

  // Hooks must run unconditionally — keep useMemo above the empty-state guards.
  const months = useMemo(() => fy ? getFYMonths(fy.start_date) : [], [fy]);
  const branchName = (typeof window !== 'undefined' && localStorage.getItem('branch_name')) || undefined;
  const streamName = (typeof window !== 'undefined' && localStorage.getItem('stream_name')) || undefined;

  if (disabled) return null;
  if (scenarios.length < 2) {
    return (
      <div
        className="px-6 py-12 rounded-lg text-center"
        style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--mt-text-heading)', marginBottom: 4 }}>
          Need at least 2 scenarios for a report
        </div>
        <div style={{ fontSize: 13, color: 'var(--mt-text-muted)' }}>
          Create another scenario in the <strong>Manage</strong> tab first.
        </div>
      </div>
    );
  }

  const handleExcel = async () => {
    if (!baseId || data.length < 2) return;
    setBusy('xlsx');
    try {
      const blob = await buildComparisonWorkbook({
        scenarios: data, baseId, months, fy, branchName, streamName,
        includeDelta, includeDeltaPct,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const fyTag = fy?.label ? `_${fy.label.replace(/\s+/g, '_')}` : '';
      link.download = `Scenario_Comparison${fyTag}.xlsx`;
      link.click();
      // Defer revoke so older Edge / Safari finish reading the blob before
      // the URL is freed. Synchronous revoke after click() can race in some
      // browsers and produce a corrupted/empty download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      console.error('Excel export failed:', e);
      alert('Could not generate the Excel workbook. Check the browser console for details.');
    } finally {
      setBusy(null);
    }
  };

  const handlePdf = async () => {
    if (!baseId || data.length < 2) return;
    setBusy('pdf');
    try {
      const doc = buildComparisonPdf({
        scenarios: data, baseId, months, fy, branchName, streamName,
        includeDelta, includeDeltaPct,
      });
      const fyTag = fy?.label ? `_${fy.label.replace(/\s+/g, '_')}` : '';
      doc.save(`Scenario_Comparison${fyTag}.pdf`);
    } catch (e: any) {
      console.error('PDF export failed:', e);
      alert('Could not generate the PDF. Check the browser console for details.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ScenarioPicker
        scenarios={scenarios}
        selected={selectedIds}
        baseId={baseId}
        onChange={(ids, base) => { setSelectedIds(ids); setBaseId(base); }}
      />

      <div
        className="rounded-lg p-4"
        style={{ background: 'var(--mt-bg-surface)', border: '1px solid var(--mt-border)' }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mt-text-heading)', marginBottom: 4 }}>Report options</div>
        <div className="flex flex-wrap items-center gap-4 mt-2">
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--mt-text-muted)' }}>
            <input type="checkbox" checked={includeDelta} onChange={e => setIncludeDelta(e.target.checked)} />
            Include ∆ columns
          </label>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--mt-text-muted)' }}>
            <input type="checkbox" checked={includeDeltaPct} onChange={e => setIncludeDeltaPct(e.target.checked)} />
            Include ∆% columns
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleExcel}
          className="mt-btn-gradient"
          style={{ padding: '8px 16px', fontSize: 13 }}
          disabled={loading || busy !== null || data.length < 2 || baseId == null}
        >
          <FileDown size={14} />
          {busy === 'xlsx' ? 'Building Excel…' : 'Download Excel'}
        </button>
        <button
          onClick={handlePdf}
          className="mt-btn-ghost"
          style={{ padding: '8px 16px', fontSize: 13, border: '1px solid var(--mt-border)' }}
          disabled={loading || busy !== null || data.length < 2 || baseId == null}
        >
          <FileText size={14} />
          {busy === 'pdf' ? 'Building PDF…' : 'Download PDF'}
        </button>
        {loading && <span style={{ fontSize: 12, color: 'var(--mt-text-muted)' }}>Loading scenario data…</span>}
      </div>

      <div style={{ fontSize: 12, color: 'var(--mt-text-faint)' }}>
        The report includes Profit & Loss, Balance Sheet, and Cash Flow rows for each picked scenario, with variance versus the base scenario.
      </div>
    </div>
  );
}
