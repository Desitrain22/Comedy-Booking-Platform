import { describe, expect, it } from 'vitest';
import type { DayComedian, DayResponse, DayShow, LineupBooking } from '../../../shared/api/lineup';
import {
  applyBook,
  applyMove,
  applySlotCount,
  activeBookings,
  dayText,
  filterPool,
  fitFor,
  indexDay,
  isFreeFor,
  lineupText,
  minSlotCount,
  overlapFor,
  overlapWarning,
  planDrop,
  poolCounts,
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
    declinedAt: null,
    declineNote: '',
    ...extra,
  };
}

function show(id: number, startMin: number, bookings: LineupBooking[], extra: Partial<DayShow> = {}): DayShow {
  return { id, date: DATE, location: cellar, startMin, name: '', slotCount: 4, status: 'scheduled', notes: '', bookings, ...extra };
}

function comedian(id: number, name: string, extra: Partial<DayComedian> = {}): DayComedian {
  return { id, name, headshotUrl: '', tags: [], availability: { startMin: 1140, endMin: 1380 }, submittedMonth: true, bookings: [], noteCount: 0, latestNote: null, ...extra };
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
    unsentThisWeek: { weekStart: '2026-10-26', weekEnd: '2026-11-01', count: 0 },
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
      declinedAt: null,
      declineNote: '',
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
  const names = (filter: Parameters<typeof filterPool>[1]) => filterPool(day, filter).map((c) => c.name);

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

// ---------------------------------------------------------------------------
// Fix round: pool fit for a focused show (UX A3), overlaps (UX B11), declines
// ---------------------------------------------------------------------------

/** makeDay() plus a 7:30 PM Annex show, a free comedian (Gus) and a declined booking (Bo at 9 PM). */
function busyDay(): DayResponse {
  const day = makeDay();
  return {
    ...day,
    shows: [
      ...day.shows.slice(0, 1),
      { ...day.shows[1]!, bookings: [...day.shows[1]!.bookings, booking(104, 11, 3, 2, 'Bo Diaz', { status: 'declined', declinedAt: 9 })] },
      day.shows[2]!,
      show(13, 1170, [], { location: annex }),
    ],
    comedians: [...day.comedians, comedian(7, 'Gus Free')],
  };
}

describe('fitFor / overlapFor (a show’s time vs. each comedian)', () => {
  const day = busyDay();
  const idx = indexDay(day);
  const fit = (comedianId: number, showId: number) => fitFor(day, idx.comedians.get(comedianId)!, idx.shows.get(showId)!);

  it('fits / outside their hours / unavailable / not marked / in the show', () => {
    expect(fit(7, 11)).toEqual({ kind: 'fits', overlap: null, bookedTonight: false, declinedTonight: false });
    expect(fit(4, 11).kind).toBe('outside'); // Dee marked 10 PM–1 AM, the show is at 9
    expect(fit(6, 11).kind).toBe('unavailable'); // Fay submitted, left the night blank
    expect(fit(5, 11).kind).toBe('not_marked'); // Eve hasn't submitted
    expect(fit(3, 11)).toMatchObject({ kind: 'in_show', overlap: null, bookedTonight: true });
  });

  it('flags another booking that starts less than 90 minutes away (B11)', () => {
    // Ann is booked at 7 PM (Cellar); the 7:30 PM Annex show "fits" her range but clashes.
    const ann = fit(1, 13);
    expect(ann.kind).toBe('fits');
    expect(ann.overlap).toMatchObject({ gap: 30, booking: { id: 100 }, show: { id: 10 } });
    expect(isFreeFor(ann)).toBe(false);
    // 9 PM is two hours after her 7 PM spot: no clash.
    expect(fit(1, 11)).toMatchObject({ kind: 'fits', overlap: null, bookedTonight: true });
    expect(isFreeFor(fit(1, 11))).toBe(true);
    // Exactly 90 minutes apart is not "within" 90 (7:30 → 9 PM).
    expect(overlapFor(day, 1, { id: 99, startMin: 1140 + 90 })).toBeNull();
    expect(overlapFor(day, 1, { id: 99, startMin: 1140 + 89 })).toMatchObject({ gap: 89 });
    expect(overlapWarning(day, 1, idx.shows.get(13)!)).toBe('Ann is also booked at 7 PM · The Cellar (30 min earlier).');
    expect(overlapWarning(day, 3, idx.shows.get(10)!)).toBeNull();
  });

  it('ignores the booking that is moving, and declined bookings', () => {
    // Moving Ann's own 7 PM booking to 7:30 doesn't clash with itself.
    expect(overlapFor(day, 1, { id: 13, startMin: 1170 }, 100)).toBeNull();
    // Bo declined 9 PM: not "booked" there, so 8 PM elsewhere doesn't clash with it.
    expect(activeBookings(day, 2).map((b) => b.id)).toEqual([101]);
    expect(overlapFor(day, 2, { id: 99, startMin: 1230 })).toBeNull();
  });
});

describe('the pool with and without a focused show (A3)', () => {
  const day = busyDay();
  const idx = indexDay(day);
  const none = { search: '', tagIds: [], availableOnly: false };

  it('no focus: free (available, not booked) before already-booked, then everyone else', () => {
    expect(filterPool(day, none).map((c) => c.name)).toEqual([
      'Gus Free',
      'Ann Lee',
      'Bo Diaz',
      'Cy Moss',
      'Dee Park',
      'Eve Stone',
      'Fay Wu',
    ]);
    // Honest header: Gus is the only one free; Ann, Bo, Cy and Dee are booked (Bo's decline doesn't count).
    expect(poolCounts(day)).toEqual({ total: 7, free: 1, booked: 4 });
  });

  it('a focused 7:30 PM show: fits and unbooked first, then booked elsewhere, clashes, outside hours, …', () => {
    const focus = idx.shows.get(13)!;
    expect(filterPool(day, none, focus).map((c) => c.name)).toEqual([
      'Gus Free', // fits, not booked
      'Cy Moss', // fits, booked at 9 PM (90 min later: no clash)
      'Ann Lee', // fits, but booked at 7 PM (30 min)
      'Bo Diaz', // fits, but booked at 7 PM
      'Dee Park', // outside 10 PM–1 AM
      'Fay Wu', // unavailable
      'Eve Stone', // not marked
    ]);
    expect(poolCounts(day, focus)).toEqual({ total: 7, free: 2, booked: 4 });
    // "available only" with a focus = fits that show's time.
    expect(filterPool(day, { ...none, availableOnly: true }, focus).map((c) => c.name)).toEqual([
      'Gus Free',
      'Cy Moss',
      'Ann Lee',
      'Bo Diaz',
    ]);
  });

  it('a focused show puts the people already in it last', () => {
    const names = filterPool(day, none, idx.shows.get(10)!).map((c) => c.name);
    expect(names.slice(-2)).toEqual(['Ann Lee', 'Bo Diaz']);
  });
});

describe('declines in the optimistic transforms', () => {
  it('restore brings a decline back; a cross-show move clears it', () => {
    const day = busyDay();
    const restore = {
      overrideUnavailable: false,
      confirmationSentAt: 1,
      confirmedAt: null,
      confirmedBy: null,
      declinedAt: 9,
      declineNote: 'Sick',
      bookedById: null,
      createdAt: 0,
    };
    const back = applyBook(removeBooking(day, 104), { tempId: -9, comedianId: 2, showId: 11, position: 3, restore });
    expect(indexDay(back).bookings.get(-9)).toMatchObject({ status: 'declined', declinedAt: 9, declineNote: 'Sick' });

    const moved = applyMove(day, { bookingId: 104, showId: 13, position: 0 });
    expect(indexDay(moved).bookings.get(104)).toMatchObject({ showId: 13, status: 'not_sent', declinedAt: null, declineNote: '' });
    const within = applyMove(day, { bookingId: 104, showId: 11, position: 2 });
    expect(indexDay(within).bookings.get(104)).toMatchObject({ status: 'declined', declinedAt: 9 });
  });

  it('a comedian from another show dropped on a declined slot replaces it (no swap)', () => {
    const day = busyDay();
    // Ann (7 PM) onto Bo's declined 9 PM slot. A swap would even be refused (Bo is in the 7 PM).
    const plan = planDrop(day, { kind: 'booking', bookingId: 100 }, slot(11, 3));
    expect(plan).toMatchObject({ kind: 'move', bookingId: 100, swapWith: null, replacing: { id: 104 } });

    const moved = indexDay(applyMove(day, { bookingId: 100, showId: 11, position: 3 }));
    expect(moved.bookings.get(104)).toBeUndefined();
    expect(moved.bookings.get(100)).toMatchObject({ showId: 11, position: 3, status: 'not_sent', declinedAt: null });
    expect(moved.shows.get(10)!.bookings.map((b) => b.id)).toEqual([101]);

    // Within the declined booking's own show it's still a swap.
    expect(planDrop(day, { kind: 'booking', bookingId: 102 }, slot(11, 3))).toMatchObject({ swapWith: { id: 104 }, replacing: null });
  });
});

describe('someone who declined a spot tonight', () => {
  it('is not offered as free, with or without a focused show', () => {
    // Hal only has a declined 9 PM spot: available all night, but said he can't make it.
    const base = busyDay();
    const day: DayResponse = {
      ...base,
      shows: base.shows.map((s) =>
        s.id === 11 ? { ...s, bookings: [...s.bookings, booking(105, 11, 1, 8, 'Hal Moon', { status: 'declined', declinedAt: 3 })] } : s,
      ),
      comedians: [...base.comedians, comedian(8, 'Hal Moon')],
    };
    const none = { search: '', tagIds: [], availableOnly: false };
    expect(filterPool(day, none).map((c) => c.name).slice(0, 2)).toEqual(['Gus Free', 'Ann Lee']);
    expect(poolCounts(day)).toEqual({ total: 8, free: 1, booked: 4 });
    const focus = indexDay(day).shows.get(13)!;
    const hal = fitFor(day, indexDay(day).comedians.get(8)!, focus);
    expect(hal).toMatchObject({ kind: 'fits', declinedTonight: true, bookedTonight: false });
    expect(isFreeFor(hal)).toBe(false);
    expect(poolCounts(day, focus).free).toBe(2);
  });
});
