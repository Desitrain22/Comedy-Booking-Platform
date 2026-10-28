import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { usePageTitle } from '../../lib/usePageTitle';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned buttons. */
  actions?: ReactNode;
  /** Small row above the title, e.g. a back link. */
  eyebrow?: ReactNode;
  /** Browser tab title; defaults to `title` when it is a string. */
  documentTitle?: string;
  className?: string;
}

/** Page title row; also sets the browser tab title. */
export function PageHeader({ title, description, actions, eyebrow, documentTitle, className }: PageHeaderProps) {
  usePageTitle(documentTitle ?? (typeof title === 'string' ? title : undefined));
  return (
    <header className={cn('mb-5 flex flex-wrap items-end gap-x-4 gap-y-3', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="mb-1 text-xs text-fg-muted">{eyebrow}</div>}
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
