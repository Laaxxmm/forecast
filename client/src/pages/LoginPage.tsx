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
    <div className="min-h-screen bg-dark-900 flex items-center justify-center relative overflow-hidden">
      {/* Ambient background — layered radial glows */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-[28rem] h-[28rem] bg-accent-500/10 rounded-full blur-3xl animate-float" />
        <div className="absolute -bottom-40 -left-40 w-[28rem] h-[28rem] bg-blue-500/8 rounded-full blur-3xl animate-float" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[40rem] h-[40rem] bg-accent-500/[0.03] rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-md relative z-10 animate-fade-in px-4">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent-gradient shadow-glow-lg mb-5 overflow-hidden ring-1 ring-accent-400/30">
            {platformLogo ? (
              <img src={platformLogo} alt="Vision" className="w-full h-full object-contain p-1.5" />
            ) : (
              <BarChart3 size={26} className="text-white" />
            )}
          </div>
          <h1 className="text-3xl font-bold text-theme-heading tracking-tight">Vision</h1>
          <p className="text-theme-faint mt-2 text-sm tracking-wide">by Indefine</p>
        </div>

        {/* Login Card — glass surface */}
        <div className="card-glass">
          <h2 className="text-lg font-semibold text-theme-heading mb-1">Welcome back</h2>
          <p className="text-xs text-theme-faint mb-6">Sign in to continue to your workspace</p>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-500 dark:text-red-400 px-4 py-3 rounded-xl mb-5 text-sm flex items-center gap-2 animate-fade-in-soft">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label className="block text-sm font-medium text-theme-muted mb-2">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="input"
                placeholder="Enter your username"
                required
              />
            </div>
            <div className="mb-6">
              <label className="block text-sm font-medium text-theme-muted mb-2">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="input pr-10"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-faint hover:text-theme-secondary transition-colors"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full flex items-center justify-center gap-2"
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
      </div>
    </div>
  );
}
