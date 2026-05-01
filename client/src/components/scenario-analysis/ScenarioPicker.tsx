import { Scenario } from '../../pages/ForecastModulePage';

interface Props {
  scenarios: Scenario[];
  selected: number[];
  baseId: number | null;
  onChange: (selected: number[], baseId: number | null) => void;
  maxSelected?: number; // default 4
  requireBase?: boolean;
}

/** Multi-select pill row + a "base" radio that sits on the chosen scenario.
 *  Drives URL state in CompareView / ReportView. */
export default function ScenarioPicker({
  scenarios, selected, baseId, onChange, maxSelected = 4, requireBase = true,
}: Props) {
  const toggle = (id: number) => {
    if (selected.includes(id)) {
      const next = selected.filter(s => s !== id);
      const nextBase = baseId === id ? (next[0] ?? null) : baseId;
      onChange(next, nextBase);
    } else {
      if (selected.length >= maxSelected) {
        alert(`At most ${maxSelected} scenarios can be compared at once.`);
        return;
      }
      const next = [...selected, id];
      const nextBase = requireBase && baseId == null ? id : baseId;
      onChange(next, nextBase);
    }
  };

  const setBase = (id: number) => {
    if (!selected.includes(id)) return;
    onChange(selected, id);
  };

  if (scenarios.length === 0) {
    return (
      <div style={{ color: 'var(--mt-text-muted)', fontSize: 13 }}>
        No scenarios available. Create some in the Manage tab.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div style={{ fontSize: 12, color: 'var(--mt-text-muted)' }}>
        Pick the scenarios to compare (up to {maxSelected}). The radio marks the <strong>base</strong> — variance is calculated against it.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {scenarios.map(s => {
          const on = selected.includes(s.id);
          const isBase = baseId === s.id;
          return (
            <div
              key={s.id}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full"
              style={{
                background: on ? 'var(--mt-accent-soft)' : 'var(--mt-bg-surface)',
                border: `1px solid ${on ? 'var(--mt-accent)' : 'var(--mt-border)'}`,
                color: on ? 'var(--mt-accent-text)' : 'var(--mt-text-muted)',
                fontSize: 12,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(s.id)}
                style={{ cursor: 'pointer' }}
              />
              <span style={{ fontWeight: 500 }} onClick={() => toggle(s.id)}>
                {s.name}{s.is_default ? ' (default)' : ''}
              </span>
              {requireBase && on && (
                <label
                  className="flex items-center gap-1 ml-1 pl-2"
                  style={{ borderLeft: '1px solid var(--mt-border)', cursor: 'pointer' }}
                  title="Mark as base scenario for variance"
                >
                  <input
                    type="radio"
                    name="scenario-base"
                    checked={isBase}
                    onChange={() => setBase(s.id)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 11 }}>base</span>
                </label>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
