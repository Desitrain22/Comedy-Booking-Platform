/**
 * Booked spots as the comedian sees them (My spots and the emailed confirm-link page).
 *
 * After-midnight shows keep their night's date tile but name the real day next to the
 * time ("1 AM (early Mon, Nov 9)"). When the club allows declines, each upcoming spot has
 * a "Can't make it?" button that opens an inline form (optional note → the caller's
 * `onDecline`); a declined spot reads "Can't make it" and can be undone until the show
 * starts.
 */
import { Check, MapPin, Undo2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { DECLINE_NOTE_MAX, type PortalSpot } from '../../../shared/api/portal';
import {
  addDays,
  diffDays,
  formatDateMedium,
  formatDateShort,
  formatShowTime,
  formatShowWhen,
  MONTH_SHORT,
  weekdayOf,
  weekStartOf,
  WEEKDAY_SHORT,
} from '../../../shared/time';
import { Button, ColorDot, Textarea } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { BOOKING_STATUS_CLASSES } from '../../lib/statusStyles';

/** "This week", "Next week", "Last week", "Week of Nov 16". */
export function weekLabel(weekStart: string, today: string): string {
  const weeks = Math.round(diffDays(weekStartOf(today), weekStart) / 7);
  if (weeks === 0) return 'This week';
  if (weeks === 1) return 'Next week';
  if (weeks === -1) return 'Last week';
  return `Week of ${formatDateShort(weekStart)}`;
}

/** "Nov 9 – 15" or "Nov 30 – Dec 6". */
export function weekRange(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const sameMonth = end.slice(0, 7) === weekStart.slice(0, 7);
  return `${formatDateShort(weekStart)} – ${sameMonth ? Number(end.slice(8)) : formatDateShort(end)}`;
}

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** The DOM id of a spot's row (the email's "Can't make it?" link scrolls to it). */
export function spotRowId(bookingId: number): string {
  return `spot-${bookingId}`;
}

/** Comedian-facing status: "Confirmed", "Not confirmed" (red on the night itself) or "Can't make it". */
export function SpotStatus({ spot, className }: { spot: PortalSpot; className?: string }) {
  const declined = spot.declinedAt != null;
  const confirmed = !declined && spot.confirmedAt != null;
  const classes =
    BOOKING_STATUS_CLASSES[
      declined ? 'declined' : confirmed ? 'confirmed' : spot.status === 'unconfirmed_today' ? 'unconfirmed_today' : 'awaiting'
    ];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        classes.chip,
        className,
      )}
    >
      {declined ? (
        <X aria-hidden className="size-3" />
      ) : confirmed ? (
        <Check aria-hidden className="size-3" />
      ) : (
        <span aria-hidden className={cn('size-1.5 rounded-full', classes.dot)} />
      )}
      {declined ? "Can't make it" : confirmed ? 'Confirmed' : 'Not confirmed'}
    </span>
  );
}

function DateTile({ date, today }: { date: string; today: string }) {
  const isToday = date === today;
  return (
    <div
      className={cn(
        'flex w-12 shrink-0 flex-col items-center justify-center rounded-lg border py-1 leading-none',
        isToday ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg',
      )}
      aria-hidden
    >
      <span className="text-[10px] font-semibold tracking-wide uppercase">{isToday ? 'Today' : WEEKDAY_SHORT[weekdayOf(date)]}</span>
      <span className="mt-0.5 text-lg font-semibold">{Number(date.slice(8))}</span>
      <span className="text-[10px] text-fg-muted">{MONTH_SHORT[Number(date.slice(5, 7)) - 1]}</span>
    </div>
  );
}

/** Declining is on for this list: what to call (the portal session or the emailed link). */
export interface SpotDeclineActions {
  /** Open this spot's "Can't make it" form on first render (the email's `?decline=<id>` link). */
  openId?: number | null;
  /** Resolves once saved; rejects with the API error (shown as a toast). */
  onDecline: (spot: PortalSpot, note: string) => Promise<unknown>;
  onUndo: (spot: PortalSpot) => Promise<unknown>;
}

export function SpotRow({ spot, today, declines }: { spot: PortalSpot; today: string; declines?: SpotDeclineActions }) {
  const { location } = spot;
  const declined = spot.declinedAt != null;
  // Declining / undoing is possible until the show starts.
  const changeable = Boolean(declines) && spot.startsAt > Date.now();
  const [open, setOpen] = useState(() => changeable && !declined && declines?.openId === spot.bookingId);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<'decline' | 'undo' | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const openedFromLink = useRef(open);
  const noteId = useId();
  const when = formatShowWhen(spot.date, spot.startMin);

  useEffect(() => {
    if (!open) return;
    if (openedFromLink.current) {
      // Arrived from the email's link for this spot: bring it into view.
      openedFromLink.current = false;
      rowRef.current?.scrollIntoView({ block: 'center' });
    } else {
      // Opened by tapping: make sure the form's buttons aren't below the fold.
      formRef.current?.scrollIntoView({ block: 'nearest' });
    }
    noteRef.current?.focus({ preventScroll: true });
  }, [open]);

  async function run(kind: 'decline' | 'undo', action: () => Promise<unknown>, done: string) {
    setPending(kind);
    try {
      await action();
      toast.success(done);
      if (kind === 'decline') {
        setOpen(false);
        setNote('');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  function handleDecline(e: FormEvent) {
    e.preventDefault();
    if (!declines || pending) return;
    void run('decline', () => declines.onDecline(spot, note.trim()), "Thanks — the club knows you can't make it");
  }

  return (
    <li ref={rowRef} id={spotRowId(spot.bookingId)} className="scroll-mt-24 px-4 py-3">
      <div className="flex items-start gap-3">
        <DateTile date={spot.date} today={today} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-[15px] font-semibold text-fg', declined && 'text-fg-muted')}>
            <span className="sr-only">{formatDateMedium(spot.date)}, </span>
            <span className={cn(declined && BOOKING_STATUS_CLASSES.declined.name)}>
              {formatShowTime(spot.date, spot.startMin)}
              {spot.showName && <span className="font-normal text-fg-muted"> · {spot.showName}</span>}
            </span>
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-fg">
            <ColorDot color={location.color} />
            <span className="truncate">{location.name}</span>
          </p>
          {location.address && (
            <a
              href={mapsUrl(location.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-fg-muted underline-offset-2 hover:text-accent hover:underline"
            >
              <MapPin aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{location.address}</span>
            </a>
          )}
          {declined && spot.declineNote && (
            <p className="mt-1 text-xs break-words text-fg-muted italic">“{spot.declineNote}”</p>
          )}
          {changeable && declined && (
            <div className="mt-0.5">
              <button
                type="button"
                onClick={() => void run('undo', () => declines!.onUndo(spot), "Undone — you're back on the lineup")}
                disabled={pending != null}
                aria-label={`Undo — I can make ${when} after all`}
                className="-ml-2 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium whitespace-nowrap text-accent hover:bg-surface-2 disabled:opacity-50"
              >
                <Undo2 aria-hidden className="size-3.5" />
                {pending === 'undo' ? 'Undoing…' : 'Undo'}
              </button>
            </div>
          )}
          {changeable && !declined && !open && (
            <div className="mt-0.5">
              <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={`Can't make ${when}?`}
                aria-expanded={false}
                className="-ml-2 inline-flex min-h-9 items-center rounded-md px-2 text-[13px] font-medium whitespace-nowrap text-fg-muted underline-offset-2 hover:bg-surface-2 hover:text-fg hover:underline"
              >
                Can't make it?
              </button>
            </div>
          )}
        </div>
        <SpotStatus spot={spot} className="mt-0.5 shrink-0" />
      </div>

      {open && !declined && changeable && (
        <form
          ref={formRef}
          onSubmit={handleDecline}
          className="mt-3 rounded-lg border border-dashed border-declined/60 bg-declined-soft/60 p-3 sm:ml-15"
          aria-label={`Can't make ${when}`}
        >
          <label htmlFor={noteId} className="block text-sm font-medium text-fg">
            Can't make it? The club will find someone else.
          </label>
          <p className="mt-0.5 text-xs text-fg-muted">Anything they should know? (optional)</p>
          <Textarea
            ref={noteRef}
            id={noteId}
            rows={2}
            maxLength={DECLINE_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. My flight got moved"
            className="mt-2 min-h-16 bg-surface text-base sm:text-sm"
          />
          <div className="mt-2.5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              size="lg"
              className="sm:h-9 sm:px-3.5 sm:text-sm"
              onClick={() => {
                setOpen(false);
                setNote('');
              }}
              disabled={pending != null}
            >
              Never mind
            </Button>
            <Button type="submit" variant="secondary" size="lg" className="sm:h-9 sm:px-3.5 sm:text-sm" loading={pending === 'decline'}>
              <X /> I can't make it
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function SpotList({
  spots,
  today,
  className,
  declines,
}: {
  spots: PortalSpot[];
  today: string;
  className?: string;
  /** Pass when the club allows declines (and the list isn't read-only). */
  declines?: SpotDeclineActions;
}) {
  return (
    <ul className={cn('divide-y divide-border', className)}>
      {spots.map((spot) => (
        <SpotRow key={spot.bookingId} spot={spot} today={today} declines={declines} />
      ))}
    </ul>
  );
}
