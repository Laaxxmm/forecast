import { useState, useEffect } from 'react';
import { Receipt, AlertTriangle, Clock, Users } from 'lucide-react';
import api from '../../api/client';

interface BillsSummary {
  total_bills: number;
  total_amount: number;
  overdue_amount: number;
  critical_amount: number;
  max_overdue: number;
}

interface AgingBucket {
  bucket: string;
  count: number;
  amount: number;
}

interface PartyBreakdown {
  party_name: string;
  bill_count: number;
  total: number;
  oldest_bill: string;
  max_overdue: number;
  overdue_total: number;
}

interface Bill {
  party_name: string;
  reference_number: string;
  bill_date: string;
  outstanding_amount: number;
  overdue_days: number;
}

function fmt(n: number): string {
  if (!n) return '0';
  const abs = Math.abs(n);
  if (abs >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (abs >= 100000) return (n / 100000).toFixed(2) + ' L';
  if (abs >= 1000) return (n / 1000).toFixed(1) + ' K';
  return n.toFixed(0);
}

function fmtFull(n: number): string {
  if (!n) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

const bucketColors: Record<string, string> = {
  'Current': 'bg-green-500',
  '1-30 days': 'bg-blue-500',
  '31-60 days': 'bg-yellow-500',
  '61-90 days': 'bg-orange-500',
  '90+ days': 'bg-red-500',
};

export default function VcfoBillsPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [nature, setNature] = useState<'receivable' | 'payable'>('receivable');
  const [summary, setSummary] = useState<BillsSummary | null>(null);
  const [aging, setAging] = useState<AgingBucket[]>([]);
  const [parties, setParties] = useState<PartyBreakdown[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'aging' | 'parties' | 'bills'>('aging');

  useEffect(() => {
    api.get('/vcfo/companies').then(r => {
      setCompanies(r.data);
      if (r.data.length > 0) setCompanyId(String(r.data[0].id));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params: any = { nature };
    if (companyId) params.companyId = companyId;

    api.get('/vcfo/reports/bills-outstanding', { params })
      .then(r => {
        setSummary(r.data.summary);
        setAging(r.data.aging || []);
        setParties(r.data.parties || []);
        setBills(r.data.bills || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [companyId, nature]);

  const totalAgingAmount = aging.reduce((s, b) => s + (b.amount || 0), 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-theme-heading">Bills Outstanding</h1>
          <p className="text-sm text-theme-muted mt-0.5">Receivables & Payables aging analysis</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setNature('receivable')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${nature === 'receivable' ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-dark-600 text-theme-muted hover:text-theme-primary'}`}
          >
            Receivables
          </button>
          <button
            onClick={() => setNature('payable')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${nature === 'payable' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' : 'bg-dark-600 text-theme-muted hover:text-theme-primary'}`}
          >
            Payables
          </button>
        </div>
      </div>

      {/* Company Filter */}
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
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-400"></div>
        </div>
      )}

      {!loading && summary && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
              <div className="flex items-center gap-2 mb-2">
                <Receipt size={15} className="text-accent-400" />
                <span className="text-xs text-theme-muted">Total Outstanding</span>
              </div>
              <div className="text-lg font-bold text-theme-heading">{fmt(summary.total_amount || 0)}</div>
              <div className="text-[10px] text-theme-faint mt-1">{summary.total_bills || 0} bills</div>
            </div>
            <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
              <div className="flex items-center gap-2 mb-2">
                <Clock size={15} className="text-amber-400" />
                <span className="text-xs text-theme-muted">Overdue</span>
              </div>
              <div className="text-lg font-bold text-amber-400">{fmt(summary.overdue_amount || 0)}</div>
            </div>
            <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={15} className="text-red-400" />
                <span className="text-xs text-theme-muted">Critical (90+ days)</span>
              </div>
              <div className="text-lg font-bold text-red-400">{fmt(summary.critical_amount || 0)}</div>
            </div>
            <div className="bg-dark-700 rounded-xl p-4 border border-dark-400/30">
              <div className="flex items-center gap-2 mb-2">
                <Clock size={15} className="text-theme-muted" />
                <span className="text-xs text-theme-muted">Max Overdue</span>
              </div>
              <div className="text-lg font-bold text-theme-heading">{summary.max_overdue || 0} days</div>
            </div>
          </div>

          {/* View Tabs */}
          <div className="flex gap-1 bg-dark-700 rounded-xl p-1 border border-dark-400/30 w-fit">
            {(['aging', 'parties', 'bills'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors capitalize ${view === v ? 'bg-accent-500 text-white' : 'text-theme-muted hover:text-theme-primary'}`}>
                {v === 'aging' ? 'Aging Analysis' : v === 'parties' ? 'Party-wise' : 'Individual Bills'}
              </button>
            ))}
          </div>

          {/* Aging Analysis */}
          {view === 'aging' && (
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 p-5">
              {/* Stacked bar visualization */}
              {totalAgingAmount > 0 && (
                <div className="mb-6">
                  <div className="flex h-8 rounded-lg overflow-hidden">
                    {aging.map((b, i) => {
                      const pct = ((b.amount || 0) / totalAgingAmount) * 100;
                      if (pct < 0.5) return null;
                      return (
                        <div key={i} className={`${bucketColors[b.bucket] || 'bg-gray-500'} relative group`}
                          style={{ width: `${pct}%` }}>
                          <div className="absolute inset-0 flex items-center justify-center">
                            {pct > 8 && <span className="text-[10px] font-medium text-white">{pct.toFixed(0)}%</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {aging.map((b, i) => (
                  <div key={i} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-dark-600/30">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-sm ${bucketColors[b.bucket] || 'bg-gray-500'}`} />
                      <span className="text-sm text-theme-primary">{b.bucket}</span>
                      <span className="text-xs text-theme-faint">{b.count} bills</span>
                    </div>
                    <span className="text-sm font-semibold text-theme-heading font-mono">{fmtFull(b.amount || 0)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Party-wise Breakdown */}
          {view === 'parties' && (
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-dark-400/30">
                    <th className="text-left px-4 py-3 text-theme-muted font-medium">Party</th>
                    <th className="text-right px-4 py-3 text-theme-muted font-medium">Bills</th>
                    <th className="text-right px-4 py-3 text-theme-muted font-medium">Total</th>
                    <th className="text-right px-4 py-3 text-theme-muted font-medium">Overdue</th>
                    <th className="text-right px-4 py-3 text-theme-muted font-medium">Max Days</th>
                  </tr>
                </thead>
                <tbody>
                  {parties.map((p, i) => (
                    <tr key={i} className="border-b border-dark-400/10 hover:bg-dark-600/30">
                      <td className="px-4 py-2.5 text-theme-primary font-medium truncate max-w-[200px]">{p.party_name}</td>
                      <td className="px-4 py-2.5 text-right text-theme-secondary">{p.bill_count}</td>
                      <td className="px-4 py-2.5 text-right text-theme-primary font-mono font-medium">{fmtFull(p.total)}</td>
                      <td className={`px-4 py-2.5 text-right font-mono ${p.overdue_total > 0 ? 'text-red-400' : 'text-theme-faint'}`}>
                        {fmtFull(p.overdue_total)}
                      </td>
                      <td className={`px-4 py-2.5 text-right ${p.max_overdue > 90 ? 'text-red-400 font-bold' : p.max_overdue > 30 ? 'text-amber-400' : 'text-theme-secondary'}`}>
                        {p.max_overdue > 0 ? `${p.max_overdue}d` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parties.length === 0 && (
                <div className="text-center py-8 text-theme-muted text-sm">No party data available</div>
              )}
            </div>
          )}

          {/* Individual Bills */}
          {view === 'bills' && (
            <div className="bg-dark-700 rounded-xl border border-dark-400/30 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-dark-400/30">
                    <th className="text-left px-4 py-3 text-theme-muted font-medium">Party</th>
                    <th className="text-left px-4 py-3 text-theme-muted font-medium">Ref</th>
                    <th className="text-left px-4 py-3 text-theme-muted font-medium">Date</th>
                    <th className="text-right px-4 py-3 text-theme-muted font-medium">Amount</th>
                    <th className="text-right px-4 py-3 text-theme-muted font-medium">Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b, i) => (
                    <tr key={i} className="border-b border-dark-400/10 hover:bg-dark-600/30">
                      <td className="px-4 py-2.5 text-theme-primary truncate max-w-[180px]">{b.party_name}</td>
                      <td className="px-4 py-2.5 text-theme-secondary truncate max-w-[120px]">{b.reference_number || '-'}</td>
                      <td className="px-4 py-2.5 text-theme-secondary">{b.bill_date || '-'}</td>
                      <td className="px-4 py-2.5 text-right text-theme-primary font-mono font-medium">{fmtFull(b.outstanding_amount)}</td>
                      <td className={`px-4 py-2.5 text-right font-medium ${b.overdue_days > 90 ? 'text-red-400' : b.overdue_days > 30 ? 'text-amber-400' : b.overdue_days > 0 ? 'text-yellow-400' : 'text-green-400'}`}>
                        {b.overdue_days > 0 ? `${b.overdue_days}d` : 'Current'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bills.length === 0 && (
                <div className="text-center py-8 text-theme-muted text-sm">No bills found</div>
              )}
            </div>
          )}
        </>
      )}

      {!loading && (!summary || !summary.total_bills) && (
        <div className="text-center py-12 text-theme-muted text-sm">
          <Users size={32} className="mx-auto mb-3 text-theme-faint" />
          No {nature} data found. Sync bills outstanding from Tally first.
        </div>
      )}
    </div>
  );
}
