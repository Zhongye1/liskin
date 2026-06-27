import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { z } from 'zod';

import type { ToolImpl } from '../types.js';
import { checkCommandAllowed, DEFAULT_BLOCKED_PATTERNS } from '../sandbox/command-policy.js';
import { applyConfirmPolicy } from '../sandbox/confirm-policy.js';

const ShellExecArgs = z.object({
  cmd: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

const DEFAULT_TIMEOUT_MS = 30_000;

export const shellExec: ToolImpl = {
  definition: {
    name: 'shell.exec',
    description: '执行 shell 命令并返回 stdout+stderr。会触发用户确认。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'shell 命令' },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 600_000,
          description: '超时毫秒，默认 30000',
        },
      },
      required: ['cmd'],
    },
  },
  preflight(call, ctx) {
    const parsed = ShellExecArgs.parse(call.args);
    const check = checkCommandAllowed(parsed.cmd, { blockedPatterns: DEFAULT_BLOCKED_PATTERNS });
    if (!check.allowed) {
      throw new Error(check.reason ?? 'command not allowed');
    }
    applyConfirmPolicy(call, ctx.confirmPolicy);
  },
  async execute(args, ctx, callbacks) {
    const parsed = ShellExecArgs.parse(args);
    const timeoutMs = parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 生成命令摘要（脱敏后）
    const cmdSummary = parsed.cmd.length > 100 ? `${parsed.cmd.slice(0, 97)}...` : parsed.cmd;

    const startTime = Date.now();
    let exitCode = -1;

    try {
      return await new Promise<string>((resolve) => {
        const child = spawn(parsed.cmd, {
          shell: true,
          cwd: ctx.cwd,
        });

        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let aborted = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs);

        const onAbort = (): void => {
          aborted = true;
          child.kill('SIGTERM');
        };
        if (ctx.signal) {
          if (ctx.signal.aborted) {
            onAbort();
          } else {
            ctx.signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        child.stdout?.on('data', (buf: Buffer) => {
          const chunk = stdoutDecoder.write(buf);
          if (chunk.length === 0) {
            return;
          }
          stdout += chunk;
          callbacks?.onProgress?.('stdout', chunk);
        });
        child.stderr?.on('data', (buf: Buffer) => {
          const chunk = stderrDecoder.write(buf);
          if (chunk.length === 0) {
            return;
          }
          stderr += chunk;
          callbacks?.onProgress?.('stderr', chunk);
        });

        const finish = (code: number): void => {
          if (settled) {
            return;
          }
          settled = true;
          exitCode = code;
          clearTimeout(timer);
          if (ctx.signal) {
            ctx.signal.removeEventListener('abort', onAbort);
          }
          // flush 任何残余多字节字符
          const stdoutTail = stdoutDecoder.end();
          if (stdoutTail.length > 0) {
            stdout += stdoutTail;
            callbacks?.onProgress?.('stdout', stdoutTail);
          }
          const stderrTail = stderrDecoder.end();
          if (stderrTail.length > 0) {
            stderr += stderrTail;
            callbacks?.onProgress?.('stderr', stderrTail);
          }

          const out = [stdout, stderr].filter(Boolean).join('\n');
          if (timedOut) {
            resolve(`timeout after ${timeoutMs}ms\n${out}`);
            return;
          }
          if (aborted) {
            resolve(`aborted\n${out}`);
            return;
          }
          if (code === 0) {
            resolve(out || '(no output)');
            return;
          }
          resolve(`exit code ${code}\n${out}`);
        };

        child.on('error', (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (ctx.signal) {
            ctx.signal.removeEventListener('abort', onAbort);
          }
          resolve(`spawn error: ${error.message}`);
        });
        child.on('close', (code) => {
          finish(typeof code === 'number' ? code : -1);
        });
      });
    } finally {
      const durationMs = Date.now() - startTime;
      ctx.logger?.info('shell.exec', {
        cmd_summary: cmdSummary,
        exit_code: exitCode,
        duration_ms: durationMs,
      });
    }
  },
};
