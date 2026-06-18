import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { ToolImpl } from '../types.js';
import { checkPathAllowed } from '../sandbox/path-policy.js';

const MAX_LIMIT = 10_000;

const FsReadArgs = z.object({
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(MAX_LIMIT).optional(),
});

export const fsRead: ToolImpl = {
  definition: {
    name: 'fs.read',
    description: '读取文件内容（默认全部，可指定起始行号 startLine 与行数 limit）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对或相对 cwd）' },
        startLine: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
      required: ['path'],
    },
  },
  preflight(call, ctx) {
    const parsed = FsReadArgs.parse(call.args);
    const check = checkPathAllowed(parsed.path, ctx.cwd, { whitelist: ctx.pathWhitelist });
    if (!check.allowed) {
      throw new Error(check.reason ?? 'path not allowed');
    }
    // fs.read 是只读，不触发确认。
  },
  async execute(args, ctx) {
    const parsed = FsReadArgs.parse(args);
    const abs = path.isAbsolute(parsed.path) ? parsed.path : path.resolve(ctx.cwd, parsed.path);
    const content = await fs.readFile(abs, 'utf8');

    if (parsed.startLine === undefined && parsed.limit === undefined) {
      return content;
    }
    const lines = content.split(/\r?\n/u);
    const start = (parsed.startLine ?? 1) - 1;
    const end = parsed.limit === undefined ? lines.length : start + parsed.limit;
    return lines.slice(start, end).join('\n');
  },
};
