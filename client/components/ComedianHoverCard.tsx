/**
 * Hover card with a comedian's headshot, tags, bio excerpt and latest notes.
 *
 * FOUNDATION STUB: renders `children` unchanged. F3 replaces the implementation (Radix
 * HoverCard, lazy `GET /api/comedians/:id/card`) keeping this exact signature, so other
 * features can wrap comedian names/chips with it today:
 *
 *   <ComedianHoverCard comedianId={c.id}><span>{c.name}</span></ComedianHoverCard>
 *
 * Pass a single element that forwards props/ref (it will become the HoverCard trigger
 * via `asChild`).
 */
import type { ReactElement } from 'react';

export interface ComedianHoverCardProps {
  comedianId: number;
  children: ReactElement;
}

export function ComedianHoverCard({ children }: ComedianHoverCardProps) {
  return children;
}
