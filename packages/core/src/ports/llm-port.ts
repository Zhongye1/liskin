import type { Msg, ToolDefinition } from '../types/messages.js';
import type { LLMEvent } from '../types/events.js';

export interface ChatRequest {
  messages: Msg[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface LLMPort {
  /**
   * 流式聊天接口。实现方负责把 OpenAI/Anthropic 等具体协议
   * 翻译成统一的 LLMEvent。
   */
  chatStream(req: ChatRequest): AsyncIterable<LLMEvent>;
}
