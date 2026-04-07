import { useEffect, useState } from 'react';
import api from '../api/client';
import { Eye, EyeOff, CheckCircle, Stethoscope, Pill, Trash2 } from 'lucide-react';

export default function SettingsPage() {
  const [fys, setFYs] = useState<any[]>([]);
  const [doctors, setDoctors] = useState<any[]>([]);
  const [newFY, setNewFY] = useState({ label: '', start_date: '', end_date: '' });
  const [newDoctor, setNewDoctor] = useState('');

  // Healthplix credentials
  const [hpCreds, setHpCreds] = useState({ username: '', password: '', clinicName: '' });
  const [hpHasPassword, setHpHasPassword] = useState(false);
  const [showHpPassword, setShowHpPassword] = useState(false);
  const [hpSaving, setHpSaving] = useState(false);
  const [hpSaved, setHpSaved] = useState(false);

  // Oneglance credentials
  const [ogCreds, setOgCreds] = useState({ username: '', password: '' });
  const [ogHasPassword, setOgHasPassword] = useState(false);
  const [showOgPassword, setShowOgPassword] = useState(false);
  const [ogSaving, setOgSaving] = useState(false);
  const [ogSaved, setOgSaved] = useState(false);

  const load = () => {
    Promise.all([
      api.get('/settings/fy'),
      api.get('/settings/doctors'),
    ]).then(([fyRes, docRes]) => {
      setFYs(fyRes.data);
      setDoctors(docRes.data);
    });
  };

  const loadCredentials = () => {
    api.get('/sync/credentials/healthplix').then(res => {
      setHpCreds(c => ({ ...c, username: res.data.username || '', clinicName: res.data.clinicName || '', password: '' }));
      setHpHasPassword(res.data.hasPassword);
    }).catch(() => {});

    api.get('/sync/credentials/oneglance').then(res => {
      setOgCreds(c => ({ ...c, username: res.data.username || '', password: '' }));
      setOgHasPassword(res.data.hasPassword);
    }).catch(() => {});
  };

  useEffect(() => { load(); loadCredentials(); }, []);

  const addFY = async () => {
    if (!newFY.label) return;
    await api.post('/settings/fy', newFY);
    setNewFY({ label: '', start_date: '', end_date: '' });
    load();
  };

  const activateFY = async (id: number) => {
    await api.put(`/settings/fy/${id}/activate`);
    load();
  };

  const addDoctor = async () => {
    if (!newDoctor.trim()) return;
    await api.post('/settings/doctors', { name: newDoctor.trim() });
    setNewDoctor('');
    load();
  };

  const generateFY = (year: string) => {
    const y = parseInt(year);
    if (!y) return;
    setNewFY({
      label: `FY ${y}-${String(y + 1).slice(-2)}`,
      start_date: `${y}-04-01`,
      end_date: `${y + 1}-03-31`,
    });
  };

  const saveHpCredentials = async () => {
    if (!hpCreds.username) return;
    setHpSaving(true);
    setHpSaved(false);
    try {
      await api.put('/sync/credentials/healthplix', {
        username: hpCreds.username,
        password: hpCreds.password || undefined,
        clinicName: hpCreds.clinicName,
      });
      setHpSaved(true);
      setHpHasPassword(true);
      setHpCreds(c => ({ ...c, password: '' }));
      setTimeout(() => setHpSaved(false), 3000);
    } catch {}
    setHpSaving(false);
  };

  const clearHpCredentials = async () => {
    if (!confirm('Remove saved Healthplix credentials?')) return;
    await api.delete('/sync/credentials/healthplix');
    setHpCreds({ username: '', password: '', clinicName: '' });
    setHpHasPassword(false);
  };

  const saveOgCredentials = async () => {
    if (!ogCreds.username) return;
    setOgSaving(true);
    setOgSaved(false);
    try {
      await api.put('/sync/credentials/oneglance', {
        username: ogCreds.username,
        password: ogCreds.password || undefined,
      });
      setOgSaved(true);
      setOgHasPassword(true);
      setOgCreds(c => ({ ...c, password: '' }));
      setTimeout(() => setOgSaved(false), 3000);
    } catch {}
    setOgSaving(false);
  };

  const clearOgCredentials = async () => {
    if (!confirm('Remove saved Oneglance credentials?')) return;
    await api.delete('/sync/credentials/oneglance');
    setOgCreds({ username: '', password: '' });
    setOgHasPassword(false);
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-800 mb-6">Settings</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Financial Years */}
        <div className="card">
          <h3 className="font-semibold text-slate-800 mb-4">Financial Years</h3>
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-2">Label</th>
                <th className="text-left py-2">Period</th>
                <th className="text-center py-2">Active</th>
                <th className="text-right py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {fys.map(fy => (
                <tr key={fy.id} className="border-b border-slate-100">
                  <td className="py-2 font-medium">{fy.label}</td>
                  <td className="py-2 text-slate-500">{fy.start_date} to {fy.end_date}</td>
                  <td className="py-2 text-center">
                    {fy.is_active ? (
                      <span className="px-2 py-0.5 bg-emerald-50 text-emerald-600 rounded-full text-xs font-medium">Active</span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right">
                    {!fy.is_active && (
                      <button onClick={() => activateFY(fy.id)} className="text-primary-600 hover:text-primary-800 text-xs font-medium">
                        Set Active
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="border-t border-slate-200 pt-4">
            <p className="text-sm text-slate-600 mb-2">Add Financial Year</p>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="Start year (e.g. 2026)"
                className="input w-48"
                onChange={e => generateFY(e.target.value)}
              />
              <input type="text" value={newFY.label} readOnly className="input w-32 bg-slate-50" placeholder="Label" />
              <button onClick={addFY} disabled={!newFY.label} className="btn-primary">Add</button>
            </div>
          </div>
        </div>

        {/* Doctors */}
        <div className="card">
          <h3 className="font-semibold text-slate-800 mb-4">Doctors</h3>
          <p className="text-sm text-slate-500 mb-3">Doctors are auto-imported from Healthplix reports. You can also add manually.</p>
          <div className="max-h-64 overflow-y-auto mb-4">
            {doctors.map(d => (
              <div key={d.id} className="flex items-center justify-between py-2 px-3 border-b border-slate-100">
                <span className="text-sm text-slate-700">{d.name}</span>
                <span className={`text-xs ${d.is_active ? 'text-emerald-500' : 'text-slate-400'}`}>
                  {d.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
            {doctors.length === 0 && <p className="text-slate-400 text-center py-4">No doctors yet</p>}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newDoctor}
              onChange={e => setNewDoctor(e.target.value)}
              placeholder="Doctor name"
              className="input flex-1"
              onKeyDown={e => e.key === 'Enter' && addDoctor()}
            />
            <button onClick={addDoctor} className="btn-primary">Add</button>
          </div>
        </div>

        {/* Healthplix Credentials */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center">
              <Stethoscope size={20} className="text-primary-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">Healthplix Credentials</h3>
              <p className="text-sm text-slate-500">Clinic billing auto-sync</p>
            </div>
            {hpHasPassword && (
              <span className="ml-auto flex items-center gap-1 text-xs text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full">
                <CheckCircle size={12} /> Configured
              </span>
            )}
          </div>

          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Username / Email</label>
              <input
                type="text"
                value={hpCreds.username}
                onChange={e => setHpCreds(c => ({ ...c, username: e.target.value }))}
                placeholder="your@email.com"
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Password {hpHasPassword && <span className="text-xs text-slate-400">(saved)</span>}
              </label>
              <div className="relative">
                <input
                  type={showHpPassword ? 'text' : 'password'}
                  value={hpCreds.password}
                  onChange={e => setHpCreds(c => ({ ...c, password: e.target.value }))}
                  placeholder={hpHasPassword ? '••••••••' : 'Enter password'}
                  className="input w-full pr-10"
                />
                <button type="button" onClick={() => setShowHpPassword(!showHpPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showHpPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Clinic Name</label>
              <input
                type="text"
                value={hpCreds.clinicName}
                onChange={e => setHpCreds(c => ({ ...c, clinicName: e.target.value }))}
                placeholder="MagnaCode Bangalore"
                className="input w-full"
              />
            </div>
          </div>

          <div className="flex gap-3 items-center">
            <button onClick={saveHpCredentials} disabled={hpSaving || !hpCreds.username} className="btn-primary text-sm">
              {hpSaving ? 'Saving...' : hpSaved ? 'Saved!' : 'Save'}
            </button>
            {hpHasPassword && (
              <button onClick={clearHpCredentials} className="flex items-center gap-1 text-sm text-red-500 hover:text-red-700">
                <Trash2 size={14} /> Clear
              </button>
            )}
          </div>
        </div>

        {/* Oneglance Credentials */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center">
              <Pill size={20} className="text-orange-600" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">Oneglance Credentials</h3>
              <p className="text-sm text-slate-500">Pharmacy reports auto-sync</p>
            </div>
            {ogHasPassword && (
              <span className="ml-auto flex items-center gap-1 text-xs text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full">
                <CheckCircle size={12} /> Configured
              </span>
            )}
          </div>

          <div className="space-y-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
              <input
                type="text"
                value={ogCreds.username}
                onChange={e => setOgCreds(c => ({ ...c, username: e.target.value }))}
                placeholder="Username"
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Password {ogHasPassword && <span className="text-xs text-slate-400">(saved)</span>}
              </label>
              <div className="relative">
                <input
                  type={showOgPassword ? 'text' : 'password'}
                  value={ogCreds.password}
                  onChange={e => setOgCreds(c => ({ ...c, password: e.target.value }))}
                  placeholder={ogHasPassword ? '••••••••' : 'Enter password'}
                  className="input w-full pr-10"
                />
                <button type="button" onClick={() => setShowOgPassword(!showOgPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
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
              <button onClick={clearOgCredentials} className="flex items-center gap-1 text-sm text-red-500 hover:text-red-700">
                <Trash2 size={14} /> Clear
              </button>
            )}
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-400 mt-4">
        Credentials are encrypted and stored locally. They are only used to automate report downloads.
      </p>
    </div>
  );
}
