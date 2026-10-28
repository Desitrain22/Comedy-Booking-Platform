/**
 * Dashboard section 4: availability for this month and next ("14 of 32 comedians have
 * submitted December"), **Request availability**, and **Remind the 18 who haven't**.
 */
import { BellRing, CircleCheck, Megaphone } from 'lucide-react';
import { useState } from 'react';
import type { AvailabilityRequestSummary, DashboardResponse, MonthAvailabilityProgress } from '../../../shared/api/dashboard';
import type { AvailabilityRequestKind } from '../../../shared/types';
import { addMonths, formatMonthName, formatRelative, monthOf } from '../../../shared/time';
import { Button, Card, CardHeader } from '../../components/ui';
import { cn } from '../../lib/cn';
import { AvailabilityRequestDialog } from './AvailabilityRequestDialog';
import { percent, plural } from './format';

interface DialogState {
  kind: AvailabilityRequestKind;
  month: string;
}

export function AvailabilityPanel({ data }: { data: DashboardResponse }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const nextMonth = addMonths(monthOf(data.today), 1);

  return (
    <Card>
      <CardHeader
        title="Availability"
        description="This month and next"
        actions={
          <Button size="sm" onClick={() => setDialog({ kind: 'request', month: nextMonth })}>
            <Megaphone aria-hidden />
            Request availability
          </Button>
        }
      />
      <div className="divide-y divide-border">
        {data.availability.map((progress) => (
          <MonthProgress
            key={progress.month}
            progress={progress}
            onRemind={() => setDialog({ kind: 'reminder', month: progress.month })}
            onRequest={() => setDialog({ kind: 'request', month: progress.month })}
          />
        ))}
      </div>
      {dialog && (
        <AvailabilityRequestDialog
          key={`${dialog.kind}-${dialog.month}`}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          kind={dialog.kind}
          initialMonth={dialog.month}
          data={data}
        />
      )}
    </Card>
  );
}

function MonthProgress({
  progress,
  onRemind,
  onRequest,
}: {
  progress: MonthAvailabilityProgress;
  onRemind: () => void;
  onRequest: () => void;
}) {
  const { month, total, submitted, notSubmitted, lastRequest, lastReminder } = progress;
  const monthName = formatMonthName(month);
  const pct = percent(submitted, total);
  const done = total > 0 && notSubmitted === 0;
  const labelId = `availability-${month}`;

  return (
    <section className="px-4 py-3.5" aria-labelledby={labelId}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={labelId} className="text-sm font-semibold text-fg">
          {monthName}
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
          className={cn('h-full rounded-full transition-[width] duration-500', done ? 'bg-available' : 'bg-accent-solid')}
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="mt-2 text-xs text-fg-muted">{historyLine(lastRequest, lastReminder)}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {done ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-available-fg">
            <CircleCheck className="size-4" aria-hidden /> Everyone's in
          </span>
        ) : lastRequest ? (
          <Button size="sm" variant="secondary" onClick={onRemind} disabled={notSubmitted === 0}>
            <BellRing aria-hidden />
            Remind the {notSubmitted} who haven't
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={onRequest}>
            <Megaphone aria-hidden />
            Request {monthName}
          </Button>
        )}
      </div>
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
