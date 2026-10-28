import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'outline';

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-2 text-fg-muted border-transparent',
  accent: 'bg-accent-soft text-accent border-transparent',
  success: 'bg-confirmed-soft text-confirmed-fg border-transparent',
  warning: 'bg-awaiting-soft text-awaiting-fg border-transparent',
  danger: 'bg-unconfirmed-soft text-unconfirmed-fg border-transparent',
  outline: 'bg-transparent text-fg-muted border-border-strong',
};

export interface BadgeProps extends ComponentProps<'span'> {
  variant?: BadgeVariant;
  /** Hex color for a leading dot, e.g. a tag or location color. */
  dotColor?: string;
}

/** Small pill label: statuses, counts, tags (`<Badge dotColor={tag.color}>{tag.name}</Badge>`). */
export function Badge({ variant = 'neutral', dotColor, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {dotColor && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />}
      {children}
    </span>
  );
}
