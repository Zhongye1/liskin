import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import { Conversation } from '../pages/Chats/Conversation';
import { EmptyState } from '../pages/Chats/EmptyState';
import { SettingsPage } from '../pages/settings/SettingsPage';
import { ProjectsPage } from '../pages/Projects/ProjectsPage';
import { KnowledgePage } from '../pages/KnowledgeBase/KnowledgePage';
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
        element: <SettingsPage />,
      },
      {
        path: 'projects',
        element: <ProjectsPage />,
      },
      {
        path: 'knowledge',
        element: <KnowledgePage />,
      },
    ],
  },
]);
