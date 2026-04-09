import { useEffect, useState } from 'react';
import api from '../api/client';
import { formatINR, getMonthLabel } from '../utils/format';

interface FY { id: number; label: string; start_date: string; is_active?: number; }
interface Dept { id: number; name: string; display_name: string; business_unit: string; }

function getFYMonths(startDate: string): string[] {
  const startYear = parseInt(startDate.slice(0, 4));
  const months: string[] = [];
  for (let m = 4; m <= 12; m++) months.push(`${startYear}-${String(m).padStart(2, '0')}`);
  for (let m = 1; m <= 3; m++) months.push(`${startYear + 1}-${String(m).padStart(2, '0')}`);
  return months;
}

type GridData = Record<string, Record<string, number>>;

export default function BudgetPage() {
  const [fys, setFYs] = useState<FY[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [streams, setStreams] = useState<any[]>([]);
  const [selectedFY, setSelectedFY] = useState<number | null>(null);
  const [unit, setUnit] = useState('');
  const [grid, setGrid] = useState<GridData>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/settings/fy'),
      api.get('/settings/departments'),
      api.get('/streams'),
    ]).then(([fyRes, deptRes, streamRes]) => {
      setFYs(fyRes.data);
      setDepts(deptRes.data);
      setStreams(streamRes.data);
      const active = fyRes.data.find((f: FY) => f.is_active);
      if (active) setSelectedFY(active.id);
      if (streamRes.data.length > 0) setUnit(streamRes.data[0].name);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedFY) return;
    api.get('/budgets', { params: { fy_id: selectedFY, business_unit: unit } }).then(res => {
      const newGrid: GridData = {};
      res.data.forEach((b: any) => {
        const key = b.department_id ? `${b.department_id}_${b.metric}` : b.metric;
        if (!newGrid[key]) newGrid[key] = {};
        newGrid[key][b.month] = b.amount;
      });
      setGrid(newGrid);
    });
  }, [selectedFY, unit]);

  const activeFY = fys.find(f => f.id === selectedFY);
  const months = activeFY ? getFYMonths(activeFY.start_date) : [];
  // Get departments for the current stream/unit
  const unitDepts = depts.filter(d => d.business_unit === unit);

  // Build rows: if departments exist for this stream, use them; otherwise generic rows
  const rows = unitDepts.length > 0
    ? unitDepts.flatMap(d => [
        { key: `${d.id}_revenue`, label: `${d.display_name} - Revenue`, deptId: d.id, metric: 'revenue' },
        { key: `${d.id}_volume`, label: `${d.display_name} - Volume`, deptId: d.id, metric: 'volume' },
      ])
    : [
        { key: 'revenue', label: `${unit} - Revenue`, deptId: null, metric: 'revenue' },
        { key: 'direct_costs', label: `${unit} - Direct Costs`, deptId: null, metric: 'direct_costs' },
        { key: 'gross_profit', label: `${unit} - Gross Profit`, deptId: null, metric: 'gross_profit' },
        { key: 'volume', label: `${unit} - Volume`, deptId: null, metric: 'volume' },
      ];

  const updateCell = (rowKey: string, month: string, value: string) => {
    const num = parseFloat(value) || 0;
    setGrid(prev => ({
      ...prev,
      [rowKey]: { ...(prev[rowKey] || {}), [month]: num },
    }));
    setSaved(false);
  };

  const getRowTotal = (rowKey: string) =>
    months.reduce((sum, m) => sum + (grid[rowKey]?.[m] || 0), 0);

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
            amount: grid[row.key]?.[month] || 0,
          });
        });
      });
      await api.post('/budgets', { fy_id: selectedFY, business_unit: unit, entries });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to save budget');
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
          <h1 className="text-2xl font-bold text-theme-heading">Budget</h1>
          <p className="text-theme-faint mt-1 text-sm">Create and manage annual budgets</p>
        </div>
        <div className="flex gap-3">
          <select
            value={selectedFY || ''}
            onChange={e => setSelectedFY(Number(e.target.value))}
            className="input w-48"
          >
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
        <table className="text-sm border-collapse" style={{ minWidth: '100%' }}>
          <thead>
            <tr className="border-b border-dark-400/50">
              <th className="text-left py-3 px-3 font-semibold text-theme-secondary sticky left-0 z-10 bg-dark-700 min-w-[220px] whitespace-nowrap">Category</th>
              {months.map(m => (
                <th key={m} className="text-right py-3 px-2 font-semibold text-theme-muted min-w-[100px] whitespace-nowrap">{getMonthLabel(m)}</th>
              ))}
              <th className="text-right py-3 px-3 font-semibold text-theme-secondary bg-dark-600 min-w-[120px] whitespace-nowrap">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key} className="border-b border-dark-400/30 hover:bg-dark-600/50 transition-colors">
                <td className="py-2 px-3 font-medium text-theme-secondary sticky left-0 z-10 bg-dark-700 whitespace-nowrap">{row.label}</td>
                {months.map(m => (
                  <td key={m} className="py-1 px-1">
                    <input
                      type="number"
                      value={grid[row.key]?.[m] ?? ''}
                      onChange={e => updateCell(row.key, m, e.target.value)}
                      placeholder="0"
                      className="w-full text-right px-2 py-1.5 border border-transparent hover:border-dark-300 focus:border-accent-500/50 focus:ring-1 focus:ring-accent-500/50 rounded-lg text-sm outline-none bg-transparent text-theme-primary placeholder-slate-600"
                    />
                  </td>
                ))}
                <td className="py-2 px-3 text-right font-semibold text-theme-heading bg-dark-600">
                  {row.metric === 'footfall' || row.metric === 'qty_sold' || row.metric === 'transactions'
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
          {saving ? 'Saving...' : 'Save Budget'}
        </button>
        {saved && <span className="text-emerald-400 text-sm">Budget saved successfully!</span>}
      </div>
    </div>
  );
}
