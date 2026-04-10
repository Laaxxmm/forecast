import { useEffect, useState } from 'react';
import api from '../api/client';
import { Eye, EyeOff, CheckCircle, Stethoscope, Pill, Trash2, Briefcase, Phone, Server } from 'lucide-react';

export default function SettingsPage() {
  const [fys, setFYs] = useState<any[]>([]);
  const [doctors, setDoctors] = useState<any[]>([]);
  const [newFY, setNewFY] = useState({ label: '', start_date: '', end_date: '' });
  const [newDoctor, setNewDoctor] = useState('');
  const [hpCreds, setHpCreds] = useState({ username: '', password: '', clinicName: '' });
  const [hpHasPassword, setHpHasPassword] = useState(false);
  const [showHpPassword, setShowHpPassword] = useState(false);
  const [hpSaving, setHpSaving] = useState(false);
  const [hpSaved, setHpSaved] = useState(false);
  const [ogCreds, setOgCreds] = useState({ username: '', password: '' });
  const [ogHasPassword, setOgHasPassword] = useState(false);
  const [showOgPassword, setShowOgPassword] = useState(false);
  const [ogSaving, setOgSaving] = useState(false);
  const [ogSaved, setOgSaved] = useState(false);
  const [turiaCreds, setTuriaCreds] = useState({ phoneNumber: '', financialYear: '2025-26' });
  const [turiaHasCreds, setTuriaHasCreds] = useState(false);
  const [turiaSaving, setTuriaSaving] = useState(false);
  const [turiaSaved, setTuriaSaved] = useState(false);
  const [tallyCreds, setTallyCreds] = useState({ host: 'localhost', port: '9000' });
  const [tallySaving, setTallySaving] = useState(false);
  const [tallySaved, setTallySaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const enabledIntegrations: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_integrations') || '[]'); } catch { return []; }
  })();
  const showFY = enabledIntegrations.includes('financial_years');
  const showDoctors = enabledIntegrations.includes('doctors');
  const showHp = enabledIntegrations.includes('healthplix');
  const showOg = enabledIntegrations.includes('oneglance');
  const showTuria = enabledIntegrations.includes('turia');
  const enabledModules: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_modules') || '[]'); } catch { return []; }
  })();
  const showTally = enabledModules.includes('vcfo_portal');

  const load = () => {
    Promise.all([api.get('/settings/fy'), api.get('/settings/doctors')]).then(([fyRes, docRes]) => {
      setFYs(fyRes.data); setDoctors(docRes.data);
    }).finally(() => setLoading(false));
  };

  const loadCredentials = () => {
    if (showHp) {
      api.get('/sync/credentials/healthplix').then(res => {
        setHpCreds(c => ({ ...c, username: res.data.username || '', clinicName: res.data.clinicName || '', password: '' }));
        setHpHasPassword(res.data.hasPassword);
      }).catch(() => {});
    }
    if (showOg) {
      api.get('/sync/credentials/oneglance').then(res => {
        setOgCreds(c => ({ ...c, username: res.data.username || '', password: '' }));
        setOgHasPassword(res.data.hasPassword);
      }).catch(() => {});
    }
    if (showTuria) {
      api.get('/sync/credentials/turia').then(res => {
        setTuriaCreds(c => ({ ...c, phoneNumber: res.data.phoneNumber || '', financialYear: res.data.financialYear || '2025-26' }));
        setTuriaHasCreds(res.data.hasCredentials);
      }).catch(() => {});
    }
    if (showTally) {
      api.get('/vcfo/tally/credentials').then(res => {
        setTallyCreds({ host: res.data.host || 'localhost', port: String(res.data.port || '9000') });
      }).catch(() => {});
    }
  };

  useEffect(() => { load(); loadCredentials(); }, []);

  const addFY = async () => {
    if (!newFY.label) return;
    try {
      await api.post('/settings/fy', newFY);
      setNewFY({ label: '', start_date: '', end_date: '' });
      load();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to add financial year');
    }
  };

  const activateFY = async (id: number) => {
    try {
      await api.put(`/settings/fy/${id}/activate`);
      load();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to activate financial year');
    }
  };

  const addDoctor = async () => {
    if (!newDoctor.trim()) return;
    try {
      await api.post('/settings/doctors', { name: newDoctor.trim() });
      setNewDoctor(''); load();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to add doctor');
    }
  };

  const generateFY = (year: string) => {
    const y = parseInt(year);
    if (!y) return;
    setNewFY({ label: `FY ${y}-${String(y + 1).slice(-2)}`, start_date: `${y}-04-01`, end_date: `${y + 1}-03-31` });
  };

  const saveHpCredentials = async () => {
    if (!hpCreds.username) return;
    setHpSaving(true); setHpSaved(false);
    try {
      await api.put('/sync/credentials/healthplix', { username: hpCreds.username, password: hpCreds.password || undefined, clinicName: hpCreds.clinicName });
      setHpSaved(true); setHpHasPassword(true); setHpCreds(c => ({ ...c, password: '' }));
      setTimeout(() => setHpSaved(false), 3000);
    } catch {}
    setHpSaving(false);
  };

  const clearHpCredentials = async () => {
    if (!confirm('Remove saved Healthplix credentials?')) return;
    await api.delete('/sync/credentials/healthplix');
    setHpCreds({ username: '', password: '', clinicName: '' }); setHpHasPassword(false);
  };

  const saveOgCredentials = async () => {
    if (!ogCreds.username) return;
    setOgSaving(true); setOgSaved(false);
    try {
      await api.put('/sync/credentials/oneglance', { username: ogCreds.username, password: ogCreds.password || undefined });
      setOgSaved(true); setOgHasPassword(true); setOgCreds(c => ({ ...c, password: '' }));
      setTimeout(() => setOgSaved(false), 3000);
    } catch {}
    setOgSaving(false);
  };

  const clearOgCredentials = async () => {
    if (!confirm('Remove saved Oneglance credentials?')) return;
    await api.delete('/sync/credentials/oneglance');
    setOgCreds({ username: '', password: '' }); setOgHasPassword(false);
  };

  const saveTuriaCredentials = async () => {
    if (!turiaCreds.phoneNumber) return;
    setTuriaSaving(true); setTuriaSaved(false);
    try {
      await api.put('/sync/credentials/turia', { phoneNumber: turiaCreds.phoneNumber, financialYear: turiaCreds.financialYear });
      setTuriaSaved(true); setTuriaHasCreds(true);
      setTimeout(() => setTuriaSaved(false), 3000);
    } catch {}
    setTuriaSaving(false);
  };

  const clearTuriaCredentials = async () => {
    if (!confirm('Remove saved Turia credentials?')) return;
    await api.delete('/sync/credentials/turia');
    setTuriaCreds({ phoneNumber: '', financialYear: '2025-26' }); setTuriaHasCreds(false);
  };

  const saveTallyCredentials = async () => {
    setTallySaving(true); setTallySaved(false);
    try {
      await api.put('/vcfo/tally/credentials', { host: tallyCreds.host, port: parseInt(tallyCreds.port) || 9000 });
      setTallySaved(true);
      setTimeout(() => setTallySaved(false), 3000);
    } catch {}
    setTallySaving(false);
  };

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="text-theme-muted">Loading...</div>
    </div>
  );

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-bold text-theme-heading mb-6">Settings</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Financial Years */}
        {showFY && <div className="card">
          <h3 className="font-semibold text-theme-heading mb-4">Financial Years</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm mb-4">
              <thead>
                <tr className="border-b border-dark-400/50">
                  <th className="text-left py-2 text-theme-faint font-medium text-xs uppercase">Label</th>
                  <th className="text-left py-2 text-theme-faint font-medium text-xs uppercase">Period</th>
                  <th className="text-center py-2 text-theme-faint font-medium text-xs uppercase">Active</th>
                  <th className="text-right py-2 text-theme-faint font-medium text-xs uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {fys.map(fy => (
                  <tr key={fy.id} className="border-b border-dark-400/30">
                    <td className="py-2.5 font-medium text-theme-primary">{fy.label}</td>
                    <td className="py-2.5 text-theme-faint">{fy.start_date} to {fy.end_date}</td>
                    <td className="py-2.5 text-center">
                      {fy.is_active ? <span className="badge-success text-[10px]">Active</span> : null}
                    </td>
                    <td className="py-2.5 text-right">
                      {!fy.is_active && (
                        <button onClick={() => activateFY(fy.id)} className="text-accent-400 hover:text-accent-300 text-xs font-medium transition-colors">
                          Set Active
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-dark-400/30 pt-4">
            <p className="text-sm text-theme-muted mb-2">Add Financial Year</p>
            <div className="flex gap-2">
              <input type="number" placeholder="Start year (e.g. 2026)" className="input w-48" onChange={e => generateFY(e.target.value)} />
              <input type="text" value={newFY.label} readOnly className="input w-32 bg-dark-600" placeholder="Label" />
              <button onClick={addFY} disabled={!newFY.label} className="btn-primary">Add</button>
            </div>
          </div>
        </div>}

        {/* Doctors */}
        {showDoctors && <div className="card">
          <h3 className="font-semibold text-theme-heading mb-4">Doctors</h3>
          <p className="text-sm text-theme-faint mb-3">Doctors are auto-imported from Healthplix reports. You can also add manually.</p>
          <div className="max-h-64 overflow-y-auto mb-4">
            {doctors.map(d => (
              <div key={d.id} className="flex items-center justify-between py-2.5 px-3 border-b border-dark-400/30">
                <span className="text-sm text-theme-secondary">{d.name}</span>
                <span className={`text-[10px] font-medium ${d.is_active ? 'text-accent-400' : 'text-theme-faint'}`}>
                  {d.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
            {doctors.length === 0 && <p className="text-theme-faint text-center py-4 text-sm">No doctors yet</p>}
          </div>
          <div className="flex gap-2">
            <input type="text" value={newDoctor} onChange={e => setNewDoctor(e.target.value)}
              placeholder="Doctor name" className="input flex-1" onKeyDown={e => e.key === 'Enter' && addDoctor()} />
            <button onClick={addDoctor} className="btn-primary">Add</button>
          </div>
        </div>}

        {/* Healthplix Credentials */}
        {showHp && <div className="card">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-accent-500/10 flex items-center justify-center">
              <Stethoscope size={20} className="text-accent-400" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-theme-heading">Healthplix Credentials</h3>
              <p className="text-sm text-theme-faint">Clinic billing auto-sync</p>
            </div>
            {hpHasPassword && <span className="badge-success text-[10px]"><CheckCircle size={10} /> Configured</span>}
          </div>
          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-theme-muted mb-1.5">Username / Email</label>
              <input type="text" value={hpCreds.username} onChange={e => setHpCreds(c => ({ ...c, username: e.target.value }))} placeholder="your@email.com" className="input w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-theme-muted mb-1.5">
                Password {hpHasPassword && <span className="text-xs text-theme-faint">(saved)</span>}
              </label>
              <div className="relative">
                <input type={showHpPassword ? 'text' : 'password'} value={hpCreds.password} onChange={e => setHpCreds(c => ({ ...c, password: e.target.value }))}
                  placeholder={hpHasPassword ? '••••••••' : 'Enter password'} className="input w-full pr-10" />
                <button type="button" onClick={() => setShowHpPassword(!showHpPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-faint hover:text-theme-secondary transition-colors">
                  {showHpPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-theme-muted mb-1.5">Clinic Name</label>
              <input type="text" value={hpCreds.clinicName} onChange={e => setHpCreds(c => ({ ...c, clinicName: e.target.value }))} placeholder="MagnaCode Bangalore" className="input w-full" />
            </div>
          </div>
          <div className="flex gap-3 items-center">
            <button onClick={saveHpCredentials} disabled={hpSaving || !hpCreds.username} className="btn-primary text-sm">
              {hpSaving ? 'Saving...' : hpSaved ? 'Saved!' : 'Save'}
            </button>
            {hpHasPassword && (
              <button onClick={clearHpCredentials} className="flex items-center gap-1 text-sm text-red-400/60 hover:text-red-400 transition-colors">
                <Trash2 size={14} /> Clear
              </button>
            )}
          </div>
        </div>}

        {/* Oneglance Credentials */}
        {showOg && <div className="card">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
              <Pill size={20} className="text-purple-400" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-theme-heading">Oneglance Credentials</h3>
              <p className="text-sm text-theme-faint">Pharmacy reports auto-sync</p>
            </div>
            {ogHasPassword && <span className="badge-success text-[10px]"><CheckCircle size={10} /> Configured</span>}
          </div>
          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-theme-muted mb-1.5">Username</label>
              <input type="text" value={ogCreds.username} onChange={e => setOgCreds(c => ({ ...c, username: e.target.value }))} placeholder="Username" className="input w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-theme-muted mb-1.5">
                Password {ogHasPassword && <span className="text-xs text-theme-faint">(saved)</span>}
              </label>
              <div className="relative">
                <input type={showOgPassword ? 'text' : 'password'} value={ogCreds.password} onChange={e => setOgCreds(c => ({ ...c, password: e.target.value }))}
                  placeholder={ogHasPassword ? '••••••••' : 'Enter password'} className="input w-full pr-10" />
                <button type="button" onClick={() => setShowOgPassword(!showOgPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-faint hover:text-theme-secondary transition-colors">
                  {showOgPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>
          <div className="flex gap-3 items-center">
            <button onClick={saveOgCredentials} disabled={ogSaving || !ogCreds.username} className="btn-primary text-sm">
              {ogSaving ? 'Saving...' : ogSaved ? 'Saved!' : 'Save'}
            </button>
            {ogHasPassword && (
              <button onClick={clearOgCredentials} className="flex items-center gap-1 text-sm text-red-400/60 hover:text-red-400 transition-colors">
                <Trash2 size={14} /> Clear
              </button>
            )}
          </div>
        </div>}

        {/* Turia Credentials */}
        {showTuria && <div className="card">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <Briefcase size={20} className="text-blue-400" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-theme-heading">Turia Credentials</h3>
              <p className="text-sm text-theme-faint">Consultancy invoice auto-sync (OTP login)</p>
            </div>
            {turiaHasCreds && <span className="badge-success text-[10px]"><CheckCircle size={10} /> Configured</span>}
          </div>
          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-theme-muted mb-1.5">
                <Phone size={14} className="inline mr-1" /> Phone Number
              </label>
              <input type="tel" value={turiaCreds.phoneNumber} onChange={e => setTuriaCreds(c => ({ ...c, phoneNumber: e.target.value }))}
                placeholder="9876543210" className="input w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-theme-muted mb-1.5">Default Financial Year</label>
              <select value={turiaCreds.financialYear} onChange={e => setTuriaCreds(c => ({ ...c, financialYear: e.target.value }))} className="input w-full">
                <option value="2023-24">2023-24</option>
                <option value="2024-25">2024-25</option>
                <option value="2025-26">2025-26</option>
                <option value="2026-27">2026-27</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3 items-center">
            <button onClick={saveTuriaCredentials} disabled={turiaSaving || !turiaCreds.phoneNumber} className="btn-primary text-sm">
              {turiaSaving ? 'Saving...' : turiaSaved ? 'Saved!' : 'Save'}
            </button>
            {turiaHasCreds && (
              <button onClick={clearTuriaCredentials} className="flex items-center gap-1 text-sm text-red-400/60 hover:text-red-400 transition-colors">
                <Trash2 size={14} /> Clear
              </button>
            )}
          </div>
        </div>}

        {/* Tally Connection */}
        {showTally && <div className="card">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <Server size={18} className="text-blue-400" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-theme-heading">Tally Connection</h3>
              <p className="text-sm text-theme-faint">Configure Tally host and port for VCFO data sync</p>
            </div>
          </div>
          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-xs text-theme-faint mb-1">Tally Host</label>
              <input
                type="text"
                value={tallyCreds.host}
                onChange={e => setTallyCreds(c => ({ ...c, host: e.target.value }))}
                placeholder="localhost"
                className="input-primary w-full"
              />
            </div>
            <div>
              <label className="block text-xs text-theme-faint mb-1">Tally Port</label>
              <input
                type="text"
                value={tallyCreds.port}
                onChange={e => setTallyCreds(c => ({ ...c, port: e.target.value }))}
                placeholder="9000"
                className="input-primary w-full"
              />
            </div>
          </div>
          <button onClick={saveTallyCredentials} disabled={tallySaving} className="btn-primary text-sm">
            {tallySaving ? 'Saving...' : tallySaved ? 'Saved!' : 'Save'}
          </button>
        </div>}
        {!showFY && !showDoctors && !showHp && !showOg && !showTuria && !showTally && (
          <div className="card col-span-full text-center py-10">
            <p className="text-theme-faint text-sm">No settings sections are enabled for your account.</p>
            <p className="text-theme-faint text-xs mt-1">Contact your administrator to configure available settings.</p>
          </div>
        )}
      </div>

      {(showHp || showOg || showTuria || showTally) && (
        <p className="text-xs text-theme-faint mt-4">
          Credentials are encrypted and stored locally. They are only used to automate report downloads.
        </p>
      )}
    </div>
  );
}
