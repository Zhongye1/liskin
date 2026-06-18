export interface HarnessPort {
  /** 是否需要为本次任务创建 harness（M1 noop 始终返回 false） */
  shouldCreate(intent: { firstUserMessage: string }): Promise<boolean>;
  /** 创建 harness（M1 noop 直接返回） */
  create?(intent: { firstUserMessage: string }): Promise<void>;
  /** 记录单节点结果（M1 noop） */
  recordNodeResult?(node: {
    id: string;
    status: 'DONE' | 'FAILED';
    summary?: string;
  }): Promise<void>;
  /** 完成（M1 noop） */
  complete?(): Promise<void>;
}
