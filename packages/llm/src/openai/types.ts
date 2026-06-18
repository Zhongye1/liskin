export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
  organization?: string;
  timeout?: number;
  /**
   * 透传给 OpenAI SDK 的 maxRetries（应修 #7）。不写默认值，由 SDK 的默认值（当前为 2）兜底。
   */
  maxRetries?: number;
}
