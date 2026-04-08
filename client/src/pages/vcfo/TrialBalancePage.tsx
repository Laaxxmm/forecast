/**
 * Trial Balance — Matches TallyVision card/table styling
 * Grouped ledger view with opening, debit, credit, closing columns
 */
import { useState, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import api from '../../api/client';

interface TBRow {
  ledger_name: string;
  group_name: string;
  opening_balance: number;
  net_debit: number;
  net_credit: number;
  closing_balance: number;
}

interface Company { id: number; name: string; }

function fmt(val: number): string {
  if (!val) return '-';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 10000000) return `${sign}${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(2)} L`;
  return `${sign}${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function getFYDates(): { from: string; to: string } {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

export default function TrialBalancePage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>('');
  const [rows, setRows] = useState<TBRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const { from, to } = useMemo(getFYDates, []);

  useEffect(() => {
    api.get('/vcfo/companies').then(res => {
      const list = res.data || [];
      setCompanies(list);
      if (list.length > 0) setSelectedCompanyId(String(list[0].id));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!from || !to) return;
    setLoading(true);
    const params: any = { from, to };
    if (selectedCompanyId) params.companyId = selectedCompanyId;
    api.get('/vcfo/dashboard/trial-balance', { params })
      .then(res => {
        const data = res.data || [];
        setRows(data);
        const groups = new Set(data.map((r: TBRow) => r.group_name).filter(Boolean));
        setExpandedGroups(groups as Set<string>);
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [selectedCompanyId, from, to]);

  const grouped = useMemo(() => {
    const filtered = search
      ? rows.filter(r => r.ledger_name?.toLowerCase().includes(search.toLowerCase()) || r.group_name?.toLowerCase().includes(search.toLowerCase()))
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

  const totals = useMemo(() => {
    return rows.reduce((acc, r) => ({
      opening: acc.opening + (r.opening_balance || 0),
      debit: acc.debit + (r.net_debit || 0),
      credit: acc.credit + (r.net_credit || 0),
      closing: acc.closing + (r.closing_balance || 0),
    }), { opening: 0, debit: 0, credit: 0, closing: 0 });
  }, [rows]);

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="card-tv p-5">
        <h1 className="text-lg font-bold text-theme-heading">Trial Balance</h1>
        <p className="text-xs text-theme-faint mt-0.5">Opening, debit, credit & closing balances for all ledgers</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">Filters</span>
        <select value={selectedCompanyId} onChange={e => setSelectedCompanyId(e.target.value)} className="tv-input min-w-[160px]">
          <option value="">All Companies</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search ledger..."
            className="tv-input pl-8 w-48"
          />
        </div>
        <span className="text-xs text-theme-faint">{from} to {to}</span>
      </div>

      {loading && <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" /></div>}

      {!loading && rows.length > 0 && (
        <div className="card-tv overflow-hidden">
          <table className="tv-table">
            <thead>
              <tr>
                <th>Ledger Name</th>
                <th className="text-right">Opening</th>
                <th className="text-right">Debit</th>
                <th className="text-right">Credit</th>
                <th className="text-right">Closing</th>
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
                    className="cursor-pointer"
                    style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.5)' }}
                  >
                    <td className="font-semibold text-theme-primary">
                      <span className="inline-flex items-center gap-2">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {grp}
                        <span className="text-[10px] text-theme-faint font-normal">({ledgers.length})</span>
                      </span>
                    </td>
                    <td className="text-right font-medium text-theme-secondary">{fmt(grpTotals.opening)}</td>
                    <td className="text-right font-medium text-theme-secondary">{fmt(grpTotals.debit)}</td>
                    <td className="text-right font-medium text-theme-secondary">{fmt(grpTotals.credit)}</td>
                    <td className="text-right font-medium text-theme-secondary">{fmt(grpTotals.closing)}</td>
                  </tr>,
                  ...(isExpanded ? ledgers.map((r, i) => (
                    <tr key={`${grp}-${i}`}>
                      <td className="pl-10 text-theme-secondary">{r.ledger_name}</td>
                      <td className="text-right tabular-nums">{fmt(r.opening_balance)}</td>
                      <td className="text-right tabular-nums">{fmt(r.net_debit)}</td>
                      <td className="text-right tabular-nums">{fmt(r.net_credit)}</td>
                      <td className="text-right tabular-nums">{fmt(r.closing_balance)}</td>
                    </tr>
                  )) : []),
                ];
              }).flat()}
            </tbody>
            <tfoot>
              <tr style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.5)' }}>
                <td className="font-bold text-theme-heading">Total</td>
                <td className="text-right font-bold text-theme-heading tabular-nums">{fmt(totals.opening)}</td>
                <td className="text-right font-bold text-theme-heading tabular-nums">{fmt(totals.debit)}</td>
                <td className="text-right font-bold text-theme-heading tabular-nums">{fmt(totals.credit)}</td>
                <td className="text-right font-bold text-theme-heading tabular-nums">{fmt(totals.closing)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="card-tv p-12 text-center text-theme-faint text-sm">
          No trial balance data found. Sync from Tally first.
        </div>
      )}
    </div>
  );
}
