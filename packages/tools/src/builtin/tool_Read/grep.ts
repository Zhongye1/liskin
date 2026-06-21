/**
 * grep — 弱契约文本检索。返回匹配行的定位信息，不吐全文。
 */
import { spawn } from 'node:child_process';

import { z } from 'zod';

import { defineTool } from '../../tool-define.js';

const MAX_MATCHES = 500;

const GrepArgs = z.object({
  pattern: z.string().min(1),
  glob: z.string().optional(),
  maxMatches: z.number().int().positive().max(MAX_MATCHES).default(200),
});

function execGrep(opts: {
  cwd: string;
  pattern: string;
  glob?: string;
  maxMatches: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const spawnArgs = ['-rIn', '--color=never', '-m', String(opts.maxMatches)];
    if (opts.glob) {
      spawnArgs.push('--include', opts.glob);
    }
    spawnArgs.push(opts.pattern, '.');
    const child = spawn('grep', spawnArgs, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));
    child.on('close', (code) => {
      if (code === 0 || code === 1) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `grep exit ${code}`));
      }
    });
    child.on('error', reject);
  });
}

function formatGrepOutput(raw: string, maxMatches: number): string {
  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return 'No matches found.';
  }
  const header = `Found ${lines.length} match(es):\n`;
  const body = lines
    .map((line) => {
      const sep = line.indexOf(':');
      if (sep === -1) {
        return line;
      }
      const file = line.slice(0, sep);
      const rest = line.slice(sep + 1);
      const lineSep = rest.indexOf(':');
      if (lineSep === -1) {
        return `${file}: ${rest}`;
      }
      return `${file}:${rest.slice(0, lineSep)}: ${rest.slice(lineSep + 1).trim()}`;
    })
    .join('\n');
  if (lines.length >= maxMatches) {
    return `${header}${body}\n\n[结果已达上限 ${maxMatches}, 请缩小搜索范围]`;
  }
  return header + body;
}

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Searches for a pattern in files. Returns matching file paths, line numbers, and line content. Use `glob` to filter by extension (e.g. "*.ts").',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（grep 正则语法）' },
      glob: { type: 'string', description: '文件名 glob，如 "*.ts"' },
      maxMatches: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_MATCHES,
        default: 200,
        description: '最大匹配数',
      },
    },
    required: ['pattern'],
  },
  argsSchema: GrepArgs,

  preflight(_call, ctx) {
    if (ctx.confirmPolicy === 'deny') {
      throw new Error('tool execution denied by confirm policy');
    }
  },

  async execute(args, ctx) {
    const raw = await execGrep({
      cwd: ctx.cwd,
      pattern: args.pattern,
      glob: args.glob,
      maxMatches: args.maxMatches,
    });
    return {
      output: formatGrepOutput(raw, args.maxMatches),
      metadata: { matchCount: raw.trim().split('\n').filter(Boolean).length },
    };
  },
});
