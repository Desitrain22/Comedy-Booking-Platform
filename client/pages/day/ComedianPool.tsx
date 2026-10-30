/**
 * Right sidebar: the comedian pool. Search, tag chips ("pull comedians from a group"),
 * "available only" toggle, and one draggable card per comedian with their availability for
 * this date and where they're already booked. Also the drop zone for unbooking.
 *
 * With a slot selected (UX A3) the pool is about *that show*: every card says whether the
 * comedian fits its start time (fits / outside their hours / unavailable / not marked), who
 * is also booked within 90 minutes, and the list puts the free ones first — "8 free at 9 PM".
 * Without a focus: free (available, not booked yet) first, then those already booked.
 *
 * Cards are memoized on plain props, so picking something up re-renders only the small
 * draggable wrappers (UX D18).
 */
import { useDraggable, useDroppable, type DraggableAttributes } from '@dnd-kit/core';
import { Check, CircleCheck, Clock, Search, StickyNote, Undo2, X } from 'lucide-react';
import { memo, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { DayComedian, DayShow, LineupTag } from '../../../shared/api/lineup';
import { DEFAULT_ALL_NIGHT, formatAvailability, type AvailabilityRange } from '../../../shared/availability';
import { formatDateShort, formatMonthName, formatTime, monthOf } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import { Avatar, Input, Switch } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useClub } from '../../lib/useMe';
import { isSelected, useBoard, useBoardActions, useBoardLive } from './BoardContext';
import { comedianDragId, POOL_DROP_ID, useStableListeners, type DragData, type DropData } from './dnd';
import {
  activeBookings,
  bookingPlace,
  comedianState,
  filterPool,
  fitFor,
  poolCounts,
  showTitle,
  type FitKind,
  type PoolFilter,
} from './lineupModel';

export interface ComedianPoolProps {
  filter: PoolFilter;
  onFilterChange: (filter: PoolFilter) => void;
  /** Clear a selected slot (the pool's focus). */
  onClearFocus: () => void;
  className?: string;
}

export function ComedianPool({ filter, onFilterChange, onClearFocus, className }: ComedianPoolProps) {
  const { day, index } = useBoard();
  const { dragging, selection, focusShowId } = useBoardLive();
  const allNight = useClub()?.allNight ?? DEFAULT_ALL_NIGHT;
  const { setNodeRef, isOver } = useDroppable({
    id: POOL_DROP_ID,
    data: { kind: 'pool', label: 'the comedian list (removes them from the lineup)' } satisfies DropData,
  });
  const focus = focusShowId != null ? (index.shows.get(focusShowId) ?? null) : null;
  const visible = useMemo(() => filterPool(day, filter, focus), [day, filter, focus]);
  const counts = useMemo(() => poolCounts(day, focus), [day, focus]);
  const draggingBooking = dragging?.kind === 'booking';
  const filtered = filter.search.trim() !== '' || filter.tagIds.length > 0 || filter.availableOnly;
  const dateLabel = day.date === day.today ? 'today' : formatDateShort(day.date);

  const toggleTag = (tagId: number) =>
    onFilterChange({
      ...filter,
      tagIds: filter.tagIds.includes(tagId) ? filter.tagIds.filter((id) => id !== tagId) : [...filter.tagIds, tagId],
    });

  return (
    <aside
      ref={setNodeRef}
      aria-label="Comedians"
      className={cn('relative flex min-h-0 flex-col rounded-lg border border-border bg-surface shadow-xs', className)}
    >
      <div className="space-y-2.5 border-b border-border p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">Comedians</h2>
          {focus ? (
            <span className="text-xs text-fg-muted tabular-nums">
              <span className="font-medium text-available-fg">{counts.free}</span> free at {formatTime(focus.startMin)}
            </span>
          ) : (
            <span
              className="text-xs text-fg-muted tabular-nums"
              title={`${counts.free} marked available ${dateLabel} and not booked yet · ${counts.booked} already booked · ${counts.total} comedians`}
            >
              <span className="font-medium text-available-fg">{counts.free}</span> free · {counts.booked} booked
            </span>
          )}
        </div>
        {focus && <FocusBar show={focus} free={counts.free} onClear={onClearFocus} />}
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            type="search"
            value={filter.search}
            onChange={(e) => onFilterChange({ ...filter, search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter.search) {
                e.stopPropagation();
                onFilterChange({ ...filter, search: '' });
              }
            }}
            placeholder="Search comedians"
            aria-label="Search comedians"
            className="h-8 pl-8"
          />
        </div>
        {day.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by tag">
            {day.tags.map((tag) => (
              <TagChip key={tag.id} tag={tag} active={filter.tagIds.includes(tag.id)} onToggle={() => toggleTag(tag.id)} />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <Switch
            checked={filter.availableOnly}
            onCheckedChange={(availableOnly) => onFilterChange({ ...filter, availableOnly })}
            label={focus ? `Fits ${formatTime(focus.startMin)} only` : `Available ${dateLabel} only`}
          />
          {filtered && (
            <button
              type="button"
              onClick={() => onFilterChange({ search: '', tagIds: [], availableOnly: false })}
              className="rounded text-xs text-fg-muted hover:text-fg"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5" aria-label="Comedian list">
        {visible.map((comedian) => {
          const fit = focus ? fitFor(day, comedian, focus) : null;
          const booked = activeBookings(day, comedian.id);
          const declined = (index.bookingsByComedian.get(comedian.id) ?? []).filter((b) => b.declinedAt != null);
          return (
            <PoolCard
              key={comedian.id}
              comedian={comedian}
              selected={isSelected(selection, { kind: 'comedian', comedianId: comedian.id })}
              availLabel={availabilityLabel(comedian.availability, comedian.submittedMonth, allNight)}
              bookedText={booked.map((b) => bookingPlace(day, b)).join(', ')}
              declinedText={declined.map((b) => bookingPlace(day, b)).join(', ')}
              fitKind={fit?.kind ?? null}
              alsoBooked={fit?.overlap ? bookingPlace(day, fit.overlap.booking) : null}
              focusStartMin={focus?.startMin ?? null}
              date={day.date}
            />
          );
        })}
        {visible.length === 0 && (
          <li className="px-3 py-8 text-center text-sm text-fg-muted">
            {day.comedians.length === 0 ? 'No comedians yet.' : 'No comedians match.'}
          </li>
        )}
      </ul>

      {draggingBooking && (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-1.5 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed text-sm font-medium backdrop-blur-[1px] transition-colors animate-fade-in',
            isOver
              ? 'border-unconfirmed bg-unconfirmed-soft/90 text-unconfirmed-fg'
              : 'border-border-strong bg-surface/80 text-fg-muted',
          )}
        >
          <Undo2 className="size-5" />
          Drop here to remove from the lineup
        </div>
      )}
    </aside>
  );
}

/** "Who fits the 9 PM Late Show · The Cellar" with a way out. */
function FocusBar({ show, free, onClear }: { show: DayShow; free: number; onClear: () => void }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent-soft py-1 pr-1 pl-2.5 text-xs text-accent animate-fade-in"
    >
      <span className="min-w-0 flex-1 truncate">
        Who fits the <strong className="font-semibold">{showTitle(show)}</strong> · {show.location.name}
        <span className="sr-only">: {free} free</span>
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Stop showing who fits this show"
        title="Clear (Esc)"
        className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent/10"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function TagChip({ tag, active, onToggle }: { tag: LineupTag; active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs font-medium transition-colors',
        active ? 'border-transparent text-fg' : 'border-border text-fg-muted hover:bg-surface-2 hover:text-fg',
      )}
      style={active ? { backgroundColor: `color-mix(in oklab, ${tag.color} 20%, transparent)`, borderColor: tag.color } : undefined}
    >
      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
      {tag.name}
      {active && <X aria-hidden className="-mr-0.5 size-3" />}
    </button>
  );
}

// ---------------------------------------------------------------------------

function availabilityLabel(range: AvailabilityRange | null, submittedMonth: boolean, allNight: AvailabilityRange): string {
  if (range) return formatAvailability(range, allNight);
  return submittedMonth ? 'unavailable' : 'not marked';
}

interface PoolCardProps {
  comedian: DayComedian;
  selected: boolean;
  /** Their range ("7–11 PM", "All night") or "unavailable" / "not marked". */
  availLabel: string;
  /** "7 PM · The Cellar, 9 PM · The Annex" — where they're booked tonight. */
  bookedText: string;
  /** Spots they declined tonight. */
  declinedText: string;
  /** How they fit the focused show (null: no focus). */
  fitKind: FitKind | null;
  /** Also booked within 90 minutes of the focused show. */
  alsoBooked: string | null;
  focusStartMin: number | null;
  /** The board's date. */
  date: string;
}

/** The draggable wrapper: re-renders with dnd-kit; the face only when its props change. */
const PoolCard = memo(function PoolCard(props: PoolCardProps) {
  const { comedian } = props;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: comedianDragId(comedian.id),
    data: { kind: 'comedian', comedianId: comedian.id, label: comedian.name } satisfies DragData,
  });
  const stableListeners = useStableListeners(listeners);
  return (
    <PoolCardFace
      {...props}
      isDragging={isDragging}
      attributes={attributes}
      listeners={stableListeners}
      setNodeRef={setNodeRef}
    />
  );
});

const FIT_PILL: Record<FitKind, string> = {
  fits: 'bg-available-soft text-available-fg',
  outside: 'bg-awaiting-soft/70 text-awaiting-fg',
  unavailable: 'text-fg-subtle',
  not_marked: 'bg-surface-2 text-fg-muted',
  in_show: 'bg-accent-soft text-accent',
};

const PoolCardFace = memo(function PoolCardFace({
  comedian,
  selected,
  availLabel,
  bookedText,
  declinedText,
  fitKind,
  alsoBooked,
  focusStartMin,
  date,
  isDragging,
  attributes,
  listeners,
  setNodeRef,
}: PoolCardProps & {
  isDragging: boolean;
  attributes: DraggableAttributes;
  listeners: ReturnType<typeof useStableListeners>;
  setNodeRef: (element: HTMLElement | null) => void;
}) {
  const actions = useBoardActions();
  const [cardOpen, setCardOpen] = useState(false);
  const state = comedianState(comedian);
  const month = monthOf(date);
  const dateShort = formatDateShort(date);
  const time = focusStartMin != null ? formatTime(focusStartMin) : '';

  // The pill: their range (no focus), or how they fit the focused show's time.
  let pill: { text: string; className: string; title: string; check?: boolean };
  if (fitKind) {
    pill = {
      fits: { text: availLabel, className: FIT_PILL.fits, title: `Marked ${availLabel}: fits ${time}`, check: true },
      outside: { text: 'Outside hours', className: FIT_PILL.outside, title: `Marked ${availLabel} for ${dateShort}; the show starts at ${time}` },
      unavailable: { text: 'Unavailable', className: FIT_PILL.unavailable, title: `Submitted ${formatMonthName(month)}; not free ${dateShort}` },
      not_marked: { text: 'Not marked', className: FIT_PILL.not_marked, title: `Hasn't submitted ${formatMonthName(month)} availability` },
      in_show: { text: 'In lineup', className: FIT_PILL.in_show, title: `Already in the ${time} lineup` },
    }[fitKind];
  } else {
    pill = {
      text: availLabel,
      className: cn(
        state === 'available' && 'bg-available-soft text-available-fg',
        state === 'not_submitted' && 'bg-surface-2 text-fg-muted',
        state === 'unavailable' && 'text-fg-subtle',
      ),
      title:
        state === 'available'
          ? `Marked ${availLabel} for ${dateShort}`
          : state === 'unavailable'
            ? `Submitted ${formatMonthName(month)}; not free ${dateShort}`
            : `Hasn't submitted ${formatMonthName(month)} availability`,
    };
  }
  const dimmed = fitKind ? fitKind !== 'fits' : state !== 'available';

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      actions.clickComedian(comedian.id);
    } else {
      listeners.onKeyDown?.(event);
    }
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('[data-note-trigger]')) {
      setCardOpen(true);
      return;
    }
    actions.clickComedian(comedian.id);
  }

  return (
    <li>
      <ComedianHoverCard comedianId={comedian.id} open={cardOpen} onOpenChange={setCardOpen}>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          onKeyDown={onKeyDown}
          onClick={onClick}
          aria-pressed={selected}
          aria-label={[
            comedian.name,
            fitKind ? `${pill.text} for ${time}${fitKind === 'fits' ? ` (marked ${availLabel})` : ''}` : state === 'available' ? `available ${availLabel}` : availLabel,
            alsoBooked ? `also booked ${alsoBooked}` : bookedText ? `booked ${bookedText}` : null,
            declinedText ? `declined ${declinedText}` : null,
            comedian.noteCount ? `${comedian.noteCount} ${comedian.noteCount === 1 ? 'note' : 'notes'}` : null,
            comedian.tags.length ? `tags: ${comedian.tags.map((t) => t.name).join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('. ')}
          className={cn(
            'flex cursor-grab touch-manipulation items-center gap-2.5 rounded-md px-2 py-1.5 select-none',
            'transition-colors hover:bg-surface-2 active:cursor-grabbing',
            isDragging && 'opacity-50',
            selected && 'bg-accent-soft ring-2 ring-accent hover:bg-accent-soft',
          )}
        >
          <Avatar name={comedian.name} src={comedian.headshotUrl} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={cn('min-w-0 truncate text-[13px] font-medium', dimmed ? 'text-fg-muted' : 'text-fg')}>
                {comedian.name}
              </span>
              {comedian.noteCount > 0 && (
                <span
                  aria-hidden
                  data-note-trigger
                  title={comedian.latestNote ? `${comedian.noteCount === 1 ? 'Note' : `${comedian.noteCount} notes`}: ${comedian.latestNote}` : undefined}
                  className="-my-1 flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-0.5 py-1 text-[11px] font-medium text-fg-subtle hover:bg-surface-3 hover:text-fg"
                >
                  <StickyNote className="size-3" />
                  {comedian.noteCount}
                </span>
              )}
              <span
                title={pill.title}
                className={cn(
                  'ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-medium whitespace-nowrap tabular-nums',
                  pill.className,
                )}
              >
                {pill.check && <Check aria-hidden className="-ml-0.5 size-3" strokeWidth={2.5} />}
                {pill.text}
              </span>
            </div>
            <div className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-[11px] text-fg-muted">
              {alsoBooked ? (
                <span className="flex min-w-0 shrink items-center gap-1 font-medium text-awaiting-fg" title={`Also booked ${alsoBooked}`}>
                  <Clock aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">Also booked {alsoBooked}</span>
                </span>
              ) : bookedText ? (
                <span className="flex min-w-0 shrink items-center gap-1 font-medium text-accent" title={`Booked ${bookedText}`}>
                  <CircleCheck aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">Booked {bookedText}</span>
                </span>
              ) : declinedText ? (
                <span className="min-w-0 shrink truncate text-declined-fg" title={`Declined ${declinedText}`}>
                  {/* Struck through like their chip in the lineup. */}
                  Declined <span className="line-through decoration-declined decoration-[1.5px]">{declinedText}</span>
                </span>
              ) : fitKind === 'outside' ? (
                <span className="min-w-0 shrink truncate">Marked {availLabel}</span>
              ) : null}
              <TagLine tags={comedian.tags} compact={Boolean(alsoBooked || bookedText || declinedText || fitKind === 'outside')} />
            </div>
          </div>
        </div>
      </ComedianHoverCard>
    </li>
  );
});

/** Tag names with color dots; just the dots when space is needed for "Booked …". */
function TagLine({ tags, compact }: { tags: LineupTag[]; compact: boolean }) {
  if (tags.length === 0) return null;
  if (compact) {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-0.5" title={tags.map((t) => t.name).join(', ')}>
        {tags.map((t) => (
          <span key={t.id} aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: t.color }} />
        ))}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2 overflow-hidden">
      {tags.map((t) => (
        <span key={t.id} className="flex shrink-0 items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: t.color }} />
          {t.name}
        </span>
      ))}
    </span>
  );
}
