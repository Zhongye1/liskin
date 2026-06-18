import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSessionStore } from '../store/session-store';
import { TurnItem } from '../components/turn/TurnItem';

export default function Chat() {
  const {
    sessions,
    activeSessionId,
    turns,
    status,
    error,
    draft,
    init,
    newSession,
    selectSession,
    setDraft,
    send,
    interrupt,
  } = useSessionStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void init();
  }, [init]);

  // 虚拟化：只渲染可见 turn，动态测量高度（见 §Step 3.3）
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: 4,
  });

  // 流式时持续滚到底（turns 变化即触发）
  useEffect(() => {
    if (turns.length === 0) {return;}
    const el = scrollRef.current;
    if (!el) {return;}
    el.scrollTo({ top: el.scrollHeight });
  }, [turns]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text || status === 'streaming') {return;}
    void send(text);
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      {/* 侧栏：会话列表 */}
      <aside className="w-56 shrink-0 border-r bg-white">
        <div className="flex items-center justify-between p-2">
          <span className="text-xs font-medium text-slate-500">会话</span>
          <button
            type="button"
            onClick={() => void newSession()}
            className="rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-slate-100"
          >
            + 新建
          </button>
        </div>
        <div className="space-y-0.5 overflow-auto p-1">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => void selectSession(s.id)}
              className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
                s.id === activeSessionId ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
              title={s.id}
            >
              {s.id.slice(0, 12)}…
            </button>
          ))}
        </div>
      </aside>

      {/* 主区：时间线（虚拟化）+ 输入 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-auto p-4">
          {turns.length === 0 ? (
            <p className="text-sm text-slate-400">输入任务开始对话…</p>
          ) : (
            <div
              style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
            >
              {items.map((vi) => {
                const turn = turns[vi.index];
                if (!turn) {return null;}
                return (
                  <div
                    key={turn.id}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                    className="pb-4"
                  >
                    <TurnItem turn={turn} />
                  </div>
                );
              })}
            </div>
          )}
          {error ? <p className="rounded bg-red-50 p-2 text-xs text-red-600">{error.message}</p> : null}
        </div>

        <div className="border-t bg-white p-3">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border px-3 py-2 text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="例如：读 README.md 并总结要点"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={status === 'streaming'}
            />
            {status === 'streaming' ? (
              <button
                type="button"
                onClick={() => void interrupt()}
                className="rounded-md border px-4 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                停止
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
