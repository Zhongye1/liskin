// L2 Tools & Execution: registry + sandbox + builtin (fs, shell)
// MAY depend on @liskin/core (port interfaces only).
// MUST NOT depend on @liskin/llm, @liskin/server, @liskin/client.

export const __VERSION__ = '0.0.0';

export { ToolRegistry, type ToolRegistryOptions } from './registry.js';
export type { ToolImpl, ToolExecContext, ToolExecCallbacks } from './types.js';

// Tool 抽象层
export {
  defineTool,
  InvalidArgumentsError,
  type ToolDef,
  type ToolExecResult,
  type ToolContext,
} from './tool-define.js';

export { fsRead, fsWrite, shellExec, builtins } from './builtin/index.js';

export { type ConfirmPolicy, applyConfirmPolicy } from './sandbox/confirm-policy.js';
export { checkPathAllowed, type PathPolicy, type PathCheckResult } from './sandbox/path-policy.js';
export {
  checkCommandAllowed,
  DEFAULT_BLOCKED_PATTERNS,
  type CommandPolicy,
  type CommandCheckResult,
} from './sandbox/command-policy.js';
