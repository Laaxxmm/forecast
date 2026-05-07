import { Wallet, Landmark } from 'lucide-react';
import { formatRs } from '../../../pages/ForecastModulePage';

interface CashBankLedger {
  name: string;
  group: 'Cash-in-Hand' | 'Bank Accounts';
  balance: number;
}

interface Props {
  asOf: string;
  total: number;
  ledgers: CashBankLedger[];
}

/**
 * Cash & Bank balances — compact list of every cash/bank ledger with its
 * closing balance as of `asOf`. Total in the header.
 */
export default function CashBankCard({ asOf, total, ledgers }: Props) {
  // Cap the rendered list so an extreme tenant (50+ accounts) doesn't push
  // the card to dashboard-eating heights. Show top N by abs(balance).
  const visible = ledgers.slice(0, 10);
  const hidden = Math.max(0, ledgers.length - visible.length);

  return (
    <div className="mt-card p-4 h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
          Cash &amp; Bank
        </div>
        <div className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
          As of {asOf}
        </div>
      </div>
      <div className="text-xl font-mono font-semibold mb-3" style={{ color: 'var(--mt-text-primary)' }}>
        {formatRs(total)}
      </div>
      {ledgers.length === 0 ? (
        <div className="text-[11px] py-4 text-center" style={{ color: 'var(--mt-text-faint)' }}>
          No cash or bank ledgers found.
        </div>
      ) : (
        <div className="space-y-1.5">
          {visible.map((l) => (
            <div
              key={`${l.group}-${l.name}`}
              className="flex items-center gap-2 text-xs py-1"
              style={{ borderTop: '1px solid var(--mt-border)' }}
            >
              <span style={{ color: 'var(--mt-text-faint)' }}>
                {l.group === 'Cash-in-Hand' ? <Wallet size={12} /> : <Landmark size={12} />}
              </span>
              <span className="flex-1 truncate" title={l.name} style={{ color: 'var(--mt-text-secondary)' }}>
                {l.name}
              </span>
              <span className="font-mono font-medium" style={{ color: 'var(--mt-text-primary)' }}>
                {formatRs(l.balance)}
              </span>
            </div>
          ))}
          {hidden > 0 && (
            <div className="text-[11px] pt-1.5" style={{ color: 'var(--mt-text-faint)', borderTop: '1px solid var(--mt-border)' }}>
              + {hidden} more {hidden === 1 ? 'account' : 'accounts'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
