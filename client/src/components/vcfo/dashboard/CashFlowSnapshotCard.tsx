import { formatRs } from '../../../pages/ForecastModulePage';
import CashFlowWaterfall from './CashFlowWaterfall';

interface Props {
  opening: number;
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
  closingCash: number;
}

/**
 * Cash flow this year — waterfall showing Opening cash → +Operating →
 * -Investing → ±Financing → Closing. Highlights which activity carried
 * the period at a glance, not just the magnitudes.
 */
export default function CashFlowSnapshotCard({
  opening, operating, investing, financing, netChange, closingCash,
}: Props) {
  const openingCash = opening;

  return (
    <div className="mt-card p-4 h-full flex flex-col">
      <div className="mb-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--mt-text-primary)' }}>
          Cash flow this year
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
          How cash moved across operating, investing, and financing
        </div>
      </div>

      <CashFlowWaterfall
        opening={openingCash}
        operating={operating}
        investing={investing}
        financing={financing}
        closing={closingCash}
      />

      <div
        className="mt-3 px-3 py-2 text-[12px] rounded-md leading-snug"
        style={{
          background: 'var(--mt-trust-green-bg)',
          color: 'var(--mt-trust-green-text)',
        }}
      >
        {generateInsight({ operating, investing, financing, openingCash, closingCash })}
      </div>

      <div
        className="flex items-center justify-between mt-3 pt-2 text-[11px]"
        style={{ borderTop: '1px solid var(--mt-border)', color: 'var(--mt-text-faint)' }}
      >
        <span>Opening Rs{formatRs(openingCash).replace('Rs', '')}</span>
        <span>Closing {formatRs(closingCash)}</span>
        <span style={{ color: netChange >= 0 ? 'var(--mt-accent-text)' : 'var(--mt-danger-text)' }}>
          Net {netChange >= 0 ? '+' : ''}{formatRs(netChange).replace('Rs', 'Rs')}
        </span>
      </div>
    </div>
  );
}

interface InsightInput {
  operating: number;
  investing: number;
  financing: number;
  openingCash: number;
  closingCash: number;
}

function generateInsight({ operating, investing, financing, closingCash }: InsightInput): string {
  const totalAbs = Math.abs(operating) + Math.abs(investing) + Math.abs(financing);
  if (totalAbs === 0) return 'No cash movement in this period.';

  const opShare = Math.abs(operating) / totalAbs;
  const invShare = Math.abs(investing) / totalAbs;
  const finShare = Math.abs(financing) / totalAbs;

  if (operating > 0 && opShare > 0.6) {
    return finShare < 0.05
      ? 'Operating cash carried the year. Financing was flat — ask whether the OD needs restructuring.'
      : 'Operating cash carried the year. Investing and financing were small relative to operations.';
  }
  if (operating < 0) {
    return 'Operating activities consumed cash this period — review collections and cost timing.';
  }
  if (financing > 0 && finShare > 0.4) {
    return 'Financing brought in the bulk of cash this period.';
  }
  if (investing < 0 && invShare > 0.4) {
    return 'Investing absorbed a meaningful share of cash — capex or asset purchases drove the swing.';
  }
  return closingCash >= 0
    ? 'Cash moved roughly evenly across activities; closing position is in surplus.'
    : 'Cash moved roughly evenly across activities; closing position is in deficit.';
}
