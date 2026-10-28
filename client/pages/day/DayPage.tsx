/** /app/day/:date — F2 replaces this placeholder with the lineup board. */
import { useParams } from 'react-router';
import { formatDateLong, isValidDate } from '../../../shared/time';
import { PlaceholderPage } from '../../components/PlaceholderPage';

export function DayPage() {
  const { date = '' } = useParams();
  return (
    <PlaceholderPage
      title={isValidDate(date) ? formatDateLong(date) : 'Day'}
      description="Every show on this date, with its lineup."
      note="Drag comedians from the pool into slots to build each lineup."
    />
  );
}
