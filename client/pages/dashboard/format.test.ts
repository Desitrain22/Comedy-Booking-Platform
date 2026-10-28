import { describe, expect, it } from 'vitest';
import { firstNameOf, formatNextSend, formatWeekRange, percent, plural, relativeDay, spotLabel } from './format';

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
