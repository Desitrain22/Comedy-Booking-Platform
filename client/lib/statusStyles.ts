/**
 * Tailwind classes for booking statuses and availability, so every screen colors them
 * the same way (spec §8: confirmed emerald, awaiting amber, not sent zinc,
 * unconfirmed-today red, declined muted violet + struck-through name; availability emerald).
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

export interface BookingStatusClasses extends StatusClasses {
  /**
   * Extra classes for the booked comedian's *name* (chips, rows): struck through and muted
   * when declined, '' otherwise. e.g. `<span className={cn('truncate', s.name)}>{name}</span>`
   */
  name: string;
}

export const BOOKING_STATUS_CLASSES: Record<BookingStatus, BookingStatusClasses> = {
  confirmed: {
    dot: 'bg-confirmed',
    chip: 'bg-confirmed-soft text-confirmed-fg border-confirmed/40',
    text: 'text-confirmed-fg',
    border: 'border-confirmed',
    name: '',
  },
  awaiting: {
    dot: 'bg-awaiting',
    chip: 'bg-awaiting-soft text-awaiting-fg border-awaiting/40',
    text: 'text-awaiting-fg',
    border: 'border-awaiting',
    name: '',
  },
  not_sent: {
    dot: 'bg-notsent',
    chip: 'bg-notsent-soft text-notsent-fg border-notsent/40',
    text: 'text-notsent-fg',
    border: 'border-notsent',
    name: '',
  },
  unconfirmed_today: {
    dot: 'bg-unconfirmed',
    chip: 'bg-unconfirmed-soft text-unconfirmed-fg border-unconfirmed/50',
    text: 'text-unconfirmed-fg',
    border: 'border-unconfirmed',
    name: '',
  },
  declined: {
    dot: 'bg-declined',
    chip: 'bg-declined-soft text-declined-fg border-dashed border-declined/60',
    text: 'text-declined-fg',
    border: 'border-declined',
    name: 'line-through decoration-declined decoration-[1.5px] text-fg-muted',
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
