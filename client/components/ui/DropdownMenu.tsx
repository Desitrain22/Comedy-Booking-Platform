import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

/**
 * Dropdown menu (Radix):
 *
 *   <Menu>
 *     <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Show menu"><Ellipsis /></Button></MenuTrigger>
 *     <MenuContent align="end">
 *       <MenuItem onSelect={…}><Pencil /> Edit show</MenuItem>
 *       <MenuSeparator />
 *       <MenuItem destructive onSelect={…}>Delete</MenuItem>
 *     </MenuContent>
 *   </Menu>
 */
export const Menu = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;
export const MenuGroup = RadixMenu.Group;

export function MenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof RadixMenu.Content>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-44 rounded-lg border border-border bg-surface p-1 text-sm text-fg shadow-lg',
          'data-[state=open]:animate-pop-in',
          className,
        )}
        {...props}
      />
    </RadixMenu.Portal>
  );
}

export interface MenuItemProps extends ComponentProps<typeof RadixMenu.Item> {
  destructive?: boolean;
}

export function MenuItem({ className, destructive, ...props }: MenuItemProps) {
  return (
    <RadixMenu.Item
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none [&_svg]:size-4 [&_svg]:text-fg-muted',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2',
        destructive && 'text-danger [&_svg]:text-danger',
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof RadixMenu.Label>) {
  return <RadixMenu.Label className={cn('px-2 py-1.5 text-xs text-fg-muted', className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof RadixMenu.Separator>) {
  return <RadixMenu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
