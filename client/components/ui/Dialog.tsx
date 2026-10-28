import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Short text under the title (also the accessible description). */
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row at the bottom (use <DialogFooter> inside children for custom layouts). */
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** Optional element that opens the dialog (rendered as the Radix trigger via asChild). */
  trigger?: ReactNode;
  className?: string;
  /** Hide the × button (e.g. while a request is in flight). */
  hideClose?: boolean;
}

/**
 * Modal dialog (Radix): focus trap, Esc/overlay to close, scrolls when tall.
 *
 *   <Dialog open={open} onOpenChange={setOpen} title="Edit show"
 *     footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button>Save</Button></>}>
 *     …form fields…
 *   </Dialog>
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  trigger,
  className,
  hideClose,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-zinc-950/40 data-[state=open]:animate-fade-in" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
          <RadixDialog.Content
            className={cn(
              'pointer-events-auto flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-xl sm:rounded-xl',
              'data-[state=open]:animate-pop-in',
              SIZES[size],
              className,
            )}
            // Without a description, tell Radix there is intentionally none.
            {...(description ? {} : { 'aria-describedby': undefined })}
          >
            <div className="flex items-start gap-3 px-5 pt-5 pb-3">
              <div className="min-w-0 flex-1">
                <RadixDialog.Title className="text-base font-semibold text-fg">{title}</RadixDialog.Title>
                {description && (
                  <RadixDialog.Description className="mt-1 text-sm text-fg-muted">{description}</RadixDialog.Description>
                )}
              </div>
              {!hideClose && (
                <RadixDialog.Close
                  className="-mt-1 -mr-1 rounded-md p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </RadixDialog.Close>
              )}
            </div>
            {children !== undefined && <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>}
            {footer && <DialogFooter>{footer}</DialogFooter>}
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Right-aligned action row with a top border; stacks full-width on phones. */
export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-end',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Closes the surrounding Dialog when its child is clicked: <DialogClose asChild><Button>…</Button></DialogClose> */
export const DialogClose = RadixDialog.Close;
