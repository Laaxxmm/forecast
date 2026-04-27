import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import {
  BarChart3,
  Eye,
  EyeOff,
  Mail,
  Lock,
  TrendingUp,
  Calendar,
  CheckSquare,
  Shield,
  ChevronRight,
} from 'lucide-react';

function detectWorkspace(): string {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname;
  if (host === 'localhost' || /^\d/.test(host)) return '';
  const parts = host.split('.');
  if (parts.length >= 3 && parts.slice(-2).join('.') === 'magna.in') return parts[0];
  return '';
}

export default function LoginPage() {
  const detectedWorkspace = detectWorkspace();
  const [workspace, setWorkspace] = useState(detectedWorkspace);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [platformLogo, setPlatformLogo] = useState<string | null>(null);
  const navigate = useNavigate();
  const workspaceLocked = detectedWorkspace !== '';

  useEffect(() => {
    api.get('/logo').then(res => setPlatformLogo(res.data.platformLogo)).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { username, password });
      if (res.data.userType === 'super_admin') {
        if (res.data.isOwner) {
          navigate('/admin');
        } else {
          navigate('/select-client');
        }
      } else {
        navigate('/modules');
      }
    } catch {
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen grid grid-cols-1 md:grid-cols-2"
      style={{ background: 'var(--mt-bg-app)' }}
    >
      {/* ─── Left: Hero panel ─────────────────────────────────────── */}
      <div
        className="relative flex flex-col justify-between p-8 md:p-12 overflow-hidden text-white"
        style={{
          background: 'linear-gradient(135deg, #059669 0%, #10b981 50%, #047857 100%)',
          minHeight: '280px',
        }}
      >
        {/* Subtle grid overlay */}
        <div
          className="absolute inset-0 pointer-events-none opacity-60"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.07) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.07) 1px, transparent 1px)
            `,
            backgroundSize: '40px 40px',
          }}
        />
        {/* Soft white highlight (top-right) */}
        <div
          className="absolute -top-40 -right-40 w-[32rem] h-[32rem] pointer-events-none"
          style={{
            background:
              'radial-gradient(circle, rgba(255,255,255,0.18), transparent 55%)',
          }}
        />

        {/* Logo lock-up */}
        <div className="relative z-10 flex items-center gap-3">
          <div
            className="inline-flex items-center justify-center w-10 h-10 rounded-xl overflow-hidden"
            style={{
              background: 'rgba(255,255,255,0.15)',
              border: '1px solid rgba(255,255,255,0.25)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2)',
            }}
          >
            {platformLogo ? (
              <img
                src={platformLogo}
                alt="Vision"
                className="w-full h-full object-contain p-1"
              />
            ) : (
              <BarChart3 size={20} className="text-white" />
            )}
          </div>
          <div className="leading-tight">
            <div className="text-lg font-bold tracking-tight">Vision</div>
            <div className="text-[10px] font-semibold tracking-[0.18em] text-white/60">
              BY INDEFINE
            </div>
          </div>
        </div>

        {/* Pitch (full version visible from md+; hidden on small screens to keep banner compact) */}
        <div className="relative z-10 hidden md:block">
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70 mb-5">
            The Finance Copilot
          </div>
          <h2 className="text-4xl font-bold leading-tight tracking-tight mb-4 max-w-md">
            Forecast, compliance &amp; close — in one quiet workspace.
          </h2>
          <p className="text-sm text-white/80 max-w-md leading-relaxed">
            Built for Indian SMB finance teams juggling Tally syncs, GSTR filings and month-end
            close across branches.
          </p>

          <div className="mt-8 flex flex-wrap gap-2">
            {[
              { Icon: TrendingUp, label: 'Forecast vs Actuals' },
              { Icon: Calendar, label: 'Compliance calendar' },
              { Icon: CheckSquare, label: 'Close checklist' },
            ].map(({ Icon, label }) => (
              <div
                key={label}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white/95"
                style={{
                  background: 'rgba(255,255,255,0.10)',
                  border: '1px solid rgba(255,255,255,0.18)',
                  backdropFilter: 'blur(8px)',
                }}
              >
                <Icon size={14} />
                {label}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="relative z-10 hidden md:flex items-center gap-3 text-xs text-white/55">
          <span>© 2026 Indefine Systems</span>
          <span className="w-1 h-1 rounded-full bg-white/40" />
          <span>Securely hosted in India</span>
        </div>
      </div>

      {/* ─── Right: Form panel ────────────────────────────────────── */}
      <div className="flex flex-col items-center justify-center px-6 sm:px-12 py-12 md:py-16">
        <div className="w-full max-w-md animate-fade-in">
          {/* Header */}
          <div className="mb-8">
            <div
              className="text-xs font-semibold uppercase tracking-[0.18em] mb-2"
              style={{ color: 'var(--mt-accent-text)' }}
            >
              Welcome back
            </div>
            <h1 className="mt-heading text-2xl mb-2">Sign in to your workspace</h1>
            <p className="text-sm" style={{ color: 'var(--mt-text-muted)' }}>
              {workspaceLocked ? (
                <>
                  Continue as{' '}
                  <span
                    className="font-semibold"
                    style={{ color: 'var(--mt-text-primary)' }}
                  >
                    {detectedWorkspace}
                  </span>
                  .magna.in — or switch tenant below.
                </>
              ) : (
                'Sign in to your workspace below.'
              )}
            </p>
          </div>

          {error && (
            <div
              className="px-4 py-3 rounded-xl mb-5 text-sm flex items-center gap-2 animate-fade-in-soft"
              style={{
                background: 'var(--mt-danger-soft)',
                color: 'var(--mt-danger-text)',
                border: '1px solid var(--mt-danger-border)',
              }}
            >
              <span className="mt-dot mt-dot--danger" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            {/* Workspace */}
            <div className="mb-4">
              <label
                className="block text-xs font-semibold mb-2"
                style={{ color: 'var(--mt-text-muted)' }}
              >
                Workspace
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={workspace}
                  onChange={e => setWorkspace(e.target.value)}
                  className="mt-input pr-20"
                  placeholder="your-workspace"
                  readOnly={workspaceLocked}
                  autoComplete="off"
                />
                <span
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-sm pointer-events-none"
                  style={{ color: 'var(--mt-text-faint)' }}
                >
                  .magna.in
                </span>
              </div>
            </div>

            {/* Email */}
            <div className="mb-4">
              <label
                className="block text-xs font-semibold mb-2"
                style={{ color: 'var(--mt-text-muted)' }}
              >
                Email
              </label>
              <div className="relative">
                <Mail
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: 'var(--mt-text-faint)' }}
                />
                <input
                  type="email"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="mt-input pl-10"
                  placeholder="you@company.com"
                  required
                  autoComplete="email"
                />
              </div>
            </div>

            {/* Password */}
            <div className="mb-6">
              <label
                className="block text-xs font-semibold mb-2"
                style={{ color: 'var(--mt-text-muted)' }}
              >
                Password
              </label>
              <div className="relative">
                <Lock
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: 'var(--mt-text-faint)' }}
                />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="mt-input pl-10 pr-10"
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--mt-text-faint)' }}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-btn-gradient w-full"
              style={{ padding: '11px 14px', fontSize: '14px' }}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Signing in...
                </>
              ) : (
                <>
                  Sign in
                  <ChevronRight size={16} />
                </>
              )}
            </button>
          </form>

          {/* Footer note */}
          <div
            className="mt-6 pt-5 flex items-start gap-2.5 text-xs leading-relaxed"
            style={{
              borderTop: '1px solid var(--mt-border)',
              color: 'var(--mt-text-muted)',
            }}
          >
            <Shield
              size={14}
              className="mt-0.5 flex-shrink-0"
              style={{ color: 'var(--mt-text-faint)' }}
            />
            <div>
              <span
                className="font-semibold"
                style={{ color: 'var(--mt-text-primary)' }}
              >
                Need access? Ask your admin.
              </span>{' '}
              Workspaces are provisioned per client — no self-signup.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
