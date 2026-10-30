import { describe, expect, it } from 'vitest';
import { DECLINE_NOTE_MAX, declineLink, declineSpotSchema, defaultAvailabilityMonth } from './portal';

describe('decline contract', () => {
  it('builds the per-spot "Can\'t make it" link from a confirm link', () => {
    expect(declineLink('https://club.example/portal/confirm/abc123', 42)).toBe(
      'https://club.example/portal/confirm/abc123?decline=42',
    );
    expect(declineLink('http://localhost:5173/portal/confirm/t?x=1', 7)).toBe(
      'http://localhost:5173/portal/confirm/t?x=1&decline=7',
    );
  });

  it('accepts an optional, trimmed note up to the limit', () => {
    expect(declineSpotSchema.parse({})).toEqual({ note: '' });
    expect(declineSpotSchema.parse({ note: '  Sick, sorry  ' })).toEqual({ note: 'Sick, sorry' });
    expect(declineSpotSchema.safeParse({ note: 'x'.repeat(DECLINE_NOTE_MAX + 1) }).success).toBe(false);
  });
});

describe('defaultAvailabilityMonth', () => {
  it('is the planning month', () => {
    expect(defaultAvailabilityMonth('2026-11-19')).toBe('2026-11');
    expect(defaultAvailabilityMonth('2026-11-20')).toBe('2026-12');
  });
});
