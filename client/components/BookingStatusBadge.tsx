import {
  BOOKING_STATUS_LABELS,
  BOOKING_STATUS_SHORT_LABELS,
  type BookingStatus,
} from '../../shared/bookingStatus';
import { cn } from '../lib/cn';
import { BOOKING_STATUS_CLASSES } from '../lib/statusStyles';

export interface BookingStatusBadgeProps {
  status: BookingStatus;
  /** "Awaiting" instead of "Awaiting confirmation". */
  short?: boolean;
  className?: string;
}

/**
 * Status pill with a colored dot: Confirmed / Awaiting / Not sent / Unconfirmed (today, red) /
 * Declined (muted violet, dashed border — pair it with `BOOKING_STATUS_CLASSES.declined.name`
 * on the comedian's name to strike it through).
 */
export function BookingStatusBadge({ status, short = false, className }: BookingStatusBadgeProps) {
  const classes = BOOKING_STATUS_CLASSES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        classes.chip,
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', classes.dot)} />
      {(short ? BOOKING_STATUS_SHORT_LABELS : BOOKING_STATUS_LABELS)[status]}
    </span>
  );
}
