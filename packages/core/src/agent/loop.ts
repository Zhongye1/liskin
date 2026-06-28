/**
 * Agent 主循环 — 流式 ReAct Loop。
 *
 * ## 职责
 *
 * L1 内核的最内层。接收三个 Port 接口（LLMPort / ToolPort / StorePort）和
 * 初始消息，产出 AsyncGenerator<AgentEvent>。不 import 任何具体实现，不感知
 * 自己是 CLI 还是 Web 在调用。
 *
 * ## 输入
 *
 *   RunAgentOptions {
 *     llm: LLMPort            // 流式聊天（由 llm 包实现）
 *     tools: ToolPort          // 工具注册与调度（由 tools 包实现）
 *     store?: StorePort        // 可选：会话持久化（由 server 包实现）
 *     harness?: HarnessPort    // 可选：任务真相记录（当前 NoopHarness 占位）
 *     initialMessages: Msg[]   // 启动消息（至少含 system + 第一条 user）
 *     maxTurns?: number        // 防死循环上限，默认 16
 *     confirmedCallIds?: string[] // 确认后重入：用户已批准的 tool_call id
 *     signal?: AbortSignal     // 取消信号（Ctrl-C / 页面关闭）
 *   }
 *
 * ## 输出
 *
 *   AsyncGenerator<AgentEvent> — 7 种事件：
 *   - token                  → 逐字文本输出
 *   - tool_call              → 模型想调工具（执行前先 yield）
 *   - tool_progress          → 工具实时 stdout/stderr
 *   - tool_result            → 工具执行结果
 *   - tool_confirm_required  → 需要用户确认（暂停 run，等 confirmTool）
 *   - done                   → completed / max_turns / cancelled
 *   - error                  → 异常终止
 *
 * ## 状态推进
 *
 *     idle
 *      │
 *      ▼
 *     streaming(LLM) ──→ 无 toolCall? ──→ done(completed)
 *      │
 *      └─→ 有 toolCall(s)
 *            │
 *            ├─ 成功 ──→ tool_result 回灌 messages ──→ 下一轮 streaming
 *            ├─ ConfirmRequiredError ──→ tool_confirm_required ──→ return（暂停）
 *            └─ 其他错误 ──→ error ──→ return
 *
 *     每轮开头检查 AbortSignal → done(cancelled)
 *     达到 maxTurns          → done(max_turns)
 *
 * ## 不变量
 *
 *   1. tool_call 先 yield 再执行 — 透明展示模型意图
 *   2. tool_result yield 后才回灌 messages，确保事件顺序一致
 *   3. ConfirmRequiredError 不产生假 user 消息 — yield + return，由上层重入
 *   4. 错误归一为 AgentEvent 后 return，不继续循环
 *   5. 内核不 import @liskin/llm / @liskin/tools / @liskin/server
 *
 * ## 确认流程
 *
 *   runAgent 不处理确认 UI。遇到 ConfirmRequiredError 时 yield
 *   tool_confirm_required 事件并 return。调用方（InProcessKernelClient）
 *   在外部等待用户决策，然后带着 confirmedCallIds 再次调用 runAgent，
 *   preflight 检测到 confirmedCallId 命中 → 用 confirmPolicy='auto' 跳过弹窗。
 *
 *   详见 packages/core/src/kernel/in-process.ts 的 wrapToolsForConfirm。
 *
 * ## invokeWithProgress
 *
 *   从主循环抽取的工具执行辅助函数。用 Promise + notify 唤醒机制在
 *   draining progressQueue 和等待工具完成之间切换，避免忙等。
 *   工具执行期间的实时 stdout/stderr 通过 onProgress 回调推送，
 *   包装为 tool_progress 事件流式 yield。
 */

import type { LLMPort } from '../ports';
import type { ToolPort } from '../ports';
import type { StorePort } from '../ports';
import { ConfirmRequiredError } from '../ports';
import type { HarnessPort } from '../harness';
import type { Msg, ToolCall, ToolResult } from '../types/messages.js';
import type { AgentEvent } from '../types/events.js';

export interface RunAgentOptions {
  llm: LLMPort;
  tools: ToolPort;
  store?: StorePort;
  harness?: HarnessPort;
  initialMessages: Msg[];
  /** 单次 run 内允许的最大 LLM 回合数（防死循环），默认 16 */
  maxTurns?: number;
  /** 用户已确认的 tool call id 集合（重新进入 run 时携带） */
  confirmedCallIds?: string[];
  /** 取消 */
  signal?: AbortSignal;
}

/**
 * 主循环入口。输入/输出/状态机/不变量详见文件头注释。
 *
 * 内部流程：
 *   while (turn < maxTurns):
 *     ├─ 调 LLMPort.chatStream() → 流式消费 LLMEvent
 *     │   ├─ token       → yield AgentEvent('token')
 *     │   ├─ tool_call   → 收集到 pendingToolCalls（先 yield 再执行）
 *     │   ├─ error       → yield error + return
 *     │   └─ done        → 结束本轮流式
 *     ├─ 把 assistant 消息（含 toolCalls）push 进 messages
 *     ├─ 没有 toolCall? → yield done('completed') + return
 *     └─ 有 toolCall?   → 逐个 invokeWithProgress():
 *         ├─ 流式产出 tool_progress（实时 stdout/stderr）
 *         ├─ ConfirmRequiredError → yield tool_confirm_required + return
 *         ├─ 其他错误 → yield error + return
 *         └─ 成功 → yield tool_result + push tool 消息 → 下一轮
 */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent, void, void> {
  const { llm, tools, harness, initialMessages, maxTurns = 16, confirmedCallIds, signal } = opts;

  const messages: Msg[] = [...initialMessages];
  const confirmed = new Set<string>(confirmedCallIds ?? []);
  let turn = 0;

  while (turn < maxTurns) {
    // 每轮开头检查取消
    if (signal?.aborted) {
      yield { kind: 'done', reason: 'cancelled' };
      return;
    }
    turn++;

    // —— 调 LLM —— //
    const pendingToolCalls: ToolCall[] = [];
    let accumulatedAssistantText = '';
    let llmErrored = false;

    try {
      for await (const ev of llm.chatStream({
        messages,
        signal,
        tools: tools.list(),
      })) {
        // 流式过程中也允许中途取消：在每个事件之间检查
        if (signal?.aborted) {
          yield { kind: 'done', reason: 'cancelled' };
          return;
        }

        switch (ev.kind) {
          case 'token': {
            accumulatedAssistantText += ev.text;
            yield { kind: 'token', text: ev.text };
            break;
          }
          case 'tool_call': {
            pendingToolCalls.push(ev.call);
            // 在执行工具之前先 yield，透明展示模型意图
            yield { call: ev.call, kind: 'tool_call' };
            break;
          }
          case 'done': {
            // LLM 本轮已结束流；交给外层处理工具调用或终止
            break;
          }
          case 'error': {
            llmErrored = true;
            yield { error: ev.error, kind: 'error' };
            return;
          }
        }

        if (ev.kind === 'done') {
          break;
        }
      }
    } catch (error) {
      // abort 引发的异常归一为 cancelled，而非 error
      if (signal?.aborted) {
        yield { kind: 'done', reason: 'cancelled' };
        return;
      }
      // ChatStream 内部异常也归一为 agent error
      if (!llmErrored) {
        yield {
          error: { message: error instanceof Error ? error.message : String(error) },
          kind: 'error',
        };
      }
      return;
    }

    // 流提前结束（chatStream 因 abort 返回而未发 done）→ cancelled
    if (signal?.aborted) {
      yield { kind: 'done', reason: 'cancelled' };
      return;
    }

    // 这一轮 assistant 消息塞进 messages（即使 content 为空也要保留 toolCalls）
    messages.push({
      content: accumulatedAssistantText,
      role: 'assistant',
      ...(pendingToolCalls.length > 0 ? { toolCalls: pendingToolCalls } : {}),
    });

    // 没有工具调用 → 完成
    if (pendingToolCalls.length === 0) {
      if (harness?.complete) {
        try {
          await harness.complete();
        } catch {
          // Harness 失败不影响主流程
        }
      }
      yield { kind: 'done', reason: 'completed' };
      return;
    }

    // 有工具调用 → 顺序执行（M1 简化版，并发优化留 M3+）
    for (const call of pendingToolCalls) {
      if (signal?.aborted) {
        // 为当前及后续所有未执行的 toolCall 补上取消消息，防止孤立
        const idx = pendingToolCalls.indexOf(call);
        fillRemainingToolMessages(messages, pendingToolCalls.slice(idx), 'cancelled');
        yield { kind: 'done', reason: 'cancelled' };
        return;
      }
      const outcome = yield* invokeWithProgress(call, tools, confirmed);
      if (outcome.kind === 'confirm') {
        // 为后续未执行的 toolCall 补上跳过消息（当前需要确认的 call 由上层重入处理）
        const idx = pendingToolCalls.indexOf(call);
        fillRemainingToolMessages(messages, pendingToolCalls.slice(idx + 1), 'confirm_required');
        yield { call: outcome.call, kind: 'tool_confirm_required' };
        return;
      }
      if (outcome.kind === 'error') {
        // 为当前及后续所有未执行的 toolCall 补上错误消息
        const idx = pendingToolCalls.indexOf(call);
        fillRemainingToolMessages(messages, pendingToolCalls.slice(idx), outcome.message);
        yield { error: { message: outcome.message }, kind: 'error' };
        return;
      }
      yield { kind: 'tool_result', result: outcome.result };
      messages.push({
        content: outcome.result.content,
        role: 'tool',
        toolCallId: call.id,
      });
    }

    // 工具结果回灌后继续下一轮 LLM
  }

  // 达到 maxTurns 上限
  yield { kind: 'done', reason: 'max_turns' };
}

/**
 * 为未执行的 toolCall 补上占位 tool 消息，保证 assistant.toolCalls 中每一项
 * 都有配对的 role:'tool' 消息，避免下次 LLM 调用时报 "insufficient tool messages"。
 */
function fillRemainingToolMessages(
  messages: Msg[],
  remainingCalls: ToolCall[],
  reason: string,
): void {
  for (const call of remainingCalls) {
    messages.push({
      content: `Tool execution skipped: ${reason}`,
      role: 'tool',
      toolCallId: call.id,
    });
  }
}

type ToolOutcome =
  | { kind: 'result'; result: ToolResult }
  | { kind: 'confirm'; call: ToolCall }
  | { kind: 'error'; message: string };

/**
 * 执行单个工具调用，流式产出 tool_progress，最终返回 result/confirm/error。
 * 从 runAgent 抽出以降低主循环嵌套深度（max-depth）。
 */
async function* invokeWithProgress(
  call: ToolCall,
  tools: ToolPort,
  confirmed: Set<string>,
): AsyncGenerator<AgentEvent, ToolOutcome, void> {
  const progressQueue: { stream: 'stdout' | 'stderr'; chunk: string }[] = [];
  const state = { settled: false, notify: null as (() => void) | null };
  const wake = (): void => {
    const fn = state.notify;
    if (fn) {
      state.notify = null;
      fn();
    }
  };
  const onProgress = (stream: 'stdout' | 'stderr', chunk: string): void => {
    progressQueue.push({ stream, chunk });
    wake();
  };

  try {
    const invokePromise = tools.invoke(call, {
      confirmedCallId: confirmed.has(call.id) ? call.id : undefined,
      onProgress,
    });
    const settled = invokePromise.finally(() => {
      state.settled = true;
      wake();
    });

    while (progressQueue.length > 0 || !state.settled) {
      while (progressQueue.length > 0) {
        const next = progressQueue.shift();
        if (next) {
          yield { kind: 'tool_progress', callId: call.id, stream: next.stream, chunk: next.chunk };
        }
      }
      if (!state.settled) {
        await new Promise<void>((resolve) => {
          state.notify = resolve;
        });
      }
    }

    const result = await settled;
    return { kind: 'result' as const, result };
  } catch (error) {
    if (error instanceof ConfirmRequiredError) {
      return { kind: 'confirm' as const, call: error.call };
    }
    return {
      kind: 'error' as const,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
