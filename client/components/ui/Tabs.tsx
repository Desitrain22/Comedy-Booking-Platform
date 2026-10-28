import * as RadixTabs from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

/**
 * Underlined tabs (Radix). Controlled or uncontrolled:
 *
 *   <Tabs value={tab} onValueChange={setTab}>
 *     <TabsList><TabsTrigger value="club">Club</TabsTrigger>…</TabsList>
 *     <TabsContent value="club">…</TabsContent>
 *   </Tabs>
 */
export function Tabs({ className, ...props }: ComponentProps<typeof RadixTabs.Root>) {
  return <RadixTabs.Root className={cn('flex flex-col gap-4', className)} {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cn('flex gap-5 overflow-x-auto border-b border-border [scrollbar-width:none]', className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        '-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 border-transparent px-0.5 text-sm font-medium whitespace-nowrap text-fg-muted',
        'transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn('focus-visible:outline-none', className)} {...props} />;
}
