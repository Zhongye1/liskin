import type { LLMEvent } from '@liskin/core';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

export async function* mockChunks(
  chunks: ChatCompletionChunk[],
): AsyncGenerator<ChatCompletionChunk, void, void> {
  for (const c of chunks) {
    yield c;
  }
}

export async function collect(gen: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
  }
  return out;
}

/** 构造一个最小可用的 ChatCompletionChunk。 */
export function makeChunk(partial: Partial<ChatCompletionChunk>): ChatCompletionChunk {
  return {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [],
    ...partial,
  } as ChatCompletionChunk;
}
