import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api/client';
import { Stethoscope, Pill, ShoppingCart, Upload, CheckCircle, AlertCircle, Trash2,
         RefreshCw, Cloud, Settings as SettingsIcon, Calendar,
         LogIn, Building2, FileSearch, CalendarRange, Download, Database, Check, XCircle,
         Phone, KeyRound, Briefcase, Package, ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { Link } from 'react-router-dom';
import { downloadXlsx, CLINIC_EXPORT_COLUMNS, PHARMA_SALES_EXPORT_COLUMNS, PHARMA_PURCHASE_EXPORT_COLUMNS, STOCK_COLUMNS } from '../utils/xlsxExport';

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

function SyncStepTracker({ status, steps }: { status: { step: string; message: string; pct: number; error?: string; lastStep?: string }; steps: typeof HP_SYNC_STEPS }) {
  const isError = status.step === 'error';
  // Use the tracked last successful step instead of guessing from error message
  const errorStep = isError ? (status.lastStep || 'login') : status.step;
  const displayStep = isError ? errorStep : status.step;

  return (
    <div
      className="mb-5 rounded-2xl p-5"
      style={{ background: 'var(--mt-bg-muted)', border: '1px solid var(--mt-border)' }}
    >
      <div className="flex items-center justify-between mb-4">
        <h4 className="mt-heading text-sm">Sync Progress</h4>
        <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>
          {isError ? 'Failed' : status.step === 'complete' ? 'Done' : `${status.pct || 0}%`}
        </span>
      </div>
      <div
        className="w-full rounded-full h-1.5 mb-5"
        style={{ background: 'var(--mt-bg-app)' }}
      >
        <div
          className="h-1.5 rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${isError ? Math.max(status.pct || 5, 5) : status.pct || 0}%`,
            background: isError ? 'var(--mt-danger-text)' : 'var(--mt-accent)',
          }}
        />
      </div>
      <div className="space-y-1">
        {steps.map((step) => {
          const stepStatus = getStepStatus(step.key, displayStep, isError, steps);
          const Icon = step.icon;
          const rowStyle: React.CSSProperties =
            stepStatus === 'active' ? { background: 'var(--mt-accent-soft)', border: '1px solid var(--mt-accent-border)' } :
            stepStatus === 'error' ? { background: 'var(--mt-danger-soft)', border: '1px solid var(--mt-danger-border)' } :
            stepStatus === 'done' ? { background: 'var(--mt-bg-raised)' } : {};
          const iconStyle: React.CSSProperties =
            stepStatus === 'done' || stepStatus === 'active' ? { background: 'var(--mt-accent-soft)', color: 'var(--mt-accent-text)' } :
            stepStatus === 'error' ? { background: 'var(--mt-danger-soft)', color: 'var(--mt-danger-text)' } :
            { background: 'var(--mt-bg-muted)', color: 'var(--mt-text-faint)' };
          const labelColor =
            stepStatus === 'done' || stepStatus === 'active' ? 'var(--mt-accent-text)' :
            stepStatus === 'error' ? 'var(--mt-danger-text)' : 'var(--mt-text-faint)';
          return (
            <div
              key={step.key}
              className="flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-300"
              style={{ ...rowStyle, opacity: stepStatus === 'pending' ? 0.4 : 1 }}
            >
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all"
                style={iconStyle}
              >
                {stepStatus === 'done' ? <CheckCircle size={14} /> :
                 stepStatus === 'active' ? <RefreshCw size={14} className="animate-spin" /> :
                 stepStatus === 'error' ? <XCircle size={14} /> :
                 <Icon size={14} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" style={{ color: labelColor }}>{step.label}</p>
                {(stepStatus === 'active' || stepStatus === 'error') && (
                  <p
                    className="text-xs mt-0.5"
                    style={{ color: stepStatus === 'error' ? 'var(--mt-danger-text)' : 'var(--mt-accent-text)' }}
                  >
                    {stepStatus === 'error' ? status.message : status.message || step.desc}
                  </p>
                )}
              </div>
              {stepStatus === 'done' && (
                <span className="text-[10px] font-medium" style={{ color: 'var(--mt-accent)' }}>Done</span>
              )}
            </div>
          );
        })}
      </div>
      {isError && (
        <div
          className="mt-3 rounded-xl px-4 py-3"
          style={{ background: 'var(--mt-danger-soft)', border: '1px solid var(--mt-danger-border)' }}
        >
          <p className="text-sm font-medium" style={{ color: 'var(--mt-danger-text)' }}>Sync failed</p>
          <p className="text-xs mt-1" style={{ color: 'var(--mt-danger-text)', opacity: 0.7 }}>{status.error || status.message}</p>
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
          setSyncStatus((prev: any) => {
            const d = res.data;
            // Preserve the last successful step so error UI keeps completed checkpoints
            if (d.step === 'error' || d.status === 'error') {
              return { ...d, lastStep: prev?.step && prev.step !== 'error' ? prev.step : prev?.lastStep };
            }
            return d;
          });
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

  const modeBtnStyle = (active: boolean): React.CSSProperties => active
    ? {
        background: 'linear-gradient(135deg, var(--mt-accent), var(--mt-accent-strong))',
        color: '#fff',
        boxShadow: '0 10px 24px -8px rgba(16,185,129,0.45)',
        border: '1px solid var(--mt-accent-border)',
      }
    : {
        background: 'var(--mt-bg-raised)',
        color: 'var(--mt-text-muted)',
        border: '1px solid var(--mt-border)',
      };

  return (
    <div className="animate-fade-in">
      <h1 className="mt-heading text-xl mb-0.5">Import Data</h1>
      <p className="text-xs mb-4" style={{ color: 'var(--mt-text-faint)' }}>Upload Excel reports{(showHpSync || showOgSync || showTuriaSync) ? ' or sync from integrations' : ''}</p>

      {/* Mode Toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => { setMode('upload'); reset(); }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
          style={modeBtnStyle(mode === 'upload')}
        >
          <Upload size={16} /> Upload File
        </button>
        {(showHpSync || showOgSync || showTuriaSync) && (
          <button
            onClick={() => { setMode('sync'); reset(); }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
            style={modeBtnStyle(mode === 'sync')}
          >
            <Cloud size={16} /> Auto Sync
          </button>
        )}
      </div>

      {/* UPLOAD MODE */}
      {mode === 'upload' && (
        <>
          <div className="flex flex-wrap gap-2 mb-4">
            {sources.map(s => {
              const active = selected === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => { setSelected(s.key); setFile(null); setResult(null); setError(''); }}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all"
                  style={{
                    background: active ? 'var(--mt-accent-soft)' : 'var(--mt-bg-raised)',
                    color: active ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)',
                    border: `1px solid ${active ? 'var(--mt-accent-border)' : 'var(--mt-border)'}`,
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  <s.icon size={15} style={{ color: active ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)' }} />
                  {s.label}
                  <span className="text-[10px] hidden sm:inline" style={{ color: 'var(--mt-text-faint)' }}>· {s.desc}</span>
                </button>
              );
            })}
          </div>

          {selected && !result && (
            <div className="mt-card p-5 mb-5">
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className="border border-dashed rounded-xl p-5 text-center transition-all"
                style={{
                  borderColor: dragOver ? 'var(--mt-accent)' : 'var(--mt-border)',
                  background: dragOver ? 'var(--mt-accent-soft)' : 'transparent',
                }}
              >
                <Upload size={20} className="mx-auto mb-2" style={{ color: 'var(--mt-text-faint)' }} />
                <p className="text-sm mb-2" style={{ color: 'var(--mt-text-secondary)' }}>
                  Drop your <span className="font-medium" style={{ color: 'var(--mt-text-heading)' }}>{sources.find(s => s.key === selected)?.label}</span> file here, or{' '}
                  <label className="cursor-pointer hover:underline font-medium" style={{ color: 'var(--mt-accent-text)' }}>
                    browse
                    <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
                  </label>
                </p>
                {file && (
                  <div className="flex items-center justify-center gap-2 mt-2 text-sm font-medium" style={{ color: 'var(--mt-accent-text)' }}>
                    <CheckCircle size={14} /> {file.name}
                  </div>
                )}
              </div>
              {error && (
                <div
                  className="mt-3 px-3 py-2 rounded-lg flex items-center gap-2 text-sm"
                  style={{
                    background: 'var(--mt-danger-soft)',
                    border: '1px solid var(--mt-danger-border)',
                    color: 'var(--mt-danger-text)',
                  }}
                >
                  <AlertCircle size={14} /> {error}
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <button onClick={handleUpload} disabled={!file || uploading} className="mt-btn-gradient text-sm">
                  {uploading ? 'Importing...' : 'Import'}
                </button>
                <button onClick={reset} className="mt-btn-ghost text-sm">Cancel</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* SYNC MODE */}
      {mode === 'sync' && !result && (
        <div className="mt-card p-4 mb-4">
          {/* Source tabs */}
          {([showHpSync, showOgSync, showTuriaSync].filter(Boolean).length > 1) && (
            <div className="flex gap-2 mb-3">
              {showHpSync && (() => {
                const active = syncSource === 'healthplix';
                return (
                  <button
                    onClick={() => { setSyncSource('healthplix'); setSyncStatus(null); setError(''); }}
                    disabled={syncing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: active ? 'var(--mt-accent-soft)' : 'var(--mt-bg-raised)',
                      color: active ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)',
                      border: `1px solid ${active ? 'var(--mt-accent-border)' : 'var(--mt-border)'}`,
                    }}
                  >
                    <Stethoscope size={14} /> Healthplix
                    <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>· Clinic</span>
                  </button>
                );
              })()}
              {showOgSync && (() => {
                const active = syncSource === 'oneglance';
                return (
                  <button
                    onClick={() => { setSyncSource('oneglance'); setSyncStatus(null); setError(''); }}
                    disabled={syncing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: active ? 'color-mix(in srgb, #8b5cf6 12%, transparent)' : 'var(--mt-bg-raised)',
                      color: active ? '#a78bfa' : 'var(--mt-text-muted)',
                      border: `1px solid ${active ? 'color-mix(in srgb, #8b5cf6 40%, transparent)' : 'var(--mt-border)'}`,
                    }}
                  >
                    <Pill size={14} /> Oneglance
                    <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>· Pharmacy</span>
                  </button>
                );
              })()}
              {showTuriaSync && (() => {
                const active = syncSource === 'turia';
                return (
                  <button
                    onClick={() => { setSyncSource('turia'); setSyncStatus(null); setError(''); }}
                    disabled={syncing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: active ? 'color-mix(in srgb, #3b82f6 12%, transparent)' : 'var(--mt-bg-raised)',
                      color: active ? '#60a5fa' : 'var(--mt-text-muted)',
                      border: `1px solid ${active ? 'color-mix(in srgb, #3b82f6 40%, transparent)' : 'var(--mt-border)'}`,
                    }}
                  >
                    <Briefcase size={14} /> Turia
                    <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>· Consultancy</span>
                  </button>
                );
              })()}
            </div>
          )}

          {hasCredentials === false && (
            <div
              className="rounded-lg px-3 py-2 mb-3 flex items-center gap-2 text-sm"
              style={{ background: 'var(--mt-warn-soft)', border: '1px solid var(--mt-warn-border)' }}
            >
              <SettingsIcon size={14} className="flex-shrink-0" style={{ color: 'var(--mt-warn-text)' }} />
              <span className="text-xs flex-1" style={{ color: 'var(--mt-warn-text)' }}>
                {syncSource === 'healthplix' ? 'Healthplix' : syncSource === 'turia' ? 'Turia' : 'Oneglance'} credentials not set
              </span>
              <Link to="/settings" className="text-xs font-medium" style={{ color: 'var(--mt-accent-text)' }}>Settings</Link>
            </div>
          )}

          {hasCredentials && (
            <>
              {syncSource === 'turia' ? (
                <div className="mb-3">
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>Financial Year</label>
                  <select value={turiaFY} onChange={e => setTuriaFY(e.target.value)} className="mt-input w-48 text-sm" disabled={syncing}>
                    <option value="2023-24">2023-24</option>
                    <option value="2024-25">2024-25</option>
                    <option value="2025-26">2025-26</option>
                    <option value="2026-27">2026-27</option>
                  </select>
                </div>
              ) : (
                <div className="flex items-end gap-3 mb-3 flex-wrap">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>From</label>
                    <input type="date" value={syncDates.from} onChange={e => setSyncDates(d => ({ ...d, from: e.target.value }))} className="mt-input text-sm" disabled={syncing} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--mt-text-muted)' }}>To</label>
                    <input type="date" value={syncDates.to} onChange={e => setSyncDates(d => ({ ...d, to: e.target.value }))} className="mt-input text-sm" disabled={syncing} />
                  </div>
                  <div className="flex gap-1.5">
                    {[
                      { label: 'Last Month', fn: () => { const d = getDefaultDates(); setSyncDates({ from: d.from, to: d.to }); }},
                      { label: 'This Month', fn: () => { const now = new Date(); const first = new Date(now.getFullYear(), now.getMonth(), 1); setSyncDates({ from: fmtDate(first), to: fmtDate(now) }); }},
                      { label: '3 Months', fn: () => { const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth() - 3, 1); setSyncDates({ from: fmtDate(start), to: fmtDate(now) }); }},
                    ].map(p => (
                      <button key={p.label} onClick={p.fn} disabled={syncing}
                        className="text-[10px] px-2 py-1 rounded transition-all"
                        style={{
                          background: 'var(--mt-bg-raised)',
                          color: 'var(--mt-text-muted)',
                          border: '1px solid var(--mt-border)',
                        }}
                      >{p.label}</button>
                    ))}
                  </div>
                </div>
              )}

              {syncSource === 'oneglance' && (
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-xs" style={{ color: 'var(--mt-text-muted)' }}>Report:</span>
                  {([
                    { key: 'both' as const, label: 'Sales+Purchase' },
                    { key: 'sales' as const, label: 'Sales' },
                    { key: 'purchase' as const, label: 'Purchase' },
                    { key: 'stock' as const, label: 'Stock' },
                    { key: 'all' as const, label: 'All' },
                  ]).map(rt => {
                    const active = ogReportType === rt.key;
                    return (
                      <button key={rt.key} onClick={() => setOgReportType(rt.key)} disabled={syncing}
                        className="px-2 py-1 rounded text-[11px] font-medium transition-all"
                        style={{
                          background: active ? 'color-mix(in srgb, #8b5cf6 14%, transparent)' : 'var(--mt-bg-raised)',
                          color: active ? '#a78bfa' : 'var(--mt-text-muted)',
                          border: `1px solid ${active ? 'color-mix(in srgb, #8b5cf6 30%, transparent)' : 'var(--mt-border)'}`,
                        }}
                      >{rt.label}</button>
                    );
                  })}
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
                <div
                  className="mb-3 rounded-lg p-3"
                  style={{
                    background: 'color-mix(in srgb, #3b82f6 10%, transparent)',
                    border: '1px solid color-mix(in srgb, #3b82f6 25%, transparent)',
                  }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <KeyRound size={14} style={{ color: '#60a5fa' }} />
                    <p className="text-xs font-medium" style={{ color: '#93c5fd' }}>Enter OTP sent to your phone</p>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={turiaOtp}
                      onChange={e => setTuriaOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="OTP"
                      className="mt-input flex-1 text-sm"
                      maxLength={6}
                      autoFocus
                      onKeyDown={e => { if (e.key === 'Enter') submitOtp(); }}
                    />
                    <button onClick={submitOtp} disabled={otpSubmitting || turiaOtp.length < 4} className="mt-btn-gradient text-sm flex items-center gap-1.5">
                      {otpSubmitting ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
                      Verify
                    </button>
                  </div>
                </div>
              )}

              {error && !syncing && !syncStatus?.step && (
                <div
                  className="mb-3 px-3 py-2 rounded-lg flex items-center gap-2 text-xs"
                  style={{
                    background: 'var(--mt-danger-soft)',
                    border: '1px solid var(--mt-danger-border)',
                    color: 'var(--mt-danger-text)',
                  }}
                >
                  <AlertCircle size={14} /> {error}
                </div>
              )}

              <button
                onClick={startSync}
                disabled={syncing || (syncSource !== 'turia' && (!syncDates.from || !syncDates.to))}
                className="mt-btn-gradient text-sm flex items-center gap-2"
              >
                {syncing ? <><RefreshCw size={14} className="animate-spin" /> Syncing...</> : <><Cloud size={14} /> Sync Now</>}
              </button>
            </>
          )}
        </div>
      )}

      {/* Result */}
      {result && (
        <div
          className="rounded-2xl p-5 mb-5"
          style={{
            background: 'color-mix(in srgb, var(--mt-accent-soft) 70%, var(--mt-bg-raised))',
            border: '1px solid var(--mt-accent-border)',
            boxShadow: 'var(--mt-shadow-card)',
          }}
        >
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle size={18} style={{ color: 'var(--mt-accent-text)' }} />
            <h3 className="mt-heading text-sm" style={{ color: 'var(--mt-accent-text)' }}>
              {mode === 'sync' ? 'Sync Successful' : 'Import Successful'}
            </h3>
          </div>
          <div className="flex gap-4 text-sm mb-3">
            <div><span style={{ color: 'var(--mt-text-faint)' }}>Rows:</span> <span className="font-bold" style={{ color: 'var(--mt-text-heading)' }}>{result.totalRows?.toLocaleString('en-IN')}</span></div>
            <div><span style={{ color: 'var(--mt-text-faint)' }}>Range:</span> <span className="font-bold" style={{ color: 'var(--mt-text-heading)' }}>{result.dateRange ? `${result.dateRange.start} → ${result.dateRange.end}` : 'N/A'}</span></div>
            {(result.warnings?.length > 0) && <div><span style={{ color: 'var(--mt-text-faint)' }}>Warnings:</span> <span className="font-bold" style={{ color: 'var(--mt-warn-text)' }}>{result.warnings.length}</span></div>}
          </div>
          <button onClick={reset} className="mt-btn-gradient text-sm">
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
          <div className="mt-card p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <CalendarDays size={15} style={{ color: 'var(--mt-accent-text)' }} />
                <h3 className="mt-heading text-sm">Sync Tracker</h3>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => navigateMonth(-1)}
                  className="p-1 rounded transition-colors"
                  style={{ color: 'var(--mt-text-faint)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--mt-bg-muted)'; e.currentTarget.style.color = 'var(--mt-text-heading)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
                ><ChevronLeft size={16} /></button>
                <span className="text-xs font-medium w-28 text-center" style={{ color: 'var(--mt-text-heading)' }}>{monthLabel}</span>
                <button
                  onClick={() => navigateMonth(1)}
                  className="p-1 rounded transition-colors"
                  style={{ color: 'var(--mt-text-faint)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--mt-bg-muted)'; e.currentTarget.style.color = 'var(--mt-text-heading)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
                ><ChevronRight size={16} /></button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4">
              {/* Calendar Grid */}
              <div>
                <div className="grid grid-cols-7 gap-[3px]">
                  {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
                    <div key={d} className="text-[10px] font-medium text-center py-1" style={{ color: 'var(--mt-text-faint)' }}>{d}</div>
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
                      const cellStyle: React.CSSProperties = isFuture
                        ? { background: 'var(--mt-bg-app)', opacity: 0.3 }
                        : isToday
                          ? { background: 'var(--mt-accent-soft)', boxShadow: 'inset 0 0 0 1px var(--mt-accent)' }
                          : hasGap
                            ? { background: 'var(--mt-danger-soft)', border: '1px solid var(--mt-danger-border)' }
                            : { background: 'var(--mt-bg-raised)' };
                      return (
                        <div
                          key={cell.date}
                          className="h-10 rounded-md flex flex-col items-center justify-center transition-all"
                          style={{ ...cellStyle, opacity: isSunday && !isFuture ? 0.6 : cellStyle.opacity }}
                          title={isFuture ? '' : `${cell.date}\nClinic: ${cell.clinic?.rows || 0} rows\nSales: ${cell.sales?.rows || 0} rows\nPurchase: ${cell.purchase?.rows || 0} rows`}
                        >
                          <span
                            className="text-[11px] leading-none"
                            style={{
                              color: isToday ? 'var(--mt-accent-text)' : 'var(--mt-text-secondary)',
                              fontWeight: isToday ? 700 : 400,
                            }}
                          >{cell.day}</span>
                          {!isFuture && (
                            <div className="flex gap-[3px] mt-1">
                              {showHpSync && (
                                <div
                                  className="w-[5px] h-[5px] rounded-full"
                                  style={{
                                    background: cell.clinic?.has ? '#10b981' : 'var(--mt-bg-muted)',
                                    boxShadow: !cell.clinic?.has && !isSunday ? '0 0 0 1px var(--mt-danger-border)' : 'none',
                                  }}
                                />
                              )}
                              {showOgSync && (
                                <>
                                  <div
                                    className="w-[5px] h-[5px] rounded-full"
                                    style={{
                                      background: cell.sales?.has ? '#8b5cf6' : 'var(--mt-bg-muted)',
                                      boxShadow: !cell.sales?.has ? '0 0 0 1px var(--mt-danger-border)' : 'none',
                                    }}
                                  />
                                  <div
                                    className="w-[5px] h-[5px] rounded-full"
                                    style={{
                                      background: cell.purchase?.has ? '#f59e0b' : 'var(--mt-bg-muted)',
                                      boxShadow: !cell.purchase?.has ? '0 0 0 1px var(--mt-danger-border)' : 'none',
                                    }}
                                  />
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
                <div className="flex gap-4 mt-2.5 text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>
                  {showHpSync && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: '#10b981' }} /> Clinic</span>}
                  {showOgSync && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: '#8b5cf6' }} /> Pharma Sales</span>}
                  {showOgSync && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: '#f59e0b' }} /> Pharma Purchase</span>}
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: 'var(--mt-bg-muted)', boxShadow: '0 0 0 1px var(--mt-danger-border)' }} />
                    Missing
                  </span>
                </div>
              </div>

              {/* Summary Cards */}
              <div className="space-y-2">
                {showHpSync && (
                  <SyncMetricCard
                    label="Clinic"
                    Icon={Stethoscope}
                    iconColor="#10b981"
                    pct={s.clinic.pct}
                    covered={s.clinic.covered}
                    expected={s.clinic.expected}
                    lastSync={s.clinic.lastSync}
                    gaps={trackerData.gaps.clinic}
                  />
                )}
                {showOgSync && (
                  <SyncMetricCard
                    label="Pharma Sales"
                    Icon={Pill}
                    iconColor="#8b5cf6"
                    pct={s.sales.pct}
                    covered={s.sales.covered}
                    expected={s.sales.expected}
                    lastSync={s.sales.lastSync}
                    gaps={trackerData.gaps.sales}
                  />
                )}
                {showOgSync && (
                  <SyncMetricCard
                    label="Pharma Purchase"
                    Icon={ShoppingCart}
                    iconColor="#f59e0b"
                    pct={s.purchase.pct}
                    covered={s.purchase.covered}
                    expected={s.purchase.expected}
                    lastSync={s.purchase.lastSync}
                    gaps={trackerData.gaps.purchase}
                  />
                )}

                {showOgSync && s.stock && (
                  <div
                    className="rounded-lg p-2.5"
                    style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Package size={12} style={{ color: '#c4b5fd' }} />
                        <span className="text-[11px] font-medium" style={{ color: 'var(--mt-text-heading)' }}>Stock Snapshot</span>
                      </div>
                      <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>{relativeTime(s.stock.lastSync)}</span>
                    </div>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--mt-text-secondary)' }}>
                      Latest: <span className="font-medium" style={{ color: 'var(--mt-text-heading)' }}>{s.stock.latestSnapshot || 'None'}</span>
                    </p>
                  </div>
                )}

                {showTuriaSync && s.turia && (
                  <div
                    className="rounded-lg p-2.5"
                    style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Briefcase size={12} style={{ color: '#60a5fa' }} />
                        <span className="text-[11px] font-medium" style={{ color: 'var(--mt-text-heading)' }}>Turia</span>
                      </div>
                      <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>{relativeTime(s.turia.lastSync)}</span>
                    </div>
                    <p className="text-[10px] mt-1" style={{ color: 'var(--mt-text-secondary)' }}>Invoices synced periodically</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Download Report */}
      <DownloadReportSection />

      {/* Import History */}
      <div className="mt-card p-4">
        <h3 className="mt-heading text-sm mb-3">Import History</h3>
        {history.length === 0 ? (
          <p className="text-center py-4 text-sm" style={{ color: 'var(--mt-text-faint)' }}>No imports yet</p>
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--mt-border)' }}>
                  <th className="text-left py-2 px-2 font-medium uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>Source</th>
                  <th className="text-left py-2 px-2 font-medium uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>File</th>
                  <th className="text-right py-2 px-2 font-medium uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>Rows</th>
                  <th className="text-left py-2 px-2 font-medium uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>Range</th>
                  <th className="text-left py-2 px-2 font-medium uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>When</th>
                  <th className="py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {history.map(log => {
                  const pillTone =
                    log.source === 'HEALTHPLIX_SYNC' ? 'mt-pill--info' :
                    log.source.includes('ONEGLANCE') ? 'mt-pill--warn' :
                    log.source.includes('TURIA') ? 'mt-pill--info' :
                    'mt-pill--success';
                  return (
                    <tr
                      key={log.id}
                      className="transition-colors"
                      style={{ borderBottom: '1px solid var(--mt-border)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--mt-bg-muted)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td className="py-1.5 px-2">
                        <span className={`mt-pill ${pillTone} mt-pill-sm`}>
                          {log.source === 'HEALTHPLIX_SYNC' ? 'HP Sync' :
                           log.source === 'ONEGLANCE_SALES_SYNC' ? 'OG Sales' :
                           log.source === 'ONEGLANCE_PURCHASE_SYNC' ? 'OG Purchase' :
                           log.source === 'ONEGLANCE_STOCK_SYNC' ? 'OG Stock' :
                           log.source === 'TURIA_SYNC' ? 'Turia Sync' :
                           log.source === 'TURIA' ? 'Turia Upload' :
                           log.source}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 truncate max-w-[180px]" style={{ color: 'var(--mt-text-secondary)' }}>{log.filename}</td>
                      <td className="py-1.5 px-2 text-right font-medium mt-num" style={{ color: 'var(--mt-text-secondary)' }}>{log.rows_imported.toLocaleString('en-IN')}</td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--mt-text-faint)' }}>
                        {log.date_range_start && log.date_range_end ? `${log.date_range_start} → ${log.date_range_end}` : '-'}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--mt-text-faint)' }}>{new Date(log.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td className="py-1.5 px-2 text-right">
                        <button
                          onClick={() => handleDelete(log.id)}
                          className="transition-colors"
                          style={{ color: 'var(--mt-text-faint)' }}
                          onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-danger-text)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sync Metric Card ────────────────────────────────────────────────────────

function SyncMetricCard({
  label, Icon, iconColor, pct, covered, expected, lastSync, gaps,
}: {
  label: string;
  Icon: any;
  iconColor: string;
  pct: number;
  covered: number;
  expected: number;
  lastSync: string | null;
  gaps: string[];
}) {
  const barColor = pct >= 95 ? iconColor : pct >= 70 ? '#f59e0b' : '#ef4444';
  const numColor = pct >= 95 ? iconColor : pct >= 70 ? 'var(--mt-warn-text)' : 'var(--mt-danger-text)';
  return (
    <div
      className="rounded-lg p-2.5"
      style={{ background: 'var(--mt-bg-raised)', border: '1px solid var(--mt-border)' }}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <Icon size={12} style={{ color: iconColor }} />
          <span className="text-[11px] font-medium" style={{ color: 'var(--mt-text-heading)' }}>{label}</span>
        </div>
        <span className="text-[10px]" style={{ color: 'var(--mt-text-faint)' }}>{relativeTime(lastSync)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div
          className="flex-1 rounded-full h-1.5"
          style={{ background: 'var(--mt-bg-app)' }}
        >
          <div
            className="h-1.5 rounded-full transition-all"
            style={{ width: `${Math.min(pct, 100)}%`, background: barColor }}
          />
        </div>
        <span className="text-[11px] font-bold mt-num" style={{ color: numColor }}>{covered}/{expected}</span>
      </div>
      {gaps.length > 0 && (
        <p className="text-[9px] mt-1 truncate" style={{ color: 'var(--mt-danger-text)', opacity: 0.7 }}>
          Missing: {gaps.map((g: string) => g.slice(8)).join(', ')}
        </p>
      )}
    </div>
  );
}

// ── Download Report Section ─────────────────────────────────────────────────

const EXPORT_SOURCES = [
  { key: 'clinic', label: 'Clinic (Healthplix)', icon: Stethoscope },
  { key: 'pharma-sales', label: 'Pharmacy Sales', icon: Pill },
  { key: 'pharma-purchase', label: 'Pharmacy Purchase', icon: ShoppingCart },
  { key: 'pharma-stock', label: 'Pharmacy Stock', icon: Package },
] as const;

const EXPORT_COLUMNS: Record<string, any> = {
  'clinic': CLINIC_EXPORT_COLUMNS,
  'pharma-sales': PHARMA_SALES_EXPORT_COLUMNS,
  'pharma-purchase': PHARMA_PURCHASE_EXPORT_COLUMNS,
  'pharma-stock': STOCK_COLUMNS,
};

const EXPORT_FILENAMES: Record<string, string> = {
  'clinic': 'Clinic_Report',
  'pharma-sales': 'Pharmacy_Sales_Report',
  'pharma-purchase': 'Pharmacy_Purchase_Report',
  'pharma-stock': 'Pharmacy_Stock_Report',
};

function DownloadReportSection() {
  const [source, setSource] = useState<string>('clinic');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (source !== 'pharma-stock' && (!from || !to)) {
      alert('Please select both From and To dates');
      return;
    }
    setDownloading(true);
    try {
      const params: any = {};
      if (source !== 'pharma-stock') {
        params.from = from;
        params.to = to;
      } else {
        params.from = '2000-01-01';
        params.to = '2099-12-31';
      }
      const res = await api.get(`/import/export/${source}`, { params });
      const { rows, count } = res.data;
      if (!rows || count === 0) {
        alert('No data found for the selected period');
        return;
      }
      const dateSuffix = source === 'pharma-stock' ? 'latest' : `${from}_to_${to}`;
      downloadXlsx(rows, EXPORT_COLUMNS[source], `${EXPORT_FILENAMES[source]}_${dateSuffix}`);
    } catch {
      alert('Failed to download report');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mt-card p-4 mb-4">
      <h3 className="mt-heading text-sm mb-3 flex items-center gap-2">
        <Download size={15} /> Download Report
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider font-medium block mb-1" style={{ color: 'var(--mt-text-faint)' }}>Source</label>
          <div className="flex gap-1">
            {EXPORT_SOURCES.map(s => {
              const Icon = s.icon;
              const active = source === s.key;
              return (
                <button key={s.key} onClick={() => setSource(s.key)}
                  className="px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 transition-colors"
                  style={{
                    background: active ? 'var(--mt-accent-soft)' : 'var(--mt-bg-raised)',
                    color: active ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)',
                    border: `1px solid ${active ? 'var(--mt-accent-border)' : 'var(--mt-border)'}`,
                    fontWeight: active ? 500 : 400,
                  }}
                >
                  <Icon size={13} /> {s.label}
                </button>
              );
            })}
          </div>
        </div>
        {source !== 'pharma-stock' && (
          <>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-medium block mb-1" style={{ color: 'var(--mt-text-faint)' }}>From</label>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                className="mt-input text-sm w-36" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-medium block mb-1" style={{ color: 'var(--mt-text-faint)' }}>To</label>
              <input type="date" value={to} onChange={e => setTo(e.target.value)}
                className="mt-input text-sm w-36" />
            </div>
          </>
        )}
        <button onClick={handleDownload} disabled={downloading}
          className="mt-btn-gradient text-sm flex items-center gap-1.5">
          <Download size={14} />
          {downloading ? 'Downloading...' : 'Download XLSX'}
        </button>
      </div>
    </div>
  );
}
