import { useState, useEffect, useRef } from 'react';
import api from '../../api/client';
import {
  Wifi, WifiOff, RefreshCw, Building2, CheckCircle2, XCircle, Clock, Loader2, Play
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

export default function TallySyncPage() {
  const [health, setHealth] = useState<TallyHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [forceResync, setForceResync] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check Tally status on mount
  useEffect(() => {
    checkStatus();
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
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-theme-heading">Tally Sync</h1>
        <p className="text-sm text-theme-muted mt-1">Connect to Tally and sync financial data</p>
      </div>

      {/* Connection Status */}
      <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-theme-heading">Connection Status</h2>
          <button
            onClick={checkStatus}
            disabled={checking}
            className="flex items-center gap-1.5 text-xs font-medium text-accent-400 hover:text-accent-300 disabled:opacity-50"
          >
            <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
            Check
          </button>
        </div>

        {!health ? (
          <div className="text-sm text-theme-muted">Click "Check" to test Tally connection</div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {health.reachable ? (
                <div className="flex items-center gap-2 text-green-400">
                  <Wifi size={16} />
                  <span className="text-sm font-medium">Connected to Tally {health.version === 'prime' ? 'Prime' : 'ERP 9'}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-red-400">
                  <WifiOff size={16} />
                  <span className="text-sm font-medium">Not connected</span>
                </div>
              )}
              <span className="text-xs text-theme-faint">{health.host}:{health.port}</span>
            </div>
            {health.error && (
              <p className="text-xs text-red-400">{health.error}</p>
            )}
          </div>
        )}
      </div>

      {/* Companies from Tally */}
      {health?.reachable && health.companies.length > 0 && (
        <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
          <h2 className="text-sm font-semibold text-theme-heading mb-4">Companies in Tally</h2>
          <div className="space-y-2">
            {health.companies.map((comp, i) => (
              <button
                key={i}
                onClick={() => setSelectedCompany(comp.name)}
                className={`w-full flex items-center gap-3 p-3 rounded-xl text-left transition-colors ${
                  selectedCompany === comp.name
                    ? 'bg-accent-500/10 border border-accent-500/30'
                    : 'bg-dark-600 border border-transparent hover:border-dark-400/30'
                }`}
              >
                <Building2 size={16} className={selectedCompany === comp.name ? 'text-accent-400' : 'text-theme-muted'} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-theme-primary truncate">{comp.name}</p>
                  <p className="text-xs text-theme-faint">FY {comp.fyFrom}-{comp.fyTo}</p>
                </div>
                {comp.lastSyncAt ? (
                  <div className="flex items-center gap-1 text-xs text-green-400">
                    <CheckCircle2 size={12} />
                    <span>{new Date(comp.lastSyncAt).toLocaleDateString()}</span>
                  </div>
                ) : (
                  <span className="text-xs text-theme-faint">Never synced</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sync Controls */}
      {selectedCompany && (
        <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
          <h2 className="text-sm font-semibold text-theme-heading mb-4">Sync: {selectedCompany}</h2>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs text-theme-muted mb-1">From Date</label>
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="w-full bg-dark-600 border border-dark-400/30 rounded-lg px-3 py-2 text-sm text-theme-primary"
              />
            </div>
            <div>
              <label className="block text-xs text-theme-muted mb-1">To Date</label>
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="w-full bg-dark-600 border border-dark-400/30 rounded-lg px-3 py-2 text-sm text-theme-primary"
              />
            </div>
          </div>

          <div className="flex items-center gap-4 mb-4">
            <label className="flex items-center gap-2 text-xs text-theme-muted cursor-pointer">
              <input
                type="checkbox"
                checked={forceResync}
                onChange={e => setForceResync(e.target.checked)}
                className="rounded"
              />
              Force full re-sync (ignore cache)
            </label>
          </div>

          <button
            onClick={startSync}
            disabled={syncing || !fromDate || !toDate}
            className="flex items-center gap-2 bg-accent-500 hover:bg-accent-600 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
          >
            {syncing ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
            {syncing ? 'Syncing...' : 'Start Sync'}
          </button>
        </div>
      )}

      {/* Sync Progress */}
      {syncProgress && (
        <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
          <h2 className="text-sm font-semibold text-theme-heading mb-3">Sync Progress</h2>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {syncProgress.status === 'running' && <Loader2 size={14} className="animate-spin text-accent-400" />}
              {syncProgress.status === 'done' && <CheckCircle2 size={14} className="text-green-400" />}
              {syncProgress.status === 'error' && <XCircle size={14} className="text-red-400" />}
              {syncProgress.status === 'partial' && <Clock size={14} className="text-amber-400" />}
              <span className="text-sm text-theme-primary">{syncProgress.message}</span>
            </div>
            {syncProgress.progress !== undefined && (
              <div className="w-full bg-dark-600 rounded-full h-2">
                <div
                  className="bg-accent-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${syncProgress.progress}%` }}
                />
              </div>
            )}
            {syncProgress.results && (
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {Object.entries(syncProgress.results.counts || {}).map(([key, count]) => (
                  <div key={key} className="bg-dark-600 rounded-lg px-3 py-2">
                    <p className="text-xs text-theme-faint capitalize">{key}</p>
                    <p className="text-sm font-semibold text-theme-primary">{String(count)}</p>
                  </div>
                ))}
              </div>
            )}
            {syncProgress.results?.errors?.length > 0 && (
              <div className="mt-2 space-y-1">
                {syncProgress.results.errors.map((err: string, i: number) => (
                  <p key={i} className="text-xs text-red-400">- {err}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
