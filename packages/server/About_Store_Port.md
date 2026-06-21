```text
  ---
  StorePort 设计详解

  StorePort 是内核定义的持久化抽象接口，把会话（Session）的存储、查询、
  删除与 LLM Provider 配置的管理统一为内核可见的最小契约。内核不 import
  任何具体存储实现（SQLite / 内存 / IndexedDB）。

  ---
  接口定义（core 层，零外部依赖）

  // packages/core/src/ports/store-port.ts

  interface SessionRecord {
    id: string;
    createdAt: string;     // ISO 时间戳
    updatedAt: string;
    messages: Msg[];       // 完整消息历史（system/user/assistant/tool）
  }

  interface SessionSummary {
    id: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;  // 不含 messages 全文，避免 N 条消息的序列化开销
  }

  interface StorePort {
    loadSession(id: string): Promise<SessionRecord | null>;
    saveSession(record: SessionRecord): Promise<void>;

    listSessions?(): Promise<SessionSummary[]>;   // 可选：旧实现可慢慢补
    deleteSession?(id: string): Promise<void>;     // 可选：不实现时 KernelClient 抛 NotImplemented
  }

  四个方法，两个必须（load/save），两个可选（list/delete）。
  核心数据单元是 SessionRecord：一次 Agent 会话从创建到关闭，messages
  数组持续追加（永不覆盖历史，只在末尾 appen
  d）。

  ---
  为什么接口在 core，实现在外层

  core/ports/store-port.ts     ← 接口（仅依赖 Msg 类型 + zod）
  core/kernel/in-memory-store.ts ← 实现 1：内存 Map（测试 / CLI MVP）
  server/store/sqlite-store.ts   ← 实现 2：SQLite 持久化（生产）
  未来可加：                    ← 实现 3：Browser IndexedDB（Web 端）

  runAgent 只依赖 StorePort 接口，不知道背后是内存、SQLite 还是浏览器
  IndexedDB。换存储实现 = 换一个类，内核零改动。

  ---
  实现 1：InMemoryStore（测试与一次性场景用）

  // packages/core/src/kernel/in-memory-store.ts

  private readonly sessions = new Map<string, SessionRecord>();

  - loadSession(id) → sessions.get(id) ?? null
  - saveSession(record) → sessions.set(id, 深拷贝（messages 快照）)
  - listSessions()     → 按 updatedAt 倒序，返回摘要（不含 messages）
  - deleteSession(id)  → sessions.delete(id)

  用途：
  - agent exec（一次性任务，无需持久化）
  - 所有单元测试（vitest，每次测试独立 Map 实例）
  - 不落盘，进程退出即消失

  ---
  实现 2：SqliteStore（生产持久化）

  // packages/server/src/store/sqlite-store.ts

  constructor(filePath):
    db = new Database(filePath)
    db.pragma('journal_mode = WAL')  // 读写并发，避免锁争用
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      messages   TEXT NOT NULL       // JSON 序列化 Msg[]
    )

  两个核心方法：

  loadSession(id):
    row = db.prepare('SELECT ... FROM sessions WHERE id = ?').get(id)
    → JSON.parse(row.messages) as Msg[]

  saveSession(record):
    db.prepare(
      'INSERT INTO sessions (...) VALUES (...)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         messages   = excluded.messages'
    ).run(...)
    → upsert 语义：新会话 insert，已存在则更新（追加新消息后的全量）

  listSessions(): 按 updated_at DESC 排序，messageCount 通过
  JSON.parse(messages).length 计算（不返回 messages 正文）

  deleteSession(id): DELETE FROM sessions WHERE id = ?

  —— provider_configs 扩展 ——

  SqliteStore 除了实现 StorePort 以外，还额外管理 LLM Provider 配置：

  CREATE TABLE provider_configs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    protocol    TEXT NOT NULL,        -- 'openai-compatible' 等
    base_url    TEXT,
    api_key     TEXT NOT NULL,        -- 明文存储（本地单机可接受）
    model       TEXT NOT NULL,
    is_active   INTEGER DEFAULT 0,    -- 当前活跃配置（唯一）
    source      TEXT DEFAULT 'user',  -- 'env' | 'user'（配置保留语义）
    ...
  )

  8 个 provider 专用方法：

  - listProviders()        → 全部配置，apiKey 上层掩码展示
  - getProvider(id)        → 单个配置详情
  - getActiveProvider()    → is_active=1 LIMIT 1
  - upsertProvider(config, {onlyIfMissing?})
      onlyIfMissing=true → 同 id 已存在则 noop（seed env 不覆盖用户编辑）
      onlyIfMissing=false → insert or update（用户手动编辑）
  - setActiveProvider(id)  → 事务内一次性更新所有行的 is_active
  - deleteProvider(id)     → DELETE（active 的拒绝，409）

  设计要点：

  1. env seed 配置保留语义：
     启动时 startServer 把环境变量作为 envSeed 写入：
     upsertProvider(envSeed, {onlyIfMissing: true})
     → 如果库里已有同 id（用户之前编辑过），保留用户版本
     → 如果是全新实例，写入 env 配置并自动设为 active
     
  2. source 字段：env → 来自环境变量 / user → 用户在 Web UI 编辑过。
     一旦用户编辑，source 升级为 user，重启时 env 不再覆盖。
     PUT 时 apiKey 为空字符串 → 视为保持原值。

  3. active 唯一性：setActiveProvider 用事务一次性更新所有行，
     保证 is_active=1 永远是唯一的（无锁，纯 SQL CASE WHEN）。

  ---
  消息持久化策略

  每次 runAgent 执行完一轮 Turn，InProcessKernelClient 调用
  persist(sessionId, messages)：
    loadSession(id) → 改 messages → saveSession({...record, messages, updatedAt})

  关键特点：

  - 追加模型：messages 数组只增不减。system → user → assistant → tool
    → assistant → tool → ... 线性追加
  - fire-and-forget：persist 不阻塞事件流，失败只打 log 不抛异常
  - JSON 序列化：SqliteStore 存整条 JSON.parse，简单但有效。
    相比每条消息一行，JSON 方案对于消息规模（通常 < 1000 条/会话）
    完全够用

  ---
  在 KernelClient 中如何被消费

  InProcessKernelClient 在所有会话操作上都通过 StorePort：

  createSession({system}):
    id = generateSessionId()
    messages = system ? [{role:'system', content:system}] : []
    store.saveSession({id, createdAt, updatedAt, messages})

  resumeSession(sessionId):
    record = store.loadSession(sessionId)
    → 不存在抛 Error → CLI 提示 / Web 404

  submit(UserTurn):
    record = store.loadSession(sessionId)   ← 加载历史
    messages = [...record.messages, {role:'user', content}]  ← 追加 user 消息
    store.saveSession({...record, messages, updatedAt})       ← 先存 user turn
    runAgent({initialMessages: messages, ...})                ← 跑 agent
    → 每轮后 persist(sessionId, messages)  ← fire-and-forget 更新

  listSessions():
    → store.listSessions?.() ?? []  （旧实现没写 list 时兜底空数组）
    CLI /sessions 命令 / Web 会话列表

  ---
  StorePort vs 其他 Port 的依赖方向

                 core (接口)
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
    LLMPort      ToolPort     StorePort
       │            │            │
       │            │     ┌──────┴──────┐
       │            │     ▼             ▼
       │            │  InMemoryStore  SqliteStore (含 provider_configs)
       │            │  (core 内部)    (server/store/)
       │            │
       ▼            ▼
    llm 包        tools 包      server 包
    (OpenAI)     (ToolRegistry)  (Hono + SQLite)

  与 LLMPort/ToolPort 不同，StorePort 有一个"轻量实现"（InMemoryStore）
  留在 core 内部。这是因为测试和一次性 CLI 场景需要一个零依赖的兜底，
  不能让 core 的单元测试去依赖 server 包的 SQLite。

  ---
  现在的状态 vs 未来

  当前:
    StorePort ─── InMemoryStore (测试/exec)
             └── SqliteStore    (chat REPL/daemon)
                 ├─ sessions 表（会话持久化）
                 └─ provider_configs 表（LLM 配置管理）

  未来可加:
    StorePort ─── JsonlStore     (单文件 append-only JSONL，备份用)
    StorePort ─── BrowserStore   (Web 端 IndexedDB，离线 PWA)
    StorePort ─── RemoteStore    (云端存储，多人共享)

  每加一个 Store 只是一个实现了 StorePort 的新类 — core 零改动。
</text>
```