#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';

import type { ProviderConfig } from '@liskin/core';
import { ToolRegistry } from '@liskin/tools';
import { startServer } from '@liskin/server';
import { runExec } from './exec.js';

interface Config {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  port?: number;
  host?: string;
  dbPath?: string;
  pathWhitelist?: string[];
  corsOrigin?: string | string[];
  confirmPolicy?: 'auto' | 'ask' | 'deny';
}

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

function defaultDbPath(): string {
  const dir = join(homedir(), '.liskin');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'sessions.sqlite');
}

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

    const apiKey = process.env.OPENAI_API_KEY ?? process.env.LISKIN_API_KEY ?? cfg.apiKey;
    const baseURL = process.env.OPENAI_BASE_URL ?? cfg.baseURL;
    const model = process.env.LISKIN_MODEL ?? cfg.model;

    const port = Number(raw.port ?? cfg.port ?? 8787);
    const host = (raw.host as string | undefined) ?? cfg.host ?? '127.0.0.1';
    const dbPath = (raw.db as string | undefined) ?? cfg.dbPath ?? defaultDbPath();
    const cwd = resolve((raw.cwd as string | undefined) ?? process.cwd());
    const confirmPolicy =
      (raw.confirm as 'auto' | 'ask' | 'deny' | undefined) ?? cfg.confirmPolicy ?? 'ask';
    const corsList = (raw.cors as string[] | undefined) ?? [];
    const corsOrigin = corsList.length > 0 ? corsList : cfg.corsOrigin;

    // Ensure parent dir of dbPath exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

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
    console.log(`[liskin] agent serving on ${server.url}`);
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
    const system =
      (raw.system as string | undefined) ??
      'You are a coding agent. Use fs.read/fs.write/shell.exec tools to complete tasks. Prefer writing files then running them. Be concise.';

    if (!apiKey) {
      console.error(
        '[liskin] no API key: set OPENAI_API_KEY / LISKIN_API_KEY or ~/.liskin/config.json',
      );
      process.exit(1);
    }

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

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- CLI bin 入口，不支持 top-level await
program.parseAsync(process.argv).catch((error: unknown) => {
  console.error('[liskin] error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
