import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ShieldAlert, ArrowRight } from 'lucide-react';
import api from '../../../api/client';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const RECHECK_DAYS = 2;

interface FailureSummary {
  failureCount: number;
  failures: Array<{ branch_id: number | null; source: string; date: string }>;
}

type Severity = 'amber' | 'red';

/**
 * Persistent data-trust strip rendered above the dashboard headline KPIs.
 * Reuses the same /api/sync/auto/failures-recent endpoint as the global
 * banner. NOT dismissible — the brief explicitly forbids the close
 * button so users can't make decisions on stale data.
 *
 * Severity:
 *  - hidden when failureCount === 0 (keeps the page clean when healthy)
 *  - amber when most recent failure is < 24h old
 *  - red   when most recent failure is >= 24h old (sync has been broken)
 *
 * Branch-count and last-sync fields aren't yet exposed by the endpoint;
 * Phase 2 will refine the message once the backend returns them.
 */
export default function TrustBar() {
  const [summary, setSummary] = useState<FailureSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const resp = await api.get(`/sync/auto/failures-recent?days=${RECHECK_DAYS}`);
        if (!cancelled) setSummary(resp.data);
      } catch {
        // Non-critical — leave bar hidden if the call fails.
      }
    };
    fetchOnce();
    const t = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!summary || summary.failureCount === 0) return null;

  const mostRecentMs = summary.failures
    .map((f) => Date.parse(f.date))
    .filter((n) => !Number.isNaN(n))
    .reduce((max, n) => (n > max ? n : max), 0);

  const ageHours = mostRecentMs > 0 ? (Date.now() - mostRecentMs) / 3_600_000 : 0;
  const severity: Severity = ageHours >= 24 ? 'red' : 'amber';

  const palette = severity === 'red'
    ? { bg: 'var(--mt-trust-red-bg)',   text: 'var(--mt-trust-red-text)',   accent: 'var(--mt-trust-red-text)' }
    : { bg: 'var(--mt-trust-amber-bg)', text: 'var(--mt-trust-amber-text)', accent: 'var(--mt-trust-amber-accent)' };

  const ageLabel = formatRelative(ageHours);

  return (
    <div
      role="status"
      className="flex items-center gap-3 px-4 py-2.5 text-[13px]"
      style={{
        background: palette.bg,
        color: palette.text,
        borderRadius: 10,
        borderLeft: `3px solid ${palette.accent}`,
      }}
    >
      <span className="shrink-0" style={{ color: palette.accent }}>
        {severity === 'red' ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}
      </span>
      <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">Data trust</span>
        <span>
          {summary.failureCount} sync {summary.failureCount === 1 ? 'failure' : 'failures'} in last {RECHECK_DAYS} days
          {mostRecentMs > 0 && <span> · most recent {ageLabel}</span>}
        </span>
      </div>
      <Link
        to="/admin"
        className="shrink-0 inline-flex items-center gap-1 font-medium hover:underline"
        style={{ color: palette.accent }}
      >
        Fix sync <ArrowRight size={13} />
      </Link>
    </div>
  );
}

function formatRelative(ageHours: number): string {
  if (ageHours < 1) {
    const m = Math.max(1, Math.round(ageHours * 60));
    return `${m} min ago`;
  }
  if (ageHours < 24) {
    const h = Math.round(ageHours);
    return `${h}h ago`;
  }
  const d = Math.round(ageHours / 24);
  return `${d}d ago`;
}
