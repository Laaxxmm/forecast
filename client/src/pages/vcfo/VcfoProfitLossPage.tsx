import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, TrendingDown, ChevronDown, ChevronRight, DollarSign, Percent } from 'lucide-react';
import api from '../../api/client';

interface PLItem {
  ledger_name: string;
  group_name: string;
  amount: number;
}

interface PLSection {
  title: string;
  items: PLItem[];
  total: number;
}

interface PLData {
  source: string;
  sections: PLSection[];
  summary: {
    grossProfit: number;
    netProfit: number;
    grossProfitMargin: number;
    netProfitMargin: number;
  };
  noData?: boolean;
}

interface MonthlyPL {
  month: string;
  revenue: number;
  directExpenses: number;
  indirectIncome: number;
  indirectExpenses: number;
  grossProfit: number;
  netProfit: number;
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (abs >= 100000) return (n / 100000).toFixed(2) + ' L';
  if (abs >= 1000) return (n / 1000).toFixed(1) + ' K';
  return n.toFixed(0);
}

function fmtFull(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
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

  // Auto-calculate FY dates
  useEffect(() => {
    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? new Date(now.getFullYear(), 3, 1)
      : new Date(now.getFullYear() - 1, 3, 1);
    const fyEnd = new Date(fyStart.getFullYear() + 1, 2, 31);
    setFromDate(fyStart.toISOString().split('T')[0]);
    setToDate(fyEnd.toISOString().split('T')[0]);
  }, []);

  useEffect(() => {
    api.get('/vcfo/companies').then(r => {
      setCompanies(r.data);
      if (r.data.length > 0) setCompanyId(String(r.data[0].id));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!fromDate || !toDate) return;
    setLoading(true);
    const params: any = { from: fromDate, to: toDate };
    if (companyId) params.companyId = companyId;

    const p1 = api.get('/vcfo/reports/profit-loss', { params });
    const p2 = api.get('/vcfo/reports/profit-loss/monthly', { params });

    Promise.all([p1, p2]).then(([r1, r2]) => {
      setData(r1.data);
      setMonthly(r2.data);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [companyId, fromDate, toDate]);

  const toggleSection = (idx: number) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  // Group items by group_name within each section
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-theme-heading">Profit & Loss Statement</h1>
          <p className="text-sm text-theme-muted mt-0.5">Revenue, expenses, and profitability analysis</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('statement')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${view === 'statement' ? 'bg-accent-500 text-white' : 'bg-dark-600 text-theme-muted hover:text-theme-primary'}`}
          >
            Statement
          </button>
          <button
            onClick={() => setView('monthly')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${view === 'monthly' ? 'bg-accent-500 text-white' : 'bg-dark-600 text-theme-muted hover:text-theme-primary'}`}
          >
            Monthly
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-theme-muted mb-1">Company</label>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)}
              className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30 min-w-[180px]">
              <option value="">All Companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-theme-muted mb-1">From</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30" />
          </div>
          <div>
            <label className="block text-xs text-theme-muted mb-1">To</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30" />
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-400"></div>
        </div>
      )}

      {!loading && data && view === 'statement' && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryCard label="Gross Profit" value={data.summary.grossProfit} icon={DollarSign}
              color={data.summary.grossProfit >= 0 ? 'text-green-400' : 'text-red-400'} />
            <SummaryCard label="Net Profit" value={data.summary.netProfit} icon={data.summary.netProfit >= 0 ? TrendingUp : TrendingDown}
              color={data.summary.netProfit >= 0 ? 'text-green-400' : 'text-red-400'} />
            <SummaryCard label="GP Margin" value={data.summary.grossProfitMargin} icon={Percent} suffix="%" isPercent />
            <SummaryCard label="NP Margin" value={data.summary.netProfitMargin} icon={Percent} suffix="%" isPercent />
          </div>

          {/* Statement Sections */}
          <div className="space-y-3">
            {groupedItems.map((section, idx) => (
              <div key={idx} className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-hidden">
                <button
                  onClick={() => toggleSection(idx)}
                  className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-dark-600/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {expandedSections.has(idx) ? <ChevronDown size={16} className="text-theme-muted" /> : <ChevronRight size={16} className="text-theme-muted" />}
                    <span className="text-sm font-semibold text-theme-heading">{section.title}</span>
                    <span className="text-xs text-theme-faint">({section.items.length} items)</span>
                  </div>
                  <span className={`text-sm font-bold ${section.total >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {fmt(Math.abs(section.total))}
                  </span>
                </button>
                {expandedSections.has(idx) && (
                  <div className="border-t border-dark-400/30">
                    {Object.entries(section.groups).map(([groupName, group]) => (
                      <div key={groupName}>
                        <div className="flex items-center justify-between px-5 py-2 bg-dark-600/30">
                          <span className="text-xs font-medium text-accent-400">{groupName}</span>
                          <span className="text-xs font-medium text-theme-secondary">{fmtFull(Math.abs(group.total))}</span>
                        </div>
                        {group.items.map((item, i) => (
                          <div key={i} className="flex items-center justify-between px-5 py-1.5 pl-10 hover:bg-dark-600/20">
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

            {/* Profit Summary */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-dark-400/30">
                <span className="text-sm font-semibold text-theme-heading">Gross Profit</span>
                <span className={`text-sm font-bold ${data.summary.grossProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {fmtFull(data.summary.grossProfit)}
                </span>
              </div>
              <div className="flex items-center justify-between px-5 py-3 bg-accent-500/5">
                <span className="text-sm font-bold text-theme-heading">Net Profit</span>
                <span className={`text-base font-bold ${data.summary.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {fmtFull(data.summary.netProfit)}
                </span>
              </div>
            </div>
          </div>

          {data.source === 'trial_balance' && (
            <p className="text-xs text-amber-400 text-center">Data sourced from Trial Balance (P&L data not available for this period)</p>
          )}
        </>
      )}

      {/* Monthly Comparison View */}
      {!loading && view === 'monthly' && monthly.length > 0 && (
        <div className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-dark-400/30">
                <th className="text-left px-4 py-3 text-theme-muted font-medium">Month</th>
                <th className="text-right px-4 py-3 text-theme-muted font-medium">Revenue</th>
                <th className="text-right px-4 py-3 text-theme-muted font-medium">Direct Exp.</th>
                <th className="text-right px-4 py-3 text-theme-muted font-medium">Gross Profit</th>
                <th className="text-right px-4 py-3 text-theme-muted font-medium">Indirect Inc.</th>
                <th className="text-right px-4 py-3 text-theme-muted font-medium">Indirect Exp.</th>
                <th className="text-right px-4 py-3 text-theme-muted font-medium">Net Profit</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m, i) => (
                <tr key={i} className="border-b border-dark-400/10 hover:bg-dark-600/30">
                  <td className="px-4 py-2.5 text-theme-primary font-medium">
                    {new Date(m.month + '-01').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-2.5 text-right text-theme-secondary font-mono">{fmt(m.revenue)}</td>
                  <td className="px-4 py-2.5 text-right text-red-400 font-mono">{fmt(m.directExpenses)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono font-medium ${m.grossProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {fmt(m.grossProfit)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-theme-secondary font-mono">{fmt(m.indirectIncome)}</td>
                  <td className="px-4 py-2.5 text-right text-red-400 font-mono">{fmt(m.indirectExpenses)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono font-bold ${m.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {fmt(m.netProfit)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-dark-600/30 font-bold">
                <td className="px-4 py-3 text-theme-heading">Total</td>
                <td className="px-4 py-3 text-right text-theme-primary font-mono">{fmt(monthly.reduce((s, m) => s + m.revenue, 0))}</td>
                <td className="px-4 py-3 text-right text-red-400 font-mono">{fmt(monthly.reduce((s, m) => s + m.directExpenses, 0))}</td>
                <td className="px-4 py-3 text-right text-green-400 font-mono">{fmt(monthly.reduce((s, m) => s + m.grossProfit, 0))}</td>
                <td className="px-4 py-3 text-right text-theme-primary font-mono">{fmt(monthly.reduce((s, m) => s + m.indirectIncome, 0))}</td>
                <td className="px-4 py-3 text-right text-red-400 font-mono">{fmt(monthly.reduce((s, m) => s + m.indirectExpenses, 0))}</td>
                <td className="px-4 py-3 text-right text-green-400 font-mono">{fmt(monthly.reduce((s, m) => s + m.netProfit, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!loading && view === 'monthly' && monthly.length === 0 && (
        <div className="text-center py-12 text-theme-muted text-sm">No monthly data available for this period</div>
      )}

      {!loading && data?.noData && (
        <div className="text-center py-12 text-theme-muted text-sm">No financial data found. Sync data from Tally first.</div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, icon: Icon, color, suffix, isPercent }: {
  label: string; value: number; icon: any; color?: string; suffix?: string; isPercent?: boolean;
}) {
  return (
    <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={15} className={color || 'text-accent-400'} />
        <span className="text-xs text-theme-muted">{label}</span>
      </div>
      <div className={`text-lg font-bold ${color || 'text-theme-heading'}`}>
        {isPercent ? value.toFixed(1) : fmt(value)}{suffix || ''}
      </div>
    </div>
  );
}
