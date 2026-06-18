import type { LLMPort } from '../ports/llm-port.js';
import type { ToolPort } from '../ports/tool-port.js';
import type { StorePort } from '../ports/store-port.js';
import { ConfirmRequiredError } from '../ports/tool-port.js';
import type { HarnessPort } from '../harness/harness-port.js';
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
 * Agent 主循环：流式产出 AgentEvent。
 *
 * 状态推进概览：
 *   idle → streaming(LLM) → (没有 toolCall? done : awaiting_tool)
 *                         → 工具执行命中 ConfirmRequiredError → awaiting_user → return
 *                         → 工具执行成功 → 把 tool 结果回灌进 messages → 下一轮
 *
 * 关键不变量：
 *   - tool_call 事件必须在工具实际执行之前 yield（透明展示意图）
 *   - tool_result 在工具执行成功后 yield，并以 role:'tool' 消息回灌
 *   - 每轮开头检查 AbortSignal；中途取消 → done(cancelled)
 *   - 达到 maxTurns → done(max_turns)
 *   - LLM error 事件 → 转发为 agent error 后立即 return
 *   - ConfirmRequiredError → yield tool_confirm_required 并 return（暂停 run）
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
        yield { kind: 'done', reason: 'cancelled' };
        return;
      }
      const outcome = yield* invokeWithProgress(call, tools, confirmed);
      if (outcome.kind === 'confirm') {
        yield { call: outcome.call, kind: 'tool_confirm_required' };
        return;
      }
      if (outcome.kind === 'error') {
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
