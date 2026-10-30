/**
 * Small pieces around the board: the drag overlay preview, the click-to-place selection bar,
 * the status legend and the loading skeleton.
 */
import { Ban, Check, Clock, CornerDownLeft, TriangleAlert, Undo2, X } from 'lucide-react';
import type { ComponentProps, CSSProperties } from 'react';
import type { DayResponse } from '../../../shared/api/lineup';
import { BOOKING_STATUSES, BOOKING_STATUS_SHORT_LABELS } from '../../../shared/bookingStatus';
import { Avatar } from '../../components/ui';
import { cn } from '../../lib/cn';
import { BOOKING_STATUS_CLASSES } from '../../lib/statusStyles';
import type { Selection } from './BoardContext';
import { indexDay, showTitle, type DropPlan, type LineupSource } from './lineupModel';

// ---------------------------------------------------------------------------
// Drag overlay
// ---------------------------------------------------------------------------

/** The pill under the pointer while dragging, with a hint for what dropping here does. */
export function DragPreview({ day, source, plan }: { day: DayResponse; source: LineupSource; plan: DropPlan | null }) {
  const index = indexDay(day);
  const booking = source.kind === 'booking' ? index.bookings.get(source.bookingId) : undefined;
  const comedianId = source.kind === 'comedian' ? source.comedianId : booking?.comedianId;
  const comedian = comedianId != null ? index.comedians.get(comedianId) : undefined;
  const name = comedian?.name ?? booking?.comedianName ?? '';

  let hint: { icon: typeof Check; text: string; className: string } | null = null;
  if (plan?.kind === 'book' || plan?.kind === 'move') {
    hint = plan.conflicts.length
      ? { icon: TriangleAlert, text: 'Not available', className: 'text-awaiting-fg' }
      : plan.kind === 'move' && plan.swapWith
        ? { icon: Check, text: `Swap with ${plan.swapWith.comedianName.split(' ')[0]}`, className: 'text-accent' }
        : plan.replacing
          ? { icon: Check, text: `Replace ${plan.replacing.comedianName.split(' ')[0]}`, className: 'text-accent' }
          : { icon: Check, text: plan.kind === 'move' ? 'Move here' : 'Book', className: 'text-available-fg' };
  } else if (plan?.kind === 'unbook') {
    hint = { icon: Undo2, text: 'Remove', className: 'text-unconfirmed-fg' };
  } else if (plan?.kind === 'reject') {
    hint = { icon: Ban, text: 'Can’t drop here', className: 'text-unconfirmed-fg' };
  }

  return (
    <div
      className={cn(
        'flex w-max max-w-64 cursor-grabbing items-center gap-2 rounded-lg border border-border-strong bg-surface py-1.5 pr-2.5 pl-1.5',
        'text-[13px] font-medium text-fg shadow-xl ring-1 ring-black/5 dark:ring-white/10',
        '-rotate-1 transition-transform',
      )}
    >
      <Avatar name={name} src={comedian?.headshotUrl} size="xs" />
      <span className="truncate">{name}</span>
      {hint && (
        <span className={cn('flex shrink-0 items-center gap-1 border-l border-border pl-2 text-xs', hint.className)}>
          <hint.icon className="size-3.5" aria-hidden />
          {hint.text}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selection bar (click-to-place)
// ---------------------------------------------------------------------------

export function SelectionBar({
  day,
  selection,
  onClear,
  onUnbook,
}: {
  day: DayResponse;
  selection: Selection | null;
  onClear: () => void;
  onUnbook: (bookingId: number) => void;
}) {
  const index = indexDay(day);
  let message: string | null = null;
  let bookingId: number | null = null;
  if (selection?.kind === 'comedian') {
    const name = index.comedians.get(selection.comedianId)?.name;
    if (name) message = `${name} selected. Click a slot to book (a booked slot is replaced).`;
  } else if (selection?.kind === 'booking') {
    const booking = index.bookings.get(selection.bookingId);
    if (booking) {
      message = `Moving ${booking.comedianName}. Click a slot to move or swap.`;
      bookingId = booking.id;
    }
  } else if (selection?.kind === 'slot') {
    const show = index.shows.get(selection.showId);
    const occupant = show?.bookings.find((b) => b.position === selection.position);
    if (show && occupant) {
      message = `Replacing ${occupant.comedianName}${occupant.declinedAt != null ? ' (declined)' : ''} in the ${showTitle(show)}. Pick a comedian from the list.`;
    } else if (show) {
      message = `Slot ${selection.position + 1} of the ${showTitle(show)}. Pick a comedian from the list.`;
    }
  }

  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      {message && (
        <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full bg-fg py-1.5 pr-1.5 pl-4 text-sm text-surface shadow-lg animate-pop-in">
          <span className="min-w-0 truncate">{message}</span>
          {bookingId != null && (
            <button
              type="button"
              onClick={() => onUnbook(bookingId)}
              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium hover:bg-white/15 dark:hover:bg-black/10"
            >
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25 dark:bg-black/10 dark:hover:bg-black/20"
          >
            <X className="size-3.5" aria-hidden /> Cancel
            <kbd className="font-sans opacity-60">Esc</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

/** `showDeclined`: declines are on, or someone declined a spot on this day. */
export function StatusLegend({ className, showDeclined = false }: { className?: string; showDeclined?: boolean }) {
  const statuses = BOOKING_STATUSES.filter((s) => s !== 'declined' || showDeclined);
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted', className)} aria-label="Legend">
      {statuses.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span aria-hidden className={cn('size-2 rounded-full', BOOKING_STATUS_CLASSES[status].dot)} />
          {status === 'unconfirmed_today' ? 'Unconfirmed today' : BOOKING_STATUS_SHORT_LABELS[status]}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <TriangleAlert aria-hidden className="size-3.5 text-awaiting" strokeWidth={2.25} />
        Booked anyway
      </li>
      <li className="flex items-center gap-1">
        <Clock aria-hidden className="size-3.5 text-awaiting" strokeWidth={2.25} />
        Also booked within 90 min
      </li>
      <li className="hidden items-center gap-1 min-[1600px]:flex">
        <CornerDownLeft aria-hidden className="size-3.5" />
        Click to select, click a slot to place
      </li>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Show grid
// ---------------------------------------------------------------------------

/**
 * Columns for a room's show cards: at least 10.5rem each, and at most `columns` per row so a
 * room's shows fill the row (no empty tracks) while one-show rooms don't get a giant card.
 */
export function showGridStyle(columns: number): CSSProperties {
  return {
    gridTemplateColumns: `repeat(auto-fill, minmax(max(10.5rem, calc((100% - ${columns - 1} * 0.75rem) / ${columns})), 1fr))`,
  };
}

// ---------------------------------------------------------------------------
// Loading skeleton (same footprint as the board, so nothing jumps when data lands)
// ---------------------------------------------------------------------------

function Bone({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} {...props} />;
}

export function BoardSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      {[4, 3].map((cards, s) => (
        <div key={s}>
          <Bone className="mb-2 h-5 w-40" />
          <div className="grid items-start gap-3" style={showGridStyle(4)}>
            {Array.from({ length: cards }, (_, i) => (
              <div key={i} className="overflow-hidden rounded-lg border border-border bg-surface">
                <div className="h-1 bg-surface-3" />
                <div className="space-y-2 px-3 py-2.5">
                  <Bone className="h-4 w-16" />
                  <Bone className="h-3 w-24" />
                </div>
                <div className="space-y-1 px-2 pb-2">
                  {Array.from({ length: 6 }, (_, j) => (
                    <Bone key={j} className="h-9" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PoolSkeleton() {
  return (
    <div className="space-y-2 p-3" aria-hidden>
      <Bone className="h-8" />
      <div className="flex gap-1.5">
        {[16, 20, 14, 18].map((w, i) => (
          <Bone key={i} className="h-6" style={{ width: `${w * 4}px` }} />
        ))}
      </div>
      {Array.from({ length: 10 }, (_, i) => (
        <Bone key={i} className="h-11" />
      ))}
    </div>
  );
}
