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
} from './render.js';

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
}

interface SigintState {
  turnInProgress: boolean;
  pendingConfirm: { sessionId: string; callId: string } | undefined;
}

// —— 入口 —— //

export async function runChat(opts: ChatOptions): Promise<void> {
  const llm = createProvider({
    id: 'chat',
    name: 'chat',
    protocol: 'openai-compatible',
    apiKey: opts.apiKey,
    model: opts.model,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  const confirmPolicy = opts.confirmPolicy ?? 'ask';
  const tools = new ToolRegistry({
    cwd: opts.cwd,
    pathWhitelist: [opts.cwd],
    confirmPolicy,
  });

  const store = opts.noSave
    ? new InMemoryStore()
    : new SqliteStore(opts.dbPath ?? defaultChatDbPath());

  const kernel = new InProcessKernelClient({
    llm,
    tools,
    store,
    maxTurns: opts.maxTurns ?? 24,
  });

  let sessionId = '';
  if (opts.resume) {
    const resumed = await kernel.resumeSession(opts.resume);
    sessionId = resumed.id;
    log(`[liskin] resumed session ${sessionId}`);
  } else {
    const created = await kernel.createSession({
      cwd: opts.cwd,
      system: opts.system,
    });
    sessionId = created.id;
  }

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

  log(`[liskin] chat session: ${sessionId}`);
  log(`[liskin] cwd=${opts.cwd}  confirm=${confirmPolicy}`);
  log('[liskin] type /exit to quit, /help for commands\n');

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
      } else if (trimmed) {
        await processTurn(kernel, sessionId, trimmed, opts.maxTurns ?? 24, confirmPolicy, rl, sig);
        process.stdout.write('\n');
      }
    }
  } finally {
    rl.close();
    if (!opts.noSave) {
      await kernel.closeSession(sessionId);
    }
  }
}

// —— Turn 处理 —— //

async function processTurn(
  kernel: InProcessKernelClient,
  sessionId: string,
  content: string,
  maxTurns: number,
  confirmPolicy: 'auto' | 'ask' | 'deny',
  rl: Readline,
  sig: SigintState,
): Promise<void> {
  sig.turnInProgress = true;

  const stream = kernel.submit({
    type: 'UserTurn',
    sessionId,
    content,
    maxTurns,
  });

  for await (const ev of stream) {
    if (!sig.turnInProgress) {
      break;
    }

    switch (ev.type) {
      case 'TurnStart': {
        break;
      }
      case 'Token': {
        writeToken(ev.text);
        break;
      }
      case 'ToolCall': {
        writeToolCall(ev.call);
        break;
      }
      case 'ToolProgress': {
        writeToolProgress(ev.chunk);
        break;
      }
      case 'ToolResult': {
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
        await kernel.confirmTool(sessionId, ev.call.id, decision);
        break;
      }
      case 'TurnEnd': {
        if (ev.reason !== 'completed' && ev.reason !== 'interrupted') {
          writeStatus(ev.reason);
        }
        break;
      }
      case 'Error': {
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

Key bindings:
  Ctrl-C      Interrupt current turn (or exit at empty prompt)
  Ctrl-C x2   Force exit

Tips:
  Type any message to start a conversation with the agent.
  When the agent wants to run a tool, you'll be asked to confirm [y/n].
  Use agent chat --resume <id> to continue a previous session.
\n`);
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
