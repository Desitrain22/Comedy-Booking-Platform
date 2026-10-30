/**
 * "Copy October's pattern into November": previews (dryRun) the shows the copy would
 * create, grouped by weekday then location, with an optional location filter, then
 * creates them on Confirm (the success toast can Undo it). Used by the create-shows page and
 * the calendar's empty state.
 */
import { useQueryClient } from '@tanstack/react-query';
import { CalendarX, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { CopyPatternResponse, CopyPatternShow } from '../../../shared/api/shows';
import { addMonths, formatDateShort, formatMonthLong, formatMonthName, formatTime } from '../../../shared/time';
import { Button, ColorDot, Dialog, EmptyState, Spinner } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { WEEKDAY_PLURALS, plural } from './showFormat';
import { undoCreatedShows, useCopyPattern, useCopyPatternPreview } from './showsData';

export interface CopyPatternDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Target month `YYYY-MM`; the source is the month before it. */
  toMonth: string;
  /** Called after shows were created. */
  onCopied?: (result: CopyPatternResponse) => void;
}

/** Label for the trigger button: "Copy October's pattern into November". */
export function copyPatternLabel(toMonth: string): string {
  return `Copy ${formatMonthName(addMonths(toMonth, -1))}’s pattern into ${formatMonthName(toMonth)}`;
}

interface PatternRow {
  key: string;
  location: CopyPatternShow['location'];
  startMin: number;
  name: string;
  slotCount: number;
  create: string[];
  exists: string[];
  past: string[];
}

interface WeekdayGroup {
  weekday: number;
  rows: PatternRow[];
}

/** Monday-first, like the club's weeks. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function groupPattern(preview: CopyPatternResponse, include: (locationId: number) => boolean): WeekdayGroup[] {
  const rows = new Map<string, PatternRow & { weekday: number }>();
  const add = (s: CopyPatternShow, bucket: 'create' | 'exists' | 'past') => {
    if (!include(s.locationId)) return;
    const key = `${s.weekday}|${s.locationId}|${s.startMin}|${s.name}|${s.slotCount}`;
    let row = rows.get(key);
    if (!row) {
      row = { key, weekday: s.weekday, location: s.location, startMin: s.startMin, name: s.name, slotCount: s.slotCount, create: [], exists: [], past: [] };
      rows.set(key, row);
    }
    row[bucket].push(s.date);
  };
  preview.shows.forEach((s) => add(s, 'create'));
  preview.skipped.forEach((s) => add(s, s.reason === 'past' ? 'past' : 'exists'));

  return WEEKDAY_ORDER.map((weekday) => ({
    weekday,
    rows: [...rows.values()]
      .filter((r) => r.weekday === weekday)
      .sort((a, b) => a.startMin - b.startMin || a.location.name.localeCompare(b.location.name)),
  })).filter((g) => g.rows.length > 0);
}

/** "Dec 4, 11, 18, 25": every date a weekday group lands on. */
function datesPhrase(rows: PatternRow[]): string {
  const dates = [...new Set(rows.flatMap((r) => [...r.create, ...r.exists, ...r.past]))].sort();
  return dates.map((d, i) => (i === 0 ? formatDateShort(d) : String(Number(d.slice(8))))).join(', ');
}

export function CopyPatternDialog({ open, onOpenChange, toMonth, onCopied }: CopyPatternDialogProps) {
  const fromMonth = addMonths(toMonth, -1);
  // Always preview every location; the chips filter what we show and what we send.
  const preview = useCopyPatternPreview({ fromMonth, toMonth }, open);
  const copy = useCopyPattern();
  const queryClient = useQueryClient();
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());

  const locations = useMemo(() => {
    const seen = new Map<number, CopyPatternShow['location']>();
    for (const s of [...(preview.data?.shows ?? []), ...(preview.data?.skipped ?? [])]) seen.set(s.locationId, s.location);
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [preview.data]);

  const include = (locationId: number) => !excluded.has(locationId);
  const groups = useMemo(
    () => (preview.data ? groupPattern(preview.data, (id) => !excluded.has(id)) : []),
    [preview.data, excluded],
  );
  const toCreate = preview.data?.shows.filter((s) => include(s.locationId)).length ?? 0;
  const existing = preview.data?.skipped.filter((s) => s.reason === 'duplicate' && include(s.locationId)).length ?? 0;
  const past = preview.data?.skipped.filter((s) => s.reason === 'past' && include(s.locationId)).length ?? 0;
  const fromName = formatMonthName(fromMonth);
  const toName = formatMonthName(toMonth);

  function handleOpenChange(next: boolean) {
    if (copy.isPending) return;
    if (!next) {
      setExcluded(new Set());
      copy.reset();
    }
    onOpenChange(next);
  }

  function toggleLocation(id: number) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirm() {
    const locationIds = excluded.size ? locations.map((l) => l.id).filter(include) : undefined;
    try {
      const result = await copy.mutateAsync({ fromMonth, toMonth, locationIds });
      const skipped = result.skipped.filter((s) => s.reason === 'duplicate').length;
      const ids = result.shows.flatMap((s) => (s.id != null ? [s.id] : []));
      toast.success(`Created ${plural(result.shows.length, 'show')} in ${toName}`, {
        description: skipped ? `${plural(skipped, 'show')} already existed and ${skipped === 1 ? 'was' : 'were'} skipped.` : undefined,
        ...(ids.length
          ? { action: { label: 'Undo', onClick: () => void undoCreatedShows(queryClient, ids) }, duration: 10_000 }
          : {}),
      });
      onCopied?.(result);
      setExcluded(new Set());
      copy.reset();
      onOpenChange(false);
    } catch {
      // Shown inline (copy.error); the mutation is `silent`, so no duplicate toast.
    }
  }

  let body;
  if (preview.isPending) {
    body = (
      <div className="flex h-48 items-center justify-center">
        <Spinner label="Loading preview" />
      </div>
    );
  } else if (preview.isError) {
    body = (
      <EmptyState
        icon={TriangleAlert}
        title="Couldn't load the preview"
        description={errorMessage(preview.error)}
        action={
          <Button variant="secondary" onClick={() => void preview.refetch()}>
            Try again
          </Button>
        }
      />
    );
  } else if (preview.data.sourceShowCount === 0) {
    body = (
      <EmptyState
        icon={CalendarX}
        title={`${fromName} has no shows to copy`}
        description={`Create ${fromName}’s shows first, or paint ${toName}’s shows by hand.`}
      />
    );
  } else {
    body = (
      <div className="space-y-4">
        {locations.length > 1 && (
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-fg">Locations</legend>
            <div className="flex flex-wrap gap-1.5">
              {locations.map((l) => {
                const on = include(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleLocation(l.id)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors',
                      on ? 'border-border-strong bg-surface text-fg shadow-xs' : 'border-dashed border-border text-fg-subtle',
                    )}
                  >
                    <ColorDot color={l.color} className={cn(!on && 'opacity-40')} />
                    {l.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {groups.length === 0 ? (
          <p className="rounded-lg bg-surface-2 px-3 py-6 text-center text-sm text-fg-muted">Pick at least one location.</p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {groups.map((group) => (
              <section key={group.weekday} className="px-3 py-2.5" aria-label={WEEKDAY_PLURALS[group.weekday]}>
                <h3 className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold text-fg">
                  {WEEKDAY_PLURALS[group.weekday]}
                  <span className="text-xs font-normal text-fg-muted">{datesPhrase(group.rows)}</span>
                </h3>
                <ul className="space-y-1">
                  {group.rows.map((row) => (
                    <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
                      <span className="flex w-36 min-w-0 items-center gap-1.5 truncate">
                        <ColorDot color={row.location.color} />
                        <span className="truncate">{row.location.name}</span>
                      </span>
                      <span className="w-20 font-medium tabular-nums">{formatTime(row.startMin)}</span>
                      <span className="min-w-0 flex-1 truncate text-fg-muted">
                        {row.name || 'Untitled'} · {plural(row.slotCount, 'slot')}
                      </span>
                      <span className="text-right text-xs text-fg-muted tabular-nums" title={row.create.map(formatDateShort).join(', ')}>
                        {row.create.length ? (
                          <span className="font-medium text-accent">
                            +{row.create.length}
                            <span className="sr-only"> new</span>
                          </span>
                        ) : null}
                        {row.exists.length ? (
                          <span className="ml-1.5">{row.exists.length} already there</span>
                        ) : null}
                        {row.past.length ? <span className="ml-1.5">{row.past.length} past</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {copy.isError && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(copy.error)}
          </p>
        )}
      </div>
    );
  }

  const ready = preview.isSuccess && preview.data.sourceShowCount > 0;
  const nothingToCopy = preview.isSuccess && preview.data.sourceShowCount === 0;
  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      size="lg"
      title={copyPatternLabel(toMonth)}
      description={`Every weekly show from ${formatMonthLong(fromMonth)} lands on the same weekdays in ${toName}. Lineups aren’t copied.`}
      footer={
        <>
          {ready && (
            <p className="text-sm text-fg-muted sm:mr-auto" aria-live="polite">
              <strong className="font-semibold text-fg">{plural(toCreate, 'show')}</strong> will be created
              {existing ? ` · ${existing} already exist` : ''}
              {past ? ` · ${past} in the past` : ''}
            </p>
          )}
          <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={copy.isPending}>
            {nothingToCopy ? 'Close' : 'Cancel'}
          </Button>
          {!nothingToCopy && (
            <Button onClick={() => void confirm()} loading={copy.isPending} disabled={!ready || toCreate === 0}>
              {toCreate ? `Create ${plural(toCreate, 'show')}` : 'Nothing to create'}
            </Button>
          )}
        </>
      }
    >
      {body}
    </Dialog>
  );
}
