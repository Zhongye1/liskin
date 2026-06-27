import type { LogLevel } from '../logger/index.js';

// —— 类型 —— //

export interface ChatOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  cwd: string;
  maxTurns?: number;
  system?: string;
  resume?: string;
  noSave?: boolean;
  dbPath?: string;
  confirmPolicy?: 'auto' | 'ask' | 'deny';
  logLevel?: LogLevel;
  logVerbose?: boolean;
}

export interface SigintState {
  turnInProgress: boolean;
  pendingConfirm: { sessionId: string; callId: string } | undefined;
}
