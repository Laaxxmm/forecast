import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { BarChart3, TrendingUp, ShieldCheck, ClipboardCheck, Scale, ArrowLeft, Lock } from 'lucide-react';
import { getUserRole, isSuperAdmin, type ClientRole } from '../utils/roles';

// ─────────────────────────────────────────────────────────────────────────────
// Role → module allow-list.
//
// Keeps the module picker honest: accountants never see a VCFO card they can't
// open, operational_heads never see a VCFO card they're not authorised for.
// The tenant's `enabledModules` still further narrows this — an accountant in
// a Forecast-only tenant sees exactly one module, same as an OH.
// Anything outside this map (admin, super_admin, or unknown) gets all modules
// and then relies on the tenant's `enabledModules` to filter.
// ─────────────────────────────────────────────────────────────────────────────
const ROLE_MODULE_ALLOW: Partial<Record<ClientRole, string[]>> = {
  operational_head: ['forecast_ops'],
  accountant:       ['forecast_ops', 'vcfo_portal'],
  user:             ['forecast_ops'],
};

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
    name: 'VCFO',
    description: 'Tally-synced financial reports — Trial Balance, P&L, Balance Sheet and Cash Flow — with one-click XLSX/PDF/DOCX export.',
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
  const [loaded, setLoaded] = useState(false);
  const clientName = localStorage.getItem('client_name');

  // Role-scoped allow-list intersected with the tenant's enabled modules.
  // super_admin / admin bypass the role filter entirely. Unknown roles (empty
  // string, legacy values, typos) also bypass — the server is the source of
  // truth and will 403 anything they can't actually reach, so it's better to
  // show them the full catalog than soft-lock them into an empty picker.
  //
  // Memoised so identity is stable across re-renders; otherwise React 18
  // StrictMode can double-fire the auto-skip navigate() below.
  const role = getUserRole() as ClientRole | '';
  const roleAllow = useMemo<string[] | null>(() => {
    if (isSuperAdmin() || role === 'admin') return null;
    if (role in ROLE_MODULE_ALLOW) return ROLE_MODULE_ALLOW[role as ClientRole] ?? null;
    return null; // unknown / missing role → treat as unrestricted
  }, [role]);
  const availableModules = useMemo(
    () => (roleAllow ? enabledModules.filter(k => roleAllow.includes(k)) : enabledModules),
    [roleAllow, enabledModules]
  );

  useEffect(() => {
    // Fetch fresh module/integration data from server
    api.get('/client-modules').then(res => {
      const mods = res.data.enabledModules || [];
      const ints = res.data.enabledIntegrations || [];
      setEnabledModules(mods);
      localStorage.setItem('enabled_modules', JSON.stringify(mods));
      localStorage.setItem('enabled_integrations', JSON.stringify(ints));
      setLoaded(true);
    }).catch(() => {
      // Fallback to localStorage
      const stored = localStorage.getItem('enabled_modules');
      if (stored) {
        try { setEnabledModules(JSON.parse(stored)); } catch { setEnabledModules(['forecast_ops']); }
      } else {
        setEnabledModules(['forecast_ops']);
      }
      setLoaded(true);
    });
  }, []);

  // Auto-skip the picker when there's exactly one module this role can open.
  // Runs only once the module list has hydrated to avoid bouncing off an
  // empty initial state.
  useEffect(() => {
    if (!loaded) return;
    if (availableModules.length !== 1) return;
    const only = availableModules[0];
    const mod = MODULE_CATALOG.find(m => m.key === only);
    if (!mod || !mod.path) return;
    localStorage.setItem('active_module', mod.key);
    navigate(mod.path, { replace: true });
  }, [loaded, availableModules, navigate]);

  const handleSelect = async (mod: ModuleInfo) => {
    if (!enabledModules.includes(mod.key)) return;
    if (roleAllow && !roleAllow.includes(mod.key)) return;
    if (!mod.path) return;
    localStorage.setItem('active_module', mod.key);
    // VCFO is now a first-class React tab under /vcfo/* — same-origin SPA nav,
    // no SSO token mint required. The old TallyVision sub-app has been retired.
    navigate(mod.path);
  };

  const colorMap: Record<string, { fg: string; bg: string; border: string }> = {
    accent: { fg: '#10b981', bg: 'color-mix(in srgb, #10b981 12%, transparent)', border: 'color-mix(in srgb, #10b981 30%, transparent)' },
    blue:   { fg: '#3b82f6', bg: 'color-mix(in srgb, #3b82f6 12%, transparent)', border: 'color-mix(in srgb, #3b82f6 30%, transparent)' },
    purple: { fg: '#8b5cf6', bg: 'color-mix(in srgb, #8b5cf6 12%, transparent)', border: 'color-mix(in srgb, #8b5cf6 30%, transparent)' },
    amber:  { fg: '#f59e0b', bg: 'color-mix(in srgb, #f59e0b 12%, transparent)', border: 'color-mix(in srgb, #f59e0b 30%, transparent)' },
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-8"
      style={{ background: 'var(--mt-bg-app)' }}
    >
      {/* Header */}
      <div className="text-center mb-12">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, #10b981, #059669)',
              boxShadow: '0 10px 30px -8px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.18)',
              border: '1px solid rgba(16,185,129,0.35)',
            }}
          >
            <BarChart3 size={24} className="text-white" />
          </div>
        </div>
        <h1 className="mt-heading text-2xl mb-1">Welcome to Vision</h1>
        {clientName && (
          <p className="text-sm" style={{ color: 'var(--mt-text-muted)' }}>{clientName}</p>
        )}
        <p className="text-xs mt-2" style={{ color: 'var(--mt-text-faint)' }}>Select a module to get started</p>
      </div>

      {/* Module Cards — hide cards outside the role's allow-list so accountants
          don't see Audit/Litigation and OH doesn't see VCFO. Super-admin / admin
          keep the full catalogue so tenant ops can spot disabled modules. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl w-full">
        {MODULE_CATALOG
          .filter(mod => !roleAllow || roleAllow.includes(mod.key))
          .map(mod => {
          const enabled = enabledModules.includes(mod.key);
          const tone = colorMap[mod.color] || colorMap.accent;
          const Icon = mod.icon;
          const comingSoon = !mod.path;
          const interactive = enabled && !comingSoon;

          return (
            <button
              key={mod.key}
              onClick={() => handleSelect(mod)}
              disabled={!enabled || comingSoon}
              className="group relative rounded-2xl p-6 text-left transition-all duration-200"
              style={{
                background: 'var(--mt-bg-raised)',
                border: `1px solid ${interactive ? tone.border : 'var(--mt-border)'}`,
                boxShadow: 'var(--mt-shadow-card)',
                opacity: interactive ? 1 : 0.6,
                cursor: interactive ? 'pointer' : 'not-allowed',
              }}
              onMouseEnter={(e) => {
                if (interactive) {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = `0 12px 24px -8px ${tone.fg}40, var(--mt-shadow-card)`;
                }
              }}
              onMouseLeave={(e) => {
                if (interactive) {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'var(--mt-shadow-card)';
                }
              }}
            >
              {/* Icon */}
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
                style={{
                  background: tone.bg,
                  boxShadow: `inset 0 0 0 1px ${tone.border}`,
                }}
              >
                <Icon size={26} style={{ color: enabled ? tone.fg : 'var(--mt-text-faint)' }} />
              </div>

              {/* Content */}
              <h3
                className="mt-heading text-lg mb-2"
                style={{ color: enabled ? 'var(--mt-text-heading)' : 'var(--mt-text-muted)' }}
              >
                {mod.name}
              </h3>
              <p
                className="text-sm leading-relaxed"
                style={{ color: enabled ? 'var(--mt-text-secondary)' : 'var(--mt-text-faint)' }}
              >
                {mod.description}
              </p>

              {/* Status badge */}
              <div className="mt-4">
                {!enabled ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--mt-text-faint)' }}>
                    <Lock size={11} /> Not enabled
                  </span>
                ) : comingSoon ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--mt-warn-text)' }}>
                    Coming soon
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: tone.fg }}>
                    Open module →
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
          className="mt-8 flex items-center gap-2 text-sm transition-colors"
          style={{ color: 'var(--mt-text-muted)' }}
        >
          <ArrowLeft size={14} /> Back to client list
        </button>
      )}
    </div>
  );
}
