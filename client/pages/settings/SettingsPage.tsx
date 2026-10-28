/**
 * /app/settings and /app/settings/:tab — Club, Locations, Email, Confirmations, and for
 * admins Bookers and Backup. The tab lives in the URL so it can be linked to
 * (e.g. "/app/settings/email" from an "email isn't set up" banner).
 */
import { Building2, CalendarClock, DatabaseBackup, Mail, MapPin, Users, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Card, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui';
import { useBooker } from '../../lib/useMe';
import { BackupTab } from './BackupTab';
import { BookersTab } from './BookersTab';
import { ClubTab } from './ClubTab';
import { ConfirmationsTab } from './ConfirmationsTab';
import { EmailTab } from './EmailTab';
import { LocationsTab } from './LocationsTab';
import { AdminOnly } from './SettingsParts';

type TabId = 'club' | 'locations' | 'email' | 'confirmations' | 'bookers' | 'backup';

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
];

export function SettingsPage() {
  const { tab = 'club' } = useParams();
  const navigate = useNavigate();
  const booker = useBooker();
  const isAdmin = booker.role === 'admin';
  const current = TABS.find((t) => t.id === tab);

  if (!current) return <Navigate to="/app/settings" replace />;
  const visible = TABS.filter((t) => isAdmin || !t.adminOnly || t.id === current.id);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Settings"
        documentTitle={`${current.label} · Settings`}
        description="Your club, its locations, how email is sent, and who can book."
      />
      <Tabs value={current.id} onValueChange={(value) => navigate(`/app/settings/${value}`)}>
        <TabsList aria-label="Settings sections">
          {visible.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              <t.icon aria-hidden className="size-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
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
