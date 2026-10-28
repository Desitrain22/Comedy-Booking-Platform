/**
 * Edit one show (opened from a calendar pill or `/app/calendar?show=<id>`): name, start
 * time, slot count, notes; cancel/restore; delete when it has no bookings. Changing the
 * start time resets its bookings' confirmations (the server does it; we warn first).
 */
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Ban, Minus, Plus, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  SHOW_NAME_MAX,
  SHOW_NOTES_MAX,
  SHOW_START_MIN,
  SHOW_START_PICKER_MAX,
  SHOW_START_STEP,
  SLOT_COUNT_MAX,
  type ShowDetail,
  type UpdateShowInput,
} from '../../../shared/api/shows';
import { formatDateLong, formatTime, timeOptions } from '../../../shared/time';
import { BookingStatusBadge } from '../../components/BookingStatusBadge';
import {
  Badge,
  Button,
  ColorDot,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  buttonClasses,
} from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { plural } from '../shows/showFormat';
import { invalidateShowData, useDeleteShow, useShowDetail, useUpdateShow } from '../shows/showsData';

export interface ShowEditDialogProps {
  /** The show to edit; null = closed. */
  showId: number | null;
  onClose: () => void;
}

export function ShowEditDialog({ showId, onClose }: ShowEditDialogProps) {
  const { data: show, isPending, isError, error, refetch } = useShowDetail(showId);
  const open = showId != null;

  if (!open) return null;

  if (!show) {
    const notFound = isApiError(error) && error.status === 404;
    return (
      <Dialog open onOpenChange={(next) => !next && onClose()} title="Edit show">
        {isPending ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <EmptyState
            icon={TriangleAlert}
            title={notFound ? 'This show no longer exists' : "Couldn't load this show"}
            description={notFound ? 'It may have been deleted.' : isError ? errorMessage(error) : undefined}
            action={
              notFound ? (
                <Button variant="secondary" onClick={onClose}>
                  Close
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => void refetch()}>
                  Try again
                </Button>
              )
            }
          />
        )}
      </Dialog>
    );
  }

  // Keyed so the form state starts fresh for each show.
  return <ShowEditForm key={show.id} show={show} onClose={onClose} />;
}

function ShowEditForm({ show, onClose }: { show: ShowDetail; onClose: () => void }) {
  const formId = useId();
  const [name, setName] = useState(show.name);
  const [startMin, setStartMin] = useState(show.startMin);
  const [slotCount, setSlotCount] = useState(show.slotCount);
  const [notes, setNotes] = useState(show.notes);
  const [confirming, setConfirming] = useState<'cancel' | 'delete' | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const update = useUpdateShow(show.id);
  const remove = useDeleteShow(show.id);
  const cancelled = show.status === 'cancelled';

  const times = useMemo(() => {
    const options = timeOptions(SHOW_START_MIN, SHOW_START_PICKER_MAX, SHOW_START_STEP);
    // Keep an off-grid time (e.g. 7:10 PM made via the API) selectable.
    if (!options.some((o) => o.value === show.startMin)) {
      options.push({ value: show.startMin, label: formatTime(show.startMin) });
      options.sort((a, b) => a.value - b.value);
    }
    return options;
  }, [show.startMin]);

  const patch: UpdateShowInput = {};
  if (name.trim() !== show.name) patch.name = name.trim();
  if (startMin !== show.startMin) patch.startMin = startMin;
  if (slotCount !== show.slotCount) patch.slotCount = slotCount;
  if (notes.trim() !== show.notes) patch.notes = notes.trim();
  const dirty = Object.keys(patch).length > 0;

  const slotError =
    slotCount < show.minSlotCount
      ? `Slot ${show.minSlotCount} is booked. Move or remove that comedian first.`
      : slotCount > SLOT_COUNT_MAX
        ? `At most ${SLOT_COUNT_MAX} slots.`
        : undefined;
  const confirmedCount = show.bookings.filter((b) => b.confirmedAt != null).length;
  const timeChanged = startMin !== show.startMin;
  const where = `${formatDateLong(show.date)} · ${formatTime(show.startMin)} at ${show.location.name}`;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || slotError) return;
    setServerError(null);
    try {
      const result = await update.mutateAsync(patch);
      toast.success('Show updated', {
        description: result.confirmationsReset
          ? `${plural(result.confirmationsReset, 'comedian')} will need to confirm the new time.`
          : undefined,
      });
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
    }
  }

  async function setStatus(status: 'scheduled' | 'cancelled') {
    const result = await update.mutateAsync({ status });
    if (status === 'cancelled') {
      onClose();
      toast.success('Show cancelled', {
        description: where,
        action: {
          label: 'Undo',
          // The dialog is gone by now, so don't rely on its mutation hook.
          onClick: () =>
            void api
              .patch(`/shows/${show.id}`, { status: 'scheduled' } satisfies UpdateShowInput)
              .then(
                () => toast.success('Show restored'),
                (err: unknown) => toast.error(errorMessage(err)),
              )
              .finally(() => void invalidateShowData(queryClient)),
        },
      });
    } else {
      toast.success('Show restored');
    }
    return result;
  }

  async function restore() {
    setServerError(null);
    try {
      await setStatus('scheduled');
    } catch (err) {
      setServerError(errorMessage(err));
    }
  }

  async function destroy() {
    await remove.mutateAsync();
    onClose();
    toast.success('Show deleted', { description: where });
  }

  const busy = update.isPending || remove.isPending;

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => !next && !busy && onClose()}
        size="lg"
        title={
          <span className="flex flex-wrap items-center gap-2">
            Edit show
            {cancelled && <Badge variant="danger">Cancelled</Badge>}
          </span>
        }
        description={
          <span className="flex items-center gap-1.5">
            <ColorDot color={show.location.color} />
            {formatDateLong(show.date)} · {show.location.name}
          </span>
        }
        footer={
          <>
            <div className="flex flex-col-reverse gap-2 sm:mr-auto sm:flex-row">
              {cancelled ? (
                <Button variant="secondary" onClick={() => void restore()} disabled={busy}>
                  <RotateCcw /> Restore show
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  className="text-danger hover:bg-danger-soft"
                  onClick={() => setConfirming('cancel')}
                  disabled={busy}
                >
                  <Ban /> Cancel show
                </Button>
              )}
              {show.bookedCount === 0 && (
                <Button
                  variant="ghost"
                  className="text-danger hover:bg-danger-soft"
                  onClick={() => setConfirming('delete')}
                  disabled={busy}
                >
                  <Trash2 /> Delete
                </Button>
              )}
            </div>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Close
            </Button>
            <Button type="submit" form={formId} loading={update.isPending} disabled={!dirty || Boolean(slotError)}>
              Save changes
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={(e) => void save(e)} className="space-y-4">
          {cancelled && (
            <p className="rounded-lg border border-unconfirmed/30 bg-unconfirmed-soft px-3 py-2 text-sm text-unconfirmed-fg">
              This show is cancelled. Its lineup is kept; restore it to put it back on the calendar.
            </p>
          )}

          <Field label="Show name" hint="Optional, e.g. “Late Show”.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={SHOW_NAME_MAX}
              placeholder="Untitled show"
              autoComplete="off"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start time">
              <Select value={startMin} onChange={(e) => setStartMin(Number(e.target.value))} options={times} />
            </Field>
            <Field label="Slots" error={slotError} hint={show.bookedCount ? `${show.bookedCount} booked` : undefined}>
              <SlotStepper value={slotCount} min={show.minSlotCount} onChange={setSlotCount} />
            </Field>
          </div>

          {timeChanged && show.bookedCount > 0 && (
            <p
              role="status"
              className="flex gap-2 rounded-lg border border-awaiting/40 bg-awaiting-soft px-3 py-2 text-sm text-awaiting-fg"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Moving to {formatTime(startMin)} resets confirmations: {show.bookedCount === 1 ? 'the' : 'all'}{' '}
                {plural(show.bookedCount, 'booked comedian')} will need to confirm the new time
                {confirmedCount ? ` (${confirmedCount} already confirmed ${formatTime(show.startMin)})` : ''}.
              </span>
            </p>
          )}

          <Field label="Notes" hint="Only bookers see these.">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={SHOW_NOTES_MAX} />
          </Field>

          <Lineup show={show} />

          {serverError && (
            <p role="alert" className="text-sm text-danger">
              {serverError}
            </p>
          )}
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirming === 'cancel'}
        onOpenChange={(next) => !next && setConfirming(null)}
        title="Cancel this show?"
        description={where}
        confirmLabel="Cancel show"
        cancelLabel="Keep show"
        destructive
        onConfirm={() => setStatus('cancelled')}
      >
        <p className="text-sm text-fg-muted">
          {show.bookedCount
            ? `The lineup (${show.bookedCount} booked) is kept and you can restore the show later. Booked comedians aren’t emailed, so let them know.`
            : 'You can restore it later.'}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'delete'}
        onOpenChange={(next) => !next && setConfirming(null)}
        title="Delete this show?"
        description={where}
        confirmLabel="Delete show"
        destructive
        onConfirm={destroy}
      >
        <p className="text-sm text-fg-muted">It will be removed from the calendar. This can’t be undone.</p>
      </ConfirmDialog>
    </>
  );
}

function SlotStepper({
  value,
  min,
  onChange,
  id,
  invalid,
  ...aria
}: {
  value: number;
  min: number;
  onChange: (value: number) => void;
  id?: string;
  invalid?: boolean;
  'aria-describedby'?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="secondary"
        size="icon"
        aria-label="Remove a slot"
        onClick={() => onChange(Math.max(1, value - 1))}
        disabled={value <= Math.max(1, min)}
      >
        <Minus />
      </Button>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={Math.max(1, min)}
        max={SLOT_COUNT_MAX}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Math.round(Number(e.target.value)))}
        invalid={invalid}
        aria-describedby={aria['aria-describedby']}
        className="w-16 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <Button
        variant="secondary"
        size="icon"
        aria-label="Add a slot"
        onClick={() => onChange(Math.min(SLOT_COUNT_MAX, (Number.isFinite(value) ? value : 0) + 1))}
        disabled={value >= SLOT_COUNT_MAX}
      >
        <Plus />
      </Button>
    </div>
  );
}

/** Read-only lineup (slot by slot) with a link to the day view to change it. */
function Lineup({ show }: { show: ShowDetail }) {
  const byPosition = new Map(show.bookings.map((b) => [b.position, b]));
  const slots = Math.max(show.slotCount, show.minSlotCount);
  return (
    <section aria-labelledby="show-lineup-heading" className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 id="show-lineup-heading" className="text-[13px] font-medium text-fg">
          Lineup <span className="font-normal text-fg-muted">· {show.bookedCount} of {show.slotCount} booked</span>
        </h3>
        <Link
          to={`/app/day/${show.date}`}
          className={buttonClasses({ variant: 'link', className: 'text-[13px] [&_svg]:size-3.5' })}
        >
          Open day <ArrowUpRight aria-hidden />
        </Link>
      </div>
      <ol className="grid gap-x-4 px-3 py-2 sm:grid-cols-2">
        {Array.from({ length: slots }, (_, position) => {
          const booking = byPosition.get(position);
          return (
            <li key={position} className="flex min-h-7 items-center gap-2 text-sm">
              <span className="w-4 shrink-0 text-right text-xs text-fg-subtle tabular-nums">{position + 1}</span>
              {booking ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-fg">{booking.comedianName}</span>
                  <BookingStatusBadge status={booking.status} short />
                </>
              ) : (
                <span className="text-fg-subtle">Open</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
