/**
 * Budgets Page — Budget Editor + Budget vs Actual Variance
 * Dark theme, INR formatting, group & FY selectors
 */
import { useState, useEffect, useCallback } from 'react';
import { Save, TrendingUp, TrendingDown, Edit3, BarChart3, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import api from '../../api/client';

/* ── constants ── */
const LINE_ITEMS: { key: string; label: string; type: 'income' | 'expense' }[] = [
  { key: 'revenue',          label: 'Revenue',            type: 'income'  },
  { key: 'directIncome',     label: 'Direct Income',      type: 'income'  },
  { key: 'purchase',         label: 'Purchase',           type: 'expense' },
  { key: 'directExpenses',   label: 'Direct Expenses',    type: 'expense' },
  { key: 'indirectExpenses',  label: 'Indirect Expenses',  type: 'expense' },
  { key: 'indirectIncome',   label: 'Indirect Income',    type: 'income'  },
];

const MONTH_LABELS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

function fyMonths(fy: number): string[] {
  // FY 2025 → Apr 2025 … Mar 2026
  return MONTH_LABELS.map((_, i) => {
    const m = ((3 + i) % 12) + 1; // 4,5,...12,1,2,3
    const y = m >= 4 ? fy : fy + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
  });
}

function fmtINR(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '₹0';
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '0%';
  return n.toFixed(1) + '%';
}

/* ── types ── */
interface Group { id: number; name: string; }

interface VarianceRow {
  line_item: string;
  budget: number;
  actual: number;
  variance: number;
  variance_pct: number;
}

type BudgetGrid = Record<string, Record<string, number>>; // line_item -> period_month -> amount

/* ── component ── */
export default function BudgetsPage() {
  const [tab, setTab] = useState<'editor' | 'variance'>('editor');

  // shared state
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string>('');
  const [fy, setFy] = useState<number>(() => {
    const now = new Date();
    return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  });

  // editor state
  const [grid, setGrid] = useState<BudgetGrid>({});
  const [loadingEditor, setLoadingEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // variance state
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [varianceRows, setVarianceRows] = useState<VarianceRow[]>([]);
  const [loadingVariance, setLoadingVariance] = useState(false);

  /* ── load groups ── */
  useEffect(() => {
    api.get('/vcfo/groups')
      .then(r => {
        const list: Group[] = r.data || [];
        setGroups(list);
        if (list.length > 0 && !groupId) setGroupId(String(list[0].id));
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── default variance date range = current FY ── */
  useEffect(() => {
    setFromDate(`${fy}-04-01`);
    setToDate(`${fy + 1}-03-31`);
  }, [fy]);

  /* ── load budget entries for editor ── */
  const loadBudget = useCallback(() => {
    if (!groupId) return;
    setLoadingEditor(true);
    const months = fyMonths(fy);
    // fetch all 12 months
    Promise.all(
      months.map(m => api.get('/vcfo/budgets', { params: { groupId, period_month: m } }))
    )
      .then(responses => {
        const g: BudgetGrid = {};
        LINE_ITEMS.forEach(li => { g[li.key] = {}; });
        responses.forEach((r, idx) => {
          const entries: any[] = r.data || [];
          entries.forEach((e: any) => {
            if (g[e.line_item]) {
              g[e.line_item][months[idx]] = Number(e.amount) || 0;
            }
          });
        });
        setGrid(g);
      })
      .catch(() => {})
      .finally(() => setLoadingEditor(false));
  }, [groupId, fy]);

  useEffect(() => { if (tab === 'editor') loadBudget(); }, [tab, loadBudget]);

  /* ── load variance ── */
  const loadVariance = useCallback(() => {
    if (!groupId || !fromDate || !toDate) return;
    setLoadingVariance(true);
    api.get('/vcfo/budgets/variance', { params: { groupId, fromDate, toDate } })
      .then(r => setVarianceRows(r.data?.variance || []))
      .catch(() => {})
      .finally(() => setLoadingVariance(false));
  }, [groupId, fromDate, toDate]);

  useEffect(() => { if (tab === 'variance') loadVariance(); }, [tab, loadVariance]);

  /* ── save budget ── */
  const saveBudget = async () => {
    setSaving(true);
    setSaveMsg(null);
    const months = fyMonths(fy);
    const entries: any[] = [];
    LINE_ITEMS.forEach(li => {
      months.forEach(m => {
        const amt = grid[li.key]?.[m];
        if (amt !== undefined && amt !== 0) {
          entries.push({ group_id: Number(groupId), period_month: m, line_item: li.key, amount: amt });
        }
      });
    });
    try {
      await api.post('/vcfo/budgets', { entries });
      setSaveMsg({ type: 'ok', text: 'Budget saved successfully' });
      setTimeout(() => setSaveMsg(null), 3000);
    } catch {
      setSaveMsg({ type: 'err', text: 'Failed to save budget' });
    } finally {
      setSaving(false);
    }
  };

  /* ── cell change handler ── */
  const onCellChange = (lineItem: string, month: string, value: string) => {
    const num = value === '' ? 0 : Number(value);
    setGrid(prev => ({
      ...prev,
      [lineItem]: { ...prev[lineItem], [month]: isNaN(num) ? 0 : num },
    }));
  };

  /* ── row total helper ── */
  const rowTotal = (lineItem: string): number => {
    const row = grid[lineItem] || {};
    return Object.values(row).reduce((s, v) => s + (v || 0), 0);
  };

  /* ── FY options (last 5 years) ── */
  const fyOptions: number[] = [];
  const currentFy = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  for (let y = currentFy - 3; y <= currentFy + 1; y++) fyOptions.push(y);

  /* ── variance helpers ── */
  const isFavorable = (row: VarianceRow): boolean => {
    const li = LINE_ITEMS.find(l => l.key === row.line_item);
    if (!li) return row.variance >= 0;
    // for expenses: under-budget (negative variance) is favorable
    if (li.type === 'expense') return row.variance <= 0;
    // for income: over-budget (positive variance) is favorable
    return row.variance >= 0;
  };

  const getVarianceLabel = (row: VarianceRow): string => {
    return LINE_ITEMS.find(l => l.key === row.line_item)?.label || row.line_item;
  };

  /* ── render ── */
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-theme-heading">Budgets</h1>

        <div className="flex flex-wrap items-center gap-3">
          {/* Group selector */}
          <select
            value={groupId}
            onChange={e => setGroupId(e.target.value)}
            className="bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-sm text-theme-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>

          {/* FY selector */}
          <select
            value={fy}
            onChange={e => setFy(Number(e.target.value))}
            className="bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-sm text-theme-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {fyOptions.map(y => (
              <option key={y} value={y}>FY {y}-{String(y + 1).slice(-2)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-dark-800 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab('editor')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            tab === 'editor'
              ? 'bg-blue-600 text-white'
              : 'text-theme-muted hover:text-theme-primary hover:bg-dark-600'
          }`}
        >
          <Edit3 size={16} /> Budget Editor
        </button>
        <button
          onClick={() => setTab('variance')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            tab === 'variance'
              ? 'bg-blue-600 text-white'
              : 'text-theme-muted hover:text-theme-primary hover:bg-dark-600'
          }`}
        >
          <BarChart3 size={16} /> Variance Analysis
        </button>
      </div>

      {/* ─── BUDGET EDITOR TAB ─── */}
      {tab === 'editor' && (
        <div className="bg-dark-700 rounded-xl overflow-hidden">
          {/* Save bar */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-dark-500">
            <span className="text-sm text-theme-muted">
              Edit budget for each line item across 12 months (FY {fy}-{String(fy + 1).slice(-2)})
            </span>
            <div className="flex items-center gap-3">
              {saveMsg && (
                <span className={`flex items-center gap-1 text-sm ${saveMsg.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
                  {saveMsg.type === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                  {saveMsg.text}
                </span>
              )}
              <button
                onClick={saveBudget}
                disabled={saving || !groupId}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                {saving ? 'Saving…' : 'Save Budget'}
              </button>
            </div>
          </div>

          {/* Grid */}
          {loadingEditor ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-blue-400" />
              <span className="ml-2 text-theme-muted">Loading budget data…</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-dark-800">
                    <th className="text-left px-4 py-3 text-theme-muted font-medium sticky left-0 bg-dark-800 z-10 min-w-[160px]">
                      Line Item
                    </th>
                    {MONTH_LABELS.map((m, i) => (
                      <th key={i} className="text-right px-3 py-3 text-theme-muted font-medium min-w-[100px]">
                        {m} {fyMonths(fy)[i].slice(0, 4)}
                      </th>
                    ))}
                    <th className="text-right px-4 py-3 text-theme-muted font-semibold min-w-[110px]">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {LINE_ITEMS.map((li, rowIdx) => {
                    const months = fyMonths(fy);
                    return (
                      <tr
                        key={li.key}
                        className={`border-t border-dark-600 ${rowIdx % 2 === 0 ? 'bg-dark-700' : 'bg-dark-750'}`}
                      >
                        <td className="px-4 py-2 font-medium text-theme-primary sticky left-0 z-10" style={{ backgroundColor: 'inherit' }}>
                          <span className={`inline-block w-2 h-2 rounded-full mr-2 ${li.type === 'income' ? 'bg-green-400' : 'bg-red-400'}`} />
                          {li.label}
                        </td>
                        {months.map(m => (
                          <td key={m} className="px-2 py-1 text-right">
                            <input
                              type="number"
                              value={grid[li.key]?.[m] || ''}
                              onChange={e => onCellChange(li.key, m, e.target.value)}
                              placeholder="0"
                              className="w-full bg-dark-600 border border-dark-500 rounded px-2 py-1.5 text-right text-theme-primary text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 placeholder-dark-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                          </td>
                        ))}
                        <td className="px-4 py-2 text-right font-semibold text-theme-primary">
                          {fmtINR(rowTotal(li.key))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-dark-500 bg-dark-800">
                    <td className="px-4 py-3 font-semibold text-theme-heading sticky left-0 bg-dark-800 z-10">
                      Column Totals
                    </td>
                    {fyMonths(fy).map(m => {
                      const colTotal = LINE_ITEMS.reduce((s, li) => {
                        const isExp = li.type === 'expense';
                        const val = grid[li.key]?.[m] || 0;
                        return s + (isExp ? -val : val);
                      }, 0);
                      return (
                        <td key={m} className={`px-3 py-3 text-right font-semibold ${colTotal >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {fmtINR(colTotal)}
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-right font-bold text-theme-heading">
                      {fmtINR(
                        LINE_ITEMS.reduce((s, li) => {
                          const isExp = li.type === 'expense';
                          return s + (isExp ? -rowTotal(li.key) : rowTotal(li.key));
                        }, 0)
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ─── VARIANCE TAB ─── */}
      {tab === 'variance' && (
        <div className="space-y-4">
          {/* Date range */}
          <div className="bg-dark-700 rounded-xl px-5 py-4 flex flex-wrap items-center gap-4">
            <label className="text-sm text-theme-muted">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="bg-dark-600 border border-dark-500 rounded-lg px-3 py-2 text-sm text-theme-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <label className="text-sm text-theme-muted">To</label>
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="bg-dark-600 border border-dark-500 rounded-lg px-3 py-2 text-sm text-theme-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={loadVariance}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Refresh
            </button>
          </div>

          {/* Variance table */}
          <div className="bg-dark-700 rounded-xl overflow-hidden">
            {loadingVariance ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={24} className="animate-spin text-blue-400" />
                <span className="ml-2 text-theme-muted">Loading variance data…</span>
              </div>
            ) : varianceRows.length === 0 ? (
              <div className="text-center py-16 text-theme-muted">
                <BarChart3 size={40} className="mx-auto mb-3 opacity-40" />
                <p>No variance data available for the selected period.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-dark-800">
                      <th className="text-left px-5 py-3 text-theme-muted font-medium">Line Item</th>
                      <th className="text-right px-5 py-3 text-theme-muted font-medium">Budget</th>
                      <th className="text-right px-5 py-3 text-theme-muted font-medium">Actual</th>
                      <th className="text-right px-5 py-3 text-theme-muted font-medium">Variance</th>
                      <th className="text-right px-5 py-3 text-theme-muted font-medium">Var %</th>
                      <th className="text-center px-5 py-3 text-theme-muted font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {varianceRows.map((row, i) => {
                      const favorable = isFavorable(row);
                      const colorCls = favorable ? 'text-green-400' : 'text-red-400';
                      return (
                        <tr key={i} className={`border-t border-dark-600 ${i % 2 === 0 ? 'bg-dark-700' : 'bg-dark-750'}`}>
                          <td className="px-5 py-3 font-medium text-theme-primary">
                            {getVarianceLabel(row)}
                          </td>
                          <td className="px-5 py-3 text-right text-theme-primary">
                            {fmtINR(row.budget)}
                          </td>
                          <td className="px-5 py-3 text-right text-theme-primary">
                            {fmtINR(row.actual)}
                          </td>
                          <td className={`px-5 py-3 text-right font-semibold ${colorCls}`}>
                            {fmtINR(row.variance)}
                          </td>
                          <td className={`px-5 py-3 text-right font-semibold ${colorCls}`}>
                            {fmtPct(row.variance_pct)}
                          </td>
                          <td className="px-5 py-3 text-center">
                            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                              favorable
                                ? 'bg-green-500/15 text-green-400'
                                : 'bg-red-500/15 text-red-400'
                            }`}>
                              {favorable
                                ? <><TrendingUp size={12} /> Favorable</>
                                : <><TrendingDown size={12} /> Unfavorable</>
                              }
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
