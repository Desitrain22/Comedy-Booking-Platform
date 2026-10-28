/**
 * Booker app shell (/app/*): left nav (Dashboard, Calendar, Comedians, Tags, Settings),
 * club name, and a user menu with sign out. On narrow screens the nav becomes a top bar.
 * Pages render into the <Outlet/>; they own their width (the shell adds only padding).
 */
import {
  CalendarDays,
  ChevronsUpDown,
  ExternalLink,
  LayoutDashboard,
  LogOut,
  MicVocal,
  Settings,
  Tags,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Avatar } from '../components/ui/Avatar';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../components/ui/DropdownMenu';
import { cn } from '../lib/cn';
import { useBooker, useClub, useSignOut } from '../lib/useMe';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Extra path prefixes that highlight this item. */
  match?: string[];
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/app/calendar', label: 'Calendar', icon: CalendarDays, match: ['/app/day', '/app/shows'] },
  { to: '/app/comedians', label: 'Comedians', icon: Users },
  { to: '/app/tags', label: 'Tags', icon: Tags },
  { to: '/app/settings', label: 'Settings', icon: Settings },
];

function isActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to || pathname === `${item.to}/`;
  return [item.to, ...(item.match ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function NavLinks({ orientation }: { orientation: 'vertical' | 'horizontal' }) {
  const { pathname } = useLocation();
  return (
    <>
      {NAV.map((item) => {
        const active = isActive(item, pathname);
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-md text-sm font-medium transition-colors',
              orientation === 'vertical' ? 'h-9 px-2.5' : 'h-9 shrink-0 px-3',
              active ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

function UserMenu({ compact = false }: { compact?: boolean }) {
  const booker = useBooker();
  const signOut = useSignOut('booker');
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          'flex items-center gap-2 rounded-md text-left hover:bg-surface-2',
          compact ? 'p-1' : 'w-full px-2 py-1.5',
        )}
        aria-label="Account menu"
      >
        <Avatar name={booker.name} size="sm" />
        {!compact && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{booker.name}</span>
              <span className="block truncate text-xs text-fg-muted">{booker.role === 'admin' ? 'Admin' : 'Booker'}</span>
            </span>
            <ChevronsUpDown className="size-4 text-fg-muted" aria-hidden />
          </>
        )}
      </MenuTrigger>
      <MenuContent align={compact ? 'end' : 'start'} side={compact ? 'bottom' : 'top'} className="w-56">
        <MenuLabel>
          <span className="block truncate font-medium text-fg">{booker.name}</span>
          <span className="block truncate">{booker.email}</span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => window.open('/portal/login', '_blank', 'noopener')}>
          <ExternalLink /> Open comedian portal
        </MenuItem>
        <MenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function ClubName() {
  const club = useClub();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-solid text-accent-solid-fg">
        <MicVocal className="size-4" aria-hidden />
      </span>
      <span className="truncate text-sm font-semibold text-fg">{club?.name || 'Comedy Booking'}</span>
    </span>
  );
}

export function BookerLayout() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Sidebar (md+) */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="flex h-14 items-center px-4">
          <ClubName />
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          <NavLinks orientation="vertical" />
        </nav>
        <div className="border-t border-border p-2">
          <UserMenu />
        </div>
      </aside>

      {/* Top bar (< md) */}
      <header className="sticky top-0 z-30 border-b border-border bg-surface md:hidden">
        <div className="flex h-12 items-center justify-between gap-3 px-3">
          <ClubName />
          <UserMenu compact />
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 [scrollbar-width:none]">
          <NavLinks orientation="horizontal" />
        </nav>
      </header>

      <main className="min-w-0 flex-1 px-4 py-5 md:px-6 md:py-6">
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
