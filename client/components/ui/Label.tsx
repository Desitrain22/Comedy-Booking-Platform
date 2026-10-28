import { cloneElement, isValidElement, useId, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('block text-[13px] font-medium text-fg', className)} {...props} />;
}

export interface FieldProps {
  label: ReactNode;
  /** A single control (Input, Select, Textarea…). It gets `id`, `aria-describedby`, `invalid`. */
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; invalid?: boolean }>;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error text under the control (also marks the control invalid). */
  error?: ReactNode;
  className?: string;
  /** Optional element on the right of the label row (e.g. a "Forgot?" link). */
  aside?: ReactNode;
}

/**
 * Label + control + hint/error, wired for accessibility:
 *
 *   <Field label="Email" error={errors.email}><Input type="email" value={…} onChange={…} /></Field>
 */
export function Field({ label, children, hint, error, className, aside }: FieldProps) {
  const autoId = useId();
  const id = (isValidElement(children) && children.props.id) || autoId;
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {aside}
      </div>
      {cloneElement(children, { id, 'aria-describedby': describedBy, invalid: Boolean(error) || undefined })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
