/**
 * Bills Outstanding — Receivables & Payables aging analysis
 * Matches TallyVision card/table styling
 */
import { useState, useEffect } from 'react';
import api from '../../api/client';

interface BillsSummary { total_bills: number; total_amount: number; overdue_amount: number; critical_amount: number; max_overdue: number; }
interface AgingBucket { bucket: string; count: number; amount: number; }
interface Party { party_name: string; bill_count: number; total: number; oldest_bill: string; max_overdue: number; overdue_total: number; }
interface Bill { party_name: string; reference_number: string; bill_date: string; outstanding_amount: number; overdue_days: number; }

function fmt(n: number): string {
  if (!n) return '0';
  const abs = Math.abs(n); const sign = n < 0 ? '-' : '';
  if (abs >= 10000000) return sign + (abs / 10000000).toFixed(2) + ' Cr';
  if (abs >= 100000) return sign + (abs / 100000).toFixed(2) + ' L';
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + ' K';
  return sign + abs.toFixed(0);
}
function fmtFull(n: number): string { return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n || 0); }

const bucketColors: Record<string, string> = {
  'Current': '#059669', '1-30 days': '#3b82f6', '31-60 days': '#eab308',
  '61-90 days': '#f97316', '90+ days': '#dc2626',
};

export default function VcfoBillsPage() {
  const [companies, setCompanies] = useState<any[]>([]);
  const [companyId, setCompanyId] = useState<string>('');
  const [nature, setNature] = useState<'receivable' | 'payable'>('receivable');
  const [summary, setSummary] = useState<BillsSummary | null>(null);
  const [aging, setAging] = useState<AgingBucket[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'aging' | 'parties' | 'bills'>('aging');

  useEffect(() => {
    api.get('/vcfo/companies').then(r => { setCompanies(r.data || []); if (r.data?.length > 0) setCompanyId(String(r.data[0].id)); }).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params: any = { nature };
    if (companyId) params.companyId = companyId;
    api.get('/vcfo/reports/bills-outstanding', { params }).then(r => {
      setSummary(r.data.summary); setAging(r.data.aging || []); setParties(r.data.parties || []); setBills(r.data.bills || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [companyId, nature]);

  const totalAging = aging.reduce((s, b) => s + (b.amount || 0), 0);

  return (
    <div className="space-y-5">
      <div className="card-tv p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-theme-heading">Bills Outstanding</h1>
            <p className="text-xs text-theme-faint mt-0.5">Receivables & Payables aging analysis</p>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setNature('receivable')}
              className={`tv-tab ${nature === 'receivable' ? 'active' : ''}`}>Receivables</button>
            <button onClick={() => setNature('payable')}
              className={`tv-tab ${nature === 'payable' ? 'active' : ''}`}>Payables</button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-theme-faint">Filters</span>
        <select value={companyId} onChange={e => setCompanyId(e.target.value)} className="tv-input min-w-[160px]">
          <option value="">All Companies</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {loading && <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500" /></div>}

      {!loading && summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Total Outstanding</div>
              <div className="text-xl font-bold text-theme-heading">{fmt(summary.total_amount || 0)}</div>
              <div className="text-[10px] text-theme-faint mt-1">{summary.total_bills || 0} bills</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Overdue</div>
              <div className="text-xl font-bold text-amber-400">{fmt(summary.overdue_amount || 0)}</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Critical (90+ days)</div>
              <div className="text-xl font-bold text-red-400">{fmt(summary.critical_amount || 0)}</div>
            </div>
            <div className="card-tv p-4">
              <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">Max Overdue</div>
              <div className="text-xl font-bold text-theme-heading">{summary.max_overdue || 0} days</div>
            </div>
          </div>

          <div className="flex gap-1">
            {(['aging', 'parties', 'bills'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`tv-tab ${view === v ? 'active' : ''}`}>
                {v === 'aging' ? 'Aging Analysis' : v === 'parties' ? 'Party-wise' : 'Individual Bills'}
              </button>
            ))}
          </div>

          {view === 'aging' && (
            <div className="card-tv p-5">
              {totalAging > 0 && (
                <div className="flex h-8 rounded-lg overflow-hidden mb-6">
                  {aging.map((b, i) => {
                    const pct = ((b.amount || 0) / totalAging) * 100;
                    if (pct < 0.5) return null;
                    return (
                      <div key={i} className="relative group flex items-center justify-center"
                        style={{ width: `${pct}%`, backgroundColor: bucketColors[b.bucket] || '#64748b' }}>
                        {pct > 8 && <span className="text-[10px] font-semibold text-white">{pct.toFixed(0)}%</span>}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="space-y-2">
                {aging.map((b, i) => (
                  <div key={i} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-[rgb(var(--c-dark-600)/0.3)]">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: bucketColors[b.bucket] || '#64748b' }} />
                      <span className="text-sm text-theme-primary">{b.bucket}</span>
                      <span className="text-[10px] text-theme-faint">{b.count} bills</span>
                    </div>
                    <span className="text-sm font-bold text-theme-heading font-mono">{fmtFull(b.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'parties' && (
            <div className="card-tv overflow-x-auto">
              <table className="tv-table">
                <thead><tr><th>Party</th><th className="text-right">Bills</th><th className="text-right">Total</th><th className="text-right">Overdue</th><th className="text-right">Max Days</th></tr></thead>
                <tbody>
                  {parties.map((p, i) => (
                    <tr key={i}>
                      <td className="font-medium truncate max-w-[200px]">{p.party_name}</td>
                      <td className="text-right">{p.bill_count}</td>
                      <td className="text-right font-mono font-semibold">{fmtFull(p.total)}</td>
                      <td className={`text-right font-mono ${p.overdue_total > 0 ? 'text-red-400' : 'text-theme-faint'}`}>{fmtFull(p.overdue_total)}</td>
                      <td className={`text-right font-semibold ${p.max_overdue > 90 ? 'text-red-400' : p.max_overdue > 30 ? 'text-amber-400' : ''}`}>
                        {p.max_overdue > 0 ? `${p.max_overdue}d` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parties.length === 0 && <div className="p-8 text-center text-theme-faint text-sm">No party data</div>}
            </div>
          )}

          {view === 'bills' && (
            <div className="card-tv overflow-x-auto">
              <table className="tv-table">
                <thead><tr><th>Party</th><th>Ref</th><th>Date</th><th className="text-right">Amount</th><th className="text-right">Overdue</th></tr></thead>
                <tbody>
                  {bills.map((b, i) => (
                    <tr key={i}>
                      <td className="truncate max-w-[180px]">{b.party_name}</td>
                      <td className="text-theme-faint truncate max-w-[120px]">{b.reference_number || '-'}</td>
                      <td className="text-theme-faint">{b.bill_date || '-'}</td>
                      <td className="text-right font-mono font-semibold">{fmtFull(b.outstanding_amount)}</td>
                      <td className={`text-right font-semibold ${b.overdue_days > 90 ? 'text-red-400' : b.overdue_days > 30 ? 'text-amber-400' : b.overdue_days > 0 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                        {b.overdue_days > 0 ? `${b.overdue_days}d` : 'Current'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bills.length === 0 && <div className="p-8 text-center text-theme-faint text-sm">No bills found</div>}
            </div>
          )}
        </>
      )}

      {!loading && (!summary || !summary.total_bills) && (
        <div className="card-tv p-12 text-center text-theme-faint text-sm">
          No {nature} data found. Sync bills outstanding from Tally first.
        </div>
      )}
    </div>
  );
}
