import type { AgentStatus, SyncResult } from '../../lib/types';

interface Props {
  status: AgentStatus | null;
  syncing: boolean;
  recent: SyncResult[];
  onSync: () => void;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 10_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Home page — at-a-glance view: connection health (Tally + Cloud), the most
 * recent sync summary, and a Recent Activity list. The big "Sync Now" sits in
 * the page header so it's always reachable.
 */
export default function HomePage({ status, syncing, recent, onSync }: Props) {
  if (!status) {
    return (
      <>
        <div className="page-header">
          <div>
            <div className="page-title">Home</div>
            <div className="page-subtitle">Loading…</div>
          </div>
        </div>
        <div className="page-content">
          <div className="card"><div className="status-detail">Loading…</div></div>
        </div>
      </>
    );
  }

  const { tally, server, lastSync, config } = status;
  const clients = config.clients || [];
  const canSync = clients.length > 0 && tally.reachable;

  // Headline for the last-sync card.
  let summaryHead = 'Never synced';
  let summaryDetail = clients.length === 0
    ? 'Link a client first, then run your first sync from the Companies page.'
    : 'Click "Sync Now" above to push your first batch.';
  let summaryOk = false;
  if (lastSync) {
    summaryOk = lastSync.ok;
    summaryHead = lastSync.ok
      ? `Last sync at ${fmtTime(lastSync.finishedAt)}`
      : `Last sync failed (${timeAgo(lastSync.finishedAt)})`;
    const focus = lastSync.company || (lastSync.perClient && lastSync.perClient[0]?.companies?.[0]) || '';
    summaryDetail = lastSync.ok
      ? `${lastSync.rowsSent} entries · ${focus || 'all companies'}`
      : (lastSync.error || 'failed');
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Home</div>
          <div className="page-subtitle">Connection status &amp; last sync</div>
        </div>
        <button
          className="sync-now-btn"
          onClick={onSync}
          disabled={syncing || !canSync}
          title={!canSync ? (clients.length === 0 ? 'Link a client first' : 'Tally is offline') : undefined}
        >
          {syncing ? 'Syncing…' : '⟳ Sync Now'}
        </button>
      </div>

      <div className="page-content">
        <div className="health-grid">
          <div className={`health-card ${tally.reachable ? 'ok' : 'fail'}`}>
            <div className={`health-icon ${tally.reachable ? 'ok' : 'fail'}`}>{tally.reachable ? '✓' : '!'}</div>
            <div>
              <div className="health-name">{tally.reachable ? 'Tally connected' : 'Tally offline'}</div>
              <div className="health-detail">
                {tally.reachable
                  ? `${tally.version || 'unknown'} · ${tally.host}:${tally.port}`
                  : (tally.error || 'Unreachable')}
              </div>
            </div>
          </div>
          <div className={`health-card ${server.reachable ? 'ok' : 'fail'}`}>
            <div className={`health-icon ${server.reachable ? 'ok' : 'fail'}`}>{server.reachable ? '✓' : '!'}</div>
            <div>
              <div className="health-name">{server.reachable ? 'Cloud connected' : 'Cloud unreachable'}</div>
              <div className="health-detail">{(server.url || '').replace(/^https?:\/\//, '') || (server.error || '')}</div>
            </div>
          </div>
        </div>

        <div className="last-sync-card">
          <div className="sync-summary">
            <div>
              <div className="sync-summary-line">
                {summaryOk && <span className="check-pill">✓ all good</span>}
                {!summaryOk && lastSync && <span className="pill error">FAILED</span>}
                {summaryHead}
              </div>
              <div className="sync-summary-meta">{summaryDetail}</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Recent activity</div>
          {recent.length === 0 ? (
            <div className="activity-empty">No syncs yet.</div>
          ) : (
            recent.slice(0, 6).map((r, i) => {
              const focus = r.company || (r.perClient && r.perClient[0]?.companies?.[0]) || 'all companies';
              return (
                <div key={`${r.startedAt}-${i}`} className="activity-row">
                  <span className="activity-time">{fmtTime(r.startedAt)}</span>
                  <span className="activity-msg">
                    <b>{focus}</b> {r.ok ? 'synced' : 'failed'}
                  </span>
                  <span className="activity-rows">{r.rowsSent} rows</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
