import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSessionStore } from '../store/session-store';
import { TurnItem } from './TurnItem';

/**
 * 单个会话的对话视图。
 * sessionId 来自 URL，不再存储在 Zustand store 中。
 */
export function Conversation() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const {
    turns,
    status,
    error,
    draft,
    selectSession,
    setDraft,
    send,
    interrupt,
  } = useSessionStore();

  // sessionId 变化时加载会话历史
  useEffect(() => {
    if (sessionId) {
      void selectSession(sessionId);
    }
  }, [sessionId, selectSession]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: 4,
  });

  useEffect(() => {
    if (turns.length === 0) {return;}
    const el = scrollRef.current;
    if (!el) {return;}
    el.scrollTo({ top: el.scrollHeight });
  }, [turns]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text || status === 'streaming' || !sessionId) {return;}
    void send(sessionId, text);
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full flex-col">
      {/* 时间线 */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-4">
        {turns.length === 0 ? (
          <p className="text-sm text-slate-400">输入任务开始对话…</p>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
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
        {error ? (
          <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-600">
            {error.message}
          </p>
        ) : null}
      </div>

      {/* 输入栏 */}
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
              onClick={() => {
                if (sessionId) {void interrupt(sessionId);}
              }}
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
  );
}
