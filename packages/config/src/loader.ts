import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ConfigSchema, type Config } from './schema.js';

/**
 * 从 ~/.liskin/config.json 读取配置。
 * 文件不存在 → 返回空对象；解析失败 → 打印警告后返回空对象。
 */
export function loadConfig(): Config {
  const configPath = join(homedir(), '.liskin', 'config.json');
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    return ConfigSchema.parse(raw);
  } catch (error) {
    process.stderr.write(`[liskin] failed to read ${configPath}: ${(error as Error).message}\n`);
    return {};
  }
}

/** 确保 ~/.liskin/ 存在，返回 serve 默认 sqlite 路径。 */
export function defaultDbPath(): string {
  const dir = join(homedir(), '.liskin');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'sessions.sqlite');
}

/** 确保 ~/.liskin/ 存在，返回 chat 默认 sqlite 路径。 */
export function defaultChatDbPath(): string {
  const dir = join(homedir(), '.liskin');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'chat-sessions.sqlite');
}
