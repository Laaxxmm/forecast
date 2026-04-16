import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { X, ChevronRight, ChevronLeft } from 'lucide-react';
import type { TourStep } from '../config/tourSteps';

/* ─── Context ────────────────────────────────────────────────── */

interface TourContextValue {
  startTour: (steps: TourStep[]) => void;
  endTour: () => void;
  isActive: boolean;
  markPageSeen: (pageKey: string) => void;
  hasPageSeen: (pageKey: string) => boolean;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used within TourProvider');
  return ctx;
}

/* ─── Provider ───────────────────────────────────────────────── */

export function TourProvider({ children }: { children: ReactNode }) {
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [isActive, setIsActive] = useState(false);

  const startTour = useCallback((tourSteps: TourStep[]) => {
    // Small delay to let DOM render data-tour targets
    setTimeout(() => {
      const validSteps = tourSteps.filter(
        s => document.querySelector(`[data-tour="${s.target}"]`)
      );
      if (validSteps.length === 0) return;
      setSteps(validSteps);
      setCurrentStep(0);
      setIsActive(true);
    }, 400);
  }, []);

  const endTour = useCallback(() => {
    setIsActive(false);
    setSteps([]);
    setCurrentStep(0);
  }, []);

  const markPageSeen = useCallback((pageKey: string) => {
    localStorage.setItem(`tour_seen_${pageKey}`, '1');
  }, []);

  const hasPageSeen = useCallback((pageKey: string) => {
    return localStorage.getItem(`tour_seen_${pageKey}`) === '1';
  }, []);

  const next = useCallback(() => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      endTour();
    }
  }, [currentStep, steps.length, endTour]);

  const prev = useCallback(() => {
    if (currentStep > 0) setCurrentStep(prev => prev - 1);
  }, [currentStep]);

  return (
    <TourContext.Provider value={{ startTour, endTour, isActive, markPageSeen, hasPageSeen }}>
      {children}
      {isActive && steps.length > 0 && (
        <TourOverlay
          step={steps[currentStep]}
          stepIndex={currentStep}
          totalSteps={steps.length}
          onNext={next}
          onPrev={prev}
          onSkip={endTour}
        />
      )}
    </TourContext.Provider>
  );
}

/* ─── Overlay ────────────────────────────────────────────────── */

function TourOverlay({
  step,
  stepIndex,
  totalSteps,
  onNext,
  onPrev,
  onSkip,
}: {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, height: 0 });
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    const el = document.querySelector(`[data-tour="${step.target}"]`) as HTMLElement | null;
    if (!el) return;

    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    const update = () => {
      const rect = el.getBoundingClientRect();
      const pad = 6;
      const spotlight = {
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
      };
      setPos(spotlight);

      // Tooltip sizing
      const tw = 320;
      const gap = 14;
      let p = step.placement || 'auto';

      if (p === 'auto') {
        const below = window.innerHeight - rect.bottom;
        const above = rect.top;
        const right = window.innerWidth - rect.right;
        if (below >= 200) p = 'bottom';
        else if (above >= 200) p = 'top';
        else if (right >= tw + gap) p = 'right';
        else p = 'left';
      }

      const style: React.CSSProperties = { width: tw, position: 'absolute' as const };

      switch (p) {
        case 'bottom':
          style.top = rect.bottom + gap;
          style.left = Math.max(12, Math.min(rect.left + rect.width / 2 - tw / 2, window.innerWidth - tw - 12));
          break;
        case 'top':
          style.bottom = window.innerHeight - rect.top + gap;
          style.left = Math.max(12, Math.min(rect.left + rect.width / 2 - tw / 2, window.innerWidth - tw - 12));
          break;
        case 'right':
          style.top = Math.max(12, rect.top + rect.height / 2 - 80);
          style.left = rect.right + gap;
          break;
        case 'left':
          style.top = Math.max(12, rect.top + rect.height / 2 - 80);
          style.right = window.innerWidth - rect.left + gap;
          break;
      }

      setTooltipStyle(style);
      setReady(true);
    };

    const timer = setTimeout(update, 350);
    window.addEventListener('resize', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', update);
    };
  }, [step]);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSkip();
      if (e.key === 'ArrowRight' || e.key === 'Enter') onNext();
      if (e.key === 'ArrowLeft') onPrev();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onNext, onPrev, onSkip]);

  const isLast = stepIndex === totalSteps - 1;

  return (
    <div className="fixed inset-0 z-[9999]" style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.2s' }}>
      {/* Dark overlay with cutout */}
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(0, 0, 0, 0.65)',
          clipPath: `polygon(
            0% 0%, 0% 100%, ${pos.left}px 100%, ${pos.left}px ${pos.top}px,
            ${pos.left + pos.width}px ${pos.top}px, ${pos.left + pos.width}px ${pos.top + pos.height}px,
            ${pos.left}px ${pos.top + pos.height}px, ${pos.left}px 100%, 100% 100%, 100% 0%
          )`,
          transition: 'clip-path 0.3s ease',
        }}
        onClick={onSkip}
      />

      {/* Spotlight border glow */}
      <div
        className="absolute rounded-xl pointer-events-none"
        style={{
          top: pos.top,
          left: pos.left,
          width: pos.width,
          height: pos.height,
          border: '2px solid rgba(16, 185, 129, 0.7)',
          boxShadow: '0 0 0 4px rgba(16, 185, 129, 0.15), 0 0 20px rgba(16, 185, 129, 0.2)',
          transition: 'all 0.3s ease',
        }}
      />

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        className="bg-dark-700 border border-dark-400/50 rounded-2xl shadow-2xl"
        style={tooltipStyle}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-accent-500 flex items-center justify-center text-white text-[10px] font-bold">
              {stepIndex + 1}
            </div>
            <h3 className="text-sm font-semibold text-theme-heading">{step.title}</h3>
          </div>
          <button
            onClick={onSkip}
            className="p-1 rounded-lg text-theme-faint hover:text-theme-primary hover:bg-dark-600 transition-colors"
            title="Skip tour"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 pb-3">
          <p className="text-xs text-theme-secondary leading-relaxed">{step.content}</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 pb-4 pt-2 border-t border-dark-400/30 mt-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-theme-faint font-medium">
              {stepIndex + 1} / {totalSteps}
            </span>
            {!isLast && (
              <button
                onClick={onSkip}
                className="text-[10px] text-theme-faint hover:text-theme-muted transition-colors"
              >
                Skip tour
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {stepIndex > 0 && (
              <button
                onClick={onPrev}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-theme-muted hover:text-theme-primary rounded-lg hover:bg-dark-600 transition-colors"
              >
                <ChevronLeft size={12} />
                Back
              </button>
            )}
            <button
              onClick={onNext}
              className="flex items-center gap-1 px-3.5 py-1.5 text-xs font-medium text-white bg-accent-500 hover:bg-accent-600 rounded-lg transition-colors"
            >
              {isLast ? 'Got it!' : 'Next'}
              {!isLast && <ChevronRight size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
