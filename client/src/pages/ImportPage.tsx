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

const sources: { key: Source; label: string; desc: string; icon: any; endpoint: string }[] = [
  { key: 'healthplix', label: 'Healthplix', desc: 'Clinic billing report', icon: Stethoscope, endpoint: '/import/healthplix' },
  { key: 'oneglance-sales', label: 'Oneglance Sales', desc: 'Pharmacy sales report', icon: Pill, endpoint: '/import/oneglance-sales' },
  { key: 'oneglance-purchase', label: 'Oneglance Purchase', desc: 'Pharmacy purchase report', icon: ShoppingCart, endpoint: '/import/oneglance-purchase' },
];

/** Format a Date as YYYY-MM-DD in local timezone (not UTC) */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDefaultDates() {
  const now = new Date();
  // Default to first and last of previous month
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: fmtDate(prevMonth), to: fmtDate(lastDay) };
}

// ─── Sync Step Definitions ──────────────────────────────────────────────────

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
  // When error, find the last active step from the message
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
    <div className="mb-5 bg-slate-50 border border-slate-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-semibold text-slate-700">Sync Progress</h4>
        <span className="text-xs text-slate-400">
          {isError ? 'Failed' : status.step === 'complete' ? 'Done' : `${status.pct || 0}%`}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-slate-200 rounded-full h-1.5 mb-5">
        <div
          className={`h-1.5 rounded-full transition-all duration-700 ease-out ${
            isError ? 'bg-red-500' : status.step === 'complete' ? 'bg-emerald-500' : 'bg-primary-500'
          }`}
          style={{ width: `${isError ? Math.max(status.pct || 5, 5) : status.pct || 0}%` }}
        />
      </div>

      {/* Step list */}
      <div className="space-y-1">
        {steps.map((step, idx) => {
          const stepStatus = getStepStatus(step.key, displayStep, isError, steps);
          const Icon = step.icon;

          return (
            <div
              key={step.key}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-300 ${
                stepStatus === 'active' ? 'bg-primary-50 border border-primary-100' :
                stepStatus === 'error' ? 'bg-red-50 border border-red-100' :
                stepStatus === 'done' ? 'bg-white' :
                'opacity-40'
              }`}
            >
              {/* Step indicator */}
              <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                stepStatus === 'done' ? 'bg-emerald-100 text-emerald-600' :
                stepStatus === 'active' ? 'bg-primary-100 text-primary-600' :
                stepStatus === 'error' ? 'bg-red-100 text-red-600' :
                'bg-slate-100 text-slate-400'
              }`}>
                {stepStatus === 'done' ? (
                  <CheckCircle size={14} />
                ) : stepStatus === 'active' ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : stepStatus === 'error' ? (
                  <XCircle size={14} />
                ) : (
                  <Icon size={14} />
                )}
              </div>

              {/* Step text */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${
                  stepStatus === 'done' ? 'text-emerald-700' :
                  stepStatus === 'active' ? 'text-primary-700' :
                  stepStatus === 'error' ? 'text-red-700' :
                  'text-slate-400'
                }`}>
                  {step.label}
                </p>
                {(stepStatus === 'active' || stepStatus === 'error') && (
                  <p className={`text-xs mt-0.5 ${stepStatus === 'error' ? 'text-red-500' : 'text-primary-500'}`}>
                    {stepStatus === 'error' ? status.message : status.message || step.desc}
                  </p>
                )}
              </div>

              {/* Status indicator */}
              {stepStatus === 'done' && (
                <span className="text-xs text-emerald-500 font-medium">Done</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Error details */}
      {isError && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <p className="text-sm text-red-700 font-medium">Sync failed</p>
          <p className="text-xs text-red-500 mt-1">{status.error || status.message}</p>
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

  // Sync state
  const [syncSource, setSyncSource] = useState<SyncSource>('healthplix');
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

  // Check credentials on mount
  useEffect(() => {
    api.get('/sync/credentials/healthplix')
      .then(res => setHasHpCreds(res.data.hasPassword && !!res.data.username))
      .catch(() => setHasHpCreds(false));
    api.get('/sync/credentials/oneglance')
      .then(res => setHasOgCreds(res.data.hasPassword && !!res.data.username))
      .catch(() => setHasOgCreds(false));
  }, []);

  const handleUpload = async () => {
    if (!file || !selected) return;
    const source = sources.find(s => s.key === selected)!;
    setUploading(true);
    setError('');
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await api.post(source.endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(res.data);
      loadHistory();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this import and all its data?')) return;
    await api.delete(`/import/${id}`);
    loadHistory();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) {
      setFile(f);
    }
  };

  const reset = () => {
    setSelected(null);
    setFile(null);
    setResult(null);
    setError('');
    setSyncStatus(null);
    setSyncing(false);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  // ─── Sync Logic ──────────────────────────────────────────────────────────

  const startSync = async () => {
    setSyncing(true);
    setError('');
    setSyncStatus({ step: 'starting', message: 'Starting sync...', pct: 0 });

    const isOg = syncSource === 'oneglance';
    const endpoint = isOg ? '/sync/oneglance' : '/sync/healthplix';
    const statusEndpoint = isOg ? '/sync/oneglance/status' : '/sync/healthplix/status';

    try {
      await api.post(endpoint, {
        fromDate: syncDates.from,
        toDate: syncDates.to,
        ...(isOg && { reportType: ogReportType }),
      });

      // Start polling for status
      pollRef.current = setInterval(async () => {
        try {
          const res = await api.get(statusEndpoint);
          setSyncStatus(res.data);

          if (res.data.status === 'complete') {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setTimeout(() => {
              setSyncing(false);
              setResult(res.data.result);
              loadHistory();
            }, 1500);
          } else if (res.data.status === 'error') {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setSyncing(false);
            setError(res.data.error || 'Sync failed');
          }
        } catch {
          // Ignore poll errors
        }
      }, 1000);
    } catch (err: any) {
      setSyncing(false);
      setError(err.response?.data?.error || 'Failed to start sync');
    }
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-800 mb-2">Import Data</h1>
      <p className="text-slate-500 mb-6">Upload Excel reports or sync directly from Healthplix / Oneglance</p>

      {/* Mode Toggle */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => { setMode('upload'); reset(); }}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            mode === 'upload'
              ? 'bg-primary-600 text-white shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Upload size={16} /> Upload File
        </button>
        <button
          onClick={() => { setMode('sync'); reset(); }}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            mode === 'sync'
              ? 'bg-primary-600 text-white shadow-sm'
              : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <Cloud size={16} /> Auto Sync
        </button>
      </div>

      {/* ═══ UPLOAD MODE ═══ */}
      {mode === 'upload' && (
        <>
          {/* Step 1: Select source */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {sources.map(s => (
              <button
                key={s.key}
                onClick={() => { setSelected(s.key); setFile(null); setResult(null); setError(''); }}
                className={`card text-left transition-all ${
                  selected === s.key
                    ? 'ring-2 ring-primary-500 border-primary-500'
                    : 'hover:border-slate-300'
                }`}
              >
                <s.icon size={24} className={selected === s.key ? 'text-primary-600' : 'text-slate-400'} />
                <h3 className="font-semibold text-slate-800 mt-3">{s.label}</h3>
                <p className="text-sm text-slate-500 mt-1">{s.desc}</p>
              </button>
            ))}
          </div>

          {/* Step 2: Upload */}
          {selected && !result && (
            <div className="card mb-8">
              <h3 className="font-semibold text-slate-800 mb-4">
                Upload {sources.find(s => s.key === selected)?.label} Report
              </h3>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  dragOver ? 'border-primary-400 bg-primary-50' : 'border-slate-300'
                }`}
              >
                <Upload size={40} className="mx-auto text-slate-400 mb-3" />
                <p className="text-slate-600 mb-2">Drag & drop your Excel file here, or</p>
                <label className="btn-primary cursor-pointer inline-block">
                  Browse Files
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    className="hidden"
                    onChange={e => setFile(e.target.files?.[0] || null)}
                  />
                </label>
                {file && (
                  <p className="mt-3 text-sm text-primary-600 font-medium">{file.name}</p>
                )}
              </div>

              {error && (
                <div className="mt-4 bg-red-50 text-red-600 px-4 py-3 rounded-lg flex items-center gap-2">
                  <AlertCircle size={18} /> {error}
                </div>
              )}

              <div className="flex gap-3 mt-4">
                <button
                  onClick={handleUpload}
                  disabled={!file || uploading}
                  className="btn-primary"
                >
                  {uploading ? 'Importing...' : 'Import Data'}
                </button>
                <button onClick={reset} className="btn-secondary">Cancel</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══ SYNC MODE ═══ */}
      {mode === 'sync' && !result && (
        <div className="card mb-8">
          {/* Source selector */}
          <div className="flex gap-3 mb-5">
            <button
              onClick={() => { setSyncSource('healthplix'); setSyncStatus(null); setError(''); }}
              disabled={syncing}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all flex-1 ${
                syncSource === 'healthplix'
                  ? 'bg-primary-50 border-2 border-primary-500 text-primary-700'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Stethoscope size={18} /> Healthplix
              <span className="text-xs text-slate-400 ml-auto">Clinic</span>
            </button>
            <button
              onClick={() => { setSyncSource('oneglance'); setSyncStatus(null); setError(''); }}
              disabled={syncing}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all flex-1 ${
                syncSource === 'oneglance'
                  ? 'bg-orange-50 border-2 border-orange-500 text-orange-700'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Pill size={18} /> Oneglance
              <span className="text-xs text-slate-400 ml-auto">Pharmacy</span>
            </button>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              syncSource === 'healthplix' ? 'bg-primary-50' : 'bg-orange-50'
            }`}>
              {syncSource === 'healthplix'
                ? <Stethoscope size={20} className="text-primary-600" />
                : <Pill size={20} className="text-orange-600" />
              }
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">
                Sync from {syncSource === 'healthplix' ? 'Healthplix' : 'Oneglance'}
              </h3>
              <p className="text-sm text-slate-500">
                {syncSource === 'healthplix'
                  ? 'Auto-fetch clinic billing report via browser automation'
                  : 'Auto-fetch pharmacy sales/purchase reports via browser automation'
                }
              </p>
            </div>
          </div>

          {/* Credentials warning */}
          {hasCredentials === false && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 flex items-center gap-3">
              <SettingsIcon size={18} className="text-amber-600 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm text-amber-800 font-medium">
                  {syncSource === 'healthplix' ? 'Healthplix' : 'Oneglance'} credentials not configured
                </p>
                <p className="text-xs text-amber-600 mt-0.5">Set up your login details in Settings first</p>
              </div>
              <Link to="/settings" className="text-sm text-primary-600 hover:text-primary-800 font-medium whitespace-nowrap">
                Go to Settings
              </Link>
            </div>
          )}

          {/* Date range + options */}
          {hasCredentials && (
            <>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    <Calendar size={14} className="inline mr-1" /> From Date
                  </label>
                  <input
                    type="date"
                    value={syncDates.from}
                    onChange={e => setSyncDates(d => ({ ...d, from: e.target.value }))}
                    className="input w-full"
                    disabled={syncing}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    <Calendar size={14} className="inline mr-1" /> To Date
                  </label>
                  <input
                    type="date"
                    value={syncDates.to}
                    onChange={e => setSyncDates(d => ({ ...d, to: e.target.value }))}
                    className="input w-full"
                    disabled={syncing}
                  />
                </div>
              </div>

              {/* Quick date presets */}
              <div className="flex gap-2 mb-4">
                {[
                  { label: 'Last Month', fn: () => {
                    const d = getDefaultDates();
                    setSyncDates({ from: d.from, to: d.to });
                  }},
                  { label: 'This Month', fn: () => {
                    const now = new Date();
                    const first = new Date(now.getFullYear(), now.getMonth(), 1);
                    setSyncDates({ from: fmtDate(first), to: fmtDate(now) });
                  }},
                  { label: 'Last 3 Months', fn: () => {
                    const now = new Date();
                    const start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
                    setSyncDates({ from: fmtDate(start), to: fmtDate(now) });
                  }},
                ].map(p => (
                  <button
                    key={p.label}
                    onClick={p.fn}
                    disabled={syncing}
                    className="text-xs px-3 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Oneglance report type selector */}
              {syncSource === 'oneglance' && (
                <div className="mb-4">
                  <label className="block text-sm font-medium text-slate-700 mb-2">Report Type</label>
                  <div className="flex gap-2">
                    {([
                      { key: 'both' as const, label: 'Sales & Purchase' },
                      { key: 'sales' as const, label: 'Sales Only' },
                      { key: 'purchase' as const, label: 'Purchase Only' },
                    ]).map(rt => (
                      <button
                        key={rt.key}
                        onClick={() => setOgReportType(rt.key)}
                        disabled={syncing}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                          ogReportType === rt.key
                            ? 'bg-orange-100 text-orange-700 border border-orange-300'
                            : 'bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {rt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Sync Step Tracker */}
              {(syncing || syncStatus?.step === 'error') && syncStatus && (
                <SyncStepTracker
                  status={syncStatus}
                  steps={syncSource === 'healthplix' ? HP_SYNC_STEPS : OG_SYNC_STEPS}
                />
              )}

              {error && !syncing && !syncStatus?.step && (
                <div className="mt-2 mb-4 bg-red-50 text-red-600 px-4 py-3 rounded-lg flex items-center gap-2">
                  <AlertCircle size={18} /> {error}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={startSync}
                  disabled={syncing || !syncDates.from || !syncDates.to}
                  className={`flex items-center gap-2 ${
                    syncSource === 'healthplix' ? 'btn-primary' : 'btn-primary'
                  }`}
                >
                  {syncing ? (
                    <><RefreshCw size={16} className="animate-spin" /> Syncing...</>
                  ) : (
                    <><Cloud size={16} /> Sync Now</>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Step 3: Result (shared between upload and sync) */}
      {result && (
        <div className="card mb-8 border-emerald-200 bg-emerald-50">
          <div className="flex items-center gap-3 mb-3">
            <CheckCircle size={24} className="text-emerald-600" />
            <h3 className="font-semibold text-emerald-800">
              {mode === 'sync' ? 'Sync Successful' : 'Import Successful'}
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-slate-500">Rows Imported</p>
              <p className="text-lg font-bold text-slate-800">{result.totalRows?.toLocaleString('en-IN')}</p>
            </div>
            <div>
              <p className="text-slate-500">Date Range</p>
              <p className="text-lg font-bold text-slate-800">
                {result.dateRange ? `${result.dateRange.start} to ${result.dateRange.end}` : 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Warnings</p>
              <p className="text-lg font-bold text-slate-800">{result.warnings?.length || 0}</p>
            </div>
          </div>
          <button onClick={reset} className="btn-primary mt-4">
            {mode === 'sync' ? 'Sync Another Period' : 'Import Another'}
          </button>
        </div>
      )}

      {/* Import History */}
      <div className="card">
        <h3 className="font-semibold text-slate-800 mb-4">Import History</h3>
        {history.length === 0 ? (
          <p className="text-slate-400 text-center py-8">No imports yet</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-3 px-3">Source</th>
                <th className="text-left py-3 px-3">File</th>
                <th className="text-right py-3 px-3">Rows</th>
                <th className="text-left py-3 px-3">Date Range</th>
                <th className="text-left py-3 px-3">Imported At</th>
                <th className="text-right py-3 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {history.map(log => (
                <tr key={log.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-3 px-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      log.source === 'HEALTHPLIX_SYNC' ? 'bg-blue-50 text-blue-700' :
                      log.source === 'ONEGLANCE_SALES_SYNC' ? 'bg-orange-50 text-orange-700' :
                      log.source === 'ONEGLANCE_PURCHASE_SYNC' ? 'bg-amber-50 text-amber-700' :
                      'bg-primary-50 text-primary-700'
                    }`}>
                      {log.source === 'HEALTHPLIX_SYNC' ? 'HEALTHPLIX (Sync)' :
                       log.source === 'ONEGLANCE_SALES_SYNC' ? 'ONEGLANCE Sales (Sync)' :
                       log.source === 'ONEGLANCE_PURCHASE_SYNC' ? 'ONEGLANCE Purchase (Sync)' :
                       log.source}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-slate-700">{log.filename}</td>
                  <td className="py-3 px-3 text-right">{log.rows_imported.toLocaleString('en-IN')}</td>
                  <td className="py-3 px-3 text-slate-500">
                    {log.date_range_start && log.date_range_end
                      ? `${log.date_range_start} to ${log.date_range_end}` : '-'}
                  </td>
                  <td className="py-3 px-3 text-slate-500">{new Date(log.created_at).toLocaleString('en-IN')}</td>
                  <td className="py-3 px-3 text-right">
                    <button onClick={() => handleDelete(log.id)} className="text-red-500 hover:text-red-700">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
