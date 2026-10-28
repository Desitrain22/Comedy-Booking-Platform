/**
 * Show pills for month grids: `7:30 · Cellar · 5/7` tinted in the location color.
 *
 * - `<ShowPill show onClick>`: a button (calendar → opens the edit dialog). A red dot
 *   marks unconfirmed comedians tonight; cancelled shows are struck through.
 * - `<ShowPill show>` without onClick: a static pill (create-shows painter context).
 * - `<NewShowPill>`: the accent preview of a show about to be created.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { ShowDto } from '../../../shared/api/shows';
import { formatTimeShort } from '../../../shared/time';
import { cn } from '../../lib/cn';
import { pillAriaLabel, shortLocationName } from './showFormat';

/** Soft background + solid left bar in a location's color (works in light and dark). */
export function locationTint(color: string): CSSProperties {
  return { backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`, borderLeftColor: color };
}

const PILL =
  'flex w-full min-w-0 items-center gap-1 rounded-[5px] border-l-[3px] px-1.5 py-px text-left text-[11px] leading-4 text-fg';

/**
 * Full pills read "7:30 · Cellar · 5/7", compact ones "7:30 Cellar". The pill is a size
 * container: when a narrow calendar leaves no room, the location name drops out
 * ("7:30 · 5/7" / "7:30") so the time and fill count stay readable; the color, title and
 * aria-label still say where it is.
 */
function PillText({ show, compact }: { show: ShowDto; compact: boolean }) {
  const time = <span className="font-semibold tabular-nums">{formatTimeShort(show.startMin)}</span>;
  if (compact) {
    return (
      <span className="min-w-0 flex-1 truncate">
        {time}
        <span className="hidden @[4.5rem]:inline"> {shortLocationName(show.location.name)}</span>
      </span>
    );
  }
  return (
    <span className="min-w-0 flex-1 truncate">
      {time}
      <span className="hidden @[6.75rem]:inline">
        <span className="text-fg-muted"> · </span>
        {shortLocationName(show.location.name)}
      </span>
      <span className="text-fg-muted"> · </span>
      <span className="tabular-nums">
        {show.bookedCount}/{show.slotCount}
      </span>
    </span>
  );
}

export interface ShowPillProps {
  show: ShowDto;
  onClick?: (show: ShowDto) => void;
  /** Time + location only ("7:30 Cellar"), for the create-shows painter. */
  compact?: boolean;
  className?: string;
}

export function ShowPill({ show, onClick, compact = false, className }: ShowPillProps) {
  const cancelled = show.status === 'cancelled';
  const content: ReactNode = (
    <>
      <PillText show={show} compact={compact} />
      {show.unconfirmedTodayCount > 0 && (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-unconfirmed ring-2 ring-unconfirmed/25" />
      )}
    </>
  );
  const classes = cn(
    PILL,
    '@container',
    cancelled && 'bg-surface-2 text-fg-muted line-through decoration-fg-muted/80',
    className,
  );
  const style = cancelled
    ? { borderLeftColor: `color-mix(in oklab, ${show.location.color} 45%, transparent)` }
    : locationTint(show.location.color);
  const title = `${show.name ? `${show.name} · ` : ''}${show.location.name}${cancelled ? ' · Cancelled' : ''}`;

  if (!onClick) {
    return (
      <span className={classes} style={style} title={title}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onClick(show)}
      aria-label={pillAriaLabel({ ...show, locationName: show.location.name })}
      title={title}
      className={cn(classes, 'transition-[filter] hover:brightness-95 focus-visible:outline-offset-1 dark:hover:brightness-125')}
      style={style}
    >
      {content}
    </button>
  );
}

export interface NewShowPillProps {
  startMin: number;
  locationName: string;
  /** A scheduled show already exists here: it will be skipped. */
  duplicate?: boolean;
}

export function NewShowPill({ startMin, locationName, duplicate = false }: NewShowPillProps) {
  return (
    <span
      className={cn(
        '@container flex w-full min-w-0 items-center gap-1 rounded-[5px] px-1.5 py-px text-[11px] leading-4 font-medium',
        duplicate
          ? 'border border-dashed border-accent/60 text-fg-muted'
          : 'bg-accent-solid text-accent-solid-fg shadow-xs',
      )}
      title={duplicate ? 'Already scheduled: will be skipped' : 'Will be created'}
    >
      <span className="min-w-0 flex-1 truncate">
        {duplicate ? <span className="hidden @[5.5rem]:inline">exists </span> : '+ '}
        <span className="tabular-nums">{formatTimeShort(startMin)}</span>
        <span className="hidden @[4.5rem]:inline"> {shortLocationName(locationName)}</span>
      </span>
    </span>
  );
}
