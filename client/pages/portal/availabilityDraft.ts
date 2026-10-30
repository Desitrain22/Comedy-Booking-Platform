/**
 * Pure logic behind the availability painter (/portal). A *draft* is the month's nights
 * as the comedian is editing them: date → range, one range per night. Nothing persists
 * until Save, which sends `entriesFromDraft(draft)` as the whole month.
 */
import {
  AVAILABILITY_MAX_END,
  AVAILABILITY_MIN_START,
  isSameRange,
  type AvailabilityEntry,
  type AvailabilityRange,
} from '../../../shared/availability';
import { AVAILABILITY_STEP_MIN } from '../../../shared/api/portal';
import { datesForWeekday, formatRange, timeOptions, type TimeOption } from '../../../shared/time';

export type Draft = ReadonlyMap<string, AvailabilityRange>;

/** What a tap or drag paints: the club's all-night range, a custom range, or "not available" (erase). */
export type BrushKind = 'allNight' | 'custom' | 'off';

export function draftFromEntries(entries: readonly AvailabilityEntry[]): Draft {
  return new Map(entries.map((e) => [e.date, { startMin: e.startMin, endMin: e.endMin }]));
}

/** The draft as a sorted entry list (the PUT body), optionally only nights on/after `from`. */
export function entriesFromDraft(draft: Draft, from?: string): AvailabilityEntry[] {
  return [...draft]
    .filter(([date]) => !from || date >= from)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, r]) => ({ date, startMin: r.startMin, endMin: r.endMin }));
}

/**
 * Paint `dates` with `range` (null erases). Painting over a night replaces its range.
 * Returns the same object when nothing changes, so React can skip the re-render.
 */
export function paint(draft: Draft, dates: readonly string[], range: AvailabilityRange | null): Draft {
  let next: Map<string, AvailabilityRange> | null = null;
  for (const date of dates) {
    const current = (next ?? draft).get(date);
    const unchanged = range ? current != null && isSameRange(current, range) : current == null;
    if (unchanged) continue;
    next ??= new Map(draft);
    if (range) next.set(date, { startMin: range.startMin, endMin: range.endMin });
    else next.delete(date);
  }
  return next ?? draft;
}

export function sameDraft(a: Draft, b: Draft): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [date, range] of a) {
    const other = b.get(date);
    if (!other || !isSameRange(range, other)) return false;
  }
  return true;
}

/** Every day of `weekday` (0 = Sun) in the month that isn't before `today`. */
export function paintableWeekdayDates(month: string, weekday: number, today: string): string[] {
  return datesForWeekday(month, weekday).filter((d) => d >= today);
}

/** Start-time options: 4 PM … 1:30 AM, half-hour steps. */
export const START_OPTIONS: readonly TimeOption[] = timeOptions(
  AVAILABILITY_MIN_START,
  AVAILABILITY_MAX_END - AVAILABILITY_STEP_MIN,
  AVAILABILITY_STEP_MIN,
);

/** End-time options: 4:30 PM … 2 AM, half-hour steps. */
export const END_OPTIONS: readonly TimeOption[] = timeOptions(
  AVAILABILITY_MIN_START + AVAILABILITY_STEP_MIN,
  AVAILABILITY_MAX_END,
  AVAILABILITY_STEP_MIN,
);

/** A new start keeps the end when it's still later; otherwise the end moves to start + 2h (capped at 2 AM). */
export function withStart(range: AvailabilityRange, startMin: number): AvailabilityRange {
  if (range.endMin > startMin) return { startMin, endMin: range.endMin };
  return { startMin, endMin: Math.min(startMin + 120, AVAILABILITY_MAX_END) };
}

/** A new end keeps the start when it's still earlier; otherwise the start moves to end − 2h (not before 4 PM). */
export function withEnd(range: AvailabilityRange, endMin: number): AvailabilityRange {
  if (range.startMin < endMin) return { startMin: range.startMin, endMin };
  return { startMin: Math.max(endMin - 120, AVAILABILITY_MIN_START), endMin };
}

/**
 * The label painted into a day: "All night" for the club's all-night range, else the
 * compact range ("9–11 PM", "10 PM–12 AM"). `[before, after]` split at the dash so the
 * cell can wrap there on narrow phones.
 */
export function dayLabel(range: AvailabilityRange, allNight: AvailabilityRange): { allNight: boolean; parts: [string, string] } {
  const text = formatRange(range.startMin, range.endMin);
  const dash = text.indexOf('–');
  const parts: [string, string] = dash < 0 ? [text, ''] : [text.slice(0, dash + 1), text.slice(dash + 1)];
  return { allNight: isSameRange(range, allNight), parts };
}

// ---------------------------------------------------------------------------
// Editing history: Undo (one paint stroke / weekday tap at a time) and Discard
// ---------------------------------------------------------------------------

/** How many steps Undo remembers. */
export const UNDO_LIMIT = 50;

export interface EditorState {
  draft: Draft;
  /** The draft before each step, oldest first; Undo restores the last one. */
  history: readonly Draft[];
  /** The paint gesture in progress: one drag is one undo step. */
  stroke: number | null;
}

export type EditorAction =
  /** Paint `dates` (null range erases). `stroke` groups a drag (MonthGrid's gesture id); omit for one-off taps. */
  | { type: 'paint'; dates: readonly string[]; range: AvailabilityRange | null; stroke?: number }
  /** The drag ended (pointer up / cancel). A drag that changed nothing leaves no undo step. */
  | { type: 'strokeEnd'; stroke: number }
  | { type: 'undo' }
  /** Back to what's saved — itself undoable. */
  | { type: 'discard'; saved: Draft }
  /** Saved: keep the draft, forget the history (the saved state is the new baseline). */
  | { type: 'saved' }
  /** Start over from `draft` (fresh server data). */
  | { type: 'reset'; draft: Draft };

export function initEditor(draft: Draft): EditorState {
  return { draft, history: [], stroke: null };
}

function remember(history: readonly Draft[], draft: Draft): readonly Draft[] {
  const next = [...history, draft];
  return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
}

/**
 * Pure reducer behind the availability editor. Painting stays immediate (no press-and-hold);
 * a mistaken drag — e.g. a vertical swipe on a phone that painted instead of scrolling —
 * is one tap of Undo away.
 */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'paint': {
      const draft = paint(state.draft, action.dates, action.range);
      if (action.stroke !== undefined && action.stroke === state.stroke) {
        return draft === state.draft ? state : { ...state, draft };
      }
      // A new drag (remember even if its first day is unchanged: later days may change),
      // or a one-off tap that changed something.
      if (action.stroke === undefined && draft === state.draft) return state;
      return { draft, history: remember(state.history, state.draft), stroke: action.stroke ?? null };
    }
    case 'strokeEnd': {
      if (state.stroke !== action.stroke) return state;
      const before = state.history[state.history.length - 1];
      if (before && sameDraft(before, state.draft)) return { ...state, history: state.history.slice(0, -1), stroke: null };
      return { ...state, stroke: null };
    }
    case 'undo': {
      const before = state.history[state.history.length - 1];
      if (!before) return state;
      return { draft: before, history: state.history.slice(0, -1), stroke: null };
    }
    case 'discard':
      if (sameDraft(state.draft, action.saved)) return state;
      return { draft: action.saved, history: remember(state.history, state.draft), stroke: null };
    case 'saved':
      return state.history.length === 0 ? state : { ...state, history: [] };
    case 'reset':
      return initEditor(action.draft);
  }
}
