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

import type { LLMPort } from '../ports';
import type { StorePort } from '../ports';
import type { ToolPort, ToolInvokeOptions } from '../ports';
import type { HarnessPort } from '../harness';
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
 * 进程内 KernelClient — 所有 in-process 场景的集中入口。
 *
 * ## 定位
 *
 * 这是 KernelClient 协议接口的 in-process 实现。CLI（chat/exec）和测试
 * 通过它直连内核，无需 HTTP/SSE transport。对外暴露统一的 KernelClient
 * 接口（createSession / submit / confirmTool / interrupt），对内组装
 * LLMPort + ToolPort + StorePort + HarnessPort，驱动 runAgent。
 *
 * ## 一次 submit() 的完整流程
 *
 *   submit({sessionId, content}):
 *     │
 *     ├─ 1. store.loadSession(sessionId) → messages（加载历史）
 *     ├─ 2. messages.push({role: 'user', content})（追加用户消息）
 *     ├─ 3. store.saveSession({...record, messages, updatedAt})（先落 user turn）
 *     ├─ 4. new AsyncQueue<EventMsg>() + new AbortController()
 *     │
 *     ├─ 5. driveTurn({messages, queue, signal, ...})  ← 异步启动
 *     │      │
 *     │      └─ for await (ev of runAgent({
 *     │            llm: this.llm,              // 原始 LLMPort
 *     │            tools: this.wrapToolsForConfirm({...}),  // ★ 包了一层
 *     │            harness: this.harness,
 *     │            initialMessages: messages,
 *     │            confirmedCallIds,
 *     │            maxTurns, signal
 *     │          })) {
 *     │            handleEvent(ev)  → 翻译 AgentEvent → EventMsg → queue.push()
 *     │          }
 *     │
 *     └─ 6. yield TurnStart; for await (ev of queue) { yield ev }
 *          // 上层拿到 AsyncIterable<EventMsg>，流式消费
 *
 * ## 确认流程 — wrapToolsForConfirm + AsyncQueue + Deferred
 *
 *   这是整个设计中"流自然暂停"的关键。runAgent 本身只能处理最原始的
 *   ConfirmRequiredError 异常（抛 → return）。InProcessKernelClient 在
 *   ToolPort 外包了一层，把异常翻译成"push 事件 + await Deferred"：
 *
 *     runAgent                    wrapToolsForConfirm              AsyncQueue
 *       │                              │                              │
 *       ├─ invoke(call) ──────────────→│ inner.invoke(call)           │
 *       │                              │   ↓ ConfirmRequiredError    │
 *       │                              │ catch:                       │
 *       │                              │   queue.push(               │
 *       │                              │     ToolConfirmRequired) ───→ 上层消费
 *       │                              │   deferred = new Deferred()  │
 *       │                              │   await deferred.promise ← 阻塞在这
 *       │                              │       ↑                     │
 *       │                              │  confirmTool('approve') ────┘
 *       │                              │   → deferred.resolve()
 *       │                              │   → inner.invoke(call, {confirmedCallId})
 *       │  ← result ───────────────────┤
 *       │                              │
 *       │  继续下一轮 ─────────────────→                              │
 *
 *   这样单条 submit() 的 AsyncIterable<EventMsg> 在确认期间自然暂停：
 *   - 不需要重新调用 runAgent（无 token 重生成）
 *   - 不需要在 messages 里插入假 user 消息（<continue:id> 等 hack）
 *   - deny 时 wrapToolsForConfirm 直接返回 ok=false 的 ToolResult，runAgent 自然处理
 *
 * ## 事件翻译 — handleEvent
 *
 *   AgentEvent (内核事件)       →  EventMsg (协议事件)
 *   ─────────────────────────────────────────────────
 *   token                      →  Token（逐字）
 *   tool_call                  →  ToolCall（展示意图）
 *   tool_progress              →  ToolProgress（实时输出）
 *   tool_result                →  ToolResult + flush assistant
 *   tool_confirm_required      →  ToolConfirmRequired（暂停）
 *   done(reason)               →  TurnEnd（reason 映射）
 *   error                      →  Error + TurnEnd('error')
 *
 * ## 内部类型
 *
 *   TurnAccumulator  — 单次 Turn 内累积的 assistant 文本 + toolCalls。
 *                      文本和 tool_call 在流式过程中分别到来，需要先缓存，
 *                      tool_result 出现时一次性 flush 成一条 assistant 消息。
 *
 *   PendingConfirm   — 活跃的确认请求。sessionId → {turnId, deferred}。
 *                      confirmTool 通过 sessionId 找到 deferred 并 resolve。
 *
 * ## 生命周期
 *
 *   - createSession: 生成 id → store.saveSession → 返回 SessionHandle
 *   - resumeSession: store.loadSession → 返回 SessionHandle（含 isNew: false）
 *   - closeSession:  interrupt + resolve pending confirm → store.deleteSession
 *   - activeRuns:    Map<sessionId, AbortController> — 同一时刻一个 session 最多一个 run
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
        // 为当前需要确认之外的 toolCall 补上占位消息，防止孤立
        this.fillOrphanedToolMessages(messages, acc, ev.call.id);
        this.flushAssistant(messages, acc);
        this.persist(sessionId, messages);
        queue.push({ type: 'ToolConfirmRequired', turnId, call: ev.call });
        break;
      }
      case 'done': {
        // 非正常完成时，补上未执行的 toolCall 占位消息
        if (ev.reason !== 'completed') {
          this.fillOrphanedToolMessages(messages, acc);
        }
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
        // 补上未执行的 toolCall 占位消息，防止下次 LLM 调用报 insufficient tool messages
        this.fillOrphanedToolMessages(messages, acc);
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
   * 为已声明但尚未匹配 tool 消息的 toolCall 补上占位消息。
   * 防止下次 LLM 调用时 OpenAI 报 "insufficient tool messages following tool_calls message"。
   *
   * @param exceptCallId 可选：跳过指定 callId（confirm 场景，该 call 会被上层重入执行）
   */
  private fillOrphanedToolMessages(
    messages: Msg[],
    acc: TurnAccumulator,
    exceptCallId?: string,
  ): void {
    // 1) 如果 acc 中还有未 flush 的 toolCall，说明 assistant 消息尚未写入 messages。
    //    这种情况下直接往 messages 写入占位 tool 消息即可（flushAssistant 会随后写入 assistant）。
    if (acc.pendingToolCalls.length > 0) {
      for (const call of acc.pendingToolCalls) {
        if (call.id !== exceptCallId) {
          messages.push({
            role: 'tool',
            content: 'Tool execution skipped (error or cancellation)',
            toolCallId: call.id,
          });
        }
      }
      return;
    }

    // 2) assistant 已 flush 到 messages。扫描最后一条 assistant 消息的 toolCalls，
    //    找出没有匹配 tool 消息的 id，补上占位。
    const assistant = findLastAssistantWithToolCalls(messages);
    if (!assistant?.toolCalls) {
      return;
    }

    const assistantIdx = messages.indexOf(assistant);
    const resolved = new Set<string>();
    for (let i = assistantIdx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'tool' && m.toolCallId) {
        resolved.add(m.toolCallId);
      }
    }

    for (const tc of assistant.toolCalls) {
      if (tc.id !== exceptCallId && !resolved.has(tc.id)) {
        messages.push({
          role: 'tool',
          content: 'Tool execution skipped (error or cancellation)',
          toolCallId: tc.id,
        });
      }
    }
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

/** 从 messages 尾部向前扫描，找到最后一条包含 toolCalls 的 assistant 消息。 */
function findLastAssistantWithToolCalls(
  messages: Msg[],
): Extract<Msg, { role: 'assistant' }> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls && m.toolCalls.length > 0) {
      return m as Extract<Msg, { role: 'assistant' }>;
    }
  }
  return undefined;
}
