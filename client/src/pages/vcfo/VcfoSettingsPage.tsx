import { useState, useEffect } from 'react';
import api from '../../api/client';
import { Settings, Save, Server, ToggleLeft, ToggleRight, Check, Loader2 } from 'lucide-react';

interface Company {
  id: number;
  name: string;
}

interface ModuleToggles {
  trial_balance: boolean;
  profit_loss: boolean;
  balance_sheet: boolean;
  bills_outstanding: boolean;
  stock_summary: boolean;
  vouchers: boolean;
  gst_entries: boolean;
  cost_centres: boolean;
  payroll: boolean;
}

const MODULE_LABELS: Record<keyof ModuleToggles, string> = {
  trial_balance: 'Trial Balance',
  profit_loss: 'Profit & Loss',
  balance_sheet: 'Balance Sheet',
  bills_outstanding: 'Bills Outstanding',
  stock_summary: 'Stock Summary',
  vouchers: 'Vouchers',
  gst_entries: 'GST Entries',
  cost_centres: 'Cost Centres',
  payroll: 'Payroll',
};

const ALL_MODULES = Object.keys(MODULE_LABELS) as (keyof ModuleToggles)[];

export default function VcfoSettingsPage() {
  // Tally connection state
  const [tallyHost, setTallyHost] = useState('localhost');
  const [tallyPort, setTallyPort] = useState('9000');
  const [savingTally, setSavingTally] = useState(false);
  const [tallySaved, setTallySaved] = useState(false);
  const [tallyError, setTallyError] = useState('');

  // Companies & modules state
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyModules, setCompanyModules] = useState<Record<number, ModuleToggles>>({});
  const [savingModules, setSavingModules] = useState<Record<number, boolean>>({});
  const [savedModules, setSavedModules] = useState<Record<number, boolean>>({});
  const [loadingSettings, setLoadingSettings] = useState(true);

  // Load settings + companies on mount
  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoadingSettings(true);
    try {
      const [settingsRes, companiesRes] = await Promise.all([
        api.get('/vcfo/settings'),
        api.get('/vcfo/companies'),
      ]);
      const s = settingsRes.data;
      setTallyHost(s.tally_host || 'localhost');
      setTallyPort(s.tally_port || '9000');

      const comps: Company[] = companiesRes.data;
      setCompanies(comps);

      // Load modules for each company
      const modulesMap: Record<number, ModuleToggles> = {};
      await Promise.all(
        comps.map(async (c) => {
          try {
            const res = await api.get(`/vcfo/settings/companies/${c.id}/modules`);
            modulesMap[c.id] = res.data;
          } catch {
            // Default all to false if no settings yet
            modulesMap[c.id] = Object.fromEntries(ALL_MODULES.map(m => [m, false])) as unknown as ModuleToggles;
          }
        })
      );
      setCompanyModules(modulesMap);
    } catch {
      // silently handle
    }
    setLoadingSettings(false);
  };

  const saveTallySettings = async () => {
    setSavingTally(true);
    setTallyError('');
    setTallySaved(false);
    try {
      await api.post('/vcfo/settings', {
        tally_host: tallyHost,
        tally_port: tallyPort,
      });
      setTallySaved(true);
      setTimeout(() => setTallySaved(false), 3000);
    } catch (err: any) {
      setTallyError(err.response?.data?.error || 'Failed to save settings');
    }
    setSavingTally(false);
  };

  const toggleModule = (companyId: number, mod: keyof ModuleToggles) => {
    setCompanyModules(prev => ({
      ...prev,
      [companyId]: {
        ...prev[companyId],
        [mod]: !prev[companyId]?.[mod],
      },
    }));
  };

  const saveCompanyModules = async (companyId: number) => {
    setSavingModules(prev => ({ ...prev, [companyId]: true }));
    setSavedModules(prev => ({ ...prev, [companyId]: false }));
    try {
      await api.post(`/vcfo/settings/companies/${companyId}/modules`, companyModules[companyId]);
      setSavedModules(prev => ({ ...prev, [companyId]: true }));
      setTimeout(() => setSavedModules(prev => ({ ...prev, [companyId]: false })), 3000);
    } catch {
      // silently handle
    }
    setSavingModules(prev => ({ ...prev, [companyId]: false }));
  };

  if (loadingSettings) {
    return (
      <div className="p-6 max-w-4xl mx-auto flex items-center justify-center min-h-[400px]">
        <Loader2 size={24} className="animate-spin text-theme-muted" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Settings size={22} className="text-accent-400" />
        <div>
          <h1 className="text-2xl font-bold text-theme-heading">VCFO Settings</h1>
          <p className="text-sm text-theme-muted mt-1">Manage Tally connection and sync modules</p>
        </div>
      </div>

      {/* Tally Connection Section */}
      <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
        <div className="flex items-center gap-2 mb-4">
          <Server size={16} className="text-accent-400" />
          <h2 className="text-sm font-semibold text-theme-heading">Tally Connection</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium text-theme-muted mb-1.5">Host</label>
            <input
              type="text"
              value={tallyHost}
              onChange={e => setTallyHost(e.target.value)}
              placeholder="localhost"
              className="w-full bg-dark-600 border border-dark-400/30 rounded-lg px-3 py-2 text-sm text-theme-primary placeholder-theme-faint focus:outline-none focus:border-accent-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-theme-muted mb-1.5">Port</label>
            <input
              type="text"
              value={tallyPort}
              onChange={e => setTallyPort(e.target.value)}
              placeholder="9000"
              className="w-full bg-dark-600 border border-dark-400/30 rounded-lg px-3 py-2 text-sm text-theme-primary placeholder-theme-faint focus:outline-none focus:border-accent-500/50"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={saveTallySettings}
            disabled={savingTally}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent-500 hover:bg-accent-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {savingTally ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            Save Connection
          </button>
          {tallySaved && (
            <span className="flex items-center gap-1 text-xs text-green-400 font-medium">
              <Check size={14} />
              Saved successfully
            </span>
          )}
          {tallyError && (
            <span className="text-xs text-red-400">{tallyError}</span>
          )}
        </div>
      </div>

      {/* Company Sync Modules Section */}
      <div className="bg-dark-700 rounded-2xl p-5 border border-dark-400/20">
        <h2 className="text-sm font-semibold text-theme-heading mb-4">Company Sync Modules</h2>

        {companies.length === 0 ? (
          <p className="text-sm text-theme-muted">No companies found. Sync from Tally first.</p>
        ) : (
          <div className="space-y-5">
            {companies.map(company => (
              <div key={company.id} className="bg-dark-600 rounded-xl p-4 border border-dark-400/20">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-theme-primary">{company.name}</h3>
                  <div className="flex items-center gap-2">
                    {savedModules[company.id] && (
                      <span className="flex items-center gap-1 text-xs text-green-400 font-medium">
                        <Check size={12} />
                        Saved
                      </span>
                    )}
                    <button
                      onClick={() => saveCompanyModules(company.id)}
                      disabled={savingModules[company.id]}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-accent-500/10 hover:bg-accent-500/20 text-accent-400 text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
                    >
                      {savingModules[company.id] ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Save size={12} />
                      )}
                      Save
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {ALL_MODULES.map(mod => {
                    const enabled = companyModules[company.id]?.[mod] ?? false;
                    return (
                      <button
                        key={mod}
                        onClick={() => toggleModule(company.id, mod)}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                          enabled
                            ? 'bg-accent-500/10 border border-accent-500/30'
                            : 'bg-dark-700 border border-dark-400/20 hover:border-dark-400/40'
                        }`}
                      >
                        {enabled ? (
                          <ToggleRight size={18} className="text-accent-400 flex-shrink-0" />
                        ) : (
                          <ToggleLeft size={18} className="text-theme-faint flex-shrink-0" />
                        )}
                        <span className={`text-xs font-medium ${enabled ? 'text-theme-primary' : 'text-theme-muted'}`}>
                          {MODULE_LABELS[mod]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
