import type { Msg } from '../types/messages.js';

/**
 * M1 占位：暂不做真正的 token 预算裁剪。
 * 目的是把"消息列表 → 模型输入"这一步的代码点位先留出来，
 * 后续在 M3+ 接入 tokenizer 时只改实现，不改调用方。
 */
export function applyBudget(messages: Msg[]): Msg[] {
  return messages;
}
