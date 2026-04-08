import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api/client';
import { Stethoscope, Pill, ShoppingCart, Upload, CheckCircle, AlertCircle, Trash2,
         RefreshCw, Cloud, Settings as SettingsIcon, Calendar,
         LogIn, Building2, FileSearch, CalendarRange, Download, Database, Check, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

type Source = 'healthplix' | 'oneglance-sales' | 'oneglance-purchase';
type Mode = 'upload' | 'sync';
type SyncSource = 'healthplix' | 'oneglance';

interface ImportLog {
  id: number;
  source: string;
  filename: string;
  rows_imported: number;
  date_range_start: string;
  date_range_end: string;
  status: string;
  created_at: string;
}

const allSources: { key: Source; label: string; desc: string; icon: any; endpoint: string; integration: string }[] = [
  { key: 'healthplix', label: 'Healthplix', desc: 'Clinic billing report', icon: Stethoscope, endpoint: '/import/healthplix', integration: 'healthplix' },
  { key: 'oneglance-sales', label: 'Oneglance Sales', desc: 'Pharmacy sales report', icon: Pill, endpoint: '/import/oneglance-sales', integration: 'oneglance' },
  { key: 'oneglance-purchase', label: 'Oneglance Purchase', desc: 'Pharmacy purchase report', icon: ShoppingCart, endpoint: '/import/oneglance-purchase', integration: 'oneglance' },
];

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDefaultDates() {
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: fmtDate(prevMonth), to: fmtDate(lastDay) };
}

const HP_SYNC_STEPS = [
  { key: 'login',    label: 'Logging in',           desc: 'Connecting to Healthplix',        icon: LogIn },
  { key: 'clinic',   label: 'Selecting clinic',     desc: 'Choosing your clinic location',    icon: Building2 },
  { key: 'navigate', label: 'Opening reports',      desc: 'Navigating to Bill Report',        icon: FileSearch },
  { key: 'dates',    label: 'Setting date range',   desc: 'Configuring report dates',         icon: CalendarRange },
  { key: 'generate', label: 'Generating report',    desc: 'Waiting for report to load',       icon: RefreshCw },
  { key: 'download', label: 'Downloading file',     desc: 'Saving the Excel report',          icon: Download },
  { key: 'parsing',  label: 'Parsing data',         desc: 'Reading rows from the report',     icon: FileSearch },
  { key: 'saving',   label: 'Saving to database',   desc: 'Importing records',                icon: Database },
  { key: 'complete', label: 'Complete',              desc: 'Sync finished successfully',       icon: Check },
];

const OG_SYNC_STEPS = [
  { key: 'login',    label: 'Logging in',           desc: 'Connecting to Oneglance',          icon: LogIn },
  { key: 'navigate', label: 'Opening reports',      desc: 'Navigating to Pharmacy Reports',   icon: FileSearch },
  { key: 'sales',    label: 'Sales report',         desc: 'Downloading sales CSV',            icon: Download },
  { key: 'purchase', label: 'Purchase report',      desc: 'Downloading purchase CSV',         icon: Download },
  { key: 'parsing',  label: 'Parsing data',         desc: 'Reading rows from CSV',            icon: FileSearch },
  { key: 'saving',   label: 'Saving to database',   desc: 'Importing records',                icon: Database },
  { key: 'complete', label: 'Complete',              desc: 'Sync finished successfully',       icon: Check },
];

function getStepStatus(stepKey: string, currentStep: string, isError: boolean, steps: typeof HP_SYNC_STEPS): 'done' | 'active' | 'pending' | 'error' {
  const stepOrder = steps.map(s => s.key);
  const currentIdx = stepOrder.indexOf(currentStep);
  const stepIdx = stepOrder.indexOf(stepKey);
  if (isError && stepKey === currentStep) return 'error';
  if (stepKey === currentStep) return 'active';
  if (stepIdx < currentIdx) return 'done';
  return 'pending';
}

function SyncStepTracker({ status, steps }: { status: { step: string; message: string; pct: number; error?: string }; steps: typeof HP_SYNC_STEPS }) {
  const isError = status.step === 'error';
  const errorStep = isError ? (
    status.message?.includes('login') || status.message?.includes('Login') ? 'login' :
    status.message?.includes('clinic') ? 'clinic' :
    status.message?.includes('menu') || status.message?.includes('report') || status.message?.includes('Frontdesk') ? 'navigate' :
    status.message?.includes('date') || status.message?.includes('calendar') ? 'dates' :
    status.message?.includes('generat') ? 'generate' :
    status.message?.includes('download') || status.message?.includes('Download') ? 'download' :
    status.message?.includes('pars') ? 'parsing' :
    status.message?.includes('sav') || status.message?.includes('database') ? 'saving' :
    status.message?.includes('sales') || status.message?.includes('Sales') ? 'sales' :
    status.message?.includes('purchase') || status.message?.includes('Purchase') ? 'purchase' :
    'login'
  ) : status.step;
  const displayStep = isError ? errorStep : status.step;

  return (
    <div className="mb-5 bg-dark-600 border border-dark-400/50 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-semibold text-theme-primary">Sync Progress</h4>
        <span className="text-xs text-theme-faint">
          {isError ? 'Failed' : status.step === 'complete' ? 'Done' : `${status.pct || 0}%`}
        </span>
      </div>
      <div className="w-full bg-dark-800 rounded-full h-1.5 mb-5">
        <div
          className={`h-1.5 rounded-full transition-all duration-700 ease-out ${
            isError ? 'bg-red-500' : status.step === 'complete' ? 'bg-accent-500' : 'bg-accent-500'
          }`}
          style={{ width: `${isError ? Math.max(status.pct || 5, 5) : status.pct || 0}%` }}
        />
      </div>
      <div className="space-y-1">
        {steps.map((step) => {
          const stepStatus = getStepStatus(step.key, displayStep, isError, steps);
          const Icon = step.icon;
          return (
            <div
              key={step.key}
              className={`flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-300 ${
                stepStatus === 'active' ? 'bg-accent-500/10 border border-accent-500/20' :
                stepStatus === 'error' ? 'bg-red-500/10 border border-red-500/20' :
                stepStatus === 'done' ? 'bg-dark-700' :
                'opacity-40'
              }`}
            >
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${
                stepStatus === 'done' ? 'bg-accent-500/15 text-accent-400' :
                stepStatus === 'active' ? 'bg-accent-500/15 text-accent-400' :
                stepStatus === 'error' ? 'bg-red-500/15 text-red-400' :
                'bg-dark-500 text-theme-faint'
              }`}>
                {stepStatus === 'done' ? <CheckCircle size={14} /> :
                 stepStatus === 'active' ? <RefreshCw size={14} className="animate-spin" /> :
                 stepStatus === 'error' ? <XCircle size={14} /> :
                 <Icon size={14} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${
                  stepStatus === 'done' ? 'text-accent-400' :
                  stepStatus === 'active' ? 'text-accent-300' :
                  stepStatus === 'error' ? 'text-red-400' :
                  'text-theme-faint'
                }`}>{step.label}</p>
                {(stepStatus === 'active' || stepStatus === 'error') && (
                  <p className={`text-xs mt-0.5 ${stepStatus === 'error' ? 'text-red-400' : 'text-accent-500/70'}`}>
                    {stepStatus === 'error' ? status.message : status.message || step.desc}
                  </p>
                )}
              </div>
              {stepStatus === 'done' && <span className="text-[10px] text-accent-500 font-medium">Done</span>}
            </div>
          );
        })}
      </div>
      {isError && (
        <div className="mt-3 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <p className="text-sm text-red-400 font-medium">Sync failed</p>
          <p className="text-xs text-red-400/70 mt-1">{status.error || status.message}</p>
        </div>
      )}
    </div>
  );
}

export default function ImportPage() {
  const [mode, setMode] = useState<Mode>('upload');
  const [selected, setSelected] = useState<Source | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<ImportLog[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Filter sources by enabled integrations
  const enabledIntegrations: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_integrations') || '[]'); } catch { return []; }
  })();
  const sources = allSources.filter(s => enabledIntegrations.includes(s.integration));
  const showHpSync = enabledIntegrations.includes('healthplix');
  const showOgSync = enabledIntegrations.includes('oneglance');

  const [syncSource, setSyncSource] = useState<SyncSource>(showHpSync ? 'healthplix' : 'oneglance');
  const [syncDates, setSyncDates] = useState(getDefaultDates);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<any>(null);
  const [hasHpCreds, setHasHpCreds] = useState<boolean | null>(null);
  const [hasOgCreds, setHasOgCreds] = useState<boolean | null>(null);
  const [ogReportType, setOgReportType] = useState<'sales' | 'purchase' | 'both'>('both');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasCredentials = syncSource === 'healthplix' ? hasHpCreds : hasOgCreds;

  const loadHistory = useCallback(() => {
    api.get('/import/history').then(res => setHistory(res.data));
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    if (showHpSync) {
      api.get('/sync/credentials/healthplix').then(res => setHasHpCreds(res.data.hasPassword && !!res.data.username)).catch(() => setHasHpCreds(false));
    }
    if (showOgSync) {
      api.get('/sync/credentials/oneglance').then(res => setHasOgCreds(res.data.hasPassword && !!res.data.username)).catch(() => setHasOgCreds(false));
    }
  }, []);

  const handleUpload = async () => {
    if (!file || !selected) return;
    const source = sources.find(s => s.key === selected)!;
    setUploading(true); setError(''); setResult(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await api.post(source.endpoint, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(res.data); loadHistory();
    } catch (err: any) { setError(err.response?.data?.error || 'Upload failed'); }
    finally { setUploading(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this import and all its data?')) return;
    try {
      await api.delete(`/import/${id}`);
      loadHistory();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete import');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) setFile(f);
  };

  const reset = () => {
    setSelected(null); setFile(null); setResult(null); setError(''); setSyncStatus(null); setSyncing(false);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startSync = async () => {
    setSyncing(true); setError(''); setSyncStatus({ step: 'starting', message: 'Starting sync...', pct: 0 });
    const isOg = syncSource === 'oneglance';
    const endpoint = isOg ? '/sync/oneglance' : '/sync/healthplix';
    const statusEndpoint = isOg ? '/sync/oneglance/status' : '/sync/healthplix/status';
    try {
      await api.post(endpoint, { fromDate: syncDates.from, toDate: syncDates.to, ...(isOg && { reportType: ogReportType }) });
      pollRef.current = setInterval(async () => {
        try {
          const res = await api.get(statusEndpoint);
          setSyncStatus(res.data);
          if (res.data.status === 'complete') {
            clearInterval(pollRef.current!); pollRef.current = null;
            setTimeout(() => { setSyncing(false); setResult(res.data.result); loadHistory(); }, 1500);
          } else if (res.data.status === 'error') {
            clearInterval(pollRef.current!); pollRef.current = null;
            setSyncing(false); setError(res.data.error || 'Sync failed');
          }
        } catch {}
      }, 1000);
    } catch (err: any) { setSyncing(false); setError(err.response?.data?.error || 'Failed to start sync'); }
  };

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-bold text-theme-heading mb-1">Import Data</h1>
      <p className="text-theme-faint text-sm mb-6">Upload Excel reports{(showHpSync || showOgSync) ? ' or sync directly from your integrations' : ''}</p>

      {/* Mode Toggle */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => { setMode('upload'); reset(); }}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
            mode === 'upload'
              ? 'bg-accent-500 text-white shadow-glow'
              : 'bg-dark-700 text-theme-muted border border-dark-400/50 hover:border-dark-300'
          }`}
        >
          <Upload size={16} /> Upload File
        </button>
        {(showHpSync || showOgSync) && (
          <button
            onClick={() => { setMode('sync'); reset(); }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
              mode === 'sync'
                ? 'bg-accent-500 text-white shadow-glow'
                : 'bg-dark-700 text-theme-muted border border-dark-400/50 hover:border-dark-300'
            }`}
          >
            <Cloud size={16} /> Auto Sync
          </button>
        )}
      </div>

      {/* UPLOAD MODE */}
      {mode === 'upload' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {sources.map(s => (
              <button
                key={s.key}
                onClick={() => { setSelected(s.key); setFile(null); setResult(null); setError(''); }}
                className={`card-hover text-left transition-all ${
                  selected === s.key ? 'ring-2 ring-accent-500 border-accent-500/50' : ''
                }`}
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${
                  selected === s.key ? 'bg-accent-500/15' : 'bg-dark-500'
                }`}>
                  <s.icon size={20} className={selected === s.key ? 'text-accent-400' : 'text-theme-faint'} />
                </div>
                <h3 className="font-semibold text-theme-heading mt-1">{s.label}</h3>
                <p className="text-sm text-theme-faint mt-1">{s.desc}</p>
              </button>
            ))}
          </div>

          {selected && !result && (
            <div className="card mb-8">
              <h3 className="font-semibold text-theme-heading mb-4">
                Upload {sources.find(s => s.key === selected)?.label} Report
              </h3>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-2xl p-8 text-center transition-all ${
                  dragOver ? 'border-accent-400 bg-accent-500/5' : 'border-dark-400'
                }`}
              >
                <div className="w-14 h-14 rounded-2xl bg-dark-600 flex items-center justify-center mx-auto mb-4">
                  <Upload size={24} className="text-theme-faint" />
                </div>
                <p className="text-theme-secondary mb-2">Drag & drop your Excel file here, or</p>
                <label className="btn-primary cursor-pointer inline-block">
                  Browse Files
                  <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
                </label>
                {file && (
                  <p className="mt-3 text-sm text-accent-400 font-medium">{file.name}</p>
                )}
              </div>
              {error && (
                <div className="mt-4 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl flex items-center gap-2 text-sm">
                  <AlertCircle size={16} /> {error}
                </div>
              )}
              <div className="flex gap-3 mt-4">
                <button onClick={handleUpload} disabled={!file || uploading} className="btn-primary">
                  {uploading ? 'Importing...' : 'Import Data'}
                </button>
                <button onClick={reset} className="btn-secondary">Cancel</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* SYNC MODE */}
      {mode === 'sync' && !result && (
        <div className="card mb-8">
          {(showHpSync && showOgSync) && (
            <div className="flex gap-3 mb-5">
              <button
                onClick={() => { setSyncSource('healthplix'); setSyncStatus(null); setError(''); }}
                disabled={syncing}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all flex-1 ${
                  syncSource === 'healthplix'
                    ? 'bg-accent-500/10 border-2 border-accent-500/50 text-accent-400'
                    : 'bg-dark-600 border border-dark-400/50 text-theme-muted hover:border-dark-300'
                }`}
              >
                <Stethoscope size={18} /> Healthplix
                <span className="text-xs text-theme-faint ml-auto">Clinic</span>
              </button>
              <button
                onClick={() => { setSyncSource('oneglance'); setSyncStatus(null); setError(''); }}
                disabled={syncing}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all flex-1 ${
                  syncSource === 'oneglance'
                    ? 'bg-purple-500/10 border-2 border-purple-500/50 text-purple-400'
                    : 'bg-dark-600 border border-dark-400/50 text-theme-muted hover:border-dark-300'
                }`}
              >
                <Pill size={18} /> Oneglance
                <span className="text-xs text-theme-faint ml-auto">Pharmacy</span>
              </button>
            </div>
          )}

          <div className="flex items-center gap-3 mb-4">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              syncSource === 'healthplix' ? 'bg-accent-500/10' : 'bg-purple-500/10'
            }`}>
              {syncSource === 'healthplix'
                ? <Stethoscope size={20} className="text-accent-400" />
                : <Pill size={20} className="text-purple-400" />
              }
            </div>
            <div>
              <h3 className="font-semibold text-theme-heading">
                Sync from {syncSource === 'healthplix' ? 'Healthplix' : 'Oneglance'}
              </h3>
              <p className="text-sm text-theme-faint">
                {syncSource === 'healthplix'
                  ? 'Auto-fetch clinic billing report via browser automation'
                  : 'Auto-fetch pharmacy sales/purchase reports via browser automation'
                }
              </p>
            </div>
          </div>

          {hasCredentials === false && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 mb-4 flex items-center gap-3">
              <SettingsIcon size={18} className="text-amber-400 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm text-amber-300 font-medium">
                  {syncSource === 'healthplix' ? 'Healthplix' : 'Oneglance'} credentials not configured
                </p>
                <p className="text-xs text-amber-400/60 mt-0.5">Set up your login details in Settings first</p>
              </div>
              <Link to="/settings" className="text-sm text-accent-400 hover:text-accent-300 font-medium whitespace-nowrap">
                Go to Settings
              </Link>
            </div>
          )}

          {hasCredentials && (
            <>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-theme-muted mb-1.5">
                    <Calendar size={14} className="inline mr-1" /> From Date
                  </label>
                  <input type="date" value={syncDates.from} onChange={e => setSyncDates(d => ({ ...d, from: e.target.value }))} className="input w-full" disabled={syncing} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-theme-muted mb-1.5">
                    <Calendar size={14} className="inline mr-1" /> To Date
                  </label>
                  <input type="date" value={syncDates.to} onChange={e => setSyncDates(d => ({ ...d, to: e.target.value }))} className="input w-full" disabled={syncing} />
                </div>
              </div>

              <div className="flex gap-2 mb-4">
                {[
                  { label: 'Last Month', fn: () => { const d = getDefaultDates(); setSyncDates({ from: d.from, to: d.to }); }},
                  { label: 'This Month', fn: () => { const now = new Date(); const first = new Date(now.getFullYear(), now.getMonth(), 1); setSyncDates({ from: fmtDate(first), to: fmtDate(now) }); }},
                  { label: 'Last 3 Months', fn: () => { const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth() - 3, 1); setSyncDates({ from: fmtDate(start), to: fmtDate(now) }); }},
                ].map(p => (
                  <button key={p.label} onClick={p.fn} disabled={syncing}
                    className="text-xs px-3 py-1.5 rounded-full bg-dark-600 text-theme-muted hover:bg-dark-500 hover:text-theme-secondary transition-all border border-dark-400/50"
                  >{p.label}</button>
                ))}
              </div>

              {syncSource === 'oneglance' && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-theme-muted mb-2">Report Type</label>
                  <div className="flex gap-2">
                    {([
                      { key: 'both' as const, label: 'Sales & Purchase' },
                      { key: 'sales' as const, label: 'Sales Only' },
                      { key: 'purchase' as const, label: 'Purchase Only' },
                    ]).map(rt => (
                      <button key={rt.key} onClick={() => setOgReportType(rt.key)} disabled={syncing}
                        className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${
                          ogReportType === rt.key
                            ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
                            : 'bg-dark-600 text-theme-muted border border-dark-400/50 hover:border-dark-300'
                        }`}
                      >{rt.label}</button>
                    ))}
                  </div>
                </div>
              )}

              {(syncing || syncStatus?.step === 'error') && syncStatus && (
                <SyncStepTracker status={syncStatus} steps={syncSource === 'healthplix' ? HP_SYNC_STEPS : OG_SYNC_STEPS} />
              )}

              {error && !syncing && !syncStatus?.step && (
                <div className="mt-2 mb-4 bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl flex items-center gap-2 text-sm">
                  <AlertCircle size={16} /> {error}
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={startSync} disabled={syncing || !syncDates.from || !syncDates.to} className="btn-primary flex items-center gap-2">
                  {syncing ? <><RefreshCw size={16} className="animate-spin" /> Syncing...</> : <><Cloud size={16} /> Sync Now</>}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="card mb-8 border-accent-500/30 bg-accent-500/5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-accent-500/15 flex items-center justify-center">
              <CheckCircle size={20} className="text-accent-400" />
            </div>
            <h3 className="font-semibold text-accent-300">
              {mode === 'sync' ? 'Sync Successful' : 'Import Successful'}
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="bg-dark-600 rounded-xl p-3">
              <p className="text-xs text-theme-faint mb-1">Rows Imported</p>
              <p className="text-lg font-bold text-theme-heading">{result.totalRows?.toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-dark-600 rounded-xl p-3">
              <p className="text-xs text-theme-faint mb-1">Date Range</p>
              <p className="text-lg font-bold text-theme-heading">
                {result.dateRange ? `${result.dateRange.start} to ${result.dateRange.end}` : 'N/A'}
              </p>
            </div>
            <div className="bg-dark-600 rounded-xl p-3">
              <p className="text-xs text-theme-faint mb-1">Warnings</p>
              <p className="text-lg font-bold text-theme-heading">{result.warnings?.length || 0}</p>
            </div>
          </div>
          <button onClick={reset} className="btn-primary mt-4">
            {mode === 'sync' ? 'Sync Another Period' : 'Import Another'}
          </button>
        </div>
      )}

      {/* Import History */}
      <div className="card">
        <h3 className="font-semibold text-theme-heading mb-4">Import History</h3>
        {history.length === 0 ? (
          <p className="text-theme-faint text-center py-8">No imports yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-400/50">
                  <th className="text-left py-3 px-3 text-theme-faint font-medium text-xs uppercase tracking-wider">Source</th>
                  <th className="text-left py-3 px-3 text-theme-faint font-medium text-xs uppercase tracking-wider">File</th>
                  <th className="text-right py-3 px-3 text-theme-faint font-medium text-xs uppercase tracking-wider">Rows</th>
                  <th className="text-left py-3 px-3 text-theme-faint font-medium text-xs uppercase tracking-wider">Date Range</th>
                  <th className="text-left py-3 px-3 text-theme-faint font-medium text-xs uppercase tracking-wider">Imported At</th>
                  <th className="text-right py-3 px-3 text-theme-faint font-medium text-xs uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map(log => (
                  <tr key={log.id} className="border-b border-dark-400/30 hover:bg-dark-600/50 transition-colors">
                    <td className="py-3 px-3">
                      <span className={`badge text-[10px] ${
                        log.source === 'HEALTHPLIX_SYNC' ? 'badge-info' :
                        log.source.includes('ONEGLANCE') ? 'badge-warning' :
                        'badge-success'
                      }`}>
                        {log.source === 'HEALTHPLIX_SYNC' ? 'HP Sync' :
                         log.source === 'ONEGLANCE_SALES_SYNC' ? 'OG Sales' :
                         log.source === 'ONEGLANCE_PURCHASE_SYNC' ? 'OG Purchase' :
                         log.source}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-theme-secondary">{log.filename}</td>
                    <td className="py-3 px-3 text-right text-theme-secondary">{log.rows_imported.toLocaleString('en-IN')}</td>
                    <td className="py-3 px-3 text-theme-faint">
                      {log.date_range_start && log.date_range_end ? `${log.date_range_start} to ${log.date_range_end}` : '-'}
                    </td>
                    <td className="py-3 px-3 text-theme-faint">{new Date(log.created_at).toLocaleString('en-IN')}</td>
                    <td className="py-3 px-3 text-right">
                      <button onClick={() => handleDelete(log.id)} className="text-red-400/60 hover:text-red-400 transition-colors">
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
