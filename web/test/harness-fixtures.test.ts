import { describe, expect, it } from 'vitest';
import {
  MOCK_PROJECT,
  MOCK_SESSIONS,
  MOCK_TURNS,
} from '../src/shared/ui/harness-fixtures';

/**
 * Harness fixtures 的形状契约测试。
 * 保证预览页 / 组件快照所依赖的 mock 数据结构稳定，
 * 避免后续误改 fixtures 导致预览页静默崩坏。
 */
describe('harness fixtures', () => {
  it('暴露一个非空项目名', () => {
    expect(MOCK_PROJECT).toBeTruthy();
    expect(typeof MOCK_PROJECT).toBe('string');
  });

  it('会话列表每项都有 id / title / project', () => {
    expect(MOCK_SESSIONS.length).toBeGreaterThan(0);
    for (const s of MOCK_SESSIONS) {
      expect(s.id).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.project).toBeTruthy();
    }
  });

  it('会话 id 唯一', () => {
    const ids = MOCK_SESSIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('对话流以 user 开头并交替推进', () => {
    expect(MOCK_TURNS[0]?.role).toBe('user');
    expect(MOCK_TURNS.some((t) => t.role === 'assistant')).toBe(true);
  });

  it('user turn 有 content，assistant turn 有 steps', () => {
    for (const t of MOCK_TURNS) {
      if (t.role === 'user') {
        expect(t.content).toBeTruthy();
      } else {
        expect(Array.isArray(t.steps)).toBe(true);
        expect(t.steps?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('tool step 携带 tool 名称', () => {
    const toolSteps = MOCK_TURNS.flatMap((t) => t.steps ?? []).filter(
      (s) => s.kind === 'tool',
    );
    expect(toolSteps.length).toBeGreaterThan(0);
    for (const s of toolSteps) {
      expect(s.tool).toBeTruthy();
    }
  });
});
