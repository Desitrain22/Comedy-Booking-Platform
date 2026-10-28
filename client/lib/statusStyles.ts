/**
 * Tailwind classes for booking statuses and availability, so every screen colors them
 * the same way (spec §8: confirmed emerald, awaiting amber, not sent zinc,
 * unconfirmed-today red; availability emerald).
 */
import type { AvailabilityState } from '../../shared/availability';
import type { BookingStatus } from '../../shared/bookingStatus';

export interface StatusClasses {
  /** Small solid dot, e.g. `<span className={cn('size-2 rounded-full', s.dot)} />` */
  dot: string;
  /** Soft chip: background + text + border. */
  chip: string;
  /** Text color only. */
  text: string;
  /** Border color only (e.g. a left accent bar). */
  border: string;
}

export const BOOKING_STATUS_CLASSES: Record<BookingStatus, StatusClasses> = {
  confirmed: {
    dot: 'bg-confirmed',
    chip: 'bg-confirmed-soft text-confirmed-fg border-confirmed/40',
    text: 'text-confirmed-fg',
    border: 'border-confirmed',
  },
  awaiting: {
    dot: 'bg-awaiting',
    chip: 'bg-awaiting-soft text-awaiting-fg border-awaiting/40',
    text: 'text-awaiting-fg',
    border: 'border-awaiting',
  },
  not_sent: {
    dot: 'bg-notsent',
    chip: 'bg-notsent-soft text-notsent-fg border-notsent/40',
    text: 'text-notsent-fg',
    border: 'border-notsent',
  },
  unconfirmed_today: {
    dot: 'bg-unconfirmed',
    chip: 'bg-unconfirmed-soft text-unconfirmed-fg border-unconfirmed/50',
    text: 'text-unconfirmed-fg',
    border: 'border-unconfirmed',
  },
};

export const AVAILABILITY_CLASSES: Record<AvailabilityState, StatusClasses> = {
  available: {
    dot: 'bg-available',
    chip: 'bg-available-soft text-available-fg border-available/40',
    text: 'text-available-fg',
    border: 'border-available',
  },
  unavailable: {
    dot: 'bg-surface-3',
    chip: 'bg-surface-2 text-fg-subtle border-border',
    text: 'text-fg-subtle',
    border: 'border-border',
  },
  not_submitted: {
    dot: 'bg-notsent',
    chip: 'bg-surface-2 text-fg-muted border-border',
    text: 'text-fg-muted',
    border: 'border-border',
  },
};
