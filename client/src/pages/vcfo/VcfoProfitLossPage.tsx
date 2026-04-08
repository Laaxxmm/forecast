/**
 * Profit & Loss Statement — Matches TallyVision Table View style
 * Hierarchical P&L with collapsible groups, summary row, monthly comparison
 */
import { useState, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../api/client';

interface PLItem { ledger_name: string; group_name: string; amount: number; }
interface PLSection { title: string; items: PLItem[]; total: number; }
interface PLData {
  source: string; sections: PLSection[]; noData?: boolean;
  summary: { grossProfit: number; netProfit: number; grossProfitMargin: number; netProfitMargin: number; };
}
interface MonthlyPL {
  month: string; revenue: number; directExpenses: number; indirectIncome: number;
  indirectExpenses: number; grossProfit: number; netProfit: number;
}

function fmtFull(n: number): string { return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n); }
function fmt(n: number): string {
  if (!n) return '0';
  const abs = Math.abs(n); const sign = n < 0 ? '-' : '';
  if (abs >= 10000000) return sign + (abs / 10000000).toFixed(2) + ' Cr';
  if (abs >= 100000) return sign + (abs / 100000).toFixed(2) + ' L';
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + ' K';
  return sign + abs.toFixed(0);
}

export default function VcfoProfitLossPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [data, setData] = useState<PLData | null>(null);
  const [monthly, setMonthly] = useState<MonthlyPL[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0, 1, 2, 3]));
  const [view, setView] = useState<'statement' | 'monthly'>('statement');

  useEffect(() => {
    const now = new Date();
    const fyStart = now.getMonth() >= 3 ? new Date(now.getFullYear(), 3, 1) : new Date(now.getFullYear() - 1, 3, 1);
    const fyEnd = new Date(fyStart.getFullYear() + 1, 2, 31);
    setFromDate(fyStart.toISOString().split('T')[0]);
    setToDate(fyEnd.toISOString().split('T')[0]);
  }, []);

  useEffect(() => {
    api.get('/vcfo/companies').then(r => { setCompanies(r.data || []); if (r.data?.length > 0) setCompanyId(String(r.data[0].id)); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!fromDate || !toDate) return;
    setLoading(true);
    const params: any = { from: fromDate, to: toDate };
    if (companyId) params.companyId = companyId;
    Promise.all([
      api.get('/vcfo/reports/profit-loss', { params }),
      api.get('/vcfo/reports/profit-loss/monthly', { params }),
    ]).then(([r1, r2]) => { setData(r1.data); setMonthly(r2.data); }).catch(() => {}).finally(() => setLoading(false));
  }, [companyId, fromDate, toDate]);

  const toggleSection = (idx: number) => {
    setExpandedSections(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
  };

  const groupedItems = useMemo(() => {
    if (!data) return [];
    return data.sections.map(section => {
      const groups: Record<string, { items: PLItem[]; total: number }> = {};
      for (const item of section.items) {
        if (!groups[item.group_name]) groups[item.group_name] = { items: [], total: 0 };
        groups[item.group_name].items.push(item);
        groups[item.group_name].total += item.amount;
      }
      return { ...section, groups };
    });
  }, [data]);

  const sectionBorders = ['border-l-indigo-500', 'border-l-red-500', 'border-l-emerald-500', 'border-l-amber-500'];

  return (
    <div className="space-y-5">
      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="card-tv p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-theme-heading">Profit & Loss Statement</h1>
            <p className="text-xs text-theme-faint mt-0.5">Revenue, expenses, and profitability analysis</p>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setView('statement')} className={`tv-tab ${view === 'statement' ? 'active' : ''}`}>Statement</button>
            <button onClick={() => setView('monthly')} className={`tv-tab ${view === 'monthly' ? 'active' : ''}`}>Monthly</button>
          </div>
        </div>
      </div>

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">Filters</span>
        <select value={companyId} onChange={e => setCompanyId(e.target.value)} className="tv-input min-w-[160px]">
          <option value="">All Companies</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="tv-input" />
        <span className="text-theme-faint text-xs">to</span>
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="tv-input" />
      </div>

      {loading && <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" /></div>}

      {!loading && data && view === 'statement' && (
        <>
          {/* Summary KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Gross Profit</div>
              <div className={`text-xl font-bold ${data.summary.grossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(data.summary.grossProfit)}</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Net Profit</div>
              <div className={`text-xl font-bold ${data.summary.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(data.summary.netProfit)}</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">GP Margin</div>
              <div className={`text-xl font-bold ${data.summary.grossProfitMargin >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{data.summary.grossProfitMargin.toFixed(1)}%</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">NP Margin</div>
              <div className={`text-xl font-bold ${data.summary.netProfitMargin >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{data.summary.netProfitMargin.toFixed(1)}%</div>
            </div>
          </div>

          {/* P&L Sections */}
          {groupedItems.map((section, idx) => (
            <div key={idx} className={`card-tv overflow-hidden border-l-4 ${sectionBorders[idx]}`}>
              <button onClick={() => toggleSection(idx)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-[rgb(var(--c-dark-600)/0.5)] transition-colors">
                <div className="flex items-center gap-2">
                  {expandedSections.has(idx) ? <ChevronDown size={16} className="text-theme-faint" /> : <ChevronRight size={16} className="text-theme-faint" />}
                  <span className="text-sm font-semibold text-theme-heading">{section.title}</span>
                  <span className="text-[10px] text-theme-faint">({section.items.length} items)</span>
                </div>
                <span className={`text-sm font-bold ${section.total >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtFull(Math.abs(section.total))}</span>
              </button>
              {expandedSections.has(idx) && (
                <div style={{ borderTop: '1px solid rgb(var(--c-dark-400) / 0.3)' }}>
                  {Object.entries(section.groups).map(([groupName, group]) => (
                    <div key={groupName}>
                      <div className="flex items-center justify-between px-5 py-2" style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.3)' }}>
                        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">{groupName}</span>
                        <span className="text-xs font-semibold text-theme-secondary">{fmtFull(Math.abs(group.total))}</span>
                      </div>
                      {group.items.map((item, i) => (
                        <div key={i} className="flex items-center justify-between px-5 py-1.5 pl-10 hover:bg-[rgb(var(--c-dark-600)/0.2)]">
                          <span className="text-xs text-theme-secondary truncate max-w-[60%]">{item.ledger_name}</span>
                          <span className="text-xs text-theme-primary font-mono">{fmtFull(Math.abs(item.amount))}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Profit Summary Row */}
          <div className="card-tv overflow-hidden border-l-4 border-l-emerald-500">
            <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid rgb(var(--c-dark-400) / 0.3)' }}>
              <span className="text-sm font-bold text-theme-heading">Gross Profit</span>
              <span className={`text-sm font-bold ${data.summary.grossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtFull(data.summary.grossProfit)}</span>
            </div>
            <div className="flex items-center justify-between px-5 py-4" style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.3)' }}>
              <span className="text-base font-bold text-theme-heading">Net Profit</span>
              <span className={`text-lg font-extrabold ${data.summary.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtFull(data.summary.netProfit)}</span>
            </div>
          </div>

          {data.source === 'trial_balance' && (
            <p className="text-xs text-amber-400 text-center">Data sourced from Trial Balance (P&L data not available for this period)</p>
          )}
        </>
      )}

      {/* Monthly Comparison */}
      {!loading && view === 'monthly' && monthly.length > 0 && (
        <div className="card-tv overflow-x-auto">
          <table className="tv-table">
            <thead>
              <tr>
                <th>Month</th><th className="text-right">Revenue</th><th className="text-right">Direct Exp.</th>
                <th className="text-right">Gross Profit</th><th className="text-right">Indirect Inc.</th>
                <th className="text-right">Indirect Exp.</th><th className="text-right">Net Profit</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m, i) => (
                <tr key={i}>
                  <td className="font-medium">{new Date(m.month + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</td>
                  <td className="text-right font-mono">{fmt(m.revenue)}</td>
                  <td className="text-right font-mono text-red-400">{fmt(m.directExpenses)}</td>
                  <td className={`text-right font-mono font-semibold ${m.grossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(m.grossProfit)}</td>
                  <td className="text-right font-mono">{fmt(m.indirectIncome)}</td>
                  <td className="text-right font-mono text-red-400">{fmt(m.indirectExpenses)}</td>
                  <td className={`text-right font-mono font-bold ${m.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmt(m.netProfit)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.5)' }}>
                <td className="font-bold text-theme-heading">Total</td>
                <td className="text-right font-mono font-bold">{fmt(monthly.reduce((s, m) => s + m.revenue, 0))}</td>
                <td className="text-right font-mono font-bold text-red-400">{fmt(monthly.reduce((s, m) => s + m.directExpenses, 0))}</td>
                <td className="text-right font-mono font-bold text-emerald-400">{fmt(monthly.reduce((s, m) => s + m.grossProfit, 0))}</td>
                <td className="text-right font-mono font-bold">{fmt(monthly.reduce((s, m) => s + m.indirectIncome, 0))}</td>
                <td className="text-right font-mono font-bold text-red-400">{fmt(monthly.reduce((s, m) => s + m.indirectExpenses, 0))}</td>
                <td className="text-right font-mono font-bold text-emerald-400">{fmt(monthly.reduce((s, m) => s + m.netProfit, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!loading && view === 'monthly' && monthly.length === 0 && (
        <div className="card-tv p-12 text-center text-theme-faint text-sm">No monthly data available</div>
      )}

      {!loading && data?.noData && (
        <div className="card-tv p-12 text-center text-theme-faint text-sm">No financial data found. Sync data from Tally first.</div>
      )}
    </div>
  );
}
