/**
 * /portal/confirm/:token — F4 replaces this placeholder. Reachable without a session:
 * GET /api/portal/confirm/:token shows the week's spots; POST confirms and signs in.
 */
import { PlaceholderPage } from '../../components/PlaceholderPage';

export function ConfirmPage() {
  return (
    <PlaceholderPage
      title="Confirm your spots"
      description="This week's bookings."
      note="Review this week's spots and confirm them in one tap."
    />
  );
}
