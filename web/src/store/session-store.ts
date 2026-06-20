import { create } from 'zustand';
import type { EventMsg, NormalizedError, SessionInfo, ToolCall } from '@liskin/core';
import type { KernelClient } from '@liskin/protocol';

import { HttpSseKernelClient } from '../api/client';
import { applyEvent, messagesToTurns, newTurn, type Turn } from '../kernel/events';

type Status = 'idle' | 'streaming' | 'awaiting_confirm' | 'error';

interface SessionState {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  turns: Turn[];
  status: Status;
  pendingConfirm: ToolCall | null;
  error: NormalizedError | null;
  draft: string;

  // 动作
  init: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  newSession: (system?: string) => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  setDraft: (v: string) => void;
  send: (content: string) => Promise<void>;
  interrupt: () => Promise<void>;
  approveTool: () => Promise<void>;
  denyTool: () => Promise<void>;
}

const kernel: KernelClient = new HttpSseKernelClient();

// —— rAF 批量 flush：高频 Token 增量合并到每帧一次 set，避免逐 token 重渲染 —— //
// 见 docs/architecture/web-frontend-design.md §Step 3.3。
type SetFn = (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void;
const pendingTokens = new Map<string, string[]>();
let flushScheduled = false;

/** 把缓冲的 token 批量折进对应 turn，清空缓冲。 */
function flushTokens(set: SetFn): void {
  flushScheduled = false;
  if (pendingTokens.size === 0) {return;}
  const batches = [...pendingTokens.entries()];
  pendingTokens.clear();
  set((s) => ({
    turns: s.turns.map((t) => {
      const chunks = batches.find(([id]) => id === t.id)?.[1];
      if (!chunks) {return t;}
      const next = { ...t, steps: t.steps.map((st) => ({ ...st })) };
      for (const text of chunks) {
        applyEvent(next, { type: 'Token', turnId: t.id, text });
      }
      return next;
    }),
  }));
}

function scheduleFlush(set: SetFn): void {
  if (flushScheduled) {return;}
  flushScheduled = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => flushTokens(set));
  } else {
    // 测试/SSR 无 rAF：下一轮宏任务兜底
    setTimeout(() => flushTokens(set), 16);
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  turns: [],
  status: 'idle',
  pendingConfirm: null,
  error: null,
  draft: '',

  init: async () => {
    await get().refreshSessions();
    const list = get().sessions;
    const target = list[0]?.id;
    // eslint-disable-next-line unicorn/prefer-ternary -- 含 await，三元可读性差
    if (target) {
      await get().selectSession(target);
    } else {
      await get().newSession();
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await kernel.listSessions();
      set({ sessions });
    } catch (error) {
      set({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  },

  newSession: async (system?: string) => {
    try {
      const handle = await kernel.createSession(system ? { system } : undefined);
      set({
        activeSessionId: handle.id,
        turns: [],
        status: 'idle',
        error: null,
        pendingConfirm: null,
        draft: '',
      });
      await get().refreshSessions();
    } catch (error) {
      set({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  },

  selectSession: async (id) => {
    // 切会话：拉取持久化消息并重建 Turn[]（历史回放，见 §Step 3.3）
    set({ activeSessionId: id, turns: [], status: 'idle', error: null, pendingConfirm: null });
    try {
      const record = await kernel.getRecord(id);
      // 仅当用户未在此期间切到别的会话时才回填
      if (get().activeSessionId === id) {
        set({ turns: messagesToTurns(record.messages) });
      }
    } catch (error) {
      set({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  },

  setDraft: (v) => set({ draft: v }),

  send: async (content) => {
    const sessionId = get().activeSessionId;
    if (!sessionId || !content.trim()) {return;}
    if (get().status === 'streaming') {return;}

    const turn = newTurn(`t-${Date.now()}`, content);
    set((s) => ({
      turns: [...s.turns, turn],
      status: 'streaming',
      error: null,
      draft: '',
    }));

    try {
      for await (const ev of kernel.submit({ sessionId, content })) {
        reduceEvent({ set, turnId: turn.id }, ev);
      }
      // 流结束：强制 flush 残留 token，保证最后一帧不丢
      flushTokens(set);
    } catch (error) {
      flushTokens(set);
      set((s) => ({
        status: 'error',
        error: { message: error instanceof Error ? error.message : String(error) },
        turns: s.turns.map((t) =>
          t.id === turn.id ? { ...t, status: 'error' as const } : t,
        ),
      }));
    }
  },

  interrupt: async () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) {return;}
    flushTokens(set);
    await kernel.interrupt(sessionId);
    set({ status: 'idle' });
  },

  approveTool: async () => {
    const { activeSessionId, pendingConfirm } = get();
    if (!activeSessionId || !pendingConfirm) {return;}
    flushTokens(set);
    set({ pendingConfirm: null, status: 'streaming' });
    await kernel.confirmTool(activeSessionId, pendingConfirm.id, 'approve');
  },

  denyTool: async () => {
    const { activeSessionId, pendingConfirm } = get();
    if (!activeSessionId || !pendingConfirm) {return;}
    flushTokens(set);
    set({ pendingConfirm: null, status: 'streaming' });
    await kernel.confirmTool(activeSessionId, pendingConfirm.id, 'deny');
  },
}));

/**
 * 把 EventMsg 折进对应 turn，并更新状态机。
 * Token 走 rAF 批量缓冲（高频增量合并），其余事件先 flush 缓冲再立即处理。
 */
interface ReduceCtx {
  set: SetFn;
  turnId: string;
}

function reduceEvent(ctx: ReduceCtx, ev: EventMsg): void {
  const { set, turnId } = ctx;

  // Token：缓冲，等 rAF 批量 flush
  if (ev.type === 'Token') {
    const arr = pendingTokens.get(turnId);
    if (arr) {
      arr.push(ev.text);
    } else {
      pendingTokens.set(turnId, [ev.text]);
    }
    scheduleFlush(set);
    return;
  }

  // 非 Token 事件：先 flush 残留 token，保证顺序（token 在前）
  flushTokens(set);

  // 把事件折进对应 turn 的 steps（applyEvent 同时更新 turn.status）
  set((s) => ({
    turns: s.turns.map((t) => {
      if (t.id !== turnId) {return t;}
      const next = { ...t, steps: t.steps.map((st) => ({ ...st })) };
      applyEvent(next, ev);
      return next;
    }),
  }));

  // 顶层状态机推进
  if (ev.type === 'ToolConfirmRequired') {
    set({ status: 'awaiting_confirm', pendingConfirm: ev.call });
  } else if (ev.type === 'TurnEnd') {
    set({ status: 'idle', pendingConfirm: null });
  } else if (ev.type === 'Error') {
    set({ status: 'error', error: ev.error });
  }
}
