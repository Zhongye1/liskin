import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useSessionStore } from '../features/conversation/store/session-store';
import { BrowserChrome } from './components/BrowserChrome';
import { Sidebar } from './components/Sidebar';

/**
 * 应用外壳：顶部浏览器外壳 + 左侧会话栏 + 右侧 <Outlet/> 子路由。
 * 会话 ID 存在 URL 中（/sessions/:sessionId），store 不再持有 activeSessionId。
 */
export default function App() {
  const navigate = useNavigate();
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

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <BrowserChrome />
      <div className="flex min-h-0 flex-1 overflow-hidden bg-panel">
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onOpenSettings={() => navigate('/settings')}
        />
        <main className="flex min-w-0 flex-1 flex-col border-l border-line bg-panel">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
