import { formatRange } from './time';

/** Earliest start a comedian can mark (4 PM). */
export const AVAILABILITY_MIN_START = 960;
/** Latest end a comedian can mark (2 AM the next morning). */
export const AVAILABILITY_MAX_END = 1560;
/** Default "All night" range (7–11 PM). The real values live in settings. */
export const DEFAULT_ALL_NIGHT: AvailabilityRange = { startMin: 1140, endMin: 1380 };

export interface AvailabilityRange {
  startMin: number;
  endMin: number;
}

export interface AvailabilityEntry extends AvailabilityRange {
  date: string;
}

/**
 * The single availability rule (spec §3): a comedian is available for a show iff they
 * have a row for the show's date and `startMin <= show.startMin <= endMin` (inclusive).
 */
export function isAvailableFor(
  row: AvailabilityRange | null | undefined,
  showStartMin: number,
): boolean {
  if (!row) return false;
  return row.startMin <= showStartMin && showStartMin <= row.endMin;
}

/** Integer minutes, inside [960, 1560], start strictly before end. */
export function isValidAvailabilityRange(range: AvailabilityRange): boolean {
  const { startMin, endMin } = range;
  return (
    Number.isInteger(startMin) &&
    Number.isInteger(endMin) &&
    startMin >= AVAILABILITY_MIN_START &&
    endMin <= AVAILABILITY_MAX_END &&
    startMin < endMin
  );
}

export function isSameRange(a: AvailabilityRange, b: AvailabilityRange): boolean {
  return a.startMin === b.startMin && a.endMin === b.endMin;
}

/** "All night" when the range equals the club's all-night default, else "9–11 PM". */
export function formatAvailability(range: AvailabilityRange, allNight?: AvailabilityRange): string {
  if (allNight && isSameRange(range, allNight)) return 'All night';
  return formatRange(range.startMin, range.endMin);
}

/**
 * How a comedian stands for one date, for pickers and badges:
 * - `available`: has a range that day
 * - `unavailable`: submitted the month but left the day blank
 * - `not_submitted`: has not submitted that month at all
 */
export type AvailabilityState = 'available' | 'unavailable' | 'not_submitted';

export function availabilityState(
  row: AvailabilityRange | null | undefined,
  submittedMonth: boolean,
): AvailabilityState {
  if (row) return 'available';
  return submittedMonth ? 'unavailable' : 'not_submitted';
}
