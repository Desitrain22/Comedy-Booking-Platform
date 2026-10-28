import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';
import { controlClasses } from './Input';

export interface TextareaProps extends ComponentProps<'textarea'> {
  invalid?: boolean;
}

export function Textarea({ className, invalid, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(controlClasses, 'min-h-20 resize-y py-2 leading-relaxed', className)}
      {...props}
    />
  );
}
