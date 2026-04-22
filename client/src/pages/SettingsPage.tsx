import { useEffect, useState } from 'react';
import api from '../api/client';
import { Eye, EyeOff, CheckCircle, Stethoscope, Pill, Trash2, Briefcase, Phone } from 'lucide-react';

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
  const [loading, setLoading] = useState(true);

  const enabledIntegrations: string[] = (() => {
    try { return JSON.parse(localStorage.getItem('enabled_integrations') || '[]'); } catch { return []; }
  })();
  const showFY = enabledIntegrations.includes('financial_years');
  const showDoctors = enabledIntegrations.includes('doctors');
  const showHp = enabledIntegrations.includes('healthplix');
  const showOg = enabledIntegrations.includes('oneglance');
  const showTuria = enabledIntegrations.includes('turia');

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

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div style={{ color: 'var(--mt-text-muted)' }}>Loading...</div>
    </div>
  );

  const labelCls = "block text-sm font-medium mb-1.5";
  const labelStyle = { color: 'var(--mt-text-muted)' } as React.CSSProperties;

  const CredCard = ({
    tone, Icon, title, subtitle, configured, children,
  }: { tone: { fg: string; soft: string; border: string }, Icon: any, title: string, subtitle: string, configured: boolean, children: React.ReactNode }) => (
    <div className="mt-card p-5">
      <div className="flex items-center gap-3 mb-5">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: tone.soft, boxShadow: `inset 0 0 0 1px ${tone.border}` }}
        >
          <Icon size={20} style={{ color: tone.fg }} />
        </div>
        <div className="flex-1">
          <h3 className="mt-heading text-base">{title}</h3>
          <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>{subtitle}</p>
        </div>
        {configured && (
          <span className="mt-pill mt-pill--success mt-pill-sm">
            <CheckCircle size={10} /> Configured
          </span>
        )}
      </div>
      {children}
    </div>
  );

  const tones = {
    accent: { fg: '#10b981', soft: 'color-mix(in srgb, #10b981 12%, transparent)', border: 'color-mix(in srgb, #10b981 30%, transparent)' },
    purple: { fg: '#8b5cf6', soft: 'color-mix(in srgb, #8b5cf6 12%, transparent)', border: 'color-mix(in srgb, #8b5cf6 30%, transparent)' },
    blue:   { fg: '#3b82f6', soft: 'color-mix(in srgb, #3b82f6 12%, transparent)', border: 'color-mix(in srgb, #3b82f6 30%, transparent)' },
  };

  const clearBtn = (onClick: () => void) => (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-sm transition-colors"
      style={{ color: 'var(--mt-text-faint)' }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-danger-text)'; }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
    >
      <Trash2 size={14} /> Clear
    </button>
  );

  return (
    <div className="animate-fade-in">
      <h1 className="mt-heading text-2xl mb-6">Settings</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Financial Years */}
        {showFY && <div className="mt-card p-5">
          <h3 className="mt-heading text-base mb-4">Financial Years</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm mb-4">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--mt-border)' }}>
                  <th className="text-left py-2 font-medium text-xs uppercase" style={{ color: 'var(--mt-text-faint)' }}>Label</th>
                  <th className="text-left py-2 font-medium text-xs uppercase" style={{ color: 'var(--mt-text-faint)' }}>Period</th>
                  <th className="text-center py-2 font-medium text-xs uppercase" style={{ color: 'var(--mt-text-faint)' }}>Active</th>
                  <th className="text-right py-2 font-medium text-xs uppercase" style={{ color: 'var(--mt-text-faint)' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {fys.map(fy => (
                  <tr key={fy.id} style={{ borderBottom: '1px solid var(--mt-border)' }}>
                    <td className="py-2.5 font-medium" style={{ color: 'var(--mt-text-heading)' }}>{fy.label}</td>
                    <td className="py-2.5" style={{ color: 'var(--mt-text-faint)' }}>{fy.start_date} to {fy.end_date}</td>
                    <td className="py-2.5 text-center">
                      {fy.is_active ? <span className="mt-pill mt-pill--success mt-pill-sm">Active</span> : null}
                    </td>
                    <td className="py-2.5 text-right">
                      {!fy.is_active && (
                        <button
                          onClick={() => activateFY(fy.id)}
                          className="text-xs font-medium transition-colors"
                          style={{ color: 'var(--mt-accent-text)' }}
                        >
                          Set Active
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pt-4" style={{ borderTop: '1px solid var(--mt-border)' }}>
            <p className="text-sm mb-2" style={{ color: 'var(--mt-text-muted)' }}>Add Financial Year</p>
            <div className="flex gap-2">
              <input type="number" placeholder="Start year (e.g. 2026)" className="mt-input w-48" onChange={e => generateFY(e.target.value)} />
              <input type="text" value={newFY.label} readOnly className="mt-input w-32" placeholder="Label" style={{ background: 'var(--mt-bg-muted)' }} />
              <button onClick={addFY} disabled={!newFY.label} className="mt-btn-gradient">Add</button>
            </div>
          </div>
        </div>}

        {/* Doctors */}
        {showDoctors && <div className="mt-card p-5">
          <h3 className="mt-heading text-base mb-4">Doctors</h3>
          <p className="text-sm mb-3" style={{ color: 'var(--mt-text-faint)' }}>Doctors are auto-imported from Healthplix reports. You can also add manually.</p>
          <div className="max-h-64 overflow-y-auto mb-4">
            {doctors.map(d => (
              <div
                key={d.id}
                className="flex items-center justify-between py-2.5 px-3"
                style={{ borderBottom: '1px solid var(--mt-border)' }}
              >
                <span className="text-sm" style={{ color: 'var(--mt-text-secondary)' }}>{d.name}</span>
                <span
                  className="text-[10px] font-medium"
                  style={{ color: d.is_active ? 'var(--mt-accent-text)' : 'var(--mt-text-faint)' }}
                >
                  {d.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
            {doctors.length === 0 && <p className="text-center py-4 text-sm" style={{ color: 'var(--mt-text-faint)' }}>No doctors yet</p>}
          </div>
          <div className="flex gap-2">
            <input type="text" value={newDoctor} onChange={e => setNewDoctor(e.target.value)}
              placeholder="Doctor name" className="mt-input flex-1" onKeyDown={e => e.key === 'Enter' && addDoctor()} />
            <button onClick={addDoctor} className="mt-btn-gradient">Add</button>
          </div>
        </div>}

        {/* Healthplix Credentials */}
        {showHp && <CredCard tone={tones.accent} Icon={Stethoscope} title="Healthplix Credentials" subtitle="Clinic billing auto-sync" configured={hpHasPassword}>
          <div className="space-y-3 mb-4">
            <div>
              <label className={labelCls} style={labelStyle}>Username / Email</label>
              <input type="text" value={hpCreds.username} onChange={e => setHpCreds(c => ({ ...c, username: e.target.value }))} placeholder="your@email.com" className="mt-input w-full" />
            </div>
            <div>
              <label className={labelCls} style={labelStyle}>
                Password {hpHasPassword && <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>(saved)</span>}
              </label>
              <div className="relative">
                <input type={showHpPassword ? 'text' : 'password'} value={hpCreds.password} onChange={e => setHpCreds(c => ({ ...c, password: e.target.value }))}
                  placeholder={hpHasPassword ? '••••••••' : 'Enter password'} className="mt-input w-full pr-10" />
                <button type="button" onClick={() => setShowHpPassword(!showHpPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--mt-text-faint)' }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-text-secondary)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
                >
                  {showHpPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls} style={labelStyle}>Clinic Name</label>
              <input type="text" value={hpCreds.clinicName} onChange={e => setHpCreds(c => ({ ...c, clinicName: e.target.value }))} placeholder="MagnaCode Bangalore" className="mt-input w-full" />
            </div>
          </div>
          <div className="flex gap-3 items-center">
            <button onClick={saveHpCredentials} disabled={hpSaving || !hpCreds.username} className="mt-btn-gradient text-sm">
              {hpSaving ? 'Saving...' : hpSaved ? 'Saved!' : 'Save'}
            </button>
            {hpHasPassword && clearBtn(clearHpCredentials)}
          </div>
        </CredCard>}

        {/* Oneglance Credentials */}
        {showOg && <CredCard tone={tones.purple} Icon={Pill} title="Oneglance Credentials" subtitle="Pharmacy reports auto-sync" configured={ogHasPassword}>
          <div className="space-y-3 mb-4">
            <div>
              <label className={labelCls} style={labelStyle}>Username</label>
              <input type="text" value={ogCreds.username} onChange={e => setOgCreds(c => ({ ...c, username: e.target.value }))} placeholder="Username" className="mt-input w-full" />
            </div>
            <div>
              <label className={labelCls} style={labelStyle}>
                Password {ogHasPassword && <span className="text-xs" style={{ color: 'var(--mt-text-faint)' }}>(saved)</span>}
              </label>
              <div className="relative">
                <input type={showOgPassword ? 'text' : 'password'} value={ogCreds.password} onChange={e => setOgCreds(c => ({ ...c, password: e.target.value }))}
                  placeholder={ogHasPassword ? '••••••••' : 'Enter password'} className="mt-input w-full pr-10" />
                <button type="button" onClick={() => setShowOgPassword(!showOgPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--mt-text-faint)' }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-text-secondary)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
                >
                  {showOgPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>
          <div className="flex gap-3 items-center">
            <button onClick={saveOgCredentials} disabled={ogSaving || !ogCreds.username} className="mt-btn-gradient text-sm">
              {ogSaving ? 'Saving...' : ogSaved ? 'Saved!' : 'Save'}
            </button>
            {ogHasPassword && clearBtn(clearOgCredentials)}
          </div>
        </CredCard>}

        {/* Turia Credentials */}
        {showTuria && <CredCard tone={tones.blue} Icon={Briefcase} title="Turia Credentials" subtitle="Consultancy invoice auto-sync (OTP login)" configured={turiaHasCreds}>
          <div className="space-y-3 mb-4">
            <div>
              <label className={labelCls} style={labelStyle}>
                <Phone size={14} className="inline mr-1" /> Phone Number
              </label>
              <input type="tel" value={turiaCreds.phoneNumber} onChange={e => setTuriaCreds(c => ({ ...c, phoneNumber: e.target.value }))}
                placeholder="9876543210" className="mt-input w-full" />
            </div>
            <div>
              <label className={labelCls} style={labelStyle}>Default Financial Year</label>
              <select value={turiaCreds.financialYear} onChange={e => setTuriaCreds(c => ({ ...c, financialYear: e.target.value }))} className="mt-input w-full">
                <option value="2023-24">2023-24</option>
                <option value="2024-25">2024-25</option>
                <option value="2025-26">2025-26</option>
                <option value="2026-27">2026-27</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3 items-center">
            <button onClick={saveTuriaCredentials} disabled={turiaSaving || !turiaCreds.phoneNumber} className="mt-btn-gradient text-sm">
              {turiaSaving ? 'Saving...' : turiaSaved ? 'Saved!' : 'Save'}
            </button>
            {turiaHasCreds && clearBtn(clearTuriaCredentials)}
          </div>
        </CredCard>}

        {!showFY && !showDoctors && !showHp && !showOg && !showTuria && (
          <div className="mt-card col-span-full text-center py-10 px-5">
            <p className="text-sm" style={{ color: 'var(--mt-text-faint)' }}>No settings sections are enabled for your account.</p>
            <p className="text-xs mt-1" style={{ color: 'var(--mt-text-faint)' }}>Contact your administrator to configure available settings.</p>
          </div>
        )}
      </div>

      {(showHp || showOg || showTuria) && (
        <p className="text-xs mt-4" style={{ color: 'var(--mt-text-faint)' }}>
          Credentials are encrypted and stored locally. They are only used to automate report downloads.
        </p>
      )}
    </div>
  );
}
