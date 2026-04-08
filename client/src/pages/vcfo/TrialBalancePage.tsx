import { useState, useEffect, useMemo } from 'react';
import api from '../../api/client';
import { Table2, Search, ChevronDown, ChevronRight } from 'lucide-react';

interface TBRow {
  ledger_name: string;
  group_name: string;
  opening_balance: number;
  net_debit: number;
  net_credit: number;
  closing_balance: number;
}

interface Company {
  id: number;
  name: string;
}

function fmt(val: number): string {
  if (!val) return '-';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  return `${sign}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function getFYDates(): { from: string; to: string } {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

export default function TrialBalancePage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [rows, setRows] = useState<TBRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const { from, to } = useMemo(getFYDates, []);

  useEffect(() => {
    api.get('/vcfo/companies').then(res => {
      setCompanies(res.data);
      if (res.data.length > 0) setSelectedCompanyId(res.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedCompanyId) { setLoading(false); return; }
    setLoading(true);
    api.get('/vcfo/dashboard/trial-balance', { params: { from, to, companyId: selectedCompanyId } })
      .then(res => {
        setRows(res.data);
        // Expand all groups by default
        const groups = new Set(res.data.map((r: TBRow) => r.group_name).filter(Boolean));
        setExpandedGroups(groups as Set<string>);
      })
      .finally(() => setLoading(false));
  }, [selectedCompanyId, from, to]);

  // Group rows by group_name
  const grouped = useMemo(() => {
    const filtered = search
      ? rows.filter(r => r.ledger_name.toLowerCase().includes(search.toLowerCase()) || r.group_name?.toLowerCase().includes(search.toLowerCase()))
      : rows;

    const map = new Map<string, TBRow[]>();
    for (const r of filtered) {
      const grp = r.group_name || 'Ungrouped';
      if (!map.has(grp)) map.set(grp, []);
      map.get(grp)!.push(r);
    }
    return map;
  }, [rows, search]);

  const toggleGroup = (grp: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(grp)) next.delete(grp); else next.add(grp);
      return next;
    });
  };

  // Totals
  const totals = useMemo(() => {
    return rows.reduce((acc, r) => ({
      opening: acc.opening + (r.opening_balance || 0),
      debit: acc.debit + (r.net_debit || 0),
      credit: acc.credit + (r.net_credit || 0),
      closing: acc.closing + (r.closing_balance || 0),
    }), { opening: 0, debit: 0, credit: 0, closing: 0 });
  }, [rows]);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-theme-heading">Trial Balance</h1>
          <p className="text-sm text-theme-muted mt-1">Period: {from} to {to}</p>
        </div>
        <div className="flex items-center gap-3">
          {companies.length > 1 && (
            <select
              value={selectedCompanyId || ''}
              onChange={e => setSelectedCompanyId(Number(e.target.value))}
              className="bg-dark-700 border border-dark-400/30 rounded-lg px-3 py-2 text-sm text-theme-primary"
            >
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search ledger..."
              className="bg-dark-700 border border-dark-400/30 rounded-lg pl-9 pr-3 py-2 text-sm text-theme-primary w-48"
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-theme-muted">Loading trial balance...</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-dark-700 rounded-2xl p-12 text-center border border-dark-400/30">
          <Table2 size={48} className="text-theme-faint mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-theme-heading mb-2">No Trial Balance Data</h2>
          <p className="text-theme-muted text-sm">Sync your Tally data first to view the trial balance.</p>
        </div>
      ) : (
        <div className="bg-dark-700 rounded-2xl border border-dark-400/20 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-dark-400/30">
                <th className="text-left px-4 py-3 text-xs font-semibold text-theme-muted">Ledger Name</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-theme-muted">Opening</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-theme-muted">Debit</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-theme-muted">Credit</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-theme-muted">Closing</th>
              </tr>
            </thead>
            <tbody>
              {[...grouped.entries()].map(([grp, ledgers]) => {
                const isExpanded = expandedGroups.has(grp);
                const grpTotals = ledgers.reduce((acc, r) => ({
                  opening: acc.opening + (r.opening_balance || 0),
                  debit: acc.debit + (r.net_debit || 0),
                  credit: acc.credit + (r.net_credit || 0),
                  closing: acc.closing + (r.closing_balance || 0),
                }), { opening: 0, debit: 0, credit: 0, closing: 0 });

                return [
                  <tr
                    key={`grp-${grp}`}
                    onClick={() => toggleGroup(grp)}
                    className="border-b border-dark-400/10 bg-dark-600/50 cursor-pointer hover:bg-dark-600"
                  >
                    <td className="px-4 py-2.5 font-semibold text-theme-primary flex items-center gap-2">
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {grp}
                      <span className="text-xs text-theme-faint font-normal">({ledgers.length})</span>
                    </td>
                    <td className="text-right px-4 py-2.5 text-theme-secondary font-medium">{fmt(grpTotals.opening)}</td>
                    <td className="text-right px-4 py-2.5 text-theme-secondary font-medium">{fmt(grpTotals.debit)}</td>
                    <td className="text-right px-4 py-2.5 text-theme-secondary font-medium">{fmt(grpTotals.credit)}</td>
                    <td className="text-right px-4 py-2.5 text-theme-secondary font-medium">{fmt(grpTotals.closing)}</td>
                  </tr>,
                  ...(isExpanded ? ledgers.map((r, i) => (
                    <tr key={`${grp}-${i}`} className="border-b border-dark-400/5 hover:bg-dark-600/30">
                      <td className="px-4 py-2 pl-10 text-theme-secondary">{r.ledger_name}</td>
                      <td className="text-right px-4 py-2 text-theme-secondary tabular-nums">{fmt(r.opening_balance)}</td>
                      <td className="text-right px-4 py-2 text-theme-secondary tabular-nums">{fmt(r.net_debit)}</td>
                      <td className="text-right px-4 py-2 text-theme-secondary tabular-nums">{fmt(r.net_credit)}</td>
                      <td className="text-right px-4 py-2 text-theme-secondary tabular-nums">{fmt(r.closing_balance)}</td>
                    </tr>
                  )) : []),
                ];
              }).flat()}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-dark-400/30 bg-dark-600">
                <td className="px-4 py-3 font-bold text-theme-heading">Total</td>
                <td className="text-right px-4 py-3 font-bold text-theme-heading tabular-nums">{fmt(totals.opening)}</td>
                <td className="text-right px-4 py-3 font-bold text-theme-heading tabular-nums">{fmt(totals.debit)}</td>
                <td className="text-right px-4 py-3 font-bold text-theme-heading tabular-nums">{fmt(totals.credit)}</td>
                <td className="text-right px-4 py-3 font-bold text-theme-heading tabular-nums">{fmt(totals.closing)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
