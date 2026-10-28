/**
 * Multi-select tag picker in a popover: search, toggle tags on/off, or create a new tag
 * from the search text. Changes are reported immediately through `onChange`.
 */
import * as Popover from '@radix-ui/react-popover';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createTagSchema, type TagWithCount } from '../../../shared/api/comedians';
import { Spinner } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { invalidateTags, useTags } from './queries';

export interface TagPickerProps {
  selectedIds: readonly number[];
  onChange: (tagIds: number[]) => void;
  /** The button that opens the picker. */
  children: ReactNode;
  disabled?: boolean;
}

export function TagPicker({ selectedIds, onChange, children, disabled }: TagPickerProps) {
  const queryClient = useQueryClient();
  const { data: tags = [], isPending } = useTags();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  const trimmed = query.trim().replace(/\s+/g, ' ');
  const matches = trimmed ? tags.filter((t) => t.name.toLowerCase().includes(trimmed.toLowerCase())) : tags;
  const exact = tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase());
  const canCreate = trimmed.length > 0 && !exact && createTagSchema.safeParse({ name: trimmed }).success;

  const create = useMutation({
    mutationFn: (name: string) => api.post<TagWithCount>('/tags', { name }),
    onSuccess: (tag) => {
      invalidateTags(queryClient);
      onChange([...selectedIds, tag.id]);
      setQuery('');
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function toggle(id: number) {
    setError(null);
    onChange(selectedIds.includes(id) ? selectedIds.filter((t) => t !== id) : [...selectedIds, id]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (matches.length === 1 || (matches.length > 0 && exact)) {
      const target = exact ? tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase())! : matches[0]!;
      toggle(target.id);
      setQuery('');
    } else if (canCreate) {
      create.mutate(trimmed);
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
          setError(null);
        }
      }}
    >
      <Popover.Trigger asChild disabled={disabled}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-64 rounded-lg border border-border bg-surface text-sm text-fg shadow-lg data-[state=open]:animate-pop-in"
        >
          <div className="border-b border-border p-1.5">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setError(null);
              }}
              onKeyDown={onKeyDown}
              placeholder="Find or create a tag"
              aria-label="Find or create a tag"
              aria-controls={listId}
              className="h-8 w-full rounded-md bg-transparent px-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus-visible:bg-surface-2"
              autoFocus
            />
          </div>
          <div id={listId} role="listbox" aria-multiselectable="true" aria-label="Tags" className="max-h-64 overflow-y-auto p-1">
            {isPending && <Spinner className="m-2 size-4" />}
            {!isPending && matches.length === 0 && !canCreate && (
              <p className="px-2 py-1.5 text-xs text-fg-muted">{tags.length === 0 ? 'No tags yet. Type a name to create one.' : 'No matching tags.'}</p>
            )}
            {matches.map((tag) => {
              const on = selectedIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(tag.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border',
                      on ? 'border-accent-solid bg-accent-solid text-accent-solid-fg' : 'border-border-strong',
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  <span className="text-xs text-fg-subtle tabular-nums">{tag.memberCount}</span>
                </button>
              );
            })}
            {canCreate && (
              <button
                type="button"
                onClick={() => create.mutate(trimmed)}
                disabled={create.isPending}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-accent hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
              >
                {create.isPending ? <Spinner className="size-4" /> : <Plus className="size-4" aria-hidden />}
                <span className="truncate">
                  Create “<span className="font-medium">{trimmed}</span>”
                </span>
              </button>
            )}
          </div>
          {error && <p className="border-t border-border px-3 py-2 text-xs text-danger">{error}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
