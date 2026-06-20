/**
 * API 层类型定义：集中管理所有接口的请求/响应类型。
 */
import type {
  EventMsg,
  SessionHandle,
  SessionInfo,
  SessionRecord,
  ToolCall,
  ToolDefinition,
} from '@liskin/core';

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

// —— 从 core 重导出 Web 需要的类型 —— //
export type {
  EventMsg,
  SessionHandle,
  SessionInfo,
  SessionRecord,
  ToolCall,
  ToolDefinition,
};

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

// —— KernelClient 接口（与 @liskin/protocol 的 KernelClient 同形）—— //

export interface KernelClient {
  createSession(opts?: { cwd?: string; system?: string }): Promise<SessionHandle>;
  resumeSession(sessionId: string): Promise<SessionHandle>;
  getRecord(sessionId: string): Promise<SessionRecord>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  submit(op: {
    sessionId: string;
    content: string;
    maxTurns?: number;
  }): AsyncIterable<EventMsg>;
  interrupt(sessionId: string): Promise<void>;
  confirmTool(
    sessionId: string,
    callId: string,
    decision: 'approve' | 'deny',
  ): Promise<void>;
}
