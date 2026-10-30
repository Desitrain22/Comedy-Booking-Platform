/**
 * Pure lineup logic for the day view: what a drop (or click-to-place) would do, the
 * optimistic cache transforms that mirror the server (`server/routes/lineup.ts`), and the
 * plain-text lineup for the clipboard. No React here, so it is unit-tested directly.
 */
import type {
  BookingRestore,
  DayComedian,
  DayResponse,
  DayShow,
  LineupBooking,
  UnavailableConflict,
} from '../../../shared/api/lineup';
import { availabilityState, isAvailableFor, type AvailabilityState } from '../../../shared/availability';
import { bookingStatus } from '../../../shared/bookingStatus';
import {
  formatDateLong,
  formatDateMedium,
  formatDateShort,
  formatMonthName,
  formatRange,
  formatTime,
  monthOf,
} from '../../../shared/time';

// ---------------------------------------------------------------------------
// Drag sources / drop targets
// ---------------------------------------------------------------------------

/** What is being dragged (or is selected for click-to-place). */
export type LineupSource = { kind: 'comedian'; comedianId: number } | { kind: 'booking'; bookingId: number };

/** Where it lands: a slot, or the comedian pool (= unbook). */
export type LineupTarget = { kind: 'slot'; showId: number; position: number } | { kind: 'pool' };

export type DropPlan =
  | { kind: 'none' }
  | { kind: 'reject'; reason: string }
  | {
      kind: 'book';
      comedianId: number;
      showId: number;
      position: number;
      /** The slot's occupant, who goes back to the pool (Undo restores them). */
      replacing: LineupBooking | null;
      conflicts: UnavailableConflict[];
    }
  | {
      kind: 'move';
      bookingId: number;
      showId: number;
      position: number;
      /** The booking that trades places, when the target slot is occupied. */
      swapWith: LineupBooking | null;
      conflicts: UnavailableConflict[];
    }
  | { kind: 'unbook'; bookingId: number };

// ---------------------------------------------------------------------------
// Lookups (memoized per immutable day object)
// ---------------------------------------------------------------------------

export interface DayIndex {
  shows: Map<number, DayShow>;
  bookings: Map<number, LineupBooking>;
  comedians: Map<number, DayComedian>;
  /** comedianId → their bookings today, by show time. */
  bookingsByComedian: Map<number, LineupBooking[]>;
}

const indexCache = new WeakMap<DayResponse, DayIndex>();

export function indexDay(day: DayResponse): DayIndex {
  const cached = indexCache.get(day);
  if (cached) return cached;
  const shows = new Map(day.shows.map((s) => [s.id, s]));
  const bookings = new Map<number, LineupBooking>();
  const bookingsByComedian = new Map<number, LineupBooking[]>();
  for (const show of day.shows) {
    for (const b of show.bookings) {
      bookings.set(b.id, b);
      const list = bookingsByComedian.get(b.comedianId) ?? [];
      list.push(b);
      bookingsByComedian.set(b.comedianId, list);
    }
  }
  for (const list of bookingsByComedian.values()) {
    list.sort((a, b) => shows.get(a.showId)!.startMin - shows.get(b.showId)!.startMin);
  }
  const index: DayIndex = {
    shows,
    bookings,
    comedians: new Map(day.comedians.map((c) => [c.id, c])),
    bookingsByComedian,
  };
  indexCache.set(day, index);
  return index;
}

/** The comedian behind a drag source, if known. */
export function sourceComedianId(day: DayResponse, source: LineupSource | null): number | null {
  if (!source) return null;
  if (source.kind === 'comedian') return source.comedianId;
  return indexDay(day).bookings.get(source.bookingId)?.comedianId ?? null;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export function comedianState(comedian: DayComedian): AvailabilityState {
  return availabilityState(comedian.availability, comedian.submittedMonth);
}

/** Why `comedian` can't play `show` (same rule as the server), or null when they can. */
export function conflictFor(day: DayResponse, comedian: DayComedian, show: DayShow): UnavailableConflict | null {
  if (isAvailableFor(comedian.availability, show.startMin)) return null;
  return {
    comedianId: comedian.id,
    comedianName: comedian.name,
    showId: show.id,
    date: day.date,
    startMin: show.startMin,
    month: monthOf(day.date),
    availability: comedian.availability,
    submittedMonth: comedian.submittedMonth,
  };
}

/** How `comedianId` fits `show`: in it already, available, or not (null when unknown). */
export type ShowFit = 'in_show' | 'available' | 'unavailable';

export function showFit(day: DayResponse, comedianId: number, show: DayShow): ShowFit | null {
  if (show.bookings.some((b) => b.comedianId === comedianId)) return 'in_show';
  const comedian = indexDay(day).comedians.get(comedianId);
  if (!comedian) return null;
  return isAvailableFor(comedian.availability, show.startMin) ? 'available' : 'unavailable';
}

// ---------------------------------------------------------------------------
// Planning a drop
// ---------------------------------------------------------------------------

export function showTitle(show: Pick<DayShow, 'startMin' | 'name'>): string {
  return show.name ? `${formatTime(show.startMin)} ${show.name}` : `${formatTime(show.startMin)} show`;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function planDrop(day: DayResponse, source: LineupSource, target: LineupTarget): DropPlan {
  const index = indexDay(day);

  if (target.kind === 'pool') {
    return source.kind === 'booking' && index.bookings.has(source.bookingId)
      ? { kind: 'unbook', bookingId: source.bookingId }
      : { kind: 'none' };
  }

  const show = index.shows.get(target.showId);
  if (!show || target.position < 0 || target.position >= show.slotCount) return { kind: 'none' };
  const occupant = show.bookings.find((b) => b.position === target.position) ?? null;

  if (source.kind === 'comedian') {
    const comedian = index.comedians.get(source.comedianId);
    if (!comedian) return { kind: 'none' };
    const existing = show.bookings.find((b) => b.comedianId === comedian.id);
    if (existing) {
      return existing.position === target.position
        ? { kind: 'none' }
        : { kind: 'reject', reason: `${firstName(comedian.name)} is already in the ${showTitle(show)} lineup.` };
    }
    // An occupied slot: replace them (still saving → wait for the server's id first).
    if (occupant && occupant.id < 0) {
      return { kind: 'reject', reason: `Slot ${target.position + 1} is still saving. Try again in a moment.` };
    }
    const conflict = conflictFor(day, comedian, show);
    return {
      kind: 'book',
      comedianId: comedian.id,
      showId: show.id,
      position: target.position,
      replacing: occupant,
      conflicts: conflict ? [conflict] : [],
    };
  }

  const booking = index.bookings.get(source.bookingId);
  if (!booking) return { kind: 'none' };
  if (booking.showId === show.id && booking.position === target.position) return { kind: 'none' };
  const sourceShow = index.shows.get(booking.showId)!;
  const sameShow = booking.showId === show.id;
  const conflicts: UnavailableConflict[] = [];

  if (!sameShow) {
    if (show.bookings.some((b) => b.comedianId === booking.comedianId)) {
      return {
        kind: 'reject',
        reason: `${firstName(booking.comedianName)} is already in the ${showTitle(show)} lineup.`,
      };
    }
    if (occupant && sourceShow.bookings.some((b) => b.comedianId === occupant.comedianId)) {
      return {
        kind: 'reject',
        reason: `Can't swap: ${firstName(occupant.comedianName)} is already in the ${showTitle(sourceShow)} lineup.`,
      };
    }
    const mover = index.comedians.get(booking.comedianId);
    const moverConflict = mover ? conflictFor(day, mover, show) : null;
    if (moverConflict) conflicts.push(moverConflict);
    const other = occupant ? index.comedians.get(occupant.comedianId) : undefined;
    const otherConflict = other ? conflictFor(day, other, sourceShow) : null;
    if (otherConflict) conflicts.push(otherConflict);
  }

  return {
    kind: 'move',
    bookingId: booking.id,
    showId: show.id,
    position: target.position,
    swapWith: occupant,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// Optimistic transforms (mirror the server)
// ---------------------------------------------------------------------------

function byPosition(a: LineupBooking, b: LineupBooking) {
  return a.position - b.position;
}

/** Replace the bookings of every show, keeping untouched shows referentially equal. */
function mapBookings(day: DayResponse, fn: (show: DayShow) => LineupBooking[] | null): DayResponse {
  let changed = false;
  const shows = day.shows.map((show) => {
    const next = fn(show);
    if (!next) return show;
    changed = true;
    return { ...show, bookings: next.sort(byPosition) };
  });
  return changed ? { ...day, shows } : day;
}

/** Insert or replace bookings (by id), wherever they were before. */
export function upsertBookings(day: DayResponse, incoming: LineupBooking[]): DayResponse {
  const ids = new Set(incoming.map((b) => b.id));
  return mapBookings(day, (show) => {
    const kept = show.bookings.filter((b) => !ids.has(b.id));
    const added = incoming.filter((b) => b.showId === show.id);
    if (kept.length === show.bookings.length && added.length === 0) return null;
    return [...kept, ...added];
  });
}

export function removeBooking(day: DayResponse, bookingId: number): DayResponse {
  return mapBookings(day, (show) =>
    show.bookings.some((b) => b.id === bookingId) ? show.bookings.filter((b) => b.id !== bookingId) : null,
  );
}

/** Swap a temporary (optimistic) booking for the server's. */
export function replaceBooking(day: DayResponse, tempId: number, booking: LineupBooking): DayResponse {
  return upsertBookings(removeBooking(day, tempId), [booking]);
}

function freshStatus(day: DayResponse) {
  return bookingStatus({ confirmedAt: null, confirmationSentAt: null }, day.date, day.today);
}

/**
 * A new (temp) booking; `replaceBookingId` drops that occupant first, and `restore` (Undo)
 * brings back a removed booking's confirmation and override.
 */
export function applyBook(
  day: DayResponse,
  input: {
    tempId: number;
    comedianId: number;
    showId: number;
    position: number;
    replaceBookingId?: number;
    restore?: BookingRestore;
  },
): DayResponse {
  const index = indexDay(day);
  const comedian = index.comedians.get(input.comedianId);
  const show = index.shows.get(input.showId);
  if (!comedian || !show) return day;
  const unavailable = !isAvailableFor(comedian.availability, show.startMin);
  const { restore } = input;
  const base = input.replaceBookingId != null ? removeBooking(day, input.replaceBookingId) : day;
  return upsertBookings(base, [
    {
      id: input.tempId,
      showId: show.id,
      position: input.position,
      comedianId: comedian.id,
      comedianName: comedian.name,
      status: restore ? bookingStatus(restore, day.date, day.today) : freshStatus(day),
      overrideUnavailable: restore ? restore.overrideUnavailable || unavailable : unavailable,
      confirmedAt: restore?.confirmedAt ?? null,
      confirmedBy: restore?.confirmedBy ?? null,
      confirmationSentAt: restore?.confirmationSentAt ?? null,
    },
  ]);
}

export function applyMove(
  day: DayResponse,
  input: { bookingId: number; showId: number; position: number },
): DayResponse {
  const index = indexDay(day);
  const moving = index.bookings.get(input.bookingId);
  const target = index.shows.get(input.showId);
  if (!moving || !target) return day;
  const source = index.shows.get(moving.showId)!;
  const sameShow = source.id === target.id;
  const occupant = target.bookings.find((b) => b.position === input.position && b.id !== moving.id) ?? null;

  // A different show is a different spot: confirmation starts over, override re-evaluated.
  const reset = (booking: LineupBooking, show: DayShow): Partial<LineupBooking> => {
    if (sameShow) return {};
    const comedian = index.comedians.get(booking.comedianId);
    return {
      confirmedAt: null,
      confirmedBy: null,
      confirmationSentAt: null,
      status: freshStatus(day),
      overrideUnavailable: comedian ? !isAvailableFor(comedian.availability, show.startMin) : booking.overrideUnavailable,
    };
  };

  const moved: LineupBooking = { ...moving, showId: target.id, position: input.position, ...reset(moving, target) };
  const swapped: LineupBooking[] = occupant
    ? [{ ...occupant, showId: source.id, position: moving.position, ...reset(occupant, source) }]
    : [];
  return upsertBookings(day, [moved, ...swapped]);
}

export function applySlotCount(day: DayResponse, showId: number, slotCount: number): DayResponse {
  return { ...day, shows: day.shows.map((s) => (s.id === showId ? { ...s, slotCount } : s)) };
}

/** The fewest slots a show can have without dropping a booked slot. */
export function minSlotCount(show: DayShow): number {
  return Math.max(1, ...show.bookings.map((b) => b.position + 1));
}

// ---------------------------------------------------------------------------
// Copy as text
// ---------------------------------------------------------------------------

export function lineupText(day: Pick<DayResponse, 'date'>, show: DayShow, withDate = true): string {
  const heading = [withDate ? formatDateMedium(day.date) : null, formatTime(show.startMin), show.name || null, show.location.name]
    .filter(Boolean)
    .join(' · ');
  const byPos = new Map(show.bookings.map((b) => [b.position, b]));
  const lines = Array.from({ length: show.slotCount }, (_, i) => `${i + 1}. ${byPos.get(i)?.comedianName ?? '—'}`);
  return [heading, ...lines].join('\n');
}

export function dayText(day: DayResponse): string {
  return [formatDateLong(day.date), ...day.shows.map((s) => lineupText(day, s, false))].join('\n\n');
}

// ---------------------------------------------------------------------------
// Pool filtering
// ---------------------------------------------------------------------------

export interface PoolFilter {
  search: string;
  tagIds: number[];
  availableOnly: boolean;
}

/** Search by name (or tag name), any of the selected tags, then available first by name. */
export function filterPool(comedians: DayComedian[], filter: PoolFilter): DayComedian[] {
  const q = filter.search.trim().toLowerCase();
  const tagIds = new Set(filter.tagIds);
  return comedians
    .filter((c) => !filter.availableOnly || c.availability != null)
    .filter((c) => tagIds.size === 0 || c.tags.some((t) => tagIds.has(t.id)))
    .filter(
      (c) => !q || c.name.toLowerCase().includes(q) || c.tags.some((t) => t.name.toLowerCase().startsWith(q)),
    )
    .sort(
      (a, b) =>
        Number(b.availability != null) - Number(a.availability != null) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
}

// ---------------------------------------------------------------------------
// "Book anyway?" copy
// ---------------------------------------------------------------------------

/**
 * Why a comedian isn't available, for the warning modal (spec §6 F2):
 * "Jason marked 9–11 PM for Nov 8" / "hasn't marked Nov 8" / "hasn't submitted November".
 */
export function unavailableReason(conflict: UnavailableConflict): string {
  const who = firstName(conflict.comedianName);
  const day = formatDateShort(conflict.date);
  if (conflict.availability) {
    const { startMin, endMin } = conflict.availability;
    return `${who} marked ${formatRange(startMin, endMin)} for ${day}, and this show starts at ${formatTime(conflict.startMin)}.`;
  }
  if (conflict.submittedMonth) return `${who} hasn't marked ${day} as available.`;
  return `${who} hasn't submitted ${formatMonthName(conflict.month)} availability.`;
}
