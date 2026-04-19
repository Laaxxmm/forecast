import { useEffect, useState } from 'react';
import type { SyncResult, SyncStepLog } from '../../lib/types';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function stepTotal(steps?: SyncStepLog[]): number {
  if (!steps) return 0;
  return steps.reduce((a, s) => a + (s.durationMs || 0), 0);
}

export default function LogView() {
  const [items, setItems] = useState<SyncResult[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  async function refresh() {
    try {
      const h = await window.vcfo.getSyncHistory();
      setItems(h);
    } catch (err) { console.error(err); setItems([]); }
  }

  useEffect(() => {
    refresh();
    // Re-pull when the main process pushes a status update (i.e. a sync just finished).
    const unsub = window.vcfo.onStatus(() => refresh());
    return () => unsub();
  }, []);

  if (items === null) {
    return <div className="card"><div className="status-row"><span className="status-detail">Loading…</span></div></div>;
  }

  if (items.length === 0) {
    return (
      <>
        <div className="card">
          <div className="status-row">
            <span className="status-detail">No sync history yet. Run your first sync from the Status tab.</span>
          </div>
        </div>
        <div className="spacer" />
      </>
    );
  }

  return (
    <>
      <div className="log-list">
        {items.map((r, idx) => {
          const isOpen = open === idx;
          const okDot = r.ok ? 'dot-on' : 'dot-off';
          return (
            <div key={`${r.startedAt}-${idx}`} className="card log-card">
              <button
                className="log-header"
                onClick={() => setOpen(isOpen ? null : idx)}
              >
                <div className="status-left">
                  <span className={`dot ${okDot}`} />
                  <span className="status-label">{fmtTime(r.startedAt)}</span>
                </div>
                <span className="status-detail">
                  {r.rowsSent} rows · {fmtDuration(stepTotal(r.steps) || (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()))}
                </span>
              </button>

              {isOpen && (
                <div className="log-body">
                  {r.company && (
                    <div className="meta-grid">
                      <span className="meta-key">Company</span>
                      <span className="meta-value">{r.company}</span>
                      {r.windowFrom && (
                        <>
                          <span className="meta-key">Window</span>
                          <span className="meta-value">{r.windowFrom} → {r.windowTo}</span>
                        </>
                      )}
                    </div>
                  )}
                  {r.error && <div className="error-text">{r.error}</div>}
                  {r.perClient && r.perClient.length > 1 && (
                    // Multi-client roll-up: one row per client, accepted rows +
                    // pass/fail dot. Only shown when the run actually touched
                    // more than one client (Slice 3 runs); single-client runs
                    // keep the flat step table below unchanged.
                    <table className="log-steps">
                      <thead>
                        <tr><th>Client</th><th>Rows</th><th>Companies</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {r.perClient.map((pc) => (
                          <tr key={pc.clientSlug}>
                            <td title={pc.clientSlug}>{pc.clientName}</td>
                            <td>{pc.rowsSent}</td>
                            <td title={pc.companies.join(', ')}>{pc.companies.length}</td>
                            <td className={pc.ok ? 'ok' : 'err'} title={pc.error}>
                              {pc.ok ? 'ok' : (pc.error || 'failed')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {r.steps && r.steps.length > 0 && (() => {
                    // Show the Client column only when at least one step is
                    // tagged (Slice 3 runs). Legacy history predates the
                    // refactor and has no tag — suppressing the column
                    // avoids a sea of "—" cells for those rows.
                    const anyClientTag = r.steps.some((s) => s.clientSlug);
                    return (
                      <table className="log-steps">
                        <thead>
                          <tr>
                            {anyClientTag && <th>Client</th>}
                            <th>Kind</th><th>Company</th><th>Rows</th><th>Duration</th><th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.steps!.map((s, i) => {
                            const isSkip = s.kind === 'skipped';
                            const isRetry = s.kind === 'retry';
                            const statusClass = isSkip ? 'warn' : (s.ok ? 'ok' : 'err');
                            const statusText = isSkip
                              ? (s.error || 'skipped')
                              : (s.ok ? 'ok' : (s.error || 'failed'));
                            const kindLabel = isRetry && s.retryOfKind
                              ? `retry (${s.retryOfKind})`
                              : s.kind;
                            return (
                              <tr key={i}>
                                {anyClientTag && (
                                  <td title={s.clientSlug}>{s.clientName || '—'}</td>
                                )}
                                <td title={isRetry ? 'Replayed from offline queue' : undefined}>
                                  {kindLabel}
                                </td>
                                <td title={s.company}>{s.company}</td>
                                <td>{isSkip ? '—' : `${s.rowsAccepted}/${s.rowsSent}`}</td>
                                <td>{isSkip ? '—' : fmtDuration(s.durationMs)}</td>
                                <td className={statusClass}>
                                  {statusText}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="footer-hint">Showing the last {items.length} syncs. Older runs are trimmed.</div>
    </>
  );
}
