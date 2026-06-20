/**
 * @liskin/web API 层
 *
 * 集中管理所有后端接口请求，分为两类通道：
 * - 控制类（http.ts）：axios 实例，短请求
 * - 流式类（stream.ts）：fetch + ReadableStream，SSE 长连接
 *
 * 协议类型（KernelClient / EventMsg / SessionHandle 等）统一来自 @liskin/protocol。
 */

// —— 协议类型（来自 @liskin/protocol）—— //
export type {
  EventMsg,
  KernelClient,
  SessionHandle,
  SessionInfo,
  SessionRecord,
} from '@liskin/protocol';

// —— API 层专属类型 —— //
export {
  ApiError,
  type CreateSessionBody,
  type UserTurnBody,
  type ConfirmBody,
  type ProviderView,
  type ProviderCreateInput,
  type ProviderUpdateInput,
} from './types/types';

// —— 客户端 —— //
export { HttpSseKernelClient } from './client';

// —— 底层通道 —— //
export { sessions, providers, tools } from './Http_Req/http';
export { streamRequest, parseSSEBlock } from './Http_Req/stream';
