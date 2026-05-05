// In-app banner shown across pages when one or more scheduled auto-syncs
// failed in the last 2 days for the current tenant. Acts as a passive
// notification — no email/Slack dependency, no extra infra. Click → goes
// to Admin → Auto-Sync Health for the full matrix view.
//
// Polls /api/sync/auto/failures-recent on mount + every 5 min while the
// component is alive. Dismissible per-session via localStorage so users
// who already saw the banner this session aren't nagged.

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import api from '../../api/client';

const SESSION_DISMISS_KEY = 'mt_autosync_banner_dismissed_until';
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const RECHECK_DAYS = 2;

interface FailureSummary {
  failureCount: number;
  failures: Array<{ branch_id: number | null; source: string; date: string }>;
}

export default function AutoSyncFailureBanner() {
  const [summary, setSummary] = useState<FailureSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Per-session dismissal — if user explicitly closed the banner in
    // the last 4 hours, respect that. Re-show on the next day.
    const dismissedUntil = localStorage.getItem(SESSION_DISMISS_KEY);
    if (dismissedUntil) {
      const until = parseInt(dismissedUntil);
      if (!isNaN(until) && until > Date.now()) {
        setDismissed(true);
        return;
      }
    }

    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const resp = await api.get(`/sync/auto/failures-recent?days=${RECHECK_DAYS}`);
        if (!cancelled) setSummary(resp.data);
      } catch {
        // Silent — banner is non-critical, don't surface load errors
        // to users on every page.
      }
    };
    fetchOnce();
    const t = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (dismissed || !summary || summary.failureCount === 0) return null;

  const handleDismiss = () => {
    // Re-show 4h from now or on the next page reload after that window.
    const until = Date.now() + 4 * 60 * 60 * 1000;
    localStorage.setItem(SESSION_DISMISS_KEY, String(until));
    setDismissed(true);
  };

  return (
    <div
      className="mx-auto mb-4 px-4 py-2.5 rounded-lg flex items-center gap-3 text-sm"
      style={{
        background: 'rgba(239, 68, 68, 0.1)',
        border: '1px solid rgba(239, 68, 68, 0.35)',
        color: '#fca5a5',
      }}
    >
      <AlertTriangle size={16} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-medium" style={{ color: '#fecaca' }}>
          {summary.failureCount} auto-sync {summary.failureCount === 1 ? 'failure' : 'failures'}
        </span>
        <span className="ml-1.5" style={{ color: '#fca5a5' }}>
          in the last {RECHECK_DAYS} days. Some branches may be missing data.
        </span>
        <Link
          to="/admin"
          className="ml-2 underline hover:no-underline"
          style={{ color: '#fecaca' }}
        >
          View Auto-Sync Health
        </Link>
      </div>
      <button
        onClick={handleDismiss}
        className="p-1 rounded hover:bg-white/10 shrink-0"
        title="Dismiss for 4 hours"
        style={{ color: '#fca5a5' }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
