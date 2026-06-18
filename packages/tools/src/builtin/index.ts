import type { ToolImpl } from '../types.js';

import { fsRead } from './fs-read.js';
import { fsWrite } from './fs-write.js';
import { shellExec } from './shell-exec.js';

export { fsRead } from './fs-read.js';
export { fsWrite } from './fs-write.js';
export { shellExec } from './shell-exec.js';

export const builtins: ToolImpl[] = [fsRead, fsWrite, shellExec];
