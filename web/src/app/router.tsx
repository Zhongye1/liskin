import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import { Conversation } from '../features/conversation/components/Conversation';
import { EmptyState } from '../features/conversation/components/EmptyState';
import { ProviderSettings } from '../features/providers/components/ProviderSettings';
import { UiPreview } from '../features/preview/UiPreview';
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
  // 独立全屏预览页：用 mock 数据走查新 UI，不挂在 App 外壳下
  {
    path: '/ui-preview',
    element: <UiPreview />,
    errorElement: <ErrorBoundary />,
  },
]);
