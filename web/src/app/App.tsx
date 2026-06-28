import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useSessionStore } from '../pages/Chats/model/session-store';
import { Sidebar_Chat } from './components/Sidebar_Chat';
import { Sidebar_Router } from './components/Sidebar_Router';

/**
 * 应用外壳：Sidebar_Router（常驻） + section 侧栏（按路由切换） + <Outlet/>。
 * 会话 ID 存在 URL 中（/sessions/:sessionId），store 不再持有 activeSessionId。
 */
export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId: activeSessionId } = useParams<{ sessionId: string }>();
  const { sessions, newSession, init } = useSessionStore();

  useEffect(() => {
    void init();
  }, [init]);

  const handleNewSession = () => {
    newSession()
      .then((id) => {
        if (id) {
          navigate(`/sessions/${id}`);
        }
      })
      .catch(() => {
        // newSession 内部已处理错误
      });
  };

  const handleSelectSession = (id: string) => {
    navigate(`/sessions/${id}`);
  };

  // 仅"会话" section 显示 Sidebar_Chat
  const isChatSection = location.pathname === '/' || location.pathname.startsWith('/sessions/');

  return (
    <div className="flex h-screen flex-col bg-canvas">
      {/* <BrowserChrome /> */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-panel">
        <Sidebar_Router />
        {isChatSection && (
          <Sidebar_Chat
            sessions={sessions}
            activeSessionId={activeSessionId}
            onNewSession={handleNewSession}
            onSelectSession={handleSelectSession}
            onOpenSettings={() => navigate('/settings')}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col border-l border-line bg-panel">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
