/**
 * Settings → Locations: the club's rooms/venues. Add, edit (name, address, color),
 * reorder (up/down), archive/restore. Uses the foundation's locations API.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronDown, ChevronUp, MapPin, Pencil, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { CreateLocationInput, UpdateLocationInput } from '../../../shared/schemas';
import { LOCATION_PALETTE, type Location } from '../../../shared/types';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Label,
  PageSpinner,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { ColorSwatches } from './SettingsParts';
import { ALL_LOCATIONS_KEY, useAllLocations } from './settingsData';

export function LocationsTab() {
  const queryClient = useQueryClient();
  const locations = useAllLocations();
  const [editing, setEditing] = useState<Location | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Location | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  /**
   * Refresh every locations query (calendar filters, create-shows form, …) and the screens
   * that show a location's name, color or order: calendar pills, day board, dashboard,
   * comedian profiles' upcoming spots.
   */
  const invalidate = () =>
    Promise.all(
      ['locations', 'shows', 'days', 'dashboard', 'comedians'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );

  const reorder = useMutation({
    mutationFn: (ids: number[]) => api.post<Location[]>('/locations/reorder', { ids }),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ALL_LOCATIONS_KEY });
      const previous = queryClient.getQueryData<Location[]>(ALL_LOCATIONS_KEY);
      if (previous) {
        const byId = new Map(previous.map((l) => [l.id, l]));
        const ordered = ids.map((id) => byId.get(id)!).filter(Boolean);
        const rest = previous.filter((l) => !ids.includes(l.id));
        queryClient.setQueryData(ALL_LOCATIONS_KEY, [...ordered, ...rest]);
      }
      return { previous };
    },
    onError: (err, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(ALL_LOCATIONS_KEY, context.previous);
      toast.error(errorMessage(err));
    },
    onSuccess: (data) => queryClient.setQueryData(ALL_LOCATIONS_KEY, data),
    onSettled: invalidate,
  });

  const setArchived = useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) =>
      api.patch<Location>(`/locations/${id}`, { archived } satisfies UpdateLocationInput),
    // The archive dialog shows its own error; restore toasts (below).
    meta: { silent: true },
    onSuccess: (location) => {
      toast.success(location.archived ? `${location.name} archived` : `${location.name} restored`);
      return invalidate();
    },
  });

  if (!locations.data) return <PageSpinner />;
  const active = locations.data.filter((l) => !l.archived);
  const archived = locations.data.filter((l) => l.archived);

  function move(index: number, delta: -1 | 1) {
    const ids = active.map((l) => l.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  }

  const nextColor =
    LOCATION_PALETTE.find((c) => !active.some((l) => l.color.toLowerCase() === c)) ??
    LOCATION_PALETTE[locations.data.length % LOCATION_PALETTE.length]!;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Locations"
          description="Rooms or venues where your shows happen. The order here is the order everywhere else."
          actions={
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus aria-hidden /> Add location
            </Button>
          }
        />
        {active.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="No locations yet"
            description="Add the rooms where you run shows, like “The Cellar” and “The Annex”."
          />
        ) : (
          <ul className="divide-y divide-border">
            {active.map((location, index) => (
              <li key={location.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex flex-col">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${location.name} up`}
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => move(index, -1)}
                    className="h-5"
                  >
                    <ChevronUp aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Move ${location.name} down`}
                    disabled={index === active.length - 1 || reorder.isPending}
                    onClick={() => move(index, 1)}
                    className="h-5"
                  >
                    <ChevronDown aria-hidden />
                  </Button>
                </div>
                <span
                  aria-hidden
                  className="size-8 shrink-0 rounded-lg ring-1 ring-black/5 ring-inset"
                  style={{ backgroundColor: location.color }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-fg">{location.name}</p>
                  <p className={cn('truncate text-xs', location.address ? 'text-fg-muted' : 'text-fg-subtle')}>
                    {location.address || 'No address'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(location)} aria-label={`Edit ${location.name}`}>
                    <Pencil aria-hidden />
                    <span className="hidden sm:inline">Edit</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setArchiving(location)}
                    disabled={active.length === 1}
                    title={active.length === 1 ? 'A club needs at least one location' : undefined}
                    aria-label={`Archive ${location.name}`}
                  >
                    <Archive aria-hidden />
                    <span className="hidden sm:inline">Archive</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {archived.length > 0 && (
        <Card>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium text-fg hover:bg-surface-2/60"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            <span>
              Archived <span className="font-normal text-fg-muted">({archived.length})</span>
            </span>
            <ChevronDown aria-hidden className={cn('size-4 text-fg-muted transition-transform', showArchived && 'rotate-180')} />
          </button>
          {showArchived && (
            <ul className="divide-y divide-border border-t border-border">
              {archived.map((location) => (
                <li key={location.id} className="flex items-center gap-3 px-4 py-3">
                  <span
                    aria-hidden
                    className="size-6 shrink-0 rounded-md opacity-50"
                    style={{ backgroundColor: location.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-fg-muted">{location.name}</p>
                    {location.address && <p className="truncate text-xs text-fg-subtle">{location.address}</p>}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={setArchived.isPending && setArchived.variables?.id === location.id}
                    onClick={() =>
                      setArchived.mutate(
                        { id: location.id, archived: false },
                        { onError: (err) => toast.error(errorMessage(err)) },
                      )
                    }
                  >
                    <ArchiveRestore aria-hidden /> Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <LocationDialog
        key={editing === 'new' ? 'new' : (editing?.id ?? 'closed')}
        location={editing}
        defaultColor={nextColor}
        onClose={() => setEditing(null)}
        onSaved={invalidate}
      />

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archiving?.name ?? 'location'}?`}
        description="It won't be offered for new shows. Existing shows stay as they are, and you can restore it any time."
        confirmLabel="Archive"
        destructive
        onConfirm={() => setArchived.mutateAsync({ id: archiving!.id, archived: true })}
      />
    </div>
  );
}

interface LocationDialogProps {
  location: Location | 'new' | null;
  defaultColor: string;
  onClose: () => void;
  onSaved: () => unknown;
}

function LocationDialog({ location, defaultColor, onClose, onSaved }: LocationDialogProps) {
  const isNew = location === 'new';
  const existing = location && location !== 'new' ? location : null;
  const [name, setName] = useState(existing?.name ?? '');
  const [address, setAddress] = useState(existing?.address ?? '');
  const [color, setColor] = useState(existing?.color ?? defaultColor);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.patch<Location>(`/locations/${existing.id}`, { name, address, color } satisfies UpdateLocationInput)
        : api.post<Location>('/locations', { name, address, color } satisfies CreateLocationInput),
    onSuccess: (saved) => {
      toast.success(isNew ? `${saved.name} added` : `${saved.name} saved`);
      onClose();
      return onSaved();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name');
    setError(null);
    save.mutate();
  }

  return (
    <Dialog
      open={location !== null}
      onOpenChange={(open) => !open && onClose()}
      title={isNew ? 'Add location' : 'Edit location'}
      size="sm"
    >
      <form id="location-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field label="Name" error={error ?? undefined}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="The Cellar" maxLength={100} />
        </Field>
        <Field label="Address" hint="Optional. Shown to comedians with their spots.">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="117 MacDougal St" maxLength={200} />
        </Field>
        <div className="space-y-2">
          <Label>Color</Label>
          <ColorSwatches label="Location color" value={color} onChange={setColor} palette={LOCATION_PALETTE} />
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {isNew ? 'Add location' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
