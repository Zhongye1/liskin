/**
 * agent chat: 交互式 REPL。
 *
 * 用 InProcessKernelClient 直连 kernel（in-process），终端内多轮对话。
 * 设计依据：docs/architecture/kernel-client-protocol.md §6.3 Step 2。
 */
import { createInterface, type Interface as Readline } from 'node:readline';

import { defaultChatDbPath } from '@liskin/config';
import { InMemoryStore, InProcessKernelClient } from '@liskin/core';
import { createProvider } from '@liskin/llm';
import { SqliteStore } from '@liskin/server';
import { ToolRegistry } from '@liskin/tools';

import {
  writeToken,
  writeToolCall,
  writeToolProgress,
  writeToolResult,
  writeError,
  writeStatus,
  formatArgs,
} from '../render/index.js';
import { createLogger, type StructuredLogger } from '../logger/index.js';
import type { ChatOptions, SigintState } from './types.js';

// —— 入口 —— //

export async function runChat(opts: ChatOptions): Promise<void> {
  let sessionId = '';
  let logger: StructuredLogger | undefined = undefined;

  try {
    // 先创建会话获取 sessionId，再初始化 logger
    const tempLlm = createProvider({
      id: 'chat',
      name: 'chat',
      protocol: 'openai-compatible',
      apiKey: opts.apiKey,
      model: opts.model,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });

    const tempTools = new ToolRegistry({
      cwd: opts.cwd,
      pathWhitelist: [opts.cwd],
      confirmPolicy: opts.confirmPolicy ?? 'ask',
    });

    const store = opts.noSave
      ? new InMemoryStore()
      : new SqliteStore(opts.dbPath ?? defaultChatDbPath());

    const tempKernel = new InProcessKernelClient({
      llm: tempLlm,
      tools: tempTools,
      store,
      maxTurns: opts.maxTurns ?? 24,
    });

    if (opts.resume) {
      const resumed = await tempKernel.resumeSession(opts.resume);
      sessionId = resumed.id;
    } else {
      const created = await tempKernel.createSession({
        cwd: opts.cwd,
        system: opts.system,
      });
      sessionId = created.id;
    }

    // 初始化结构化日志记录器（默认开启）
    logger = createLogger(sessionId, {
      level: opts.logLevel ?? 'info',
      verbose: opts.logVerbose ?? false,
    });

    // 输出日志提示
    const logPath = logger.getLogFilePath() ?? 'unknown';
    const logLevel = logger.getLevel();
    log(`[liskin] logging to ${logPath} (level: ${logLevel})`);

    // 用 logger 重新创建 LLM provider 和 ToolRegistry
    const llm = createProvider(
      {
        id: 'chat',
        name: 'chat',
        protocol: 'openai-compatible',
        apiKey: opts.apiKey,
        model: opts.model,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      },
      { logger },
    );

    const confirmPolicy = opts.confirmPolicy ?? 'ask';
    const tools = new ToolRegistry({
      cwd: opts.cwd,
      pathWhitelist: [opts.cwd],
      confirmPolicy,
      logger,
    });

    const kernel = new InProcessKernelClient({
      llm,
      tools,
      store,
      maxTurns: opts.maxTurns ?? 24,
    });

    log(`[liskin] chat session: ${sessionId}`);
    log(`[liskin] cwd=${opts.cwd}  confirm=${confirmPolicy}`);
    log('[liskin] type /exit to quit, /help for commands\n');

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const sig = { turnInProgress: false, pendingConfirm: undefined } as SigintState;

    process.on('SIGINT', () => {
      if (sig.pendingConfirm) {
        void kernel
          .confirmTool(sig.pendingConfirm.sessionId, sig.pendingConfirm.callId, 'deny')
          .catch(swallow);
        sig.pendingConfirm = undefined;
        return;
      }
      if (sig.turnInProgress) {
        void kernel.interrupt(sessionId).catch(swallow);
        process.stdout.write('\n');
        writeStatus('interrupted');
        sig.turnInProgress = false;
        return;
      }
      rl.close();
      process.stdout.write('\n');
      process.exit(0);
    });

    try {
      for (;;) {
        const line = await question(rl, '> ');
        const trimmed = line?.trim();

        if (trimmed === '/exit') {
          break;
        }
        if (trimmed === '/help') {
          showHelp();
        } else if (trimmed === '/sessions') {
          await showSessions(kernel);
        } else if (trimmed === '/logs') {
          showLogsInfo(logger);
        } else if (trimmed) {
          logger.info('user.input', { content: trimmed });
          await processTurn(
            kernel,
            sessionId,
            trimmed,
            opts.maxTurns ?? 24,
            confirmPolicy,
            rl,
            sig,
            logger,
          );
          process.stdout.write('\n');
        }
      }
    } finally {
      rl.close();
      await logger.close();
      if (!opts.noSave) {
        await kernel.closeSession(sessionId);
      }
    }
  } catch (error) {
    if (logger) {
      logger.error('error', {
        error_message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      await logger.close().catch(swallow);
    }
    throw error;
  }
}

// —— Turn 处理 —— //

// eslint-disable-next-line max-params -- 内部函数，bundle kernel/rl/sig 等上下文参数，拆对象属过度工程
async function processTurn(
  kernel: InProcessKernelClient,
  sessionId: string,
  content: string,
  maxTurns: number,
  confirmPolicy: 'auto' | 'ask' | 'deny',
  rl: Readline,
  sig: SigintState,
  logger: StructuredLogger,
): Promise<void> {
  sig.turnInProgress = true;

  const stream = kernel.submit({
    type: 'UserTurn',
    sessionId,
    content,
    maxTurns,
  });

  // 当前 turn 的 logger（带 turn_id）
  let turnLogger: StructuredLogger | undefined = undefined;

  for await (const ev of stream) {
    if (!sig.turnInProgress) {
      break;
    }

    switch (ev.type) {
      case 'TurnStart': {
        turnLogger = logger.with({ turn_id: ev.turnId });
        turnLogger.info('turn.start', { turn_id: ev.turnId });
        break;
      }
      case 'Token': {
        writeToken(ev.text);
        break;
      }
      case 'ToolCall': {
        // 派生带 tool_call_id 的 logger
        if (turnLogger) {
          const toolLogger = turnLogger.with({ tool_call_id: ev.call.id });
          // 注意：tool.call 事件已由 ToolRegistry 记录，此处不重复记录
          void toolLogger; // 保留引用以备将来使用
        }
        writeToolCall(ev.call);
        break;
      }
      case 'ToolProgress': {
        writeToolProgress(ev.chunk);
        break;
      }
      case 'ToolResult': {
        // 注意：tool.result 事件已由 ToolRegistry 记录
        writeToolResult(ev.result);
        break;
      }
      case 'ToolConfirmRequired': {
        sig.pendingConfirm = { sessionId, callId: ev.call.id };
        const decision =
          confirmPolicy === 'ask' ? await askConfirm(rl, ev.call.name, ev.call.args) : 'approve';
        sig.pendingConfirm = undefined;
        if (!sig.turnInProgress) {
          break;
        }
        if (turnLogger) {
          turnLogger.info('tool.confirm', {
            tool_name: ev.call.name,
            decision,
          });
        }
        await kernel.confirmTool(sessionId, ev.call.id, decision);
        break;
      }
      case 'TurnEnd': {
        if (turnLogger) {
          turnLogger.info('turn.end', {
            turn_id: ev.turnId,
            reason: ev.reason,
          });
        }
        if (ev.reason !== 'completed' && ev.reason !== 'interrupted') {
          writeStatus(ev.reason);
        }
        break;
      }
      case 'Error': {
        if (turnLogger) {
          turnLogger.error('error', {
            error_message: ev.error.message,
            stack: ev.error.stack,
          });
        } else {
          logger.error('error', {
            error_message: ev.error.message,
            stack: ev.error.stack,
          });
        }
        writeError(ev.error.message);
        break;
      }
      default: {
        break;
      }
    }
  }

  sig.turnInProgress = false;
}

// —— 辅助函数 —— //

/** 吞掉 rejected promise（fire-and-forget 模式用）。 */
function swallow(_: unknown): void {
  void _;
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function question(rl: Readline, prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function askConfirm(
  rl: Readline,
  toolName: string,
  args: unknown,
): Promise<'approve' | 'deny'> {
  const formatted = formatArgs(args);
  const answer = await question(rl, `[33m⚠ ${toolName} ${formatted}[0m [y/n] `);
  return answer.trim().toLowerCase().startsWith('y') ? 'approve' : 'deny';
}

function showHelp(): void {
  process.stdout.write(`
Commands:
  /exit       Quit the REPL
  /help       Show this help
  /sessions   List saved sessions
  /logs       Show log file path and current log level

Key bindings:
  Ctrl-C      Interrupt current turn (or exit at empty prompt)
  Ctrl-C x2   Force exit

Tips:
  Type any message to start a conversation with the agent.
  When the agent wants to run a tool, you'll be asked to confirm [y/n].
  Use agent chat --resume <id> to continue a previous session.
  Logging is enabled by default. Use --log-level to adjust verbosity.
\n`);
}

function showLogsInfo(logger: StructuredLogger): void {
  const logPath = logger.getLogFilePath();
  const logLevel = logger.getLevel();
  const metrics = logger.getMetrics();
  process.stdout.write(`\nLog file: ${logPath ?? 'unknown'}\n`);
  process.stdout.write(`Log level: ${logLevel}\n`);
  process.stdout.write(`Queue length: ${metrics.queueLength}\n`);
  process.stdout.write(`Dropped entries: ${metrics.dropped}\n\n`);
}

async function showSessions(kernel: InProcessKernelClient): Promise<void> {
  const sessions = await kernel.listSessions();
  if (sessions.length === 0) {
    process.stdout.write('No saved sessions.\n\n');
    return;
  }
  process.stdout.write('\nSaved sessions:\n');
  for (const s of sessions) {
    const date = new Date(s.updatedAt).toLocaleString();
    process.stdout.write(`  ${s.id}  msgs=${s.messageCount}  updated=${date}\n`);
  }
  process.stdout.write('\n');
}
