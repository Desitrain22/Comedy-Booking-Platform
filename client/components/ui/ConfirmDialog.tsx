import { useState, type ReactNode } from 'react';
import { errorMessage } from '../../lib/api';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra content between the description and the buttons. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button (deletes, removals). */
  destructive?: boolean;
  /**
   * Called on confirm. If it returns a promise the button shows a spinner; the dialog
   * closes when it resolves and stays open (showing the error) when it rejects.
   */
  onConfirm: () => void | Promise<unknown>;
  /** Force the loading state (e.g. from a mutation's isPending). */
  loading?: boolean;
}

/**
 * "Are you sure?" dialog.
 *
 *   <ConfirmDialog open={!!pending} onOpenChange={() => setPending(null)}
 *     title={<><strong>Jason</strong> isn't available during this slot</>}
 *     description="Marked 9–11 PM for Nov 8. Book anyway?"
 *     confirmLabel="Book anyway" onConfirm={() => book({ ...pending, force: true })} />
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  loading,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isBusy = busy || Boolean(loading);

  function handleOpenChange(next: boolean) {
    if (isBusy) return;
    if (!next) setError(null);
    onOpenChange(next);
  }

  async function handleConfirm() {
    setError(null);
    const result = onConfirm();
    if (!(result instanceof Promise)) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      await result;
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={description}
      size="sm"
      hideClose
      footer={
        <>
          <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={isBusy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={() => void handleConfirm()} loading={isBusy} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {(children || error) && (
        <div className="space-y-3">
          {children}
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
