/**
 * Dashboard section 3: this week per day (shows, open slots, unconfirmed), the "N booked this
 * week haven't been emailed yet – Send" nudge (spots booked after the confirmations went out;
 * the daily catch-up also sends them), when confirmations were last sent / go out next, and
 * **Send confirmations now**.
 */
import { MailWarning, Send } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { DashboardResponse } from '../../../shared/api/dashboard';
import { BOOKING_STATUS_SHORT_LABELS, type BookingStatus } from '../../../shared/bookingStatus';
import { formatDateShort, formatRelative, formatTime, formatWeekday } from '../../../shared/time';
import { Button, Card, CardHeader, Dialog, Switch } from '../../components/ui';
import { cn } from '../../lib/cn';
import { BOOKING_STATUS_CLASSES } from '../../lib/statusStyles';
import { formatNextSend, formatWeekRange, plural } from './format';
import { outboxNote, useSendConfirmations } from './useDashboard';

const STATUS_ORDER: BookingStatus[] = ['unconfirmed_today', 'awaiting', 'not_sent', 'confirmed', 'declined'];

export function ThisWeek({ data }: { data: DashboardResponse }) {
  const { week, today } = data;
  const { confirmations } = week;
  const [dialogOpen, setDialogOpen] = useState(false);
  const remainingTotal = STATUS_ORDER.reduce((n, s) => n + week.remaining[s], 0);

  return (
    <Card>
      <CardHeader title="This week" description={formatWeekRange(week.weekStart, week.weekEnd)} />

      <table className="w-full text-sm">
        <caption className="sr-only">Shows, open slots and unconfirmed spots per day this week</caption>
        <thead>
          <tr className="border-b border-border text-xs text-fg-muted">
            <th scope="col" className="py-2 pl-4 text-left font-medium">
              Day
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Shows
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Open
            </th>
            <th scope="col" className="py-2 pr-4 pl-2 text-right font-medium">
              Unconfirmed
            </th>
          </tr>
        </thead>
        <tbody>
          {week.days.map((day) => {
            const declinedNote = day.declined > 0 ? `, ${day.declined} declined` : '';
            const isToday = day.date === today;
            const past = day.date < today;
            const dark = day.shows === 0;
            return (
              <tr
                key={day.date}
                className={cn(
                  'relative border-b border-border last:border-b-0 transition-colors hover:bg-surface-2',
                  isToday && 'bg-accent-soft hover:bg-accent-soft',
                  (past || dark) && !isToday && 'text-fg-subtle',
                )}
              >
                <th scope="row" className="py-2 pl-4 text-left font-normal">
                  <Link
                    to={`/app/day/${day.date}`}
                    className="rounded-sm after:absolute after:inset-0 after:content-['']"
                    aria-current={isToday ? 'date' : undefined}
                  >
                    <span className={cn('font-medium', !past && !dark && 'text-fg', isToday && 'text-accent')}>
                      {formatWeekday(day.date).slice(0, 3)}
                    </span>{' '}
                    <span className={cn(!past && !dark && 'text-fg-muted')}>{formatDateShort(day.date)}</span>
                    {isToday && <span className="ml-1.5 text-xs font-semibold text-accent">Today</span>}
                  </Link>
                </th>
                <td className="px-2 py-2 text-right tabular-nums">{dark ? '—' : day.shows}</td>
                <td className="px-2 py-2 text-right tabular-nums">{dark ? '—' : day.openSlots}</td>
                <td className="py-2 pr-4 pl-2 text-right tabular-nums" title={declinedNote ? `Needs a replacement${declinedNote}` : undefined}>
                  <UnconfirmedCell
                    count={day.unconfirmed}
                    booked={day.booked - day.declined}
                    past={past}
                    today={isToday}
                  />
                  {day.declined > 0 && !past && (
                    <span className="ml-1 inline-flex min-w-6 justify-center rounded-full border border-dashed border-declined/60 bg-declined-soft px-1.5 text-xs leading-[18px] font-semibold text-declined-fg">
                      <span className="sr-only">plus </span>
                      {day.declined}
                      <span className="sr-only"> declined</span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="space-y-3 border-t border-border px-4 py-3.5">
        <UnsentNudge data={data} />

        {remainingTotal > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-fg-muted">
              {plural(remainingTotal, 'spot')} from today to Sunday
            </p>
            <StatusBar counts={week.remaining} total={remainingTotal} />
          </div>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fg-muted">Last sent</dt>
          <dd className="text-fg">
            {confirmations.lastSentAt != null ? formatRelative(confirmations.lastSentAt) : 'Not sent this week'}
          </dd>
          <dt className="text-fg-muted">Next automatic</dt>
          <dd className="text-fg">
            {confirmations.nextSend ? (
              formatNextSend(confirmations.nextSend, today, Date.now())
            ) : (
              <>
                Off ·{' '}
                <Link to="/app/settings/confirmations" className="text-accent hover:underline">
                  Settings
                </Link>
              </>
            )}
          </dd>
        </dl>

        <Button
          variant="secondary"
          className="w-full"
          onClick={() => setDialogOpen(true)}
          disabled={confirmations.pendingComedians === 0}
        >
          <Send aria-hidden />
          Send confirmations now
        </Button>
        {confirmations.pendingComedians === 0 && (
          <p className="text-center text-xs text-fg-muted">
            {remainingTotal === 0
              ? 'No one is booked from today to Sunday.'
              : week.remaining.declined > 0
                ? 'Everyone else booked from today to Sunday has confirmed.'
                : 'Everyone booked from today to Sunday has confirmed.'}
          </p>
        )}
      </div>

      <SendConfirmationsDialog open={dialogOpen} onOpenChange={setDialogOpen} data={data} />
    </Card>
  );
}

/**
 * "4 booked this week haven't been emailed yet – Send": spots from tonight to Sunday that
 * nobody has emailed (booked after the confirmations went out). Sends with `onlyUnsent`.
 */
function UnsentNudge({ data }: { data: DashboardResponse }) {
  const { confirmations, weekStart } = data.week;
  const send = useSendConfirmations(data.emailConfigured);
  const count = confirmations.unsentBookings;
  if (count === 0) return null;
  const catchUp = confirmations.enabled && confirmations.catchUpEnabled;
  return (
    <div className="rounded-lg border border-awaiting/35 bg-awaiting-soft px-3 py-2.5" role="status">
      <div className="flex items-center gap-2.5">
        <MailWarning className="size-4 shrink-0 text-awaiting-fg" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-fg">
          <span className="font-semibold tabular-nums">{count}</span> booked this week{' '}
          {count === 1 ? "hasn't" : "haven't"} been emailed yet
        </p>
        <Button
          size="sm"
          loading={send.isPending}
          onClick={() => send.mutate({ weekStart, onlyUnsent: true })}
          aria-label={`Send confirmation emails for the ${count} spots booked this week that haven't been emailed`}
        >
          {!send.isPending && <Send aria-hidden />}
          Send
        </Button>
      </div>
      <p className="mt-1 pl-6.5 text-xs text-fg-muted">
        {catchUp ? (
          <>Or leave it: the daily catch-up emails them at {formatTime(confirmations.timeMin)}.</>
        ) : (
          <>
            Daily catch-up is off ·{' '}
            <Link to="/app/settings/confirmations" className="text-accent hover:underline">
              Settings
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

function UnconfirmedCell({ count, booked, past, today }: { count: number; booked: number; past: boolean; today: boolean }) {
  if (booked === 0) return <span className="text-fg-subtle">—</span>;
  if (count === 0) {
    return (
      <span className={cn('font-medium', past ? 'text-fg-subtle' : 'text-confirmed-fg')} title="All confirmed">
        ✓
      </span>
    );
  }
  if (past) return <span>{count}</span>;
  return (
    <span
      className={cn(
        'inline-flex min-w-6 justify-center rounded-full px-1.5 text-xs leading-5 font-semibold',
        today ? 'bg-unconfirmed text-white' : 'bg-awaiting-soft text-awaiting-fg',
      )}
    >
      {count}
    </span>
  );
}

/** Stacked bar + legend of booking statuses. */
function StatusBar({ counts, total }: { counts: Record<BookingStatus, number>; total: number }) {
  const shown = STATUS_ORDER.filter((s) => counts[s] > 0);
  return (
    <>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {shown.map((s) => (
          <span key={s} className={BOOKING_STATUS_CLASSES[s].dot} style={{ width: `${(counts[s] / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
        {shown.map((s) => (
          <li key={s} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2 rounded-full', BOOKING_STATUS_CLASSES[s].dot)} />
            <span className="font-semibold text-fg tabular-nums">{counts[s]}</span>
            {s === 'unconfirmed_today' ? 'unconfirmed today' : BOOKING_STATUS_SHORT_LABELS[s].toLowerCase()}
          </li>
        ))}
      </ul>
    </>
  );
}

function SendConfirmationsDialog({
  open,
  onOpenChange,
  data,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: DashboardResponse;
}) {
  const { pendingComedians, unsentComedians } = data.week.confirmations;
  const [onlyUnsent, setOnlyUnsent] = useState(false);
  const send = useSendConfirmations(data.emailConfigured);
  const count = onlyUnsent ? unsentComedians : pendingComedians;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !send.isPending && onOpenChange(next)}
      title="Send this week's confirmations?"
      description={`Each comedian with unconfirmed spots from today to Sunday (${formatWeekRange(
        data.today,
        data.week.weekEnd,
      )}) gets one email listing their spots with a Confirm button.`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button
            loading={send.isPending}
            disabled={count === 0}
            onClick={() =>
              send.mutate(
                { weekStart: data.week.weekStart, onlyUnsent },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Send {plural(count, 'email')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-fg">
          <span className="font-semibold">{plural(pendingComedians, 'comedian')}</span>{' '}
          {pendingComedians === 1 ? 'has' : 'have'} unconfirmed spots this week
          {unsentComedians < pendingComedians && (
            <>
              ; <span className="font-semibold">{unsentComedians}</span> of them{' '}
              {unsentComedians === 1 ? "hasn't" : "haven't"} been emailed yet
            </>
          )}
          .
        </p>
        <Switch
          checked={onlyUnsent}
          onCheckedChange={setOnlyUnsent}
          disabled={unsentComedians === pendingComedians}
          label={`Only comedians who haven't been emailed (${unsentComedians})`}
        />
        {!data.emailConfigured && <p className="text-xs text-fg-muted">{outboxNote(false)}</p>}
      </div>
    </Dialog>
  );
}
