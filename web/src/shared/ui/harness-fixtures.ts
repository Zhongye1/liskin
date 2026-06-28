/**
 * UI Harness 固定装置（fixtures）。
 *
 * 这些纯数据用于：
 *  1. 在没有后端的情况下预览 / 截图新 UI（见 ui-preview 路由）；
 *  2. 给展示型组件写快照式单测。
 *
 * 数据形态参考目标设计稿（Claude Code 风格）：项目选择、会话列表、
 * 带工具调用步骤的对话流。这里刻意用最小内联类型，避免耦合协议层。
 */

export interface MockSession {
  id: string;
  title: string;
  project: string;
  status?: 'active' | 'answered' | 'open';
  meta?: string;
}

export interface MockStep {
  kind: 'text' | 'tool';
  /** tool 名称，例如 Grep / Read / Edit */
  tool?: string;
  /** tool 参数摘要或文本内容 */
  text: string;
  state?: 'running' | 'done';
}

export interface MockTurn {
  id: string;
  role: 'user' | 'assistant';
  /** user 气泡文本 */
  content?: string;
  /** assistant 的步骤序列 */
  steps?: MockStep[];
}

export const MOCK_PROJECT = 'acme/tea-sales';

export const MOCK_SESSIONS: MockSession[] = [
  {
    id: 's-round',
    title: 'Round subscription amounts to dollar',
    project: 'acme/tea-sales',
    status: 'active',
  },
  {
    id: 's-inventory',
    title: 'Add real-time inventory tracking',
    project: 'acme/tea-sales',
  },
  {
    id: 's-tax',
    title: 'Tax calculation details',
    project: 'acme/tea-sales',
    status: 'answered',
  },
  {
    id: 's-banner',
    title: 'Add fall welcome banner',
    project: 'acme/mobile-tea',
    status: 'open',
    meta: '+263 -11',
  },
];

export const MOCK_TURNS: MockTurn[] = [
  {
    id: 't1',
    role: 'user',
    content: 'round subscription discounts down to nearest dollar',
  },
  {
    id: 't2',
    role: 'assistant',
    steps: [
      { kind: 'text', text: "I'll get right on that!" },
      { kind: 'tool', tool: 'Grep', text: 'discount' },
      { kind: 'tool', tool: 'Read', text: 'pricing_utils.ts' },
      { kind: 'tool', tool: 'Read', text: 'models.ts' },
      {
        kind: 'text',
        text: "I've found the logic for computing subscription discounts. Let me make that change.",
      },
      { kind: 'tool', tool: 'Edit', text: 'pricing_utils.ts' },
    ],
  },
  {
    id: 't3',
    role: 'user',
    content: "don't forget to write tests",
  },
  {
    id: 't4',
    role: 'assistant',
    steps: [
      { kind: 'text', text: 'Good idea! Let me see if there are any existing tests.' },
      { kind: 'tool', tool: 'Grep', text: 'test' },
      { kind: 'text', text: 'Pondering…', state: 'running' },
    ],
  },
];
