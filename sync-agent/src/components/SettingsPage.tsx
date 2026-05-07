import { useEffect, useRef, useState } from 'react';
import type { AgentConfig } from '../../lib/types';

interface Props {
  config: AgentConfig;
  onSave: (patch: Partial<AgentConfig>) => Promise<void>;
}

type ScheduleMode = 'off' | 'interval' | 'daily';
type PresetKey = 'current' | 'custom' | `fy-${number}`;

function currentFyStartYear(): number {
  const now = new Date();
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

function inferPreset(fromDate?: string, toDate?: string): PresetKey {
  const yr = currentFyStartYear();
  const currentFyFrom = `${yr}-04-01`;
  if (!toDate) return !fromDate || fromDate === currentFyFrom ? 'current' : 'custom';
  const fm = /^(\d{4})-04-01$/.exec(fromDate || '');
  const tm = /^(\d{4})-03-31$/.exec(toDate);
  if (fm && tm && Number(tm[1]) === Number(fm[1]) + 1) return `fy-${Number(fm[1])}` as PresetKey;
  return 'custom';
}

function fyLabel(year: number): string {
  return `FY ${String(year).slice(2)}-${String(year + 1).slice(2)}`;
}

function inferMode(c: AgentConfig): ScheduleMode {
  if (c.autoSyncMode) return c.autoSyncMode;
  return c.autoSyncEnabled ? 'interval' : 'off';
}

/**
 * Settings page — Connection, Auto-sync schedule (off / interval / daily-at-time),
 * Sync period, and Preferences. The "Daily at HH:MM" mode is new in 0.4.0.
 */
export default function SettingsPage({ config, onSave }: Props) {
  const [form, setForm] = useState<AgentConfig>(config);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const committedRef = useRef<AgentConfig>(config);

  // Re-sync form from config UNLESS the user is mid-edit. The "dirty" check
  // compares only the fields we let the user touch.
  useEffect(() => {
    if (saving) return;
    const cur = committedRef.current;
    const dirty = (
      form.tallyHost !== cur.tallyHost
      || form.tallyPort !== cur.tallyPort
      || form.serverUrl !== cur.serverUrl
      || form.syncIntervalMinutes !== cur.syncIntervalMinutes
      || (form.autoSyncMode || (form.autoSyncEnabled ? 'interval' : 'off'))
         !== (cur.autoSyncMode || (cur.autoSyncEnabled ? 'interval' : 'off'))
      || (form.dailyAtHHMM || '21:00') !== (cur.dailyAtHHMM || '21:00')
      || (form.autoStartOnLogin ?? false) !== (cur.autoStartOnLogin ?? false)
      || (form.notificationsEnabled !== false) !== (cur.notificationsEnabled !== false)
      || (form.syncFromDate || '') !== (cur.syncFromDate || '')
      || (form.syncToDate || '') !== (cur.syncToDate || '')
    );
    if (dirty) return;
    setForm(config);
    committedRef.current = config;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, saving]);

  const update = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      // Mode is the source of truth; keep autoSyncEnabled in sync for legacy.
      const mode = inferMode(form);
      await onSave({
        tallyHost: form.tallyHost,
        tallyPort: form.tallyPort,
        serverUrl: form.serverUrl,
        syncIntervalMinutes: form.syncIntervalMinutes,
        autoSyncMode: mode,
        autoSyncEnabled: mode !== 'off',
        dailyAtHHMM: form.dailyAtHHMM || '21:00',
        autoStartOnLogin: form.autoStartOnLogin,
        notificationsEnabled: form.notificationsEnabled,
        syncFromDate: form.syncFromDate,
        syncToDate: form.syncToDate,
      });
      committedRef.current = form;
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const mode = inferMode(form);
  const setMode = (next: ScheduleMode) => setForm((f) => ({
    ...f,
    autoSyncMode: next,
    autoSyncEnabled: next !== 'off',
  }));

  const periodPreset = inferPreset(form.syncFromDate, form.syncToDate);
  const fyStart = currentFyStartYear();
  const fyOptions = [fyStart, fyStart - 1, fyStart - 2];

  const applyPeriodPreset = (next: PresetKey) => {
    if (next === 'custom') {
      setForm((f) => ({
        ...f,
        syncFromDate: f.syncFromDate || `${fyStart}-04-01`,
        syncToDate: f.syncToDate || new Date().toISOString().slice(0, 10),
      }));
      return;
    }
    if (next === 'current') {
      setForm((f) => ({ ...f, syncFromDate: `${fyStart}-04-01`, syncToDate: undefined }));
      return;
    }
    const yr = Number(next.slice(3));
    setForm((f) => ({ ...f, syncFromDate: `${yr}-04-01`, syncToDate: `${yr + 1}-03-31` }));
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-subtitle">Connection, schedule &amp; preferences</div>
        </div>
      </div>

      <div className="page-content">

        <div className="settings-section">
          <div className="settings-section-title">Connection</div>
          <div className="card">
            <div className="settings-row">
              <div>
                <div className="settings-label">Tally host</div>
                <div className="settings-hint">Where Tally is reachable</div>
              </div>
              <input className="settings-input" value={form.tallyHost} onChange={(e) => update('tallyHost', e.target.value)} placeholder="localhost" />
            </div>
            <div className="settings-row">
              <div><div className="settings-label">Tally port</div></div>
              <input className="settings-input" type="number" value={form.tallyPort} onChange={(e) => update('tallyPort', Number(e.target.value))} placeholder="9000" />
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-label">Cloud server URL</div>
                <div className="settings-hint">The Vision dashboard you sync to</div>
              </div>
              <input className="settings-input" value={form.serverUrl} onChange={(e) => update('serverUrl', e.target.value)} placeholder="https://vision.indefine.in" />
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Auto-sync schedule</div>
          <div className="card">
            <div className="schedule-options">

              <button type="button" className={`schedule-option ${mode === 'off' ? 'selected' : ''}`} onClick={() => setMode('off')}>
                <div className="radio-dot" />
                <div className="schedule-detail">
                  <div className="schedule-name">Off</div>
                  <div className="schedule-info">Sync only when you click "Sync Now"</div>
                </div>
              </button>

              <div className={`schedule-option ${mode === 'interval' ? 'selected' : ''}`} onClick={() => setMode('interval')}>
                <div className="radio-dot" />
                <div className="schedule-detail">
                  <div className="schedule-name">Every few minutes</div>
                  <div className="schedule-info">Live updates during business hours</div>
                </div>
                <select
                  className="schedule-control"
                  value={form.syncIntervalMinutes}
                  onChange={(e) => { setMode('interval'); update('syncIntervalMinutes', Number(e.target.value)); }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value={5}>5 min</option>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={60}>1 hour</option>
                </select>
              </div>

              <div className={`schedule-option ${mode === 'daily' ? 'selected' : ''}`} onClick={() => setMode('daily')}>
                <div className="radio-dot" />
                <div className="schedule-detail">
                  <div className="schedule-name">Daily at <span className="new-tag">NEW</span></div>
                  <div className="schedule-info">Set &amp; forget — e.g. 9 PM after stores close</div>
                </div>
                <input
                  type="time"
                  className="schedule-control"
                  value={form.dailyAtHHMM || '21:00'}
                  onChange={(e) => { setMode('daily'); update('dailyAtHHMM', e.target.value); }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>

            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Sync period</div>
          <div className="card">
            <div className="settings-row">
              <div>
                <div className="settings-label">What to pull</div>
                <div className="settings-hint">
                  {form.syncFromDate || `${fyStart}-04-01`} → {form.syncToDate || 'today'}
                </div>
              </div>
              <select className="settings-input" value={periodPreset} onChange={(e) => applyPeriodPreset(e.target.value as PresetKey)}>
                <option value="current">Current FY, to today</option>
                {fyOptions.map((yr) => (
                  <option key={yr} value={`fy-${yr}`}>{fyLabel(yr)}{yr === fyStart ? ' (full year)' : ''}</option>
                ))}
                <option value="custom">Custom range…</option>
              </select>
            </div>
            {periodPreset === 'custom' && (
              <>
                <div className="settings-row">
                  <div className="settings-label">From</div>
                  <input className="settings-input" type="date" value={form.syncFromDate || ''} onChange={(e) => update('syncFromDate', e.target.value)} />
                </div>
                <div className="settings-row">
                  <div className="settings-label">To</div>
                  <input className="settings-input" type="date" value={form.syncToDate || ''} onChange={(e) => update('syncToDate', e.target.value)} />
                </div>
              </>
            )}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Preferences</div>
          <div className="card">
            <div className="settings-row">
              <div>
                <div className="settings-label">Launch at login</div>
                <div className="settings-hint">Start silently in the tray when Windows boots</div>
              </div>
              <button
                type="button"
                className={`toggle ${form.autoStartOnLogin ? 'on' : ''}`}
                onClick={() => update('autoStartOnLogin', !form.autoStartOnLogin)}
                aria-label="Launch at login"
              />
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-label">Desktop notifications</div>
                <div className="settings-hint">On sync failure &amp; recovery</div>
              </div>
              <button
                type="button"
                className={`toggle ${form.notificationsEnabled !== false ? 'on' : ''}`}
                onClick={() => update('notificationsEnabled', !(form.notificationsEnabled !== false))}
                aria-label="Notifications"
              />
            </div>
          </div>
        </div>

        <div className="save-bar">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : (savedAt && Date.now() - savedAt < 2500 ? 'Saved ✓' : 'Save changes')}
          </button>
        </div>
      </div>
    </>
  );
}
