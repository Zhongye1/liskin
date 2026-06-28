import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useSessionStore } from '../pages/Chats/model/session-store';
import { Sidebar_Chat } from './components/Sidebar_Chat';
import { Sidebar_Router } from './components/Sidebar_Router';
import { HeadBar_Top } from './components/HeadBar_Top';
import { useWipeNavigate } from './hooks/useWipeNavigate';
import './wipe.css';

export default function App() {
  const navigate = useNavigate();
  const wipeNavigate = useWipeNavigate();
  const location = useLocation();
  const { sessionId: activeSessionId } = useParams<{ sessionId: string }>();
  const { sessions, newSession, init } = useSessionStore();

  useEffect(() => {
    void init();
  }, [init]);

  const handleNewSession = () => {
    newSession()
      .then((id) => {
        if (id) {navigate(`/sessions/${id}`);}
      })
      .catch(() => {});
  };

  const handleSelectSession = (id: string) => navigate(`/sessions/${id}`);

  const isChatSection = location.pathname === '/' || location.pathname.startsWith('/sessions/');

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <HeadBar_Top onSettingsClick={() => wipeNavigate('/settings')} />
      <div className="flex min-h-0 flex-1 overflow-hidden bg-panel">
        {/* Sidebar_Router 始终静止，不参与擦除 */}
        <Sidebar_Router />
        {/* stage 包裹 Sidebar_Chat + main 作为一个整体拍快照、一起擦除 */}
        <div className="stage flex min-w-0 flex-1 overflow-hidden">
          {isChatSection && (
            <Sidebar_Chat
              sessions={sessions}
              activeSessionId={activeSessionId}
              onNewSession={handleNewSession}
              onSelectSession={handleSelectSession}
              onOpenSettings={() => wipeNavigate('/settings')}
            />
          )}
          <main className="flex min-w-0 flex-1 flex-col border-l border-line bg-panel overflow-hidden">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
