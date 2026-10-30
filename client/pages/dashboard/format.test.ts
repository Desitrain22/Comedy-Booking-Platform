import { describe, expect, it } from 'vitest';
import type { AvailabilityRequestSummary, MonthAvailabilityProgress } from '../../../shared/api/dashboard';
import type { AvailabilityAudience } from '../../../shared/types';
import {
  askedLine,
  defaultRequestKind,
  firstNameOf,
  formatNextSend,
  formatWeekRange,
  percent,
  plural,
  relativeDay,
  setupSteps,
  showChecklist,
  spotLabel,
  tonightCounts,
  tonightSummary,
} from './format';

describe('dashboard format helpers', () => {
  it('pluralizes', () => {
    expect(plural(1, 'comedian')).toBe('1 comedian');
    expect(plural(0, 'comedian')).toBe('0 comedians');
    expect(plural(12, 'confirmation email')).toBe('12 confirmation emails');
    expect(plural(2, 'reply', 'replies')).toBe('2 replies');
  });

  it('names days relative to today', () => {
    expect(relativeDay('2026-10-28', '2026-10-28')).toBe('today');
    expect(relativeDay('2026-10-29', '2026-10-28')).toBe('tomorrow');
    expect(relativeDay('2026-11-02', '2026-10-28')).toBe('Mon, Nov 2');
    expect(formatNextSend({ date: '2026-11-02', startMin: 600, at: 0, weekStart: '2026-11-02' }, '2026-10-28')).toBe(
      'Mon, Nov 2 at 10 AM',
    );
    // Already due (a missed send the scheduler is about to catch up on).
    const due = { date: '2026-10-26', startMin: 600, at: 1_000, weekStart: '2026-10-26' };
    expect(formatNextSend(due, '2026-10-29', 2_000)).toBe('Any minute now');
    expect(formatNextSend(due, '2026-10-29', 500)).toBe('Mon, Oct 26 at 10 AM');
  });

  it('formats week ranges and spots', () => {
    expect(formatWeekRange('2026-10-26', '2026-11-01')).toBe('Oct 26 – Nov 1');
    expect(formatWeekRange('2026-11-02', '2026-11-08')).toBe('Nov 2 – 8');
    expect(spotLabel(1140, 'The Cellar')).toBe('7 PM @ The Cellar');
    expect(firstNameOf(' John Mercer ')).toBe('John');
  });

  it('computes percentages safely', () => {
    expect(percent(14, 32)).toBe(44);
    expect(percent(0, 0)).toBe(0);
  });
});

describe('tonight summary (ux#B12 zero-data copy)', () => {
  const counts = { shows: 3, booked: 14, confirmed: 12, unconfirmed: 2, declined: 0 };

  it('never says "all confirmed" when nobody is booked', () => {
    expect(tonightSummary({ ...counts, shows: 0, booked: 0, confirmed: 0, unconfirmed: 0 })).toBe('No shows tonight');
    expect(tonightSummary({ ...counts, booked: 0, confirmed: 0, unconfirmed: 0 })).toBe('3 shows tonight · No one is booked yet');
  });

  it('counts unconfirmed and declined separately', () => {
    expect(tonightSummary(counts)).toBe('3 shows tonight · 14 booked · 2 unconfirmed');
    expect(tonightSummary({ ...counts, confirmed: 14, unconfirmed: 0 })).toBe('3 shows tonight · 14 booked · all confirmed');
    expect(tonightSummary({ ...counts, shows: 1, confirmed: 13, unconfirmed: 0, declined: 1 })).toBe(
      '1 show tonight · 14 booked · 1 declined',
    );
  });

  it('derives the counts from the payload', () => {
    const show = (status: 'scheduled' | 'cancelled', statuses: string[], confirmedCount: number) => ({
      status,
      bookedCount: statuses.length,
      confirmedCount,
      bookings: statuses.map((s) => ({ status: s })),
    });
    const data = {
      tonight: [show('scheduled', ['confirmed', 'declined', 'awaiting'], 1), show('cancelled', ['awaiting'], 0)],
      unconfirmedTonight: [{}],
    } as unknown as Parameters<typeof tonightCounts>[0];
    expect(tonightCounts(data)).toEqual({ shows: 1, booked: 3, confirmed: 1, unconfirmed: 1, declined: 1 });
  });
});

describe('availability request defaults (ux#B7)', () => {
  const request = (sentAt: number, audience: AvailabilityAudience = 'all', audienceLabel = 'Everyone'): AvailabilityRequestSummary => ({
    id: 1,
    month: '2026-11',
    kind: 'request',
    audience,
    audienceLabel,
    message: '',
    recipientCount: 29,
    sentAt,
    sentByName: null,
  });
  const progress = (over: Partial<MonthAvailabilityProgress> = {}): MonthAvailabilityProgress => ({
    month: '2026-11',
    total: 29,
    submitted: 18,
    notSubmitted: 11,
    audiences: [],
    lastRequest: null,
    lastReminder: null,
    ...over,
  });
  // Oct 22, 2026 3 PM in New York.
  const OCT_22 = Date.UTC(2026, 9, 22, 19);

  it('defaults to a reminder once the month was asked for and someone is missing', () => {
    expect(defaultRequestKind(undefined)).toBe('request');
    expect(defaultRequestKind(progress())).toBe('request');
    expect(defaultRequestKind(progress({ lastRequest: request(OCT_22) }))).toBe('reminder');
    expect(defaultRequestKind(progress({ lastRequest: request(OCT_22), submitted: 29, notSubmitted: 0 }))).toBe('request');
  });

  it('says when the month was asked for and how many have submitted', () => {
    expect(askedLine(progress(), 'America/New_York')).toBeNull();
    expect(askedLine(progress({ lastRequest: request(OCT_22) }), 'America/New_York')).toBe(
      'You asked on Oct 22 · 18 of 29 have submitted',
    );
    // 11 PM Oct 22 in Los Angeles is already Oct 23 in UTC: the club's date wins.
    const lateLa = Date.UTC(2026, 9, 23, 6);
    expect(askedLine(progress({ lastRequest: request(lateLa, 'tag:2', 'Hosts'), submitted: 1 }), 'America/Los_Angeles')).toBe(
      'You asked Hosts on Oct 22 · 1 of 29 has submitted',
    );
    const reminder = { ...request(OCT_22 + 5 * 86_400_000), kind: 'reminder' as const };
    expect(askedLine(progress({ lastRequest: request(OCT_22), lastReminder: reminder }), 'America/New_York')).toBe(
      'You asked on Oct 22 · reminded Oct 27 · 18 of 29 have submitted',
    );
  });
});

describe('getting started checklist (ux#B12)', () => {
  const fresh = { setup: { locations: 1, comedians: 0, shows: 0, availabilityRequests: 0 }, emailConfigured: false };

  it('lists the steps, with email only for admins', () => {
    expect(setupSteps(fresh, true).map((s) => [s.id, s.done])).toEqual([
      ['location', true],
      ['comedians', false],
      ['shows', false],
      ['email', false],
      ['availability', false],
    ]);
    expect(setupSteps(fresh, false).map((s) => s.id)).toEqual(['location', 'comedians', 'shows', 'availability']);
  });

  it('shows until done; a running club that only lacks email gets the banner instead', () => {
    expect(showChecklist(setupSteps(fresh, true))).toBe(true);
    const running = { setup: { locations: 2, comedians: 30, shows: 40, availabilityRequests: 3 }, emailConfigured: false };
    expect(showChecklist(setupSteps(running, true))).toBe(false);
    expect(showChecklist(setupSteps({ ...running, emailConfigured: true }, true))).toBe(false);
  });
});
