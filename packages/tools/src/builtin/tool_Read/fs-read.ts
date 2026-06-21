/**
 * fs_read — 强契约文件读取 / 目录列表。
 *
 * - 文件：实时 readFile，行号输出 + 三重截断 + 二进制嗅探 + fuzzy miss 提示
 * - 目录：列条目（📁/📄），offset/limit 分页
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { defineTool } from '../../tool-define.js';
import { checkPathAllowed } from '../../sandbox/path-policy.js';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LEN = 2000;
const MAX_BYTES = 50 * 1024;
const BINARY_SNIFF_BYTES = 4096;

const FsReadArgs = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(5000).optional(),
});

function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

async function fuzzySuggest(absPath: string): Promise<string> {
  const dir = path.dirname(absPath);
  const target = path.basename(absPath);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return '';
  }
  // 简单相似度：前缀匹配 + 包含匹配，不引入编辑距离
  const lower = target.toLowerCase();
  const scored = entries
    .map((name) => {
      let score = 0;
      const nl = name.toLowerCase();
      if (nl === lower) {
        score += 10;
      } else if (nl.startsWith(lower)) {
        score += 6;
      } else if (nl.includes(lower)) {
        score += 3;
      }
      return { name, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (scored.length === 0) {
    return '';
  }
  return `\nDid you mean:\n${scored.map((e) => `  ${path.join(path.basename(dir), e.name)}`).join('\n')}`;
}

export const fsReadTool = defineTool({
  name: 'fs_read',
  description:
    'Reads a file or lists a directory.\n\n- If path is a file: returns content with line numbers. Use offset/limit for long files.\n- If path is a directory: lists entries. Use offset/limit for large directories.\n- Call multiple tools in a single response to speculatively read multiple files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件或目录路径' },
      offset: { type: 'integer', minimum: 1, description: '起始行/条目（1-indexed）' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        description: `读取上限，默认 ${DEFAULT_LIMIT}`,
      },
    },
    required: ['path'],
  },
  argsSchema: FsReadArgs,

  preflight(call, ctx) {
    const parsed = FsReadArgs.parse(call.args);
    const abs = path.resolve(ctx.cwd, parsed.path);
    const check = checkPathAllowed(abs, ctx.cwd, { whitelist: ctx.pathWhitelist });
    if (!check.allowed) {
      throw new Error(check.reason ?? 'path not allowed');
    }
  },

  async execute(args, ctx) {
    const abs = path.resolve(ctx.cwd, args.path);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      const suggest = await fuzzySuggest(abs);
      throw new Error(`ENOENT: no such file, '${args.path}'${suggest}`);
    }

    // —— 目录 —— //
    if (stat.isDirectory()) {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const total = entries.length;
      const start = (args.offset ?? 1) - 1;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const slice = entries.slice(start, start + limit);
      const lines: string[] = [];
      for (const d of slice.filter((e) => e.isDirectory())) {
        lines.push(`📁 ${d.name}/`);
      }
      for (const f of slice.filter((e) => e.isFile())) {
        lines.push(`📄 ${f.name}`);
      }
      for (const o of slice.filter((e) => !e.isDirectory() && !e.isFile())) {
        lines.push(`🔗 ${o.name}`);
      }
      if (start + limit < total) {
        lines.push(
          `[共 ${total} 项, 已显示 ${start + 1}-${start + slice.length}, 使用 offset=${start + slice.length + 1} 继续]`,
        );
      }
      return {
        output: lines.join('\n') || 'Directory is empty.',
        metadata: { type: 'directory', totalEntries: total },
      };
    }

    // —— 文件 —— //
    const fd = await fs.open(abs, 'r');
    try {
      const head = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await fd.read(head, 0, BINARY_SNIFF_BYTES, 0);
      if (isBinary(head.subarray(0, bytesRead))) {
        throw new Error(`binary file, cannot read as text: ${args.path}`);
      }
      if (stat.size > MAX_BYTES) {
        throw new Error(
          `file too large (${(stat.size / 1024).toFixed(1)}KB, max ${MAX_BYTES / 1024}KB). Use offset/limit.`,
        );
      }

      const buf = Buffer.alloc(stat.size);
      await fd.read(buf, 0, stat.size, 0);
      const content = buf.toString('utf8');
      if (content.length === 0) {
        return { output: 'File is empty.' };
      }

      const allLines = content.split(/\r?\n/u);
      const totalLines = allLines.length;
      const start = (args.offset ?? 1) - 1;
      const effectiveLimit = args.limit ?? DEFAULT_LIMIT;
      const end = Math.min(start + effectiveLimit, totalLines);
      const outputLines: string[] = [];

      for (let i = 0; i < end - start; i++) {
        let line = allLines[start + i];
        if (line.length > MAX_LINE_LEN) {
          line = `${line.slice(0, MAX_LINE_LEN)}... (line truncated)`;
        }
        outputLines.push(`${start + i + 1}: ${line}`);
      }
      if (end < totalLines) {
        outputLines.push(
          `[文件共 ${totalLines} 行, 已显示 ${start + 1}-${end}, 使用 offset=${end + 1} 继续]`,
        );
      }

      return {
        output: outputLines.join('\n'),
        metadata: { type: 'file', totalLines, truncated: end < totalLines },
      };
    } finally {
      await fd.close();
    }
  },
});
