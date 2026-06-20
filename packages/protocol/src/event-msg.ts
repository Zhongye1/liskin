import type { ToolCall, ToolResult } from './tool-types.js';
import type { SessionInfo } from './session.js';

// —— EventMsg：内核 → 客户端 —— //

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface NormalizedError {
  message: string;
  code?: string;
}

export type TurnEndReason = 'completed' | 'interrupted' | 'max_turns' | 'error' | 'cancelled';

export type EventMsg =
  | { type: 'SessionCreated'; sessionId: string; createdAt: string; isNew: boolean }
  | { type: 'SessionResumed'; sessionId: string; updatedAt: string }
  | { type: 'SessionClosed'; sessionId: string; reason: 'user' | 'error' }
  | { type: 'SessionList'; sessions: SessionInfo[] }
  | { type: 'TurnStart'; turnId: string; sessionId: string }
  | {
      type: 'TurnEnd';
      turnId: string;
      sessionId: string;
      reason: TurnEndReason;
      usage?: Usage;
    }
  | { type: 'Token'; turnId: string; text: string }
  | { type: 'ToolCall'; turnId: string; call: ToolCall }
  | {
      type: 'ToolProgress';
      turnId: string;
      callId: string;
      stream: 'stdout' | 'stderr';
      chunk: string;
    }
  | { type: 'ToolResult'; turnId: string; result: ToolResult }
  | { type: 'ToolConfirmRequired'; turnId: string; call: ToolCall }
  | {
      type: 'Error';
      turnId?: string;
      sessionId?: string;
      error: NormalizedError;
    };
