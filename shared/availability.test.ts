import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALL_NIGHT,
  availabilityState,
  formatAvailability,
  isAvailableFor,
  isValidAvailabilityRange,
} from './availability';

describe('isAvailableFor', () => {
  const nineToEleven = { startMin: 1260, endMin: 1380 };

  it('is inclusive at both ends', () => {
    expect(isAvailableFor(nineToEleven, 1260)).toBe(true);
    expect(isAvailableFor(nineToEleven, 1380)).toBe(true);
    expect(isAvailableFor(nineToEleven, 1320)).toBe(true);
  });

  it('is false outside the range', () => {
    expect(isAvailableFor(nineToEleven, 1259)).toBe(false);
    expect(isAvailableFor(nineToEleven, 1381)).toBe(false);
    expect(isAvailableFor(nineToEleven, 1140)).toBe(false);
  });

  it('is false with no row for the date', () => {
    expect(isAvailableFor(null, 1260)).toBe(false);
    expect(isAvailableFor(undefined, 1260)).toBe(false);
  });

  it('handles after-midnight times', () => {
    expect(isAvailableFor({ startMin: 1320, endMin: 1500 }, 1470)).toBe(true);
  });
});

describe('range helpers', () => {
  it('validates ranges inside 4 PM–2 AM with start < end', () => {
    expect(isValidAvailabilityRange({ startMin: 960, endMin: 1560 })).toBe(true);
    expect(isValidAvailabilityRange({ startMin: 1140, endMin: 1380 })).toBe(true);
    expect(isValidAvailabilityRange({ startMin: 930, endMin: 1380 })).toBe(false);
    expect(isValidAvailabilityRange({ startMin: 1140, endMin: 1590 })).toBe(false);
    expect(isValidAvailabilityRange({ startMin: 1380, endMin: 1380 })).toBe(false);
    expect(isValidAvailabilityRange({ startMin: 1140.5, endMin: 1380 })).toBe(false);
  });

  it('labels all-night ranges', () => {
    expect(formatAvailability(DEFAULT_ALL_NIGHT, DEFAULT_ALL_NIGHT)).toBe('All night');
    expect(formatAvailability({ startMin: 1260, endMin: 1380 }, DEFAULT_ALL_NIGHT)).toBe('9–11 PM');
    expect(formatAvailability(DEFAULT_ALL_NIGHT)).toBe('7–11 PM');
  });

  it('distinguishes unavailable from not submitted', () => {
    expect(availabilityState({ startMin: 1140, endMin: 1380 }, true)).toBe('available');
    expect(availabilityState(null, true)).toBe('unavailable');
    expect(availabilityState(null, false)).toBe('not_submitted');
  });
});
