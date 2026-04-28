import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import api from '../../api/client';
import { formatRs } from '../../pages/ForecastModulePage';
import StatementSearch from '../common/StatementSearch';

interface TrialBalanceRow {
  ledgerName: string;
  groupName: string | null;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

interface TrialBalanceGroup {
  key: string;
  groupName: string;
  opening: number;
  debit: number;
  credit: number;
  closing: number;
  children: TrialBalanceRow[];
}

interface TrialBalanceReport {
  period: { from: string; to: string };
  rows: TrialBalanceRow[];
  groups?: TrialBalanceGroup[];
  totals: { opening: number; debit: number; credit: number; closing: number };
}

interface Props {
  companyId: number | null;
  companyIds?: string | null;
  from: string;
  to: string;
}

export default function TrialBalanceReport({ companyId, companyIds, from, to }: Props) {
  const [data, setData] = useState<TrialBalanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!companyId && !companyIds) {
      setData(null);
      return;
    }
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    const params: Record<string, any> = { from, to };
    if (companyId) params.companyId = companyId;
    else if (companyIds) params.companyIds = companyIds;
    api
      .get('/vcfo/trial-balance', { params })
      .then(res => setData(res.data))
      .catch(err => setError(err?.response?.data?.error || err?.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [companyId, companyIds, from, to]);

  if (!companyId && !companyIds) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">Select a company to view the Trial Balance.</p>
      </div>
    );
  }
  if (loading) return <div className="text-theme-muted py-8 text-center">Loading…</div>;
  if (error) return <div className="text-red-400 py-8 text-center">{error}</div>;
  if (!data || data.rows.length === 0) {
    return (
      <div className="bg-dark-800 border border-dark-400/30 rounded-2xl p-8 text-center">
        <p className="text-theme-muted">
          No data for this period. Run Sync Now in the VCFO Sync desktop agent to pull fresh data.
        </p>
      </div>
    );
  }

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Server-side groups are preferred; fall back to client-side grouping for
  // older server responses that didn't populate `groups` yet.
  const allGroups: TrialBalanceGroup[] =
    data.groups && data.groups.length > 0
      ? data.groups
      : foldRowsClientSide(data.rows);

  // Find-in-statement search. Matches a group OR any of its child ledgers; we
  // expand matched groups automatically so the matching child is visible.
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups
      .map(g => {
        const groupHit = g.groupName.toLowerCase().includes(q);
        const matchedChildren = g.children.filter(c => c.ledgerName.toLowerCase().includes(q));
        if (groupHit) return g; // group name matches → show whole group
        if (matchedChildren.length > 0) return { ...g, children: matchedChildren };
        return null;
      })
      .filter((g): g is TrialBalanceGroup => g != null);
  }, [allGroups, search]);

  // When a search filters to specific children, force-expand those groups.
  const effectiveExpanded = useMemo(() => {
    if (!search.trim()) return expanded;
    const next = new Set(expanded);
    for (const g of groups) next.add(g.key);
    return next;
  }, [expanded, groups, search]);

  const renderGroup = (g: TrialBalanceGroup): ReactNode => {
    const isOpen = effectiveExpanded.has(g.key);
    const hasChildren = g.children.length > 0;
    return (
      <Fragment key={g.key}>
        <tr
          className={`border-b border-dark-400/20 transition-colors ${
            hasChildren ? 'cursor-pointer hover:bg-dark-600/40' : 'hover:bg-dark-600/20'
          }`}
          onClick={hasChildren ? () => toggle(g.key) : undefined}
        >
          <td className="py-2 pr-4 font-semibold text-theme-primary" style={{ paddingLeft: 16 }}>
            <span className="inline-flex items-center gap-1.5">
              {hasChildren ? (
                isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
              ) : (
                <span style={{ width: 14, display: 'inline-block' }} />
              )}
              {g.groupName}
            </span>
          </td>
          <td className="px-4 py-2 text-right font-mono font-semibold text-theme-primary">{formatRs(g.opening)}</td>
          <td className="px-4 py-2 text-right font-mono font-semibold text-theme-primary">{formatRs(g.debit)}</td>
          <td className="px-4 py-2 text-right font-mono font-semibold text-theme-primary">{formatRs(g.credit)}</td>
          <td className="px-4 py-2 text-right font-mono font-semibold text-theme-primary">{formatRs(g.closing)}</td>
        </tr>
        {hasChildren && isOpen && g.children.map((r, i) => (
          <tr
            key={`${g.key}:${r.ledgerName}-${i}`}
            className="border-b border-dark-400/20 hover:bg-dark-600/20"
          >
            <td className="py-2 pr-4 text-[13px] text-theme-secondary" style={{ paddingLeft: 36 }}>
              {r.ledgerName}
            </td>
            <td className="px-4 py-2 text-right text-theme-secondary font-mono text-[13px]">{formatRs(r.opening)}</td>
            <td className="px-4 py-2 text-right text-theme-secondary font-mono text-[13px]">{formatRs(r.debit)}</td>
            <td className="px-4 py-2 text-right text-theme-secondary font-mono text-[13px]">{formatRs(r.credit)}</td>
            <td className="px-4 py-2 text-right text-theme-secondary font-mono text-[13px]">{formatRs(r.closing)}</td>
          </tr>
        ))}
      </Fragment>
    );
  };

  return (
    <div className="bg-dark-800 border border-dark-400/30 rounded-2xl shadow-elev-2 overflow-hidden">
      <div className="px-5 py-3 border-b border-dark-400/30 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme-primary">Trial Balance</h3>
        <span className="text-xs text-theme-faint">
          {data.period.from} → {data.period.to}
        </span>
      </div>
      <div className="px-5 pt-3">
        <StatementSearch
          value={search}
          onChange={setSearch}
          placeholder="Find group or ledger…"
          resultLabel={`${groups.length} of ${allGroups.length} groups`}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-dark-700">
            <tr className="text-xs font-semibold text-theme-muted uppercase tracking-wide">
              <th className="text-left px-4 py-2.5 border-b border-dark-400/30">Group / Ledger</th>
              <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Opening</th>
              <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Debit</th>
              <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Credit</th>
              <th className="text-right px-4 py-2.5 border-b border-dark-400/30">Closing</th>
            </tr>
          </thead>
          <tbody>{groups.map(renderGroup)}</tbody>
          <tfoot>
            <tr className="bg-dark-700/80 font-semibold">
              <td className="px-4 py-2.5 text-theme-primary">Total</td>
              <td className="px-4 py-2.5 text-right text-theme-primary font-mono">{formatRs(data.totals.opening)}</td>
              <td className="px-4 py-2.5 text-right text-theme-primary font-mono">{formatRs(data.totals.debit)}</td>
              <td className="px-4 py-2.5 text-right text-theme-primary font-mono">{formatRs(data.totals.credit)}</td>
              <td className="px-4 py-2.5 text-right text-theme-primary font-mono">{formatRs(data.totals.closing)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function foldRowsClientSide(rows: TrialBalanceRow[]): TrialBalanceGroup[] {
  const byGroup = new Map<string, TrialBalanceGroup>();
  for (const r of rows) {
    const name = r.groupName || 'Ungrouped';
    let g = byGroup.get(name);
    if (!g) {
      g = { key: `grp:${name}`, groupName: name, opening: 0, debit: 0, credit: 0, closing: 0, children: [] };
      byGroup.set(name, g);
    }
    g.opening += r.opening;
    g.debit += r.debit;
    g.credit += r.credit;
    g.closing += r.closing;
    g.children.push(r);
  }
  const out = [...byGroup.values()];
  for (const g of out) g.children.sort((a, b) => a.ledgerName.localeCompare(b.ledgerName));
  out.sort((a, b) => a.groupName.localeCompare(b.groupName));
  return out;
}
