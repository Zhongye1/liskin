import type { EventMsg, InProcessKernelClient } from '@liskin/core';
import type { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';

import { formatSSE, formatSSEComment } from './sse.js';

const CreateSessionSchema = z.object({
  cwd: z.string().optional(),
  system: z.string().optional(),
});

const UserTurnSchema = z.object({
  content: z.string().min(1),
  maxTurns: z.number().int().positive().optional(),
});

const ConfirmSchema = z.object({
  callId: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
});

/**
 * 把 EventMsg 序列化成 SSE data 行。
 */
function formatEventMsg(ev: EventMsg): string {
  return formatSSE(ev as unknown as { kind: string });
}

/**
 * 在 Hono app 上挂载 sessions 相关路由，全部由 InProcessKernelClient 驱动。
 *
 * 路由只做 transport 翻译（HTTP ↔ Op/EventMsg），不含 agent 逻辑。
 * 见 docs/architecture/web-frontend-design.md §1.4。
 */
export function mountSessionRoutes(
  app: Hono,
  kernel: InProcessKernelClient,
  store: { loadSession(id: string): Promise<{ id: string; createdAt: string; updatedAt: string; messages: unknown[] } | null> },
): void {
  // —— 会话生命周期 —— //

  app.post('/v1/sessions', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CreateSessionSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    }
    const session = await kernel.createSession(parsed.data);
    return c.json(session, 201);
  });

  app.get('/v1/sessions', async (c) => {
    const sessions = await kernel.listSessions();
    return c.json({ sessions });
  });

  app.get('/v1/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const record = await store.loadSession(id);
    if (!record) {
      return c.json({ error: 'session not found' }, 404);
    }
    return c.json(record);
  });

  app.delete('/v1/sessions/:id', async (c) => {
    const id = c.req.param('id');
    await kernel.closeSession(id);
    return c.body(null, 204);
  });

  // —— 回合（SSE 流）—— //

  app.post('/v1/sessions/:id/turns', async (c) => {
    const sessionId = c.req.param('id');
    const raw = await c.req.json().catch(() => null);
    const parsed = UserTurnSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    }

    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    return stream(c, async (s) => {
      await s.write(formatSSEComment('liskin session stream'));
      try {
        for await (const ev of kernel.submit({
          type: 'UserTurn',
          sessionId,
          content: parsed.data.content,
          ...(parsed.data.maxTurns ? { maxTurns: parsed.data.maxTurns } : {}),
        })) {
          await s.write(formatEventMsg(ev));
        }
      } catch (error) {
        await s.write(
          formatEventMsg({
            type: 'Error',
            sessionId,
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        );
      }
    });
  });

  // —— 控制 —— //

  app.post('/v1/sessions/:id/interrupt', async (c) => {
    const sessionId = c.req.param('id');
    await kernel.interrupt(sessionId);
    return c.json({ ok: true });
  });

  app.post('/v1/sessions/:id/confirm', async (c) => {
    const sessionId = c.req.param('id');
    const raw = await c.req.json().catch(() => null);
    const parsed = ConfirmSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    }
    try {
      await kernel.confirmTool(sessionId, parsed.data.callId, parsed.data.decision);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
}
