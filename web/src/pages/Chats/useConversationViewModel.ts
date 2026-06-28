import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSessionStore } from './model/session-store';

/**
 * Conversation 页面的 ViewModel 层。
 *
 * 职责：
 * - 从 Model（Zustand store）读取状态
 * - 管理虚拟滚动 / 自动滚底
 * - 计算派生值（title、streaming、items）
 * - 暴露纯 action 回调给 View
 *
 * View 层（Conversation.tsx）只负责渲染，不包含业务逻辑。
 */
export function useConversationViewModel(sessionId: string | undefined) {
  // ── Model 层：Zustand store ──
  const { turns, status, error, draft, selectSession, setDraft, send, interrupt } =
    useSessionStore();

  // ── session 加载 ──
  useEffect(() => {
    if (sessionId) {
      void selectSession(sessionId);
    }
  }, [sessionId, selectSession]);

  // ── 虚拟滚动 ──
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: 4,
  });

  // ── 新 turn 自动滚底 ──
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

  // ── 派生值 ──
  const streaming = status === 'streaming';
  const title = turns[0]?.userContent?.slice(0, 48) ?? 'New session';
  const items = virtualizer.getVirtualItems();

  // ── Actions ──
  const handleSend = () => {
    const text = draft.trim();
    if (!text || status === 'streaming' || !sessionId) {
      return;
    }
    void send(sessionId, text);
  };

  const handleInterrupt = () => {
    if (sessionId) {
      void interrupt(sessionId);
    }
  };

  return {
    // 状态
    turns,
    status,
    error,
    draft,
    streaming,
    title,
    // 视图引用
    scrollRef,
    virtualizer,
    items,
    // Actions
    setDraft,
    handleSend,
    handleInterrupt,
  };
}
