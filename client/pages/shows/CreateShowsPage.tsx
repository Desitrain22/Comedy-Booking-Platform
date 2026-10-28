/** /app/shows/new?month=YYYY-MM — F1 replaces this placeholder with the create-shows painter. */
import { PlaceholderPage } from '../../components/PlaceholderPage';

export function CreateShowsPage() {
  return (
    <PlaceholderPage
      title="Create shows"
      description="Paint dates on the calendar to add a run of shows."
      note="Pick a location, time and slot count, then click or drag across days."
    />
  );
}
