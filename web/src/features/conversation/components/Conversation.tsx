import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSessionStore } from '../store/session-store';
import { TurnItem } from './TurnItem';
import { IconButton } from '../../../shared/ui/primitives';
import { IconChevronDown, IconSend, IconStop } from '../../../shared/ui/icons';

/**
 * 单个会话的对话视图。
 * sessionId 来自 URL，不再存储在 Zustand store 中。
 */
export function Conversation() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { turns, status, error, draft, selectSession, setDraft, send, interrupt } =
    useSessionStore();

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
    if (turns.length === 0) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight });
  }, [turns]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text || status === 'streaming' || !sessionId) {
      return;
    }
    void send(sessionId, text);
  };

  const items = virtualizer.getVirtualItems();
  const streaming = status === 'streaming';
  const title = turns[0]?.userContent?.slice(0, 48) ?? 'New session';

  return (
    <div className="flex h-full flex-col">
      {/* 面板标题 */}
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-medium text-ink">{title}</h1>
          <IconChevronDown size={15} className="text-ink-faint" />
        </div>
      </header>

      {/* 时间线 */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-5 py-5">
        {turns.length === 0 ? (
          <p className="text-sm text-ink-faint">输入任务开始对话…</p>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
          >
            {items.map((vi) => {
              const turn = turns[vi.index];
              if (!turn) {
                return null;
              }
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
                  className="pb-5"
                >
                  <TurnItem turn={turn} />
                </div>
              );
            })}
          </div>
        )}
        {error ? (
          <p className="mt-2 rounded-lg bg-danger/10 p-2 text-xs text-danger">
            {error.message}
          </p>
        ) : null}
      </div>

      {/* 输入栏 */}
      <div className="px-5 pb-5">
        <div className="flex items-end gap-2 rounded-xl2 border border-line bg-card p-2 shadow-composer focus-within:border-accent/50">
          <textarea
            rows={1}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply to Liskin…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={streaming}
          />
          {streaming ? (
            <IconButton
              onClick={() => {
                if (sessionId) {
                  void interrupt(sessionId);
                }
              }}
              title="停止"
              className="bg-danger/10 text-danger hover:bg-danger/20"
            >
              <IconStop size={15} />
            </IconButton>
          ) : (
            <IconButton
              onClick={handleSend}
              title="发送"
              disabled={!draft.trim()}
              className="bg-accent text-white hover:bg-accent-ink disabled:bg-line disabled:text-ink-faint"
            >
              <IconSend size={15} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}
