/**
 * One show's column: header (time, name, fill count, −/+ slots, menu) and its numbered slots.
 * Empty slots are drop targets / click targets; filled slots hold a draggable comedian chip.
 *
 * A chip shows the comedian's status color, ⚠ when booked anyway, a clock when they're also
 * booked within 90 minutes elsewhere tonight, and a notes count (click/tap it for their card).
 * A declined booking keeps its slot, struck through with "Replace": click it to pick someone
 * from the pool, or drop someone on it.
 *
 * Rendering: the card, header and chip faces are memoized on plain props; only the small
 * wrappers that hold dnd-kit hooks re-render while something is dragged (UX D18).
 */
import { useDraggable, useDroppable, type DraggableAttributes } from '@dnd-kit/core';
import {
  Check,
  Clock,
  Copy,
  Ellipsis,
  Minus,
  Pencil,
  Plus,
  StickyNote,
  TriangleAlert,
  UserSearch,
  X,
} from 'lucide-react';
import { memo, useId, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { LINEUP_MAX_SLOTS, type DayShow, type LineupBooking } from '../../../shared/api/lineup';
import { BOOKING_STATUS_LABELS } from '../../../shared/bookingStatus';
import { formatTime, monthOf } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/ui';
import { cn } from '../../lib/cn';
import { BOOKING_STATUS_CLASSES } from '../../lib/statusStyles';
import { isSelected, useBoard, useBoardActions, useBoardLive } from './BoardContext';
import { bookingDragId, slotDropId, useStableListeners, type DragData, type DropData } from './dnd';
import { bookingPlace, fitFor, minSlotCount, overlapFor, showTitle, type DropPlan } from './lineupModel';
import { isTempId } from './useLineup';

export const ShowCard = memo(function ShowCard({ show }: { show: DayShow }) {
  const headingId = useId();
  const byPosition = new Map(show.bookings.map((b) => [b.position, b]));
  // Declined bookings hold their slot but don't fill it.
  const filled = show.bookings.filter((b) => b.declinedAt == null).length;
  const full = filled >= show.slotCount;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xs"
    >
      <div aria-hidden className="h-1 shrink-0" style={{ backgroundColor: show.location.color }} />
      <ShowHeader show={show} headingId={headingId} filled={filled} full={full} />
      <ol className="flex flex-col gap-1 px-2 pb-2" aria-label={`${showTitle(show)} lineup`}>
        {Array.from({ length: show.slotCount }, (_, position) => (
          <SlotRow key={position} show={show} position={position} booking={byPosition.get(position)} />
        ))}
      </ol>
    </section>
  );
});

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const ShowHeader = memo(function ShowHeader({
  show,
  headingId,
  filled,
  full,
}: {
  show: DayShow;
  headingId: string;
  filled: number;
  full: boolean;
}) {
  const actions = useBoardActions();
  const navigate = useNavigate();
  const min = minSlotCount(show);
  const canRemove = show.slotCount > min;
  const canAdd = show.slotCount < LINEUP_MAX_SLOTS;

  return (
    <header className="px-3 pt-2 pb-2">
      <div className="flex h-6 items-center gap-2">
        <h3 id={headingId} className="shrink-0 text-[15px] font-semibold whitespace-nowrap text-fg tabular-nums">
          {formatTime(show.startMin)}
          <span className="sr-only">
            {' '}
            {show.name} at {show.location.name}
          </span>
        </h3>
        {/* While someone is dragged/selected this spot says whether they fit; otherwise the fill count. */}
        <span className="flex min-w-0 flex-1 justify-end">
          <HeaderStatus show={show} filled={filled} full={full} />
        </span>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1 size-6 text-fg-muted" aria-label="Show options">
              <Ellipsis />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => actions.focusShow(show.id)}>
              <UserSearch /> Who’s free at {formatTime(show.startMin)}
            </MenuItem>
            <MenuItem onSelect={() => navigate(`/app/calendar?month=${monthOf(show.date)}&show=${show.id}`)}>
              <Pencil /> Edit show
            </MenuItem>
            <MenuItem onSelect={() => actions.copyLineup(show.id)}>
              <Copy /> Copy lineup to clipboard
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="mt-0.5 flex h-6 items-center gap-0.5">
        <p className="flex min-w-0 flex-1 items-center gap-1 text-xs text-fg-muted" aria-hidden>
          <span className="truncate" title={show.name || undefined}>
            {show.name || 'Show'}
          </span>
          {show.notes && (
            <span title={show.notes} className="shrink-0 text-fg-subtle">
              <StickyNote className="size-3" />
            </span>
          )}
        </p>
        {show.notes && <span className="sr-only">Notes: {show.notes}</span>}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-fg-muted"
          disabled={!canRemove}
          onClick={() => actions.setSlotCount(show.id, show.slotCount - 1)}
          aria-label={`Remove a slot (${show.slotCount} slots)`}
          title={canRemove ? 'Remove the last slot' : min > 1 ? `Slot ${min} is booked` : undefined}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="-mr-1 size-6 text-fg-muted"
          disabled={!canAdd}
          onClick={() => actions.setSlotCount(show.id, show.slotCount + 1)}
          aria-label={`Add a slot (${show.slotCount} slots)`}
          title="Add a slot"
        >
          <Plus />
        </Button>
      </div>
    </header>
  );
});

/** The fill count, or — while a comedian is dragged or selected — whether they fit. */
function HeaderStatus({ show, filled, full }: { show: DayShow; filled: number; full: boolean }) {
  const { focusComedianId } = useBoardLive();
  if (focusComedianId != null) return <FitBadge show={show} comedianId={focusComedianId} />;
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 text-xs font-medium whitespace-nowrap tabular-nums',
        full ? 'bg-available-soft text-available-fg' : 'text-fg-muted',
      )}
      title={`${filled} of ${show.slotCount} slots filled`}
    >
      <span aria-hidden>
        {filled}/{show.slotCount}
      </span>
      <span className="sr-only">
        {filled} of {show.slotCount} slots filled
      </span>
    </span>
  );
}

/** While a comedian is dragged or selected: do they fit this show (and clash with another booking)? */
function FitBadge({ show, comedianId }: { show: DayShow; comedianId: number }) {
  const { day, index } = useBoard();
  const comedian = index.comedians.get(comedianId);
  if (!comedian) return null;
  const fit = fitFor(day, comedian, show);
  if (fit.kind === 'in_show') {
    return <span className="truncate text-xs whitespace-nowrap text-fg-subtle animate-fade-in">In lineup</span>;
  }
  // Not marked for this time matters more (it asks "Book anyway?"); a clash is the soft warning.
  if (fit.kind === 'fits' && fit.overlap) {
    const place = bookingPlace(day, fit.overlap.booking);
    return (
      <span
        title={`Also booked ${place}`}
        className="inline-flex min-w-0 items-center gap-0.5 rounded-full bg-awaiting-soft px-1.5 text-xs font-medium whitespace-nowrap text-awaiting-fg animate-fade-in"
      >
        <Clock className="size-3 shrink-0" aria-hidden /> <span className="truncate">Also {place}</span>
      </span>
    );
  }
  if (fit.kind === 'fits') {
    return (
      <span className="inline-flex min-w-0 items-center gap-0.5 text-xs font-medium whitespace-nowrap text-available-fg animate-fade-in">
        <Check className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">Available</span>
      </span>
    );
  }
  return (
    <span className="truncate text-xs whitespace-nowrap text-fg-subtle animate-fade-in">
      {fit.kind === 'outside' ? 'Outside their hours' : fit.kind === 'not_marked' ? 'Not marked' : 'Unavailable'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

type DropTone = 'ok' | 'warn' | 'bad' | null;

function dropTone(plan: DropPlan): DropTone {
  switch (plan.kind) {
    case 'book':
    case 'move':
      return plan.conflicts.length ? 'warn' : 'ok';
    case 'reject':
      return 'bad';
    default:
      return null;
  }
}

const TONE_RING: Record<Exclude<DropTone, null>, string> = {
  ok: 'ring-2 ring-accent bg-accent-soft',
  warn: 'ring-2 ring-awaiting bg-awaiting-soft',
  bad: 'ring-2 ring-unconfirmed/60',
};

/** The droppable slot. Reads the live board state and hands its children plain props. */
function SlotRow({ show, position, booking }: { show: DayShow; position: number; booking: LineupBooking | undefined }) {
  const { day, index } = useBoard();
  const { dragging, selection, preview } = useBoardLive();
  const label = `slot ${position + 1} of the ${showTitle(show)} at ${show.location.name}`;
  const { setNodeRef, isOver } = useDroppable({
    id: slotDropId(show.id, position),
    data: { kind: 'slot', showId: show.id, position, label } satisfies DropData,
  });
  const plan = isOver && dragging ? preview({ kind: 'slot', showId: show.id, position }) : null;
  const tone = plan ? dropTone(plan) : null;
  const slotSelected = isSelected(selection, { kind: 'slot', showId: show.id, position });

  let content;
  if (booking) {
    const comedian = index.comedians.get(booking.comedianId);
    const overlap = booking.declinedAt == null ? overlapFor(day, booking.comedianId, show) : null;
    content = (
      <BookingChip
        booking={booking}
        position={position}
        dropHint={plan?.kind === 'move' && !plan.replacing ? 'Swap' : plan?.kind === 'book' || plan?.kind === 'move' ? 'Replace' : null}
        selected={isSelected(selection, { kind: 'booking', bookingId: booking.id })}
        replacing={slotSelected}
        noteCount={comedian?.noteCount ?? 0}
        latestNote={comedian?.latestNote ?? null}
        alsoBooked={overlap ? bookingPlace(day, overlap.booking) : null}
      />
    );
  } else {
    let hint: string | null = null;
    if (selection?.kind === 'comedian') hint = `Book ${firstName(index.comedians.get(selection.comedianId)?.name)} here`;
    else if (selection?.kind === 'booking') hint = `Move ${firstName(index.bookings.get(selection.bookingId)?.comedianName)} here`;
    content = <EmptySlot showId={show.id} position={position} plan={plan} selected={slotSelected} hint={hint} />;
  }

  return (
    <li className="group/slot relative">
      <div
        ref={setNodeRef}
        className={cn('flex h-9 items-center gap-1 rounded-md transition-shadow', tone && TONE_RING[tone])}
      >
        <span aria-hidden className="w-3.5 shrink-0 text-right text-[11px] text-fg-subtle tabular-nums">
          {position + 1}
        </span>
        {content}
      </div>
    </li>
  );
}

const EmptySlot = memo(function EmptySlot({
  showId,
  position,
  plan,
  selected,
  hint,
}: {
  showId: number;
  position: number;
  plan: DropPlan | null;
  selected: boolean;
  /** What clicking does with the current selection ("Book Maria here"). */
  hint: string | null;
}) {
  const actions = useBoardActions();

  let text = 'Empty';
  if (plan?.kind === 'book' || plan?.kind === 'move') text = plan.conflicts.length ? 'Not available — drop to ask' : 'Drop to book';
  else if (plan?.kind === 'reject') text = 'Already in this lineup';
  else if (selected) text = 'Pick a comedian →';

  return (
    <button
      type="button"
      onClick={() => actions.clickSlot(showId, position)}
      aria-pressed={selected}
      aria-label={`Slot ${position + 1}, empty${hint ? `. ${hint}` : ''}`}
      className={cn(
        'flex h-full min-w-0 flex-1 items-center gap-1 rounded-md border border-dashed px-2 text-left text-xs transition-colors',
        selected
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-border-strong text-fg-subtle hover:border-accent hover:text-accent',
        plan && 'border-transparent bg-transparent',
        plan?.kind === 'reject' && 'text-unconfirmed-fg',
        (plan?.kind === 'book' || plan?.kind === 'move') && (plan.conflicts.length ? 'text-awaiting-fg' : 'text-accent'),
      )}
    >
      {hint && !plan ? (
        <>
          <span className="truncate group-hover/slot:hidden">{text}</span>
          <span className="hidden truncate group-hover/slot:inline">{hint}</span>
        </>
      ) : (
        <span className="truncate">{text}</span>
      )}
    </button>
  );
});

function firstName(name: string | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? 'them';
}

interface BookingChipProps {
  booking: LineupBooking;
  position: number;
  /** What dropping the current drag here does to this chip. */
  dropHint: 'Swap' | 'Replace' | null;
  /** Picked up for click-to-place. */
  selected: boolean;
  /** Its slot is selected: the next pool comedian picked replaces it (declined bookings). */
  replacing: boolean;
  noteCount: number;
  latestNote: string | null;
  /** "7 PM · The Cellar" when they're also booked within 90 minutes tonight. */
  alsoBooked: string | null;
}

/** The draggable wrapper: re-renders with dnd-kit; the face below only when its props change. */
function BookingChip(props: BookingChipProps) {
  const { booking } = props;
  const pending = isTempId(booking.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: bookingDragId(booking.id),
    data: { kind: 'booking', bookingId: booking.id, label: booking.comedianName } satisfies DragData,
    disabled: pending,
  });
  const stableListeners = useStableListeners(listeners);
  return (
    <ChipFace
      {...props}
      pending={pending}
      isDragging={isDragging}
      attributes={attributes}
      listeners={stableListeners}
      setNodeRef={setNodeRef}
    />
  );
}

const ChipFace = memo(function ChipFace({
  booking,
  position,
  dropHint,
  selected,
  replacing,
  noteCount,
  latestNote,
  alsoBooked,
  pending,
  isDragging,
  attributes,
  listeners,
  setNodeRef,
}: BookingChipProps & {
  pending: boolean;
  isDragging: boolean;
  attributes: DraggableAttributes;
  listeners: ReturnType<typeof useStableListeners>;
  setNodeRef: (element: HTMLElement | null) => void;
}) {
  const actions = useBoardActions();
  const [cardOpen, setCardOpen] = useState(false);
  const classes = BOOKING_STATUS_CLASSES[booking.status];
  const declined = booking.status === 'declined';
  const statusLabel = declined ? 'Declined — replace' : BOOKING_STATUS_LABELS[booking.status];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      actions.clickBooking(booking.id);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && !pending) {
      event.preventDefault();
      actions.unbook(booking.id);
    } else {
      listeners.onKeyDown?.(event);
    }
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    // The notes badge opens the comedian's card (the only way on touch, which never hovers).
    if ((event.target as Element).closest('[data-note-trigger]')) {
      setCardOpen(true);
      return;
    }
    actions.clickBooking(booking.id);
  }

  const declinedTitle = declined
    ? `${booking.comedianName} can’t make it${booking.declineNote ? `: “${booking.declineNote}”` : ''}. Click to pick a replacement, or drop someone here.`
    : undefined;

  return (
    <>
      <ComedianHoverCard comedianId={booking.comedianId} open={cardOpen} onOpenChange={setCardOpen}>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          onKeyDown={onKeyDown}
          onClick={onClick}
          aria-pressed={selected || replacing}
          aria-label={[
            `Slot ${position + 1}: ${booking.comedianName}, ${statusLabel}`,
            booking.overrideUnavailable ? 'booked anyway (not marked available)' : null,
            alsoBooked ? `also booked ${alsoBooked}` : null,
            noteCount ? `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : null,
          ]
            .filter(Boolean)
            .join(', ')}
          title={declinedTitle}
          className={cn(
            '@container flex h-full min-w-0 flex-1 cursor-grab touch-manipulation items-center gap-1.5 rounded-md border pr-2 pl-2 text-[13px] font-medium select-none',
            'group-focus-within/slot:pr-6 group-hover/slot:pr-6 [@media(hover:none)]:pr-6',
            'transition-[opacity,box-shadow] hover:shadow-sm active:cursor-grabbing',
            classes.chip,
            isDragging && 'opacity-40',
            (selected || replacing) && 'ring-2 ring-accent ring-offset-1 ring-offset-surface',
          )}
        >
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', classes.dot)} />
          <span className={cn('min-w-0 truncate', classes.name)}>{booking.comedianName}</span>
          {booking.overrideUnavailable && !declined && (
            <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-awaiting" strokeWidth={2.25} />
          )}
          {alsoBooked && (
            <span aria-hidden title={`Also booked ${alsoBooked}`} className="shrink-0 text-awaiting">
              <Clock className="size-3.5" strokeWidth={2.25} />
            </span>
          )}
          {noteCount > 0 && (
            <span
              aria-hidden
              data-note-trigger
              title={latestNote ? `${noteCount === 1 ? 'Note' : `${noteCount} notes`}: ${latestNote}` : undefined}
              className="-my-1 flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-0.5 py-1 text-[11px] font-medium opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
            >
              <StickyNote className="size-3" />
              {noteCount}
            </span>
          )}
          {dropHint ? (
            <span className="ml-auto shrink-0 rounded bg-surface/80 px-1 text-[10px] font-semibold tracking-wide text-accent uppercase">
              {dropHint}
            </span>
          ) : (
            declined && (
              <span className="ml-auto shrink-0 rounded bg-surface/70 px-1 text-[10px] font-semibold tracking-wide text-declined-fg uppercase">
                <span className="hidden @[13.5rem]:inline">Declined — </span>Replace
              </span>
            )
          )}
        </div>
      </ComedianHoverCard>
      {!pending && (
        <button
          type="button"
          onClick={() => actions.unbook(booking.id)}
          aria-label={`Remove ${booking.comedianName} from slot ${position + 1}`}
          title="Remove from lineup"
          className={cn(
            'absolute top-1/2 right-0.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-current opacity-0 transition-opacity',
            'group-hover/slot:opacity-60 hover:bg-black/5 hover:!opacity-100 focus-visible:opacity-100 dark:hover:bg-white/10',
            '[@media(hover:none)]:opacity-60',
            classes.text,
            isDragging && 'hidden',
          )}
        >
          <X className="size-3.5" />
        </button>
      )}
    </>
  );
});
