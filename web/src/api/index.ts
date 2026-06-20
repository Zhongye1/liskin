/**
 * @liskin/web API 层
 *
 * 集中管理所有后端接口请求，分为两类通道：
 * - 控制类（http.ts）：axios 实例，短请求（session CRUD、interrupt、confirm、provider CRUD）
 * - 流式类（stream.ts）：fetch + ReadableStream，SSE 长连接消费
 *
 * 对上层暴露统一的 KernelClient 接口（client.ts），axios/fetch 差异封在内部。
 */

// 类型
export {
  ApiError,
  type KernelClient,
  type SessionRecord,
  type CreateSessionBody,
  type UserTurnBody,
  type ConfirmBody,
  type ProviderView,
  type ProviderCreateInput,
  type ProviderUpdateInput,
} from './types/types';
export type { EventMsg, SessionHandle, SessionInfo } from './types/types';

// 客户端
export { HttpSseKernelClient } from './client';

// 底层通道（按需直接使用）
export { sessions, providers, tools } from './Http_Req/http';
export { streamRequest, parseSSEBlock } from './Http_Req/stream';
