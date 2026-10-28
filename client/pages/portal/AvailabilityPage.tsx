/**
 * /portal?month=YYYY-MM — the comedian paints which nights they're free (approved mockup:
 * .superpowers/brainstorm/…/comedian-portal.html).
 *
 * Pick a brush (All night · a custom range · Not available), then tap or drag across days,
 * or tap a weekday to paint every such day this month. One range per night: painting over
 * a night replaces it; "Not available" erases. Past days are disabled. Nothing persists
 * until Save, which sends the whole month and records a submission (even with zero
 * nights). Unsaved changes are guarded on unload, in-app navigation and month switches.
 *
 * Month: `?month=`, else next month from the 20th on, else the current month.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Clock, Moon, RotateCw, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { DEFAULT_CUSTOM_RANGE, defaultAvailabilityMonth, type PortalAvailabilityResponse } from '../../../shared/api/portal';
import type { AvailabilityRange } from '../../../shared/availability';
import {
  addMonths,
  formatDateShort,
  formatMonthLong,
  formatMonthName,
  formatMonthShort,
  formatRange,
  isValidMonth,
  lastDayOfMonth,
  monthOf,
  todayInTz,
  WEEKDAY_MINI,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
} from '../../../shared/time';
import { MonthGrid } from '../../components/MonthGrid';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { usePageTitle } from '../../lib/usePageTitle';
import { useClub } from '../../lib/useMe';
import {
  dayLabel,
  draftFromEntries,
  END_OPTIONS,
  entriesFromDraft,
  paint,
  paintableWeekdayDates,
  sameDraft,
  START_OPTIONS,
  withEnd,
  withStart,
  type BrushKind,
  type Draft,
} from './availabilityDraft';
import { portalKeys, useAvailability, usePortalMe } from './portalQueries';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

/** How far ahead the month arrows go. */
const MAX_MONTHS_AHEAD = 12;
/** A painted night: clearly green, like the mockup. */
const PAINTED_CELL = 'border-available bg-available/20 hover:border-available dark:bg-available/15';

export function AvailabilityPage() {
  usePageTitle('Availability');
  const timeZone = useClub()?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = todayInTz(timeZone);
  const [params, setParams] = useSearchParams();
  const requested = params.get('month');
  const month = requested && isValidMonth(requested) ? requested : defaultAvailabilityMonth(today);

  // The brush lives here so it survives month switches.
  const [brush, setBrush] = useState<BrushKind>('allNight');
  const [custom, setCustom] = useState<AvailabilityRange>(DEFAULT_CUSTOM_RANGE);
  const availability = useAvailability(month);

  const thisMonth = monthOf(today);
  const nav: MonthNav = {
    month,
    prev: month > thisMonth ? addMonths(month, -1) : null,
    next: month < addMonths(thisMonth, MAX_MONTHS_AHEAD) ? addMonths(month, 1) : null,
    go: (m) => setParams({ month: m }),
  };

  if (availability.data) {
    return (
      <AvailabilityEditor
        key={month}
        data={availability.data}
        nav={nav}
        brush={brush}
        onBrushChange={setBrush}
        custom={custom}
        onCustomChange={setCustom}
      />
    );
  }

  return (
    <>
      <MonthHeader nav={nav} />
      {availability.isError ? (
        <EmptyState
          title="Couldn't load your availability"
          description={errorMessage(availability.error)}
          action={
            <Button variant="secondary" onClick={() => void availability.refetch()} loading={availability.isFetching}>
              <RotateCw /> Try again
            </Button>
          }
        />
      ) : (
        <div className="flex min-h-96 items-center justify-center">
          <Spinner className="size-6" label="Loading your availability" />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

interface MonthNav {
  month: string;
  prev: string | null;
  next: string | null;
  go: (month: string) => void;
}

function MonthHeader({ nav, guard, children }: { nav: MonthNav; guard?: (go: () => void) => void; children?: ReactNode }) {
  const go = (m: string) => (guard ? guard(() => nav.go(m)) : nav.go(m));
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{formatMonthLong(nav.month)}</h1>
        <div className="-mr-2 flex items-center">
          <Button
            variant="ghost"
            className="h-11 px-2.5 text-fg-muted sm:h-9"
            disabled={!nav.prev}
            onClick={() => nav.prev && go(nav.prev)}
            aria-label={nav.prev ? `Previous month, ${formatMonthName(nav.prev)}` : 'Previous month'}
          >
            <ChevronLeft />
            {nav.prev ? formatMonthShort(nav.prev) : formatMonthShort(addMonths(nav.month, -1))}
          </Button>
          <Button
            variant="ghost"
            className="h-11 px-2.5 text-fg-muted sm:h-9"
            disabled={!nav.next}
            onClick={() => nav.next && go(nav.next)}
            aria-label={nav.next ? `Next month, ${formatMonthName(nav.next)}` : 'Next month'}
          >
            {formatMonthShort(addMonths(nav.month, 1))}
            <ChevronRight />
          </Button>
        </div>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface EditorProps {
  data: PortalAvailabilityResponse;
  nav: MonthNav;
  brush: BrushKind;
  onBrushChange: (brush: BrushKind) => void;
  custom: AvailabilityRange;
  onCustomChange: (range: AvailabilityRange) => void;
}

function AvailabilityEditor({ data, nav, brush, onBrushChange, custom, onCustomChange }: EditorProps) {
  const queryClient = useQueryClient();
  const timeZone = useClub()?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { month, today, allNight } = data;
  const [saved, setSaved] = useState(() => ({ source: data, draft: draftFromEntries(data.entries) }));
  const [draft, setDraft] = useState<Draft>(saved.draft);
  const dirty = !sameDraft(saved.draft, draft);

  // Fresh server data arrived while nothing is unsaved (e.g. a refetch): adopt it.
  if (data !== saved.source && !dirty) {
    const fresh = draftFromEntries(data.entries);
    setSaved({ source: data, draft: fresh });
    setDraft(fresh);
  }

  const save = useMutation({
    mutationFn: (entries: ReturnType<typeof entriesFromDraft>) =>
      api.put<PortalAvailabilityResponse>('/portal/availability', { month, entries }),
    meta: { silent: true }, // errors are shown by the caller (toast or the leave dialog)
    onSuccess: (res) => {
      setSaved({ source: res, draft: draftFromEntries(res.entries) });
      queryClient.setQueryData(portalKeys.availability(month), res);
      void queryClient.invalidateQueries({ queryKey: portalKeys.me });
      toast.success('Saved — the club can see it now');
    },
  });

  const saveNow = () => save.mutateAsync(entriesFromDraft(draft, today));
  const submitted = saved.source.submittedAt != null;
  const canSave = dirty || !submitted;

  function handleSave() {
    if (!canSave || save.isPending) return;
    saveNow().catch((err: unknown) => toast.error(errorMessage(err, "Couldn't save. Try again.")));
  }

  // Ctrl/⌘+S saves.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        document.getElementById('availability-save')?.click();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const guard = useUnsavedChangesGuard({
    dirty,
    onSave: saveNow,
    title: 'Save your availability?',
    description: `You've marked nights in ${formatMonthName(month)} that the club can't see until you save.`,
  });

  const monthOver = lastDayOfMonth(month) < today;
  const range: AvailabilityRange | null = brush === 'allNight' ? allNight : brush === 'custom' ? custom : null;
  const isPast = (date: string) => date < today;
  const nights = draft.size;
  const nightsLabel = `${nights} ${nights === 1 ? 'night' : 'nights'} marked`;

  return (
    <>
      <MonthHeader nav={nav} guard={guard.confirmLeave}>
        <p className="mt-0.5 text-sm text-fg-muted">
          {saved.source.submittedAt != null
            ? `Sent to the club ${formatDateShort(todayInTz(timeZone, new Date(saved.source.submittedAt)))} · change it any time`
            : `Which nights are you free in ${formatMonthName(month)}?`}
        </p>
      </MonthHeader>

      {monthOver ? (
        <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg-muted">This month is over, so it can't be changed.</p>
      ) : (
        <>
          <BrushPicker
            brush={brush}
            onBrushChange={onBrushChange}
            allNight={allNight}
            custom={custom}
            onCustomChange={onCustomChange}
          />
          <p className="mt-2.5 text-xs text-fg-muted">
            Tap or drag across days to mark them. Tap a weekday to mark every one.
          </p>
          <div className="mt-3 flex items-center gap-2" role="group" aria-label="Mark every weekday">
            <span className="hidden text-xs text-fg-muted sm:inline" aria-hidden>
              Every:
            </span>
            <div className="grid flex-1 grid-cols-7 gap-1 sm:flex sm:flex-none sm:gap-1.5">
              {WEEKDAY_NAMES.map((name, weekday) => {
                const dates = paintableWeekdayDates(month, weekday, today);
                return (
                  <button
                    key={name}
                    type="button"
                    disabled={dates.length === 0}
                    aria-label={`${range ? 'Mark' : 'Clear'} every ${name}`}
                    title={`${range ? 'Mark' : 'Clear'} every ${name}`}
                    onClick={() => setDraft((d) => paint(d, dates, range))}
                    className={cn(
                      'h-11 min-w-0 rounded-lg border border-border bg-surface text-xs font-semibold text-fg-muted transition-colors',
                      'hover:border-accent hover:text-fg active:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40',
                      'sm:h-8 sm:w-10 sm:font-medium sm:text-fg',
                    )}
                  >
                    <span className="sm:hidden">{WEEKDAY_SHORT[weekday]}</span>
                    <span className="hidden sm:inline">{WEEKDAY_MINI[weekday]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      <MonthGrid
        month={month}
        today={today}
        aria-label={`Your availability for ${formatMonthLong(month)}`}
        // Phones: the weekday buttons above double as the column headers.
        className="mt-1.5 max-sm:[&>div:first-child]:hidden"
        cellClassName="min-h-15 p-1 sm:min-h-21 sm:p-1.5"
        isDisabled={(date) => monthOver || isPast(date)}
        isSelected={(date) => draft.has(date)}
        dayClassName={(date) => draft.has(date) && PAINTED_CELL}
        onPaint={monthOver ? undefined : (dates) => setDraft((d) => paint(d, dates, range))}
        renderDay={(date) => {
          const night = draft.get(date);
          if (!night) return null;
          const label = dayLabel(night, allNight);
          return (
            <span className="mt-auto text-[10px] leading-tight font-semibold text-available-fg sm:text-xs">
              {label.allNight ? (
                <>
                  All night
                  <span className="hidden font-medium opacity-80 sm:block">{label.parts.join('')}</span>
                </>
              ) : (
                <>
                  <span className="whitespace-nowrap">{label.parts[0]}</span>
                  <wbr />
                  <span className="whitespace-nowrap">{label.parts[1]}</span>
                </>
              )}
            </span>
          );
        }}
      />
      <p className="mt-3 text-center text-xs text-fg-muted sm:text-left">Blank nights count as not available.</p>
      <SpotsToConfirmBanner />

      {!monthOver && (
        <div
          className={cn(
            'sticky bottom-0 z-10 -mx-4 -mb-5 mt-4 border-t border-border bg-surface/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur',
            'sm:mx-0 sm:mb-0 sm:rounded-xl sm:border sm:pb-3 sm:shadow-lg',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-sm" aria-live="polite" data-testid="availability-status">
              {dirty ? (
                <>
                  <span className="font-medium text-awaiting-fg">
                    <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-awaiting align-middle" />
                    Unsaved changes
                  </span>
                  <span className="text-fg-muted"> · {nightsLabel}</span>
                </>
              ) : submitted ? (
                <span className="text-fg-muted">
                  <Check aria-hidden className="mr-1 inline size-4 align-[-3px] text-available" />
                  Saved · {nightsLabel}
                </span>
              ) : (
                <span className="text-fg-muted">
                  Not sent yet · {nightsLabel}
                </span>
              )}
            </p>
            <Button
              id="availability-save"
              size="lg"
              className="px-7 sm:h-10"
              onClick={handleSave}
              disabled={!canSave}
              loading={save.isPending}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      {guard.dialog}
    </>
  );
}

// ---------------------------------------------------------------------------

interface BrushPickerProps {
  brush: BrushKind;
  onBrushChange: (brush: BrushKind) => void;
  allNight: AvailabilityRange;
  custom: AvailabilityRange;
  onCustomChange: (range: AvailabilityRange) => void;
}

const pill = (on: boolean, tone: 'green' | 'gray' = 'green') =>
  cn(
    'flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-sm transition-colors sm:min-h-10',
    on
      ? tone === 'green'
        ? 'border-available bg-available/15 font-semibold text-fg'
        : 'border-border-strong bg-surface-3 font-semibold text-fg'
      : 'border-border bg-surface text-fg hover:border-border-strong',
  );

/** All night · custom range · Not available. The custom pill holds two native time selects. */
function BrushPicker({ brush, onBrushChange, allNight, custom, onCustomChange }: BrushPickerProps) {
  const selectClasses =
    'h-10 rounded-md border border-border-strong bg-surface px-1.5 text-base text-fg sm:h-8 sm:text-sm focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <div role="group" aria-label="What to mark" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
      <button type="button" aria-pressed={brush === 'allNight'} onClick={() => onBrushChange('allNight')} className={pill(brush === 'allNight')}>
        <Moon aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <span>All night</span>
        <span className="truncate font-normal text-fg-muted">{formatRange(allNight.startMin, allNight.endMin)}</span>
      </button>

      <div
        className={cn(pill(brush === 'custom'), 'order-last col-span-2 py-1 pr-1.5 sm:order-none')}
        onClick={() => onBrushChange('custom')}
      >
        <button
          type="button"
          aria-pressed={brush === 'custom'}
          aria-label={`Custom time, ${formatRange(custom.startMin, custom.endMin)}`}
          onClick={() => onBrushChange('custom')}
          className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-full text-fg-muted hover:text-fg"
        >
          <Clock aria-hidden className="size-4" />
        </button>
        <select
          aria-label="Free from"
          className={cn(selectClasses, 'min-w-0 flex-1 sm:flex-none')}
          value={custom.startMin}
          onChange={(e) => {
            onCustomChange(withStart(custom, Number(e.target.value)));
            onBrushChange('custom');
          }}
        >
          {START_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-fg-muted">to</span>
        <select
          aria-label="Free until"
          className={cn(selectClasses, 'min-w-0 flex-1 sm:flex-none')}
          value={custom.endMin}
          onChange={(e) => {
            onCustomChange(withEnd(custom, Number(e.target.value)));
            onBrushChange('custom');
          }}
        >
          {END_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} disabled={o.value <= custom.startMin}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <button type="button" aria-pressed={brush === 'off'} onClick={() => onBrushChange('off')} className={pill(brush === 'off', 'gray')}>
        <X aria-hidden className="size-4 shrink-0 text-fg-muted" />
        Not available
      </button>
    </div>
  );
}

/** A nudge when the comedian has booked spots waiting for confirmation. */
function SpotsToConfirmBanner() {
  const { data } = usePortalMe();
  const count = data?.spots.unconfirmed ?? 0;
  if (count === 0) return null;
  return (
    <Link
      to="/portal/spots"
      className="mt-4 flex min-h-11 items-center gap-2 rounded-lg border border-awaiting/40 bg-awaiting-soft px-3 py-2 text-sm text-awaiting-fg hover:border-awaiting"
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-awaiting" />
      <span className="flex-1">
        You have {count} {count === 1 ? 'spot' : 'spots'} to confirm
      </span>
      <ArrowRight aria-hidden className="size-4" />
    </Link>
  );
}
