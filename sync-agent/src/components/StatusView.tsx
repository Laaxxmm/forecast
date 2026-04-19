import type { AgentStatus } from '../../lib/types';

interface Props {
  status: AgentStatus | null;
  syncing: boolean;
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

export default function StatusView({ status, syncing, onSync }: Props) {
  if (!status) {
    return (
      <div className="card">
        <div className="status-row">
          <div className="status-left">
            <span className="dot dot-idle" />
            <span className="status-label">Loading…</span>
          </div>
        </div>
      </div>
    );
  }

  const { tally, server, lastSync, config, queueSize } = status;
  const pending = queueSize || 0;
  const discoveredNames = (tally.companies || []).map((c) => c.name);
  const clients = config.clients || [];

  // Slice 3: aggregate "how many companies across how many clients". Each
  // client's target set is (if whitelist empty) all discovered OR (if set)
  // the intersection with discovered. Missing entries show as "+N offline"
  // so the user knows their whitelist references companies that aren't
  // currently loaded in Tally.
  const perClientTargets = clients.map((c) => {
    const whitelist = c.tallyCompanyNames || [];
    if (whitelist.length === 0) {
      return { client: c, targets: discoveredNames, missing: [] as string[] };
    }
    return {
      client: c,
      targets: whitelist.filter((n) => discoveredNames.includes(n)),
      missing: whitelist.filter((n) => !discoveredNames.includes(n)),
    };
  });
  const totalTargets = new Set(perClientTargets.flatMap((p) => p.targets)).size;
  const totalMissing = perClientTargets.reduce((n, p) => n + p.missing.length, 0);

  let companyLine: string;
  if (clients.length === 0) {
    companyLine = '(no clients linked)';
  } else if (discoveredNames.length === 0) {
    companyLine = '(none loaded in Tally)';
  } else if (clients.length === 1) {
    const [only] = perClientTargets;
    if (only.targets.length === 1) {
      companyLine = only.targets[0];
    } else if ((only.client.tallyCompanyNames || []).length === 0) {
      companyLine = `all ${discoveredNames.length} (auto)`;
    } else if (only.targets.length === 0) {
      companyLine = `0 of ${only.missing.length} selected loaded`;
    } else {
      companyLine = `${only.targets.length} selected${only.missing.length > 0 ? ` (+${only.missing.length} offline)` : ''}`;
    }
  } else {
    companyLine = `${totalTargets} compan${totalTargets === 1 ? 'y' : 'ies'} across ${clients.length} clients${totalMissing > 0 ? ` (+${totalMissing} offline)` : ''}`;
  }

  const singleClient = clients.length === 1 ? clients[0] : null;
  const lastPerClient = lastSync?.perClient || [];

  return (
    <>
      <div className="card">
        <div className="status-row">
          <div className="status-left">
            <span className={`dot ${tally.reachable ? 'dot-on' : 'dot-off'}`} />
            <span className="status-label">Tally</span>
          </div>
          <span className="status-detail">
            {tally.reachable
              ? `${tally.version ?? 'ok'} · ${tally.host}:${tally.port}`
              : tally.error || 'offline'}
          </span>
        </div>
        <div className="status-row">
          <div className="status-left">
            <span className={`dot ${server.reachable ? 'dot-on' : 'dot-off'}`} />
            <span className="status-label">Cloud</span>
          </div>
          <span className="status-detail">
            {server.reachable ? 'connected' : (server.error || 'unreachable')}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="meta-grid">
          <span className="meta-key">{clients.length > 1 ? 'Clients' : 'Client'}</span>
          <span
            className="meta-value"
            title={clients.map((c) => c.name).join(', ') || 'No clients linked'}
          >
            {clients.length === 0
              ? '(none)'
              : singleClient
                ? singleClient.name
                : `${clients.length} linked`}
          </span>
          <span className="meta-key">{totalTargets > 1 ? 'Companies' : 'Company'}</span>
          <span
            className="meta-value"
            title={
              totalTargets > 0
                ? Array.from(new Set(perClientTargets.flatMap((p) => p.targets))).join(', ')
                : undefined
            }
          >
            {companyLine}
          </span>
          <span className="meta-key">Last sync</span>
          <span className="meta-value">
            {lastSync
              ? `${timeAgo(lastSync.finishedAt)} · ${lastSync.rowsSent} rows${lastSync.ok ? '' : ' · failed'}`
              : 'never'}
          </span>
          <span className="meta-key">Auto-sync</span>
          <span className="meta-value">
            {config.autoSyncEnabled ? `every ${config.syncIntervalMinutes} min` : 'paused'}
          </span>
          {pending > 0 && (
            <>
              <span className="meta-key">Retry queue</span>
              <span
                className="meta-value"
                title="Batches that failed to reach the server. They will replay on the next sync."
              >
                {pending} batch{pending === 1 ? '' : 'es'} pending
              </span>
            </>
          )}
        </div>
        {lastSync?.error && (
          <div className="error-text">{lastSync.error}</div>
        )}
      </div>

      {/* Per-client breakdown — only meaningful for 2+ linked clients. */}
      {clients.length > 1 && (
        <div className="card">
          <div className="status-row status-row-header">
            <span className="status-label">Per-client</span>
            <span className="status-detail">
              last run: {lastSync ? timeAgo(lastSync.finishedAt) : 'never'}
            </span>
          </div>
          <ul className="per-client-list">
            {clients.map((c) => {
              const summary = lastPerClient.find((p) => p.clientSlug === c.slug);
              const plannedTargets = perClientTargets.find((p) => p.client.slug === c.slug);
              const plannedCount = plannedTargets?.targets.length ?? 0;
              return (
                <li key={c.slug} className="per-client-item">
                  <div className="per-client-main">
                    <div className="per-client-name">{c.name}</div>
                    <div className="per-client-slug">
                      {c.slug}
                      {plannedCount > 0 && (
                        <span className="per-client-planned">
                          {' · '}{plannedCount} compan{plannedCount === 1 ? 'y' : 'ies'} planned
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="per-client-right">
                    <span className={`dot ${summary ? (summary.ok ? 'dot-on' : 'dot-off') : 'dot-idle'}`} />
                    <span className="status-detail">
                      {summary
                        ? `${summary.rowsSent} row${summary.rowsSent === 1 ? '' : 's'}${summary.ok ? '' : ' · failed'}`
                        : 'not yet synced'}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="btn-row">
        <button className="btn btn-primary" onClick={onSync} disabled={syncing || clients.length === 0}>
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>

      <div className="spacer" />

      <div className="footer-hint">
        The app keeps running in your system tray. Right-click the tray icon for options.
      </div>
    </>
  );
}
