import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import Home from './pages/Home';
import Chat from './pages/Chat';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'chat', element: <Chat /> }
    ]
  }
]);
