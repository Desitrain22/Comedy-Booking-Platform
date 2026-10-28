/**
 * One show's column: header (time, name, fill count, −/+ slots, menu) and its numbered slots.
 * Empty slots are drop targets / click targets; filled slots hold a draggable comedian chip.
 */
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Check, Copy, Ellipsis, Minus, Pencil, Plus, StickyNote, TriangleAlert, X } from 'lucide-react';
import { useId, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { LINEUP_MAX_SLOTS, type DayShow, type LineupBooking } from '../../../shared/api/lineup';
import { BOOKING_STATUS_LABELS } from '../../../shared/bookingStatus';
import { formatTime, monthOf } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/ui';
import { cn } from '../../lib/cn';
import { BOOKING_STATUS_CLASSES } from '../../lib/statusStyles';
import { isSelected, useBoard } from './BoardContext';
import { bookingDragId, slotDropId, type DragData, type DropData } from './dnd';
import { minSlotCount, showFit, showTitle, type DropPlan } from './lineupModel';
import { isTempId } from './useLineup';

export function ShowCard({ show }: { show: DayShow }) {
  const headingId = useId();
  const byPosition = new Map(show.bookings.map((b) => [b.position, b]));
  const filled = show.bookings.length;
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
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function ShowHeader({
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
  const board = useBoard();
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
          {board.focusComedianId != null ? (
            <FitBadge show={show} comedianId={board.focusComedianId} />
          ) : (
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
          )}
        </span>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1 size-6 text-fg-muted" aria-label="Show options">
              <Ellipsis />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => navigate(`/app/calendar?month=${monthOf(show.date)}&show=${show.id}`)}>
              <Pencil /> Edit show
            </MenuItem>
            <MenuItem onSelect={() => board.copyLineup(show.id)}>
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
          onClick={() => board.setSlotCount(show.id, show.slotCount - 1)}
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
          onClick={() => board.setSlotCount(show.id, show.slotCount + 1)}
          aria-label={`Add a slot (${show.slotCount} slots)`}
          title="Add a slot"
        >
          <Plus />
        </Button>
      </div>
    </header>
  );
}

/** While a comedian is dragged or selected: do they fit this show? */
function FitBadge({ show, comedianId }: { show: DayShow; comedianId: number }) {
  const { day } = useBoard();
  const fit = showFit(day, comedianId, show);
  if (fit === 'available') {
    return (
      <span className="inline-flex min-w-0 items-center gap-0.5 text-xs font-medium whitespace-nowrap text-available-fg animate-fade-in">
        <Check className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">Available</span>
      </span>
    );
  }
  if (fit === 'unavailable') {
    return <span className="truncate text-xs whitespace-nowrap text-fg-subtle animate-fade-in">Unavailable</span>;
  }
  if (fit === 'in_show') {
    return <span className="truncate text-xs whitespace-nowrap text-fg-subtle animate-fade-in">In lineup</span>;
  }
  return null;
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

function SlotRow({ show, position, booking }: { show: DayShow; position: number; booking: LineupBooking | undefined }) {
  const board = useBoard();
  const label = `slot ${position + 1} of the ${showTitle(show)} at ${show.location.name}`;
  const { setNodeRef, isOver } = useDroppable({
    id: slotDropId(show.id, position),
    data: { kind: 'slot', showId: show.id, position, label } satisfies DropData,
  });
  const plan = isOver && board.dragging ? board.preview({ kind: 'slot', showId: show.id, position }) : null;
  const tone = plan ? dropTone(plan) : null;

  return (
    <li className="group/slot relative">
      <div
        ref={setNodeRef}
        className={cn('flex h-9 items-center gap-1 rounded-md transition-shadow', tone && TONE_RING[tone])}
      >
        <span aria-hidden className="w-3.5 shrink-0 text-right text-[11px] text-fg-subtle tabular-nums">
          {position + 1}
        </span>
        {booking ? (
          <BookingChip booking={booking} position={position} swapHint={plan?.kind === 'move'} />
        ) : (
          <EmptySlot show={show} position={position} plan={plan} />
        )}
      </div>
    </li>
  );
}

function EmptySlot({ show, position, plan }: { show: DayShow; position: number; plan: DropPlan | null }) {
  const board = useBoard();
  const { selection, index } = board;
  const selected = isSelected(selection, { kind: 'slot', showId: show.id, position });

  let hint: string | null = null;
  if (selection?.kind === 'comedian') hint = `Book ${firstName(index.comedians.get(selection.comedianId)?.name)} here`;
  else if (selection?.kind === 'booking') hint = `Move ${firstName(index.bookings.get(selection.bookingId)?.comedianName)} here`;

  let text = 'Empty';
  if (plan?.kind === 'book' || plan?.kind === 'move') text = plan.conflicts.length ? 'Not available — drop to ask' : 'Drop to book';
  else if (plan?.kind === 'reject') text = 'Already in this lineup';
  else if (selected) text = 'Pick a comedian →';

  return (
    <button
      type="button"
      onClick={() => board.clickSlot(show.id, position)}
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
}

function firstName(name: string | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? 'them';
}

function BookingChip({
  booking,
  position,
  swapHint,
}: {
  booking: LineupBooking;
  position: number;
  swapHint: boolean;
}) {
  const board = useBoard();
  const pending = isTempId(booking.id);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: bookingDragId(booking.id),
    data: { kind: 'booking', bookingId: booking.id, label: booking.comedianName } satisfies DragData,
    disabled: pending,
  });
  const classes = BOOKING_STATUS_CLASSES[booking.status];
  const selected = isSelected(board.selection, { kind: 'booking', bookingId: booking.id });
  const statusLabel = BOOKING_STATUS_LABELS[booking.status];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      board.clickBooking(booking.id);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && !pending) {
      event.preventDefault();
      board.unbook(booking.id);
    } else {
      listeners?.onKeyDown?.(event);
    }
  }

  return (
    <>
      <ComedianHoverCard comedianId={booking.comedianId}>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          onKeyDown={onKeyDown}
          onClick={() => board.clickBooking(booking.id)}
          aria-pressed={selected}
          aria-label={`Slot ${position + 1}: ${booking.comedianName}, ${statusLabel}${
            booking.overrideUnavailable ? ', booked anyway (not marked available)' : ''
          }`}
          className={cn(
            'flex h-full min-w-0 flex-1 cursor-grab touch-manipulation items-center gap-1.5 rounded-md border pr-2 pl-2 text-[13px] font-medium select-none',
            'group-focus-within/slot:pr-6 group-hover/slot:pr-6 [@media(hover:none)]:pr-6',
            'transition-[opacity,box-shadow] hover:shadow-sm active:cursor-grabbing',
            classes.chip,
            isDragging && 'opacity-40',
            selected && 'ring-2 ring-accent ring-offset-1 ring-offset-surface',
          )}
        >
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', classes.dot)} />
          <span className="min-w-0 truncate">{booking.comedianName}</span>
          {booking.overrideUnavailable && (
            <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-awaiting" strokeWidth={2.25} />
          )}
          {swapHint && (
            <span className="ml-auto shrink-0 rounded bg-surface/80 px-1 text-[10px] font-semibold tracking-wide text-accent uppercase">
              Swap
            </span>
          )}
        </div>
      </ComedianHoverCard>
      {!pending && (
        <button
          type="button"
          onClick={() => board.unbook(booking.id)}
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
}
