/**
 * Shared Sun-first month calendar. One component, three modes:
 *
 * - **Paint** (`onPaint`): click, or press and drag across days with mouse, pen or touch
 *   (the grid sets `touch-action: none`, so on phones a drag paints instead of scrolling).
 *   The grid only reports which dates the pointer covered; the caller decides what
 *   painting means. Typical uses:
 *
 *     // F1 create-shows: a drag that starts on an unselected day adds, on a selected day removes.
 *     const modeRef = useRef<'add' | 'remove'>('add');
 *     onPaint={(dates, g) => {
 *       if (g.phase === 'start') modeRef.current = selected.has(g.origin) ? 'remove' : 'add';
 *       setSelected((prev) => applyMode(prev, dates, modeRef.current));
 *     }}
 *
 *     // F4 portal: every covered day gets the current brush (range, or erase).
 *     onPaint={(dates) => setEntries((prev) => paintWith(prev, dates, brush))}
 *
 * - **Click** (`onDayClick`, no `onPaint`): clicking a day (not an interactive element
 *   inside it) calls back, e.g. the F1 month calendar navigating to /app/day/:date.
 * - **Read-only**: neither callback (F3 comedian availability view).
 *
 * Day cells: the grid draws the cell box and the day number; `renderDay(date)` fills the
 * rest (pills, ranges). Style a day with `dayClassName(date)` (merged last, so it wins)
 * and size all cells with `cellClassName` (default `min-h-16`).
 *
 * Inside a paintable cell, native interactive elements (button, a, input, select,
 * textarea, label) and anything marked `data-no-paint` don't start a paint gesture.
 *
 * Keyboard: one tab stop; arrow keys move between days, Home/End jump to week start/end,
 * Enter/Space paints (gesture.pointerType 'keyboard') or clicks.
 */
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  addDays,
  formatDateLong,
  monthGrid,
  monthOf,
  WEEKDAY_LETTERS,
  WEEKDAY_MINI,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
} from '../../shared/time';
import { cn } from '../lib/cn';

export type PaintPhase = 'start' | 'move';

export interface PaintGesture {
  /** Unique per gesture; use it to group one drag (e.g. a single undo step). */
  id: number;
  /** `start`: the first day of the gesture (always exactly `[origin]`); `move`: days entered while dragging. */
  phase: PaintPhase;
  /** The day the gesture began on. Read its state at `start` to pick add vs remove. */
  origin: string;
  pointerType: 'mouse' | 'pen' | 'touch' | 'keyboard';
}

export interface MonthGridProps {
  /** `YYYY-MM` */
  month: string;
  /** Content under the day number. */
  renderDay?: (date: string) => ReactNode;
  /** Disabled days are dimmed, can't be painted/clicked, and are skipped mid-drag (e.g. past days). */
  isDisabled?: (date: string) => boolean;
  /** Marks days as selected: aria-selected + accent styling (override via dayClassName). */
  isSelected?: (date: string) => boolean;
  /** Enables paint mode. `dates` are in the order the pointer covered them, never disabled ones. */
  onPaint?: (dates: string[], gesture: PaintGesture) => void;
  /** Called once when a paint gesture ends (pointer up / cancel). */
  onPaintEnd?: (gesture: PaintGesture) => void;
  /** Click mode (ignored when `onPaint` is set). */
  onDayClick?: (date: string) => void;
  /** Makes the weekday header letters buttons, e.g. "paint every Friday". 0 = Sunday. */
  onWeekdayClick?: (weekday: number) => void;
  /** Extra classes for one day's cell (merged last). */
  dayClassName?: (date: string) => string | undefined | false;
  /** Extra classes for every day cell, e.g. `min-h-24` or `aspect-square`. */
  cellClassName?: string;
  /** Highlights this date's number (pass today in the club timezone). */
  today?: string;
  /** Header style: `short` "Sun" (default), `mini` "Su", `letter` "S". */
  weekdayLabels?: 'short' | 'mini' | 'letter';
  /** Draw the day number in each cell (default true). */
  showDayNumber?: boolean;
  className?: string;
  'aria-label'?: string;
}

const WEEKDAY_LABEL_SETS = { short: WEEKDAY_SHORT, mini: WEEKDAY_MINI, letter: WEEKDAY_LETTERS } as const;
const INTERACTIVE = 'button, a, input, select, textarea, label, [data-no-paint]';

interface ActiveGesture {
  gesture: PaintGesture;
  pointerId: number;
  last: string;
}

function toPointerType(type: string): PaintGesture['pointerType'] {
  return type === 'touch' || type === 'pen' ? type : 'mouse';
}

let gestureCounter = 0;

export function MonthGrid({
  month,
  renderDay,
  isDisabled,
  isSelected,
  onPaint,
  onPaintEnd,
  onDayClick,
  onWeekdayClick,
  dayClassName,
  cellClassName,
  today,
  weekdayLabels = 'short',
  showDayNumber = true,
  className,
  'aria-label': ariaLabel,
}: MonthGridProps) {
  const weeks = useMemo(() => monthGrid(month), [month]);
  /** date → [row, col] */
  const positions = useMemo(() => {
    const map = new Map<string, readonly [number, number]>();
    weeks.forEach((week, row) =>
      week.forEach((date, col) => {
        if (date) map.set(date, [row, col]);
      }),
    );
    return map;
  }, [weeks]);

  const gridRef = useRef<HTMLDivElement>(null);
  const active = useRef<ActiveGesture | null>(null);
  const [focusDate, setFocusDate] = useState<string | null>(null);

  const paintable = Boolean(onPaint);
  const clickable = !paintable && Boolean(onDayClick);
  const interactive = paintable || clickable;
  const disabled = (date: string) => Boolean(isDisabled?.(date));

  // The single tab stop: the focused day if it's in this month, else today, else the 1st.
  const tabStop =
    focusDate && positions.has(focusDate) ? focusDate : today && positions.has(today) ? today : `${month}-01`;

  function cellAt(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const cell = target.closest<HTMLElement>('[data-date]');
    return cell && gridRef.current?.contains(cell) ? cell : null;
  }

  /** Days on the straight grid line after `from` up to and including `to` (fast drags skip cells). */
  function daysBetween(from: string, to: string): string[] {
    const a = positions.get(from);
    const b = positions.get(to);
    if (!a || !b) return [to];
    const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    const out: string[] = [];
    for (let i = 1; i <= steps; i++) {
      const row = Math.round(a[0] + ((b[0] - a[0]) * i) / steps);
      const col = Math.round(a[1] + ((b[1] - a[1]) * i) / steps);
      const date = weeks[row]?.[col];
      if (date && !out.includes(date)) out.push(date);
    }
    return out;
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!onPaint || active.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    const cell = cellAt(target);
    if (!cell || target?.closest(INTERACTIVE)) return;
    const date = cell.dataset.date!;
    if (disabled(date)) return;

    e.preventDefault(); // no text selection / focus flash while dragging
    try {
      // Keep receiving moves when the pointer leaves the grid (and for touch, which
      // otherwise stays bound to the first cell).
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointer: painting still works while over the grid.
    }
    const gesture: PaintGesture = {
      id: ++gestureCounter,
      phase: 'start',
      origin: date,
      pointerType: toPointerType(e.pointerType),
    };
    active.current = { gesture, pointerId: e.pointerId, last: date };
    setFocusDate(date);
    onPaint([date], gesture);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const current = active.current;
    if (!current || !onPaint || e.pointerId !== current.pointerId) return;
    // With pointer capture, the event target is the grid; find the cell under the finger.
    const cell = cellAt(document.elementFromPoint(e.clientX, e.clientY));
    const date = cell?.dataset.date;
    if (!date || date === current.last) return;
    const dates = daysBetween(current.last, date).filter((d) => !disabled(d));
    current.last = date;
    if (dates.length) onPaint(dates, { ...current.gesture, phase: 'move' });
  }

  function endGesture(e: ReactPointerEvent<HTMLDivElement>) {
    const current = active.current;
    if (!current || e.pointerId !== current.pointerId) return;
    active.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onPaintEnd?.(current.gesture);
  }

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (!clickable || !onDayClick) return;
    const target = e.target instanceof Element ? e.target : null;
    const cell = cellAt(target);
    if (!cell || target?.closest(INTERACTIVE)) return;
    const date = cell.dataset.date!;
    if (!disabled(date)) onDayClick(date);
  }

  function activate(date: string) {
    if (disabled(date)) return;
    if (onPaint) {
      const gesture: PaintGesture = { id: ++gestureCounter, phase: 'start', origin: date, pointerType: 'keyboard' };
      onPaint([date], gesture);
      onPaintEnd?.(gesture);
    } else {
      onDayClick?.(date);
    }
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const cell = cellAt(e.target);
    if (!cell || e.target !== cell) return; // let inner buttons handle their own keys
    const date = cell.dataset.date!;
    const weekday = positions.get(date)?.[1] ?? 0;
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
      Home: -weekday,
      End: 6 - weekday,
    };
    if (e.key in moves) {
      e.preventDefault();
      const next = addDays(date, moves[e.key]!);
      if (monthOf(next) !== month) return;
      setFocusDate(next);
      gridRef.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus();
    } else if (interactive && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      activate(date);
    }
  }

  const labels = WEEKDAY_LABEL_SETS[weekdayLabels];

  return (
    <div className={cn('select-none', className)}>
      <div className="mb-1 grid grid-cols-7 gap-1" aria-hidden={onWeekdayClick ? undefined : true}>
        {labels.map((label, weekday) =>
          onWeekdayClick ? (
            <button
              key={weekday}
              type="button"
              title={`Every ${WEEKDAY_NAMES[weekday]}`}
              onClick={() => onWeekdayClick(weekday)}
              className="rounded-md py-1 text-center text-[11px] font-medium tracking-wide text-fg-muted uppercase hover:bg-surface-2 hover:text-fg"
            >
              {label}
            </button>
          ) : (
            <div key={weekday} className="py-1 text-center text-[11px] font-medium tracking-wide text-fg-muted uppercase">
              {label}
            </div>
          ),
        )}
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label={ariaLabel}
        aria-multiselectable={isSelected ? true : undefined}
        className={cn('flex flex-col gap-1', paintable && 'touch-none')}
        onPointerDown={paintable ? handlePointerDown : undefined}
        onPointerMove={paintable ? handlePointerMove : undefined}
        onPointerUp={paintable ? endGesture : undefined}
        onPointerCancel={paintable ? endGesture : undefined}
        onLostPointerCapture={paintable ? endGesture : undefined}
        onClick={clickable ? handleClick : undefined}
        onKeyDown={handleKeyDown}
      >
        {weeks.map((week, row) => (
          <div key={row} role="row" className="grid grid-cols-7 gap-1">
            {week.map((date, col) => {
              if (!date) return <div key={`pad-${col}`} role="presentation" />;
              const isOff = disabled(date);
              const selected = isSelected?.(date) ?? false;
              const isToday = date === today;
              return (
                <div
                  key={date}
                  role="gridcell"
                  data-date={date}
                  tabIndex={date === tabStop ? 0 : -1}
                  aria-label={formatDateLong(date)}
                  aria-selected={isSelected ? selected : undefined}
                  aria-disabled={isOff || undefined}
                  aria-current={isToday ? 'date' : undefined}
                  onFocus={() => setFocusDate(date)}
                  className={cn(
                    'relative flex min-h-16 min-w-0 flex-col gap-0.5 overflow-hidden rounded-lg border border-border bg-surface p-1 text-left text-xs transition-colors',
                    interactive && !isOff && 'cursor-pointer hover:border-accent',
                    selected && 'border-accent bg-accent-soft',
                    isOff && 'cursor-not-allowed opacity-40',
                    cellClassName,
                    dayClassName?.(date),
                  )}
                >
                  {showDayNumber && (
                    <span
                      className={cn(
                        'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-fg-muted',
                        isToday && 'bg-accent-solid text-accent-solid-fg',
                      )}
                    >
                      {Number(date.slice(8))}
                    </span>
                  )}
                  {renderDay?.(date)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
