/**
 * /app/tags — manage comedian groups ("Hosts", "All Stars", "Bullet Spots"…): create,
 * rename, recolor, delete. Clicking a tag opens the roster filtered by it.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { nextTagColor, type TagWithCount } from '../../../shared/api/comedians';
import { Button, Card, ConfirmDialog, EmptyState, PageHeader, PageSpinner } from '../../components/ui';
import { api } from '../../lib/api';
import { invalidateTags, useTags } from '../comedians/queries';
import { TagDialog } from './TagDialog';

const SUGGESTIONS = ['Hosts', 'Headliners', 'All Stars', 'Bullet Spots'];

export function TagsPage() {
  const queryClient = useQueryClient();
  const { data: tags, isPending, isError } = useTags();
  const [dialog, setDialog] = useState<{ tag: TagWithCount | null } | null>(null);
  const [deleting, setDeleting] = useState<TagWithCount | null>(null);

  const quickCreate = useMutation({
    mutationFn: (name: string) => api.post<TagWithCount>('/tags', { name }),
    onSuccess: (tag) => {
      invalidateTags(queryClient);
      toast.success(`Created “${tag.name}”`);
    },
  });

  const remove = useMutation({
    mutationFn: (tag: TagWithCount) => api.del(`/tags/${tag.id}`),
    meta: { silent: true }, // ConfirmDialog shows the error
    onSuccess: (_res, tag) => {
      invalidateTags(queryClient);
      toast.success(`Deleted “${tag.name}”`);
    },
  });

  const list = tags ?? [];
  const nextColor = nextTagColor(list.map((t) => t.color));
  const missingSuggestions = SUGGESTIONS.filter((s) => !list.some((t) => t.name.toLowerCase() === s.toLowerCase()));

  return (
    <div>
      <PageHeader
        title="Tags"
        description="Group comedians — hosts, headliners, bullet spots — then pull them into lineups by tag."
        actions={
          <Button onClick={() => setDialog({ tag: null })}>
            <Plus /> New tag
          </Button>
        }
      />

      {isPending ? (
        <Card>
          <PageSpinner />
        </Card>
      ) : isError ? (
        <Card>
          <EmptyState title="Couldn't load tags" description="Check your connection and try again." />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Tags}
            title="No tags yet"
            description="Tags group comedians so you can filter the roster and pull them into lineups. Start with a few common ones:"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((name) => (
                  <Button
                    key={name}
                    variant="secondary"
                    size="sm"
                    disabled={quickCreate.isPending}
                    onClick={() => quickCreate.mutate(name)}
                  >
                    <Plus /> {name}
                  </Button>
                ))}
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {list.map((tag) => (
                <li key={tag.id} className="group flex items-center gap-3 pr-2 transition-colors hover:bg-surface-2/60">
                  <Link
                    to={`/app/comedians?tags=${tag.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 focus-visible:outline-offset-[-2px]"
                    aria-label={`${tag.name}: ${tag.memberCount} comedian${tag.memberCount === 1 ? '' : 's'}. Show them`}
                  >
                    <span
                      aria-hidden
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                      style={{ backgroundColor: `color-mix(in oklab, ${tag.color} 18%, transparent)` }}
                    >
                      <span className="size-3 rounded-full" style={{ backgroundColor: tag.color }} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg">{tag.name}</span>
                      <span className="block text-xs text-fg-muted">
                        {tag.memberCount === 0
                          ? 'No comedians yet'
                          : `${tag.memberCount} comedian${tag.memberCount === 1 ? '' : 's'}`}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-fg-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${tag.name}`}
                    className="text-fg-muted hover:text-fg"
                    onClick={() => setDialog({ tag })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${tag.name}`}
                    className="text-fg-muted hover:text-danger"
                    onClick={() => setDeleting(tag)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
          {missingSuggestions.length > 0 && list.length < 4 && (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              Ideas:
              {missingSuggestions.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => quickCreate.mutate(name)}
                  disabled={quickCreate.isPending}
                  className="rounded-full border border-dashed border-border-strong px-2 py-0.5 hover:border-accent hover:text-accent"
                >
                  + {name}
                </button>
              ))}
            </p>
          )}
          <p className="mt-4 text-xs text-fg-muted">
            Tip: tag comedians from their profile, or select several on the{' '}
            <Link to="/app/comedians" className="text-accent hover:underline">
              Comedians
            </Link>{' '}
            page and use “Add tag”.
          </p>
        </>
      )}

      <TagDialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)} tag={dialog?.tag} defaultColor={nextColor} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description={
          deleting && deleting.memberCount > 0
            ? `It will be removed from ${deleting.memberCount} comedian${deleting.memberCount === 1 ? '' : 's'}. The comedians themselves aren't affected.`
            : 'No comedians have this tag.'
        }
        confirmLabel="Delete tag"
        destructive
        onConfirm={() => remove.mutateAsync(deleting!)}
      />
    </div>
  );
}
