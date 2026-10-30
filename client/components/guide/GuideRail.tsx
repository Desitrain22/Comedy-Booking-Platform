/**
 * The setup guide's progress rail across the top of the booker app while the guide runs:
 * `Club ✓ — Shows · 2 of 3 — Comedians`, plus Hide (minimize). Sticky, so BookerLayout offsets
 * its sticky sidebar / phone header by `GUIDE_RAIL_HEIGHT` while it shows.
 */
import { Check, Compass } from 'lucide-react';
import { Fragment } from 'react';
import { cn } from '../../lib/cn';
import { useGuide } from './GuideProvider';
import { railSteps } from './script';

/** px; keep in sync with the rail's `h-11`. */
export const GUIDE_RAIL_HEIGHT = 44;

/** The rail shows while the setup guide (not the tour) is open and not minimized. */
export function useGuideRailVisible(): boolean {
  const guide = useGuide();
  return Boolean(guide?.open && !guide.minimized && guide.data && guide.mark && !guide.mark.id.startsWith('tour-'));
}

export function GuideRail() {
  const guide = useGuide();
  const visible = useGuideRailVisible();
  if (!visible || !guide?.data) return null;
  const steps = railSteps(guide.data);

  return (
    <div
      role="region"
      aria-label="Setup guide progress"
      data-guide-chrome=""
      className="sticky top-0 z-30 h-11 shrink-0 border-b border-border bg-surface"
    >
      <div className="flex h-full items-center gap-3 px-3 md:px-4">
        <span className="hidden items-center gap-1.5 text-xs font-semibold text-fg sm:flex">
          <Compass className="size-4 text-accent" aria-hidden />
          Setup guide
        </span>
        <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
        <ol className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
          {steps.map((step, i) => (
            <Fragment key={step.key}>
              {i > 0 && (
                <li aria-hidden className={cn('h-px w-4 shrink md:w-10', step.status === 'todo' ? 'bg-border' : 'bg-accent/50')} />
              )}
              <li
                aria-current={step.status === 'current' ? 'step' : undefined}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap',
                  step.status === 'current' ? 'font-semibold text-fg' : 'text-fg-muted',
                )}
              >
                <span
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
                    step.status === 'done' && 'bg-confirmed text-white',
                    step.status === 'current' && 'bg-accent-solid text-accent-solid-fg',
                    step.status === 'todo' && 'border border-border-strong text-fg-subtle',
                  )}
                >
                  {step.status === 'done' ? <Check className="size-3" strokeWidth={3} aria-hidden /> : i + 1}
                </span>
                <span className={cn(step.status !== 'current' && 'max-sm:sr-only')}>{step.label}</span>
                {step.status === 'done' && <span className="sr-only">(done)</span>}
                {step.detail && (
                  <span className={cn('font-normal text-fg-muted tabular-nums', step.status !== 'current' && 'max-sm:sr-only')}>
                    · {step.detail}
                  </span>
                )}
              </li>
            </Fragment>
          ))}
        </ol>
        <button
          type="button"
          onClick={guide.minimize}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          Hide
        </button>
      </div>
    </div>
  );
}
