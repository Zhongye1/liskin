export interface ExecOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  cwd: string;
  /** 单次任务最大 LLM 回合数 */
  maxTurns?: number;
  /** 系统提示 */
  system?: string;
}

export interface ExecResult {
  ok: boolean;
  turnEndReason: string;
}
