/**
 * All client routes (spec §6). Feature pages are imported from `pages/<feature>/*Page.tsx`;
 * features replace those files, not this one.
 *
 *   /                          → /app, /portal or /portal/login (by session)
 *   /setup                     first-run wizard (only until setup is complete)
 *   /login                     booker sign-in
 *   /accept-invite/:token      invited booker sets a password
 *   /welcome#<token>           hosted mode: signed in right after sign-up → the setup guide
 *   /app                       Dashboard                (F5)   ┐
 *   /app/calendar?month        Month calendar           (F1)   │
 *   /app/shows/new?month       Create shows             (F1)   │ BookerLayout,
 *   /app/day/:date             Day view / lineups       (F2)   │ booker session
 *   /app/comedians             Roster                   (F3)   │ (else /login?next=…)
 *   /app/comedians/:id         Comedian profile         (F3)   │
 *   /app/tags                  Tags                     (F3)   │
 *   /app/settings[/:tab]       Settings                 (F6)   ┘
 *   /portal/login              comedian sign-in         (F4 polishes)
 *   /portal/magic/:token       magic-link landing       (no session needed)
 *   /portal/confirm/:token     confirm week's spots     (F4; PortalLayout, no session needed)
 *   /portal?month              Availability             (F4)   ┐ PortalLayout,
 *   /portal/spots              My spots                 (F4)   │ comedian session
 *   /portal/profile            Profile                  (F4)   ┘ (else /portal/login?next=…)
 *   /dev/month-grid            MonthGrid playground (dev builds only)
 *
 * This is a club's app: the self-hosted single club, or one club of a hosted install
 * (client/HostGate.tsx picks it; the platform site is client/platform/PlatformApp.tsx).
 */
import { Route, Routes } from 'react-router';
import { RequireBooker, RequireComedian, RootRedirect, SetupGate } from './components/guards';
import { BookerLayout } from './layouts/BookerLayout';
import { PortalLayout } from './layouts/PortalLayout';
import { AcceptInvitePage } from './pages/acceptInvite/AcceptInvitePage';
import { CalendarPage } from './pages/calendar/CalendarPage';
import { ComedianProfilePage } from './pages/comedians/ComedianProfilePage';
import { ComediansPage } from './pages/comedians/ComediansPage';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { DayPage } from './pages/day/DayPage';
import { MonthGridPlayground } from './pages/dev/MonthGridPlayground';
import { WelcomePage } from './pages/hosted/WelcomePage';
import { LoginPage } from './pages/login/LoginPage';
import { NotFoundPage } from './pages/notFound/NotFoundPage';
import { AvailabilityPage } from './pages/portal/AvailabilityPage';
import { ConfirmPage } from './pages/portal/ConfirmPage';
import { LoginPage as PortalLoginPage } from './pages/portal/LoginPage';
import { MagicPage } from './pages/portal/MagicPage';
import { ProfilePage } from './pages/portal/ProfilePage';
import { SpotsPage } from './pages/portal/SpotsPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { SetupPage } from './pages/setup/SetupPage';
import { CreateShowsPage } from './pages/shows/CreateShowsPage';
import { TagsPage } from './pages/tags/TagsPage';

export function App() {
  return (
    <Routes>
      <Route element={<SetupGate />}>
        <Route index element={<RootRedirect />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="accept-invite/:token" element={<AcceptInvitePage />} />
        <Route path="welcome" element={<WelcomePage />} />

        <Route path="app" element={<RequireBooker />}>
          <Route element={<BookerLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="shows/new" element={<CreateShowsPage />} />
            <Route path="day/:date" element={<DayPage />} />
            <Route path="comedians" element={<ComediansPage />} />
            <Route path="comedians/:id" element={<ComedianProfilePage />} />
            <Route path="tags" element={<TagsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="settings/:tab" element={<SettingsPage />} />
          </Route>
        </Route>

        <Route path="portal">
          <Route path="login" element={<PortalLoginPage />} />
          <Route path="magic/:token" element={<MagicPage />} />
          <Route element={<PortalLayout />}>
            <Route path="confirm/:token" element={<ConfirmPage />} />
            <Route element={<RequireComedian />}>
              <Route index element={<AvailabilityPage />} />
              <Route path="spots" element={<SpotsPage />} />
              <Route path="profile" element={<ProfilePage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Route>

      {import.meta.env.DEV && <Route path="dev/month-grid" element={<MonthGridPlayground />} />}
    </Routes>
  );
}
