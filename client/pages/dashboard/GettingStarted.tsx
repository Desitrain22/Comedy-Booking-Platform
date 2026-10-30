/**
 * A new club's dashboard: the "Getting started" checklist (add a location, add comedians,
 * create shows, connect email — admins only — and request availability), each step linking to
 * the screen that does it. It shows until every step is done. A club that's up and running
 * but still has no email set up gets the slimmer outbox banner instead (admins only).
 */
import { ArrowRight, Check, MailWarning, Rocket } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Card, buttonClasses } from '../../components/ui';
import { cn } from '../../lib/cn';
import type { SetupStep, SetupStepId } from './format';

interface StepCopy {
  title: string;
  description: string;
  /** Where the step is done (a link), unless it opens something on the dashboard. */
  to?: string;
  action: string;
}

const STEP_COPY: Record<SetupStepId, StepCopy> = {
  location: {
    title: 'Add a location',
    description: 'The rooms your shows happen in. Each gets its own color.',
    to: '/app/settings/locations',
    action: 'Locations',
  },
  comedians: {
    title: 'Add your comedians',
    description: 'A name and an email each, or paste your whole list at once.',
    to: '/app/comedians',
    action: 'Add comedians',
  },
  shows: {
    title: 'Create shows',
    description: 'Set up a month of shows in one go, by weekday and time.',
    to: '/app/shows/new',
    action: 'Create shows',
  },
  email: {
    title: 'Connect email',
    description: "Until then, sign-in links and confirmations wait in the outbox instead of being sent.",
    to: '/app/settings/email',
    action: 'Set up email',
  },
  availability: {
    title: 'Request availability',
    description: 'Ask comedians which nights they can do, then build lineups from who’s free.',
    action: 'Request availability',
  },
};

export interface GettingStartedProps {
  steps: SetupStep[];
  /** Open the availability request dialog. */
  onRequestAvailability: () => void;
  /** No comedians yet: requesting availability would reach nobody. */
  canRequestAvailability: boolean;
}

export function GettingStarted({ steps, onRequestAvailability, canRequestAvailability }: GettingStartedProps) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Rocket className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg">Getting started</h2>
          <p className="text-sm text-fg-muted">A few steps and your club is ready to book.</p>
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
      </div>
      <ol className="divide-y divide-border">
        {steps.map((step, i) => {
          const copy = STEP_COPY[step.id];
          const isNext = step.id === next;
          let action: ReactNode = null;
          if (!step.done) {
            const variant = isNext ? 'primary' : 'secondary';
            action = copy.to ? (
              <Link to={copy.to} className={buttonClasses({ variant, size: 'sm' })}>
                {copy.action} <ArrowRight aria-hidden />
              </Link>
            ) : (
              <Button
                size="sm"
                variant={variant}
                onClick={onRequestAvailability}
                disabled={!canRequestAvailability}
                title={canRequestAvailability ? undefined : 'Add comedians first'}
              >
                {copy.action}
              </Button>
            );
          }
          return (
            <li key={step.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
                  step.done
                    ? 'border-confirmed bg-confirmed text-white'
                    : isNext
                      ? 'border-accent text-accent'
                      : 'border-border-strong text-fg-subtle',
                )}
              >
                {step.done ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
              </span>
              <div className="min-w-0 flex-[1_1_16rem]">
                <p className={cn('text-sm font-medium', step.done ? 'text-fg-muted line-through decoration-fg-subtle' : 'text-fg')}>
                  {copy.title}
                </p>
                {!step.done && <p className="text-xs text-fg-muted">{copy.description}</p>}
              </div>
              {action}
            </li>
          );
        })}
      </ol>
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
