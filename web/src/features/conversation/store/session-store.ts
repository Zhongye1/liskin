import { create } from 'zustand';
import type { EventMsg, NormalizedError, SessionInfo, ToolCall } from '@liskin/core';
import type { KernelClient } from '@liskin/protocol';

import { HttpSseKernelClient } from '../../../api';
import { applyEvent, messagesToTurns, newTurn, type Turn } from '../lib/events';

type Status = 'idle' | 'streaming' | 'awaiting_confirm' | 'error';

interface SessionState {
  sessions: SessionInfo[];
  turns: Turn[];
  status: Status;
  pendingConfirm: ToolCall | null;
  error: NormalizedError | null;
  draft: string;

  // 动作 —— sessionId 由调用方传入（来自 URL params），store 不再持有 activeSessionId
  init: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  newSession: (system?: string) => Promise<string>;
  selectSession: (id: string) => Promise<void>;
  setDraft: (v: string) => void;
  send: (sessionId: string, content: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  approveTool: (sessionId: string) => Promise<void>;
  denyTool: (sessionId: string) => Promise<void>;
}

const kernel: KernelClient = new HttpSseKernelClient();

type SetFn = (
  partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>),
) => void;

// —— rAF 批量 flush —— //
const pendingTokens = new Map<string, string[]>();
let flushScheduled = false;

function flushTokens(set: SetFn): void {
  flushScheduled = false;
  if (pendingTokens.size === 0) {
    return;
  }
  const batches = [...pendingTokens.entries()];
  pendingTokens.clear();
  set((s) => ({
    turns: s.turns.map((t) => {
      const chunks = batches.find(([id]) => id === t.id)?.[1];
      if (!chunks) {
        return t;
      }
      const next = { ...t, steps: t.steps.map((st) => ({ ...st })) };
      for (const text of chunks) {
        applyEvent(next, { type: 'Token', turnId: t.id, text });
      }
      return next;
    }),
  }));
}

function scheduleFlush(set: SetFn): void {
  if (flushScheduled) {
    return;
  }
  flushScheduled = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => flushTokens(set));
  } else {
    setTimeout(() => flushTokens(set), 16);
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  turns: [],
  status: 'idle',
  pendingConfirm: null,
  error: null,
  draft: '',

  init: async () => {
    await get().refreshSessions();
  },

  refreshSessions: async () => {
    try {
      const sessions = await kernel.listSessions();
      set({ sessions });
    } catch (error) {
      set({
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },

  newSession: async (system?: string) => {
    try {
      const handle = await kernel.createSession(system ? { system } : undefined);
      set({
        turns: [],
        status: 'idle',
        error: null,
        pendingConfirm: null,
        draft: '',
      });
      await get().refreshSessions();
      return handle.id;
    } catch (error) {
      set({
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return '';
    }
  },

  selectSession: async (id) => {
    set({ turns: [], status: 'idle', error: null, pendingConfirm: null });
    try {
      const record = await kernel.getRecord(id);
      set({ turns: messagesToTurns(record.messages as Parameters<typeof messagesToTurns>[0]) });
    } catch (error) {
      set({
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },

  setDraft: (v) => set({ draft: v }),

  send: async (sessionId, content) => {
    if (!sessionId || !content.trim()) {
      return;
    }
    if (get().status === 'streaming') {
      return;
    }

    const turn = newTurn(`t-${Date.now()}`, content);
    set((s) => ({
      turns: [...s.turns, turn],
      status: 'streaming',
      error: null,
      draft: '',
    }));

    try {
      for await (const ev of kernel.submit({
        type: 'UserTurn',
        sessionId,
        content,
      })) {
        reduceEvent({ set, turnId: turn.id }, ev);
      }
      flushTokens(set);
    } catch (error) {
      flushTokens(set);
      set((s) => ({
        status: 'error',
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
        turns: s.turns.map((t) => (t.id === turn.id ? { ...t, status: 'error' as const } : t)),
      }));
    }
  },

  interrupt: async (sessionId) => {
    if (!sessionId) {
      return;
    }
    flushTokens(set);
    await kernel.interrupt(sessionId);
    set({ status: 'idle' });
  },

  approveTool: async (sessionId) => {
    const { pendingConfirm } = get();
    if (!sessionId || !pendingConfirm) {
      return;
    }
    flushTokens(set);
    set({ pendingConfirm: null, status: 'streaming' });
    await kernel.confirmTool(sessionId, pendingConfirm.id, 'approve');
  },

  denyTool: async (sessionId) => {
    const { pendingConfirm } = get();
    if (!sessionId || !pendingConfirm) {
      return;
    }
    flushTokens(set);
    set({ pendingConfirm: null, status: 'streaming' });
    await kernel.confirmTool(sessionId, pendingConfirm.id, 'deny');
  },
}));

// —— EventMsg → Turn reducer —— //

interface ReduceCtx {
  set: SetFn;
  turnId: string;
}

function reduceEvent(ctx: ReduceCtx, ev: EventMsg): void {
  const { set, turnId } = ctx;

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

  flushTokens(set);

  set((s) => ({
    turns: s.turns.map((t) => {
      if (t.id !== turnId) {
        return t;
      }
      const next = { ...t, steps: t.steps.map((st) => ({ ...st })) };
      applyEvent(next, ev);
      return next;
    }),
  }));

  if (ev.type === 'ToolConfirmRequired') {
    set({ status: 'awaiting_confirm', pendingConfirm: ev.call });
  } else if (ev.type === 'TurnEnd') {
    set({ status: 'idle', pendingConfirm: null });
  } else if (ev.type === 'Error') {
    set({ status: 'error', error: ev.error });
  }
}
