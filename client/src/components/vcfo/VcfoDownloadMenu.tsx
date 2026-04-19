import { useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { Download, FileSpreadsheet, FileText, File as FileIcon, Loader2 } from 'lucide-react';

interface Props {
  disabled?: boolean;
  /** Returns the query-string portion (without the leading `?`). */
  buildParams: (format: 'xlsx' | 'pdf' | 'docx') => string | null;
  /** Used to generate a file name when the server doesn't send one. */
  filenameHint?: string;
}

/**
 * Triggers XLSX/PDF/DOCX download via the authenticated axios client. Goes
 * through a blob rather than a plain `<a href>` so the Bearer token and
 * tenant headers attach correctly (a native anchor can't set headers).
 */
export default function VcfoDownloadMenu({ disabled, buildParams, filenameHint }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | 'docx' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const trigger = async (format: 'xlsx' | 'pdf' | 'docx') => {
    const qs = buildParams(format);
    if (!qs) return;
    setBusy(format);
    try {
      const res = await api.get(`/vcfo/download?${qs}`, { responseType: 'blob' });
      const blob = res.data as Blob;

      // Try to respect the filename from Content-Disposition, fall back to hint.
      let filename = `${filenameHint || 'vcfo-report'}.${format}`;
      const cd: string | undefined = res.headers['content-disposition'];
      if (cd) {
        const m = /filename="?([^";]+)"?/i.exec(cd);
        if (m?.[1]) filename = m[1];
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Download failed';
      alert(`Could not download: ${msg}`);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  const isBusy = busy !== null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled || isBusy}
        className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-theme-muted hover:text-accent-400 hover:bg-accent-500/10 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        title="Download report"
      >
        {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        <span className="hidden lg:inline">Download</span>
      </button>
      {open && !disabled && !isBusy && (
        <div className="absolute right-0 mt-1 w-44 bg-dark-800 border border-dark-400/50 rounded-xl shadow-elev-3 overflow-hidden z-20">
          <button
            onClick={() => trigger('xlsx')}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-theme-secondary hover:bg-dark-700 hover:text-accent-400 transition-colors"
          >
            <FileSpreadsheet size={14} className="text-emerald-400" />
            Excel (.xlsx)
          </button>
          <button
            onClick={() => trigger('pdf')}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-theme-secondary hover:bg-dark-700 hover:text-accent-400 transition-colors"
          >
            <FileIcon size={14} className="text-rose-400" />
            PDF (.pdf)
          </button>
          <button
            onClick={() => trigger('docx')}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-theme-secondary hover:bg-dark-700 hover:text-accent-400 transition-colors"
          >
            <FileText size={14} className="text-sky-400" />
            Word (.docx)
          </button>
        </div>
      )}
    </div>
  );
}
