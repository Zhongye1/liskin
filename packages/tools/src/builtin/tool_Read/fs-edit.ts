/**
 * fs_edit — 文件编辑：replace（字符串替换）或 lines（行号范围替换）+ fuzzy 兜底。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { defineTool } from '../../tool-define.js';
import { checkPathAllowed } from '../../sandbox/path-policy.js';

const EditArgs = z.object({
  path: z.string().min(1),
  mode: z.enum(['replace', 'lines']),
  target: z.string().optional(),
  replacement: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

function diffPreview(oldLines: string[], newLines: string[]): string {
  const result: string[] = [];
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    if (oldLines[i] !== newLines[i]) {
      if (oldLines[i] !== undefined) {
        result.push(`- ${oldLines[i]}`);
      }
      if (newLines[i] !== undefined) {
        result.push(`+ ${newLines[i]}`);
      }
    }
  }
  return result.join('\n');
}

export const fsEditTool = defineTool({
  name: 'fs_edit',
  description:
    'Edits a file. Modes: replace (find & replace first occurrence), lines (replace line range with new content). Returns diff preview.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      mode: { type: 'string', enum: ['replace', 'lines'] },
      target: { type: 'string', description: '[replace] 要替换的字符串' },
      replacement: { type: 'string', description: '替换后的新内容' },
      startLine: { type: 'integer', minimum: 1, description: '[lines] 起始行（含）' },
      endLine: { type: 'integer', minimum: 1, description: '[lines] 结束行（含）' },
    },
    required: ['path', 'mode'],
  },
  argsSchema: EditArgs,

  preflight(call, ctx) {
    const parsed = EditArgs.parse(call.args);
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
      throw new Error(`ENOENT: no such file, '${args.path}'`);
    }
    if (stat.isDirectory()) {
      throw new Error(`EISDIR: path is a directory, '${args.path}'`);
    }

    const content = await fs.readFile(abs, 'utf8');
    const allLines = content.split(/\r?\n/u);
    let newLines: string[] = [];

    if (args.mode === 'replace') {
      const target = args.target ?? '';
      const replacement = args.replacement ?? '';
      if (content.includes(target)) {
        newLines = content.replace(target, replacement).split(/\r?\n/u);
      } else {
        const trimmed = target.trim();
        let fuzzyMatched = false;
        newLines = allLines.map((line) => {
          if (!fuzzyMatched && line.trim() === trimmed) {
            fuzzyMatched = true;
            return replacement;
          }
          return line;
        });
        if (!fuzzyMatched) {
          throw new Error(
            `target string not found: '${target.slice(0, 100)}'. Use fs_read to verify current content.`,
          );
        }
      }
    } else {
      const startLine = args.startLine ?? 1;
      const endLine = args.endLine ?? startLine;
      const replacement = args.replacement ?? '';
      if (startLine < 1 || startLine > allLines.length) {
        throw new Error(`startLine ${startLine} out of range (1-${allLines.length})`);
      }
      if (endLine < startLine || endLine > allLines.length) {
        throw new Error(`endLine ${endLine} out of range (${startLine}-${allLines.length})`);
      }
      newLines = [...allLines.slice(0, startLine - 1), replacement, ...allLines.slice(endLine)];
    }

    const preview = diffPreview(allLines, newLines);
    await fs.writeFile(abs, newLines.join('\n'), 'utf8');
    return {
      output: `wrote ${newLines.length} lines to ${args.path}\n${preview}`,
      metadata: { linesWritten: newLines.length },
    };
  },
});
