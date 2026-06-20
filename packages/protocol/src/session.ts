// —— 会话元信息 —— //

export interface SessionInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionHandle extends SessionInfo {
  isNew: boolean;
}
