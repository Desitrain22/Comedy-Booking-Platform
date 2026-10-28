/**
 * Right sidebar: the comedian pool. Search, tag chips ("pull comedians from a group"),
 * "available only" toggle, and one draggable card per comedian with their availability for
 * this date and where they're already booked. Also the drop zone for unbooking.
 */
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CircleCheck, Search, Undo2, X } from 'lucide-react';
import { useMemo, type KeyboardEvent } from 'react';
import type { DayComedian, LineupTag } from '../../../shared/api/lineup';
import { DEFAULT_ALL_NIGHT, formatAvailability } from '../../../shared/availability';
import { formatDateShort, formatMonthName, formatTime, monthOf } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import { Avatar, Input, Switch } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useClub } from '../../lib/useMe';
import { isSelected, useBoard } from './BoardContext';
import { comedianDragId, POOL_DROP_ID, type DragData, type DropData } from './dnd';
import { comedianState, filterPool, type PoolFilter } from './lineupModel';

export interface ComedianPoolProps {
  filter: PoolFilter;
  onFilterChange: (filter: PoolFilter) => void;
  className?: string;
}

export function ComedianPool({ filter, onFilterChange, className }: ComedianPoolProps) {
  const board = useBoard();
  const { day } = board;
  const { setNodeRef, isOver } = useDroppable({
    id: POOL_DROP_ID,
    data: { kind: 'pool', label: 'the comedian list (removes them from the lineup)' } satisfies DropData,
  });
  const visible = useMemo(() => filterPool(day.comedians, filter), [day.comedians, filter]);
  const availableCount = day.comedians.filter((c) => c.availability != null).length;
  const draggingBooking = board.dragging?.kind === 'booking';
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
          <span className="text-xs text-fg-muted tabular-nums">
            <span className="font-medium text-available-fg">{availableCount}</span> of {day.comedians.length} available
          </span>
        </div>
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
            label={`Available ${dateLabel} only`}
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
        {visible.map((comedian) => (
          <PoolCard key={comedian.id} comedian={comedian} />
        ))}
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

function availabilityLabel(comedian: DayComedian, allNight = DEFAULT_ALL_NIGHT): string {
  if (comedian.availability) return formatAvailability(comedian.availability, allNight);
  return comedian.submittedMonth ? 'unavailable' : 'not marked';
}

function PoolCard({ comedian }: { comedian: DayComedian }) {
  const board = useBoard();
  const { day, index } = board;
  const allNight = useClub()?.allNight;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: comedianDragId(comedian.id),
    data: { kind: 'comedian', comedianId: comedian.id, label: comedian.name } satisfies DragData,
  });
  const state = comedianState(comedian);
  const booked = index.bookingsByComedian.get(comedian.id) ?? [];
  const selected = isSelected(board.selection, { kind: 'comedian', comedianId: comedian.id });
  const avail = availabilityLabel(comedian, allNight);
  const month = monthOf(day.date);
  const availTitle =
    state === 'available'
      ? `Marked ${avail} for ${formatDateShort(day.date)}`
      : state === 'unavailable'
        ? `Submitted ${formatMonthName(month)}; not free ${formatDateShort(day.date)}`
        : `Hasn't submitted ${formatMonthName(month)} availability`;
  const bookedText = booked
    .map((b) => index.shows.get(b.showId))
    .map((show) => (show ? `${formatTime(show.startMin)} · ${show.location.name}` : ''))
    .join(', ');

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      board.clickComedian(comedian.id);
    } else {
      listeners?.onKeyDown?.(event);
    }
  }

  return (
    <li>
      <ComedianHoverCard comedianId={comedian.id}>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          onKeyDown={onKeyDown}
          onClick={() => board.clickComedian(comedian.id)}
          aria-pressed={selected}
          aria-label={[
            comedian.name,
            state === 'available' ? `available ${avail}` : avail,
            booked.length ? `booked ${bookedText}` : null,
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
            <div className="flex items-center gap-2">
              <span className={cn('min-w-0 truncate text-[13px] font-medium', state === 'available' ? 'text-fg' : 'text-fg-muted')}>
                {comedian.name}
              </span>
              <span
                title={availTitle}
                className={cn(
                  'ml-auto shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium whitespace-nowrap tabular-nums',
                  state === 'available' && 'bg-available-soft text-available-fg',
                  state === 'not_submitted' && 'bg-surface-2 text-fg-muted',
                  state === 'unavailable' && 'text-fg-subtle',
                )}
              >
                {avail}
              </span>
            </div>
            <div className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-[11px] text-fg-muted">
              {booked.length > 0 && (
                <span className="flex min-w-0 shrink items-center gap-1 font-medium text-accent" title={`Booked ${bookedText}`}>
                  <CircleCheck aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">Booked {bookedText}</span>
                </span>
              )}
              <TagLine tags={comedian.tags} compact={booked.length > 0} />
            </div>
          </div>
        </div>
      </ComedianHoverCard>
    </li>
  );
}

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
