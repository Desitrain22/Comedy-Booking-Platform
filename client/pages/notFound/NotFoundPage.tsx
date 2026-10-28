import { Link } from 'react-router';
import { AuthShell } from '../../components/AuthShell';
import { buttonClasses } from '../../components/ui';

export function NotFoundPage() {
  return (
    <AuthShell title="Page not found" description="That link doesn't go anywhere. It may be mistyped or out of date.">
      <Link to="/" className={buttonClasses({ variant: 'secondary', className: 'w-full' })}>
        Go home
      </Link>
    </AuthShell>
  );
}
