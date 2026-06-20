/**
 * API 层类型定义：HTTP 请求/响应体 + Provider 类型。
 * 协议类型（KernelClient / EventMsg / SessionHandle 等）统一从 @liskin/protocol import。
 */
import type { KernelClient, SessionRecord } from '@liskin/protocol';

// —— 基础 —— //

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// —— 从 protocol 重导出 —— //
export type { KernelClient, SessionRecord };

export interface CreateSessionBody {
  cwd?: string;
  system?: string;
}

export interface UserTurnBody {
  content: string;
  maxTurns?: number;
}

export interface ConfirmBody {
  callId: string;
  decision: 'approve' | 'deny';
}

// —— Provider —— //

export interface ProviderView {
  id: string;
  name: string;
  protocol: string;
  baseURL?: string;
  model: string;
  apiKey: string;
  organization?: string;
  timeout?: number;
  maxRetries?: number;
  isActive: boolean;
  source: 'env' | 'user';
}

export interface ProviderCreateInput {
  id: string;
  name: string;
  protocol: string;
  baseURL?: string;
  model: string;
  apiKey: string;
  organization?: string;
  timeout?: number;
  maxRetries?: number;
}
export type ProviderUpdateInput = Partial<Omit<ProviderCreateInput, 'id'>>;
