import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { Mail, Plus, Trash2, Send, Eye } from 'lucide-react';

// Settings card that lets admins (and super_admins) manage who receives the
// 8 AM Daily Brief email. branch_id is the platform branches.id; NULL means
// the recipient gets the consolidated brief.
//
// The card stays hidden until the parent page determines the user is an
// admin — server-side enforcement on POST/PUT/DELETE is the actual gate.

interface Recipient {
  id: number;
  branch_id: number | null;
  email: string;
  name: string | null;
  is_active: number;
  created_at: string;
}

interface Branch {
  id: number;
  name: string;
}

const ALL_BRANCHES_KEY = '__all__';

export default function DailyBriefRecipients() {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ email: '', name: '', branch: ALL_BRANCHES_KEY });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const [r, b] = await Promise.all([
        api.get('/daily-brief/recipients'),
        api.get('/daily-brief/branches'),
      ]);
      setRecipients(r.data || []);
      setBranches(b.data || []);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to load recipients');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const addRecipient = async () => {
    setError(null);
    const email = draft.email.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('That doesn’t look like a valid email');
      return;
    }
    setSaving(true);
    try {
      const branchId = draft.branch === ALL_BRANCHES_KEY ? null : Number(draft.branch);
      await api.post('/daily-brief/recipients', {
        email,
        name: draft.name.trim() || undefined,
        branch_id: branchId,
      });
      setDraft({ email: '', name: '', branch: draft.branch });
      reload();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Couldn’t add recipient');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (r: Recipient) => {
    await api.put(`/daily-brief/recipients/${r.id}`, { is_active: !r.is_active });
    reload();
  };

  const remove = async (r: Recipient) => {
    if (!confirm(`Remove ${r.email} from the Daily Brief?`)) return;
    await api.delete(`/daily-brief/recipients/${r.id}`);
    reload();
  };

  const branchLabel = (id: number | null) =>
    id == null ? 'All branches' : branches.find(b => b.id === id)?.name || `Branch #${id}`;

  // Group recipients by branch (NULL first) so the list reads top-down by
  // scope. Each group renders a small heading; empty groups are skipped.
  const groups = useMemo(() => {
    const map = new Map<string, Recipient[]>();
    for (const r of recipients) {
      const key = r.branch_id == null ? 'null' : String(r.branch_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    const order: { key: string; label: string; rows: Recipient[] }[] = [];
    if (map.has('null')) order.push({ key: 'null', label: 'All branches', rows: map.get('null')! });
    for (const b of branches) {
      const key = String(b.id);
      if (map.has(key)) order.push({ key, label: b.name, rows: map.get(key)! });
    }
    return order;
  }, [recipients, branches]);

  const showBranchPicker = branches.length > 0;

  return (
    <div className="mt-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Mail size={18} style={{ color: 'var(--mt-accent-text)' }} />
        <h2 className="mt-heading text-lg">Daily Brief Recipients</h2>
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--mt-text-faint)' }}>
        Admins manage who receives the 8 AM morning report by email. Add as many addresses as you like — each can be subscribed to a specific branch or to the consolidated view.
      </p>

      {/* Add new */}
      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div className="flex-1 min-w-[180px]">
          <label className="block text-[10px] mb-1 uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>Email</label>
          <input
            type="email"
            value={draft.email}
            onChange={e => setDraft(d => ({ ...d, email: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter' && !saving) addRecipient(); }}
            placeholder="alice@indefine.in"
            className="mt-input text-sm w-full"
            style={{ padding: '8px 10px' }}
          />
        </div>
        <div className="flex-1 min-w-[140px]">
          <label className="block text-[10px] mb-1 uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>Name (optional)</label>
          <input
            type="text"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter' && !saving) addRecipient(); }}
            placeholder="Alice Iyer"
            className="mt-input text-sm w-full"
            style={{ padding: '8px 10px' }}
          />
        </div>
        {showBranchPicker && (
          <div className="min-w-[160px]">
            <label className="block text-[10px] mb-1 uppercase tracking-wider" style={{ color: 'var(--mt-text-faint)' }}>Branch</label>
            <select
              value={draft.branch}
              onChange={e => setDraft(d => ({ ...d, branch: e.target.value }))}
              className="mt-input text-sm w-full"
              style={{ padding: '8px 10px' }}
            >
              <option value={ALL_BRANCHES_KEY}>All branches (consolidated)</option>
              {branches.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}
        <button
          onClick={addRecipient}
          disabled={saving || !draft.email.trim()}
          className="mt-btn-soft text-sm flex items-center gap-1.5"
          style={{ padding: '8px 12px' }}
        >
          <Plus size={14} /> Add recipient
        </button>
      </div>

      {error && (
        <div className="text-xs mb-3 px-3 py-2 rounded" style={{ background: 'var(--mt-danger-soft)', color: 'var(--mt-danger-text)', border: '1px solid var(--mt-danger-border)' }}>
          {error}
        </div>
      )}

      {/* Preview link */}
      <div className="flex items-center gap-2 mb-4 flex-wrap text-xs" style={{ color: 'var(--mt-text-muted)' }}>
        <span>See what the 8 AM email looks like:</span>
        <a
          href="/api/daily-brief/preview"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline"
          style={{ color: 'var(--mt-accent-text)' }}
        >
          <Eye size={12} /> HTML preview
        </a>
        <span style={{ color: 'var(--mt-text-faint)' }}>·</span>
        <a
          href="/api/daily-brief/preview.pdf"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline"
          style={{ color: 'var(--mt-accent-text)' }}
        >
          <Send size={12} /> PDF
        </a>
      </div>

      {/* List */}
      {loading ? (
        <div className="text-xs py-6 text-center" style={{ color: 'var(--mt-text-faint)' }}>Loading recipients…</div>
      ) : recipients.length === 0 ? (
        <div className="text-sm py-8 text-center rounded" style={{ background: 'var(--mt-bg-muted)', color: 'var(--mt-text-muted)' }}>
          No recipients yet. Add the first email above and they’ll start receiving the brief tomorrow morning.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(g => (
            <div key={g.key}>
              <div className="text-[11px] uppercase tracking-wider mb-1.5 flex items-center gap-2" style={{ color: 'var(--mt-text-faint)' }}>
                <span>{g.label}</span>
                <span style={{ color: 'var(--mt-text-faint)' }}>· {g.rows.length} {g.rows.length === 1 ? 'recipient' : 'recipients'}</span>
              </div>
              <div className="rounded overflow-hidden" style={{ border: '1px solid var(--mt-border)' }}>
                {g.rows.map((r, idx) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 px-3 py-2"
                    style={{
                      borderTop: idx > 0 ? '1px solid var(--mt-border)' : 'none',
                      background: r.is_active ? 'transparent' : 'var(--mt-bg-muted)',
                      opacity: r.is_active ? 1 : 0.6,
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: 'var(--mt-text-heading)' }}>
                        {r.name ? `${r.name} · ${r.email}` : r.email}
                      </div>
                      <div className="text-[10px] mt-0.5" style={{ color: 'var(--mt-text-faint)' }}>
                        Added {new Date(r.created_at).toLocaleDateString()} · {branchLabel(r.branch_id)}
                      </div>
                    </div>
                    <button
                      onClick={() => toggle(r)}
                      className="text-[11px] px-2 py-1 rounded"
                      style={{
                        background: r.is_active ? 'var(--mt-accent-soft)' : 'var(--mt-bg-muted)',
                        color: r.is_active ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)',
                        border: '1px solid var(--mt-border)',
                      }}
                      title={r.is_active ? 'Pause sending to this recipient' : 'Resume sending'}
                    >
                      {r.is_active ? 'Active' : 'Paused'}
                    </button>
                    <button
                      onClick={() => remove(r)}
                      className="p-1 transition-colors"
                      style={{ color: 'var(--mt-text-faint)' }}
                      onMouseEnter={e => { e.currentTarget.style.color = 'var(--mt-danger-text)'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = 'var(--mt-text-faint)'; }}
                      title="Remove recipient"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
