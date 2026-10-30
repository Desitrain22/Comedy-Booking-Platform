/**
 * /app/comedians/:id — profile: header (headshot/initials, name, email, tags editor,
 * bio), actions (send sign-in link, edit, archive/restore), private notes, read-only
 * availability calendar and upcoming spots.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowLeft, Copy, Ellipsis, Mail, Pencil, Plus, Send, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type { ComedianDetail, SendLoginLinkResponse, TagSummary } from '../../../shared/api/comedians';
import { formatRelative } from '../../../shared/time';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  PageHeader,
  PageSpinner,
  buttonClasses,
} from '../../components/ui';
import { api, errorMessage, isApiError } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { useBooker } from '../../lib/useMe';
import { AvailabilityCard } from './AvailabilityCard';
import { EditComedianDialog } from './EditComedianDialog';
import { NotesPanel } from './NotesPanel';
import { comedianKeys, comedianQuery, invalidateTags, useTags } from './queries';
import { TagPicker } from './TagPicker';
import { UpcomingSpots } from './UpcomingSpots';

export function ComedianProfilePage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const query = useQuery({ ...comedianQuery(id), enabled: valid });

  if (!valid || (query.isError && isApiError(query.error) && query.error.status === 404)) {
    return <NotFound />;
  }
  if (!query.data) return <PageSpinner />;
  return <Profile comedian={query.data} />;
}

function NotFound() {
  return (
    <div>
      <PageHeader title="Comedian not found" />
      <Card>
        <EmptyState
          title="No comedian here"
          description="They may have been removed, or the link is wrong."
          action={
            <Link to="/app/comedians" className={buttonClasses({ variant: 'secondary' })}>
              Back to comedians
            </Link>
          }
        />
      </Card>
    </div>
  );
}

function Profile({ comedian }: { comedian: ComedianDetail }) {
  usePageTitle(comedian.name);
  const queryClient = useQueryClient();
  const isAdmin = useBooker().role === 'admin';
  const [editOpen, setEditOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const sendLink = useMutation({
    mutationFn: () => api.post<SendLoginLinkResponse>(`/comedians/${comedian.id}/send-login-link`),
    onSuccess: (res) => {
      if (res.status === 'sent') toast.success(`Sign-in link sent to ${comedian.email}`);
      else if (res.status === 'outbox') {
        toast.info('Email isn’t set up yet, so the link went to the outbox', {
          // The email log is admin-only (it holds sign-in codes and links).
          description: isAdmin ? 'Find it under Settings → Email log.' : 'An admin can find it under Settings → Email log.',
        });
      } else toast.error(`Couldn’t send the email${res.error ? `: ${res.error}` : ''}`);
    },
  });

  const setArchived = useMutation({
    mutationFn: (archived: boolean) => api.patch<ComedianDetail>(`/comedians/${comedian.id}`, { archived }),
    onSuccess: (updated) => {
      queryClient.setQueryData(comedianKeys.detail(comedian.id), updated);
      invalidateTags(queryClient); // member counts change too
      toast.success(updated.archived ? `${updated.name} archived` : `${updated.name} restored`);
    },
  });

  return (
    <div>
      <Link
        to="/app/comedians"
        className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Comedians
      </Link>

      {comedian.archived && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-4 py-2.5 text-sm">
          <Archive className="size-4 text-fg-muted" aria-hidden />
          <p className="flex-1 text-fg-muted">
            <span className="font-medium text-fg">{comedian.name} is archived.</span> They're hidden from the roster and
            lineup pool and can't sign in.
          </p>
          <Button size="sm" variant="secondary" loading={setArchived.isPending} onClick={() => setArchived.mutate(false)}>
            <ArchiveRestore /> Restore
          </Button>
        </div>
      )}

      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start">
        <Avatar name={comedian.name} src={comedian.headshotUrl} size="xl" className="shadow-sm ring-4 ring-surface" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold tracking-tight text-fg">{comedian.name}</h1>
              <p className="mt-0.5 text-sm text-fg-muted">
                <a href={`mailto:${comedian.email}`} className="break-all hover:text-fg hover:underline">
                  {comedian.email}
                </a>
                <span aria-hidden> · </span>
                <span className="whitespace-nowrap">
                  {comedian.lastLoginAt ? `Signed in ${formatRelative(comedian.lastLoginAt)}` : 'Never signed in'}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => sendLink.mutate()}
                loading={sendLink.isPending}
                disabled={comedian.archived}
                title={comedian.archived ? 'Restore them first' : 'Email them a link that signs them in to the portal'}
              >
                {!sendLink.isPending && <Send />} Send sign-in link
              </Button>
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                <Pencil /> Edit
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More actions">
                    <Ellipsis />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem
                    onSelect={() =>
                      void navigator.clipboard.writeText(comedian.email).then(
                        () => toast.success('Email copied'),
                        () => toast.error('Couldn’t copy'),
                      )
                    }
                  >
                    <Copy /> Copy email
                  </MenuItem>
                  <MenuItem onSelect={() => (window.location.href = `mailto:${comedian.email}`)}>
                    <Mail /> Write an email
                  </MenuItem>
                  <MenuSeparator />
                  {comedian.archived ? (
                    <MenuItem onSelect={() => setArchived.mutate(false)}>
                      <ArchiveRestore /> Restore
                    </MenuItem>
                  ) : (
                    <MenuItem destructive onSelect={() => setConfirmArchive(true)}>
                      <Archive /> Archive
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            </div>
          </div>

          <TagsEditor comedian={comedian} />

          {comedian.bio ? (
            <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-line text-fg">{comedian.bio}</p>
          ) : (
            <p className="text-sm text-fg-subtle">No bio yet — they can add one from the portal.</p>
          )}
        </div>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="min-w-0 space-y-5">
          <AvailabilityCard comedianId={comedian.id} />
          <UpcomingSpots comedianId={comedian.id} />
        </div>
        <div className="min-w-0 lg:sticky lg:top-6">
          <NotesPanel comedianId={comedian.id} comedianName={comedian.name} />
        </div>
      </div>

      <EditComedianDialog comedian={comedian} open={editOpen} onOpenChange={setEditOpen} />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${comedian.name}?`}
        description={
          <>
            They'll be hidden from the roster and the lineup pool and won't be able to sign in.
            {comedian.upcomingCount > 0 &&
              ` Their ${comedian.upcomingCount} upcoming spot${comedian.upcomingCount === 1 ? '' : 's'} stay booked.`}{' '}
            You can restore them any time.
          </>
        }
        confirmLabel="Archive"
        destructive
        onConfirm={() => setArchived.mutateAsync(true)}
      />
    </div>
  );
}

function TagsEditor({ comedian }: { comedian: ComedianDetail }) {
  const queryClient = useQueryClient();
  const { data: allTags = [] } = useTags();
  const key = comedianKeys.detail(comedian.id);

  const save = useMutation({
    mutationFn: (tagIds: number[]) => api.put<TagSummary[]>(`/comedians/${comedian.id}/tags`, { tagIds }),
    onMutate: async (tagIds) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ComedianDetail>(key);
      const byId = new Map<number, TagSummary>([...allTags, ...comedian.tags].map((t) => [t.id, t]));
      const optimistic = tagIds
        .map((id) => byId.get(id))
        .filter((t): t is TagSummary => Boolean(t))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      queryClient.setQueryData<ComedianDetail>(key, (prev) => (prev ? { ...prev, tags: optimistic } : prev));
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(errorMessage(err));
    },
    onSuccess: (tags) => {
      queryClient.setQueryData<ComedianDetail>(key, (prev) => (prev ? { ...prev, tags } : prev));
    },
    onSettled: () => {
      invalidateTags(queryClient);
    },
  });

  const ids = comedian.tags.map((t) => t.id);

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Tags">
      {comedian.tags.map((tag) => (
        <Badge key={tag.id} dotColor={tag.color} className="h-7 gap-1.5 pr-1 pl-2.5 text-[13px]">
          {tag.name}
          <button
            type="button"
            onClick={() => save.mutate(ids.filter((t) => t !== tag.id))}
            aria-label={`Remove tag ${tag.name}`}
            className="rounded-full p-0.5 text-fg-subtle hover:bg-surface-3 hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <TagPicker selectedIds={ids} onChange={(next) => save.mutate(next)}>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Plus className="size-3.5" aria-hidden /> {comedian.tags.length ? 'Tag' : 'Add tags'}
        </button>
      </TagPicker>
    </div>
  );
}
