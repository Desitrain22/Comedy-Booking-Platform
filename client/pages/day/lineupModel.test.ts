import { describe, expect, it } from 'vitest';
import type { DayComedian, DayResponse, DayShow, LineupBooking } from '../../../shared/api/lineup';
import {
  applyBook,
  applyMove,
  applySlotCount,
  dayText,
  filterPool,
  indexDay,
  lineupText,
  minSlotCount,
  planDrop,
  removeBooking,
  replaceBooking,
  showFit,
  unavailableReason,
} from './lineupModel';

const DATE = '2026-11-07';
const cellar = { id: 1, name: 'The Cellar', color: '#7c5cff', address: '' };
const annex = { id: 2, name: 'The Annex', color: '#f08c2e', address: '' };

function booking(id: number, showId: number, position: number, comedianId: number, name: string, extra: Partial<LineupBooking> = {}): LineupBooking {
  return {
    id,
    showId,
    position,
    comedianId,
    comedianName: name,
    status: 'not_sent',
    overrideUnavailable: false,
    confirmedAt: null,
    confirmedBy: null,
    confirmationSentAt: null,
    ...extra,
  };
}

function show(id: number, startMin: number, bookings: LineupBooking[], extra: Partial<DayShow> = {}): DayShow {
  return { id, date: DATE, location: cellar, startMin, name: '', slotCount: 4, status: 'scheduled', notes: '', bookings, ...extra };
}

function comedian(id: number, name: string, extra: Partial<DayComedian> = {}): DayComedian {
  return { id, name, headshotUrl: '', tags: [], availability: { startMin: 1140, endMin: 1380 }, submittedMonth: true, bookings: [], ...extra };
}

/**
 * 7 PM: [Ann (confirmed), _, Bo, _]   9 PM: [Cy, _, _, _]   midnight (Annex): [_, Dee, _, _]
 * Ann/Bo/Cy are free 7–11 PM; Dee marked 10 PM–1 AM; Eve hasn't submitted.
 */
function makeDay(): DayResponse {
  const confirmed = { status: 'confirmed' as const, confirmedAt: 5, confirmedBy: 'comedian' as const, confirmationSentAt: 1 };
  return {
    date: DATE,
    today: '2026-10-28',
    shows: [
      show(10, 1140, [booking(100, 10, 0, 1, 'Ann Lee', confirmed), booking(101, 10, 2, 2, 'Bo Diaz')], { name: 'Early Show' }),
      show(11, 1260, [booking(102, 11, 0, 3, 'Cy Moss', confirmed)]),
      show(12, 1440, [booking(103, 12, 1, 4, 'Dee Park')], { location: annex, name: 'Late' }),
    ],
    comedians: [
      comedian(1, 'Ann Lee', { tags: [{ id: 1, name: 'Hosts', color: '#3b82f6' }] }),
      comedian(2, 'Bo Diaz'),
      comedian(3, 'Cy Moss', { tags: [{ id: 2, name: 'All Stars', color: '#d946ef' }] }),
      comedian(4, 'Dee Park', { availability: { startMin: 1320, endMin: 1500 } }),
      comedian(5, 'Eve Stone', { availability: null, submittedMonth: false }),
      comedian(6, 'Fay Wu', { availability: null }),
    ],
    tags: [],
  };
}

const slot = (showId: number, position: number) => ({ kind: 'slot' as const, showId, position });

describe('planDrop', () => {
  const day = makeDay();

  it('books an available comedian into an empty slot', () => {
    expect(planDrop(day, { kind: 'comedian', comedianId: 2 }, slot(11, 1))).toEqual({
      kind: 'book',
      comedianId: 2,
      showId: 11,
      position: 1,
      replacing: null,
      conflicts: [],
    });
  });

  it('flags an unavailable comedian with what they marked', () => {
    const plan = planDrop(day, { kind: 'comedian', comedianId: 4 }, slot(10, 1));
    expect(plan).toMatchObject({
      kind: 'book',
      conflicts: [{ comedianId: 4, showId: 10, startMin: 1140, month: '2026-11', availability: { startMin: 1320, endMin: 1500 }, submittedMonth: true }],
    });
  });

  it('replaces the occupant of a taken slot, still checking the newcomer’s availability', () => {
    // Fay (available) onto Bo's slot.
    expect(planDrop(day, { kind: 'comedian', comedianId: 6 }, slot(10, 2))).toMatchObject({
      kind: 'book',
      comedianId: 6,
      showId: 10,
      position: 2,
      replacing: { id: 101, comedianName: 'Bo Diaz' },
    });
    // Eve hasn't submitted: replacing Ann still asks first.
    const plan = planDrop(day, { kind: 'comedian', comedianId: 5 }, slot(10, 0));
    expect(plan).toMatchObject({ kind: 'book', replacing: { id: 100 }, conflicts: [{ comedianId: 5, submittedMonth: false }] });
    // An occupant that hasn't saved yet can't be replaced.
    const pending = makeDay();
    pending.shows[1]!.bookings.push(booking(-3, 11, 1, 2, 'Bo Diaz'));
    expect(planDrop(pending, { kind: 'comedian', comedianId: 6 }, slot(11, 1))).toMatchObject({ kind: 'reject' });
  });

  it('rejects duplicates from the pool', () => {
    expect(planDrop(day, { kind: 'comedian', comedianId: 1 }, slot(10, 3))).toMatchObject({ kind: 'reject' });
    expect(planDrop(day, { kind: 'comedian', comedianId: 2 }, slot(10, 0))).toMatchObject({ kind: 'reject' }); // Bo is in it
    expect(planDrop(day, { kind: 'comedian', comedianId: 1 }, slot(10, 0))).toEqual({ kind: 'none' });
    expect(planDrop(day, { kind: 'comedian', comedianId: 5 }, slot(10, 4))).toEqual({ kind: 'none' }); // past slotCount
  });

  it('moves and swaps within a show without availability checks', () => {
    expect(planDrop(day, { kind: 'booking', bookingId: 100 }, slot(10, 3))).toMatchObject({ kind: 'move', swapWith: null, conflicts: [] });
    expect(planDrop(day, { kind: 'booking', bookingId: 100 }, slot(10, 2))).toMatchObject({
      kind: 'move',
      swapWith: { id: 101 },
      conflicts: [],
    });
    expect(planDrop(day, { kind: 'booking', bookingId: 100 }, slot(10, 0))).toEqual({ kind: 'none' });
  });

  it('re-checks both comedians on a cross-show swap', () => {
    const plan = planDrop(day, { kind: 'booking', bookingId: 101 }, slot(12, 1)); // Bo → midnight, Dee → 7 PM
    expect(plan).toMatchObject({ kind: 'move', swapWith: { id: 103 } });
    expect(plan.kind === 'move' && plan.conflicts.map((c) => [c.comedianName, c.showId])).toEqual([
      ['Bo Diaz', 12],
      ['Dee Park', 10],
    ]);
  });

  it('rejects moves that would put someone in a show twice', () => {
    const d = makeDay();
    d.shows[1]!.bookings.push(booking(104, 11, 3, 1, 'Ann Lee'));
    // Ann's 7 PM booking into the 9 PM, where she already is.
    expect(planDrop(d, { kind: 'booking', bookingId: 100 }, slot(11, 1))).toMatchObject({ kind: 'reject' });
    // Bo (7 PM) onto Ann's 9 PM slot: the swap would put Ann in the 7 PM twice.
    expect(planDrop(d, { kind: 'booking', bookingId: 101 }, slot(11, 3))).toMatchObject({ kind: 'reject' });
  });

  it('unbooks when a chip is dropped on the pool', () => {
    expect(planDrop(day, { kind: 'booking', bookingId: 102 }, { kind: 'pool' })).toEqual({ kind: 'unbook', bookingId: 102 });
    expect(planDrop(day, { kind: 'comedian', comedianId: 2 }, { kind: 'pool' })).toEqual({ kind: 'none' });
  });
});

describe('optimistic transforms', () => {
  it('applyBook adds a temp booking with the derived override flag', () => {
    const next = applyBook(makeDay(), { tempId: -1, comedianId: 4, showId: 10, position: 1 });
    expect(next.shows[0]!.bookings.map((b) => [b.id, b.position])).toEqual([
      [100, 0],
      [-1, 1],
      [101, 2],
    ]);
    expect(indexDay(next).bookings.get(-1)).toMatchObject({ comedianName: 'Dee Park', overrideUnavailable: true, status: 'not_sent' });
    expect(indexDay(next).bookingsByComedian.get(4)!.map((b) => b.showId)).toEqual([10, 12]);
  });

  it('applyBook replacing an occupant drops them; restore brings back the confirmation', () => {
    const replaced = applyBook(makeDay(), { tempId: -2, comedianId: 6, showId: 10, position: 0, replaceBookingId: 100 });
    expect(replaced.shows[0]!.bookings.map((b) => [b.id, b.comedianName])).toEqual([
      [-2, 'Fay Wu'],
      [101, 'Bo Diaz'],
    ]);

    const restore = {
      overrideUnavailable: false,
      confirmationSentAt: 1,
      confirmedAt: 5,
      confirmedBy: 'comedian' as const,
      bookedById: 9,
      createdAt: 0,
    };
    const undone = applyBook(replaced, { tempId: -3, comedianId: 1, showId: 10, position: 0, replaceBookingId: -2, restore });
    expect(indexDay(undone).bookings.has(-2)).toBe(false);
    expect(indexDay(undone).bookings.get(-3)).toMatchObject({
      comedianName: 'Ann Lee',
      status: 'confirmed',
      confirmedAt: 5,
      confirmedBy: 'comedian',
      confirmationSentAt: 1,
      overrideUnavailable: false,
    });
  });

  it('applyMove within a show keeps confirmation; across shows resets it', () => {
    const day = makeDay();
    const within = applyMove(day, { bookingId: 100, showId: 10, position: 2 });
    expect(within.shows[0]!.bookings.map((b) => [b.id, b.position, b.status])).toEqual([
      [101, 0, 'not_sent'],
      [100, 2, 'confirmed'],
    ]);
    expect(within.shows[1]).toBe(day.shows[1]); // untouched shows keep identity

    const across = applyMove(day, { bookingId: 100, showId: 11, position: 0 }); // swap with Cy
    const idx = indexDay(across);
    expect(idx.bookings.get(100)).toMatchObject({ showId: 11, position: 0, status: 'not_sent', confirmedAt: null });
    expect(idx.bookings.get(102)).toMatchObject({ showId: 10, position: 0, status: 'not_sent', confirmedAt: null });
  });

  it('applyMove marks the override when moving someone into a show they did not mark', () => {
    const next = applyMove(makeDay(), { bookingId: 101, showId: 12, position: 3 });
    expect(indexDay(next).bookings.get(101)).toMatchObject({ showId: 12, overrideUnavailable: true });
  });

  it('remove / replace / slot count', () => {
    const day = makeDay();
    expect(indexDay(removeBooking(day, 101)).bookings.has(101)).toBe(false);
    const temp = applyBook(day, { tempId: -7, comedianId: 2, showId: 11, position: 2 });
    const real = replaceBooking(temp, -7, booking(200, 11, 2, 2, 'Bo Diaz'));
    expect(real.shows[1]!.bookings.map((b) => b.id)).toEqual([102, 200]);
    expect(applySlotCount(day, 11, 7).shows[1]!.slotCount).toBe(7);
    expect(minSlotCount(day.shows[0]!)).toBe(3);
    expect(minSlotCount(show(1, 1200, []))).toBe(1);
  });
});

describe('showFit', () => {
  it('says whether the focused comedian fits each show', () => {
    const day = makeDay();
    expect(showFit(day, 1, day.shows[0]!)).toBe('in_show');
    expect(showFit(day, 2, day.shows[1]!)).toBe('available');
    expect(showFit(day, 2, day.shows[2]!)).toBe('unavailable');
    expect(showFit(day, 99, day.shows[2]!)).toBeNull();
  });
});

describe('filterPool', () => {
  const day = makeDay();
  const names = (filter: Parameters<typeof filterPool>[1]) => filterPool(day.comedians, filter).map((c) => c.name);

  it('sorts available first, then by name', () => {
    expect(names({ search: '', tagIds: [], availableOnly: false })).toEqual([
      'Ann Lee',
      'Bo Diaz',
      'Cy Moss',
      'Dee Park',
      'Eve Stone',
      'Fay Wu',
    ]);
  });

  it('filters by availability, any selected tag, and search (name or tag)', () => {
    expect(names({ search: '', tagIds: [], availableOnly: true })).toEqual(['Ann Lee', 'Bo Diaz', 'Cy Moss', 'Dee Park']);
    expect(names({ search: '', tagIds: [1, 2], availableOnly: false })).toEqual(['Ann Lee', 'Cy Moss']);
    expect(names({ search: 'park', tagIds: [], availableOnly: false })).toEqual(['Dee Park']);
    expect(names({ search: 'all', tagIds: [], availableOnly: false })).toEqual(['Cy Moss']);
  });
});

describe('copy text and modal copy', () => {
  it('lineupText lists every slot', () => {
    const day = makeDay();
    expect(lineupText(day, day.shows[0]!)).toBe('Sat, Nov 7 · 7 PM · Early Show · The Cellar\n1. Ann Lee\n2. —\n3. Bo Diaz\n4. —');
    expect(dayText(day).split('\n\n')[0]).toBe('Saturday, Nov 7');
  });

  it('unavailableReason covers marked / not marked / not submitted', () => {
    const base = { comedianId: 1, comedianName: 'Jason Park', showId: 1, date: '2026-11-08', startMin: 1410, month: '2026-11' };
    expect(unavailableReason({ ...base, availability: { startMin: 1260, endMin: 1380 }, submittedMonth: true })).toBe(
      'Jason marked 9–11 PM for Nov 8, and this show starts at 11:30 PM.',
    );
    expect(unavailableReason({ ...base, availability: null, submittedMonth: true })).toBe("Jason hasn't marked Nov 8 as available.");
    expect(unavailableReason({ ...base, availability: null, submittedMonth: false })).toBe(
      "Jason hasn't submitted November availability.",
    );
  });
});
