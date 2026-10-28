import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Rounded surface with a subtle border. Compose with CardHeader / CardBody / CardFooter. */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border border-border bg-surface shadow-xs', className)} {...props} />;
}

export interface CardHeaderProps extends Omit<ComponentProps<'div'>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions (buttons, menus). */
  actions?: ReactNode;
}

export function CardHeader({ title, description, actions, className, children, ...props }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start gap-3 border-b border-border px-4 py-3', className)} {...props}>
      <div className="min-w-0 flex-1">
        {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
        {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center justify-end gap-2 border-t border-border px-4 py-3', className)}
      {...props}
    />
  );
}
