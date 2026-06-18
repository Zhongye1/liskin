import type { LLMEvent } from '@liskin/core';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

interface PendingToolCall {
  id: string;
  name: string;
  argsBuffer: string;
}

/**
 * 把单个 PendingToolCall 转换为一个或多个 LLMEvent：
 *  - 缺 id 或 name → 跳过（不输出任何事件）
 *  - args 非空但 JSON.parse 失败 → yield error 事件（code='invalid_tool_args'），不再 yield 该 tool_call
 *  - 其余正常情况 → yield 一个 tool_call 事件
 */
function* toolCallEventsFor(pending: PendingToolCall): Generator<LLMEvent, void, void> {
  // 必修 #2：drainPending 校验 — 缺 id / name 直接跳过
  if (pending.id === '' || pending.name === '') {
    return;
  }

  let parsedArgs: unknown = {};
  if (pending.argsBuffer !== '') {
    try {
      parsedArgs = JSON.parse(pending.argsBuffer);
    } catch {
      // 应修 #6：JSON.parse 失败改 yield error 事件，跳过该 pending
      yield {
        kind: 'error',
        error: {
          code: 'invalid_tool_args',
          message: `invalid tool args JSON for tool ${pending.name}: ${pending.argsBuffer.slice(0, 200)}`,
        },
      };
      return;
    }
  }

  yield {
    kind: 'tool_call',
    call: { id: pending.id, name: pending.name, args: parsedArgs },
  };
}

function* drainPending(
  pendingByIndex: Map<number, PendingToolCall>,
): Generator<LLMEvent, void, void> {
  if (pendingByIndex.size === 0) {
    return;
  }
  const indices = [...pendingByIndex.keys()];
  indices.sort((a, b) => a - b);
  for (const idx of indices) {
    const pending = pendingByIndex.get(idx);
    if (pending) {
      yield* toolCallEventsFor(pending);
    }
  }
  pendingByIndex.clear();
}

/**
 * 必修 #1：现在只把 'tool_calls' / 'stop' 当成正常终止；
 * 'length' / 'content_filter' 由调用方单独处理为 error 事件。
 */
function isTerminalFinishReason(
  reason: ChatCompletionChunk.Choice['finish_reason'] | null | undefined,
): boolean {
  return reason === 'tool_calls' || reason === 'stop';
}

/**
 * 把 OpenAI 流式响应解析为 LLMEvent。
 *
 * 策略：
 *  - delta.content 直接 yield 为 token 事件
 *  - delta.tool_calls[i] 按 index 累积（id / function.name / function.arguments 都是分片下发的）
 *  - finish_reason='tool_calls' / 'stop' → flush 累积的 tool_calls（按 index 升序）
 *  - finish_reason='length' / 'content_filter' → yield error 事件并立即 return（不再 yield done）
 *  - 流自然结束（最后一帧通常携带 usage 但没有 choices）：
 *      - 若有残留 pending（说明上游断流，没正常 finish）→ yield error{code:'incomplete_stream'}，不 yield done
 *      - 否则 yield done
 *  - signal.aborted 时静默返回，不再 yield
 */
export async function* parseOpenAIStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  signal?: AbortSignal,
): AsyncGenerator<LLMEvent, void, void> {
  // 入口检查
  if (signal?.aborted) {
    return;
  }

  const pendingByIndex = new Map<number, PendingToolCall>();
  let usage: { inputTokens?: number; outputTokens?: number } | undefined = undefined;
  let earlyTerminated = false;

  for await (const chunk of stream) {
    // 每 chunk 检查
    if (signal?.aborted) {
      return;
    }

    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
    }

    const [choice] = chunk.choices;
    if (choice) {
      const next = yield* handleChoice(choice, pendingByIndex, signal);
      if (next === 'aborted') {
        return;
      }
      if (next === 'terminated') {
        return;
      }
      if (next === 'flushed') {
        earlyTerminated = true;
      }
    }
  }

  // 出循环后（流自然结束）再做一次 abort 检查
  if (signal?.aborted) {
    return;
  }

  // 必修 #2：流自然结束兜底
  if (pendingByIndex.size > 0) {
    yield {
      kind: 'error',
      error: {
        code: 'incomplete_stream',
        message: 'stream ended before tool_call completion',
      },
    };
    return; // 不再 yield done
  }

  // 没有残留：正常结束
  // earlyTerminated 标志防止重复 flush（已在 finish_reason 分支 drain 过）
  void earlyTerminated;
  yield { kind: 'done', usage };
}

type ChoiceOutcome = 'continue' | 'flushed' | 'terminated' | 'aborted';

/**
 * 处理单个 chunk 内的 choice：
 *  - 累积 token / tool_call delta
 *  - finish_reason=length/content_filter → yield error 并返回 'terminated'
 *  - finish_reason=tool_calls/stop → drain pending 并返回 'flushed'
 *  - 其他情况返回 'continue'
 */
async function* handleChoice(
  choice: ChatCompletionChunk.Choice,
  pendingByIndex: Map<number, PendingToolCall>,
  signal: AbortSignal | undefined,
): AsyncGenerator<LLMEvent, ChoiceOutcome, void> {
  const { delta } = choice;

  if (delta.content) {
    yield { kind: 'token', text: delta.content };
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index;
      let pending = pendingByIndex.get(idx);
      if (!pending) {
        pending = { id: '', name: '', argsBuffer: '' };
        pendingByIndex.set(idx, pending);
      }
      if (tc.id && pending.id === '') {
        pending.id = tc.id;
      }
      if (tc.function?.name && pending.name === '') {
        pending.name = tc.function.name;
      }
      if (tc.function?.arguments) {
        pending.argsBuffer += tc.function.arguments;
      }
    }
  }

  // 必修 #1：length / content_filter 抬升为 error，不再 drainPending
  if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
    yield {
      kind: 'error',
      error: {
        message: `output ${choice.finish_reason}`,
        code: choice.finish_reason,
      },
    };
    return 'terminated';
  }

  // finish_reason flush 前再次检查 abort
  if (isTerminalFinishReason(choice.finish_reason)) {
    if (signal?.aborted) {
      return 'aborted';
    }
    yield* drainPending(pendingByIndex);
    return 'flushed';
  }

  return 'continue';
}
