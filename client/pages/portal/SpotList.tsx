/** Booked spots as the comedian sees them (My spots and the emailed confirm-link page). */
import { Check, MapPin } from 'lucide-react';
import type { PortalSpot } from '../../../shared/api/portal';
import {
  addDays,
  diffDays,
  formatDateShort,
  formatTime,
  MONTH_SHORT,
  weekdayOf,
  weekStartOf,
  WEEKDAY_SHORT,
} from '../../../shared/time';
import { ColorDot } from '../../components/ui';
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

/** Comedian-facing status: just "Confirmed" or "Not confirmed" (red on the day itself). */
export function SpotStatus({ spot, className }: { spot: PortalSpot; className?: string }) {
  const confirmed = spot.confirmedAt != null;
  const classes = BOOKING_STATUS_CLASSES[confirmed ? 'confirmed' : spot.status === 'unconfirmed_today' ? 'unconfirmed_today' : 'awaiting'];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        classes.chip,
        className,
      )}
    >
      {confirmed ? <Check aria-hidden className="size-3" /> : <span aria-hidden className={cn('size-1.5 rounded-full', classes.dot)} />}
      {confirmed ? 'Confirmed' : 'Not confirmed'}
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

export function SpotRow({ spot, today }: { spot: PortalSpot; today: string }) {
  const { location } = spot;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <DateTile date={spot.date} today={today} />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-fg">
          <span className="sr-only">{formatDateShort(spot.date)}, </span>
          {formatTime(spot.startMin)}
          {spot.showName && <span className="font-normal text-fg-muted"> · {spot.showName}</span>}
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
      </div>
      <SpotStatus spot={spot} className="mt-0.5 shrink-0" />
    </li>
  );
}

export function SpotList({ spots, today, className }: { spots: PortalSpot[]; today: string; className?: string }) {
  return (
    <ul className={cn('divide-y divide-border', className)}>
      {spots.map((spot) => (
        <SpotRow key={spot.bookingId} spot={spot} today={today} />
      ))}
    </ul>
  );
}
