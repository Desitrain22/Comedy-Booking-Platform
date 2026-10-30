/**
 * /app/shows/new?month=YYYY-MM — create a run of shows (approved mockup): pick a location,
 * optional name, start time and slots on the left; choose dates with the weekday chips
 * (toggle every such day) or by clicking / dragging across the calendar (a drag starting
 * on an unselected day adds, on a selected day removes). Existing shows show as pills in
 * their location color, new ones preview in the accent color, and a live summary says
 * what will be created. The selection survives month navigation; Create sends it all, and
 * the success toast can Undo it. Without `?month` it opens the month being planned (next
 * month from the 20th on).
 *
 * Setup guide targets (client/components/guide): `shows-form` (location, name, start, slots),
 * `shows-weekdays`, `shows-calendar` and `shows-create`; the page also tells the guide how many
 * shows Create would make, so "Put it on the calendar" moves on to "Create them".
 */
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarSync, ChevronLeft, ChevronRight, MapPin, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  DEFAULT_SHOW_START,
  DEFAULT_SLOT_COUNT,
  SHOW_NAME_MAX,
  SHOW_START_MIN,
  SHOW_START_PICKER_MAX,
  SHOW_START_STEP,
  SLOT_COUNT_MAX,
  SLOT_COUNT_MIN,
  type ShowDto,
} from '../../../shared/api/shows';
import {
  addMonths,
  formatMonthLong,
  formatMonthName,
  formatMonthShort,
  formatTime,
  lastDayOfMonth,
  monthOf,
  timeOptions,
  WEEKDAY_LETTERS,
  WEEKDAY_NAMES,
} from '../../../shared/time';
import type { Location } from '../../../shared/types';
import { useGuideSignal } from '../../components/guide';
import { MonthGrid, type PaintGesture } from '../../components/MonthGrid';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  PageHeader,
  PageSpinner,
  Select,
  buttonClasses,
} from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CopyPatternDialog, copyPatternLabel } from './CopyPatternDialog';
import { NewShowPill, ShowPill } from './ShowPill';
import {
  countByMonth,
  isWeekdayFullySelected,
  monthsPhrase,
  paintDates,
  plural,
  selectableWeekdayDates,
  toggleWeekday,
} from './showFormat';
import {
  copySourceEmptyReason,
  monthParam,
  showsQueryOptions,
  undoCreatedShows,
  useBulkCreateShows,
  useClubToday,
  useCopySourceCount,
  useLocations,
  useMonthShows,
} from './showsData';

const START_TIMES = timeOptions(SHOW_START_MIN, SHOW_START_PICKER_MAX, SHOW_START_STEP);
const dupKey = (locationId: number, date: string, startMin: number) => `${locationId}|${date}|${startMin}`;

export function CreateShowsPage() {
  const [params, setParams] = useSearchParams();
  const today = useClubToday();
  const month = monthParam(params.get('month'), today);
  const locations = useLocations();

  if (locations.isPending) {
    return (
      <Shell month={month}>
        <PageSpinner />
      </Shell>
    );
  }
  if (locations.isError) {
    return (
      <Shell month={month}>
        <Card>
          <EmptyState
            icon={TriangleAlert}
            title="Couldn't load locations"
            description={errorMessage(locations.error)}
            action={
              <Button variant="secondary" onClick={() => void locations.refetch()}>
                Try again
              </Button>
            }
          />
        </Card>
      </Shell>
    );
  }
  if (locations.data.length === 0) {
    return (
      <Shell month={month}>
        <Card>
          <EmptyState
            icon={MapPin}
            title="Add a location first"
            description="Shows happen at a location (a room or venue). Add one in Settings, then come back to create shows."
            action={
              <Link to="/app/settings/locations" className={buttonClasses()}>
                Go to locations
              </Link>
            }
          />
        </Card>
      </Shell>
    );
  }

  return (
    <Shell month={month}>
      <ShowPainter
        month={month}
        today={today}
        locations={locations.data}
        onMonthChange={(next) => setParams({ month: next }, { replace: true })}
      />
    </Shell>
  );
}

function Shell({ month, children }: { month: string; children: ReactNode }) {
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link
            to={`/app/calendar?month=${month}`}
            className="inline-flex items-center gap-1 rounded hover:text-fg [&_svg]:size-3.5"
          >
            <ArrowLeft aria-hidden /> Calendar
          </Link>
        }
        title="Create shows"
        description="Pick a location and time, then choose dates: tap weekdays, or click and drag across the calendar."
      />
      {children}
    </div>
  );
}

interface ShowPainterProps {
  month: string;
  today: string;
  locations: Location[];
  onMonthChange: (month: string) => void;
}

function ShowPainter({ month, today, locations, onMonthChange }: ShowPainterProps) {
  const navigate = useNavigate();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  const [name, setName] = useState('');
  const [startMin, setStartMin] = useState(DEFAULT_SHOW_START);
  const [slotInput, setSlotInput] = useState(String(DEFAULT_SLOT_COUNT));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [copyOpen, setCopyOpen] = useState(false);
  const paintMode = useRef<'add' | 'remove'>('add');
  const bulk = useBulkCreateShows();
  const queryClient = useQueryClient();
  const copyBlocked = copySourceEmptyReason(month, useCopySourceCount(addMonths(month, -1)));

  const location = locations.find((l) => l.id === locationId) ?? locations[0]!;
  const slotCount = Number(slotInput);
  const slotError =
    !Number.isInteger(slotCount) || slotCount < SLOT_COUNT_MIN || slotCount > SLOT_COUNT_MAX
      ? `${SLOT_COUNT_MIN}–${SLOT_COUNT_MAX}`
      : undefined;

  // This month's shows (pills), plus every month with selected dates (duplicate check).
  const monthShows = useMonthShows(month);
  const selectedDates = useMemo(() => [...selected].sort(), [selected]);
  const selectedMonths = useMemo(() => [...new Set(selectedDates.map(monthOf))], [selectedDates]);
  const otherMonths = useQueries({ queries: selectedMonths.filter((m) => m !== month).map(showsQueryOptions) });

  const visibleShows = useMemo(
    () => (monthShows.data ?? []).filter((s) => s.date.startsWith(month)),
    [monthShows.data, month],
  );
  const showsByDate = useMemo(() => {
    const map = new Map<string, ShowDto[]>();
    for (const s of visibleShows) map.set(s.date, [...(map.get(s.date) ?? []), s]);
    return map;
  }, [visibleShows]);
  const scheduledKeys = new Set(
    [...visibleShows, ...otherMonths.flatMap((q) => q.data ?? [])]
      .filter((s) => s.status === 'scheduled')
      .map((s) => dupKey(s.locationId, s.date, s.startMin)),
  );
  const isDuplicate = (date: string) => scheduledKeys.has(dupKey(location.id, date, startMin));
  const duplicates = selectedDates.filter(isDuplicate);
  const toCreate = selectedDates.length - duplicates.length;
  const monthSelected = selectedDates.filter((d) => d.startsWith(month)).length;
  const pastMonth = lastDayOfMonth(month) < today;
  useGuideSignal('showsSelected', slotError ? 0 : toCreate);

  function onPaint(dates: string[], gesture: PaintGesture) {
    if (gesture.phase === 'start') paintMode.current = selected.has(gesture.origin) ? 'remove' : 'add';
    setSelected((prev) => paintDates(prev, dates, paintMode.current));
  }

  async function create() {
    if (toCreate === 0 || slotError) return;
    try {
      const result = await bulk.mutateAsync({
        locationId: location.id,
        name: name.trim(),
        startMin,
        slotCount,
        dates: selectedDates,
      });
      const created = result.created.length;
      const what = `${name.trim() ? `“${name.trim()}”, ` : ''}${formatTime(startMin)} at ${location.name}`;
      const firstMonth = monthOf(result.created[0]?.date ?? selectedDates[0] ?? `${month}-01`);
      const ids = result.created.map((s) => s.id);
      const viewCalendar = { label: 'View calendar', onClick: () => void navigate(`/app/calendar?month=${firstMonth}`) };
      toast.success(created ? `Created ${plural(created, 'show')}` : 'No new shows', {
        description: `${what}${result.skipped.length ? ` · ${result.skipped.length} already existed` : ''}`,
        // Undo deletes exactly what was just created (anything booked since is kept).
        ...(created
          ? { action: { label: 'Undo', onClick: () => void undoCreatedShows(queryClient, ids) }, cancel: viewCalendar, duration: 10_000 }
          : { action: viewCalendar }),
      });
      setSelected(new Set());
    } catch {
      // The global mutation handler shows the error toast; keep the selection so nothing is lost.
    }
  }

  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);
  const selectedIn = new Map(countByMonth(selectedDates));
  const legendLocations = [
    ...new Map(
      [location, ...visibleShows.map((s) => s.location)].map((l) => [l.id, { id: l.id, name: l.name, color: l.color }]),
    ).values(),
  ];

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      {/* Settings panel */}
      <Card className="xl:sticky xl:top-[calc(var(--guide-rail-h,0px)+1.5rem)]">
        <CardBody className="grid gap-x-6 gap-y-4 lg:grid-cols-2 xl:grid-cols-1">
          <div className="space-y-4" data-guide="shows-form">
            <Field label="Location">
              <Select
                value={location.id}
                onChange={(e) => setLocationId(Number(e.target.value))}
                options={locations.map((l) => ({ value: l.id, label: l.name }))}
              />
            </Field>
            <Field label="Show name" hint="Optional">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={SHOW_NAME_MAX}
                placeholder="e.g. Late Show"
                autoComplete="off"
              />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-3">
              <Field label="Start">
                <Select value={startMin} onChange={(e) => setStartMin(Number(e.target.value))} options={START_TIMES} />
              </Field>
              <Field label="Slots" error={slotError}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={SLOT_COUNT_MIN}
                  max={SLOT_COUNT_MAX}
                  value={slotInput}
                  onChange={(e) => setSlotInput(e.target.value)}
                  className="tabular-nums"
                />
              </Field>
            </div>
          </div>

          <div className="space-y-4">
            <WeekdayChips
              month={month}
              today={today}
              selected={selected}
              onToggle={(weekday) => setSelected((prev) => toggleWeekday(prev, month, weekday, today))}
              onClear={monthSelected ? () => setSelected((prev) => new Set([...prev].filter((d) => !d.startsWith(month)))) : undefined}
            />

            <Summary
              selectedDates={selectedDates}
              toCreate={toCreate}
              duplicates={duplicates.length}
              name={name.trim()}
              startMin={startMin}
              location={location}
              slotCount={slotError ? null : slotCount}
            />

            <div className="space-y-2">
              <Button
                size="lg"
                className="w-full"
                data-guide="shows-create"
                onClick={() => void create()}
                loading={bulk.isPending}
                disabled={toCreate === 0 || Boolean(slotError)}
              >
                {toCreate ? `Create ${plural(toCreate, 'show')}` : 'Create shows'}
              </Button>
              <button
                type="button"
                onClick={() => setCopyOpen(true)}
                disabled={copyBlocked != null}
                aria-describedby={copyBlocked ? 'copy-pattern-blocked' : undefined}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-[13px] text-fg-muted transition-colors enabled:hover:border-accent enabled:hover:bg-accent-soft enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                <CalendarSync className="size-4 shrink-0" aria-hidden />
                {copyPatternLabel(month)}
              </button>
              {copyBlocked && (
                <p id="copy-pattern-blocked" className="text-center text-xs text-fg-muted">
                  {copyBlocked}.
                </p>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Calendar */}
      <Card data-guide="shows-calendar">
        <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
          <h2 className="text-base font-semibold text-fg" aria-live="polite">
            {formatMonthLong(month)}
          </h2>
          <nav aria-label="Change month" className="flex items-center gap-1">
            <MonthButton month={prevMonth} count={selectedIn.get(prevMonth)} direction="prev" onClick={onMonthChange} />
            <MonthButton month={nextMonth} count={selectedIn.get(nextMonth)} direction="next" onClick={onMonthChange} />
          </nav>
        </div>
        <div className="px-4 pb-4">
          {monthShows.isError && (
            <div
              role="alert"
              className="mb-3 flex items-center gap-3 rounded-lg border border-unconfirmed/30 bg-unconfirmed-soft px-3 py-2 text-sm text-unconfirmed-fg"
            >
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              <span className="flex-1">Couldn’t load existing shows, so duplicates can’t be flagged yet.</span>
              <Button size="sm" variant="secondary" onClick={() => void monthShows.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {pastMonth && (
            <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg-muted">
              {formatMonthName(month)} is in the past. Pick a later month to add shows.
            </p>
          )}
          <MonthGrid
            month={month}
            today={today}
            aria-label={`Dates for new shows in ${formatMonthLong(month)}`}
            cellClassName="min-h-[84px]"
            isDisabled={(d) => d < today}
            isSelected={(d) => selected.has(d)}
            onPaint={onPaint}
            renderDay={(date) => (
              <>
                {showsByDate.get(date)?.map((s) => <ShowPill key={s.id} show={s} compact />)}
                {selected.has(date) && (
                  <NewShowPill startMin={startMin} locationName={location.name} duplicate={isDuplicate(date)} />
                )}
              </>
            )}
          />
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-fg-muted">
            {legendLocations.map((l) => (
              <span key={l.id} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-3 w-1 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-3 rounded-[3px] bg-accent-solid" />
              Will be created
            </span>
            {duplicates.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-3 rounded-[3px] border border-dashed border-accent/60" />
                Already scheduled (skipped)
              </span>
            )}
            {monthShows.isFetching && !monthShows.isError && <span className="ml-auto">Loading shows…</span>}
          </div>
        </div>
      </Card>

      <CopyPatternDialog open={copyOpen} onOpenChange={setCopyOpen} toMonth={month} />
    </div>
  );
}

function WeekdayChips({
  month,
  today,
  selected,
  onToggle,
  onClear,
}: {
  month: string;
  today: string;
  selected: ReadonlySet<string>;
  onToggle: (weekday: number) => void;
  onClear?: () => void;
}) {
  return (
    <fieldset data-guide="shows-weekdays">
      <div className="mb-1.5 flex items-baseline justify-between">
        <legend className="text-[13px] font-medium text-fg">Repeat on</legend>
        {onClear && (
          <button type="button" onClick={onClear} className="text-xs text-fg-muted hover:text-fg hover:underline">
            Clear {formatMonthShort(month)}
          </button>
        )}
      </div>
      <div className="flex gap-1">
        {WEEKDAY_LETTERS.map((letter, weekday) => {
          const dates = selectableWeekdayDates(month, weekday, today);
          const on = isWeekdayFullySelected(selected, month, weekday, today);
          const some = !on && dates.some((d) => selected.has(d));
          return (
            <button
              key={weekday}
              type="button"
              aria-pressed={on}
              aria-label={`Every ${WEEKDAY_NAMES[weekday]}`}
              title={`Every ${WEEKDAY_NAMES[weekday]} in ${formatMonthName(month)}`}
              disabled={dates.length === 0}
              onClick={() => onToggle(weekday)}
              className={cn(
                'h-9 min-w-0 flex-1 rounded-lg border text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                on
                  ? 'border-accent-solid bg-accent-solid text-accent-solid-fg hover:bg-accent-solid-hover'
                  : some
                    ? 'border-accent bg-accent-soft text-accent hover:bg-accent-soft/70'
                    : 'border-border-strong bg-surface text-fg hover:border-accent hover:text-accent',
              )}
            >
              {letter}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function Summary({
  selectedDates,
  toCreate,
  duplicates,
  name,
  startMin,
  location,
  slotCount,
}: {
  selectedDates: string[];
  toCreate: number;
  duplicates: number;
  name: string;
  startMin: number;
  location: Location;
  slotCount: number | null;
}) {
  const byMonth = countByMonth(selectedDates);
  let text: ReactNode;
  if (selectedDates.length === 0) {
    text = <span className="text-fg-muted">Pick weekdays or drag across the calendar to choose dates.</span>;
  } else if (toCreate === 0) {
    text = (
      <span className="text-fg-muted">
        {selectedDates.length === 1 ? 'That date already has' : `All ${selectedDates.length} dates already have`} a{' '}
        {formatTime(startMin)} show at {location.name}. Pick other dates or another time.
      </span>
    );
  } else {
    text = (
      <>
        <strong className="font-semibold text-fg">{plural(toCreate, 'show')}</strong> will be created:{' '}
        {name && <>“{name}”, </>}
        {formatTime(startMin)} at {location.name}
        {slotCount != null && <>, {plural(slotCount, 'slot')} each</>}.
        {byMonth.length > 1 && (
          <span className="mt-1 block text-xs text-fg-muted">
            Across {monthsPhrase(selectedDates)}:{' '}
            {byMonth.map(([m, n]) => `${n} in ${formatMonthShort(m)}`).join(', ')}.
          </span>
        )}
        {duplicates > 0 && (
          <span className="mt-1 block text-xs text-fg-muted">
            {plural(duplicates, 'date')} already {duplicates === 1 ? 'has' : 'have'} this show and will be skipped.
          </span>
        )}
      </>
    );
  }
  return (
    <p aria-live="polite" className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-fg">
      {text}
    </p>
  );
}

function MonthButton({
  month,
  count,
  direction,
  onClick,
}: {
  month: string;
  count: number | undefined;
  direction: 'prev' | 'next';
  onClick: (month: string) => void;
}) {
  const label = formatMonthShort(month);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onClick(month)}
      aria-label={`${formatMonthLong(month)}${count ? `, ${count} selected` : ''}`}
    >
      {direction === 'prev' && <ChevronLeft aria-hidden />}
      {label}
      {count ? (
        <span className="rounded-full bg-accent-solid px-1.5 text-[10px] leading-4 font-semibold text-accent-solid-fg tabular-nums">
          {count}
        </span>
      ) : null}
      {direction === 'next' && <ChevronRight aria-hidden />}
    </Button>
  );
}
