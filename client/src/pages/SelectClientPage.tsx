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
    <div className="min-h-screen bg-dark-900 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-accent-500/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-accent-500/3 rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-2xl relative z-10 animate-fade-in">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent-500 shadow-glow mb-4">
            <BarChart3 size={24} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-theme-heading">Vision</h1>
          <p className="text-theme-faint mt-1.5 text-sm">Select a client to manage</p>
        </div>

        {loading ? (
          <div className="text-center text-theme-faint">
            <div className="w-6 h-6 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin mx-auto mb-3" />
            Loading clients...
          </div>
        ) : clients.length === 0 ? (
          <div className="card text-center">
            <p className="text-theme-muted mb-4">
              {isOwner ? 'No clients found.' : 'No clients have been assigned to you yet.'}
            </p>
            <p className="text-theme-faint text-sm">
              {isOwner ? '' : 'Contact the platform owner to get client access.'}
            </p>
            {isOwner && (
              <button onClick={() => navigate('/admin')} className="btn-primary mt-3">
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
                className="card-hover cursor-pointer group"
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-xl bg-accent-500/15 flex items-center justify-center group-hover:bg-accent-500/25 transition-colors">
                    <Building2 size={20} className="text-accent-400" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-theme-heading">{client.name}</h3>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="flex items-center gap-1 text-xs text-theme-faint">
                        <Users size={11} />
                        {client.user_count} user{client.user_count !== 1 ? 's' : ''}
                      </span>
                      {client.integrations && (
                        <span className="flex gap-1.5">
                          {client.integrations.split(',').map(i => (
                            <span key={i} className="badge-info text-[10px]">
                              {i}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight size={18} className="text-theme-faint group-hover:text-accent-400 transition-colors" />
                </div>
              </div>
            ))}

            {isOwner && (
              <div className="text-center mt-8">
                <button onClick={() => navigate('/admin')} className="text-sm text-accent-500 hover:text-accent-400 font-medium transition-colors">
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
