import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { ToolImpl } from '../types.js';
import { applyConfirmPolicy } from '../sandbox/confirm-policy.js';
import { checkPathAllowed } from '../sandbox/path-policy.js';

const FsWriteArgs = z.object({
  path: z.string(),
  content: z.string(),
});

export const fsWrite: ToolImpl = {
  definition: {
    name: 'fs.write',
    description: '写入文件（覆盖）。会触发用户确认。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（绝对或相对 cwd）' },
        content: { type: 'string', description: '要写入的文本内容' },
      },
      required: ['path', 'content'],
    },
  },
  preflight(call, ctx) {
    const parsed = FsWriteArgs.parse(call.args);
    const check = checkPathAllowed(parsed.path, ctx.cwd, { whitelist: ctx.pathWhitelist });
    if (!check.allowed) {
      throw new Error(check.reason ?? 'path not allowed');
    }
    applyConfirmPolicy(call, ctx.confirmPolicy);
  },
  async execute(args, ctx) {
    const parsed = FsWriteArgs.parse(args);
    const abs = path.isAbsolute(parsed.path) ? parsed.path : path.resolve(ctx.cwd, parsed.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, parsed.content, 'utf8');
    return `wrote ${parsed.content.length} bytes to ${abs}`;
  },
};
