import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

/**
 * Shared look for text-like controls. 16px text on phones (prevents iOS zoom-on-focus),
 * 14px from `sm` up.
 */
export const controlClasses = cn(
  'w-full rounded-lg border border-border-strong bg-surface px-3 text-base text-fg shadow-xs sm:text-sm',
  'placeholder:text-fg-subtle transition-colors',
  'focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/30',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70',
  'aria-invalid:border-danger aria-invalid:focus-visible:outline-danger/30',
);

export interface InputProps extends ComponentProps<'input'> {
  /** Red border + aria-invalid. */
  invalid?: boolean;
}

export function Input({ className, invalid, ...props }: InputProps) {
  return <input aria-invalid={invalid || undefined} className={cn(controlClasses, 'h-9', className)} {...props} />;
}
