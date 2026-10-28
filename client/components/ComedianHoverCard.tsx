/**
 * Hover card with a comedian's headshot, tags, bio excerpt and latest private notes.
 * Wrap any element that names a comedian (roster rows, lineup chips, pool cards):
 *
 *   <ComedianHoverCard comedianId={c.id}><span>{c.name}</span></ComedianHoverCard>
 *
 * `children` must be a single element that forwards props and ref (it becomes the Radix
 * HoverCard trigger via `asChild`; your own event handlers keep working).
 *
 * - Opens after a short hover (or on keyboard focus); never on touch.
 * - Lazily fetches `GET /api/comedians/:id/card` (key `['comedians', id, 'card']`, cached
 *   for a minute), prefetching as soon as the pointer enters so it usually opens filled.
 * - Drag-and-drop safe: no pointer capture, closes on pointer down (and on Space/Enter
 *   from the keyboard), and never opens while any pointer button is held, so dragging
 *   over other chips stays quiet. Pass `disabled` to switch it off entirely.
 */
import * as HoverCard from '@radix-ui/react-hover-card';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Archive, StickyNote } from 'lucide-react';
import { useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import type { ComedianCard } from '../../shared/api/comedians';
import { formatRelative } from '../../shared/time';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { Avatar } from './ui/Avatar';
import { Badge } from './ui/Badge';

export interface ComedianHoverCardProps {
  comedianId: number;
  children: ReactElement;
  /** Never open (the trigger still renders normally). */
  disabled?: boolean;
}

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 120;

/** `GET /api/comedians/:id/card`, cached under `['comedians', id, 'card']`. */
export function cardQuery(comedianId: number) {
  return queryOptions({
    queryKey: ['comedians', comedianId, 'card'] as const,
    queryFn: ({ signal }) => api.get<ComedianCard>(`/comedians/${comedianId}/card`, { signal }),
    staleTime: 60_000,
  });
}

// Is any pointer button held right now? Tracked once for the whole app (capture phase,
// so it sees presses before drag libraries do). Hover cards stay shut while it's true.
let pointerHeld = false;
if (typeof window !== 'undefined') {
  const release = () => {
    pointerHeld = false;
  };
  window.addEventListener('pointerdown', () => (pointerHeld = true), true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
}

export function ComedianHoverCard({ comedianId, children, disabled = false }: ComedianHoverCardProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // Set when the trigger itself is pressed (click, tap, drag start) so the focus that
  // follows doesn't pop the card; cleared by the next real hover or by blur.
  const suppressed = useRef(false);

  function handleOpenChange(next: boolean) {
    if (next && (disabled || suppressed.current || pointerHeld)) return;
    setOpen(next);
  }

  return (
    <HoverCard.Root
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
    >
      <HoverCard.Trigger
        asChild
        onPointerEnter={(e) => {
          if (e.pointerType === 'touch' || pointerHeld || disabled) return;
          suppressed.current = false;
          void queryClient.prefetchQuery(cardQuery(comedianId));
        }}
        onPointerDown={() => {
          suppressed.current = true;
          setOpen(false);
        }}
        onKeyDown={(e) => {
          // Space/Enter usually means "select" or "pick up to drag": get out of the way.
          if (e.key === ' ' || e.key === 'Enter') {
            suppressed.current = true;
            setOpen(false);
          }
        }}
        onBlur={() => {
          suppressed.current = false;
        }}
      >
        {children}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-50 w-72 overflow-hidden rounded-xl border border-border bg-surface text-left text-fg shadow-xl',
            'data-[state=open]:animate-pop-in',
          )}
        >
          <CardContent comedianId={comedianId} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function CardContent({ comedianId }: { comedianId: number }) {
  const { data: card, isError } = useQuery(cardQuery(comedianId));

  if (isError) {
    return <p className="p-4 text-sm text-fg-muted">Couldn't load this comedian.</p>;
  }
  if (!card) return <CardSkeleton />;

  return (
    <div>
      <div className="flex items-start gap-3 p-3.5 pb-3">
        <Avatar name={card.name} src={card.headshotUrl} size="lg" />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="truncate text-sm leading-tight font-semibold text-fg">{card.name}</p>
          <p className="mt-0.5 truncate text-xs text-fg-muted">{card.email}</p>
          {card.archived && (
            <Badge variant="outline" className="mt-1.5 gap-1 py-0 text-[11px]">
              <Archive className="size-3" aria-hidden /> Archived
            </Badge>
          )}
        </div>
      </div>

      {(card.tags.length > 0 || card.bio) && (
        <div className="space-y-2 px-3.5 pb-3">
          {card.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {card.tags.map((tag) => (
                <Badge key={tag.id} dotColor={tag.color} className="py-0 text-[11px]">
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}
          {card.bio && <p className="line-clamp-3 text-xs leading-relaxed text-fg-muted">{card.bio}</p>}
        </div>
      )}

      <div className="border-t border-border bg-surface-2/50 px-3.5 py-2.5">
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
          <StickyNote className="size-3" aria-hidden />
          Notes{card.noteCount > 0 && <span className="font-normal normal-case">· {card.noteCount}</span>}
        </p>
        {card.notes.length === 0 ? (
          <p className="text-xs text-fg-subtle">No notes yet.</p>
        ) : (
          <ul className="space-y-2">
            {card.notes.map((note) => (
              <li key={note.id}>
                <p className="line-clamp-3 text-xs leading-snug whitespace-pre-line text-fg">{note.body}</p>
                <p className="mt-0.5 text-[11px] text-fg-subtle">
                  {note.authorName ?? 'Former booker'} · {formatRelative(note.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link
        to={`/app/comedians/${card.id}`}
        className="flex items-center justify-between border-t border-border px-3.5 py-2 text-xs font-medium text-accent hover:bg-surface-2"
      >
        {card.noteCount > card.notes.length ? `View profile · ${card.noteCount - card.notes.length} more notes` : 'View profile'}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="animate-pulse p-3.5" aria-busy="true" aria-label="Loading">
      <div className="flex items-center gap-3">
        <div className="size-14 shrink-0 rounded-full bg-surface-3" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-2/3 rounded bg-surface-3" />
          <div className="h-2.5 w-1/2 rounded bg-surface-2" />
        </div>
      </div>
      <div className="mt-4 space-y-1.5">
        <div className="h-2.5 rounded bg-surface-2" />
        <div className="h-2.5 w-5/6 rounded bg-surface-2" />
      </div>
    </div>
  );
}
