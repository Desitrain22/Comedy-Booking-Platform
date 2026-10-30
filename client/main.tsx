// First: configures zod before any schema is built (CSP-safe, see the file).
import './lib/zodConfig';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { HostGate } from './HostGate';
import { queryClient } from './lib/queryClient';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// HostGate asks the server what this host is (a club, or in hosted mode the platform site), then
// renders that app in a data router, so pages can block navigation (`useBlocker`: the portal's
// unsaved-changes guard also catches Back/Forward). One splat route renders its <Routes>.

/** Sonner's phone layout (full-width toasts) kicks in at this width. */
const PHONE_QUERY = '(max-width: 600px)';

function subscribePhone(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Toasts: top-center on wider screens; on phones bottom-center, so they don't cover the
 * header and tabs. A page with a sticky bottom bar (portal Availability) sets
 * `--toast-bottom-offset` to stay clear of it.
 */
function AppToaster() {
  const phone = useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches);
  return (
    <Toaster
      position={phone ? 'bottom-center' : 'top-center'}
      mobileOffset={{ bottom: 'var(--toast-bottom-offset, max(16px, env(safe-area-inset-bottom)))' }}
      theme="system"
      richColors
      closeButton
    />
  );
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HostGate />
      <AppToaster />
    </QueryClientProvider>
  </StrictMode>,
);
