// L3 LLM Adapter: LLMProvider interface + OpenAI/Anthropic implementations
// MAY depend on @liskin/core (port interfaces only). MUST NOT depend on @liskin/tools, @liskin/server, @liskin/client.

export const __VERSION__ = '0.0.0';

export { OpenAIProvider } from './openai/provider.js';
export type { OpenAIProviderOptions } from './openai/types.js';
export { createProvider } from './factory.js';
