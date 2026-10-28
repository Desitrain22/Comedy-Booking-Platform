/** /app/calendar?month=YYYY-MM — F1 replaces this placeholder with the month calendar. */
import { useSearchParams } from 'react-router';
import { isValidMonth, formatMonthLong } from '../../../shared/time';
import { PlaceholderPage } from '../../components/PlaceholderPage';

export function CalendarPage() {
  const [params] = useSearchParams();
  const month = params.get('month');
  return (
    <PlaceholderPage
      title="Calendar"
      description={month && isValidMonth(month) ? formatMonthLong(month) : 'Shows across all locations.'}
      note="A month of shows across all locations, with location filters and a link to create shows."
    />
  );
}
