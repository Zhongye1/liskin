import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import { Conversation } from '../features/conversation/components/Conversation';
import { EmptyState } from '../features/conversation/components/EmptyState';
import { ProviderSettings } from '../features/providers/components/ProviderSettings';
import { ErrorBoundary } from '../shared/components/ErrorBoundary';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    errorElement: <ErrorBoundary />,
    children: [
      { index: true, element: <EmptyState /> },
      {
        path: 'sessions/:sessionId',
        element: <Conversation />,
        errorElement: <ErrorBoundary />,
      },
      {
        path: 'settings',
        element: <ProviderSettings />,
      },
    ],
  },
]);
