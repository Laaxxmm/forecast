import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { BarChart3, Eye, EyeOff } from 'lucide-react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [platformLogo, setPlatformLogo] = useState<string | null>(null);
  const navigate = useNavigate();

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
      className="min-h-screen flex items-center justify-center relative overflow-hidden"
      style={{ background: 'var(--mt-bg-app)' }}
    >
      {/* Ambient background — layered radial glows */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute -top-40 -right-40 w-[28rem] h-[28rem] rounded-full blur-3xl animate-float"
          style={{ background: 'color-mix(in srgb, var(--mt-accent) 10%, transparent)' }}
        />
        <div
          className="absolute -bottom-40 -left-40 w-[28rem] h-[28rem] rounded-full blur-3xl animate-float"
          style={{ background: 'color-mix(in srgb, #3b82f6 8%, transparent)', animationDelay: '1s' }}
        />
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[40rem] h-[40rem] rounded-full blur-3xl"
          style={{ background: 'color-mix(in srgb, var(--mt-accent) 3%, transparent)' }}
        />
      </div>

      <div className="w-full max-w-md relative z-10 animate-fade-in px-4">
        {/* Logo */}
        <div className="text-center mb-10">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-5 overflow-hidden"
            style={{
              background: 'linear-gradient(135deg, #10b981, #059669)',
              boxShadow: '0 10px 30px -8px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.18)',
              border: '1px solid rgba(16,185,129,0.35)',
            }}
          >
            {platformLogo ? (
              <img src={platformLogo} alt="Vision" className="w-full h-full object-contain p-1.5" />
            ) : (
              <BarChart3 size={26} className="text-white" />
            )}
          </div>
          <h1 className="mt-heading text-3xl">Vision</h1>
          <p
            className="mt-2 text-sm tracking-wide"
            style={{ color: 'var(--mt-text-faint)', fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic' }}
          >
            by Indefine
          </p>
        </div>

        {/* Login Card */}
        <div className="mt-card p-8">
          <h2 className="mt-heading text-lg mb-1">Welcome back</h2>
          <p className="text-xs mb-6" style={{ color: 'var(--mt-text-faint)' }}>
            Sign in to continue to your workspace
          </p>

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
            <div className="mb-4">
              <label
                className="block text-xs font-semibold mb-2 uppercase tracking-wider"
                style={{ color: 'var(--mt-text-muted)' }}
              >
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="mt-input"
                placeholder="Enter your username"
                required
                autoComplete="username"
              />
            </div>
            <div className="mb-6">
              <label
                className="block text-xs font-semibold mb-2 uppercase tracking-wider"
                style={{ color: 'var(--mt-text-muted)' }}
              >
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="mt-input pr-10"
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
              style={{ padding: '10px 14px', fontSize: '14px' }}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Signing in...
                </>
              ) : 'Sign In'}
            </button>
          </form>
        </div>

        {/* Footer note */}
        <p className="text-center text-xs mt-6" style={{ color: 'var(--mt-text-faint)' }}>
          Secure sign-in · End-to-end encrypted session
        </p>
      </div>
    </div>
  );
}
