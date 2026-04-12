import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api/client';
import { Stethoscope, Pill, ShoppingCart, Upload, CheckCircle, AlertCircle, Trash2,
         RefreshCw, Cloud, Settings as SettingsIcon, Calendar,
         LogIn, Building2, FileSearch, CalendarRange, Download, Database, Check, XCircle,
         Phone, KeyRound, Briefcase, Package, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { Link } from 'react-router-dom';

type Source = 'healthplix' | 'oneglance-sales' | 'oneglance-purchase' | 'oneglance-stock' | 'turia';
type Mode = 'upload' | 'sync';
type SyncSource = 'healthplix' | 'oneglance' | 'turia';

interface ImportLog {
  id: number;
  source: string;
  filename: string;
  rows_imported: number;
  date_range_start: string;
  date_range_end: string;
  status: string;
  created_at: string;
  file_path?: string;
}

const allSources: { key: Source; label: string; desc: string; icon: any; endpoint: string; integration: string }[] = [
  { key: 'healthplix', label: 'Healthplix', desc: 'Clinic billing report', icon: Stethoscope, endpoint: '/import/healthplix', integration: 'healthplix' },
  { key: 'oneglance-sales', label: 'Oneglance Sales', desc: 'Pharmacy sales report', icon: Pill, endpoint: '/import/oneglance-sales', integration: 'oneglance' },
  { key: 'oneglance-purchase', label: 'Oneglance Purchase', desc: 'Pharmacy purchase report', icon: ShoppingCart, endpoint: '/import/oneglance-purchase', integration: 'oneglance' },
  { key: 'oneglance-stock', label: 'Oneglance Stock', desc: 'Pharmacy stock snapshot', icon: Package, endpoint: '/import/oneglance-stock', integration: 'oneglance' },
  { key: 'turia', label: 'Turia Invoices', desc: 'Consultancy invoice data', icon: Briefcase, endpoint: '/import/turia', integration: 'turia' },
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
  { key: 'stock',    label: 'Stock report',         desc: 'Downloading stock CSV',            icon: Package },
  { key: 'parsing',  label: 'Parsing data',         desc: 'Reading rows from CSV',            icon: FileSearch },
  { key: 'saving',   label: 'Saving to database',   desc: 'Importing records',                icon: Database },
  { key: 'complete', label: 'Complete',              desc: 'Sync finished successfully',       icon: Check },
];

const TURIA_SYNC_STEPS = [
  { key: 'login',       label: 'Opening login',       desc: 'Navigating to Turia login',       icon: LogIn },
  { key: 'waiting_otp', label: 'Waiting for OTP',     desc: 'Enter OTP sent to your phone',    icon: KeyRound },
  { key: 'navigate',    label: 'Opening invoices',    desc: 'Navigating to invoice list',      icon: FileSearch },
  { key: 'download',    label: 'Downloading data',    desc: 'Exporting invoice data',          icon: Download },
  { key: 'parsing',     label: 'Parsing data',        desc: 'Reading invoice rows',            icon: FileSearch },
  { key: 'saving',      label: 'Saving to database',  desc: 'Importing invoices',              icon: Database },
  { key: 'complete',    label: 'Complete',             desc: 'Sync finished successfully',      icon: Check },
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

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
  const showTuriaSync = enabledIntegrations.includes('turia');

  const [syncSource, setSyncSource] = useState<SyncSource>(showHpSync ? 'healthplix' : showOgSync ? 'oneglance' : 'turia');
  const [syncDates, setSyncDates] = useState(getDefaultDates);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<any>(null);
  const [hasHpCreds, setHasHpCreds] = useState<boolean | null>(null);
  const [hasOgCreds, setHasOgCreds] = useState<boolean | null>(null);
  const [hasTuriaCreds, setHasTuriaCreds] = useState<boolean | null>(null);
  const [ogReportType, setOgReportType] = useState<'sales' | 'purchase' | 'stock' | 'both' | 'all'>('both');
  const [turiaOtp, setTuriaOtp] = useState('');
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [turiaFY, setTuriaFY] = useState('2025-26');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasCredentials = syncSource === 'healthplix' ? hasHpCreds : syncSource === 'oneglance' ? hasOgCreds : hasTuriaCreds;

  // Sync Tracker state
  const [trackerMonth, setTrackerMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [trackerData, setTrackerData] = useState<any>(null);

  useEffect(() => {
    api.get('/import/sync-tracker', { params: { month: trackerMonth } })
      .then(r => setTrackerData(r.data))
      .catch(() => setTrackerData(null));
  }, [trackerMonth]);

  const navigateMonth = (dir: -1 | 1) => {
    const [y, m] = trackerMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setTrackerMonth(d.toISOString().slice(0, 7));
  };

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
    if (showTuriaSync) {
      api.get('/sync/credentials/turia').then(res => {
        setHasTuriaCreds(res.data.hasCredentials);
        if (res.data.financialYear) setTuriaFY(res.data.financialYear);
      }).catch(() => setHasTuriaCreds(false));
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
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls') || f.name.endsWith('.csv'))) setFile(f);
  };

  const reset = () => {
    setSelected(null); setFile(null); setResult(null); setError(''); setSyncStatus(null); setSyncing(false);
    setTuriaOtp(''); setOtpSubmitting(false);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startSync = async () => {
    setSyncing(true); setError(''); setSyncStatus({ step: 'starting', message: 'Starting sync...', pct: 0 });
    setTuriaOtp('');
    const isTuria = syncSource === 'turia';
    const isOg = syncSource === 'oneglance';
    const endpoint = isTuria ? '/sync/turia' : isOg ? '/sync/oneglance' : '/sync/healthplix';
    const statusEndpoint = isTuria ? '/sync/turia/status' : isOg ? '/sync/oneglance/status' : '/sync/healthplix/status';
    try {
      await api.post(endpoint, isTuria
        ? { financialYear: turiaFY }
        : { fromDate: syncDates.from, toDate: syncDates.to, ...(isOg && { reportType: ogReportType }) }
      );
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

  const submitOtp = async () => {
    if (!turiaOtp || turiaOtp.length < 4) return;
    setOtpSubmitting(true);
    try {
      await api.post('/sync/turia/otp', { otp: turiaOtp });
      setTuriaOtp('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to submit OTP');
    } finally {
      setOtpSubmitting(false);
    }
  };

  useEffect(() => { return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, []);

  return (
    <div className="animate-fade-in">
      <h1 className="text-xl font-bold text-theme-heading mb-0.5">Import Data</h1>
      <p className="text-theme-faint text-xs mb-4">Upload Excel reports{(showHpSync || showOgSync || showTuriaSync) ? ' or sync from integrations' : ''}</p>

      {/* Mode Toggle */}
      <div className="flex gap-2 mb-4">
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
        {(showHpSync || showOgSync || showTuriaSync) && (
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
          <div className="flex flex-wrap gap-2 mb-4">
            {sources.map(s => (
              <button
                key={s.key}
                onClick={() => { setSelected(s.key); setFile(null); setResult(null); setError(''); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all ${
                  selected === s.key
                    ? 'bg-accent-500/15 ring-1 ring-accent-500 text-accent-400 font-medium'
                    : 'bg-dark-600 text-theme-muted hover:bg-dark-500 border border-dark-400/40'
                }`}
              >
                <s.icon size={15} className={selected === s.key ? 'text-accent-400' : 'text-theme-faint'} />
                {s.label}
                <span className="text-[10px] text-theme-faint hidden sm:inline">· {s.desc}</span>
              </button>
            ))}
          </div>

          {selected && !result && (
            <div className="card mb-5">
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`border border-dashed rounded-xl p-5 text-center transition-all ${
                  dragOver ? 'border-accent-400 bg-accent-500/5' : 'border-dark-400'
                }`}
              >
                <Upload size={20} className="text-theme-faint mx-auto mb-2" />
                <p className="text-theme-secondary text-sm mb-2">
                  Drop your <span className="font-medium text-theme-heading">{sources.find(s => s.key === selected)?.label}</span> file here, or{' '}
                  <label className="text-accent-400 cursor-pointer hover:underline font-medium">
                    browse
                    <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
                  </label>
                </p>
                {file && (
                  <div className="flex items-center justify-center gap-2 mt-2 text-sm text-accent-400 font-medium">
                    <CheckCircle size={14} /> {file.name}
                  </div>
                )}
              </div>
              {error && (
                <div className="mt-3 bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg flex items-center gap-2 text-sm">
                  <AlertCircle size={14} /> {error}
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <button onClick={handleUpload} disabled={!file || uploading} className="btn-primary text-sm py-2">
                  {uploading ? 'Importing...' : 'Import'}
                </button>
                <button onClick={reset} className="btn-secondary text-sm py-2">Cancel</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* SYNC MODE */}
      {mode === 'sync' && !result && (
        <div className="card !p-4 mb-4">
          {/* Source tabs */}
          {([showHpSync, showOgSync, showTuriaSync].filter(Boolean).length > 1) && (
            <div className="flex gap-2 mb-3">
              {showHpSync && (
                <button
                  onClick={() => { setSyncSource('healthplix'); setSyncStatus(null); setError(''); }}
                  disabled={syncing}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    syncSource === 'healthplix'
                      ? 'bg-accent-500/10 ring-1 ring-accent-500/50 text-accent-400'
                      : 'bg-dark-600 border border-dark-400/40 text-theme-muted hover:border-dark-300'
                  }`}
                >
                  <Stethoscope size={14} /> Healthplix
                  <span className="text-[10px] text-theme-faint">· Clinic</span>
                </button>
              )}
              {showOgSync && (
                <button
                  onClick={() => { setSyncSource('oneglance'); setSyncStatus(null); setError(''); }}
                  disabled={syncing}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    syncSource === 'oneglance'
                      ? 'bg-purple-500/10 ring-1 ring-purple-500/50 text-purple-400'
                      : 'bg-dark-600 border border-dark-400/40 text-theme-muted hover:border-dark-300'
                  }`}
                >
                  <Pill size={14} /> Oneglance
                  <span className="text-[10px] text-theme-faint">· Pharmacy</span>
                </button>
              )}
              {showTuriaSync && (
                <button
                  onClick={() => { setSyncSource('turia'); setSyncStatus(null); setError(''); }}
                  disabled={syncing}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    syncSource === 'turia'
                      ? 'bg-blue-500/10 ring-1 ring-blue-500/50 text-blue-400'
                      : 'bg-dark-600 border border-dark-400/40 text-theme-muted hover:border-dark-300'
                  }`}
                >
                  <Briefcase size={14} /> Turia
                  <span className="text-[10px] text-theme-faint">· Consultancy</span>
                </button>
              )}
            </div>
          )}

          {hasCredentials === false && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3 flex items-center gap-2 text-sm">
              <SettingsIcon size={14} className="text-amber-400 flex-shrink-0" />
              <span className="text-amber-300 text-xs flex-1">
                {syncSource === 'healthplix' ? 'Healthplix' : syncSource === 'turia' ? 'Turia' : 'Oneglance'} credentials not set
              </span>
              <Link to="/settings" className="text-xs text-accent-400 hover:text-accent-300 font-medium">Settings</Link>
            </div>
          )}

          {hasCredentials && (
            <>
              {syncSource === 'turia' ? (
                <div className="mb-3">
                  <label className="block text-xs font-medium text-theme-muted mb-1">Financial Year</label>
                  <select value={turiaFY} onChange={e => setTuriaFY(e.target.value)} className="input w-48 text-sm" disabled={syncing}>
                    <option value="2023-24">2023-24</option>
                    <option value="2024-25">2024-25</option>
                    <option value="2025-26">2025-26</option>
                    <option value="2026-27">2026-27</option>
                  </select>
                </div>
              ) : (
                <div className="flex items-end gap-3 mb-3 flex-wrap">
                  <div>
                    <label className="block text-xs font-medium text-theme-muted mb-1">From</label>
                    <input type="date" value={syncDates.from} onChange={e => setSyncDates(d => ({ ...d, from: e.target.value }))} className="input text-sm" disabled={syncing} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-theme-muted mb-1">To</label>
                    <input type="date" value={syncDates.to} onChange={e => setSyncDates(d => ({ ...d, to: e.target.value }))} className="input text-sm" disabled={syncing} />
                  </div>
                  <div className="flex gap-1.5">
                    {[
                      { label: 'Last Month', fn: () => { const d = getDefaultDates(); setSyncDates({ from: d.from, to: d.to }); }},
                      { label: 'This Month', fn: () => { const now = new Date(); const first = new Date(now.getFullYear(), now.getMonth(), 1); setSyncDates({ from: fmtDate(first), to: fmtDate(now) }); }},
                      { label: '3 Months', fn: () => { const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth() - 3, 1); setSyncDates({ from: fmtDate(start), to: fmtDate(now) }); }},
                    ].map(p => (
                      <button key={p.label} onClick={p.fn} disabled={syncing}
                        className="text-[10px] px-2 py-1 rounded bg-dark-600 text-theme-muted hover:bg-dark-500 transition-all border border-dark-400/40"
                      >{p.label}</button>
                    ))}
                  </div>
                </div>
              )}

              {syncSource === 'oneglance' && (
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-xs text-theme-muted">Report:</span>
                  {([
                    { key: 'both' as const, label: 'Sales+Purchase' },
                    { key: 'sales' as const, label: 'Sales' },
                    { key: 'purchase' as const, label: 'Purchase' },
                    { key: 'stock' as const, label: 'Stock' },
                    { key: 'all' as const, label: 'All' },
                  ]).map(rt => (
                    <button key={rt.key} onClick={() => setOgReportType(rt.key)} disabled={syncing}
                      className={`px-2 py-1 rounded text-[11px] font-medium transition-all ${
                        ogReportType === rt.key
                          ? 'bg-purple-500/15 text-purple-400 ring-1 ring-purple-500/30'
                          : 'bg-dark-600 text-theme-muted border border-dark-400/40 hover:border-dark-300'
                      }`}
                    >{rt.label}</button>
                  ))}
                </div>
              )}

              {(syncing || syncStatus?.step === 'error') && syncStatus && (
                <SyncStepTracker
                  status={syncStatus}
                  steps={syncSource === 'healthplix' ? HP_SYNC_STEPS : syncSource === 'turia' ? TURIA_SYNC_STEPS :
                    OG_SYNC_STEPS.filter(s => {
                      if (ogReportType === 'all') return true;
                      if (ogReportType === 'both') return s.key !== 'stock';
                      if (ogReportType === 'stock') return s.key !== 'sales' && s.key !== 'purchase';
                      if (ogReportType === 'sales') return s.key !== 'purchase' && s.key !== 'stock';
                      if (ogReportType === 'purchase') return s.key !== 'sales' && s.key !== 'stock';
                      return true;
                    })
                  }
                />
              )}

              {syncSource === 'turia' && syncing && syncStatus?.status === 'waiting_otp' && (
                <div className="mb-3 bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <KeyRound size={14} className="text-blue-400" />
                    <p className="text-xs font-medium text-blue-300">Enter OTP sent to your phone</p>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={turiaOtp}
                      onChange={e => setTuriaOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="OTP"
                      className="input flex-1 text-sm"
                      maxLength={6}
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') submitOtp(); }}
                    />
                    <button onClick={submitOtp} disabled={otpSubmitting || turiaOtp.length < 4} className="btn-primary text-sm py-1.5 flex items-center gap-1.5">
                      {otpSubmitting ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
                      Verify
                    </button>
                  </div>
                </div>
              )}

              {error && !syncing && !syncStatus?.step && (
                <div className="mb-3 bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-lg flex items-center gap-2 text-xs">
                  <AlertCircle size={14} /> {error}
                </div>
              )}

              <button
                onClick={startSync}
                disabled={syncing || (syncSource !== 'turia' && (!syncDates.from || !syncDates.to))}
                className="btn-primary text-sm py-2 flex items-center gap-2"
              >
                {syncing ? <><RefreshCw size={14} className="animate-spin" /> Syncing...</> : <><Cloud size={14} /> Sync Now</>}
              </button>
            </>
          )}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="card mb-5 border-accent-500/30 bg-accent-500/5">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle size={18} className="text-accent-400" />
            <h3 className="font-semibold text-accent-300 text-sm">
              {mode === 'sync' ? 'Sync Successful' : 'Import Successful'}
            </h3>
          </div>
          <div className="flex gap-4 text-sm mb-3">
            <div><span className="text-theme-faint">Rows:</span> <span className="font-bold text-theme-heading">{result.totalRows?.toLocaleString('en-IN')}</span></div>
            <div><span className="text-theme-faint">Range:</span> <span className="font-bold text-theme-heading">{result.dateRange ? `${result.dateRange.start} → ${result.dateRange.end}` : 'N/A'}</span></div>
            {(result.warnings?.length > 0) && <div><span className="text-theme-faint">Warnings:</span> <span className="font-bold text-yellow-400">{result.warnings.length}</span></div>}
          </div>
          <button onClick={reset} className="btn-primary text-sm py-2">
            {mode === 'sync' ? 'Sync Another' : 'Import Another'}
          </button>
        </div>
      )}

      {/* Sync Tracker */}
      {trackerData && (() => {
        const [yr, mo] = trackerMonth.split('-').map(Number);
        const daysInMonth = new Date(yr, mo, 0).getDate();
        const firstDow = new Date(yr, mo - 1, 1).getDay();
        const startOffset = firstDow === 0 ? 6 : firstDow - 1; // Mon-start
        const monthLabel = new Date(yr, mo - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
        const cells: (null | { day: number; date: string; dow: number; clinic: any; sales: any; purchase: any })[] = [];
        for (let i = 0; i < startOffset; i++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${trackerMonth}-${String(d).padStart(2, '0')}`;
          const dd = trackerData.days[dateStr] || { dow: new Date(yr, mo - 1, d).getDay(), clinic: { has: false }, sales: { has: false }, purchase: { has: false } };
          cells.push({ day: d, date: dateStr, ...dd });
        }
        const s = trackerData.summary;

        return (
          <div className="card !p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <CalendarDays size={15} className="text-accent-400" />
                <h3 className="font-semibold text-theme-heading text-sm">Sync Tracker</h3>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => navigateMonth(-1)} className="p-1 rounded hover:bg-dark-600 text-theme-faint hover:text-theme-heading transition-colors"><ChevronLeft size={16} /></button>
                <span className="text-xs font-medium text-theme-heading w-28 text-center">{monthLabel}</span>
                <button onClick={() => navigateMonth(1)} className="p-1 rounded hover:bg-dark-600 text-theme-faint hover:text-theme-heading transition-colors"><ChevronRight size={16} /></button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4">
              {/* Calendar Grid */}
              <div>
                <div className="grid grid-cols-7 gap-[3px]">
                  {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
                    <div key={d} className="text-[10px] font-medium text-theme-faint text-center py-1">{d}</div>
                  ))}
                  {cells.map((cell, i) =>
                    cell === null ? <div key={`e-${i}`} className="h-10" /> : (() => {
                      const isFuture = cell.date > trackerData.today;
                      const isSunday = cell.dow === 0;
                      const isToday = cell.date === trackerData.today;
                      const clinicGap = !cell.clinic?.has && !isSunday && !isFuture && showHpSync;
                      const salesGap = !cell.sales?.has && !isFuture && showOgSync;
                      const purchaseGap = !cell.purchase?.has && !isFuture && showOgSync;
                      const hasGap = clinicGap || salesGap || purchaseGap;
                      return (
                        <div
                          key={cell.date}
                          className={`h-10 rounded-md flex flex-col items-center justify-center transition-all ${
                            isFuture ? 'bg-dark-800/40 opacity-30' :
                            isToday ? 'ring-1 ring-accent-500 bg-accent-500/5' :
                            hasGap ? 'bg-red-500/5 border border-red-500/15' :
                            'bg-dark-700'
                          } ${isSunday && !isFuture ? 'opacity-60' : ''}`}
                          title={isFuture ? '' : `${cell.date}\nClinic: ${cell.clinic?.rows || 0} rows\nSales: ${cell.sales?.rows || 0} rows\nPurchase: ${cell.purchase?.rows || 0} rows`}
                        >
                          <span className={`text-[11px] leading-none ${isToday ? 'font-bold text-accent-400' : 'text-theme-secondary'}`}>{cell.day}</span>
                          {!isFuture && (
                            <div className="flex gap-[3px] mt-1">
                              {showHpSync && (
                                <div className={`w-[5px] h-[5px] rounded-full ${cell.clinic?.has ? 'bg-accent-500' : isSunday ? 'bg-dark-500' : 'bg-dark-500 ring-1 ring-red-500/40'}`} />
                              )}
                              {showOgSync && (
                                <>
                                  <div className={`w-[5px] h-[5px] rounded-full ${cell.sales?.has ? 'bg-purple-500' : 'bg-dark-500 ring-1 ring-red-500/40'}`} />
                                  <div className={`w-[5px] h-[5px] rounded-full ${cell.purchase?.has ? 'bg-amber-500' : 'bg-dark-500 ring-1 ring-red-500/40'}`} />
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()
                  )}
                </div>
                {/* Legend */}
                <div className="flex gap-4 mt-2.5 text-[10px] text-theme-faint">
                  {showHpSync && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-accent-500" /> Clinic</span>}
                  {showOgSync && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500" /> Pharma Sales</span>}
                  {showOgSync && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Pharma Purchase</span>}
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-dark-500 ring-1 ring-red-500/40" /> Missing</span>
                </div>
              </div>

              {/* Summary Cards */}
              <div className="space-y-2">
                {showHpSync && (
                  <div className="bg-dark-700 rounded-lg p-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <Stethoscope size={12} className="text-accent-400" />
                        <span className="text-[11px] font-medium text-theme-heading">Clinic</span>
                      </div>
                      <span className="text-[10px] text-theme-faint">{relativeTime(s.clinic.lastSync)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-dark-800 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full transition-all ${s.clinic.pct >= 95 ? 'bg-accent-500' : s.clinic.pct >= 70 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.min(s.clinic.pct, 100)}%` }} />
                      </div>
                      <span className={`text-[11px] font-bold ${s.clinic.pct >= 95 ? 'text-accent-400' : s.clinic.pct >= 70 ? 'text-amber-400' : 'text-red-400'}`}>{s.clinic.covered}/{s.clinic.expected}</span>
                    </div>
                    {trackerData.gaps.clinic.length > 0 && (
                      <p className="text-[9px] text-red-400/70 mt-1 truncate">Missing: {trackerData.gaps.clinic.map((g: string) => g.slice(8)).join(', ')}</p>
                    )}
                  </div>
                )}

                {showOgSync && (
                  <div className="bg-dark-700 rounded-lg p-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <Pill size={12} className="text-purple-400" />
                        <span className="text-[11px] font-medium text-theme-heading">Pharma Sales</span>
                      </div>
                      <span className="text-[10px] text-theme-faint">{relativeTime(s.sales.lastSync)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-dark-800 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full transition-all ${s.sales.pct >= 95 ? 'bg-purple-500' : s.sales.pct >= 70 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.min(s.sales.pct, 100)}%` }} />
                      </div>
                      <span className={`text-[11px] font-bold ${s.sales.pct >= 95 ? 'text-purple-400' : s.sales.pct >= 70 ? 'text-amber-400' : 'text-red-400'}`}>{s.sales.covered}/{s.sales.expected}</span>
                    </div>
                    {trackerData.gaps.sales.length > 0 && (
                      <p className="text-[9px] text-red-400/70 mt-1 truncate">Missing: {trackerData.gaps.sales.map((g: string) => g.slice(8)).join(', ')}</p>
                    )}
                  </div>
                )}

                {showOgSync && (
                  <div className="bg-dark-700 rounded-lg p-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <ShoppingCart size={12} className="text-amber-400" />
                        <span className="text-[11px] font-medium text-theme-heading">Pharma Purchase</span>
                      </div>
                      <span className="text-[10px] text-theme-faint">{relativeTime(s.purchase.lastSync)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-dark-800 rounded-full h-1.5">
                        <div className={`h-1.5 rounded-full transition-all ${s.purchase.pct >= 95 ? 'bg-amber-500' : s.purchase.pct >= 70 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.min(s.purchase.pct, 100)}%` }} />
                      </div>
                      <span className={`text-[11px] font-bold ${s.purchase.pct >= 95 ? 'text-amber-400' : s.purchase.pct >= 70 ? 'text-amber-400' : 'text-red-400'}`}>{s.purchase.covered}/{s.purchase.expected}</span>
                    </div>
                    {trackerData.gaps.purchase.length > 0 && (
                      <p className="text-[9px] text-red-400/70 mt-1 truncate">Missing: {trackerData.gaps.purchase.map((g: string) => g.slice(8)).join(', ')}</p>
                    )}
                  </div>
                )}

                {showOgSync && s.stock && (
                  <div className="bg-dark-700 rounded-lg p-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Package size={12} className="text-purple-300" />
                        <span className="text-[11px] font-medium text-theme-heading">Stock Snapshot</span>
                      </div>
                      <span className="text-[10px] text-theme-faint">{relativeTime(s.stock.lastSync)}</span>
                    </div>
                    <p className="text-[10px] text-theme-secondary mt-1">Latest: <span className="font-medium text-theme-heading">{s.stock.latestSnapshot || 'None'}</span></p>
                  </div>
                )}

                {showTuriaSync && s.turia && (
                  <div className="bg-dark-700 rounded-lg p-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Briefcase size={12} className="text-blue-400" />
                        <span className="text-[11px] font-medium text-theme-heading">Turia</span>
                      </div>
                      <span className="text-[10px] text-theme-faint">{relativeTime(s.turia.lastSync)}</span>
                    </div>
                    <p className="text-[10px] text-theme-secondary mt-1">Invoices synced periodically</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Import History */}
      <div className="card !p-4">
        <h3 className="font-semibold text-theme-heading text-sm mb-3">Import History</h3>
        {history.length === 0 ? (
          <p className="text-theme-faint text-center py-4 text-sm">No imports yet</p>
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-dark-400/50">
                  <th className="text-left py-2 px-2 text-theme-faint font-medium uppercase tracking-wider">Source</th>
                  <th className="text-left py-2 px-2 text-theme-faint font-medium uppercase tracking-wider">File</th>
                  <th className="text-right py-2 px-2 text-theme-faint font-medium uppercase tracking-wider">Rows</th>
                  <th className="text-left py-2 px-2 text-theme-faint font-medium uppercase tracking-wider">Range</th>
                  <th className="text-left py-2 px-2 text-theme-faint font-medium uppercase tracking-wider">When</th>
                  <th className="py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {history.map(log => (
                  <tr key={log.id} className="border-b border-dark-400/20 hover:bg-dark-600/50 transition-colors">
                    <td className="py-1.5 px-2">
                      <span className={`badge text-[10px] ${
                        log.source === 'HEALTHPLIX_SYNC' ? 'badge-info' :
                        log.source.includes('ONEGLANCE') ? 'badge-warning' :
                        log.source.includes('TURIA') ? 'badge-info' :
                        'badge-success'
                      }`}>
                        {log.source === 'HEALTHPLIX_SYNC' ? 'HP Sync' :
                         log.source === 'ONEGLANCE_SALES_SYNC' ? 'OG Sales' :
                         log.source === 'ONEGLANCE_PURCHASE_SYNC' ? 'OG Purchase' :
                         log.source === 'ONEGLANCE_STOCK_SYNC' ? 'OG Stock' :
                         log.source === 'TURIA_SYNC' ? 'Turia Sync' :
                         log.source === 'TURIA' ? 'Turia Upload' :
                         log.source}
                      </span>
                    </td>
                    <td className="py-1.5 px-2 text-theme-secondary truncate max-w-[180px]">{log.filename}</td>
                    <td className="py-1.5 px-2 text-right text-theme-secondary font-medium">{log.rows_imported.toLocaleString('en-IN')}</td>
                    <td className="py-1.5 px-2 text-theme-faint">
                      {log.date_range_start && log.date_range_end ? `${log.date_range_start} → ${log.date_range_end}` : '-'}
                    </td>
                    <td className="py-1.5 px-2 text-theme-faint">{new Date(log.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="py-1.5 px-2 text-right flex items-center justify-end gap-1.5">
                      {log.file_path && (
                        <button
                          onClick={() => {
                            const baseUrl = api.defaults.baseURL || '';
                            const token = localStorage.getItem('token');
                            const url = `${baseUrl}/import/download/${log.id}`;
                            const a = document.createElement('a');
                            // Use fetch to download with auth header
                            fetch(url, { headers: { Authorization: `Bearer ${token}` } })
                              .then(r => {
                                if (!r.ok) throw new Error('Download failed');
                                return r.blob();
                              })
                              .then(blob => {
                                const blobUrl = URL.createObjectURL(blob);
                                a.href = blobUrl;
                                a.download = log.filename || `import-${log.id}`;
                                a.click();
                                URL.revokeObjectURL(blobUrl);
                              })
                              .catch(() => alert('File not available for download'));
                          }}
                          className="text-accent-400/40 hover:text-accent-400 transition-colors"
                          title="Download file"
                        >
                          <Download size={13} />
                        </button>
                      )}
                      <button onClick={() => handleDelete(log.id)} className="text-red-400/40 hover:text-red-400 transition-colors">
                        <Trash2 size={13} />
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
