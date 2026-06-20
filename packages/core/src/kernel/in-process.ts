/* eslint-disable max-lines -- 协议核心实现：会话+回合+确认+持久化内聚于此，拆分会破坏可读性 */
import type {
  EventMsg,
  KernelClient,
  SessionHandle,
  SessionInfo,
  SessionRecord,
  SubmitOp,
  TurnEndReason,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@liskin/protocol';

import type { LLMPort } from '../ports/llm-port.js';
import type { StorePort } from '../ports/store-port.js';
import type { ToolPort, ToolInvokeOptions } from '../ports/tool-port.js';
import type { HarnessPort } from '../harness/harness-port.js';
import type { Msg } from '../types/messages.js';
import type { AgentEvent } from '../types/events.js';
import { runAgent } from '../agent/loop.js';
import { AsyncQueue, Deferred } from './async-queue.js';

export interface InProcessKernelOptions {
  llm: LLMPort;
  tools: ToolPort;
  store: StorePort;
  harness?: HarnessPort;
  /** 单次 UserTurn 默认最大 LLM 回合数，默认 16。 */
  maxTurns?: number;
}

interface PendingConfirm {
  readonly turnId: string;
  readonly maxTurns: number;
  readonly deferred: Deferred<'approve' | 'deny' | 'cancel'>;
}

/** 单次 UserTurn 内累积的 assistant 内容（文本 + 工具调用），用于落库。 */
interface TurnAccumulator {
  assistantText: string;
  pendingToolCalls: ToolCall[];
}

interface DriveTurnCtx {
  sessionId: string;
  turnId: string;
  messages: Msg[];
  maxTurns: number;
  signal: AbortSignal;
  queue: AsyncQueue<EventMsg>;
  acc: TurnAccumulator;
  confirmedCallIds: string[];
}

interface HandleEventCtx {
  ev: AgentEvent;
  turnId: string;
  sessionId: string;
  messages: Msg[];
  acc: TurnAccumulator;
  queue: AsyncQueue<EventMsg>;
}

/**
 * 进程内 KernelClient：把 runAgent 包装成「服务」。
 *
 * 关键设计——用 ConfirmingToolPort + AsyncQueue 合并确认语义：
 * - runAgent 的事件流（经 ConfirmingToolPort 翻译）push 进 AsyncQueue
 * - 遇到 ConfirmRequiredError 时，先 push ToolConfirmRequired，再 await deferred
 * - confirmTool(approve) → deferred resolve('approve') → ToolPort 带
 *   confirmedCallId 重跑同一 call，事件继续 push
 * - confirmTool(deny) → 回灌 ok=false 的 tool_result，续跑
 *
 * 这样单条 submit(UserTurn) 的 AsyncIterable<EventMsg> 在确认期间自然暂停，
 * 既不需要重新 runAgent（无 token 重生成），也不需要假 user 消息。
 *
 * 见 docs/architecture/kernel-client-protocol.md §3.4 / §4.3。
 */
export class InProcessKernelClient implements KernelClient {
  private readonly maxTurnsDefault: number;
  private readonly llm: LLMPort;
  private readonly tools: ToolPort;
  private readonly store: StorePort;
  private readonly harness?: HarnessPort;

  private readonly activeRuns = new Map<string, AbortController>();
  private readonly pendingConfirms = new Map<string, PendingConfirm>();

  constructor(options: InProcessKernelOptions) {
    this.llm = options.llm;
    this.tools = options.tools;
    this.store = options.store;
    this.harness = options.harness;
    this.maxTurnsDefault = options.maxTurns ?? 16;
  }

  // —— 会话生命周期 —— //

  async createSession(init?: {
    cwd?: string;
    providerId?: string;
    system?: string;
  }): Promise<SessionHandle> {
    void init?.cwd;
    void init?.providerId;
    const now = new Date().toISOString();
    const id = this.generateSessionId();
    const messages: Msg[] = init?.system ? [{ role: 'system', content: init.system }] : [];
    const record = { id, createdAt: now, updatedAt: now, messages };
    await this.store.saveSession(record);
    return { ...toInfo(record), isNew: true };
  }

  async resumeSession(sessionId: string): Promise<SessionHandle> {
    const record = await this.store.loadSession(sessionId);
    if (!record) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return { ...toInfo(record), isNew: false };
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.interrupt(sessionId);
    const pending = this.pendingConfirms.get(sessionId);
    if (pending) {
      pending.deferred.resolve('cancel');
    }
    this.pendingConfirms.delete(sessionId);
    if (this.store.deleteSession) {
      await this.store.deleteSession(sessionId);
    }
  }

  async getRecord(sessionId: string): Promise<SessionRecord> {
    const record = await this.store.loadSession(sessionId);
    if (!record) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return record;
  }

  async listSessions(): Promise<SessionInfo[]> {
    if (this.store.listSessions) {
      return this.store.listSessions();
    }
    return [];
  }

  // —— 回合控制 —— //

  async interrupt(sessionId: string): Promise<void> {
    const controller = this.activeRuns.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }

  async confirmTool(
    sessionId: string,
    callId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    void callId;
    const pending = this.pendingConfirms.get(sessionId);
    if (!pending) {
      throw new Error(`no pending confirm on session ${sessionId}`);
    }
    this.pendingConfirms.delete(sessionId);
    pending.deferred.resolve(decision);
  }

  // —— 回合事件流 —— //

  async *submit(op: SubmitOp): AsyncIterable<EventMsg> {
    const { sessionId, content } = op;
    const record = await this.store.loadSession(sessionId);
    if (!record) {
      yield { type: 'Error', sessionId, error: { message: `session not found: ${sessionId}` } };
      return;
    }

    const turnId = this.generateTurnId();
    const now = new Date().toISOString();
    const messages: Msg[] = [...record.messages, { role: 'user', content }];
    await this.store.saveSession({ ...record, messages, updatedAt: now });

    const maxTurns = op.maxTurns ?? this.maxTurnsDefault;
    const queue = new AsyncQueue<EventMsg>();
    const controller = new AbortController();
    this.activeRuns.set(sessionId, controller);

    const acc: TurnAccumulator = { assistantText: '', pendingToolCalls: [] };
    const confirmedCallIds: string[] = [];

    const drive = this.driveTurn({
      sessionId,
      turnId,
      messages,
      maxTurns,
      signal: controller.signal,
      queue,
      acc,
      confirmedCallIds,
    });
    drive.catch((error: unknown) => {
      // drive 内部已归一化错误为 EventMsg；此处仅防 unhandled rejection
      void error;
    });

    yield { type: 'TurnStart', turnId, sessionId };

    try {
      for await (const ev of queue) {
        yield ev;
      }
    } finally {
      controller.abort();
      this.activeRuns.delete(sessionId);
    }
  }

  // —— 内部：驱动 runAgent —— //

  private async driveTurn(ctx: DriveTurnCtx): Promise<void> {
    const { sessionId, turnId, messages, maxTurns, signal, queue, acc, confirmedCallIds } = ctx;
    try {
      for await (const ev of runAgent({
        llm: this.llm,
        tools: this.wrapToolsForConfirm({
          sessionId,
          turnId,
          queue,
          confirmedCallIds,
          maxTurns,
          messages,
          acc,
        }),
        harness: this.harness,
        initialMessages: messages,
        confirmedCallIds,
        maxTurns,
        signal,
      })) {
        this.handleEvent({ ev, turnId, sessionId, messages, acc, queue });
      }
    } catch (error) {
      this.flushAssistant(messages, acc);
      queue.push({
        type: 'Error',
        turnId,
        sessionId,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      this.flushAssistant(messages, acc);
      this.persist(sessionId, messages);
      this.activeRuns.delete(sessionId);
      queue.close();
    }
  }

  /** 翻译单个 AgentEvent → push EventMsg 到 queue；同时维护 messages 与 acc。 */
  private handleEvent(ctx: HandleEventCtx): void {
    const { ev, turnId, sessionId, messages, acc, queue } = ctx;
    switch (ev.kind) {
      case 'token': {
        acc.assistantText += ev.text;
        queue.push({ type: 'Token', turnId, text: ev.text });
        break;
      }
      case 'tool_call': {
        acc.pendingToolCalls.push(ev.call);
        queue.push({ type: 'ToolCall', turnId, call: ev.call });
        break;
      }
      case 'tool_progress': {
        queue.push({
          type: 'ToolProgress',
          turnId,
          callId: ev.callId,
          stream: ev.stream,
          chunk: ev.chunk,
        });
        break;
      }
      case 'tool_result': {
        // tool_result 标志着上一段 assistant 结束：先 flush，再落 tool 消息
        this.flushAssistant(messages, acc);
        messages.push({
          role: 'tool',
          content: ev.result.content,
          toolCallId: ev.result.toolCallId,
        });
        queue.push({ type: 'ToolResult', turnId, result: ev.result });
        break;
      }
      case 'tool_confirm_required': {
        // 暂停前先 flush assistant（含本轮 toolCalls）
        this.flushAssistant(messages, acc);
        this.persist(sessionId, messages);
        queue.push({ type: 'ToolConfirmRequired', turnId, call: ev.call });
        break;
      }
      case 'done': {
        this.flushAssistant(messages, acc);
        queue.push({
          type: 'TurnEnd',
          turnId,
          sessionId,
          reason: mapDoneReason(ev.reason),
        });
        break;
      }
      case 'error': {
        this.flushAssistant(messages, acc);
        queue.push(
          { type: 'Error', turnId, sessionId, error: ev.error },
          { type: 'TurnEnd', turnId, sessionId, reason: 'error' },
        );
        break;
      }
      default: {
        break;
      }
    }
  }

  /** 把累积的 assistant 文本 + toolCalls 写成一条 assistant 消息（匹配旧 server 行为）。 */
  private flushAssistant(messages: Msg[], acc: TurnAccumulator): void {
    if (acc.assistantText.length === 0 && acc.pendingToolCalls.length === 0) {
      return;
    }
    messages.push({
      role: 'assistant',
      content: acc.assistantText,
      ...(acc.pendingToolCalls.length > 0 ? { toolCalls: [...acc.pendingToolCalls] } : {}),
    });
    acc.assistantText = '';
    acc.pendingToolCalls = [];
  }

  /**
   * 包一层 ToolPort：把 ConfirmRequiredError 翻译成「push 事件 + await 用户决策」。
   */
  private wrapToolsForConfirm(ctx: {
    sessionId: string;
    turnId: string;
    queue: AsyncQueue<EventMsg>;
    confirmedCallIds: string[];
    maxTurns: number;
    messages: Msg[];
    acc: TurnAccumulator;
  }): ToolPort {
    const { sessionId, turnId, queue, confirmedCallIds, maxTurns, messages, acc } = ctx;
    const inner = this.tools;
    return {
      list: (): ToolDefinition[] => inner.list(),
      invoke: async (call: ToolCall, opts?: ToolInvokeOptions): Promise<ToolResult> => {
        if (opts?.confirmedCallId && opts.confirmedCallId === call.id) {
          return inner.invoke(call, opts);
        }
        try {
          return await inner.invoke(call, opts);
        } catch (error) {
          if (!isConfirmRequired(error)) {
            throw error;
          }
          // 暂停：先 flush assistant，push 确认事件，等用户决策
          this.flushAssistant(messages, acc);
          this.persist(sessionId, messages);
          queue.push({ type: 'ToolConfirmRequired', turnId, call });
          const deferred = new Deferred<'approve' | 'deny' | 'cancel'>();
          this.pendingConfirms.set(sessionId, { turnId, maxTurns, deferred });
          const decision = await deferred.promise;
          if (decision === 'cancel') {
            throw new Error('session closed', { cause: error });
          }
          if (decision === 'approve') {
            confirmedCallIds.push(call.id);
            return inner.invoke(call, { ...opts, confirmedCallId: call.id });
          }
          return {
            toolCallId: call.id,
            ok: false,
            content: `user denied tool call: ${call.name}`,
          };
        }
      },
    };
  }

  private persist(sessionId: string, messages: Msg[]): void {
    const now = new Date().toISOString();
    void this.store
      .loadSession(sessionId)
      .then((record) => {
        if (!record) {
          return;
        }
        return this.store.saveSession({ ...record, messages, updatedAt: now });
      })
      .catch(() => {
        // 落库失败不阻塞事件流；上层可从 store 重建
      });
  }

  private generateSessionId(): string {
    return `s-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  }

  private generateTurnId(): string {
    return `t-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  }
}

function toInfo(record: {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: Msg[];
}): SessionInfo {
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messages.length,
  };
}

function mapDoneReason(reason: 'completed' | 'max_turns' | 'cancelled'): TurnEndReason {
  if (reason === 'completed') {
    return 'completed';
  }
  if (reason === 'max_turns') {
    return 'max_turns';
  }
  return 'interrupted';
}

function isConfirmRequired(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConfirmRequiredError';
}
