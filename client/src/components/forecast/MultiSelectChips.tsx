import { useEffect, useRef, useState } from 'react';
import { Search, X, Check, ChevronDown } from 'lucide-react';

interface Option {
  /** Stable key — used for selection state and equality. */
  value: string;
  /** Visible text on the chip + in the dropdown. */
  label: string;
  /** Optional secondary text shown grey under the label in the dropdown. */
  hint?: string;
  /** When true, the option is greyed out and tagged "missing" — used for
   *  selected items that no longer exist in the available set (e.g. Tally
   *  ledger renamed since the mapping was saved). */
  missing?: boolean;
}

interface Props {
  options: Option[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Disables the input — used while options are loading or disabled by parent. */
  disabled?: boolean;
  loading?: boolean;
  /** Optional max height (px) for the dropdown — default 280. */
  maxHeight?: number;
  /** Optional empty-state text shown when the dropdown is open but options is empty. */
  emptyText?: string;
}

/**
 * Reusable multi-select chip input — popover dropdown with type-ahead search,
 * keyboard navigation, and chip-style display of the picked items. Stays
 * styled to match the rest of the forecast module (uses the .input class
 * tokens and the global theme variables, no Tailwind colors hardcoded).
 */
export default function MultiSelectChips({
  options, selected, onChange, placeholder = 'Pick items…',
  disabled = false, loading = false, maxHeight = 280, emptyText = 'No options',
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Build the visible option list — selected items first (so they're easy to
  // un-pick), then the rest filtered by search query.
  const q = search.trim().toLowerCase();
  const filtered = q
    ? options.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
    : options;

  const selectedSet = new Set(selected);
  const knownSelected = options.filter(o => selectedSet.has(o.value));
  // Missing chips — selected values that aren't in the current options. This
  // happens when a ledger was synced under one name and renamed in Tally
  // since. We still show them so the user knows about the gap.
  const knownValues = new Set(options.map(o => o.value));
  const missingSelected: Option[] = selected
    .filter(v => !knownValues.has(v))
    .map(v => ({ value: v, label: v, missing: true }));

  const allChips: Option[] = [...knownSelected, ...missingSelected];

  const toggle = (val: string) => {
    if (selectedSet.has(val)) onChange(selected.filter(v => v !== val));
    else onChange([...selected, val]);
  };

  const removeChip = (val: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selected.filter(v => v !== val));
  };

  return (
    <div className="relative" ref={wrapRef}>
      {/* Trigger — the chip strip plus a small ChevronDown */}
      <div
        className={`min-h-[34px] w-full px-2 py-1 rounded border cursor-text transition-colors flex items-center flex-wrap gap-1 ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        }`}
        style={{
          background: 'var(--mt-bg-raised)',
          borderColor: open ? 'var(--mt-accent-border)' : 'var(--mt-border)',
        }}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        {allChips.length === 0 && (
          <span className="text-[11px] px-1" style={{ color: 'var(--mt-text-faint)' }}>
            {placeholder}
          </span>
        )}
        {allChips.map(opt => (
          <span
            key={opt.value}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded"
            style={{
              background: opt.missing ? 'var(--mt-warn-soft)' : 'var(--mt-accent-soft)',
              color: opt.missing ? 'var(--mt-warn-text)' : 'var(--mt-accent-text)',
              border: `1px solid ${opt.missing ? 'var(--mt-warn-border)' : 'var(--mt-accent-border)'}`,
            }}
            title={opt.missing ? 'Not currently in any synced company' : undefined}
          >
            {opt.label}
            {!disabled && (
              <button
                type="button"
                className="hover:opacity-70"
                onClick={(e) => removeChip(opt.value, e)}
                aria-label={`Remove ${opt.label}`}
              >
                <X size={10} />
              </button>
            )}
          </span>
        ))}
        <span className="ml-auto" style={{ color: 'var(--mt-text-faint)' }}>
          <ChevronDown size={14} />
        </span>
      </div>

      {/* Dropdown */}
      {open && !disabled && (
        <div
          className="absolute z-50 mt-1 w-full rounded shadow-lg overflow-hidden"
          style={{
            background: 'var(--mt-bg-raised)',
            border: '1px solid var(--mt-border)',
            boxShadow: 'var(--mt-shadow-card)',
          }}
        >
          {/* Search */}
          <div
            className="flex items-center gap-2 px-2 py-1.5"
            style={{ borderBottom: '1px solid var(--mt-border)' }}
          >
            <Search size={12} style={{ color: 'var(--mt-text-faint)' }} />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-transparent text-xs outline-none"
              style={{ color: 'var(--mt-text-primary)' }}
            />
            {selected.length > 0 && (
              <button
                type="button"
                className="text-[10px] hover:underline"
                style={{ color: 'var(--mt-text-faint)' }}
                onClick={() => onChange([])}
              >
                Clear all
              </button>
            )}
          </div>

          {/* Option list */}
          <div style={{ maxHeight, overflowY: 'auto' }}>
            {loading ? (
              <div className="text-[11px] px-3 py-3 text-center" style={{ color: 'var(--mt-text-faint)' }}>
                Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-[11px] px-3 py-3 text-center" style={{ color: 'var(--mt-text-faint)' }}>
                {q ? `No matches for "${search.trim()}"` : emptyText}
              </div>
            ) : (
              filtered.map(opt => {
                const isSelected = selectedSet.has(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors"
                    style={{
                      background: isSelected ? 'var(--mt-accent-soft)' : 'transparent',
                      color: 'var(--mt-text-primary)',
                    }}
                    onClick={() => toggle(opt.value)}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'var(--mt-bg-muted)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-sm border flex-shrink-0 flex items-center justify-center"
                      style={{
                        borderColor: isSelected ? 'var(--mt-accent)' : 'var(--mt-border-strong)',
                        background: isSelected ? 'var(--mt-accent)' : 'transparent',
                      }}
                    >
                      {isSelected && <Check size={10} style={{ color: 'white' }} />}
                    </span>
                    <span className="flex-1 truncate">{opt.label}</span>
                    {opt.hint && (
                      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--mt-text-faint)' }}>
                        {opt.hint}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Footer count */}
          <div
            className="px-2.5 py-1.5 text-[10px]"
            style={{
              borderTop: '1px solid var(--mt-border)',
              color: 'var(--mt-text-faint)',
            }}
          >
            {selected.length} selected
            {options.length > 0 && ` · ${filtered.length} of ${options.length} shown`}
          </div>
        </div>
      )}
    </div>
  );
}
