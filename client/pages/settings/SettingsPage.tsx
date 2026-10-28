/**
 * /app/settings (and /app/settings/:tab) — F6 replaces this placeholder with the settings
 * tabs: Club, Locations, Email, Confirmations, Bookers, Backup.
 */
import { PlaceholderPage } from '../../components/PlaceholderPage';

export function SettingsPage() {
  return (
    <PlaceholderPage
      title="Settings"
      description="Club, locations, email, confirmations, bookers and backups."
      note="Settings tabs, the email log, booker invites and database backups."
    />
  );
}
