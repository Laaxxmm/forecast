import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { BarChart3, Building2, ChevronRight, Users } from 'lucide-react';

interface Client {
  id: number;
  slug: string;
  name: string;
  is_active: number;
  user_count: number;
  integrations: string | null;
  created_at: string;
}

export default function SelectClientPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/admin/clients')
      .then(res => setClients(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const selectClient = async (client: Client) => {
    localStorage.setItem('client_slug', client.slug);
    localStorage.setItem('client_name', client.name);
    // Fetch client context: modules, integrations, branches, streams
    try {
      const [modRes, intRes, clientRes, branchRes, streamRes] = await Promise.all([
        api.get(`/admin/clients/${client.slug}/modules`),
        api.get(`/admin/clients/${client.slug}/integrations`),
        api.get(`/admin/clients/${client.slug}`),
        api.get(`/admin/clients/${client.slug}/branches`),
        api.get(`/admin/clients/${client.slug}/streams`),
      ]);
      const enabledMods = modRes.data.filter((m: any) => m.is_enabled).map((m: any) => m.module_key);
      localStorage.setItem('enabled_modules', JSON.stringify(enabledMods));
      const enabledInts = intRes.data.catalog?.filter((i: any) => i.enabled).map((i: any) => i.key) || [];
      localStorage.setItem('enabled_integrations', JSON.stringify(enabledInts));
      // Set multi-branch context
      const clientData = clientRes.data;
      if (clientData.is_multi_branch) {
        localStorage.setItem('is_multi_branch', '1');
        const activeBranches = branchRes.data.filter((b: any) => b.is_active);
        if (activeBranches.length > 0) {
          localStorage.setItem('branch_id', String(activeBranches[0].id));
          localStorage.setItem('branch_name', activeBranches[0].name);
        }
      } else {
        localStorage.removeItem('is_multi_branch');
        localStorage.removeItem('branch_id');
        localStorage.removeItem('branch_name');
      }
      // Set streams and auto-select first stream so forecast doesn't land in consolidated/read-only view
      if (streamRes.data?.length > 0) {
        localStorage.setItem('streams', JSON.stringify(streamRes.data));
        if (!localStorage.getItem('stream_id')) {
          const first = streamRes.data[0];
          localStorage.setItem('stream_id', String(first.id));
          localStorage.setItem('stream_name', first.name);
        }
      }
    } catch {
      localStorage.setItem('enabled_modules', JSON.stringify(['forecast_ops']));
      localStorage.setItem('enabled_integrations', JSON.stringify([]));
    }
    navigate('/modules');
  };

  const userType = localStorage.getItem('user_type');
  const isOwner = localStorage.getItem('is_owner') === '1';

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: 'var(--mt-bg-app)' }}
    >
      {/* Background effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute -top-40 -right-40 w-96 h-96 rounded-full blur-3xl"
          style={{ background: 'color-mix(in srgb, var(--mt-accent) 6%, transparent)' }}
        />
        <div
          className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full blur-3xl"
          style={{ background: 'color-mix(in srgb, #3b82f6 5%, transparent)' }}
        />
      </div>

      <div className="w-full max-w-2xl relative z-10 animate-fade-in">
        <div className="text-center mb-10">
          <div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4"
            style={{
              background: 'linear-gradient(135deg, #10b981, #059669)',
              boxShadow: '0 10px 30px -8px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.18)',
              border: '1px solid rgba(16,185,129,0.35)',
            }}
          >
            <BarChart3 size={24} className="text-white" />
          </div>
          <h1 className="mt-heading text-2xl">Vision</h1>
          <p className="mt-1.5 text-sm" style={{ color: 'var(--mt-text-faint)' }}>Select a client to manage</p>
        </div>

        {loading ? (
          <div className="text-center" style={{ color: 'var(--mt-text-faint)' }}>
            <div
              className="w-6 h-6 border-2 rounded-full animate-spin mx-auto mb-3"
              style={{
                borderColor: 'var(--mt-accent-soft)',
                borderTopColor: 'var(--mt-accent)',
              }}
            />
            Loading clients...
          </div>
        ) : clients.length === 0 ? (
          <div className="mt-card p-8 text-center">
            <p className="mb-4" style={{ color: 'var(--mt-text-muted)' }}>
              {isOwner ? 'No clients found.' : 'No clients have been assigned to you yet.'}
            </p>
            <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>
              {isOwner ? '' : 'Contact the platform owner to get client access.'}
            </p>
            {isOwner && (
              <button onClick={() => navigate('/admin')} className="mt-btn-gradient mt-3">
                Create First Client
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {clients.filter(c => c.is_active).map(client => (
              <div
                key={client.id}
                onClick={() => selectClient(client)}
                className="mt-card p-4 cursor-pointer group transition-all"
                style={{ transition: 'transform .15s ease, border-color .15s ease' }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.borderColor = 'var(--mt-accent-border)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--mt-border)'; }}
              >
                <div className="flex items-center gap-4">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center transition-colors"
                    style={{
                      background: 'var(--mt-accent-soft)',
                      border: '1px solid var(--mt-accent-border)',
                    }}
                  >
                    <Building2 size={20} style={{ color: 'var(--mt-accent-text)' }} />
                  </div>
                  <div className="flex-1">
                    <h3 className="mt-heading text-base">{client.name}</h3>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--mt-text-faint)' }}>
                        <Users size={11} />
                        {client.user_count} user{client.user_count !== 1 ? 's' : ''}
                      </span>
                      {client.integrations && (
                        <span className="flex gap-1.5">
                          {client.integrations.split(',').map(i => (
                            <span key={i} className="mt-pill mt-pill--info mt-pill-sm">
                              {i}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight size={18} style={{ color: 'var(--mt-text-faint)' }} className="transition-colors" />
                </div>
              </div>
            ))}

            {isOwner && (
              <div className="text-center mt-8">
                <button
                  onClick={() => navigate('/admin')}
                  className="text-sm font-medium transition-colors"
                  style={{ color: 'var(--mt-accent-text)' }}
                >
                  Manage Clients
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
