/**
 * Private booker notes on a comedian: add (⌘/Ctrl+Enter), edit and delete (author or
 * admin), newest first, author + relative time. Also feeds the hover card.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Lock, Pencil, StickyNote, Trash2 } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { NOTE_MAX, type NoteDto } from '../../../shared/api/comedians';
import { formatRelative } from '../../../shared/time';
import {
  Avatar,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Spinner,
  Textarea,
} from '../../components/ui';
import { api } from '../../lib/api';
import { comedianKeys, notesQuery } from './queries';

function submitOnModEnter(e: KeyboardEvent<HTMLTextAreaElement>, submit: () => void) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submit();
  }
}

export function NotesPanel({ comedianId, comedianName }: { comedianId: number; comedianName: string }) {
  const queryClient = useQueryClient();
  const notes = useQuery(notesQuery(comedianId));
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<NoteDto | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: comedianKeys.notes(comedianId) });
    void queryClient.invalidateQueries({ queryKey: comedianKeys.card(comedianId) });
  };

  const add = useMutation({
    mutationFn: (body: string) => api.post<NoteDto>(`/comedians/${comedianId}/notes`, { body }),
    onSuccess: (note) => {
      queryClient.setQueryData<NoteDto[]>(comedianKeys.notes(comedianId), (prev) => [note, ...(prev ?? [])]);
      refresh();
      setDraft('');
    },
  });

  const remove = useMutation({
    mutationFn: (note: NoteDto) => api.del(`/notes/${note.id}`),
    meta: { silent: true }, // ConfirmDialog shows the error
    onSuccess: (_res, note) => {
      queryClient.setQueryData<NoteDto[]>(comedianKeys.notes(comedianId), (prev) => prev?.filter((n) => n.id !== note.id));
      refresh();
      toast.success('Note deleted');
    },
  });

  const body = draft.trim();
  const tooLong = draft.length > NOTE_MAX;
  const submit = () => {
    if (body && !tooLong && !add.isPending) add.mutate(body);
  };

  const count = notes.data?.length ?? 0;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Notes
            {count > 0 && <span className="text-xs font-normal text-fg-muted">{count}</span>}
          </span>
        }
        description={
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3" aria-hidden /> Private to club staff · also shown on hover
          </span>
        }
      />
      <CardBody className="space-y-3 border-b border-border">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => submitOnModEnter(e, submit)}
          placeholder={`What should other bookers know about ${comedianName.split(' ')[0] || 'them'}?`}
          aria-label="New note"
          rows={3}
          invalid={tooLong}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-fg-subtle">
            {tooLong ? (
              <span className="text-danger">
                {draft.length}/{NOTE_MAX} characters
              </span>
            ) : (
              <>
                <kbd className="font-sans">⌘</kbd>/<kbd className="font-sans">Ctrl</kbd>+<kbd className="font-sans">Enter</kbd> to add
              </>
            )}
          </p>
          <Button size="sm" onClick={submit} disabled={!body || tooLong} loading={add.isPending}>
            Add note
          </Button>
        </div>
      </CardBody>

      {notes.isPending ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : count === 0 ? (
        <EmptyState
          icon={StickyNote}
          title="No notes yet"
          description="Jot down how sets went, who they work well with, or anything to keep in mind."
          className="py-8"
        />
      ) : (
        <ul className="divide-y divide-border">
          {notes.data!.map((note) => (
            <NoteItem key={note.id} note={note} comedianId={comedianId} onDelete={() => setDeleting(note)} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this note?"
        description="It will be gone for every booker. This can't be undone."
        confirmLabel="Delete note"
        destructive
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </Card>
  );
}

function NoteItem({ note, comedianId, onDelete }: { note: NoteDto; comedianId: number; onDelete: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);

  const save = useMutation({
    mutationFn: (body: string) => api.patch<NoteDto>(`/notes/${note.id}`, { body }),
    onSuccess: (updated) => {
      queryClient.setQueryData<NoteDto[]>(comedianKeys.notes(comedianId), (prev) =>
        prev?.map((n) => (n.id === updated.id ? updated : n)),
      );
      void queryClient.invalidateQueries({ queryKey: comedianKeys.card(comedianId) });
      setEditing(false);
    },
  });

  const author = note.authorName ?? 'Former booker';
  const edited = note.updatedAt - note.createdAt > 60_000;
  const trimmed = text.trim();
  const submit = () => {
    if (!trimmed || text.length > NOTE_MAX) return;
    if (trimmed === note.body) setEditing(false);
    else save.mutate(trimmed);
  };

  return (
    <li className="group px-4 py-3">
      <div className="flex items-center gap-2">
        <Avatar name={author} size="xs" />
        <span className="text-xs font-medium text-fg">{author}</span>
        <span className="text-xs text-fg-subtle" title={new Date(note.createdAt).toLocaleString()}>
          {formatRelative(note.createdAt)}
          {edited && ' · edited'}
        </span>
        {note.canEdit && !editing && (
          <Menu>
            <MenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Note actions"
                className="ml-auto text-fg-muted opacity-60 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <Ellipsis />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                onSelect={() => {
                  setText(note.body);
                  setEditing(true);
                }}
              >
                <Pencil /> Edit
              </MenuItem>
              <MenuItem destructive onSelect={onDelete}>
                <Trash2 /> Delete
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              submitOnModEnter(e, submit);
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
            aria-label="Edit note"
            rows={3}
            autoFocus
            invalid={text.length > NOTE_MAX}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} loading={save.isPending} disabled={!trimmed || text.length > NOTE_MAX}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 pl-7 text-sm leading-relaxed whitespace-pre-wrap text-fg">{note.body}</p>
      )}
    </li>
  );
}
