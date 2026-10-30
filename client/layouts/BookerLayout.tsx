/**
 * Booker app shell (/app/*): left nav (Dashboard, Calendar, Comedians, Tags, Settings),
 * club name, and a user menu with sign out. On narrow screens the nav becomes a top bar.
 *
 * Page container (one rule for every booker page): pages render into a container with the
 * same left edge (the shell's padding) and the same max width (`max-w-7xl`), left-aligned
 * so the edge never moves between pages. Pages don't set their own width or center
 * themselves (a page root's own `mx-*`/`max-w-*` are neutralized). A full-width page (the
 * day board) keeps the left edge but drops the max width by putting `FULL_WIDTH_PAGE` on its
 * root element: `<div {...FULL_WIDTH_PAGE}>`.
 *
 * Setup guide (client/components/guide): the provider wraps the shell, its progress rail sits
 * across the top while it runs (the sticky sidebar / phone header move down by
 * `--guide-rail-h`), and its overlay renders once. Nav items and the user menu carry the
 * `data-guide` ids the guide points at (`nav-dashboard` … `nav-settings`, `user-menu`); the
 * user menu's **Setup guide** (or **Welcome tour**) reopens it.
 */
import {
  CalendarDays,
  ChevronsUpDown,
  Compass,
  ExternalLink,
  LayoutDashboard,
  LogOut,
  MicVocal,
  Settings,
  Tags,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  GUIDE_RAIL_HEIGHT,
  GuideOverlay,
  GuideProvider,
  GuideRail,
  useGuide,
  useGuideRailVisible,
} from '../components/guide';
import { Avatar } from '../components/ui/Avatar';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../components/ui/DropdownMenu';
import { cn } from '../lib/cn';
import { useBooker, useClub, useSignOut } from '../lib/useMe';

interface NavItem {
  to: string;
  label: string;
  /** `data-guide` id (setup guide / welcome tour target). */
  guide: string;
  icon: LucideIcon;
  /** Extra path prefixes that highlight this item. */
  match?: string[];
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/app', label: 'Dashboard', guide: 'nav-dashboard', icon: LayoutDashboard, end: true },
  { to: '/app/calendar', label: 'Calendar', guide: 'nav-calendar', icon: CalendarDays, match: ['/app/day', '/app/shows'] },
  { to: '/app/comedians', label: 'Comedians', guide: 'nav-comedians', icon: Users },
  { to: '/app/tags', label: 'Tags', guide: 'nav-tags', icon: Tags },
  { to: '/app/settings', label: 'Settings', guide: 'nav-settings', icon: Settings },
];

/**
 * Spread on a page's root element to opt out of the container's max width (same left edge,
 * full width): `<div {...FULL_WIDTH_PAGE}>…</div>`.
 */
export const FULL_WIDTH_PAGE = { 'data-page-width': 'full' } as const;

/**
 * The shared page container. `has-[…]` drops the max width for a FULL_WIDTH_PAGE root; the
 * `[&>*]` rules make sure a page root never re-centers or narrows itself.
 */
const PAGE_CONTAINER =
  'w-full max-w-7xl has-[>[data-page-width=full]]:max-w-none [&>*]:mx-0! [&>*]:w-full [&>*]:max-w-none!';

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
            data-guide={item.guide}
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
  const guide = useGuide();
  return (
    <Menu>
      <MenuTrigger
        data-guide="user-menu"
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
        {guide?.data && (
          <MenuItem onSelect={guide.start}>
            <Compass /> {guide.mode === 'tour' ? 'Welcome tour' : 'Setup guide'}
          </MenuItem>
        )}
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
  return (
    <GuideProvider>
      <BookerShell />
      <GuideOverlay />
    </GuideProvider>
  );
}

function BookerShell() {
  const { pathname } = useLocation();
  const railVisible = useGuideRailVisible();
  const railHeight = { '--guide-rail-h': `${railVisible ? GUIDE_RAIL_HEIGHT : 0}px` } as CSSProperties;
  return (
    <div className="flex min-h-dvh flex-col" style={railHeight}>
      <GuideRail />
      <div className="flex flex-1 flex-col md:flex-row">
        {/* Sidebar (md+) */}
        <aside className="sticky top-(--guide-rail-h) hidden h-[calc(100dvh-var(--guide-rail-h))] w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
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
        <header
          data-guide-chrome=""
          className="sticky top-(--guide-rail-h) z-30 border-b border-border bg-surface md:hidden"
        >
          <div className="flex h-12 items-center justify-between gap-3 px-3">
            <ClubName />
            <UserMenu compact />
          </div>
          <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 [scrollbar-width:none]">
            <NavLinks orientation="horizontal" />
          </nav>
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 md:px-6 md:py-6">
          <div className={PAGE_CONTAINER}>
            <ErrorBoundary resetKey={pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
          {/* Room for the guide's bottom sheet on phones, so the page's end stays reachable. */}
          <div aria-hidden style={{ height: 'var(--guide-sheet-h, 0px)' }} />
        </main>
      </div>
    </div>
  );
}
