/**
 * agent exec: headless 一次性消费器。
 *
 * 用 InProcessKernelClient 直连 kernel（in-process，无 daemon），
 * 把 EventMsg 流渲染成终端文本，auto 批准工具调用。
 *
 * 设计依据：docs/architecture/kernel-client-protocol.md §6.3 Step 2。
 * headless 是「不渲染 UI 的事件消费者」，与 agent chat 同根协议。
 */
import { InMemoryStore, InProcessKernelClient, type EventMsg } from '@liskin/core';
import { createProvider } from '@liskin/llm';
import { ToolRegistry } from '@liskin/tools';

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

/**
 * 运行一次任务，把事件流打印到 stdout/stderr。
 * 返回最终 TurnEnd 的 reason。
 */
export async function runExec(prompt: string, opts: ExecOptions): Promise<ExecResult> {
  const llm = createProvider({
    id: 'exec',
    name: 'exec',
    protocol: 'openai-compatible',
    apiKey: opts.apiKey,
    model: opts.model,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  const tools = new ToolRegistry({
    cwd: opts.cwd,
    pathWhitelist: [opts.cwd],
    confirmPolicy: 'auto',
  });

  const kernel = new InProcessKernelClient({
    llm,
    tools,
    store: new InMemoryStore(),
    maxTurns: opts.maxTurns ?? 24,
  });

  const session = await kernel.createSession({
    cwd: opts.cwd,
    system: opts.system,
  });

  let lastReason = 'unknown';
  const stream = kernel.submit({
    type: 'UserTurn',
    sessionId: session.id,
    content: prompt,
    maxTurns: opts.maxTurns,
  });

  for await (const ev of stream) {
    lastReason = render(ev, lastReason);
  }

  const ok = lastReason === 'completed';
  return { ok, turnEndReason: lastReason };
}

/** 把单个 EventMsg 渲染成终端输出，返回当前 turn 状态 reason。 */
function render(ev: EventMsg, prevReason: string): string {
  switch (ev.type) {
    case 'TurnStart': {
      return prevReason;
    }
    case 'Token': {
      process.stdout.write(ev.text);
      return prevReason;
    }
    case 'ToolCall': {
      process.stdout.write(`\n\u001B[36m▸ ${ev.call.name}\u001B[0m ${formatArgs(ev.call.args)}\n`);
      return prevReason;
    }
    case 'ToolProgress': {
      process.stdout.write(ev.chunk);
      return prevReason;
    }
    case 'ToolResult': {
      process.stdout.write(
        `\u001B[${ev.result.ok ? '32' : '31'}m✓\u001B[0m ${truncate(ev.result.content)}\n`,
      );
      return prevReason;
    }
    case 'ToolConfirmRequired': {
      process.stderr.write(`\n[confirm required] ${ev.call.name} (auto-approved)\n`);
      return prevReason;
    }
    case 'TurnEnd': {
      return ev.reason;
    }
    case 'Error': {
      process.stderr.write(`\n\u001B[31m✗ ${ev.error.message}\u001B[0m\n`);
      return 'error';
    }
    default: {
      return prevReason;
    }
  }
}

function formatArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return '';
  }
  const obj = args as Record<string, unknown>;
  if (typeof obj.cmd === 'string') {
    return `$ ${obj.cmd}`;
  }
  if (typeof obj.path === 'string') {
    return obj.path;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

function truncate(text: string, max = 500): string {
  const one = text.replaceAll('\n', ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
