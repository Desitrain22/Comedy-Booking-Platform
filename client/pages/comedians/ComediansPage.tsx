/**
 * /app/comedians — the roster: search, tag filter (`?tags=1,2`, any of), show archived,
 * row selection for bulk tag / archive, and the Add / Bulk add dialogs.
 * URL params: `q`, `tags`, `archived=1` (the Tags page links here with `?tags=<id>`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Check, ChevronDown, ClipboardList, Plus, Search, Tag, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { BulkUpdateResult, ComedianListItem, TagWithCount } from '../../../shared/api/comedians';
import { addMonths, formatMonthShort, monthOf, todayInTz } from '../../../shared/time';
import { ComedianHoverCard } from '../../components/ComedianHoverCard';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  PageHeader,
  PageSpinner,
  Switch,
} from '../../components/ui';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useClub } from '../../lib/useMe';
import { AddComedianDialog } from './AddComedianDialog';
import { BulkAddDialog } from './BulkAddDialog';
import { invalidateTags, rosterQuery, useTags } from './queries';

function parseIds(value: string | null): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function ComediansPage() {
  const [params, setParams] = useSearchParams();
  const urlSearch = params.get('q') ?? '';
  const tagIds = useMemo(() => parseIds(params.get('tags')), [params]);
  const archived = params.get('archived') === '1';

  const [searchInput, setSearchInput] = useState(urlSearch);
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // Debounce typing into the URL (replace, so Back doesn't step through keystrokes).
  useEffect(() => {
    if (searchInput.trim() === urlSearch) return;
    const timer = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (searchInput.trim()) next.set('q', searchInput.trim());
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [searchInput, urlSearch, setParams]);

  function updateParam(key: string, value: string | null) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  function toggleTag(id: number) {
    const next = tagIds.includes(id) ? tagIds.filter((t) => t !== id) : [...tagIds, id];
    updateParam('tags', next.length ? next.join(',') : null);
  }

  function clearFilters() {
    setSearchInput('');
    setParams(new URLSearchParams(), { replace: true });
  }

  const roster = useQuery(rosterQuery({ search: urlSearch, tagIds, archived }));
  const { data: tags = [] } = useTags();
  const club = useClub();
  const nextMonth = addMonths(monthOf(todayInTz(club?.timezone ?? 'America/New_York')), 1);

  const rows = roster.data ?? [];
  const filtered = Boolean(urlSearch) || tagIds.length > 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Comedians"
        description="Your roster. Hover a name to see tags and notes."
        actions={
          <>
            <Button variant="secondary" onClick={() => setBulkOpen(true)}>
              <ClipboardList /> Bulk add
            </Button>
            <Button onClick={() => setAddOpen(true)}>
              <Plus /> Add comedian
            </Button>
          </>
        }
      />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search name or email"
              aria-label="Search comedians"
              className="pl-9"
            />
          </div>
          <div className="ml-auto flex items-center gap-4">
            {filtered && (
              <Button variant="link" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            <Switch checked={archived} onCheckedChange={(v) => updateParam('archived', v ? '1' : null)} label="Show archived" />
          </div>
        </div>
        {tags.length > 0 && (
          <TagFilter tags={tags} selected={tagIds} onToggle={toggleTag} />
        )}
      </div>

      {roster.isPending ? (
        <Card>
          <PageSpinner />
        </Card>
      ) : roster.isError ? (
        <Card>
          <EmptyState title="Couldn't load comedians" description="Check your connection and try again." />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={Search}
              title="No comedians match"
              description="Try a different search or tag."
              action={
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No comedians yet"
              description="Add comedians one at a time, or paste a whole list. They only need a name and an email."
              action={
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setBulkOpen(true)}>
                    <ClipboardList /> Bulk add
                  </Button>
                  <Button onClick={() => setAddOpen(true)}>
                    <Plus /> Add comedian
                  </Button>
                </div>
              }
            />
          )}
        </Card>
      ) : (
        <RosterTable
          rows={rows}
          tags={tags}
          nextMonth={nextMonth}
          fetching={roster.isFetching && roster.isPlaceholderData}
          filtered={filtered}
        />
      )}

      <AddComedianDialog open={addOpen} onOpenChange={setAddOpen} />
      <BulkAddDialog open={bulkOpen} onOpenChange={setBulkOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function TagFilter({
  tags,
  selected,
  onToggle,
}: {
  tags: TagWithCount[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag">
      <span className="mr-1 text-xs font-medium text-fg-muted">Tags</span>
      {tags.map((tag) => {
        const on = selected.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(tag.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
              on
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border-strong bg-surface text-fg-muted hover:border-fg-subtle hover:text-fg',
            )}
          >
            <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
            {tag.name}
            <span className={cn('tabular-nums', on ? 'text-accent/80' : 'text-fg-subtle')}>{tag.memberCount}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface RosterTableProps {
  rows: ComedianListItem[];
  tags: TagWithCount[];
  nextMonth: string;
  fetching: boolean;
  filtered: boolean;
}

function RosterTable({ rows, tags, nextMonth, fetching, filtered }: RosterTableProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirmArchive, setConfirmArchive] = useState(false);

  // Only act on selected rows that are still visible under the current filters.
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectedIds = selectedRows.map((r) => r.id);
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;
  const someSelected = selectedRows.length > 0 && !allSelected;

  const headerBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  const bulkTag = useMutation({
    mutationFn: (input: { tag: TagWithCount; action: 'add' | 'remove' }) =>
      api.post<BulkUpdateResult>('/comedians/bulk-tag', { comedianIds: selectedIds, tagId: input.tag.id, action: input.action }),
    onSuccess: (_res, { tag, action }) => {
      invalidateTags(queryClient);
      const n = selectedIds.length;
      toast.success(
        action === 'add'
          ? `Tagged ${n} comedian${n === 1 ? '' : 's'} “${tag.name}”`
          : `Removed “${tag.name}” from ${n} comedian${n === 1 ? '' : 's'}`,
      );
    },
  });

  const bulkArchive = useMutation({
    mutationFn: (archive: boolean) =>
      api.post<BulkUpdateResult>('/comedians/bulk-archive', {
        comedianIds: selectedRows.filter((r) => r.archived !== archive).map((r) => r.id),
        archived: archive,
      }),
    onSuccess: (res, archive) => {
      invalidateTags(queryClient);
      setSelected(new Set());
      toast.success(`${archive ? 'Archived' : 'Restored'} ${res.updated} comedian${res.updated === 1 ? '' : 's'}`);
    },
  });

  const selectedTagIds = new Set(selectedRows.flatMap((r) => r.tags.map((t) => t.id)));
  const removableTags = tags.filter((t) => selectedTagIds.has(t.id));
  const activeSelected = selectedRows.filter((r) => !r.archived).length;
  const archivedSelected = selectedRows.length - activeSelected;

  function onRowClick(e: MouseEvent<HTMLTableRowElement>, id: number) {
    const target = e.target as Element;
    if (target.closest('a, button, input, label')) return;
    if (window.getSelection()?.toString()) return;
    void navigate(`/app/comedians/${id}`);
  }

  const monthLabel = formatMonthShort(nextMonth);

  return (
    <>
      <div className="mb-2 flex min-h-9 flex-wrap items-center gap-2">
        {selectedRows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-2 py-1 animate-fade-in">
            <span className="px-1 text-sm font-medium text-accent">{selectedRows.length} selected</span>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="secondary" size="sm" disabled={bulkTag.isPending}>
                  <Tag /> Add tag <ChevronDown />
                </Button>
              </MenuTrigger>
              <MenuContent align="start">
                {tags.length === 0 ? (
                  <MenuItem onSelect={() => void navigate('/app/tags')}>No tags yet — create one</MenuItem>
                ) : (
                  tags.map((tag) => (
                    <MenuItem key={tag.id} onSelect={() => bulkTag.mutate({ tag, action: 'add' })}>
                      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                      {tag.name}
                    </MenuItem>
                  ))
                )}
              </MenuContent>
            </Menu>
            {removableTags.length > 0 && (
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="secondary" size="sm" disabled={bulkTag.isPending}>
                    Remove tag <ChevronDown />
                  </Button>
                </MenuTrigger>
                <MenuContent align="start">
                  <MenuLabel>Remove from selected</MenuLabel>
                  {removableTags.map((tag) => (
                    <MenuItem key={tag.id} onSelect={() => bulkTag.mutate({ tag, action: 'remove' })}>
                      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                      {tag.name}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )}
            {activeSelected > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setConfirmArchive(true)}>
                <Archive /> Archive
              </Button>
            )}
            {archivedSelected > 0 && (
              <Button variant="secondary" size="sm" loading={bulkArchive.isPending} onClick={() => bulkArchive.mutate(false)}>
                <ArchiveRestore /> Restore
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
              <X />
            </Button>
          </div>
        ) : (
          <p className="text-sm text-fg-muted" aria-live="polite">
            {rows.length} comedian{rows.length === 1 ? '' : 's'}
            {filtered && (rows.length === 1 ? ' matches' : ' match')}
          </p>
        )}
      </div>

      <Card className={cn('overflow-hidden transition-opacity', fetching && 'opacity-70')}>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="border-b border-border bg-surface-2/60 text-xs text-fg-muted">
              <tr>
                <th scope="col" className="w-11 py-2.5 pr-1 pl-4">
                  <input
                    ref={headerBox}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all comedians"
                    className="size-4 rounded accent-accent-solid"
                  />
                </th>
                <th scope="col" className="w-[36%] px-3 py-2.5 font-medium lg:w-[26%]">
                  Comedian
                </th>
                <th scope="col" className="hidden w-[24%] px-3 py-2.5 font-medium lg:table-cell">
                  Email
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Tags
                </th>
                <th scope="col" className="w-24 px-3 py-2.5 font-medium whitespace-nowrap lg:w-36">
                  {monthLabel}
                  <span className="hidden lg:inline"> availability</span>
                </th>
                <th scope="col" className="w-20 px-4 py-2.5 text-right font-medium lg:w-24">
                  Upcoming
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const isSelected = selected.has(c.id);
                return (
                  <tr
                    key={c.id}
                    onClick={(e) => onRowClick(e, c.id)}
                    className={cn(
                      'cursor-pointer border-b border-border last:border-b-0 transition-colors',
                      isSelected ? 'bg-accent-soft/60' : 'hover:bg-surface-2/60',
                      c.archived && 'text-fg-muted',
                    )}
                  >
                    <td className="py-2.5 pr-1 pl-4">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(c.id)}
                        aria-label={`Select ${c.name}`}
                        className="size-4 rounded accent-accent-solid"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={c.name} src={c.headshotUrl} size="sm" className={cn(c.archived && 'opacity-60')} />
                        <div className="min-w-0">
                          <ComedianHoverCard comedianId={c.id}>
                            <Link
                              to={`/app/comedians/${c.id}`}
                              className={cn(
                                'block truncate font-medium hover:underline',
                                c.archived ? 'text-fg-muted' : 'text-fg',
                              )}
                            >
                              {c.name}
                            </Link>
                          </ComedianHoverCard>
                          <span className="block truncate text-xs text-fg-muted lg:hidden">{c.email}</span>
                        </div>
                        {c.archived && (
                          <Badge variant="outline" className="py-0 text-[11px]">
                            Archived
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="hidden max-w-64 truncate px-3 py-2 text-fg-muted lg:table-cell">{c.email}</td>
                    <td className="overflow-hidden px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.map((tag) => (
                          <Badge key={tag.id} dotColor={tag.color}>
                            {tag.name}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {c.nextMonthSubmitted ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-available-fg">
                          <Check className="size-3.5" aria-hidden /> Submitted
                        </span>
                      ) : (
                        <span className="text-xs text-fg-subtle">Not yet</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {c.upcomingCount > 0 ? (
                        <span className="font-medium text-fg">{c.upcomingCount}</span>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${activeSelected} comedian${activeSelected === 1 ? '' : 's'}?`}
        description="They'll be hidden from the roster and the lineup pool and won't be able to sign in. Spots they're already booked for stay booked. You can restore them any time."
        confirmLabel="Archive"
        destructive
        onConfirm={() => bulkArchive.mutateAsync(true)}
      />
    </>
  );
}
