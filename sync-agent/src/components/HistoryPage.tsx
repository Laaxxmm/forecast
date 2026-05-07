import { useEffect, useMemo, useState } from 'react';
import type { SyncResult, SyncStepLog } from '../../lib/types';

type Filter = 'all' | 'failed' | '24h' | '7d';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today, ${t}`;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

function summaryFor(r: SyncResult): string {
  const focus = r.company || (r.perClient && r.perClient[0]?.companies?.[0]) || 'all companies';
  if (!r.ok) return `${focus} · failed`;
  return `${focus} · ${r.rowsSent.toLocaleString()} entries`;
}

/**
 * History page — scrollable list of past sync runs with filter chips and an
 * Export button. Click a row to expand the per-step trace inline.
 */
export default function HistoryPage() {
  const [items, setItems] = useState<SyncResult[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [exporting, setExporting] = useState<'json' | 'csv' | null>(null);
  const [exportToast, setExportToast] = useState<string | null>(null);

  async function refresh() {
    try {
      const h = await window.vcfo.getSyncHistory();
      setItems(h);
    } catch {
      setItems([]);
    }
  }

  useEffect(() => {
    refresh();
    const unsub = window.vcfo.onStatus(() => refresh());
    return () => unsub();
  }, []);

  const filtered = useMemo(() => {
    if (!items) return [];
    const now = Date.now();
    const cutoff24 = now - 24 * 3600 * 1000;
    const cutoff7 = now - 7 * 24 * 3600 * 1000;
    return items.filter((r) => {
      if (filter === 'failed') return !r.ok;
      const t = new Date(r.finishedAt).getTime();
      if (filter === '24h') return t >= cutoff24;
      if (filter === '7d') return t >= cutoff7;
      return true;
    });
  }, [items, filter]);

  const counts = useMemo(() => {
    if (!items) return { all: 0, failed: 0 };
    return { all: items.length, failed: items.filter((r) => !r.ok).length };
  }, [items]);

  const handleExport = async (format: 'json' | 'csv') => {
    setExporting(format);
    try {
      const res = await window.vcfo.exportSyncHistory(format);
      if (res.ok) {
        setExportToast(`Exported to ${res.path}`);
        setTimeout(() => setExportToast(null), 3500);
      } else if (!res.cancelled) {
        setExportToast(`Export failed: ${res.error || 'unknown'}`);
        setTimeout(() => setExportToast(null), 4000);
      }
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Sync history</div>
          <div className="page-subtitle">Click a row for full details</div>
        </div>
      </div>

      <div className="page-content">
        <div className="filter-row">
          <button
            className={`filter-chip ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >All ({counts.all})</button>
          <button
            className={`filter-chip ${filter === 'failed' ? 'active' : ''}`}
            onClick={() => setFilter('failed')}
          >Failed ({counts.failed})</button>
          <button
            className={`filter-chip ${filter === '24h' ? 'active' : ''}`}
            onClick={() => setFilter('24h')}
          >24 hrs</button>
          <button
            className={`filter-chip ${filter === '7d' ? 'active' : ''}`}
            onClick={() => setFilter('7d')}
          >7 days</button>
          <button
            className="export-btn"
            onClick={() => handleExport('json')}
            disabled={exporting !== null || !items || items.length === 0}
            title="Save sync history as JSON"
          >
            {exporting === 'json' ? '…' : '↓'} Export JSON
          </button>
          <button
            className="export-btn"
            onClick={() => handleExport('csv')}
            disabled={exporting !== null || !items || items.length === 0}
            title="Save sync history as CSV"
          >
            {exporting === 'csv' ? '…' : '↓'} CSV
          </button>
        </div>

        {exportToast && (
          <div className="card" style={{ background: 'var(--emerald-bg)', borderColor: 'var(--emerald-border)', color: 'var(--emerald)', fontSize: 11 }}>
            {exportToast}
          </div>
        )}

        {items === null ? (
          <div className="history-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="history-empty">
            {items.length === 0 ? 'No sync history yet. Run your first sync from the Home page.' : 'No runs match this filter.'}
          </div>
        ) : (
          <div className="history-list">
            {filtered.map((r, idx) => {
              const isOpen = open === idx;
              return (
                <div key={`${r.startedAt}-${idx}`} style={{ borderRadius: 6, overflow: 'hidden' }}>
                  <button
                    className="history-card"
                    onClick={() => setOpen(isOpen ? null : idx)}
                    style={isOpen ? { borderRadius: '6px 6px 0 0', borderBottomColor: 'var(--bg-2)' } : undefined}
                  >
                    <span className={`history-status ${r.ok ? 'ok' : 'fail'}`} />
                    <span className="history-time">{fmtTime(r.startedAt)}</span>
                    <span className="history-summary">
                      <b>{r.company || (r.perClient && r.perClient[0]?.companies?.[0]) || 'all'}</b>
                      {' · '}
                      {r.ok ? `${r.rowsSent.toLocaleString()} entries` : 'failed'}
                    </span>
                    <span className="history-stats">
                      {fmtDuration(stepTotal(r.steps) || (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()))}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="history-detail">
                      {r.error && <div className="error-text" style={{ marginBottom: 8 }}>{r.error}</div>}
                      {r.windowFrom && (
                        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 6 }}>
                          Window: {r.windowFrom} → {r.windowTo}
                        </div>
                      )}
                      {r.steps && r.steps.length > 0 ? (
                        <table className="history-detail-table">
                          <thead>
                            <tr>
                              <th>Kind</th>
                              <th>Company</th>
                              <th>Rows</th>
                              <th>Duration</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.steps.map((s, i) => {
                              const isSkip = s.kind === 'skipped';
                              const isRetry = s.kind === 'retry';
                              const cls = isSkip ? 'warn' : (s.ok ? 'ok' : 'err');
                              const txt = isSkip ? (s.error || 'skipped') : (s.ok ? 'ok' : (s.error || 'failed'));
                              const kind = isRetry && s.retryOfKind ? `retry (${s.retryOfKind})` : s.kind;
                              return (
                                <tr key={i}>
                                  <td>{kind}</td>
                                  <td>{s.company || '—'}</td>
                                  <td>{isSkip ? '—' : `${s.rowsAccepted}/${s.rowsSent}`}</td>
                                  <td>{isSkip ? '—' : fmtDuration(s.durationMs)}</td>
                                  <td className={cls}>{txt}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>No step trace recorded for this run.</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
