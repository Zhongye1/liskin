// Public package entry: re-export the stable client-facing API surface.
// The CLI entry remains in src/cli.ts.
export const __VERSION__ = '0.0.0';

export * from './chat/index.js';
export * from './exec/index.js';
export * from './logger/index.js';
export * from './render/index.js';
