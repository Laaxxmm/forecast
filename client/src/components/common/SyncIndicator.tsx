// ─────────────────────────────────────────────────────────────────────────────
// SyncIndicator — "Synced through [date]" pill for page headers
//
// Shown in the top-right of pages that surface partial-day data so the user
// understands which day's numbers are finalised vs in-flight. Concretely:
// the indicator shows the most recent day in the dataset that is NOT today
// and that has non-zero data — that's the day we know is fully synced.
//
// The component accepts either:
//   • `syncedThrough` — an explicit Date the caller computed
//   • `streams[]` — operational-insights-shaped per-stream daily arrays;
//     the indicator derives the latest fully-synced day client-side
//
// When a real `last_synced_at` field lands on the API (see
// HOMEPAGE_BACKEND.md) callers should switch to passing it via
// `syncedThrough` directly. The streams-based fallback exists so the
// indicator can ship immediately without server work.
//
// Hidden when no synced day can be derived (brand-new tenants, future
// months, etc.). Shows an amber dot when the synced-through date is
// older than 1 day from today (i.e., yesterday is healthy, two days ago
// is stale).
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatShortDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

interface SyncIndicatorProps {
  /** Pre-computed sync-through date (preferred when caller already has it). */
  syncedThrough?: Date | null;
  /** operational-insights-shaped per-stream daily arrays (fallback source). */
  streams?: Array<{ daily?: Array<{ date?: string; revenue?: number; patients?: number; transactions?: number }> }>;
  /** Human-readable next sync time for the tooltip (defaults to "11 PM"). */
  nextSyncTime?: string;
}

export default function SyncIndicator({ syncedThrough, streams, nextSyncTime = '11 PM' }: SyncIndicatorProps) {
  const date = useMemo(() => {
    if (syncedThrough) return syncedThrough;
    if (!streams) return null;
    return computeSyncedThrough(streams);
  }, [syncedThrough, streams]);

  if (!date) return null;

  const stale = isStale(date);
  const dotColor = stale ? '#BA7517' : '#1D9E75';
  const labelLeft = stale ? 'Sync delayed · last' : 'Synced through';
  const tooltip = stale
    ? 'Data may be older than usual. Contact support if this persists.'
    : `Today's data updates each night at ~${nextSyncTime}. Last full sync: ${formatShortDate(date)}.`;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md text-[11px] whitespace-nowrap"
      style={{
        background: 'var(--mt-bg-muted)',
        border: '0.5px solid var(--mt-border)',
        padding: '6px 10px',
      }}
      title={tooltip}
    >
      <span
        className="inline-block rounded-full shrink-0"
        style={{ width: 8, height: 8, background: dotColor }}
        aria-hidden="true"
      />
      <span style={{ color: 'var(--mt-text-faint)' }}>{labelLeft}</span>
      <span style={{ color: 'var(--mt-text-secondary)', fontWeight: 500 }}>
        {formatShortDate(date)}
      </span>
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

// Derive the most recent date in any stream's daily[] that is strictly
// before today and carries non-zero data. We accept any of revenue /
// patients / transactions because different streams populate different
// fields (clinic uses patients, pharmacy uses revenue + transactions).
// Strings are compared lexicographically, which is safe for ISO YYYY-MM-DD.
function computeSyncedThrough(streams: Array<{ daily?: Array<{ date?: string; revenue?: number; patients?: number; transactions?: number }> }>): Date | null {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let max: string | null = null;
  for (const s of streams || []) {
    for (const d of s.daily || []) {
      const date = String(d.date || '');
      if (!date || date >= todayStr) continue;
      const hasData =
        (Number(d.revenue) || 0) > 0 ||
        (Number(d.patients) || 0) > 0 ||
        (Number(d.transactions) || 0) > 0;
      if (!hasData) continue;
      if (!max || date > max) max = date;
    }
  }
  if (!max) return null;
  const [y, m, dd] = max.split('-').map(Number);
  return new Date(y, m - 1, dd);
}

// "Stale" = synced-through is more than one day before today. Yesterday
// is considered healthy (data syncs each night around 11 PM, so seeing
// yesterday after midnight is normal).
function isStale(syncedThrough: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return syncedThrough < yesterday;
}
