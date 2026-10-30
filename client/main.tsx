import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Toaster } from 'sonner';
import { App } from './App';
import { queryClient } from './lib/queryClient';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// A data router, so pages can block navigation (`useBlocker`: the portal's unsaved-changes
// guard also catches Back/Forward). One splat route renders App's declarative <Routes>.
const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-center" theme="system" richColors closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
