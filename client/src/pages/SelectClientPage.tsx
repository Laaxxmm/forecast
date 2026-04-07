import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

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

  const selectClient = (client: Client) => {
    localStorage.setItem('client_slug', client.slug);
    localStorage.setItem('client_name', client.name);
    navigate('/actuals');
  };

  const userType = localStorage.getItem('user_type');

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-primary-600">Magna Tracker</h1>
          <p className="text-slate-500 mt-2">Select a client to manage</p>
        </div>

        {loading ? (
          <div className="text-center text-slate-500">Loading clients...</div>
        ) : clients.length === 0 ? (
          <div className="card text-center">
            <p className="text-slate-500 mb-4">No clients found.</p>
            {userType === 'super_admin' && (
              <button onClick={() => navigate('/admin/clients')} className="btn-primary">
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
                className="card cursor-pointer hover:shadow-lg hover:border-primary-300 transition-all border-l-4 border-l-primary-500"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-800">{client.name}</h3>
                    <p className="text-sm text-slate-500 mt-1">
                      {client.user_count} user{client.user_count !== 1 ? 's' : ''}
                      {client.integrations && (
                        <span className="ml-2">
                          {client.integrations.split(',').map(i => (
                            <span key={i} className="inline-block bg-primary-50 text-primary-700 text-xs px-2 py-0.5 rounded-full ml-1">
                              {i}
                            </span>
                          ))}
                        </span>
                      )}
                    </p>
                  </div>
                  <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            ))}

            {userType === 'super_admin' && (
              <div className="text-center mt-6 space-x-4">
                <button onClick={() => navigate('/admin/clients')} className="text-sm text-primary-600 hover:text-primary-800">
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
