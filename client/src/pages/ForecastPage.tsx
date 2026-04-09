import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import { formatINR, getMonthLabel } from '../utils/format';

interface FY { id: number; label: string; start_date: string; is_active?: number; }

function getFYMonths(startDate: string): string[] {
  const startYear = parseInt(startDate.slice(0, 4));
  const months: string[] = [];
  for (let m = 4; m <= 12; m++) months.push(`${startYear}-${String(m).padStart(2, '0')}`);
  for (let m = 1; m <= 3; m++) months.push(`${startYear + 1}-${String(m).padStart(2, '0')}`);
  return months;
}

type GridData = Record<string, Record<string, { amount: number; source: string }>>;

export default function ForecastPage() {
  const [fys, setFYs] = useState<FY[]>([]);
  const [selectedFY, setSelectedFY] = useState<number | null>(null);
  const [streams, setStreams] = useState<any[]>([]);
  const [unit, setUnit] = useState('');
  const [grid, setGrid] = useState<GridData>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/settings/fy'),
      api.get('/streams'),
    ]).then(([fyRes, streamRes]) => {
      setFYs(fyRes.data);
      const active = fyRes.data.find((f: FY) => f.is_active);
      if (active) setSelectedFY(active.id);
      setStreams(streamRes.data);
      if (streamRes.data.length > 0) setUnit(streamRes.data[0].name);
    }).finally(() => setLoading(false));
  }, []);

  const loadForecast = useCallback(async () => {
    if (!selectedFY || !unit) return;
    const fcRes = await api.get('/forecasts', { params: { fy_id: selectedFY, business_unit: unit } });
    if (fcRes.data.length > 0) {
      const newGrid: GridData = {};
      fcRes.data.forEach((f: any) => {
        const key = f.department_id ? `${f.department_id}_${f.metric}` : f.metric;
        if (!newGrid[key]) newGrid[key] = {};
        newGrid[key][f.month] = { amount: f.amount, source: 'forecast' };
      });
      setGrid(newGrid);
    } else {
      const budgetRes = await api.get('/budgets', { params: { fy_id: selectedFY, business_unit: unit } });
      const newGrid: GridData = {};
      budgetRes.data.forEach((b: any) => {
        const key = b.department_id ? `${b.department_id}_${b.metric}` : b.metric;
        if (!newGrid[key]) newGrid[key] = {};
        newGrid[key][b.month] = { amount: b.amount, source: 'budget' };
      });
      setGrid(newGrid);
    }
  }, [selectedFY, unit]);

  useEffect(() => { loadForecast(); }, [loadForecast]);

  const activeFY = fys.find(f => f.id === selectedFY);
  const months = activeFY ? getFYMonths(activeFY.start_date) : [];
  const currentMonth = new Date().toISOString().slice(0, 7);

  // Generic rows — revenue and volume metrics for any stream
  const rows = [
    { key: 'revenue', label: `${unit} - Revenue`, deptId: null, metric: 'revenue' },
    { key: 'volume', label: `${unit} - Volume`, deptId: null, metric: 'volume' },
    { key: 'direct_costs', label: `${unit} - Direct Costs`, deptId: null, metric: 'direct_costs' },
    { key: 'gross_profit', label: `${unit} - Gross Profit`, deptId: null, metric: 'gross_profit' },
  ];

  const updateCell = (rowKey: string, month: string, value: string) => {
    const num = parseFloat(value) || 0;
    setGrid(prev => ({
      ...prev,
      [rowKey]: {
        ...(prev[rowKey] || {}),
        [month]: { amount: num, source: 'edited' },
      },
    }));
    setSaved(false);
  };

  const getRowTotal = (rowKey: string) =>
    months.reduce((sum, m) => sum + (grid[rowKey]?.[m]?.amount || 0), 0);

  const save = async () => {
    if (!selectedFY) return;
    setSaving(true);
    try {
      const entries: any[] = [];
      rows.forEach(row => {
        months.forEach(month => {
          entries.push({
            month,
            department_id: row.deptId,
            metric: row.metric,
            amount: grid[row.key]?.[month]?.amount || 0,
          });
        });
      });
      await api.post('/forecasts', { fy_id: selectedFY, business_unit: unit, entries });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save forecast');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="text-theme-muted">Loading...</div>
    </div>
  );

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-theme-heading">Forecast</h1>
          <p className="text-theme-faint mt-1 text-sm">Revised projections based on actuals + future estimates</p>
        </div>
        <div className="flex gap-3">
          <select value={selectedFY || ''} onChange={e => setSelectedFY(Number(e.target.value))} className="input w-48">
            {fys.map(fy => <option key={fy.id} value={fy.id}>{fy.label}</option>)}
          </select>
          {streams.length > 1 && (
            <div className="flex bg-dark-600 rounded-xl p-1 border border-dark-400/50">
              {streams.map((s: any) => (
                <button key={s.id} onClick={() => setUnit(s.name)} className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${unit === s.name ? 'bg-accent-500/15 text-accent-400' : 'text-theme-faint'}`}>{s.name}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex gap-4 mb-4 text-xs">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-500/20 border border-blue-500/30"></span> <span className="text-theme-muted">Budget</span></span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500/20 border border-emerald-500/30"></span> <span className="text-theme-muted">Actual/Forecast</span></span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-500/20 border border-amber-500/30"></span> <span className="text-theme-muted">Edited</span></span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-dark-400/50">
              <th className="text-left py-3 px-3 font-semibold text-theme-secondary sticky left-0 bg-dark-700 min-w-[200px]">Category</th>
              {months.map(m => (
                <th key={m} className={`text-right py-3 px-2 font-semibold min-w-[100px] ${m <= currentMonth ? 'text-theme-secondary' : 'text-theme-faint'}`}>
                  {getMonthLabel(m)}
                  {m <= currentMonth && <div className="text-[10px] font-normal text-accent-400">actual</div>}
                </th>
              ))}
              <th className="text-right py-3 px-3 font-semibold text-theme-secondary bg-dark-600 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key} className="border-b border-dark-400/30">
                <td className="py-2 px-3 font-medium text-theme-secondary sticky left-0 bg-dark-700">{row.label}</td>
                {months.map(m => {
                  const cell = grid[row.key]?.[m];
                  const bg = cell?.source === 'edited' ? 'bg-amber-500/5' : cell?.source === 'forecast' || cell?.source === 'actual' ? 'bg-emerald-500/5' : 'bg-blue-500/5';
                  return (
                    <td key={m} className={`py-1 px-1 ${cell ? bg : ''}`}>
                      <input
                        type="number"
                        value={cell?.amount ?? ''}
                        onChange={e => updateCell(row.key, m, e.target.value)}
                        placeholder="0"
                        className="w-full text-right px-2 py-1.5 border border-transparent hover:border-dark-300 focus:border-accent-500/50 focus:ring-1 focus:ring-accent-500/50 rounded-lg text-sm outline-none bg-transparent text-theme-primary placeholder-slate-600"
                      />
                    </td>
                  );
                })}
                <td className="py-2 px-3 text-right font-semibold text-theme-heading bg-dark-600">
                  {row.metric === 'footfall' || row.metric === 'transactions'
                    ? getRowTotal(row.key).toLocaleString('en-IN')
                    : formatINR(getRowTotal(row.key))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4 mt-4">
        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? 'Saving...' : 'Save Forecast'}
        </button>
        {saved && <span className="text-emerald-400 text-sm">Forecast saved!</span>}
      </div>
    </div>
  );
}
