import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Building2, Scale } from 'lucide-react';
import api from '../../api/client';

interface BSItem {
  ledger_name: string;
  group_name: string;
  amount: number;
}

interface BSSection {
  title: string;
  items: BSItem[];
  total: number;
}

interface BSData {
  sections: BSSection[];
  summary: {
    totalAssets: number;
    totalLiabilities: number;
    netWorth: number;
    currentRatio: number;
  };
  noData?: boolean;
}

function fmtFull(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (abs >= 100000) return (n / 100000).toFixed(2) + ' L';
  if (abs >= 1000) return (n / 1000).toFixed(1) + ' K';
  return n.toFixed(0);
}

export default function VcfoBalanceSheetPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [asOnDate, setAsOnDate] = useState('');
  const [data, setData] = useState<BSData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0, 1, 2]));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    const now = new Date();
    setAsOnDate(now.toISOString().split('T')[0]);
  }, []);

  useEffect(() => {
    api.get('/vcfo/companies').then(r => {
      setCompanies(r.data);
      if (r.data.length > 0) setCompanyId(String(r.data[0].id));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!asOnDate) return;
    setLoading(true);
    const params: any = { date: asOnDate };
    if (companyId) params.companyId = companyId;

    api.get('/vcfo/reports/balance-sheet', { params })
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [companyId, asOnDate]);

  const toggleSection = (idx: number) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Group items by group_name within each section
  const getSectionGroups = (section: BSSection) => {
    const groups: Record<string, { items: BSItem[]; total: number }> = {};
    for (const item of section.items) {
      if (!groups[item.group_name]) groups[item.group_name] = { items: [], total: 0 };
      groups[item.group_name].items.push(item);
      groups[item.group_name].total += item.amount;
    }
    return groups;
  };

  const sectionColors = ['text-blue-400', 'text-orange-400', 'text-green-400'];
  const sectionBgColors = ['bg-blue-500/5', 'bg-orange-500/5', 'bg-green-500/5'];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-theme-heading">Balance Sheet</h1>
        <p className="text-sm text-theme-muted mt-0.5">Assets, Liabilities & Capital as on a specific date</p>
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
            <label className="block text-xs text-theme-muted mb-1">As On Date</label>
            <input type="date" value={asOnDate} onChange={e => setAsOnDate(e.target.value)}
              className="bg-dark-600 text-theme-primary text-sm rounded-lg px-3 py-2 border border-dark-400/30" />
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-400"></div>
        </div>
      )}

      {!loading && data && !data.noData && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
              <div className="flex items-center gap-2 mb-2">
                <Building2 size={15} className="text-blue-400" />
                <span className="text-xs text-theme-muted">Total Assets</span>
              </div>
              <div className="text-lg font-bold text-blue-400">{fmt(data.summary.totalAssets)}</div>
            </div>
            <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
              <div className="flex items-center gap-2 mb-2">
                <Scale size={15} className="text-orange-400" />
                <span className="text-xs text-theme-muted">Total Liabilities</span>
              </div>
              <div className="text-lg font-bold text-orange-400">{fmt(Math.abs(data.summary.totalLiabilities))}</div>
            </div>
            <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
              <div className="flex items-center gap-2 mb-2">
                <Building2 size={15} className="text-green-400" />
                <span className="text-xs text-theme-muted">Net Worth</span>
              </div>
              <div className="text-lg font-bold text-green-400">{fmt(Math.abs(data.summary.netWorth))}</div>
            </div>
            <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
              <div className="flex items-center gap-2 mb-2">
                <Scale size={15} className="text-accent-400" />
                <span className="text-xs text-theme-muted">Current Ratio</span>
              </div>
              <div className="text-lg font-bold text-accent-400">{data.summary.currentRatio.toFixed(2)}</div>
            </div>
          </div>

          {/* BS Sections */}
          <div className="space-y-3">
            {data.sections.map((section, idx) => {
              const groups = getSectionGroups(section);
              return (
                <div key={idx} className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-hidden">
                  <button
                    onClick={() => toggleSection(idx)}
                    className={`w-full flex items-center justify-between px-5 py-3.5 hover:bg-dark-600/50 transition-colors ${sectionBgColors[idx]}`}
                  >
                    <div className="flex items-center gap-2">
                      {expandedSections.has(idx) ? <ChevronDown size={16} className="text-theme-muted" /> : <ChevronRight size={16} className="text-theme-muted" />}
                      <span className={`text-sm font-semibold ${sectionColors[idx]}`}>{section.title}</span>
                      <span className="text-xs text-theme-faint">({section.items.length} ledgers)</span>
                    </div>
                    <span className={`text-sm font-bold ${sectionColors[idx]}`}>
                      {fmtFull(Math.abs(section.total))}
                    </span>
                  </button>
                  {expandedSections.has(idx) && (
                    <div className="border-t border-dark-400/30">
                      {Object.entries(groups).map(([groupName, group]) => {
                        const gKey = `${idx}-${groupName}`;
                        const isExpanded = expandedGroups.has(gKey);
                        return (
                          <div key={groupName}>
                            <button
                              onClick={() => toggleGroup(gKey)}
                              className="w-full flex items-center justify-between px-5 py-2 bg-dark-600/30 hover:bg-dark-600/50 transition-colors"
                            >
                              <div className="flex items-center gap-1.5">
                                {isExpanded ? <ChevronDown size={12} className="text-theme-faint" /> : <ChevronRight size={12} className="text-theme-faint" />}
                                <span className="text-xs font-medium text-accent-400">{groupName}</span>
                              </div>
                              <span className="text-xs font-medium text-theme-secondary">{fmtFull(Math.abs(group.total))}</span>
                            </button>
                            {isExpanded && group.items.map((item, i) => (
                              <div key={i} className="flex items-center justify-between px-5 py-1.5 pl-12 hover:bg-dark-600/20">
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

            {/* Balance Check */}
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 bg-accent-500/5">
                <span className="text-sm font-bold text-theme-heading">Difference (Assets - Liabilities)</span>
                <span className={`text-base font-bold ${Math.abs(data.summary.totalAssets - data.summary.totalLiabilities) < 1 ? 'text-green-400' : 'text-amber-400'}`}>
                  {fmtFull(data.summary.totalAssets - data.summary.totalLiabilities)}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {!loading && data?.noData && (
        <div className="text-center py-12 text-theme-muted text-sm">No balance sheet data found. Sync data from Tally first.</div>
      )}
    </div>
  );
}
