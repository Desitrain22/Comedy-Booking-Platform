/**
 * /app/calendar?month=YYYY-MM[&locations=1,2][&show=<id>] — the booker's month of shows.
 *
 * Each day lists its shows as pills (`7:30 · Cellar · 5/7`) in the location color, sorted
 * by time; a red dot means someone on it is unconfirmed tonight; cancelled shows are
 * struck through. Clicking a day opens the day view; clicking a pill opens the show
 * editor, which is URL-driven (`?show=<id>`) so F2's "Edit show" link deep-links to it.
 * Without `?month` it opens the month being planned (next month from the 20th on, UX B8).
 */
import { CalendarPlus, CalendarSync, ChevronLeft, ChevronRight, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { ShowDto } from '../../../shared/api/shows';
import { addMonths, formatMonthLong, formatMonthName, monthOf } from '../../../shared/time';
import { MonthGrid } from '../../components/MonthGrid';
import { Button, Card, ColorDot, EmptyState, PageHeader, Spinner, buttonClasses } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CopyPatternDialog } from '../shows/CopyPatternDialog';
import { ShowPill } from '../shows/ShowPill';
import { plural } from '../shows/showFormat';
import {
  copySourceEmptyReason,
  monthParam,
  useClubToday,
  useCopySourceCount,
  useLocations,
  useMonthShows,
  useShowDetail,
} from '../shows/showsData';
import { ShowEditDialog } from './ShowEditDialog';

function parseIds(value: string | null): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

function parseShowId(value: string | null): number | null {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 ? n : null;
}

export function CalendarPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const today = useClubToday();
  const month = monthParam(params.get('month'), today);
  const filterIds = useMemo(() => parseIds(params.get('locations')), [params]);
  const editingId = parseShowId(params.get('show'));
  const [copyOpen, setCopyOpen] = useState(false);

  const shows = useMonthShows(month);
  const locations = useLocations();
  const copyBlocked = copySourceEmptyReason(month, useCopySourceCount(addMonths(month, -1)));

  /** Update some query params, keeping the rest (replace: no history spam). */
  function updateParams(changes: Record<string, string | null>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value == null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  }

  // Deep link without a month (`?show=12`): jump to the show's month once it loads.
  const deepLinked = useShowDetail(editingId);
  const deepLinkedDate = deepLinked.data?.date;
  const hasMonthParam = params.has('month');
  useEffect(() => {
    if (deepLinkedDate && !hasMonthParam) updateParams({ month: monthOf(deepLinkedDate) });
  }, [deepLinkedDate, hasMonthParam]); // updateParams only reads the latest params via its updater

  const monthShows = useMemo(
    () => (shows.data ?? []).filter((s) => s.date.startsWith(month)),
    [shows.data, month],
  );
  const loadingMonth = shows.isPending || (shows.isPlaceholderData && shows.isFetching);

  // Filter chips: active locations + any location that has shows this month (e.g. archived).
  const chipLocations = useMemo(() => {
    const map = new Map<number, { id: number; name: string; color: string; sortOrder: number }>();
    for (const l of locations.data ?? []) map.set(l.id, l);
    for (const s of monthShows) if (!map.has(s.locationId)) map.set(s.locationId, s.location);
    return [...map.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }, [locations.data, monthShows]);

  const visible = useMemo(
    () => (filterIds.length ? monthShows.filter((s) => filterIds.includes(s.locationId)) : monthShows),
    [monthShows, filterIds],
  );
  const byDate = useMemo(() => {
    const map = new Map<string, ShowDto[]>();
    for (const s of visible) map.set(s.date, [...(map.get(s.date) ?? []), s]);
    return map;
  }, [visible]);

  const scheduled = visible.filter((s) => s.status === 'scheduled');
  const cancelledCount = visible.length - scheduled.length;
  const slots = scheduled.reduce((sum, s) => sum + s.slotCount, 0);
  const booked = scheduled.reduce((sum, s) => sum + Math.min(s.bookedCount, s.slotCount), 0);
  const unconfirmedTonight = scheduled.reduce((sum, s) => sum + s.unconfirmedTodayCount, 0);

  function toggleLocation(id: number) {
    const all = chipLocations.map((l) => l.id);
    const current = filterIds.length ? filterIds : all;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    // Everything (or nothing) selected = no filter.
    const isAll = next.length === 0 || all.every((x) => next.includes(x));
    updateParams({ locations: isAll ? null : next.join(',') });
  }

  const description = loadingMonth ? (
    <span className="inline-flex items-center gap-2">
      <Spinner className="size-3.5" label="Loading shows" /> Loading shows…
    </span>
  ) : shows.isError ? (
    'Shows couldn’t be loaded.'
  ) : (
    <>
      {plural(scheduled.length, 'show')}
      {scheduled.length > 0 && ` · ${booked} of ${slots} slots booked`}
      {cancelledCount > 0 && ` · ${cancelledCount} cancelled`}
      {unconfirmedTonight > 0 && (
        <span className="text-unconfirmed-fg"> · {plural(unconfirmedTonight, 'comedian')} unconfirmed tonight</span>
      )}
    </>
  );

  return (
    <div>
      <PageHeader
        eyebrow="Calendar"
        title={formatMonthLong(month)}
        documentTitle={`Calendar · ${formatMonthLong(month)}`}
        description={description}
        actions={
          <>
            <div className="flex items-center rounded-lg border border-border-strong bg-surface shadow-xs">
              <Button
                variant="ghost"
                size="icon"
                className="rounded-r-none"
                aria-label={`Previous month, ${formatMonthLong(addMonths(month, -1))}`}
                onClick={() => updateParams({ month: addMonths(month, -1), show: null })}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                className="rounded-none border-x border-border-strong px-3"
                onClick={() => updateParams({ month: monthOf(today), show: null })}
                disabled={month === monthOf(today)}
              >
                Today
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-l-none"
                aria-label={`Next month, ${formatMonthLong(addMonths(month, 1))}`}
                onClick={() => updateParams({ month: addMonths(month, 1), show: null })}
              >
                <ChevronRight />
              </Button>
            </div>
            <Link to={`/app/shows/new?month=${month}`} className={buttonClasses()}>
              <Plus aria-hidden /> Create shows
            </Link>
          </>
        }
      />

      {chipLocations.length > 1 && (
        <div role="group" aria-label="Filter by location" className="mb-3 flex flex-wrap items-center gap-1.5">
          {chipLocations.map((l) => {
            const on = filterIds.length === 0 || filterIds.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleLocation(l.id)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors',
                  on
                    ? 'border-border-strong bg-surface text-fg shadow-xs hover:bg-surface-2'
                    : 'border-dashed border-border-strong text-fg-subtle hover:text-fg-muted',
                )}
              >
                <ColorDot color={l.color} className={cn(!on && 'opacity-35')} />
                {l.name}
              </button>
            );
          })}
          {filterIds.length > 0 && (
            <Button variant="link" size="sm" className="ml-1 text-[13px]" onClick={() => updateParams({ locations: null })}>
              Show all
            </Button>
          )}
        </div>
      )}

      {shows.isError ? (
        <Card>
          <EmptyState
            icon={TriangleAlert}
            title="Couldn't load shows"
            description={errorMessage(shows.error)}
            action={
              <Button variant="secondary" onClick={() => void shows.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {!loadingMonth && monthShows.length === 0 && (
            <Card className="mb-3 flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                <CalendarPlus className="size-[18px]" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">No shows in {formatMonthName(month)} yet</p>
                <p className="text-sm text-fg-muted">
                  {copyBlocked
                    ? `Paint a run of shows. ${formatMonthName(addMonths(month, -1))} has no shows, so there’s no pattern to copy yet.`
                    : `Paint a run of shows, or copy ${formatMonthName(addMonths(month, -1))}’s weekly pattern in one go.`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setCopyOpen(true)}
                  disabled={copyBlocked != null}
                  title={copyBlocked ?? undefined}
                >
                  <CalendarSync aria-hidden /> Copy {formatMonthName(addMonths(month, -1))}’s pattern
                </Button>
                <Link to={`/app/shows/new?month=${month}`} className={buttonClasses()}>
                  <Plus aria-hidden /> Create shows
                </Link>
              </div>
            </Card>
          )}
          {!loadingMonth && monthShows.length > 0 && visible.length === 0 && (
            <p className="mb-3 text-sm text-fg-muted">No shows at the selected locations this month.</p>
          )}

          <Card className="p-2 sm:p-3">
            <MonthGrid
              month={month}
              today={today}
              aria-label={`Shows in ${formatMonthLong(month)}. Choose a day to open its lineup.`}
              cellClassName="min-h-[104px] gap-[3px]"
              dayClassName={(d) => (d < today ? 'bg-surface-2/50' : undefined)}
              onDayClick={(date) => void navigate(`/app/day/${date}`)}
              renderDay={(date) =>
                loadingMonth ? (
                  <DaySkeleton date={date} />
                ) : (
                  byDate
                    .get(date)
                    ?.map((s) => (
                      <ShowPill key={s.id} show={s} onClick={(show) => updateParams({ show: String(show.id) })} />
                    ))
                )
              }
            />
          </Card>
          <p className="mt-2 text-xs text-fg-muted">
            Click a day to build its lineups · click a show to edit it
            <span className="ml-3 inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-unconfirmed" /> someone unconfirmed tonight
            </span>
          </p>
        </>
      )}

      <ShowEditDialog showId={editingId} onClose={() => updateParams({ show: null })} />
      <CopyPatternDialog open={copyOpen} onOpenChange={setCopyOpen} toMonth={month} />
    </div>
  );
}

/** Placeholder pills while the month loads (weekend-heavy, like a real club). */
function DaySkeleton({ date }: { date: string }) {
  const day = Number(date.slice(8));
  const count = [1, 2, 3, 2, 1, 0, 2][day % 7]!;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} aria-hidden className="h-4 w-full animate-pulse rounded-[5px] bg-surface-2" />
      ))}
    </>
  );
}
