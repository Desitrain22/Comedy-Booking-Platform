/** /app/comedians/:id — F3 replaces this placeholder with the comedian profile. */
import { useParams } from 'react-router';
import { PlaceholderPage } from '../../components/PlaceholderPage';

export function ComedianProfilePage() {
  const { id } = useParams();
  return (
    <PlaceholderPage
      title="Comedian"
      description={`Profile #${id ?? '?'}`}
      note="Profile, tags, private notes, availability and upcoming spots."
    />
  );
}
