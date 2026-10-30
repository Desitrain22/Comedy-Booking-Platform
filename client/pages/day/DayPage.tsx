/**
 * /app/day/:date — the lineup board (spec §6 F2). Every scheduled show that night, grouped by
 * location then time, with numbered slots; the comedian pool on the right.
 *
 * Drag a comedian from the pool into an empty slot to book (onto a booked slot to replace
 * that comedian, with Undo); drag a chip to another slot to move (onto an occupied slot to
 * swap); drag it back to the pool or click × to unbook (with Undo). Or
 * click to select, then click where it goes (keyboard / touch fallback). Booking someone who
 * isn't available asks first ("Book anyway?"); booking someone within 90 minutes of another
 * spot that night warns (a toast, never a block). Every change is optimistic and persists
 * immediately.
 *
 * Selecting an empty (or declined) slot — or "Who's free at 9 PM" in a show's menu — focuses
 * the pool on that show's time. The header nudges when spots booked this week were never
 * emailed ("Send"), and the menu can cancel every show that night (with Undo).
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  MailWarning,
  RotateCw,
  Send,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { SendConfirmationsInput, SendConfirmationsResponse } from '../../../shared/api/dashboard';
import type { DayResponse, DayShow } from '../../../shared/api/lineup';
import type { BulkShowStatusInput, BulkShowStatusResponse } from '../../../shared/api/shows';
import { addDays, formatDateLong, formatDateMedium, formatMonthLong, isValidDate, monthOf } from '../../../shared/time';
import {
  Badge,
  Button,
  buttonClasses,
  ColorDot,
  ConfirmDialog,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PageHeader,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { FULL_WIDTH_PAGE } from '../../layouts/BookerLayout';
import { useClub } from '../../lib/useMe';
import { usePageTitle } from '../../lib/usePageTitle';
import { plural } from '../shows/showFormat';
import { invalidateShowData } from '../shows/showsData';
import {
  BoardActionsContext,
  BoardContext,
  BoardLiveContext,
  isSelected,
  type BoardActions,
  type BoardData,
  type BoardLive,
  type Selection,
} from './BoardContext';
import { BoardSkeleton, DragPreview, PoolSkeleton, SelectionBar, showGridStyle, StatusLegend } from './BoardChrome';
import { ComedianPool } from './ComedianPool';
import { SCREEN_READER_INSTRUCTIONS, lineupCollision, useLineupSensors, type DragData, type DropData } from './dnd';
import {
  dayText,
  indexDay,
  lineupText,
  overlapWarning,
  planDrop,
  showTitle,
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
  const club = useClub();

  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState<LineupSource | null>(null);
  const [over, setOver] = useState<LineupTarget | null>(null);
  const [dropAccepted, setDropAccepted] = useState(false);
  const [pending, setPending] = useState<PendingConflict | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
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

  /** Carry out a planned drop; ask first when someone isn't available; warn about clashes. */
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
          // Who'd now be within 90 minutes of another of their spots (from the board as it is).
          const warnings = day ? clashWarnings(day, plan) : [];
          const run = (force: boolean) => {
            if (plan.kind === 'book') {
              actions.book({
                comedianId: plan.comedianId,
                showId: plan.showId,
                position: plan.position,
                replaceBookingId: plan.replacing?.id,
                force,
              });
            } else {
              actions.move({ bookingId: plan.bookingId, showId: plan.showId, position: plan.position, force });
            }
            for (const warning of warnings) toast.warning(warning, { id: `clash-${warning}` });
          };
          if (plan.conflicts.length) setPending({ conflicts: plan.conflicts, confirm: () => run(true) });
          else run(false);
        }
      }
    },
    [actions, day],
  );

  // The leaves get stable actions that read the latest state when called (UX D18).
  const latest = useRef({ day, selection, attempt, actions, copy });
  latest.current = { day, selection, attempt, actions, copy };
  const boardActions = useMemo<BoardActions>(() => {
    const slot = (showId: number, position: number) => ({ kind: 'slot' as const, showId, position });
    return {
      clickComedian: (comedianId) => {
        const { day, selection, attempt } = latest.current;
        if (!day) return;
        const source: LineupSource = { kind: 'comedian', comedianId };
        if (selection?.kind === 'slot') {
          attempt(planDrop(day, source, selection));
          setSelection(null);
        } else {
          setSelection(isSelected(selection, source) ? null : source);
        }
      },
      clickBooking: (bookingId) => {
        const { day, selection, attempt } = latest.current;
        const booking = day ? indexDay(day).bookings.get(bookingId) : undefined;
        if (!day || !booking || isTempId(bookingId)) return;
        const source: LineupSource = { kind: 'booking', bookingId };
        if (selection && selection.kind !== 'slot' && !isSelected(selection, source)) {
          // Something is picked up: put it here (swap, or replace for a pool comedian).
          const plan = planDrop(day, selection, slot(booking.showId, booking.position));
          attempt(plan);
          if (plan.kind !== 'reject') setSelection(null);
          return;
        }
        if (booking.declinedAt != null) {
          // A declined spot: select the slot, so the next comedian picked replaces them.
          const target: Selection = slot(booking.showId, booking.position);
          setSelection(isSelected(selection, target) ? null : target);
          return;
        }
        setSelection(isSelected(selection, source) ? null : source);
      },
      clickSlot: (showId, position) => {
        const { day, selection, attempt } = latest.current;
        if (!day) return;
        if (selection && selection.kind !== 'slot') {
          const plan = planDrop(day, selection, slot(showId, position));
          attempt(plan);
          if (plan.kind !== 'reject') setSelection(null);
          return;
        }
        const target: Selection = slot(showId, position);
        setSelection(isSelected(selection, target) ? null : target);
      },
      unbook: (bookingId) => {
        if (isTempId(bookingId)) return;
        latest.current.actions.unbook(bookingId);
        setSelection((s) => (s?.kind === 'booking' && s.bookingId === bookingId ? null : s));
      },
      setSlotCount: (showId, slotCount) => latest.current.actions.setSlotCount(showId, slotCount),
      copyLineup: (showId) => {
        const { day, copy } = latest.current;
        const show = day ? indexDay(day).shows.get(showId) : undefined;
        if (day && show) void copy(lineupText(day, show), 'Lineup');
      },
      focusShow: (showId) => {
        const { day } = latest.current;
        const show = day ? indexDay(day).shows.get(showId) : undefined;
        if (!show) return;
        const taken = new Map(show.bookings.map((b) => [b.position, b]));
        const open = Array.from({ length: show.slotCount }, (_, i) => i).find((i) => !taken.has(i));
        const declined = show.bookings.find((b) => b.declinedAt != null)?.position;
        const position = open ?? declined;
        if (position == null) {
          toast(`The ${showTitle(show)} is full. Click a slot’s comedian to move or replace them.`);
          return;
        }
        setSelection(slot(showId, position));
      },
    };
  }, []);

  const data = useMemo<BoardData | null>(
    () => (day ? { day, index: indexDay(day), actions: boardActions } : null),
    [day, boardActions],
  );
  const live = useMemo<BoardLive | null>(() => {
    if (!day) return null;
    return {
      dragging,
      selection,
      focusComedianId:
        sourceComedianId(day, dragging) ??
        (selection && selection.kind !== 'slot' ? sourceComedianId(day, selection) : null),
      focusShowId: selection?.kind === 'slot' && !dragging ? selection.showId : null,
      preview: (target) => (dragging ? planDrop(day, dragging, target) : { kind: 'none' }),
    };
  }, [day, dragging, selection]);

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
  const scheduledShows = day?.shows ?? [];

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
              <MenuItem destructive onSelect={() => setConfirmCancel(true)}>
                <Ban /> Cancel all shows this day
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      }
    />
  );

  if (query.isError && !day) {
    return (
      <div {...FULL_WIDTH_PAGE}>
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

  // Owner decision: with declines off there's no decline UI at all, legend included (a spot
  // declined while they were on still reads "Declined" on its chip).
  const showDeclined = Boolean(club?.allowDeclines);

  return (
    <div {...FULL_WIDTH_PAGE}>
      {header}
      {day && <UnsentNudge day={day} />}
      {!data || !live ? (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <BoardSkeleton />
          </div>
          <div className={cn('rounded-lg border border-border bg-surface', poolClasses)}>
            <PoolSkeleton />
          </div>
        </div>
      ) : (
        <BoardContext.Provider value={data}>
          <BoardActionsContext.Provider value={boardActions}>
            <BoardLiveContext.Provider value={live}>
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
                    {data.day.shows.length > 0 ? (
                      <>
                        <StatusLegend className="mb-4" showDeclined={showDeclined} />
                        <LocationSections shows={data.day.shows} />
                      </>
                    ) : (
                      <NoShows date={date} />
                    )}
                  </div>
                  <ComedianPool
                    filter={filter}
                    onFilterChange={setFilter}
                    onClearFocus={() => setSelection(null)}
                    className={poolClasses}
                  />
                </div>
                {createPortal(
                  <DragOverlay dropAnimation={dropAccepted ? null : DROP_ANIMATION} zIndex={60}>
                    {dragging && (
                      <DragPreview day={data.day} source={dragging} plan={over ? planDrop(data.day, dragging, over) : null} />
                    )}
                  </DragOverlay>,
                  document.body,
                )}
              </DndContext>
              <SelectionBar
                day={data.day}
                selection={selection}
                onClear={() => setSelection(null)}
                onUnbook={(id) => boardActions.unbook(id)}
              />
            </BoardLiveContext.Provider>
          </BoardActionsContext.Provider>
        </BoardContext.Provider>
      )}
      <UnavailableDialog pending={pending} onClose={() => setPending(null)} />
      <CancelDayDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        date={date}
        shows={scheduledShows}
      />
    </div>
  );
}

/** Toasts for anyone a drop leaves within 90 minutes of another of their spots (UX B11). */
function clashWarnings(day: DayResponse, plan: Extract<DropPlan, { kind: 'book' | 'move' }>): string[] {
  const index = indexDay(day);
  const target = index.shows.get(plan.showId);
  if (!target) return [];
  if (plan.kind === 'book') {
    const warning = overlapWarning(day, plan.comedianId, target);
    return warning ? [`Heads up: ${warning}`] : [];
  }
  const moving = index.bookings.get(plan.bookingId);
  const source = moving ? index.shows.get(moving.showId) : undefined;
  if (!moving || !source || source.id === target.id) return [];
  const warnings = [overlapWarning(day, moving.comedianId, target, moving.id)];
  if (plan.swapWith) warnings.push(overlapWarning(day, plan.swapWith.comedianId, source, plan.swapWith.id));
  return warnings.filter((w): w is string => w != null).map((w) => `Heads up: ${w}`);
}

/**
 * "3 booked this week haven't been emailed yet – Send": spots booked after the weekly
 * confirmations went out (the daily catch-up sends them too; this sends them now).
 */
function UnsentNudge({ day }: { day: DayResponse }) {
  const queryClient = useQueryClient();
  const { weekStart, weekEnd, count } = day.unsentThisWeek;
  const send = useMutation({
    mutationFn: () =>
      api.post<SendConfirmationsResponse>('/confirmations/send', { weekStart, onlyUnsent: true } satisfies SendConfirmationsInput),
    onSuccess: (result) => {
      if (result.failed) {
        toast.error(`Emailed ${plural(result.sent, 'comedian')}; ${result.failed} failed. See the email log.`);
      } else {
        toast.success(result.sent ? `Emailed ${plural(result.sent, 'comedian')} their spots this week` : 'Nothing left to email');
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['days'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  // Only on this week's days, where it's about the spots in front of you.
  if (count === 0 || day.date < weekStart || day.date > weekEnd) return null;
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-awaiting/40 bg-awaiting-soft px-3 py-2 text-sm text-awaiting-fg"
    >
      <MailWarning className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">{count}</strong> booked this week {count === 1 ? 'hasn’t' : 'haven’t'} been
        emailed yet
      </span>
      <Button size="sm" variant="secondary" loading={send.isPending} onClick={() => send.mutate()}>
        <Send aria-hidden /> Send
      </Button>
    </div>
  );
}

/** "Cancel all shows this day" — keeps the lineups; Undo restores them. */
function CancelDayDialog({
  open,
  onOpenChange,
  date,
  shows,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string;
  shows: DayShow[];
}) {
  const queryClient = useQueryClient();
  const ids = shows.map((s) => s.id);
  const booked = shows.reduce((n, s) => n + s.bookings.length, 0);
  const setStatus = (showIds: number[], status: BulkShowStatusInput['status']) =>
    api.post<BulkShowStatusResponse>('/shows/bulk-status', { ids: showIds, status } satisfies BulkShowStatusInput);

  async function cancelAll() {
    const result = await setStatus(ids, 'cancelled');
    void invalidateShowData(queryClient);
    const cancelled = result.updatedIds;
    toast.success(`Cancelled ${plural(cancelled.length, 'show')} on ${formatDateMedium(date)}`, {
      description: booked ? 'Lineups are kept. Booked comedians aren’t emailed, so let them know.' : undefined,
      duration: 10_000,
      action: {
        label: 'Undo',
        onClick: () =>
          void setStatus(cancelled, 'scheduled')
            .then((undo) => {
              const blocked = undo.skipped.filter((s) => s.reason === 'duplicate_show').length;
              return blocked
                ? toast.warning(
                    `Restored ${plural(undo.updatedIds.length, 'show')}; ${plural(blocked, 'show')} couldn’t come back (another show is there now).`,
                  )
                : toast.success(`Restored ${plural(undo.updatedIds.length, 'show')}`);
            },
              (err: unknown) => toast.error(errorMessage(err)),
            )
            .finally(() => void invalidateShowData(queryClient)),
      },
    });
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Cancel all ${plural(shows.length, 'show')} on ${formatDateLong(date)}?`}
      confirmLabel="Cancel all shows"
      cancelLabel="Keep them"
      destructive
      onConfirm={cancelAll}
    >
      <p className="text-sm text-fg-muted">
        {booked
          ? `The lineups (${booked} booked) are kept and you can restore the shows later. Booked comedians aren’t emailed, so let them know.`
          : 'You can restore them later from the calendar.'}
      </p>
    </ConfirmDialog>
  );
}

function DaySummary({ day }: { day: DayResponse }) {
  const bookings = day.shows.flatMap((s) => s.bookings);
  const slots = day.shows.reduce((n, s) => n + s.slotCount, 0);
  const declined = bookings.filter((b) => b.declinedAt != null).length;
  const filled = bookings.length - declined;
  const unconfirmed = bookings.filter((b) => b.status === 'unconfirmed_today').length;
  if (day.shows.length === 0) return <>No shows scheduled</>;
  return (
    <span className="tabular-nums">
      {day.shows.length} {day.shows.length === 1 ? 'show' : 'shows'} · {filled} of {slots} slots filled
      {unconfirmed > 0 && <span className="text-unconfirmed-fg"> · {unconfirmed} unconfirmed tonight</span>}
      {declined > 0 && (
        <span className="text-declined-fg"> · {declined} declined, {declined === 1 ? 'needs' : 'need'} a replacement</span>
      )}
    </span>
  );
}

/** Shows grouped by location, keeping the server's order (location sort order, then time). */
const LocationSections = memo(function LocationSections({ shows }: { shows: DayShow[] }) {
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
        const filled = locationShows.reduce((n, s) => n + s.bookings.filter((b) => b.declinedAt == null).length, 0);
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
});

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
