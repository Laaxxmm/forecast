import { ReactNode, useState, useRef, useEffect } from 'react';

interface Props {
  trigger: ReactNode;
  content: ReactNode;
  /** Width of the popover panel (CSS value). Default 240px. */
  width?: string;
  /** Align panel start/end against the trigger. Default 'start'. */
  align?: 'start' | 'end';
}

/**
 * Tiny hover/focus popover. Used on the Net Cash Position KPI to expose
 * the per-account ledger breakdown without bloating the headline strip.
 * No external dependency — purely absolute-positioned, dismisses on
 * mouseleave/blur. Uses `mt-card` styling for consistency.
 */
export default function HoverPopover({ trigger, content, width = '240px', align = 'start' }: Props) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => () => cancelClose(), []);

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => { cancelClose(); setOpen(true); }}
      onMouseLeave={scheduleClose}
      onFocus={() => { cancelClose(); setOpen(true); }}
      onBlur={scheduleClose}
    >
      <span tabIndex={0} className="outline-none cursor-help">
        {trigger}
      </span>
      {open && (
        <span
          role="tooltip"
          className="absolute z-30 mt-2 p-3 rounded-lg pointer-events-auto"
          style={{
            top: '100%',
            [align === 'start' ? 'left' : 'right']: 0,
            width,
            background: 'var(--mt-bg-raised)',
            border: '1px solid var(--mt-border)',
            boxShadow: 'var(--mt-shadow-pop)',
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
