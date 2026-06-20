import type { LLMEvent } from '@liskin/core';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { resolveOriginalName, type ToolNameMap } from './translate.js';

interface PendingToolCall {
  id: string;
  name: string;
  argsBuffer: string;
}

/**
 * 把单个 PendingToolCall 转换为一个或多个 LLMEvent。
 * - 缺 id 或 name → 跳过
 * - args JSON.parse 失败 → yield error 事件
 * - 正常 → yield tool_call 事件，name 反查为原名
 */
function* toolCallEventsFor(
  pending: PendingToolCall,
  nameMap?: ToolNameMap,
): Generator<LLMEvent, void, void> {
  if (pending.id === '' || pending.name === '') {
    return;
  }

  let parsedArgs: unknown = {};
  if (pending.argsBuffer !== '') {
    try {
      parsedArgs = JSON.parse(pending.argsBuffer);
    } catch {
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
    call: {
      id: pending.id,
      name: resolveOriginalName(pending.name, nameMap),
      args: parsedArgs as Record<string, unknown>,
    },
  };
}

function* drainPending(
  pendingByIndex: Map<number, PendingToolCall>,
  nameMap?: ToolNameMap,
): Generator<LLMEvent, void, void> {
  if (pendingByIndex.size === 0) {
    return;
  }
  const indices = [...pendingByIndex.keys()];
  indices.sort((a, b) => a - b);
  for (const idx of indices) {
    const pending = pendingByIndex.get(idx);
    if (pending) {
      yield* toolCallEventsFor(pending, nameMap);
    }
  }
  pendingByIndex.clear();
}

function isTerminalFinishReason(
  reason: ChatCompletionChunk.Choice['finish_reason'] | null | undefined,
): boolean {
  return reason === 'tool_calls' || reason === 'stop';
}

/**
 * 把 OpenAI 流式响应解析为 LLMEvent。
 *
 * @param stream  OpenAI SSE 流
 * @param signal  可选的 AbortSignal
 * @param nameMap 可选的 sanitized→original 工具名映射（用于还原被 API 规范化的名称）
 */
export async function* parseOpenAIStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  signal?: AbortSignal,
  nameMap?: ToolNameMap,
): AsyncGenerator<LLMEvent, void, void> {
  if (signal?.aborted) {
    return;
  }

  const pendingByIndex = new Map<number, PendingToolCall>();
  // eslint-disable-next-line init-declarations -- 跨 chunk 累积，初始值由第一个 usage chunk 赋值
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let earlyTerminated = false;

  for await (const chunk of stream) {
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
      const next = yield* handleChoice(choice, pendingByIndex, signal, nameMap);
      if (next === 'aborted' || next === 'terminated') {
        return;
      }
      if (next === 'flushed') {
        earlyTerminated = true;
      }
    }
  }

  if (signal?.aborted) {
    return;
  }

  if (pendingByIndex.size > 0) {
    yield {
      kind: 'error',
      error: {
        code: 'incomplete_stream',
        message: 'stream ended before tool_call completion',
      },
    };
    return;
  }

  void earlyTerminated;
  yield { kind: 'done', usage };
}

type ChoiceOutcome = 'continue' | 'flushed' | 'terminated' | 'aborted';

// eslint-disable-next-line max-params -- signal + nameMap 是必要的透传，拆对象无意义
async function* handleChoice(
  choice: ChatCompletionChunk.Choice,
  pendingByIndex: Map<number, PendingToolCall>,
  signal: AbortSignal | undefined,
  nameMap: ToolNameMap | undefined,
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

  if (isTerminalFinishReason(choice.finish_reason)) {
    if (signal?.aborted) {
      return 'aborted';
    }
    yield* drainPending(pendingByIndex, nameMap);
    return 'flushed';
  }

  return 'continue';
}
