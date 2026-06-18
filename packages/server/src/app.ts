/* eslint-disable max-lines -- Hono 路由聚合：providers/sessions/chat/logs 全部在此，拆分收益低 */
import type { LLMPort, Msg, ProviderConfig, ToolPort } from '@liskin/core';
import { InProcessKernelClient, ProviderConfigSchema, runAgent } from '@liskin/core';
import { createProvider } from '@liskin/llm';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';

import type { LogBus, LogEntry } from './logger.js';
import type { ProviderRow, SqliteStore } from './store/sqlite-store.js';
import { DynamicLLMPort } from './dynamic-llm.js';
import { mountSessionRoutes } from './kernel-routes.js';
import { formatSSE, formatSSEComment } from './sse.js';

const ChatBodySchema = z.object({
  sessionId: z.string().min(1),
  /** 用户本轮新消息（追加进会话） */
  message: z.string().min(1),
  /** 已被用户确认放行的 tool call id（再次进入 run 时透传） */
  confirmedCallIds: z.array(z.string()).optional(),
  /** 可选 system 提示，仅在 session 第一次创建时生效 */
  system: z.string().optional(),
});

/**
 * 部分更新 schema：所有字段可选；apiKey 允许空字符串（语义=保持原值）。
 */
const ProviderUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    protocol: z.enum(['openai-compatible']).optional(),
    baseURL: z.string().url().optional(),
    apiKey: z.string().optional(),
    model: z.string().min(1).optional(),
    organization: z.string().optional(),
    timeout: z.number().int().positive().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
  })
  .strict();

export interface CreateAppOptions {
  /** 静态 LLM。如果传了，chat 走静态 llm（兼容现有测试）；否则用数据库 active provider。 */
  llm?: LLMPort;
  tools: ToolPort;
  store: SqliteStore;
  /** 允许的跨域来源（开发时需要让 Vite 直接打到本服务） */
  corsOrigin?: string | string[];
  /** 服务端日志总线；提供后启用 GET /v1/logs/stream */
  logBus?: LogBus;
}

/**
 * apiKey 掩码：长度 ≤ 4 全 *，否则前 3 位 + *** + 末 4 位。
 */
export function maskKey(key: string): string {
  if (key.length <= 4) {
    return '*'.repeat(key.length);
  }
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

function resolveCorsOrigins(corsOrigin: string | string[] | undefined): string[] {
  if (Array.isArray(corsOrigin)) {
    return [...corsOrigin];
  }
  if (corsOrigin) {
    return [corsOrigin];
  }
  return [];
}

function formatLogSSE(entry: LogEntry): string {
  return `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
}

interface MaskedProviderView {
  id: string;
  name: string;
  protocol: ProviderRow['protocol'];
  baseURL?: string;
  apiKey: string;
  model: string;
  organization?: string;
  timeout?: number;
  maxRetries?: number;
  isActive: boolean;
  source: ProviderRow['source'];
}

function toView(row: ProviderRow): MaskedProviderView {
  const out: MaskedProviderView = {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    apiKey: maskKey(row.apiKey),
    model: row.model,
    isActive: row.isActive,
    source: row.source,
  };
  if (row.baseURL) {
    out.baseURL = row.baseURL;
  }
  if (row.organization) {
    out.organization = row.organization;
  }
  if (row.timeout !== undefined) {
    out.timeout = row.timeout;
  }
  if (row.maxRetries !== undefined) {
    out.maxRetries = row.maxRetries;
  }
  return out;
}

function rowToConfig(row: ProviderRow): ProviderConfig {
  const cfg: ProviderConfig = {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    apiKey: row.apiKey,
    model: row.model,
  };
  if (row.baseURL) {
    cfg.baseURL = row.baseURL;
  }
  if (row.organization) {
    cfg.organization = row.organization;
  }
  if (row.timeout !== undefined) {
    cfg.timeout = row.timeout;
  }
  if (row.maxRetries !== undefined) {
    cfg.maxRetries = row.maxRetries;
  }
  return cfg;
}

/**
 * 创建一个 Hono app：
 *   - GET  /healthz             健康检查
 *   - GET  /v1/tools            列出工具定义
 *   - GET/POST/PUT/DELETE /v1/providers, /v1/providers/:id/activate
 *   - POST /v1/chat             SSE 流式对话；确认通过 confirmedCallIds 透传
 *   - GET  /v1/sessions/:id     读取会话
 */
export function createApp(opts: CreateAppOptions) {
  const { llm, tools, store, corsOrigin, logBus } = opts;
  const app = new Hono();

  // —— 极简 CORS —— //
  const allowed = resolveCorsOrigins(corsOrigin);
  if (allowed.length > 0) {
    app.use('*', async (c, next) => {
      const origin = c.req.header('origin');
      if (origin && (allowed.includes('*') || allowed.includes(origin))) {
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Headers', 'content-type, authorization');
        c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      }
      if (c.req.method === 'OPTIONS') {
        return c.body(null, 204);
      }
      await next();
    });
  }

  app.get('/healthz', (c) => c.json({ ok: true }));

  // —— sessions 端点：由 InProcessKernelClient 驱动（Step 3 协议对齐）—— //
  const dynamicLlm = new DynamicLLMPort(store, llm);
  const kernel = new InProcessKernelClient({ llm: dynamicLlm, tools, store });
  mountSessionRoutes(app, kernel, store);

  app.get('/v1/tools', (c) => c.json({ tools: tools.list() }));

  // ——— providers CRUD ——— //

  app.get('/v1/providers', (c) => {
    const list = store.listProviders().map((row) => toView(row));
    return c.json(list);
  });

  app.post('/v1/providers', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ProviderConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    }
    const cfg = parsed.data;
    store.upsertProvider({ ...cfg, source: 'user' });
    // 若当前没有 active，则把新建的设为 active
    if (!store.getActiveProvider()) {
      store.setActiveProvider(cfg.id);
    }
    const row = store.getProvider(cfg.id);
    if (!row) {
      return c.json({ error: 'unexpected: provider not found after insert' }, 500);
    }
    return c.json(toView(row), 201);
  });

  app.put('/v1/providers/:id', async (c) => {
    const id = c.req.param('id');
    const exists = store.getProvider(id);
    if (!exists) {
      return c.json({ error: 'not found' }, 404);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = ProviderUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    }
    const patch = parsed.data;
    const merged: ProviderConfig = {
      id: exists.id,
      name: patch.name ?? exists.name,
      protocol: patch.protocol ?? exists.protocol,
      // apiKey === '' 视为「保持原值」
      apiKey: patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : exists.apiKey,
      model: patch.model ?? exists.model,
    };
    const baseURL = patch.baseURL ?? exists.baseURL;
    if (baseURL) {
      merged.baseURL = baseURL;
    }
    const organization = patch.organization ?? exists.organization;
    if (organization) {
      merged.organization = organization;
    }
    const timeout = patch.timeout ?? exists.timeout;
    if (timeout !== undefined) {
      merged.timeout = timeout;
    }
    const maxRetries = patch.maxRetries ?? exists.maxRetries;
    if (maxRetries !== undefined) {
      merged.maxRetries = maxRetries;
    }
    // 用户主动编辑后，source 升级为 user（即使原来是 env）
    store.upsertProvider({ ...merged, source: 'user' });
    const row = store.getProvider(id);
    if (!row) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(toView(row));
  });

  app.delete('/v1/providers/:id', (c) => {
    const id = c.req.param('id');
    const row = store.getProvider(id);
    if (!row) {
      return c.json({ error: 'not found' }, 404);
    }
    if (row.isActive) {
      return c.json({ error: 'cannot delete active provider' }, 409);
    }
    store.deleteProvider(id);
    return c.body(null, 204);
  });

  app.post('/v1/providers/:id/activate', (c) => {
    const id = c.req.param('id');
    const row = store.getProvider(id);
    if (!row) {
      return c.json({ error: 'not found' }, 404);
    }
    store.setActiveProvider(id);
    const updated = store.getProvider(id);
    if (!updated) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(toView(updated));
  });

  // —— 服务端日志 SSE：先回放 ring buffer，再实时推送 —— //
  if (logBus) {
    app.get('/v1/logs/stream', (c) => {
      c.header('Content-Type', 'text/event-stream; charset=utf-8');
      c.header('Cache-Control', 'no-cache, no-transform');
      c.header('Connection', 'keep-alive');
      c.header('X-Accel-Buffering', 'no');

      return stream(c, async (s) => {
        let unsubscribe: (() => void) | null = null;
        const ping = setInterval(() => {
          // 每 15s 一个注释行，防止反代切流
          s.write(formatSSEComment('ping')).catch(() => {
            // 写失败（客户端断连）由 s.onAbort 兜底，此处忽略
          });
        }, 15_000);
        const cleanup = (): void => {
          clearInterval(ping);
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        };
        s.onAbort(cleanup);

        // 回放历史
        await s.write(formatSSEComment('liskin log stream'));
        const buffered = logBus.getBuffer();
        for (const entry of buffered) {
          await s.write(formatLogSSE(entry));
        }

        // 实时订阅
        let alive = true;
        await new Promise<void>((resolve) => {
          unsubscribe = logBus.subscribe((entry) => {
            if (!alive) {
              return;
            }
            s.write(formatLogSSE(entry)).catch(() => {
              alive = false;
              cleanup();
              resolve();
            });
          });
          s.onAbort(() => {
            alive = false;
            cleanup();
            resolve();
          });
        });
      });
    });
  }

  app.post('/v1/chat', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ChatBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    // —— 0. 选 LLM：静态优先；否则查 active provider —— //
    const activeRow = llm ? null : store.getActiveProvider();
    if (!llm && !activeRow) {
      return c.json({ error: 'no active provider configured' }, 503);
    }
    const activeLlm: LLMPort = llm ?? createProvider(rowToConfig(activeRow as ProviderRow));

    // 1. 装载/创建 session
    const now = new Date().toISOString();
    let session = await store.loadSession(body.sessionId);
    if (!session) {
      const seed: Msg[] = [];
      if (body.system) {
        seed.push({ role: 'system', content: body.system });
      }
      session = {
        id: body.sessionId,
        createdAt: now,
        updatedAt: now,
        messages: seed,
      };
    }
    // 2. 追加本轮 user 消息
    const messages: Msg[] = [...session.messages, { role: 'user', content: body.message }];

    // 3. 持久化（先把 user 消息存下来，避免中途崩溃丢失）
    await store.saveSession({ ...session, messages, updatedAt: now });

    // 4. 起 SSE
    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const controller = new AbortController();
    const llmForRun = activeLlm;
    return stream(c, async (s) => {
      s.onAbort(() => controller.abort());
      // 心跳，避免代理切断
      await s.write(formatSSEComment('liskin agent stream'));

      // 把 agent 流式产出的事件以及最终消息状态都收集起来；
      // 工具调用产生的 assistant / tool 消息也要落到 session 里
      let assistantText = '';
      const newMsgs: Msg[] = [...messages];
      const pendingToolCalls = new Map<string, { name: string; args: unknown }>();

      try {
        for await (const ev of runAgent({
          llm: llmForRun,
          tools,
          initialMessages: messages,
          confirmedCallIds: body.confirmedCallIds,
          signal: controller.signal,
        })) {
          await s.write(formatSSE(ev));

          switch (ev.kind) {
            case 'token': {
              assistantText += ev.text;
              break;
            }
            case 'tool_call': {
              pendingToolCalls.set(ev.call.id, { name: ev.call.name, args: ev.call.args });
              break;
            }
            case 'tool_result': {
              newMsgs.push({
                role: 'tool',
                content: ev.result.content,
                toolCallId: ev.result.toolCallId,
              });
              break;
            }
            case 'tool_confirm_required':
            case 'tool_progress':
            case 'done':
            case 'error': {
              break;
            }
          }
        }
      } catch (error) {
        await s.write(
          formatSSE({
            kind: 'error',
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        );
      }

      // 收尾：把 assistant / pending tool calls 落到 session
      if (assistantText.length > 0 || pendingToolCalls.size > 0) {
        const toolCalls = [...pendingToolCalls.entries()].map(([id, v]) => ({
          id,
          name: v.name,
          args: v.args,
        }));
        newMsgs.push({
          role: 'assistant',
          content: assistantText,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      }
      const updated = new Date().toISOString();
      await store.saveSession({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: updated,
        messages: newMsgs,
      });
    });
  });

  return app;
}
