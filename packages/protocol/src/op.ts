// —— Op：客户端 → 内核 —— //

export type Op =
  | { type: 'CreateSession'; cwd?: string; providerId?: string; system?: string }
  | { type: 'ResumeSession'; sessionId: string }
  | { type: 'CloseSession'; sessionId: string }
  | { type: 'ListSessions' }
  | {
      type: 'UserTurn';
      sessionId: string;
      content: string;
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

/** 带会话上下文的 Op（内核 dispatch 时 sessionId 已填好）。 */
export type SessionOp = Extract<
  Op,
  | { type: 'ResumeSession' }
  | { type: 'CloseSession' }
  | { type: 'UserTurn' }
  | { type: 'Interrupt' }
  | { type: 'ConfirmTool' }
  | { type: 'Cancel' }
>;

/** submit 接受的 Op 子集。 */
export type SubmitOp = Extract<Op, { type: 'UserTurn' }>;
