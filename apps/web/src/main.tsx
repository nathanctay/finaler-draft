import '@fontsource/courier-prime/latin-400.css';
import '@fontsource/courier-prime/latin-700.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen.js';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const router = createRouter({ context: { queryClient }, defaultPreload: 'intent', routeTree });

const root = document.getElementById('root');

if (!root) {
  throw new Error('Application root was not found.');
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
