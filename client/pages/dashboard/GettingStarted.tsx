/**
 * A new club's dashboard: the "Getting started" card — the setup guide's home. It lists the
 * guide's three steps from `GET /api/onboarding` (Club, Shows with "2 of 3", Comedians: add
 * them, then ask for availability), each linking to the screen that does it, plus optional
 * extras for admins (connect email, invite another booker), and **Resume setup guide**. It
 * shows until the three steps are done. A club that's up and running but still has no email
 * set up gets the slimmer outbox banner instead (admins only).
 */
import { ArrowRight, Check, Compass, MailWarning, Rocket } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { OnboardingResponse } from '../../../shared/api/onboarding';
import { formatMonthName } from '../../../shared/time';
import { createShowsPath } from '../../components/guide';
import { Button, Card, buttonClasses } from '../../components/ui';
import { cn } from '../../lib/cn';
import { checklistItems, plural, type ChecklistItem } from './format';

interface ItemCopy {
  title: string;
  description: string;
  /** Where the item is done (a link), unless it opens something on the dashboard. */
  to?: string;
  action: string;
}

function itemCopy(item: ChecklistItem, onboarding: OnboardingResponse): ItemCopy {
  const month = formatMonthName(onboarding.suggestedMonth);
  switch (item.id) {
    case 'club':
      return item.done
        ? { title: 'Set up your club', description: '', action: '' }
        : {
            title: 'Add a location',
            description: 'The room or venue your shows happen in. Each gets its own color.',
            to: '/app/settings/locations',
            action: 'Add a location',
          };
    case 'shows':
      return {
        title: 'Put shows on the calendar',
        description: 'Start with at least 3. A month of regular shows is one tap per weekday.',
        to: createShowsPath(onboarding.suggestedMonth),
        action: 'Create shows',
      };
    case 'comedians':
      return onboarding.counts.comedians === 0
        ? {
            title: 'Add comedians and ask who’s free',
            description: 'Import your spreadsheet or add them one at a time, then ask which nights they can do.',
            to: '/app/comedians',
            action: 'Add comedians',
          }
        : {
            title: 'Add comedians and ask who’s free',
            description: `${plural(onboarding.counts.comedians, 'comedian')} on the roster. Now ask which nights they’re free in ${month}.`,
            action: 'Request availability',
          };
    case 'email':
      return {
        title: 'Connect email',
        description: 'Until then, sign-in links and requests wait in the outbox instead of being sent.',
        to: '/app/settings/email',
        action: 'Set up email',
      };
    case 'invite':
      return {
        title: 'Invite another booker',
        description: 'Bookers share the calendar, the roster and the lineups.',
        to: '/app/settings/bookers',
        action: 'Invite',
      };
  }
}

export interface GettingStartedProps {
  onboarding: OnboardingResponse;
  isAdmin: boolean;
  /** Open the availability request dialog (on the guide's month). */
  onRequestAvailability: () => void;
  /** Reopen the setup guide; null while it's showing (or for the welcome tour). */
  onResumeGuide: (() => void) | null;
}

export function GettingStarted({ onboarding, isAdmin, onRequestAvailability, onResumeGuide }: GettingStartedProps) {
  const items = checklistItems(onboarding, isAdmin);
  const steps = items.filter((i) => !i.optional);
  const extras = items.filter((i) => i.optional);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;

  function row(item: ChecklistItem, marker: ReactNode) {
    const copy = itemCopy(item, onboarding);
    const isNext = item.id === next;
    let action: ReactNode = null;
    if (!item.done) {
      const variant = isNext ? 'primary' : 'secondary';
      action = copy.to ? (
        <Link to={copy.to} className={buttonClasses({ variant, size: 'sm' })}>
          {copy.action} <ArrowRight aria-hidden />
        </Link>
      ) : (
        <Button size="sm" variant={variant} onClick={onRequestAvailability}>
          {copy.action}
        </Button>
      );
    }
    return (
      <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        {marker}
        <div className="min-w-0 flex-[1_1_16rem]">
          <p className={cn('text-sm font-medium', item.done ? 'text-fg-muted line-through decoration-fg-subtle' : 'text-fg')}>
            {copy.title}
            {item.progress && !item.done && (
              <span className="ml-2 rounded-full bg-surface-2 px-1.5 py-px text-xs font-medium text-fg-muted no-underline tabular-nums">
                {Math.min(item.progress.count, item.progress.target)} of {item.progress.target}
              </span>
            )}
          </p>
          {!item.done && <p className="text-xs text-fg-muted">{copy.description}</p>}
        </div>
        {action}
      </li>
    );
  }

  return (
    <Card className="overflow-hidden" data-testid="getting-started">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Rocket className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg">Getting started</h2>
          <p className="text-sm text-fg-muted">Three steps and your club is ready to book.</p>
        </div>
        <div className="flex items-center gap-2.5 text-xs font-medium text-fg-muted tabular-nums">
          {done} of {steps.length} done
          <div
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={done}
            className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3"
          >
            <div className="h-full rounded-full bg-accent-solid transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} />
          </div>
        </div>
        {onResumeGuide && (
          <Button size="sm" variant="secondary" onClick={onResumeGuide}>
            <Compass aria-hidden /> Resume setup guide
          </Button>
        )}
      </div>
      <ol className="divide-y divide-border">
        {steps.map((step, i) =>
          row(
            step,
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
                step.done
                  ? 'border-confirmed bg-confirmed text-white'
                  : step.id === next
                    ? 'border-accent text-accent'
                    : 'border-border-strong text-fg-subtle',
              )}
            >
              {step.done ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
            </span>,
          ),
        )}
      </ol>
      {extras.length > 0 && (
        <>
          <p className="border-t border-border bg-surface-2/50 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
            Optional
          </p>
          <ul className="divide-y divide-border border-t border-border">
            {extras.map((extra) =>
              row(
                extra,
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border',
                    extra.done ? 'border-confirmed bg-confirmed text-white' : 'border-dashed border-border-strong',
                  )}
                >
                  {extra.done && <Check className="size-3.5" aria-label="Done" />}
                </span>,
              ),
            )}
          </ul>
        </>
      )}
    </Card>
  );
}

/** Admins only: emails aren't really going out yet. */
export function OutboxBanner() {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-awaiting/35 bg-awaiting-soft px-4 py-3"
    >
      <MailWarning className="size-5 shrink-0 text-awaiting-fg" aria-hidden />
      <p className="min-w-0 flex-[1_1_20rem] text-sm text-fg">
        <span className="font-semibold">Email isn't set up.</span>{' '}
        <span className="text-fg-muted">
          Confirmations, sign-in links and availability requests are going to the outbox, not to comedians.
        </span>
      </p>
      <Link to="/app/settings/email" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
        Set up email <ArrowRight aria-hidden />
      </Link>
    </div>
  );
}
