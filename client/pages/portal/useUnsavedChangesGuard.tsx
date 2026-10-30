/**
 * Warns before unsaved portal edits are lost.
 *
 * - Closing/reloading the tab or following an external link: the browser's native
 *   "Leave site?" prompt (beforeunload).
 * - In-app navigation (the portal tabs, any same-origin link) and the layout's Sign out
 *   button: intercepted before React Router sees the click (a capture-phase click
 *   listener), and a dialog offers Save / Keep editing / Discard.
 * - Browser Back/Forward and programmatic navigation: react-router's `useBlocker` (the app
 *   runs on a data router) stops it and shows the same dialog; Discard/Save carry on.
 * - In-page actions (e.g. switching months): call `confirmLeave(action)`.
 *
 *   const guard = useUnsavedChangesGuard({ dirty, onSave: save });
 *   <Button onClick={() => guard.confirmLeave(() => setMonth(next))}>Next</Button>
 *   {guard.dialog}
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';
import { Button, Dialog } from '../../components/ui';
import { errorMessage } from '../../lib/api';

export interface UnsavedChangesGuardOptions {
  dirty: boolean;
  /** Saves the changes; rejecting keeps the user on the page (the error is shown in the dialog). */
  onSave: () => Promise<unknown>;
  title?: string;
  description?: ReactNode;
}

export interface UnsavedChangesGuard {
  /** Runs `action` now when there's nothing unsaved, else after the user saves or discards. */
  confirmLeave: (action: () => void) => void;
  /** Render this once. */
  dialog: ReactNode;
}

/** The element a click would navigate away with, if any. */
function leavingTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const link = target.closest<HTMLAnchorElement>('a[href]');
  if (link) {
    if (link.target && link.target !== '_self') return null;
    if (link.hasAttribute('download')) return null;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return null; // full navigation: beforeunload covers it
    if (url.pathname === window.location.pathname && url.search === window.location.search) return null;
    return link;
  }
  // Buttons in the app chrome (the portal header's Sign out), not in the page or a dialog.
  const button = target.closest<HTMLButtonElement>('button');
  if (button && !button.disabled && button.closest('header') && !button.closest('main, [role="dialog"]')) return button;
  return null;
}

export function useUnsavedChangesGuard({
  dirty,
  onSave,
  title = 'Save your changes?',
  description = "You have changes that haven't been saved yet.",
}: UnsavedChangesGuardOptions): UnsavedChangesGuard {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set while replaying an intercepted click, and once the user chose to leave. */
  const bypass = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Back/Forward (and navigations the click listener didn't see) to another page or month.
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current &&
      !bypass.current &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
    [],
  );
  const blocker = useBlocker(shouldBlock);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    setError(null);
    setPending(() => () => blocker.proceed());
  }, [blocker]);

  useEffect(() => {
    if (!dirty) return;
    bypass.current = false; // (re)armed whenever there are new unsaved changes
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (bypass.current) return;
      e.preventDefault();
      e.returnValue = ''; // older browsers
    }
    function onClick(e: MouseEvent) {
      if (bypass.current || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab/window: nothing is lost
      const el = leavingTarget(e.target);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      setError(null);
      setPending(() => () => {
        // The user chose to leave: replay the click, and stay out of the way while it
        // navigates (sign-out posts first, then reloads — no second "Leave site?" prompt).
        bypass.current = true;
        el.click();
      });
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const confirmLeave = useCallback(
    (action: () => void) => {
      if (!dirty) {
        action();
        return;
      }
      setError(null);
      setPending(() => action);
    },
    [dirty],
  );

  function close() {
    if (saving) return;
    setPending(null);
    // "Keep editing" after Back/Forward: stay here (the URL is already restored).
    if (blockerRef.current.state === 'blocked') blockerRef.current.reset();
  }

  function discard() {
    const action = pending;
    setPending(null);
    bypass.current = true; // the user chose to leave: don't ask again on the way out
    action?.();
  }

  async function saveAndLeave() {
    const action = pending;
    setSaving(true);
    setError(null);
    try {
      await onSave();
      setPending(null);
      bypass.current = true;
      action?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => !open && close()}
      title={title}
      description={description}
      size="sm"
      hideClose
      footer={
        <>
          <Button variant="ghost" size="lg" className="text-danger sm:mr-auto sm:h-9 sm:px-3.5 sm:text-sm" onClick={discard} disabled={saving}>
            Discard changes
          </Button>
          <Button variant="secondary" size="lg" className="sm:h-9 sm:px-3.5 sm:text-sm" onClick={close} disabled={saving}>
            Keep editing
          </Button>
          <Button size="lg" className="sm:h-9 sm:px-3.5 sm:text-sm" onClick={() => void saveAndLeave()} loading={saving} autoFocus>
            Save
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : undefined}
    </Dialog>
  );

  return { confirmLeave, dialog };
}
