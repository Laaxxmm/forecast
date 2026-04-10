import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MoreVertical, ExternalLink, StickyNote, Trash2, Copy,
  ArrowRightLeft, GitMerge, ChevronRight, X
} from 'lucide-react';
import api from '../../api/client';
import { ForecastItem } from '../../pages/ForecastModulePage';

const MOVE_TARGETS: Record<string, string> = {
  revenue: 'Revenue',
  direct_costs: 'Direct Costs',
  personnel: 'Personnel',
  expenses: 'Expenses',
  assets: 'Assets',
};

const DEFAULT_TYPES: Record<string, string> = {
  revenue: 'revenue_only',
  direct_costs: 'general_cost',
  personnel: 'individual',
  expenses: 'other',
  assets: 'long_term',
};

interface Props {
  item: ForecastItem;
  items: ForecastItem[];
  category: string;
  allValues: Record<number, Record<string, number>>;
  onEdit: () => void;
  onDuplicate: () => void;
  onReload: () => Promise<void>;
}

export default function ItemRowMenu({ item, items, category, allValues, onEdit, onDuplicate, onReload }: Props) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.right - 200 });
    setOpen(true);
    setShowMoveSubmenu(false);
  };

  const closeMenu = () => { setOpen(false); setShowMoveSubmenu(false); };

  const handleDelete = async () => {
    closeMenu();
    if (!confirm('Delete this item?')) return;
    await api.delete(`/forecast-module/items/${item.id}`);
    await onReload();
  };

  const handleMove = async (targetCategory: string) => {
    await api.put(`/forecast-module/items/${item.id}`, {
      category: targetCategory,
      item_type: DEFAULT_TYPES[targetCategory] || item.item_type,
    });
    await onReload();
    closeMenu();
  };

  const handleNoteSave = async () => {
    const meta = { ...item.meta, note: noteText.trim() || undefined };
    await api.put(`/forecast-module/items/${item.id}`, { meta });
    setNoteOpen(false);
    await onReload();
  };

  const handleMerge = async () => {
    if (!mergeTarget) return;
    const sourceVals = allValues[item.id] || {};
    const targetVals = allValues[mergeTarget] || {};
    const merged: Record<string, number> = { ...targetVals };
    for (const [month, amount] of Object.entries(sourceVals)) {
      merged[month] = (merged[month] || 0) + amount;
    }
    if (Object.keys(merged).length > 0) {
      await api.post('/forecast-module/values', {
        item_id: mergeTarget,
        values: Object.entries(merged).map(([month, amount]) => ({ month, amount })),
      });
    }
    await api.delete(`/forecast-module/items/${item.id}`);
    setMergeOpen(false);
    await onReload();
  };

  const otherItems = items.filter(i => i.id !== item.id);
  const moveCategories = Object.entries(MOVE_TARGETS).filter(([k]) => k !== category);

  return (
    <>
      <button onClick={handleOpen} className="opacity-0 group-hover:opacity-100 p-1 hover:bg-dark-400 rounded">
        <MoreVertical size={14} />
      </button>

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[49]" onClick={closeMenu} onKeyDown={e => { if (e.key === 'Escape') closeMenu(); }} />
          <div
            className="fixed bg-dark-700 border border-dark-400/50 rounded-lg shadow-xl z-50 w-48 py-1"
            style={{ top: menuPos.top, left: menuPos.left }}
            onKeyDown={e => { if (e.key === 'Escape') closeMenu(); }}
          >
            <button
              onClick={() => { onEdit(); closeMenu(); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2.5 text-theme-secondary"
            >
              <ExternalLink size={14} /> Open editor
            </button>
            <button
              onClick={() => { setNoteText(item.meta?.note || ''); setNoteOpen(true); closeMenu(); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2.5 text-theme-secondary"
            >
              <StickyNote size={14} /> Add/edit note
            </button>
            <button
              onClick={handleDelete}
              className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2.5 text-red-400"
            >
              <Trash2 size={14} /> Delete
            </button>
            <button
              onClick={() => { onDuplicate(); closeMenu(); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2.5 text-theme-secondary"
            >
              <Copy size={14} /> Duplicate
            </button>
            {moveCategories.length > 0 && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowMoveSubmenu(!showMoveSubmenu); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2.5 text-theme-secondary"
                >
                  <ArrowRightLeft size={14} /> Move <ChevronRight size={12} className="ml-auto text-theme-faint" />
                </button>
                {showMoveSubmenu && (
                  <div className="absolute left-full top-0 ml-1 bg-dark-700 border border-dark-400/50 rounded-lg shadow-xl w-40 py-1 z-[51]">
                    {moveCategories.map(([k, v]) => (
                      <button key={k} onClick={() => handleMove(k)} className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 text-theme-secondary">
                        {v}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {otherItems.length > 0 && (
              <button
                onClick={() => { setMergeTarget(null); setMergeOpen(true); closeMenu(); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-dark-600 flex items-center gap-2.5 text-theme-secondary"
              >
                <GitMerge size={14} /> Merge with...
              </button>
            )}
          </div>
        </>,
        document.body
      )}

      {/* Note Dialog */}
      {noteOpen && createPortal(
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={() => setNoteOpen(false)}>
          <div className="bg-dark-700 border border-dark-400/50 rounded-xl p-5 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-theme-heading">Note for &ldquo;{item.name}&rdquo;</h3>
              <button onClick={() => setNoteOpen(false)} className="text-theme-faint hover:text-theme-secondary"><X size={16} /></button>
            </div>
            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              className="input w-full h-28 resize-none text-sm"
              placeholder="Add a note..."
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setNoteOpen(false)} className="px-3 py-1.5 text-sm text-theme-faint hover:text-theme-secondary rounded-lg">Cancel</button>
              <button onClick={handleNoteSave} className="btn-primary text-sm px-4 py-1.5">Save Note</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Merge Dialog */}
      {mergeOpen && createPortal(
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={() => setMergeOpen(false)}>
          <div className="bg-dark-700 border border-dark-400/50 rounded-xl p-5 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-theme-heading">Merge &ldquo;{item.name}&rdquo; with...</h3>
              <button onClick={() => setMergeOpen(false)} className="text-theme-faint hover:text-theme-secondary"><X size={16} /></button>
            </div>
            <p className="text-xs text-theme-faint mb-3">Values will be combined into the target item. &ldquo;{item.name}&rdquo; will be deleted.</p>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {otherItems.map(t => (
                <label
                  key={t.id}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                    mergeTarget === t.id ? 'bg-accent-500/15 border border-accent-500/30' : 'hover:bg-dark-600 border border-transparent'
                  }`}
                >
                  <input type="radio" name="mergeTarget" checked={mergeTarget === t.id} onChange={() => setMergeTarget(t.id)} className="accent-accent-500" />
                  <span className={mergeTarget === t.id ? 'text-accent-400 font-medium' : 'text-theme-secondary'}>{t.name}</span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setMergeOpen(false)} className="px-3 py-1.5 text-sm text-theme-faint hover:text-theme-secondary rounded-lg">Cancel</button>
              <button onClick={handleMerge} disabled={!mergeTarget} className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50">Merge</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
