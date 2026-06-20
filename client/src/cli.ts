#!/usr/bin/env node

// bin.agent 的入口文件，负责解析命令行参数、装配依赖、分发到子命令。
// 解析参数、读 config、检查 apiKey
// 调用 runExec(prompt, opts)

// shebang + imports
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';

// liskin 内部模块
import type { ProviderConfig } from '@liskin/core';
import { ToolRegistry } from '@liskin/tools';
import { startServer } from '@liskin/server';
import { runExec } from './exec.js';
import { runChat } from './chat.js';

// cli 接口类型定义
import type { Config } from './types/cli-config.js';

// 默认系统提示词
import { DEFAULT_SYSTEM_PROMPT } from './prompts/default-system.js';

// 读 ~/.liskin/config.json 相关配置
function loadConfig(): Config {
  const configPath = join(homedir(), '.liskin', 'config.json');
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  } catch (error) {
    console.error(`[liskin] failed to read ${configPath}:`, (error as Error).message);
    return {};
  }
}

// 确保~/.liskin/目录存在 + 返回 db 路径
function defaultDbPath(): string {
  const dir = join(homedir(), '.liskin');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'sessions.sqlite');
}

// 注册新命令 agent
// agent serve [--port 8787] [--host 127.0.0.1] [--db <path>]
//             [--cwd <path>] [--confirm auto|ask|deny] [--cors <origin>]

const program = new Command();
program.name('agent').description('liskin local coding agent').version('0.0.0');

program
  .command('serve')
  .description('Start the local agent HTTP/SSE server')
  .option('-p, --port <port>', 'port to listen on', (v) => Number.parseInt(v, 10), 8787)
  .option('-h, --host <host>', 'host to bind', '127.0.0.1')
  .option('--db <path>', 'sqlite db path')
  .option('--cwd <path>', 'sandbox cwd / path whitelist root', process.cwd())
  .option(
    '--confirm <policy>',
    'tool confirm policy: auto | ask | deny',
    (v: string): 'auto' | 'ask' | 'deny' => {
      if (v !== 'auto' && v !== 'ask' && v !== 'deny') {
        throw new Error(`invalid --confirm: ${v}`);
      }
      return v;
    },
  )
  .option('--cors <origin>', 'allowed CORS origin (repeatable)', collect, [] as string[])
  .action(async (raw: Record<string, unknown>) => {
    const cfg = loadConfig();

    // 解析模型api相关
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.LISKIN_API_KEY ?? cfg.apiKey;
    const baseURL = process.env.OPENAI_BASE_URL ?? cfg.baseURL;
    const model = process.env.LISKIN_MODEL ?? cfg.model;

    // 解析 port/host/db/cwd/confirm
    const port = Number(raw.port ?? cfg.port ?? 8787);
    const host = (raw.host as string | undefined) ?? cfg.host ?? '127.0.0.1';
    const dbPath = (raw.db as string | undefined) ?? cfg.dbPath ?? defaultDbPath();
    const cwd = resolve((raw.cwd as string | undefined) ?? process.cwd());
    const confirmPolicy =
      (raw.confirm as 'auto' | 'ask' | 'deny' | undefined) ?? cfg.confirmPolicy ?? 'ask';
    const corsList = (raw.cors as string[] | undefined) ?? [];
    const corsOrigin = corsList.length > 0 ? corsList : cfg.corsOrigin;

    // 确保db path 父级path存在
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // 如果 apiKey 存在，生成 id='env' 的种子配置
    // 仅当 apiKey 存在时构造 envSeed；envSeed 只在 DB 没有同 id 时写入（保留用户改动）
    const envSeed: ProviderConfig | undefined = apiKey
      ? {
          id: 'env',
          name: 'Env (seeded)',
          protocol: 'openai-compatible',
          apiKey,
          model: model ?? 'gpt-4o-mini',
          ...(baseURL ? { baseURL } : {}),
        }
      : undefined;
    if (!apiKey) {
      console.warn(
        '[liskin] no API key found in env / config; starting without an env-seeded provider. ' +
          'Configure one via Web UI (POST /v1/providers).',
      );
      console.warn(
        '[liskin] 未在env中找到模型Api key / 配置; 在无 env-seeded provider 情况下启动 ' +
          '在webUI中进行配置(POST /v1/providers).',
      );
    }

    const tools = new ToolRegistry({
      cwd,
      pathWhitelist: cfg.pathWhitelist ?? [cwd],
      confirmPolicy,
    });

    const server = startServer({
      port,
      host,
      dbPath,
      tools,
      ...(corsOrigin ? { corsOrigin } : {}),
      ...(envSeed ? { envSeed } : {}),
    });
    console.log(`[liskin] agent serving on ==> ${server.url}`);
    console.log(`[liskin] cwd=${cwd}  db=${dbPath}  confirm=${confirmPolicy}`);

    const shutdown = async (signal: string) => {
      console.log(`[liskin] received ${signal}, shutting down`);
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  });

program
  .command('exec')
  .description('Run a one-shot task headlessly (in-process, no daemon)')
  .argument('<prompt>', 'task prompt')
  .option('--cwd <path>', 'working directory', process.cwd())
  .option('--model <model>', 'model id')
  .option('--base-url <url>', 'LLM base URL')
  .option('--max-turns <n>', 'max LLM turns', (v) => Number.parseInt(v, 10), 24)
  .option('--system <text>', 'system prompt')
  .action(async (prompt: string, raw: Record<string, unknown>) => {
    const cfg = loadConfig();
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.LISKIN_API_KEY ?? cfg.apiKey;
    const baseURL =
      (process.env.OPENAI_BASE_URL as string | undefined) ??
      (raw.baseUrl as string | undefined) ??
      cfg.baseURL;
    const model = String(raw.model ?? process.env.LISKIN_MODEL ?? cfg.model ?? 'gpt-4o-mini');
    const cwd = resolve(String(raw.cwd ?? process.cwd()));
    const maxTurns = Number(raw.maxTurns ?? 24);
    const system = (raw.system as string | undefined) ?? DEFAULT_SYSTEM_PROMPT;

    if (!apiKey) {
      console.error(
        '[liskin] no API key: set OPENAI_API_KEY / LISKIN_API_KEY or ~/.liskin/config.json',
      );
      process.exit(1);
    }

    // 运行 Agent exec
    const result = await runExec(prompt, {
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      model,
      cwd,
      maxTurns,
      system,
    });

    if (!result.ok) {
      console.error(`[liskin] exec ended: ${result.turnEndReason}`);
      process.exit(1);
    }
    console.error(`[liskin] exec done: ${result.turnEndReason}`);
  });

program
  .command('chat')
  .description('Start interactive REPL (in-process, no daemon)')
  .option('--cwd <path>', 'working directory', process.cwd())
  .option('--model <model>', 'model id')
  .option('--base-url <url>', 'LLM base URL')
  .option('--max-turns <n>', 'max LLM turns per round', (v) => Number.parseInt(v, 10), 24)
  .option('--system <text>', 'system prompt')
  .option('--resume <id>', 'resume a previous session')
  .option('--no-save', 'do not persist session (use in-memory store)')
  .option('--db <path>', 'sqlite db path for session persistence')
  .option(
    '--confirm <policy>',
    'tool confirm policy: auto | ask | deny (default: ask)',
    (v: string): 'auto' | 'ask' | 'deny' => {
      if (v !== 'auto' && v !== 'ask' && v !== 'deny') {
        throw new Error(`invalid --confirm: ${v}`);
      }
      return v;
    },
  )
  .action(async (raw: Record<string, unknown>) => {
    const cfg = loadConfig();
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.LISKIN_API_KEY ?? cfg.apiKey;
    const baseURL =
      (process.env.OPENAI_BASE_URL as string | undefined) ??
      (raw.baseUrl as string | undefined) ??
      cfg.baseURL;
    const model = String(raw.model ?? process.env.LISKIN_MODEL ?? cfg.model ?? 'gpt-4o-mini');
    const cwd = resolve(String(raw.cwd ?? process.cwd()));
    const maxTurns = Number(raw.maxTurns ?? 24);
    const system = (raw.system as string | undefined) ?? DEFAULT_SYSTEM_PROMPT;
    const resume = raw.resume as string | undefined;
    const noSave = Boolean(raw.noSave);
    const dbPath = (raw.db as string | undefined) ?? cfg.dbPath;
    const confirmPolicy =
      (raw.confirm as 'auto' | 'ask' | 'deny' | undefined) ?? cfg.confirmPolicy ?? 'ask';

    if (!apiKey) {
      console.error(
        '[liskin] no API key: set OPENAI_API_KEY / LISKIN_API_KEY or ~/.liskin/config.json',
      );
      process.exit(1);
    }

    await runChat({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      model,
      cwd,
      maxTurns,
      system,
      ...(resume ? { resume } : {}),
      noSave,
      ...(dbPath ? { dbPath } : {}),
      confirmPolicy,
    });
  });

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- CLI bin 入口，不支持 top-level await
program.parseAsync(process.argv).catch((error: unknown) => {
  console.error('[liskin] error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
