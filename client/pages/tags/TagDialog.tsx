import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { createTagSchema, type TagWithCount } from '../../../shared/api/comedians';
import { TAG_PALETTE } from '../../../shared/types';
import { Badge, Button, Dialog, Field, Input, Label } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { invalidateTags } from '../comedians/queries';

export interface TagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this tag; omit to create one. */
  tag?: TagWithCount | null;
  /** Color for a new tag (the next palette color). */
  defaultColor?: string;
}

/** Create or rename/recolor a tag. */
export function TagDialog({ open, onOpenChange, tag, defaultColor }: TagDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tag ? 'Edit tag' : 'New tag'}
      description={tag ? undefined : 'Group comedians, then pull them into lineups by tag.'}
      size="sm"
    >
      {open && <TagForm tag={tag ?? null} defaultColor={defaultColor} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function TagForm({ tag, defaultColor, onDone }: { tag: TagWithCount | null; defaultColor?: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState<string>(tag?.color ?? defaultColor ?? TAG_PALETTE[0]);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: { name: string; color: string }) =>
      tag ? api.patch<TagWithCount>(`/tags/${tag.id}`, input) : api.post<TagWithCount>('/tags', input),
    onSuccess: (saved) => {
      invalidateTags(queryClient);
      toast.success(tag ? `Saved “${saved.name}”` : `Created “${saved.name}”`);
      onDone();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = createTagSchema.safeParse({ name, color });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the name');
      return;
    }
    save.mutate({ name: parsed.data.name, color });
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Name" error={error ?? undefined}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="e.g. Hosts, Headliners, Bullet Spots"
          autoComplete="off"
          autoFocus
        />
      </Field>
      <div className="space-y-1.5">
        <Label id="tag-color-label">Color</Label>
        <div role="radiogroup" aria-labelledby="tag-color-label" className="flex flex-wrap gap-2">
          {TAG_PALETTE.map((c) => {
            const selected = c === color;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={c}
                onClick={() => setColor(c)}
                className={cn(
                  'flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-shadow',
                  selected ? 'ring-2 ring-fg' : 'hover:ring-2 hover:ring-border-strong',
                )}
                style={{ backgroundColor: c }}
              >
                {selected && <Check className="size-4 text-white" strokeWidth={3} aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        Preview
        <Badge dotColor={color}>{name.trim() || 'Tag name'}</Badge>
      </div>
      <div className="-mx-5 -mb-4 flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {tag ? 'Save' : 'Create tag'}
        </Button>
      </div>
    </form>
  );
}
