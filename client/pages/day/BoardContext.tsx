/**
 * Shared state for the lineup board's pieces (show cards, slots, chips, pool cards), so the
 * page wires drag-and-drop and click-to-place once and the leaves just ask.
 *
 * Two contexts, so picking something up doesn't re-render the whole board (UX D18):
 * - `useBoard()`: the day's data and the actions. Changes only when the data does; the
 *   actions are stable (they read the latest state when called).
 * - `useBoardLive()`: what is dragged / selected / focused. Changes on every pickup and click;
 *   read it high up (or in tiny components) and hand memoized leaves plain props.
 * - `useBoardActions()`: just the actions (never changes).
 */
import { createContext, useContext } from 'react';
import type { DayResponse } from '../../../shared/api/lineup';
import type { DayIndex, DropPlan, LineupSource, LineupTarget } from './lineupModel';

/** Click-to-place: pick a comedian or booked chip, or an empty (or declined) slot first. */
export type Selection = LineupSource | { kind: 'slot'; showId: number; position: number };

export interface BoardActions {
  clickComedian: (comedianId: number) => void;
  clickBooking: (bookingId: number) => void;
  clickSlot: (showId: number, position: number) => void;
  unbook: (bookingId: number) => void;
  setSlotCount: (showId: number, slotCount: number) => void;
  copyLineup: (showId: number) => void;
  /** Select the show's first open (or declined) slot, so the pool shows who fits its time. */
  focusShow: (showId: number) => void;
}

export interface BoardData {
  day: DayResponse;
  index: DayIndex;
  actions: BoardActions;
}

export interface BoardLive {
  /** What is being dragged right now. */
  dragging: LineupSource | null;
  selection: Selection | null;
  /** The comedian being dragged or selected (show cards show how they fit). */
  focusComedianId: number | null;
  /** The show whose slot is selected (pool cards show how each comedian fits its time). */
  focusShowId: number | null;
  /** What dropping the current drag on `target` would do. */
  preview: (target: LineupTarget) => DropPlan;
}

export const BoardContext = createContext<BoardData | null>(null);
export const BoardLiveContext = createContext<BoardLive | null>(null);
/** The actions alone: never changes, so memoized leaves that only act can use it freely. */
export const BoardActionsContext = createContext<BoardActions | null>(null);

export function useBoard(): BoardData {
  const board = useContext(BoardContext);
  if (!board) throw new Error('useBoard() outside the lineup board');
  return board;
}

export function useBoardLive(): BoardLive {
  const live = useContext(BoardLiveContext);
  if (!live) throw new Error('useBoardLive() outside the lineup board');
  return live;
}

export function useBoardActions(): BoardActions {
  const actions = useContext(BoardActionsContext);
  if (!actions) throw new Error('useBoardActions() outside the lineup board');
  return actions;
}

export function isSelected(selection: Selection | null, source: Selection): boolean {
  if (!selection || selection.kind !== source.kind) return false;
  switch (source.kind) {
    case 'comedian':
      return selection.kind === 'comedian' && selection.comedianId === source.comedianId;
    case 'booking':
      return selection.kind === 'booking' && selection.bookingId === source.bookingId;
    case 'slot':
      return selection.kind === 'slot' && selection.showId === source.showId && selection.position === source.position;
  }
}
