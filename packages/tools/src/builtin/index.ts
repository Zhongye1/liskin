import type { ToolImpl } from '../types.js';

import { fsWrite } from './fs-write.js';
import { shellExec } from './shell-exec.js';

import { fsReadTool } from './tool_Read/fs-read.js';
import { fsEditTool } from './tool_Read/fs-edit.js';
import { grepTool } from './tool_Read/grep.js';

export { fsRead } from './fs-read.js';
export { fsWrite } from './fs-write.js';
export { shellExec } from './shell-exec.js';
export { fsReadTool } from './tool_Read/fs-read.js';
export { fsEditTool } from './tool_Read/fs-edit.js';
export { grepTool } from './tool_Read/grep.js';

export const builtins: ToolImpl[] = [
  fsReadTool, // fs_read: 读文件/列目录 + 行号 + 三重截断 (defineTool)
  fsEditTool, // fs_edit: replace/lines + fuzzy 兜底 (defineTool)
  grepTool, // grep: 文本检索 (defineTool)
  fsWrite,
  shellExec,
];
