/**
 * /app/settings and /app/settings/:tab — Club, Locations, Email, Confirmations, for admins
 * Bookers and Backup, and everyone's own Account (password). The tab lives in the URL so it
 * can be linked to (e.g. "/app/settings/email" from an "email isn't set up" banner).
 */
import {
  Building2,
  CalendarClock,
  CircleUserRound,
  DatabaseBackup,
  Mail,
  MapPin,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { GuideDockSlot } from '../../components/guide';
import { Card, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui';
import { useBooker } from '../../lib/useMe';
import { AccountTab } from './AccountTab';
import { BackupTab } from './BackupTab';
import { BookersTab } from './BookersTab';
import { ClubTab } from './ClubTab';
import { ConfirmationsTab } from './ConfirmationsTab';
import { EmailTab } from './EmailTab';
import { LocationsTab } from './LocationsTab';
import { AdminOnly } from './SettingsParts';

type TabId = 'club' | 'locations' | 'email' | 'confirmations' | 'bookers' | 'backup' | 'account';

interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  render: () => ReactNode;
}

const TABS: TabDef[] = [
  { id: 'club', label: 'Club', icon: Building2, render: () => <ClubTab /> },
  { id: 'locations', label: 'Locations', icon: MapPin, render: () => <LocationsTab /> },
  { id: 'email', label: 'Email', icon: Mail, render: () => <EmailTab /> },
  { id: 'confirmations', label: 'Confirmations', icon: CalendarClock, render: () => <ConfirmationsTab /> },
  { id: 'bookers', label: 'Bookers', icon: Users, adminOnly: true, render: () => <BookersTab /> },
  { id: 'backup', label: 'Backup', icon: DatabaseBackup, adminOnly: true, render: () => <BackupTab /> },
  { id: 'account', label: 'Account', icon: CircleUserRound, render: () => <AccountTab /> },
];

export function SettingsPage() {
  const { tab = 'club' } = useParams();
  const navigate = useNavigate();
  const booker = useBooker();
  const isAdmin = booker.role === 'admin';
  const current = TABS.find((t) => t.id === tab);
  const listRef = useRef<HTMLDivElement>(null);

  // On a phone the tab strip scrolls sideways: keep the open tab (e.g. Account, last) in view.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!list || !active) return;
    const box = active.getBoundingClientRect();
    const view = list.getBoundingClientRect();
    if (box.left < view.left || box.right > view.right) {
      list.scrollLeft += box.left - view.left - (view.width - box.width) / 2;
    }
  }, [tab]);

  if (!current) return <Navigate to="/app/settings" replace />;
  const visible = TABS.filter((t) => isAdmin || !t.adminOnly || t.id === current.id);

  return (
    <div>
      <PageHeader
        title="Settings"
        documentTitle={`${current.label} · Settings`}
        description="Your club, its locations, how email is sent, who can book, and your own account."
      />
      {/* Forms read best at a moderate width, left-aligned with the page header. */}
      <Tabs className="max-w-4xl" value={current.id} onValueChange={(value) => navigate(`/app/settings/${value}`)}>
        <TabsList ref={listRef} aria-label="Settings sections">
          {visible.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon aria-hidden className="size-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* The setup guide's card while it waits on this page (Add a location, Connect email). */}
        <GuideDockSlot />
        {visible.map((t) => (
          <TabsContent key={t.id} value={t.id} className="animate-fade-in">
            {t.adminOnly && !isAdmin ? (
              <Card>
                <AdminOnly what={t.id === 'bookers' ? 'bookers' : 'backups'} />
              </Card>
            ) : (
              t.render()
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
