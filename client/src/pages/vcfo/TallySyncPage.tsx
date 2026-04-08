/**
 * Tally Sync — Connect to Tally and sync financial data
 * Styled to match TallyVision card/table/input theme
 */
import { useState, useEffect, useRef } from 'react';
import api from '../../api/client';
import {
  Wifi, WifiOff, RefreshCw, Building2, CheckCircle2, XCircle, Clock, Loader2, Play, AlertTriangle,
} from 'lucide-react';

interface TallyHealth {
  reachable: boolean;
  version: string | null;
  companies: { name: string; fyFrom: string; fyTo: string; dbCompanyId: number | null; lastSyncAt: string | null }[];
  error: string | null;
  host: string;
  port: number;
}

interface SyncProgress {
  step: string;
  status: string;
  message: string;
  progress?: number;
  results?: any;
}

interface SyncLogEntry {
  id: number;
  company_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  records_synced: number;
  error_message: string | null;
}

export default function TallySyncPage() {
  const [health, setHealth] = useState<TallyHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [forceResync, setForceResync] = useState(false);
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkStatus();
    loadSyncLog();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const res = await api.get('/vcfo/tally/status');
      setHealth(res.data.tally);
      if (res.data.sync?.inProgress) {
        setSyncing(true);
        setSyncProgress(res.data.sync.progress);
        startPolling();
      }
    } catch { }
    setChecking(false);
  };

  const loadSyncLog = async () => {
    try {
      const res = await api.get('/vcfo/tally/sync/log');
      setSyncLog(res.data || []);
    } catch { }
  };

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await api.get('/vcfo/tally/sync/progress');
        setSyncProgress(res.data.progress);
        if (!res.data.inProgress) {
          setSyncing(false);
          if (pollRef.current) clearInterval(pollRef.current);
          checkStatus();
          loadSyncLog();
        }
      } catch { }
    }, 2000);
  };

  const startSync = async () => {
    if (!selectedCompany || !fromDate || !toDate) return;
    setSyncing(true);
    setSyncProgress({ step: 'init', status: 'running', message: 'Starting sync...' });
    try {
      await api.post('/vcfo/tally/sync', {
        companyName: selectedCompany,
        fromDate, toDate,
        forceResync,
      });
      startPolling();
    } catch (err: any) {
      setSyncing(false);
      setSyncProgress({ step: 'error', status: 'error', message: err.response?.data?.error || err.message });
    }
  };

  // Auto-fill dates when company is selected
  useEffect(() => {
    if (!selectedCompany || !health) return;
    const comp = health.companies.find(c => c.name === selectedCompany);
    if (comp) {
      setFromDate(`${comp.fyFrom}-04-01`);
      setToDate(`${comp.fyTo}-03-31`);
    }
  }, [selectedCompany, health]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="card-tv p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-theme-heading">Tally Sync</h1>
            <p className="text-xs text-theme-faint mt-0.5">Connect to Tally and sync financial data</p>
          </div>
          <button
            onClick={checkStatus}
            disabled={checking}
            className="tv-tab active inline-flex items-center gap-1.5"
          >
            <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
            {checking ? 'Checking...' : 'Check Connection'}
          </button>
        </div>
      </div>

      {/* Connection Status */}
      <div className="card-tv p-5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-3">Connection Status</div>
        {!health ? (
          <div className="flex items-center gap-3 py-3">
            <AlertTriangle size={16} className="text-amber-400" />
            <span className="text-sm text-theme-muted">Click "Check Connection" to test Tally connectivity</span>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {health.reachable ? (
                <div className="flex items-center gap-2 text-emerald-400">
                  <Wifi size={16} />
                  <span className="text-sm font-semibold">Connected to Tally {health.version === 'prime' ? 'Prime' : 'ERP 9'}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-red-400">
                  <WifiOff size={16} />
                  <span className="text-sm font-semibold">Not connected</span>
                </div>
              )}
              <span className="text-[10px] px-2 py-0.5 rounded bg-[rgb(var(--c-dark-600))] text-theme-faint font-mono">{health.host}:{health.port}</span>
            </div>
            {health.error && (
              <p className="text-xs text-red-400 flex items-center gap-1.5">
                <XCircle size={12} /> {health.error}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Companies from Tally */}
      {health?.reachable && health.companies.length > 0 && (
        <div className="card-tv overflow-hidden">
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--c-dark-400) / 0.3)' }}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint">Companies in Tally</div>
          </div>
          <div className="divide-y" style={{ borderColor: 'rgb(var(--c-dark-400) / 0.15)' }}>
            {health.companies.map((comp, i) => (
              <button
                key={i}
                onClick={() => setSelectedCompany(comp.name)}
                className={`w-full flex items-center gap-4 px-5 py-3.5 text-left transition-colors ${
                  selectedCompany === comp.name
                    ? 'bg-indigo-500/8'
                    : 'hover:bg-[rgb(var(--c-dark-600)/0.5)]'
                }`}
              >
                <Building2 size={16} className={selectedCompany === comp.name ? 'text-indigo-400' : 'text-theme-faint'} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold truncate ${selectedCompany === comp.name ? 'text-indigo-400' : 'text-theme-primary'}`}>
                    {comp.name}
                  </p>
                  <p className="text-[10px] text-theme-faint mt-0.5">FY {comp.fyFrom} - {comp.fyTo}</p>
                </div>
                {comp.lastSyncAt ? (
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-medium">
                    <CheckCircle2 size={12} />
                    <span>Synced {new Date(comp.lastSyncAt).toLocaleDateString('en-IN')}</span>
                  </div>
                ) : (
                  <span className="text-[10px] text-theme-faint font-medium">Never synced</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sync Controls */}
      {selectedCompany && (
        <div className="card-tv p-5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-4">
            Sync Configuration — {selectedCompany}
          </div>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">From Date</label>
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="tv-input w-full"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-1">To Date</label>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="tv-input w-full"
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-theme-muted cursor-pointer">
              <input
                type="checkbox"
                checked={forceResync}
                onChange={e => setForceResync(e.target.checked)}
                className="rounded border-gray-600 bg-dark-600 text-indigo-500 focus:ring-indigo-500"
              />
              Force full re-sync (ignore cache)
            </label>

            <button
              onClick={startSync}
              disabled={syncing || !fromDate || !toDate}
              className="tv-tab active inline-flex items-center gap-2 disabled:opacity-40"
            >
              {syncing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {syncing ? 'Syncing...' : 'Start Sync'}
            </button>
          </div>
        </div>
      )}

      {/* Sync Progress */}
      {syncProgress && (
        <div className="card-tv p-5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint mb-3">Sync Progress</div>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {syncProgress.status === 'running' && <Loader2 size={14} className="animate-spin text-indigo-400" />}
              {syncProgress.status === 'done' && <CheckCircle2 size={14} className="text-emerald-400" />}
              {syncProgress.status === 'error' && <XCircle size={14} className="text-red-400" />}
              {syncProgress.status === 'partial' && <Clock size={14} className="text-amber-400" />}
              <span className="text-sm text-theme-primary">{syncProgress.message}</span>
            </div>
            {syncProgress.progress !== undefined && (
              <div className="w-full rounded-full h-2" style={{ backgroundColor: 'rgb(var(--c-dark-600))' }}>
                <div
                  className="h-2 rounded-full transition-all duration-300"
                  style={{ width: `${syncProgress.progress}%`, backgroundColor: '#4f46e5' }}
                />
              </div>
            )}
            {syncProgress.results && (
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(syncProgress.results.counts || {}).map(([key, count]) => (
                  <div key={key} className="rounded-lg px-3 py-2" style={{ backgroundColor: 'rgb(var(--c-dark-600) / 0.5)' }}>
                    <p className="text-[10px] text-theme-faint uppercase tracking-wider">{key}</p>
                    <p className="text-sm font-bold text-theme-primary">{String(count)}</p>
                  </div>
                ))}
              </div>
            )}
            {syncProgress.results?.errors?.length > 0 && (
              <div className="mt-2 space-y-1">
                {syncProgress.results.errors.map((err: string, i: number) => (
                  <p key={i} className="text-xs text-red-400 flex items-center gap-1.5">
                    <XCircle size={10} /> {err}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sync History */}
      {syncLog.length > 0 && (
        <div className="card-tv overflow-hidden">
          <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--c-dark-400) / 0.3)' }}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-faint">Recent Sync History</div>
          </div>
          <table className="tv-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Started</th>
                <th className="text-right">Records</th>
              </tr>
            </thead>
            <tbody>
              {syncLog.slice(0, 10).map(entry => (
                <tr key={entry.id}>
                  <td className="font-medium">{entry.company_name}</td>
                  <td>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                      entry.status === 'success' ? 'bg-emerald-500/15 text-emerald-400' :
                      entry.status === 'error' ? 'bg-red-500/15 text-red-400' :
                      'bg-amber-500/15 text-amber-400'
                    }`}>
                      {entry.status === 'success' && <CheckCircle2 size={10} />}
                      {entry.status === 'error' && <XCircle size={10} />}
                      {entry.status === 'running' && <Loader2 size={10} className="animate-spin" />}
                      {entry.status}
                    </span>
                  </td>
                  <td className="text-theme-faint">{new Date(entry.started_at).toLocaleString('en-IN')}</td>
                  <td className="text-right font-mono">{entry.records_synced || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
