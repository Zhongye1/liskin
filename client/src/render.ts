/**
 * 终端渲染工具函数。
 *
 * agent exec 与 agent chat 共享的事件→终端输出映射。
 * 不含任何业务状态，纯函数 + ANSI escape codes。
 */
import type { ToolCall, ToolResult } from '@liskin/core';

// —— ANSI 常量 —— //
const CYAN = '\u001B[36m';
const GREEN = '\u001B[32m';
const RED = '\u001B[31m';
const YELLOW = '\u001B[33m';
const RESET = '\u001B[0m';

// —— 工具参数格式化 —— //

/** 语义化显示工具参数：shell 显示命令、fs 显示路径、其他 fallback 到 JSON。 */
export function formatArgs(args: unknown): string {
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

// —— 文本截断 —— //

/** 截断过长文本（换行→空格），用于工具结果单行摘要。 */
export function truncate(text: string, max = 500): string {
  const one = text.replaceAll('\n', ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

// —— 事件 → 终端输出（纯副作用函数） —— //

/** 流式打印 Token，不换行。 */
export function writeToken(text: string): void {
  process.stdout.write(text);
}

/** 工具调用标签：青色 ▸ 前缀 + 语义化参数。 */
export function writeToolCall(call: ToolCall): void {
  process.stdout.write(`\n${CYAN}▸ ${call.name}${RESET} ${formatArgs(call.args)}\n`);
}

/** 透传工具执行的实时 stdout/stderr。 */
export function writeToolProgress(chunk: string): void {
  process.stdout.write(chunk);
}

/** 工具结果摘要：绿色✓（成功）或红色✓（失败）+ 截断内容。 */
export function writeToolResult(result: ToolResult): void {
  const color = result.ok ? GREEN : RED;
  process.stdout.write(`${color}✓${RESET} ${truncate(result.content)}\n`);
}

/** 错误输出到 stderr，红色。 */
export function writeError(msg: string): void {
  process.stderr.write(`\n${RED}✗ ${msg}${RESET}\n`);
}

/** 状态标签（黄色），如 [interrupted] [max_turns]。 */
export function writeStatus(label: string): void {
  process.stdout.write(`\n${YELLOW}[${label}]${RESET}\n`);
}
