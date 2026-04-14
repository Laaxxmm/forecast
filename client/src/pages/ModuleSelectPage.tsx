import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { BarChart3, TrendingUp, ShieldCheck, ClipboardCheck, Scale, ArrowLeft, Lock } from 'lucide-react';

interface ModuleInfo {
  key: string;
  name: string;
  description: string;
  icon: typeof TrendingUp;
  color: string;
  path: string | null;
  external?: boolean;
}

const MODULE_CATALOG: ModuleInfo[] = [
  {
    key: 'forecast_ops',
    name: 'Forecast & Operations',
    description: 'Build financial forecasts, track actuals against budgets, and generate integrated financial reports.',
    icon: TrendingUp,
    color: 'accent',
    path: '/actuals',
  },
  {
    key: 'vcfo_portal',
    name: 'VCFO Portal',
    description: 'Comprehensive Virtual CFO portal with advisory dashboards, KPIs, and strategic insights.',
    icon: ShieldCheck,
    color: 'blue',
    path: '/vcfo',
  },
  {
    key: 'audit_view',
    name: 'Audit View',
    description: 'Audit support tools including compliance tracking, document management, and audit trails.',
    icon: ClipboardCheck,
    color: 'purple',
    path: null,
  },
  {
    key: 'litigation_tool',
    name: 'Litigation Tool',
    description: 'Track all legal notices, manage case timelines, and prepare responses with your team.',
    icon: Scale,
    color: 'amber',
    path: null,
  },
];

export default function ModuleSelectPage() {
  const navigate = useNavigate();
  const [enabledModules, setEnabledModules] = useState<string[]>([]);
  const clientName = localStorage.getItem('client_name');

  useEffect(() => {
    // Fetch fresh module/integration data from server
    api.get('/client-modules').then(res => {
      const mods = res.data.enabledModules || [];
      const ints = res.data.enabledIntegrations || [];
      setEnabledModules(mods);
      localStorage.setItem('enabled_modules', JSON.stringify(mods));
      localStorage.setItem('enabled_integrations', JSON.stringify(ints));
    }).catch(() => {
      // Fallback to localStorage
      const stored = localStorage.getItem('enabled_modules');
      if (stored) {
        try { setEnabledModules(JSON.parse(stored)); } catch { setEnabledModules(['forecast_ops']); }
      } else {
        setEnabledModules(['forecast_ops']);
      }
    });
  }, []);

  const handleSelect = (mod: ModuleInfo) => {
    if (!enabledModules.includes(mod.key)) return;
    if (!mod.path) return;
    localStorage.setItem('active_module', mod.key);
    // VCFO Portal is a separate sub-app (TallyVision) mounted at /vcfo/* — use a hard nav
    // so the browser loads the non-React app instead of the SPA router.
    // Pass the current client's slug so TallyVision isolates data per-client.
    if (mod.key === 'vcfo_portal') {
      const clientSlug = localStorage.getItem('client_slug') || '';
      const url = clientSlug ? `/vcfo/?clientSlug=${encodeURIComponent(clientSlug)}` : '/vcfo/';
      window.location.href = url;
      return;
    }
    navigate(mod.path);
  };

  const colorMap: Record<string, { bg: string; border: string; icon: string; glow: string }> = {
    accent: { bg: 'bg-accent-500/10', border: 'border-accent-500/30', icon: 'text-accent-400', glow: 'shadow-[0_0_30px_rgba(16,185,129,0.1)]' },
    blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', icon: 'text-blue-400', glow: 'shadow-[0_0_30px_rgba(59,130,246,0.1)]' },
    purple: { bg: 'bg-purple-500/10', border: 'border-purple-500/30', icon: 'text-purple-400', glow: 'shadow-[0_0_30px_rgba(168,85,247,0.1)]' },
    amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', icon: 'text-amber-400', glow: 'shadow-[0_0_30px_rgba(245,158,11,0.1)]' },
  };

  return (
    <div className="min-h-screen bg-dark-900 flex flex-col items-center justify-center p-8">
      {/* Header */}
      <div className="text-center mb-12">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-accent-500 flex items-center justify-center">
            <BarChart3 size={24} className="text-white" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-theme-heading mb-1">Welcome to Vision</h1>
        {clientName && (
          <p className="text-theme-muted text-sm">{clientName}</p>
        )}
        <p className="text-theme-faint text-xs mt-2">Select a module to get started</p>
      </div>

      {/* Module Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl w-full">
        {MODULE_CATALOG.map(mod => {
          const enabled = enabledModules.includes(mod.key);
          const colors = colorMap[mod.color] || colorMap.accent;
          const Icon = mod.icon;
          const comingSoon = !mod.path;

          return (
            <button
              key={mod.key}
              onClick={() => handleSelect(mod)}
              disabled={!enabled || comingSoon}
              className={`group relative rounded-2xl p-6 text-left transition-all duration-300 border ${
                enabled && !comingSoon
                  ? `bg-dark-700 ${colors.border} hover:${colors.glow} hover:scale-[1.02] cursor-pointer`
                  : 'bg-dark-700/50 border-dark-400/20 cursor-not-allowed opacity-60'
              }`}
            >
              {/* Icon */}
              <div className={`w-14 h-14 rounded-2xl ${colors.bg} flex items-center justify-center mb-5`}>
                <Icon size={26} className={enabled ? colors.icon : 'text-theme-faint'} />
              </div>

              {/* Content */}
              <h3 className={`text-lg font-semibold mb-2 ${enabled ? 'text-theme-heading' : 'text-theme-muted'}`}>
                {mod.name}
              </h3>
              <p className={`text-sm leading-relaxed ${enabled ? 'text-theme-secondary' : 'text-theme-faint'}`}>
                {mod.description}
              </p>

              {/* Status badge */}
              <div className="mt-4">
                {!enabled ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-theme-faint">
                    <Lock size={11} /> Not enabled
                  </span>
                ) : comingSoon ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                    Coming soon
                  </span>
                ) : (
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${colors.icon}`}>
                    Open module &rarr;
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Back link for super admins */}
      {localStorage.getItem('user_type') === 'super_admin' && (
        <button
          onClick={() => navigate('/select-client')}
          className="mt-8 flex items-center gap-2 text-sm text-theme-muted hover:text-accent-400 transition-colors"
        >
          <ArrowLeft size={14} /> Back to client list
        </button>
      )}
    </div>
  );
}
