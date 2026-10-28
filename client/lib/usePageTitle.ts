import { useEffect } from 'react';
import { useClub } from './useMe';

/** Sets `document.title` to "<title> · <club name>" while the component is mounted. */
export function usePageTitle(title: string | undefined): void {
  const clubName = useClub()?.name;
  useEffect(() => {
    const parts = [title, clubName || 'Comedy Booking'].filter(Boolean);
    document.title = parts.join(' · ');
  }, [title, clubName]);
}
