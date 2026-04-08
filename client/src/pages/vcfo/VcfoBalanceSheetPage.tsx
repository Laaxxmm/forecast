/**
 * Balance Sheet — Matches TallyVision card/table styling
 * Assets/Liabilities/Capital with collapsible group hierarchy
 */
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../api/client';

interface BSItem { ledger_name: string; group_name: string; amount: number; }
interface BSSection { title: string; items: BSItem[]; total: number; }
interface BSData {
  sections: BSSection[]; noData?: boolean;
  summary: { totalAssets: number; totalLiabilities: number; netWorth: number; currentRatio: number; };
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

const sectionBorders = ['border-l-blue-500', 'border-l-orange-500', 'border-l-emerald-500'];
const sectionColors = ['text-blue-400', 'text-orange-400', 'text-emerald-400'];

export default function VcfoBalanceSheetPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [asOnDate, setAsOnDate] = useState('');
  const [data, setData] = useState<BSData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0, 1, 2]));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => { setAsOnDate(new Date().toISOString().split('T')[0]); }, []);

  useEffect(() => {
    api.get('/vcfo/companies').then(r => { setCompanies(r.data || []); if (r.data?.length > 0) setCompanyId(String(r.data[0].id)); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!asOnDate) return;
    setLoading(true);
    const params: any = { date: asOnDate };
    if (companyId) params.companyId = companyId;
    api.get('/vcfo/reports/balance-sheet', { params }).then(r => setData(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, [companyId, asOnDate]);

  const toggleSection = (idx: number) => {
    setExpandedSections(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
  };
  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  const getSectionGroups = (section: BSSection) => {
    const groups: Record<string, { items: BSItem[]; total: number }> = {};
    for (const item of section.items) {
      if (!groups[item.group_name]) groups[item.group_name] = { items: [], total: 0 };
      groups[item.group_name].items.push(item);
      groups[item.group_name].total += item.amount;
    }
    return groups;
  };

  return (
    <div className="space-y-5">
      <div className="card-tv p-5">
        <h1 className="text-lg font-bold text-theme-heading">Balance Sheet</h1>
        <p className="text-xs text-theme-faint mt-0.5">Assets, Liabilities & Capital as on a specific date</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">Filters</span>
        <select value={companyId} onChange={e => setCompanyId(e.target.value)} className="tv-input min-w-[160px]">
          <option value="">All Companies</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={asOnDate} onChange={e => setAsOnDate(e.target.value)} className="tv-input" />
      </div>

      {loading && <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" /></div>}

      {!loading && data && !data.noData && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Total Assets</div>
              <div className="text-xl font-bold text-blue-400">{fmt(data.summary.totalAssets)}</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Total Liabilities</div>
              <div className="text-xl font-bold text-orange-400">{fmt(Math.abs(data.summary.totalLiabilities))}</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Net Worth</div>
              <div className="text-xl font-bold text-emerald-400">{fmt(Math.abs(data.summary.netWorth))}</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Current Ratio</div>
              <div className="text-xl font-bold text-indigo-400">{data.summary.currentRatio.toFixed(2)}</div>
            </div>
          </div>

          {data.sections.map((section, idx) => {
            const groups = getSectionGroups(section);
            return (
              <div key={idx} className={`card-tv overflow-hidden border-l-4 ${sectionBorders[idx]}`}>
                <button onClick={() => toggleSection(idx)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-[rgb(var(--c-dark-600)/0.5)] transition-colors">
                  <div className="flex items-center gap-2">
                    {expandedSections.has(idx) ? <ChevronDown size={16} className="text-theme-faint" /> : <ChevronRight size={16} className="text-theme-faint" />}
                    <span className={`text-sm font-semibold ${sectionColors[idx]}`}>{section.title}</span>
                    <span className="text-[10px] text-theme-faint">({section.items.length} ledgers)</span>
                  </div>
                  <span className={`text-sm font-bold ${sectionColors[idx]}`}>{fmtFull(Math.abs(section.total))}</span>
                </button>
                {expandedSections.has(idx) && (
                  <div style={{ borderTop: '1px solid rgb(var(--c-dark-400) / 0.3)' }}>
                    {Object.entries(groups).map(([groupName, group]) => {
                      const gKey = `${idx}-${groupName}`;
                      return (
                        <div key={groupName}>
                          <button onClick={() => toggleGroup(gKey)}
                            className="w-full flex items-center justify-between px-5 py-2 hover:bg-[rgb(var(--c-dark-600)/0.3)] transition-colors"
                            style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.2)' }}>
                            <div className="flex items-center gap-1.5">
                              {expandedGroups.has(gKey) ? <ChevronDown size={12} className="text-theme-faint" /> : <ChevronRight size={12} className="text-theme-faint" />}
                              <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">{groupName}</span>
                            </div>
                            <span className="text-xs font-semibold text-theme-secondary">{fmtFull(Math.abs(group.total))}</span>
                          </button>
                          {expandedGroups.has(gKey) && group.items.map((item, i) => (
                            <div key={i} className="flex items-center justify-between px-5 py-1.5 pl-12 hover:bg-[rgb(var(--c-dark-600)/0.2)]">
                              <span className="text-xs text-theme-secondary truncate max-w-[60%]">{item.ledger_name}</span>
                              <span className="text-xs text-theme-primary font-mono">{fmtFull(Math.abs(item.amount))}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          <div className="card-tv overflow-hidden border-l-4 border-l-indigo-500">
            <div className="flex items-center justify-between px-5 py-4" style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.3)' }}>
              <span className="text-base font-bold text-theme-heading">Difference (Assets - Liabilities)</span>
              <span className={`text-lg font-extrabold ${Math.abs(data.summary.totalAssets - data.summary.totalLiabilities) < 1 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {fmtFull(data.summary.totalAssets - data.summary.totalLiabilities)}
              </span>
            </div>
          </div>
        </>
      )}

      {!loading && data?.noData && (
        <div className="card-tv p-12 text-center text-theme-faint text-sm">No balance sheet data. Sync from Tally first.</div>
      )}
    </div>
  );
}
