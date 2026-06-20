import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useSessionStore } from '../features/conversation/store/session-store';

/**
 * 两栏 shell：左侧会话列表常驻，右侧通过 <Outlet /> 渲染子路由。
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
    newSession().then((id) => {
      if (id) {navigate(`/sessions/${id}`);}
    }).catch(() => {
      // newSession 内部已处理错误
    });
  };

  const handleSelectSession = (id: string) => {
    navigate(`/sessions/${id}`);
  };

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900">
      {/* 侧栏：会话列表 */}
      <aside className="flex w-56 shrink-0 flex-col border-r bg-white">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Liskin</span>
          <button
            type="button"
            onClick={handleNewSession}
            className="rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-slate-100"
          >
            + 新建
          </button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-auto p-1">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => handleSelectSession(s.id)}
              className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
                s.id === activeSessionId
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              title={s.id}
            >
              {s.id.slice(0, 12)}…
            </button>
          ))}
        </div>
        <div className="border-t p-2">
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="w-full rounded px-2 py-1 text-left text-xs text-slate-500 hover:bg-slate-100"
          >
            设置
          </button>
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
