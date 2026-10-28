/**
 * /app/day/:date — the lineup board (spec §6 F2). Every scheduled show that night, grouped by
 * location then time, with numbered slots; the comedian pool on the right.
 *
 * Drag a comedian from the pool into an empty slot to book; drag a chip to another slot to
 * move (onto an occupied slot to swap); drag it back to the pool or click × to unbook. Or
 * click to select, then click where it goes (keyboard / touch fallback). Booking someone who
 * isn't available asks first ("Book anyway?"). Every change is optimistic and persists
 * immediately.
 */
import {
  DndContext,
  DragOverlay,
  defaultDropAnimationSideEffects,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarPlus, ChevronLeft, ChevronRight, Copy, Ellipsis, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { DayResponse, DayShow } from '../../../shared/api/lineup';
import { addDays, formatDateLong, formatDateMedium, formatMonthLong, isValidDate, monthOf } from '../../../shared/time';
import {
  Badge,
  Button,
  buttonClasses,
  ColorDot,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PageHeader,
} from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { usePageTitle } from '../../lib/usePageTitle';
import { BoardContext, isSelected, type BoardState, type Selection } from './BoardContext';
import { BoardSkeleton, DragPreview, PoolSkeleton, SelectionBar, showGridStyle, StatusLegend } from './BoardChrome';
import { ComedianPool } from './ComedianPool';
import { SCREEN_READER_INSTRUCTIONS, lineupCollision, useLineupSensors, type DragData, type DropData } from './dnd';
import {
  dayText,
  indexDay,
  lineupText,
  planDrop,
  sourceComedianId,
  type DropPlan,
  type LineupSource,
  type LineupTarget,
  type PoolFilter,
} from './lineupModel';
import { ShowCard } from './ShowCard';
import { UnavailableDialog, type PendingConflict } from './UnavailableDialog';
import { isTempId, prefetchDay, useCopy, useDay, useLineupActions } from './useLineup';

const DROP_ANIMATION: DropAnimation = {
  duration: 180,
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.4' } } }),
};

const announcementLabel = (data: unknown) => (data as { label?: string } | undefined)?.label ?? 'item';

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `Picked up ${announcementLabel(active.data.current)}.`,
  onDragOver: ({ active, over }) =>
    over
      ? `${announcementLabel(active.data.current)} is over ${announcementLabel(over.data.current)}.`
      : `${announcementLabel(active.data.current)} is no longer over a slot.`,
  onDragEnd: ({ active, over }) =>
    over
      ? `${announcementLabel(active.data.current)} was dropped on ${announcementLabel(over.data.current)}.`
      : `${announcementLabel(active.data.current)} was dropped.`,
  onDragCancel: ({ active }) => `Cancelled. ${announcementLabel(active.data.current)} was not moved.`,
};

export function DayPage() {
  const { date = '' } = useParams();
  if (!isValidDate(date)) return <InvalidDate />;
  return <DayBoard date={date} />;
}

function InvalidDate() {
  usePageTitle('Day');
  return (
    <EmptyState
      title="That isn’t a date we know"
      description="Pick a day from the calendar."
      action={
        <Link to="/app/calendar" className={buttonClasses({ variant: 'secondary' })}>
          Open the calendar
        </Link>
      }
    />
  );
}

const EMPTY_FILTER: PoolFilter = { search: '', tagIds: [], availableOnly: false };

function DayBoard({ date }: { date: string }) {
  const queryClient = useQueryClient();
  const query = useDay(date);
  const day = query.data;
  const copy = useCopy();

  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState<LineupSource | null>(null);
  const [over, setOver] = useState<LineupTarget | null>(null);
  const [dropAccepted, setDropAccepted] = useState(false);
  const [pending, setPending] = useState<PendingConflict | null>(null);
  // Filters stick while paging between days (the component stays mounted).
  const [filter, setFilter] = useState<PoolFilter>(EMPTY_FILTER);

  const actions = useLineupActions(date, {
    onUnavailable: (conflicts, retry) => setPending({ conflicts, confirm: retry }),
  });
  const sensors = useLineupSensors();

  // A new day starts with nothing selected; warm the neighbors so prev/next are instant.
  useEffect(() => setSelection(null), [date]);
  const loaded = day != null;
  useEffect(() => {
    if (!loaded) return;
    prefetchDay(queryClient, addDays(date, -1));
    prefetchDay(queryClient, addDays(date, 1));
  }, [loaded, date, queryClient]);

  // Escape clears a click-to-place selection.
  useEffect(() => {
    if (!selection) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  // Drop a selection whose booking/comedian/show vanished (refetch, undo, another tab).
  useEffect(() => {
    if (!day || !selection) return;
    const index = indexDay(day);
    const stale =
      (selection.kind === 'booking' && !index.bookings.has(selection.bookingId)) ||
      (selection.kind === 'comedian' && !index.comedians.has(selection.comedianId)) ||
      (selection.kind === 'slot' && (index.shows.get(selection.showId)?.slotCount ?? 0) <= selection.position);
    if (stale) setSelection(null);
  }, [day, selection]);

  /** Carry out a planned drop; ask first when someone isn't available. */
  const attempt = useCallback(
    (plan: DropPlan) => {
      switch (plan.kind) {
        case 'none':
          return;
        case 'reject':
          toast(plan.reason);
          return;
        case 'unbook':
          actions.unbook(plan.bookingId);
          return;
        case 'book':
        case 'move': {
          const run = (force: boolean) =>
            plan.kind === 'book'
              ? actions.book({ comedianId: plan.comedianId, showId: plan.showId, position: plan.position, force })
              : actions.move({ bookingId: plan.bookingId, showId: plan.showId, position: plan.position, force });
          if (plan.conflicts.length) setPending({ conflicts: plan.conflicts, confirm: () => run(true) });
          else run(false);
        }
      }
    },
    [actions],
  );

  const board = useMemo<BoardState | null>(() => {
    if (!day) return null;
    const index = indexDay(day);
    const slot = (showId: number, position: number): LineupTarget => ({ kind: 'slot', showId, position });
    return {
      day,
      index,
      dragging,
      selection,
      focusComedianId:
        sourceComedianId(day, dragging) ??
        (selection && selection.kind !== 'slot' ? sourceComedianId(day, selection) : null),
      preview: (target) => (dragging ? planDrop(day, dragging, target) : { kind: 'none' }),
      clickComedian: (comedianId) => {
        const source: LineupSource = { kind: 'comedian', comedianId };
        if (selection?.kind === 'slot') {
          attempt(planDrop(day, source, selection));
          setSelection(null);
        } else {
          setSelection(isSelected(selection, source) ? null : source);
        }
      },
      clickBooking: (bookingId) => {
        const booking = index.bookings.get(bookingId);
        if (!booking || isTempId(bookingId)) return;
        const source: LineupSource = { kind: 'booking', bookingId };
        if (selection && selection.kind !== 'slot' && !isSelected(selection, source)) {
          // Something is picked up: put it here (swap, or "slot taken" for a pool comedian).
          const plan = planDrop(day, selection, slot(booking.showId, booking.position));
          attempt(plan);
          if (plan.kind !== 'reject') setSelection(null);
          return;
        }
        setSelection(isSelected(selection, source) ? null : source);
      },
      clickSlot: (showId, position) => {
        if (selection && selection.kind !== 'slot') {
          const plan = planDrop(day, selection, slot(showId, position));
          attempt(plan);
          if (plan.kind !== 'reject') setSelection(null);
          return;
        }
        const target: Selection = { kind: 'slot', showId, position };
        setSelection(isSelected(selection, target) ? null : target);
      },
      unbook: (bookingId) => {
        if (isTempId(bookingId)) return;
        actions.unbook(bookingId);
        setSelection((s) => (s?.kind === 'booking' && s.bookingId === bookingId ? null : s));
      },
      setSlotCount: (showId, slotCount) => actions.setSlotCount(showId, slotCount),
      copyLineup: (showId) => {
        const show = index.shows.get(showId);
        if (show) void copy(lineupText(day, show), 'Lineup');
      },
    };
  }, [day, dragging, selection, attempt, actions, copy]);

  // ---- drag & drop -----------------------------------------------------------

  function onDragStart({ active }: DragStartEvent) {
    setSelection(null);
    setDropAccepted(false);
    setDragging(active.data.current as DragData);
  }

  function onDragOver({ over: target }: DragOverEvent) {
    setOver(target ? (target.data.current as DropData) : null);
  }

  function onDragEnd({ active, over: target }: DragEndEvent) {
    const source = active.data.current as DragData | undefined;
    setDragging(null);
    setOver(null);
    if (!day || !source || !target) return;
    const plan = planDrop(day, source, target.data.current as DropData);
    setDropAccepted(plan.kind === 'book' || plan.kind === 'move' || plan.kind === 'unbook');
    attempt(plan);
  }

  function onDragCancel() {
    setDragging(null);
    setOver(null);
  }

  // ---- render ----------------------------------------------------------------

  const month = monthOf(date);
  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const isToday = day ? day.today === date : false;

  const header = (
    <PageHeader
      eyebrow={
        <Link to={`/app/calendar?month=${month}`} className="inline-flex items-center gap-1 rounded hover:text-fg">
          <ArrowLeft className="size-3.5" aria-hidden /> {formatMonthLong(month)}
        </Link>
      }
      title={
        <span className="flex items-center gap-2">
          {formatDateLong(date)}
          {isToday && <Badge variant="accent">Today</Badge>}
        </span>
      }
      documentTitle={formatDateLong(date)}
      description={day ? <DaySummary day={day} /> : <span className="invisible">Loading</span>}
      actions={
        <>
          <div className="flex items-center">
            <Link
              to={`/app/day/${prev}`}
              onMouseEnter={() => prefetchDay(queryClient, prev)}
              className={buttonClasses({ variant: 'secondary', size: 'icon', className: 'rounded-r-none' })}
              aria-label={`Previous day, ${formatDateMedium(prev)}`}
              title={formatDateMedium(prev)}
            >
              <ChevronLeft />
            </Link>
            <Link
              to={`/app/day/${next}`}
              onMouseEnter={() => prefetchDay(queryClient, next)}
              className={buttonClasses({ variant: 'secondary', size: 'icon', className: '-ml-px rounded-l-none' })}
              aria-label={`Next day, ${formatDateMedium(next)}`}
              title={formatDateMedium(next)}
            >
              <ChevronRight />
            </Link>
          </div>
          {day && !isToday && (
            <Link to={`/app/day/${day.today}`} className={buttonClasses({ variant: 'secondary' })}>
              Today
            </Link>
          )}
          <Menu>
            <MenuTrigger asChild>
              <Button variant="secondary" size="icon" aria-label="More actions" disabled={!day?.shows.length}>
                <Ellipsis />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => day && void copy(dayText(day), 'All lineups')}>
                <Copy /> Copy all lineups
              </MenuItem>
              <MenuItem asChild>
                <Link to={`/app/shows/new?month=${month}`}>
                  <CalendarPlus /> Create shows
                </Link>
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      }
    />
  );

  if (query.isError && !day) {
    return (
      <div>
        {header}
        <EmptyState
          title="Couldn’t load this day"
          description={errorMessage(query.error)}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              <RotateCw /> Try again
            </Button>
          }
        />
      </div>
    );
  }

  const poolClasses =
    'lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)] lg:w-64 lg:shrink-0 2xl:w-80 max-lg:max-h-[26rem] max-lg:order-first';

  return (
    <div>
      {header}
      {!board ? (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <BoardSkeleton />
          </div>
          <div className={cn('rounded-lg border border-border bg-surface', poolClasses)}>
            <PoolSkeleton />
          </div>
        </div>
      ) : (
        <BoardContext.Provider value={board}>
          <DndContext
            sensors={sensors}
            collisionDetection={lineupCollision}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
            accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: { draggable: SCREEN_READER_INSTRUCTIONS } }}
          >
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
              <div className="min-w-0 flex-1">
                {board.day.shows.length > 0 ? (
                  <>
                    <StatusLegend className="mb-4" />
                    <LocationSections shows={board.day.shows} />
                  </>
                ) : (
                  <NoShows date={date} />
                )}
              </div>
              <ComedianPool filter={filter} onFilterChange={setFilter} className={poolClasses} />
            </div>
            {createPortal(
              <DragOverlay dropAnimation={dropAccepted ? null : DROP_ANIMATION} zIndex={60}>
                {dragging && (
                  <DragPreview day={board.day} source={dragging} plan={over ? planDrop(board.day, dragging, over) : null} />
                )}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
          <SelectionBar
            day={board.day}
            selection={selection}
            onClear={() => setSelection(null)}
            onUnbook={(id) => board.unbook(id)}
          />
        </BoardContext.Provider>
      )}
      <UnavailableDialog pending={pending} onClose={() => setPending(null)} />
    </div>
  );
}

function DaySummary({ day }: { day: DayResponse }) {
  const slots = day.shows.reduce((n, s) => n + s.slotCount, 0);
  const filled = day.shows.reduce((n, s) => n + s.bookings.length, 0);
  const unconfirmed = day.shows.reduce(
    (n, s) => n + s.bookings.filter((b) => b.status === 'unconfirmed_today').length,
    0,
  );
  if (day.shows.length === 0) return <>No shows scheduled</>;
  return (
    <span className="tabular-nums">
      {day.shows.length} {day.shows.length === 1 ? 'show' : 'shows'} · {filled} of {slots} slots filled
      {unconfirmed > 0 && <span className="text-unconfirmed-fg"> · {unconfirmed} unconfirmed tonight</span>}
    </span>
  );
}

/** Shows grouped by location, keeping the server's order (location sort order, then time). */
function LocationSections({ shows }: { shows: DayShow[] }) {
  const groups: { location: DayShow['location']; shows: DayShow[] }[] = [];
  for (const show of shows) {
    const last = groups[groups.length - 1];
    if (last && last.location.id === show.location.id) last.shows.push(show);
    else groups.push({ location: show.location, shows: [show] });
  }
  const columns = Math.max(4, ...groups.map((g) => g.shows.length));
  return (
    <div className="space-y-6">
      {groups.map(({ location, shows: locationShows }) => {
        const slots = locationShows.reduce((n, s) => n + s.slotCount, 0);
        const filled = locationShows.reduce((n, s) => n + s.bookings.length, 0);
        return (
          <section key={location.id} aria-label={location.name}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
              <ColorDot color={location.color} size="md" />
              {location.name}
              <span className="font-normal text-fg-muted tabular-nums">
                · {locationShows.length} {locationShows.length === 1 ? 'show' : 'shows'} · {filled}/{slots} filled
              </span>
            </h2>
            <div className="grid items-start gap-3" style={showGridStyle(columns)}>
              {locationShows.map((show) => (
                <ShowCard key={show.id} show={show} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function NoShows({ date }: { date: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong">
      <EmptyState
        icon={CalendarPlus}
        title={`No shows on ${formatDateLong(date)}`}
        description="Create shows for this night from the calendar, then build the lineups here."
        action={
          <Link to={`/app/shows/new?month=${monthOf(date)}`} className={buttonClasses({ variant: 'secondary' })}>
            <CalendarPlus /> Create shows
          </Link>
        }
      />
    </div>
  );
}
