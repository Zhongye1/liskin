import type { ToolCall, ToolResult } from '../types/messages.js';
import type { AgentEvent } from '../types/events.js';

/**
 * Kernel ↔ Client 协议类型（外层协议）。
 *
 * 设计原则（见 docs/architecture/kernel-client-protocol.md §4）：
 * - 全部 plain JSON，可跨进程序列化无损失
 * - Op = 客户端意图；EventMsg = 内核事实
 * - 内层 LLMEvent 永不外泄；内核翻译成 EventMsg
 * - 每个回合用 turnId 聚合，客户端据此把流式事件归并成「一轮」
 */

// —— 会话 —— //

export interface SessionInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** 消息条数（含 system/user/assistant/tool），不含 system 可为 0 */
  messageCount: number;
}

export interface SessionHandle extends SessionInfo {
  /** 是否为新建（首次创建）；resume 时为 false */
  isNew: boolean;
}

// —— 回合内容（MVP 暂用 string；ContentBlock v2 留 Phase 2）—— //

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface NormalizedError {
  message: string;
  code?: string;
}

export type TurnEndReason = 'completed' | 'interrupted' | 'max_turns' | 'error' | 'cancelled';

// —— Op：客户端 → 内核 —— //

export type Op =
  // —— 会话生命周期 —— //
  | { type: 'CreateSession'; cwd?: string; providerId?: string; system?: string }
  | { type: 'ResumeSession'; sessionId: string }
  | { type: 'CloseSession'; sessionId: string }
  | { type: 'ListSessions' }
  // —— 回合 —— //
  | {
      type: 'UserTurn';
      sessionId: string;
      content: string;
      /** 单次 run 内允许的最大 LLM 回合数，默认沿用 kernel 配置 */
      maxTurns?: number;
    }
  | { type: 'Interrupt'; sessionId: string }
  | {
      type: 'ConfirmTool';
      sessionId: string;
      callId: string;
      decision: 'approve' | 'deny';
    }
  | { type: 'Cancel'; sessionId: string };

/**
 * 带会话上下文的 Op（内核 dispatch 时把 sessionId 填好）。
 * ListSessions / CreateSession 无 sessionId。
 */
export type SessionOp = Extract<
  Op,
  | { type: 'ResumeSession' }
  | { type: 'CloseSession' }
  | { type: 'UserTurn' }
  | { type: 'Interrupt' }
  | { type: 'ConfirmTool' }
  | { type: 'Cancel' }
>;

// —— EventMsg：内核 → 客户端 —— //
//
// = AgentEvent 的超集：补 turnId + 会话生命周期 + TurnStart/TurnEnd 包络。
// 映射规则见 docs/architecture/kernel-client-protocol.md §4.3。

export type EventMsg =
  // —— 会话生命周期 —— //
  | { type: 'SessionCreated'; sessionId: string; createdAt: string; isNew: boolean }
  | { type: 'SessionResumed'; sessionId: string; updatedAt: string }
  | { type: 'SessionClosed'; sessionId: string; reason: 'user' | 'error' }
  | { type: 'SessionList'; sessions: SessionInfo[] }
  // —— 回合包络 —— //
  | { type: 'TurnStart'; turnId: string; sessionId: string }
  | {
      type: 'TurnEnd';
      turnId: string;
      sessionId: string;
      reason: TurnEndReason;
      usage?: Usage;
    }
  // —— 回合内事件（全部带 turnId）—— //
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
  | { type: 'Error'; turnId?: string; sessionId?: string; error: NormalizedError };

/** 仅供实现内部引用：把 AgentEvent 归类用的判别器。 */
export type AgentEventKind = AgentEvent['kind'];
