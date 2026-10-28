import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { controlClasses } from './Input';

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends ComponentProps<'select'> {
  /** Convenience: render these options (in addition to any children). */
  options?: readonly SelectOption[];
  invalid?: boolean;
  /** Classes for the wrapper (width etc.); `className` styles the <select> itself. */
  wrapperClassName?: string;
}

/**
 * A styled native <select> (best on mobile, accessible, works with forms).
 * Values are strings in the DOM: convert with Number(e.target.value) for numeric options.
 */
export function Select({ options, invalid, className, wrapperClassName, children, ...props }: SelectProps) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <select
        aria-invalid={invalid || undefined}
        className={cn(controlClasses, 'h-9 appearance-none pr-8', className)}
        {...props}
      >
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-muted"
      />
    </div>
  );
}
