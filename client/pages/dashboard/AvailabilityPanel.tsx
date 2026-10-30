/**
 * Dashboard section 4: availability from this month through the month after the planning
 * month ("14 of 32 comedians have submitted December"), **Request availability** (defaults to
 * the planning month, and to a reminder once that month was asked for), and **Remind the 18
 * who haven't**. The planning month follows the portal's rule: next month from the 20th on.
 * A month that's winding down (this month, once we're planning the next) shows its progress
 * without the buttons.
 *
 * The header's Request availability is the setup guide's `dashboard-request-availability`
 * target; while the guide points at it, it opens on the guide's month (the one with shows).
 */
import { BellRing, CircleCheck, Megaphone } from 'lucide-react';
import { Link } from 'react-router';
import type { AvailabilityRequestSummary, DashboardResponse, MonthAvailabilityProgress } from '../../../shared/api/dashboard';
import { formatMonthName, formatRelative } from '../../../shared/time';
import type { AvailabilityRequestKind } from '../../../shared/types';
import { Badge, Button, Card, CardHeader } from '../../components/ui';
import { cn } from '../../lib/cn';
import { defaultRequestKind, percent, plural } from './format';

export interface RequestDialogTarget {
  kind: AvailabilityRequestKind;
  month: string;
}

export interface AvailabilityPanelProps {
  data: DashboardResponse;
  /** Open the request/remind dialog. */
  onRequest: (target: RequestDialogTarget) => void;
  /** The month the header button asks for (default: the planning month). */
  requestMonth?: string;
}

export function AvailabilityPanel({ data, onRequest, requestMonth }: AvailabilityPanelProps) {
  const planning = data.planningMonth;
  const noComedians = data.setup.comedians === 0;
  const headerMonth = requestMonth ?? planning;
  const headerProgress = data.availability.find((p) => p.month === headerMonth);

  return (
    <Card>
      <CardHeader
        title="Availability"
        description={`Planning ${formatMonthName(planning)}`}
        actions={
          <Button
            size="sm"
            data-guide="dashboard-request-availability"
            disabled={noComedians}
            title={noComedians ? 'Add comedians first' : undefined}
            onClick={() => onRequest({ kind: defaultRequestKind(headerProgress), month: headerMonth })}
          >
            <Megaphone aria-hidden />
            Request availability
          </Button>
        }
      />
      {noComedians && (
        <p className="border-b border-border bg-surface-2/60 px-4 py-2.5 text-xs text-fg-muted">
          There's no one to ask yet.{' '}
          <Link to="/app/comedians" className="font-medium text-accent hover:underline">
            Add comedians
          </Link>{' '}
          first, then request their availability.
        </p>
      )}
      <div className="divide-y divide-border">
        {data.availability.map((progress) => (
          <MonthProgress
            key={progress.month}
            progress={progress}
            role={progress.month === planning ? 'planning' : progress.month < planning ? 'ending' : 'ahead'}
            disabled={noComedians}
            onRemind={() => onRequest({ kind: 'reminder', month: progress.month })}
            onRequest={() => onRequest({ kind: 'request', month: progress.month })}
          />
        ))}
      </div>
    </Card>
  );
}

function MonthProgress({
  progress,
  role,
  disabled,
  onRemind,
  onRequest,
}: {
  progress: MonthAvailabilityProgress;
  /** `ending`: this month while the club already plans the next (no buttons). */
  role: 'planning' | 'ending' | 'ahead';
  disabled: boolean;
  onRemind: () => void;
  onRequest: () => void;
}) {
  const { month, total, submitted, notSubmitted, lastRequest, lastReminder } = progress;
  const monthName = formatMonthName(month);
  const pct = percent(submitted, total);
  const done = total > 0 && notSubmitted === 0;
  const labelId = `availability-${month}`;
  const ending = role === 'ending';

  return (
    <section className={cn('px-4 py-3.5', ending && 'bg-surface-2/40')} aria-labelledby={labelId}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={labelId} className={cn('flex items-center gap-2 text-sm font-semibold', ending ? 'text-fg-muted' : 'text-fg')}>
          {monthName}
          {role === 'planning' && <Badge variant="accent">Planning</Badge>}
          {ending && <span className="text-xs font-normal text-fg-subtle">This month</span>}
        </h3>
        <span className="text-xs font-medium text-fg-muted tabular-nums">{pct}%</span>
      </div>
      <p className="mt-0.5 text-sm text-fg-muted">
        <span className="font-semibold text-fg tabular-nums">{submitted}</span> of{' '}
        <span className="tabular-nums">{plural(total, 'comedian')}</span> {submitted === 1 ? 'has' : 'have'} submitted{' '}
        {monthName}
      </p>
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={submitted}
        aria-valuetext={`${submitted} of ${total} submitted`}
        className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            done ? 'bg-available' : ending ? 'bg-fg-subtle' : 'bg-accent-solid',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="mt-2 text-xs text-fg-muted">{historyLine(lastRequest, lastReminder)}</p>

      {!ending && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {done ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-available-fg">
              <CircleCheck className="size-4" aria-hidden /> Everyone's in
            </span>
          ) : lastRequest ? (
            <Button size="sm" variant="secondary" onClick={onRemind} disabled={disabled || notSubmitted === 0}>
              <BellRing aria-hidden />
              Remind the {notSubmitted} who haven't
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={onRequest} disabled={disabled}>
              <Megaphone aria-hidden />
              Request {monthName}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function requestPhrase(r: AvailabilityRequestSummary, verb: string): string {
  const to = r.audience === 'all' ? '' : ` to ${r.audienceLabel}`;
  return `${verb}${to} ${formatRelative(r.sentAt)}`;
}

/** "Requested 6d ago by Dana · reminded 1d ago". */
function historyLine(request: AvailabilityRequestSummary | null, reminder: AvailabilityRequestSummary | null): string {
  if (!request && !reminder) return 'No request sent yet.';
  const parts: string[] = [];
  if (request) parts.push(requestPhrase(request, 'Requested') + (request.sentByName ? ` by ${request.sentByName.split(' ')[0]}` : ''));
  if (reminder && (!request || reminder.sentAt > request.sentAt)) {
    parts.push(requestPhrase(reminder, parts.length ? 'reminded' : 'Reminded'));
  }
  return parts.join(' · ');
}
