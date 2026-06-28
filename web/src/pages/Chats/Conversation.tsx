import { useParams } from 'react-router-dom';
import { useConversationViewModel } from './useConversationViewModel';
import { TurnItem } from './components/TurnItem';
import { IconButton } from '../../shared/ui/primitives';
import { ChevronDown, Send, Square } from 'lucide-react';

/**
 * 会话对话视图 — 纯 View 层。
 * 所有状态 / 逻辑 / 副作用由 useConversationViewModel 提供，
 * 本组件只负责渲染 JSX。
 */
export function Conversation() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const vm = useConversationViewModel(sessionId);

  return (
    <div className="flex h-full flex-col">
      {/* 面板标题 */}
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-medium text-ink">{vm.title}</h1>
          <ChevronDown size={15} className="text-ink-faint" />
        </div>
      </header>

      {/* 时间线 */}
      <div ref={vm.scrollRef} className="flex-1 overflow-auto px-5 py-5">
        {vm.turns.length === 0 ? (
          <p className="text-sm text-ink-faint">输入任务开始对话…</p>
        ) : (
          <div
            style={{
              height: `${vm.virtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
          >
            {vm.items.map((vi) => {
              const turn = vm.turns[vi.index];
              if (!turn) {
                return null;
              }
              return (
                <div
                  key={turn.id}
                  data-index={vi.index}
                  ref={vm.virtualizer.measureElement}
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
        {vm.error ? (
          <p className="mt-2 rounded-lg bg-danger/10 p-2 text-xs text-danger">{vm.error.message}</p>
        ) : null}
      </div>

      {/* 输入栏 */}
      <div className="px-5 pb-5">
        <div className="flex items-end gap-2 rounded-xl2 border border-line bg-card p-2 shadow-composer focus-within:border-accent/50">
          <textarea
            rows={1}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            value={vm.draft}
            onChange={(e) => vm.setDraft(e.target.value)}
            placeholder="Reply to Liskin…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                vm.handleSend();
              }
            }}
            disabled={vm.streaming}
          />
          {vm.streaming ? (
            <IconButton
              onClick={vm.handleInterrupt}
              title="停止"
              className="bg-danger/10 text-danger hover:bg-danger/20"
            >
              <Square size={15} />
            </IconButton>
          ) : (
            <IconButton
              onClick={vm.handleSend}
              title="发送"
              disabled={!vm.draft.trim()}
              className="bg-accent text-white hover:bg-accent-ink disabled:bg-line disabled:text-ink-faint"
            >
              <Send size={15} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}
