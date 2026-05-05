// ─────────────────────────────────────────────────────────────────────────────
// AutoSyncHealthPanel — Admin Portal tab showing the per-branch × per-source
// run history for the last N days, so operators can tell at a glance:
//   - which scheduled runs failed last night
//   - which branches don't have auto-sync enabled
//   - which retries succeeded after an initial failure
// Click any cell for the full run details + a link to that day's trace zip.
//
// Backing endpoint: GET /api/sync/auto/health?days=7  (in routes/auto-sync.ts)
//
// Auth: admin / operational_head / super_admin. Server scopes the response
// to the caller's current tenant, so super-admins switching tenants see
// the matrix for whichever tenant they're currently in.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle2, XCircle, Minus, Loader2, RefreshCw, Activity, Clock,
  AlertTriangle, ExternalLink, X, Play,
} from 'lucide-react';
import api from '../../api/client';
import { formatIstTimestamp } from '../../utils/format';

/* ─── Types ──────────────────────────────────────────────── */

type Source = 'healthplix' | 'oneglance';

interface Cell {
  status: 'running' | 'success' | 'failed' | 'skipped';
  trigger: 'schedule' | 'catchup' | 'manual_test';
  started_at: string;
  finished_at: string | null;
  rows_imported: number | null;
  import_id: number | null;
  error: string | null;
  runId: number;
}

interface DayRun {
  date: string;
  cell: Cell | null;
  attemptCount: number;
}

interface SourceData {
  key: Source;
  enabled: boolean;
  runs: DayRun[];
}

interface BranchData {
  id: number | null;
  name: string;
  code: string | null;
  city: string | null;
  role: 'standalone' | 'central_store' | 'satellite';
  is_user_visible: number;
  sources: SourceData[];
}

interface HealthResponse {
  tenantSlug: string;
  tenantName: string | null;
  isMultiBranch: boolean;
  days: string[];
  branches: BranchData[];
}

/* ─── Component ─────────────────────────────────────────── */

export default function AutoSyncHealthPanel() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    branch: BranchData; source: SourceData; run: DayRun;
  } | null>(null);
  const [catchupRunning, setCatchupRunning] = useState(false);
  const [catchupConfirm, setCatchupConfirm] = useState(false);
  const [catchupNotice, setCatchupNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get(`/sync/auto/health?days=${days}`);
      setData(resp.data);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Failed to load auto-sync health');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh while a catchup is running so the user sees cells
  // flip from skipped/failed → running → success in near-real time.
  useEffect(() => {
    if (!catchupRunning) return;
    const t = setInterval(() => { load(); }, 15_000);
    return () => clearInterval(t);
  }, [catchupRunning, load]);

  const startCatchup = async () => {
    setCatchupConfirm(false);
    setCatchupRunning(true);
    setCatchupNotice('Catchup started. Each enabled (branch × source) will run sequentially — this can take 10–30 minutes depending on how many branches you have. The matrix below auto-refreshes every 15s.');
    try {
      await api.post('/sync/auto/run-tick-now');
      // Stop the auto-refresh after ~20 min — enough for a typical run,
      // and the user can refresh manually if it's still going.
      setTimeout(() => setCatchupRunning(false), 20 * 60 * 1000);
      load();
    } catch (e: any) {
      setCatchupNotice(`Failed to start catchup: ${e?.response?.data?.error || e?.message || 'unknown error'}`);
      setCatchupRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="mt-heading text-lg flex items-center gap-2">
            <Activity size={18} style={{ color: 'var(--mt-accent)' }} />
            Auto-Sync Health
          </h2>
          <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>
            Status of nightly scheduled syncs across every branch
            {data?.tenantName ? ` for ${data.tenantName}` : ''}. Click any
            cell to see details and download the run's trace.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={days}
            onChange={e => setDays(parseInt(e.target.value))}
            className="px-2 py-1 rounded text-sm"
            style={{
              background: 'var(--mt-bg-raised)',
              color: 'var(--mt-text-primary)',
              border: '1px solid var(--mt-border)',
            }}
          >
            {[7, 14, 30].map(n => (
              <option key={n} value={n}>Last {n} days</option>
            ))}
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1 rounded text-sm flex items-center gap-1.5"
            style={{
              background: 'var(--mt-bg-raised)',
              color: 'var(--mt-text-primary)',
              border: '1px solid var(--mt-border)',
              opacity: loading ? 0.5 : 1,
            }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => setCatchupConfirm(true)}
            disabled={catchupRunning}
            className="px-3 py-1 rounded text-sm flex items-center gap-1.5 font-medium"
            style={{
              background: catchupRunning
                ? 'var(--mt-bg-raised)'
                : 'color-mix(in srgb, #10b981 14%, transparent)',
              color: catchupRunning ? 'var(--mt-text-faint)' : '#10b981',
              border: `1px solid ${catchupRunning ? 'var(--mt-border)' : 'color-mix(in srgb, #10b981 30%, transparent)'}`,
              opacity: catchupRunning ? 0.6 : 1,
              cursor: catchupRunning ? 'not-allowed' : 'pointer',
            }}
            title="Run a catchup tick across every enabled (branch × source) right now. Already-successful targets are skipped."
          >
            {catchupRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {catchupRunning ? 'Catchup running' : 'Run catchup now'}
          </button>
        </div>
      </div>

      {/* Catchup notice + confirm dialog */}
      {catchupNotice && (
        <div className="p-3 rounded text-sm" style={{
          background: 'color-mix(in srgb, #10b981 8%, transparent)',
          border: '1px solid color-mix(in srgb, #10b981 25%, transparent)',
          color: 'var(--mt-text-secondary)',
        }}>
          {catchupNotice}
        </div>
      )}
      {catchupConfirm && (
        <div className="p-3 rounded text-sm space-y-2" style={{
          background: 'var(--mt-bg-raised)',
          border: '1px solid var(--mt-border)',
        }}>
          <div style={{ color: 'var(--mt-text-heading)' }}>
            Run catchup across every enabled (branch × source)?
          </div>
          <div style={{ color: 'var(--mt-text-faint)' }} className="text-xs">
            This fires the same logic as the 23:30 / 01:00 / 05:00 IST retry crons,
            immediately. Already-successful targets are skipped, so it's safe to run
            anytime. Each branch's data window is yesterday → today (matching the
            scheduled cron). Tonight's 23:00 IST main schedule will skip targets that
            succeed during this catchup — the data is already pulled, so there's
            nothing to re-fetch.
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={startCatchup}
              className="px-3 py-1 rounded text-sm font-medium"
              style={{
                background: '#10b981',
                color: 'white',
              }}
            >
              Yes, run catchup
            </button>
            <button
              onClick={() => setCatchupConfirm(false)}
              className="px-3 py-1 rounded text-sm"
              style={{
                background: 'var(--mt-bg)',
                color: 'var(--mt-text-secondary)',
                border: '1px solid var(--mt-border)',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 rounded text-sm flex items-start gap-2" style={{
          background: 'var(--mt-danger-bg)',
          color: 'var(--mt-danger-text)',
          border: '1px solid var(--mt-danger-border)',
        }}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {/* Legend */}
      <Legend />

      {loading && !data && (
        <div className="text-sm flex items-center gap-2" style={{ color: 'var(--mt-text-faint)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading...
        </div>
      )}

      {data && <Matrix data={data} onCellClick={(branch, source, run) => setSelected({ branch, source, run })} />}

      {selected && (
        <RunDetailModal
          tenantSlug={data?.tenantSlug || ''}
          branch={selected.branch}
          source={selected.source}
          run={selected.run}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ─── Legend ─────────────────────────────────────────────── */

function Legend() {
  const items = [
    { icon: <CheckCircle2 size={12} />, label: 'Success', color: '#10b981' },
    { icon: <XCircle size={12} />, label: 'Failed', color: '#ef4444' },
    { icon: <Loader2 size={12} className="animate-spin" />, label: 'Running', color: '#f59e0b' },
    { icon: <Minus size={12} />, label: 'No run', color: 'var(--mt-text-faint)' },
    { icon: <Clock size={12} />, label: 'Skipped (manual run took priority)', color: '#a78bfa' },
  ];
  return (
    <div className="flex items-center gap-4 flex-wrap text-xs" style={{ color: 'var(--mt-text-faint)' }}>
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5" style={{ color: it.color }}>
          {it.icon} <span style={{ color: 'var(--mt-text-faint)' }}>{it.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ─── Matrix ─────────────────────────────────────────────── */

function Matrix({ data, onCellClick }: {
  data: HealthResponse;
  onCellClick: (branch: BranchData, source: SourceData, run: DayRun) => void;
}) {
  const SOURCE_LABEL: Record<Source, string> = {
    healthplix: 'Healthplix',
    oneglance: 'Oneglance',
  };
  const SOURCE_COLOR: Record<Source, string> = {
    healthplix: '#10b981',
    oneglance: '#8b5cf6',
  };

  // Collapse the (branch, source) pairs into a flat row list, skipping
  // sources that don't apply to this branch role:
  //   central_store has Purchase only → only OG row, no HP row
  //   satellite has Sales/Stock/Transfer + HP for clinic if configured
  //   standalone has both
  const rows: Array<{ branch: BranchData; source: SourceData }> = [];
  for (const branch of data.branches) {
    for (const source of branch.sources) {
      // Hide HP for central_store (no clinic data flows through there).
      if (branch.role === 'central_store' && source.key === 'healthplix') continue;
      rows.push({ branch, source });
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--mt-border)' }}>
      <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--mt-bg-raised)' }}>
            <th className="text-left px-3 py-2 sticky left-0 z-10" style={{
              background: 'var(--mt-bg-raised)',
              color: 'var(--mt-text-secondary)',
              fontWeight: 600,
              minWidth: 220,
            }}>Branch / Source</th>
            {data.days.map(d => (
              <th key={d} className="text-center px-2 py-2" style={{
                color: 'var(--mt-text-secondary)',
                fontWeight: 600,
                minWidth: 64,
              }}>
                {formatDayHeader(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={data.days.length + 1} className="px-3 py-6 text-center text-sm" style={{ color: 'var(--mt-text-faint)' }}>
                No branches configured for this tenant.
              </td>
            </tr>
          )}
          {rows.map(({ branch, source }, idx) => {
            const branchLabel = branch.code ? `${branch.name} (${branch.code})` : branch.name;
            return (
              <tr key={`${branch.id}-${source.key}`} style={{
                borderTop: idx === 0 ? 'none' : '1px solid var(--mt-border)',
              }}>
                <td className="px-3 py-2 sticky left-0 z-10" style={{
                  background: 'var(--mt-bg)',
                }}>
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: SOURCE_COLOR[source.key] }} />
                    <div className="min-w-0">
                      <div className="font-medium truncate" style={{ color: 'var(--mt-text-heading)' }}>
                        {branchLabel}
                        {branch.role !== 'standalone' && (
                          <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded" style={{
                            background: 'var(--mt-bg-raised)',
                            color: 'var(--mt-text-faint)',
                          }}>
                            {branch.role === 'central_store' ? 'central' : 'satellite'}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px]" style={{ color: 'var(--mt-text-faint)' }}>
                        {SOURCE_LABEL[source.key]}{branch.city ? ` · ${branch.city}` : ''}
                      </div>
                    </div>
                  </div>
                </td>
                {source.runs.map(run => (
                  <td key={run.date} className="text-center px-1 py-1.5">
                    <CellBadge
                      run={run}
                      enabled={source.enabled}
                      onClick={() => onCellClick(branch, source, run)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Cell badge ─────────────────────────────────────────── */

function CellBadge({ run, enabled, onClick }: {
  run: DayRun;
  enabled: boolean;
  onClick: () => void;
}) {
  // No run + not enabled → distinct gray dash with "Not enabled" tooltip.
  if (!run.cell && !enabled) {
    return (
      <span
        className="inline-block w-7 h-7 rounded flex items-center justify-center"
        style={{
          background: 'var(--mt-bg-raised)',
          color: 'var(--mt-text-faint)',
          opacity: 0.4,
        }}
        title="Auto-sync not enabled for this branch + source"
      >
        <Minus size={11} />
      </span>
    );
  }
  // Enabled but no run on this date — could be in the past (cron didn't
  // fire? branch wasn't enabled yet?) or future (today's hasn't run yet).
  if (!run.cell) {
    return (
      <span
        className="inline-block w-7 h-7 rounded flex items-center justify-center cursor-help"
        style={{
          background: 'var(--mt-bg-raised)',
          color: 'var(--mt-text-faint)',
        }}
        title={`No run on ${run.date}`}
      >
        <Minus size={11} />
      </span>
    );
  }

  const status = run.cell.status;
  const tone = (() => {
    if (status === 'success') return { bg: 'rgba(16, 185, 129, 0.15)', fg: '#10b981', icon: <CheckCircle2 size={13} /> };
    if (status === 'failed') return { bg: 'rgba(239, 68, 68, 0.15)', fg: '#ef4444', icon: <XCircle size={13} /> };
    if (status === 'running') return { bg: 'rgba(245, 158, 11, 0.15)', fg: '#f59e0b', icon: <Loader2 size={13} className="animate-spin" /> };
    return { bg: 'rgba(167, 139, 250, 0.15)', fg: '#a78bfa', icon: <Clock size={13} /> };
  })();

  const tooltip = `${status.toUpperCase()} · ${run.cell.trigger}` +
    (run.cell.rows_imported != null ? ` · ${run.cell.rows_imported} rows` : '') +
    (run.attemptCount > 1 ? ` · ${run.attemptCount} attempts` : '') +
    `\n${formatIstTimestamp(run.cell.started_at)}` +
    (run.cell.error ? `\n${run.cell.error.slice(0, 200)}` : '');

  return (
    <button
      onClick={onClick}
      className="inline-block w-7 h-7 rounded flex items-center justify-center transition-all hover:scale-110 cursor-pointer"
      style={{ background: tone.bg, color: tone.fg }}
      title={tooltip}
    >
      {tone.icon}
    </button>
  );
}

/* ─── Run detail modal ───────────────────────────────────── */

function RunDetailModal({ tenantSlug: _tenantSlug, branch, source, run, onClose }: {
  tenantSlug: string;
  branch: BranchData;
  source: SourceData;
  run: DayRun;
  onClose: () => void;
}) {
  const [traceFiles, setTraceFiles] = useState<Array<{ name: string; mtime: string; size: number }>>([]);
  const [tracesLoading, setTracesLoading] = useState(false);

  // Best-effort trace listing. Tracing is only emitted by the Hyderabad
  // emr25 scraper (central_store + satellite branches), NOT by the
  // legacy emr7 OneGlance scraper used for standalone branches like
  // BTM Layout / Ashok Nagar / Mysore / Noida. Healthplix doesn't emit
  // traces at all yet. We hide the trace section when it isn't relevant
  // so users don't see Hyderabad traces in a Bangalore modal.
  const tracingApplies =
    source.key === 'oneglance' &&
    (branch.role === 'central_store' || branch.role === 'satellite');
  useEffect(() => {
    if (!tracingApplies || !run.cell) return;
    setTracesLoading(true);
    api.get('/debug/hyderabad').then(resp => {
      // Filter to traces matching this run's date. Trace filenames
      // look like "trace/trace-2026-05-04T17-31-38.zip".
      const dayPrefix = run.date; // YYYY-MM-DD
      const matches = (resp.data || []).filter((f: any) =>
        typeof f.name === 'string' &&
        f.name.startsWith('trace/') &&
        f.name.includes(dayPrefix)
      );
      setTraceFiles(matches);
    }).catch(() => { /* ignore — admin may not have access */ })
      .finally(() => setTracesLoading(false));
  }, [tracingApplies, run.date, run.cell]);

  const cell = run.cell;
  const branchLabel = branch.code ? `${branch.name} (${branch.code})` : branch.name;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        style={{
          background: 'var(--mt-bg)',
          border: '1px solid var(--mt-border)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b" style={{ borderColor: 'var(--mt-border)' }}>
          <div>
            <h3 className="mt-heading text-base">
              {branchLabel} · {source.key === 'healthplix' ? 'Healthplix' : 'Oneglance'} · {run.date}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
              Run #{cell?.runId ?? '—'} · trigger: {cell?.trigger ?? '—'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5">
            <X size={16} style={{ color: 'var(--mt-text-faint)' }} />
          </button>
        </div>

        <div className="p-4 space-y-3 text-sm">
          {!cell ? (
            <div style={{ color: 'var(--mt-text-faint)' }}>
              {source.enabled
                ? `No auto-sync ran for this branch on ${run.date}. Either the cron didn't fire, or auto-sync was toggled off at the time.`
                : `Auto-sync is not enabled for this branch + source. Toggle it on under Settings → Auto-Sync.`}
            </div>
          ) : (
            <>
              <DetailRow label="Status">
                <StatusBadge status={cell.status} />
              </DetailRow>
              <DetailRow label="Started">{formatIstTimestamp(cell.started_at)}</DetailRow>
              {cell.finished_at && (
                <DetailRow label="Finished">
                  {formatIstTimestamp(cell.finished_at)}
                  <span className="ml-2" style={{ color: 'var(--mt-text-faint)' }}>
                    ({durationLabel(cell.started_at, cell.finished_at)})
                  </span>
                </DetailRow>
              )}
              {cell.rows_imported != null && (
                <DetailRow label="Rows imported">
                  <span className="mt-num">{cell.rows_imported.toLocaleString('en-IN')}</span>
                </DetailRow>
              )}
              {run.attemptCount > 1 && (
                <DetailRow label="Attempts">
                  {run.attemptCount} (most recent shown)
                </DetailRow>
              )}
              {cell.error && (
                <div>
                  <div className="text-xs mb-1" style={{ color: 'var(--mt-text-faint)' }}>Error</div>
                  <div className="p-3 rounded text-xs font-mono whitespace-pre-wrap" style={{
                    background: 'var(--mt-danger-bg)',
                    color: 'var(--mt-danger-text)',
                    border: '1px solid var(--mt-danger-border)',
                    maxHeight: '200px',
                    overflowY: 'auto',
                  }}>
                    {cell.error}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Trace files (Hyderabad OneGlance only — legacy emr7 scraper
              for standalone branches doesn't emit traces) */}
          {tracingApplies && cell && (
            <div className="pt-2 border-t" style={{ borderColor: 'var(--mt-border)' }}>
              <div className="text-xs mb-2" style={{ color: 'var(--mt-text-faint)' }}>
                Playwright traces for this date
              </div>
              {tracesLoading ? (
                <div className="text-xs flex items-center gap-2" style={{ color: 'var(--mt-text-faint)' }}>
                  <Loader2 size={12} className="animate-spin" /> Looking up trace files...
                </div>
              ) : traceFiles.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>
                  No trace files found for {run.date}. Tracing must be enabled
                  (ONEGLANCE_HYDERABAD_TRACE != "0") and traces are only kept
                  on disk for a limited time.
                </div>
              ) : (
                <ul className="space-y-1">
                  {traceFiles.map(f => (
                    <li key={f.name} className="flex items-center gap-2 text-xs">
                      <a
                        href={`/api/debug/hyderabad/file?path=${encodeURIComponent(f.name)}`}
                        target="_blank" rel="noreferrer"
                        className="flex items-center gap-1.5 hover:underline"
                        style={{ color: 'var(--mt-accent)' }}
                      >
                        <ExternalLink size={11} />
                        {f.name.replace('trace/', '')}
                      </a>
                      <span style={{ color: 'var(--mt-text-faint)' }}>
                        ({(f.size / 1024).toFixed(0)} KB · {formatIstTimestamp(f.mtime)})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="text-[11px] mt-2" style={{ color: 'var(--mt-text-faint)' }}>
                Replay locally with: <code className="px-1 py-0.5 rounded" style={{ background: 'var(--mt-bg-raised)' }}>npx playwright show-trace &lt;file&gt;.zip</code>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <div className="text-xs w-28 shrink-0" style={{ color: 'var(--mt-text-faint)' }}>{label}</div>
      <div className="text-sm" style={{ color: 'var(--mt-text-heading)' }}>{children}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; icon: React.ReactNode }> = {
    success: { bg: 'rgba(16, 185, 129, 0.15)', fg: '#10b981', icon: <CheckCircle2 size={11} /> },
    failed: { bg: 'rgba(239, 68, 68, 0.15)', fg: '#ef4444', icon: <XCircle size={11} /> },
    running: { bg: 'rgba(245, 158, 11, 0.15)', fg: '#f59e0b', icon: <Loader2 size={11} className="animate-spin" /> },
    skipped: { bg: 'rgba(167, 139, 250, 0.15)', fg: '#a78bfa', icon: <Clock size={11} /> },
  };
  const t = map[status] || map.skipped;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs" style={{
      background: t.bg, color: t.fg,
    }}>
      {t.icon} {status.toUpperCase()}
    </span>
  );
}

/* ─── Helpers ────────────────────────────────────────────── */

function formatDayHeader(dateStr: string): string {
  // Compact — "Mon 04" or "Sun 28". Today gets bolded by the column
  // styling (handled inline above where we render).
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${dow} ${String(day).padStart(2, '0')}`;
}

function durationLabel(startedIso: string, finishedIso: string): string {
  const start = new Date(startedIso).getTime();
  const end = new Date(finishedIso).getTime();
  if (isNaN(start) || isNaN(end) || end < start) return '';
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}
