# 本地 Agent 架构设计文档

> 版本：v1.1 · 2026-06-17 · 状态：可开工
>
> 范围：客户端核心架构（§1–§10） + Harness 框架（§11） + IDE 插件（§12） + 工作流编排（§13）

---

## 文档结构总览

```
章节│ 内容
§1  │ 项目定位与边界
§2  │ 关键架构判断（后端要不要、客户端 MVP 优先论证）
§3  │ 客户端架构（分层 / 数据流 / 进程模型 / 选型表）
§4  │ MVP 最小闭环（目录结构 + 端到端示例）
§5  │ 后端服务（按需引入，不做的事）
§6  │ 阶段路线图 Phase 0→3
§7  │ 关键决策与权衡（TS vs Go、UI 选型、安全模型、Provider 抽象）
§8  │ 风险与对策
§9  │ 参考实现对照（Claude Code / Aider / Cline / Devin / ）
§10 │ 未决事项
§11 │ Harness 框架（定义 / 何时创建 / Markdown schema 示例 / 生命周期 / 7 个工具 / .liskin/harness/ 目录）
§12 │ IDE 插件（Daemon 化策略 / 启动流程 / /v1/ 协议 / 单进程→Daemon 演进点）
§13 │ 工作流编排（明确告诉读者「什么时候不要做」/ 触发条件 / 警告）
```

## 三个核心结论

1. Harness：参考 oh-my-code 经验，落在 .liskin/harness/active|completed/ 的 Markdown  
   文件，Pending/Completed 二分、节点落盘后才能 dispatch、control state 三态；MVP 只做单  
   harness 顺序执行
2. IDE 插件：插件是 UI 不是 Agent，VSCode/JetBrains/Web/CLI 都连同一个 agent serve  
   Daemon；MVP 不做，但 §3 的 HTTP/SSE 接口要按未来 Daemon 形态写，迁移成本接近零
3. 工作流编排：Phase 3 之后视情况，有可能永远不做；不要把 Agent  
   多步骤误当工作流引擎，不要把 harness 当 DAG 节点

## 1. 项目定位与边界

### 1.1 目标用户与场景

- **目标用户**：个人开发者、开源贡献者、小团队工程师，已有本地代码仓库与 LLM API Key（或 OAuth）。
- **核心场景**：在本地仓库内通过自然语言完成「读代码 → 改代码 → 跑命令 → 看结果」的循环；典型任务包括 Bug 修复、重构、生成测试、写文档、跨文件搜索改写。
- **运行形态**：Agent 进程跑在用户机器上，直接持有文件系统 / Shell / Git 的访问权，LLM 调用直连云端 Provider。

### 1.2 不做什么

- **不做**云端代码托管、不做协同编辑、不做 IDE 插件（首版）。
- **不做**为不同业务方定制的"通用 Agent 平台"——这是 SaaS 路线，不在本项目目标内。
- **不做**远程沙箱执行（首版默认在用户本地执行，沙箱仅做权限隔离，不做容器化）。

---

## 2. 关键架构判断（核心）

### 2.1 后端服务要不要？

**结论：MVP 阶段不要后端。后端是「条件触发」的演进结果，不是默认组件。**

| 场景                                       | 是否需要后端   | 理由                                                                   |
| ------------------------------------------ | -------------- | ---------------------------------------------------------------------- |
| 个人/开源工具，用户自带 API Key            | **否**         | 客户端直连 LLM Provider 即可，多一层后端只增加部署成本、延迟与隐私风险 |
| 纯本地代码操作，无团队协作                 | **否**         | 文件、Shell、Git 都在本地，没有跨端同步需求                            |
| 需要托管 LLM Key（避免用户配置）           | **是**         | Key 必须服务端持有，客户端不能见明文                                   |
| 需要团队级会话 / 知识库共享                | **是**         | 跨端持久化、权限、审计                                                 |
| 云端 Agent（不在用户机器上跑）             | **是**         | 执行环境本身在云上                                                     |
| 企业部署需要审计 / 限流 / 计费             | **是**         | 这是网关职责，必须有服务端                                             |
| 想要多 Provider 路由 / Key 兜底 / 用量统计 | **是（轻量）** | 可以是一个非常薄的 LLM Gateway                                         |

**触发条件**（任一命中再考虑引入后端，且只引入解决该问题所需的最小服务）：

1. 不希望用户自管 Key（产品要降低门槛）
2. 出现 ≥2 端同步会话/记忆的需求
3. 出现团队/企业付费意向，需要统一审计
4. 自建模型路由 / 灰度 / A-B 实验

### 2.2 客户端 MVP → 后端按需 的演进合理性

**合理，且强烈推荐。** 理由：

- **价值锚点早**：用户第一天就能用客户端单端跑通对话 + 工具调用。
- **避免提前抽象**：在没有真实多端/多用户压力前，任何 IDL/RPC/微服务设计都是空想。参见 liskin/ "先画 645 个 IDL 方法"——那是 SaaS 平台型语境下的产物，套到本地 Agent 上就是过度设计。
- **可逆**：客户端把 LLM Provider 抽象成 `LLMProvider` 接口，未来要走后端中转，只需新增一个 `RemoteGatewayProvider` 实现，业务代码零改动。

### 2.3 与平台型 SaaS（Devin / ）的差异

| 维度         | 平台型 SaaS            | 本项目（本地 Agent）               |
| ------------ | ---------------------- | ---------------------------------- |
| 执行环境     | 云端 VM / 沙箱         | 用户本机                           |
| 部署形态     | 多租户后端 + Web 前端  | 单机进程                           |
| 关键复杂度   | 多租户隔离、计费、调度 | 工具系统、流式状态机、本地权限     |
| 需要 IDL/RPC | 通常需要               | **不需要**——同一进程内函数调用即可 |
| 用户 Key     | 平台托管               | 用户本地保管                       |

**核心差异：本项目不是"平台"，是"工具"**。设计取舍倾向**单进程、少抽象、本地优先**。

---

## 3. 客户端架构（核心交付物）

### 3.1 总体分层

```
┌───────────────────────────────────────────────┐
│  UI 层（MVP: Web/React; 后续: Ink/Bubble Tea）│
└──────────────────┬────────────────────────────┘
                   │ HTTP/SSE（同进程 localhost）
┌──────────────────▼──────────────────────────┐
│  Agent Core                                 │
│  - 会话状态机（思考/调用工具/等用户/出错）  │
│  - 上下文管理（消息裁剪、token 预算）       │
│  - 工具调度器（并发/确认/取消）             │
└──┬───────────┬──────────────┬──────────┬────┘
   │           │              │          │
┌──▼──┐   ┌────▼─────┐   ┌────▼─────┐ ┌──▼────┐
│ LLM │   │ Tool     │   │ MCP      │ │ Store │
│Adapt│   │ Registry │   │ Client   │ │ SQLite│
│ er  │   │ (fs/exec │   │ (stdio   │ │ /JSON │
│     │   │  /search)│   │ JSON-RPC)│ │       │
└─────┘   └────┬─────┘   └──────────┘ └───────┘
               │
        ┌──────▼───────┐
        │ Sandbox 层   │
        │ 危险命令拦截 │
        │ 用户确认 /   │
        │ 路径白名单   │
        └──────────────┘
```

### 3.2 各模块职责

- **UI 层**：纯渲染 + 输入采集，不持有业务状态。MVP 用 React + SSE 订阅 Agent Core 事件流。
- **Agent Core**：唯一"大脑"，持有会话状态机；输入是用户消息或工具结果，输出事件流（`token`、`tool_call`、`tool_result`、`done`、`error`）。
- **LLM Adapter**：抽象 `LLMProvider` 接口（`chatStream(messages, tools) -> AsyncIterable<Event>`）；首版实现 OpenAI、Anthropic 两个适配器。
- **Tool Registry**：函数注册表 + JSON Schema；按职责分类：`fs.*` / `shell.exec` / `search.*` / `git.*` / `mcp.*` / `harness.*`（详见 §11）。
- **MCP Client**：作为 MCP 协议消费方，stdio JSON-RPC 接外部工具服务器；MCP 工具注册到 Tool Registry 同一命名空间。
- **Store**：会话历史、记忆（CLAUDE.md/AGENTS.md 风格）、配置；MVP 用 SQLite（`better-sqlite3`）。
- **Sandbox**：所有写操作必须经此层，做路径白名单、危险命令模式匹配、用户确认（auto-approve / ask / deny）。

### 3.3 关键数据流

```
User Input
   │
   ▼
[UI] POST /chat → [Agent Core]
   │
   ├─ 加载会话上下文（Store）
   ├─ 拼装 messages + tools schema
   ▼
[LLM Adapter] chatStream()  ←─── 流式返回 ───┐
   │                                          │
   ├─ event: token        → SSE → UI 渲染      │
   ├─ event: tool_call    →                   │
   │     ├─ Sandbox 检查（必要时阻塞等用户确认）│
   │     ├─ 执行工具 → 拿到结果                │
   │     └─ 把 tool_result 塞回 messages ──────┘（再次 chatStream）
   │
   └─ event: done → 落库 → SSE: done → UI
```

### 3.4 进程模型

**推荐：单进程 + 同进程 HTTP（localhost）暴露给 UI**。

- UI 与 Core 通过 HTTP/SSE 通信，物理上同一个 Node 进程。
- UI 可换（Web → Ink → 任意），Agent Core 零改动。
- 未来要拆出 Daemon 模式（`agent serve` + `agent attach`）只是换传输层（详见 §12.6）。
- **不推荐**：MVP 阶段拆 Daemon + Client 两进程，没有相应收益。

### 3.5 选型表

| 模块      | 推荐                           | 理由                                     |
| --------- | ------------------------------ | ---------------------------------------- |
| 语言      | TypeScript（Node 20+）         | 前后端同语言、生态成熟                   |
| HTTP 框架 | **Hono**                       | 极轻、Web 标准 API、SSE 友好             |
| LLM SDK   | `@anthropic-ai/sdk` + `openai` | 官方 SDK 处理流式 / tool call 比手撸更稳 |
| 持久化    | `better-sqlite3`               | 同步 API、零依赖、单文件                 |
| 代码搜索  | 调外部 `ripgrep` 二进制        | 不要自己实现                             |
| 语法分析  | `tree-sitter`（按需）          | 仅符号级搜索/重构时引入，MVP 不强制      |
| MCP       | 自实现 stdio JSON-RPC client   | 协议简单、可控                           |
| 进程执行  | `execa`                        | 比 `child_process` 人性化                |
| Schema    | `zod`                          | 工具入参校验 + 类型推导                  |
| 前端      | React + Vite + Tailwind        | MVP 够用                                 |

---

## 4. MVP 阶段最小闭环

**必须有**：1 个 LLM Provider（推荐 Anthropic）+ 3 个工具（`fs.read/fs.write/shell.exec`）+ 单会话流式 + 工具确认弹窗 + Web UI（聊天 + diff 预览）+ 会话历史落 SQLite。

**不必须有**：多 Provider、MCP、记忆/AGENTS.md、终端 UI、多会话管理（全部 Phase 1+）。

### 目录结构

```
liskarm_cc/
├── packages/
│   ├── core/              # Agent Core（纯 TS 库，无 HTTP）
│   │   └── src/{agent.ts, llm/, tools/, sandbox/, store/}
│   ├── server/            # Hono HTTP 层（薄）
│   │   └── src/routes/chat.ts    # POST /chat (SSE)
│   └── web/               # React UI
└── package.json           # pnpm workspace
```

### 端到端流程（用户：「给 formatDate 加时区参数」）

1. UI 发 `POST /chat`，建立 SSE
2. Core 加载上下文 + 注入 system prompt + tools schema
3. `LLMProvider.chatStream` 流式返回：
   - `token` → SSE → UI
   - `tool_call: fs.read` → Sandbox 通过 → 执行 → 结果回灌 messages → 再次 chatStream
   - `tool_call: fs.write` → Sandbox **拦截** → UI 弹 diff → 用户接受 → 写入
   - `tool_call: shell.exec("npm test")` → 默认 `ask` → 确认 → 执行
4. `done` → 落库 → SSE 关闭

---

## 5. 后端服务（可选，按需引入）

### 5.1 触发条件

仅当满足之一才引入：① Key 托管 ② 多端同步 ③ 团队协作 ④ 云端 Agent ⑤ 企业审计/计费。

### 5.2 引入时只做三件事

1. **LLM 网关**：Key 托管 + 限流 + 审计（透传式，不解析业务语义）
2. **会话同步**：CRUD 会话/消息（一两张表）
3. **用户体系**：登录、Token、最小 RBAC

### 5.3 明确不做的事

- ❌ 先画几百个 IDL/RPC 方法（liskin/ 反例）
- ❌ 提前微服务化，一个 Hono 单体撑到 1k 用户没问题
- ❌ 照搬特定框架/RPC 协议
- ❌ 在后端做 Agent 推理逻辑（推理只在客户端，后端是无状态网关）

### 5.4 推荐栈

**Hono + TS + SQLite/Postgres**，单进程容器部署（Fly.io / Railway / 自建 VM）。客户端通过新增 `RemoteGatewayProvider` 接入，无侵入。

---

## 6. 阶段路线图

| 阶段                               | 目标                                                              | 退出标准                           | 价值锚点                  |
| ---------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | ------------------------- |
| **Phase 0 MVP**                    | 单端跑通                                                          | 完成一个真实 PR 级任务（读→改→跑） | 替代 ChatGPT 复制粘贴流程 |
| **Phase 1 完善**                   | MCP / 多 Provider / 记忆 / 多会话 / 终端 UI / Harness 框架（§11） | 终端常驻使用，覆盖 80% 日常编码    | 真正成为日常工具          |
| **Phase 2 后端按需 / IDE 插件**    | 仅当 §5.1 / §12 命中                                              | 解决具体诉求即停                   | 视情况                    |
| **Phase 3 平台化 / 工作流（§13）** | 团队/企业                                                         | 视商业化                           | —                         |

> **重点：Phase 2/3 是支线，不是必经之路。永远停在 Phase 1 的开源工具完全可以是成功的。**

---

## 7. 关键决策与权衡（决策记录）

### 7.1 为什么 TS 而不是 Go/Rust/Python

- LLM/MCP 生态最齐全在 TS
- 前后端共享 zod schema 与类型，节省一半粘合代码
- Node 性能对 IO 密集的 Agent 足够
- 代价：长程 CPU 重活（如 tree-sitter 大仓索引）需 worker 或外部二进制

### 7.2 为什么 MVP 用 Web UI 而不是直接 Ink/Bubble Tea

- Web 对 diff、流式、富文本门槛低；Ink 的 diff 体验需要更多打磨
- 调试器、DevTools 现成
- 终端 UI 是 Phase 1 加的，Core/UI 解耦后并行迭代成本低

### 7.3 Agent Core 与 UI 解耦：三种选择对比

| 方式                                  | 优点                      | 缺点         | 选择           |
| ------------------------------------- | ------------------------- | ------------ | -------------- |
| 直接函数调用                          | 最简单                    | UI/Core 耦合 | ❌             |
| **HTTP/SSE on localhost**             | 解耦、可换 UI、可远程调试 | 多一层序列化 | ✅ MVP         |
| 真 IPC（child_process / Unix socket） | 进程隔离                  | 复杂         | Phase 2 视需要 |

### 7.4 Tool 安全模型

- **路径白名单**：默认仅 cwd 子目录
- **危险命令拦截**：`rm -rf /`、`curl | sh`、`~/.ssh`、`.env` 写操作 → 强制确认
- **确认策略**：`auto / ask / deny` 三档，按工具粒度配置；写 + exec 默认 `ask`
- **沙箱执行**：Phase 1+ 引入 `--sandbox`（macOS sandbox-exec / Linux bubblewrap）；MVP 不做

### 7.5 多 Provider 抽象层

**统一中间表示（薄包装）**，覆盖 90% 共性（chat + tool use + 流式 + usage），Provider 特有能力（如 Anthropic prompt caching）通过 `extra` 透传。**不要做超集 schema**——会变成又一个 645 IDL。

```ts
interface LLMProvider {
  chatStream(req: ChatRequest): AsyncIterable<LLMEvent>;
}
type LLMEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown }
  | { kind: 'tool_result_ack' }
  | { kind: 'done'; usage: Usage }
  | { kind: 'error'; error: Error };
```

---

## 8. 风险与对策

| 风险                        | 对策                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 流式 + tool call 状态机复杂 | 显式状态机（`idle/streaming/awaiting_tool/awaiting_user`），单一事件入口；状态转换写单测                            |
| 长上下文 Token 爆炸         | 滑动窗口 + 工具结果裁剪 + AGENTS.md 摘要注入；80% 预算时主动 summarize                                              |
| 大文件读取                  | `fs.read` 分块 + 行号范围；超阈值返回前 N 行 + 提示模型用 `search`                                                  |
| 并发 Tool 安全              | 写串行（同路径）；读 + search 可并发；exec 默认串行                                                                 |
| API Key 存储                | OS Keychain（macOS Keychain / Win Credential Manager / libsecret）；fallback `~/.config/agent/keys.json` 600 + 告警 |
| 误删用户文件                | 写/删前 diff 预览 + 确认；保留撤销栈（Phase 1）                                                                     |
| MCP 服务器质量参差          | MCP 工具默认 `ask`；记录调用日志；超时强 kill                                                                       |

---

## 9. 参考实现对照

| 产品            | 形态                   | 后端                  | UI             | 关系                            |
| --------------- | ---------------------- | --------------------- | -------------- | ------------------------------- |
| **Claude Code** | 本地 CLI / VSCode 扩展 | 仅 Anthropic API      | Terminal + IDE | **形态最接近**，参考基准        |
| **Cursor CLI**  | 本地 CLI               | 有（Cursor 自营网关） | Terminal       | 后端是商业 Key 托管，MVP 不需要 |
| **Aider**       | 本地 CLI（Python）     | 无                    | Terminal       | 架构理念接近：单端 + 自带 Key   |
| **Cline**       | VSCode 扩展（TS）      | 无                    | IDE 侧栏       | TS 同生态，工具集设计可参考     |
| **Devin / **    | 云端 SaaS              | 重后端、多服务        | Web            | **不参考**：会引入过度设计      |

**立场**：靠近 Aider/Claude Code，远离 Devin/。

---

## 10. 未决事项（Phase 1 再定）

- [ ] 终端 UI 选 Ink 还是 Bubble Tea（涉及是否引入 Go 子进程）
- [ ] 记忆系统是 AGENTS.md 单文件还是分级（global / project / session）
- [ ] 是否提供 `--sandbox` 容器执行模式
- [ ] 多会话 UI 是否需要"分支"语义（git 风格）
- [ ] Tool 调用计费/统计粒度（Phase 2 后端话题）

---

## §11 Harness 框架

### 11.1 定义与定位

**Harness** 是 g Agent 在执行复杂任务时维护的一份**任务真相文档**：以 Markdown 文件形式落盘，记录用户意图、待办节点、已完成节点、闸门、理解笔记与控制状态，作为「可中断、可重连、可审计」的执行单元。

**与会话历史的区别**：

| 维度     | 会话历史 (messages)             | Harness                            |
| -------- | ------------------------------- | ---------------------------------- |
| 内容     | 原始 LLM token 流、工具调用 raw | 任务结构化真相（节点、依赖、状态） |
| 真相来源 | LLM 输出，易漂移                | 工具显式写入，强约束               |
| 用途     | 重放上下文                      | 续跑、重新规划、审计               |
| 可写入方 | Agent Core 追加                 | 仅通过 harness 工具                |

会话历史是「LLM 看到了什么」，harness 是「任务现在在哪儿」。两者并存，互不替代。

### 11.2 何时创建 Harness

**需要 harness 的任务**：

- 多步骤（≥3 个工具调用且步骤间有依赖）
- 跨文件（涉及 ≥2 个文件的协调修改）
- 高风险（含写文件、git 提交、shell 危险命令）
- 长耗时（预计 >5 分钟或多轮交互）
- 用户显式要求「分阶段执行」

**不需要 harness 的任务**：

- 单轮问答、读代码、解释概念
- 单文件局部改动且步骤 ≤2
- 纯查询类工具调用（grep/list）

**判断职责**：由 Agent Core 在状态机入口根据首轮规划结果决定是否调用 `harness_create`，而非 LLM 自行随意创建。MVP 可先用「步骤数 + 是否含写操作」的简单启发式。

### 11.3 数据结构（Markdown 优先）

**为什么是 Markdown 而非 JSON**：人类可读、可手工修复、便于 git diff、LLM 原生擅长读写。结构化字段通过约定的 H2/H3 标题与 bullet 前缀解析，必要时辅以 YAML front-matter。

**示例片段**：

```markdown
---
id: 2026-06-17-add-rate-limiter
created_at: 2026-06-17T10:30:00+08:00
status: active
control:
  dispatch_state: ready
  confirmation_kind: null
---

# Add Rate Limiter to Auth Endpoints

## User Intent

- 在 /login 与 /register 前接入 rate limiter
- 阈值：每 IP 每分钟 10 次
- 命中后返回 429

## Understanding

- 现有中间件链：packages/server/src/app.ts:42
- 已存在 ioredis 依赖，可复用
- 测试框架：vitest（packages/server/test/）

## Gates

- gate-tests-pass: PENDING (acceptance: pnpm -F server test 全绿)
- gate-no-perf-regression: PENDING (acceptance: p99 < 5ms)

## Pending

### node-1: 设计 limiter 中间件接口

- depends: []
- acceptance: 中间件签名与现有 auth 中间件兼容
- status: PENDING

### node-2: 实现 Redis 计数逻辑

- depends: [node-1]
- acceptance: 单测覆盖正常 / 超限 / Redis 故障三场景
- gate: gate-tests-pass

### node-3: 接入 /login /register 路由

- depends: [node-2]
- acceptance: 集成测试通过
- gate: gate-tests-pass

## Completed

<!-- 节点完成后从 Pending 迁移到这里，append-only -->
```

完成的节点写法：

```markdown
## Completed

### node-1: 设计 limiter 中间件接口

#### Status

- result: DONE
- completed_at: 2026-06-17T10:42:00+08:00

#### Contract

- deliverables: packages/server/src/middleware/rate-limit.ts (signature only)
- evidence: file:packages/server/src/middleware/rate-limit.ts:1-20
- findings: 复用 Express RequestHandler 类型即可
```

### 11.4 生命周期与状态机

```
[user request]
   │
   ▼
[Agent Core 规划]──需 harness?──no──▶ 普通会话执行
   │ yes
   ▼
harness_create  ──▶  active/<id>.md (Pending 全部填充)
   │
   ▼
┌─────── dispatch loop ───────┐
│ pick next pending node      │
│   │                         │
│   ▼                         │
│ Agent 执行（调用工具）      │
│   │                         │
│   ▼                         │
│ harness_record_node_result  │ ◀── 节点结果必须落盘
│   │                         │
│   ├── DONE → 迁移到 Completed
│   ├── FAILED → control=awaiting_graph_reconcile
│   └── NEEDS_USER → control=awaiting_user_confirmation
│   │                         │
│   ▼                         │
│ harness_update_graph_plan   │ (re-derive Pending suffix)
└─────────────────────────────┘
   │ all pending drained & gates green
   ▼
harness_complete ──▶ active/*.md → completed/*.md
```

**与 Agent 状态机的关系**：harness 不替代状态机，而是状态机在「running」态内的子状态外化。状态机仍然驱动 token/tool_call/tool_result 事件流；每当一个有意义的工具调用闭环结束，状态机调用 `harness_record_node_result` 把这次推进固化到磁盘。

### 11.5 关键约束

| 约束                      | 说明                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Completed 冻结            | 已完成节点不可改写，只可追加新节点                                                                                                |
| 重新规划只动 Pending 后缀 | `harness_update_graph_plan` 只能替换 Pending；前置依赖如已 Completed 不可回退                                                     |
| 落盘先行                  | 节点结果必须先写入 harness 再进入下一次 dispatch，避免内存与磁盘漂移                                                              |
| Control State 三态        | `ready` (可继续)、`awaiting_user_confirmation` (待用户确认)、`awaiting_graph_reconcile` (失败结果使 Pending 失效，必须先 re-plan) |
| 单一写入路径              | 只能通过 harness 工具写入，禁止 Agent 旁路改 md 文件                                                                              |

### 11.6 存储与目录约定

```
.liskin/
├── harness/
│   ├── active/         # 进行中的任务，每文件一个 harness
│   │   └── 2026-06-17-add-rate-limiter.md
│   └── completed/      # 完成归档，append-only
│       └── 2026-06-15-fix-login-bug.md
└── sessions.db         # SQLite 会话与消息（已有 §3）
```

文件名使用 `YYYY-MM-DD-<kebab-task-name>.md`。SQLite 中的 session 表新增 `harness_path` 弱关联字段，但**真相在文件**——SQLite 故障不影响 harness 续跑。

### 11.7 工具接口（注册到 Tool Registry）

| 工具                            | 用途                        | 形态                                  |
| ------------------------------- | --------------------------- | ------------------------------------- |
| `harness_create`                | 创建新 active harness       | 写：用户意图 + 初始 Pending           |
| `harness_record_node_result`    | 记录单节点结果              | 写：迁移 Pending→Completed 或更新状态 |
| `harness_update_graph_plan`     | 重新规划 Pending 后缀       | 写：替换 Pending；清除 reconcile 阻塞 |
| `harness_reconcile_node_result` | 失败 + re-plan 原子写       | 写：上述两步合并                      |
| `harness_complete`              | 终结归档                    | 写：active → completed                |
| `harness_read`                  | 读取当前 harness            | 读                                    |
| `harness_list`                  | 列出可恢复的 active harness | 读                                    |

这些工具**就是 Tool Registry 中的普通工具**，与文件读写、shell 等同形态。LLM 通过 function call 主动调用，配合 system prompt 的「何时调用」指引使用。

### 11.8 与 Tool 系统的关系

- harness 工具复用 §3 的 JSON Schema 校验与 sandbox（路径白名单约束写入仅限 `.liskin/harness/`）
- 不需要为 harness 单独造一层抽象；它就是「带语义的文件 IO 工具」
- 危险命令拦截、`auto/ask/deny` 策略对 harness 工具不适用（这些工具本身是元数据写入，无副作用风险）

### 11.9 MVP 范围

**MVP 做**：

- 单 harness 顺序执行
- Markdown 文件 + 七个核心工具
- control state 三态
- 续跑：启动时 `harness_list` 提示用户是否恢复

**MVP 不做**：

- 并行节点 / 子图（DAG fan-out）
- Lineage（harness 之间的衍生关系）
- 跨 harness 的全局 gate
- harness 之间的 import / 复用

### 11.10 未决事项

- harness 的 schema 是否需要 lint 工具（参考 oh-my-code 的 `harness_lint`）
- 节点 ID 命名规则是否强约束（避免 LLM 生成混乱 ID）
- Completed 节点的 token 体积管理（长任务 harness 可能膨胀，是否需要摘要折叠）

---

## §12 IDE 插件

### 12.1 核心策略：插件是 UI，不是 Agent

**反模式警告**：不要在插件里跑独立的 Agent 实例。每个 IDE 窗口一个 Agent、各自管理状态、各自写 SQLite——会立刻陷入「多 Agent 同步」的泥潭。

**正确形态**：

```
┌────────────┐   ┌────────────┐   ┌────────────┐
│ VSCode 插件│   │ JetBrains  │   │  Web UI    │
└──────┬─────┘   └─────┬──────┘   └─────┬──────┘
       │ HTTP/SSE      │ HTTP/SSE       │ HTTP/SSE
       └───────────────┼────────────────┘
                       ▼
              ┌──────────────────┐
              │  Agent Daemon    │  ← 唯一 Agent Core
              │  (agent serve)   │     单一会话/harness/工具状态来源
              └────────┬─────────┘
                       │
                       ▼
                 SQLite + .liskin/
```

插件**不持有 LLM Key、不做推理、不维护会话状态**，仅做：UI 渲染、流式事件订阅、编辑器集成（diff 应用、文件高亮、引用注入）。

### 12.2 架构与启动流程

1. 插件启动时检查本地 `agent` CLI 是否安装；未安装提示用户 `npm i -g @liskin/cli`
2. 插件以子进程拉起 `agent serve --port 0 --token <random>` 自动选端口
3. Daemon 把端口与 token 写入 `~/.liskin/daemon.json`
4. 插件读取 daemon.json，建立 HTTP/SSE 连接
5. 用户关闭 IDE 时插件**不杀 Daemon**（其他 UI 可能仍在用）；超时无连接由 Daemon 自我退出

如果用户已通过 CLI 或 Web UI 启动了 Daemon，插件直接复用。

### 12.3 关键能力

| 能力      | 说明                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| 侧栏对话  | 流式 token 渲染，复用 SSE `/v1/chat/stream`                                           |
| Diff 集成 | Agent 产出的修改 → VSCode `vscode.diff` 视图 → 用户接受/拒绝                          |
| 选中即问  | 右键 "Ask Agent"，自动注入选中范围作为引用                                            |
| @-mention | `@file:src/foo.ts` / `@symbol:Foo.bar`，由插件解析后作为 context 段发给 Daemon        |
| 任务恢复  | 启动时拉 `/v1/harness/list`，侧栏列出可续跑的 active harness                          |
| 工具确认  | Daemon 推送 `tool_confirm_required` 事件 → 插件弹原生确认窗 → 回写 `/v1/tool-confirm` |

### 12.4 协议（Daemon 暴露）

版本化前缀 `/v1/`，以下为形态（不展开字段）：

- `POST /v1/chat` + `GET /v1/chat/stream` （SSE）
- `GET /v1/harness/list` / `GET /v1/harness/:id` / `POST /v1/harness/:id/resume`
- `POST /v1/tool-confirm`
- `GET /v1/file-events` （SSE，文件变更广播给所有 UI）
- `GET /v1/health`

兼容性保证：`/v1/` 不做破坏性变更，新增能力进 `/v2/`。

### 12.5 JetBrains 同形态

基于 IntelliJ Platform SDK，使用 Kotlin 实现一个薄 UI 层，**协议层完全复用** `/v1/`。差异只在编辑器 API（diff、selection、virtual file）。

### 12.6 单进程到 Daemon 的演进点

| 阶段                                            | 形态                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| MVP (§4)                                        | 单进程：CLI 直接拉起 Agent Core，Web UI 嵌在同进程               |
| Phase 1 末 / IDE 插件出现时 / Web UI 多人共享时 | 拆 Daemon：`agent serve` 独立进程，CLI / Web UI / IDE 都是客户端 |

**MVP 阶段的预留动作**：

- `packages/server` 的 HTTP/SSE 接口设计就按未来 Daemon 形态写，不要嵌死在 CLI 进程内
- 配置文件（API key、模型等）从 env 与 `~/.liskin/config.json` 读，不依赖 CLI 启动参数
- 不在 Agent Core 里直接读 stdin/stdout——所有 IO 走传输层

这样从单进程到 Daemon 的迁移，就是「把 server 模块换种启动方式」，零代码重构。

### 12.7 决策表

| 决策                | 选择                   | 原因                            |
| ------------------- | ---------------------- | ------------------------------- |
| 推理在哪            | Daemon                 | 单一真相、Key 集中、状态一致    |
| 插件如何启动 Daemon | 自动拉起 + 复用已存在  | 用户零感知                      |
| 跨 IDE 协议         | HTTP/SSE               | 已有 Web UI 复用，跨语言友好    |
| 鉴权                | localhost + 随机 token | MVP 足够，避免 OS keychain 依赖 |

### 12.8 未决事项

- Daemon 的多用户场景（多个系统用户共用一台机器）：先不支持，单用户假设
- 插件市场分发与版本对齐策略
- 离线场景下 Daemon 的故障兜底（重启策略、日志位置）

---

## §13 工作流编排与流水线

### 13.1 边界声明

**这一章的核心价值是：告诉读者什么时候不要做。**

工作流编排是 **Phase 2/3 之后** 的能力。MVP、Phase 1 完全不做，**有可能永远不做**。

### 13.2 两类需求必须分清

| 类型               | 描述                                                 | 方案                                                |
| ------------------ | ---------------------------------------------------- | --------------------------------------------------- |
| **Agent 内编排**   | 单次任务内部的多步骤决策（写代码 → 跑测试 → 修 bug） | **已被 §11 harness + 状态机覆盖，不需要工作流引擎** |
| **外部流水线编排** | 跨任务、跨 Agent、定时、批量、协作                   | 才是真正的工作流场景                                |

混淆这两者是引入过早抽象的最大根源。**Agent 的多步骤能力 ≠ 工作流引擎。**

### 13.3 触发条件（同时满足才考虑）

只有当以下场景**真实出现**且**频率足够高**时才考虑引入：

1. 团队级批量 PR（一次升级 50+ 仓库的依赖）
2. 跨仓代码迁移（API 重命名、框架升级）
3. 定时巡检（每天扫描代码异味、跑安全审计）
4. 多 Agent 协作（review Agent + fix Agent + test Agent 流水线）
5. 与外部系统（CI/CD、issue tracker、发布单）深度耦合的任务

**只满足 1 项时**：用 shell 脚本 + Agent CLI 拼一拼即可。

### 13.4 如果引入，可能的形态

```
workflow.yaml
   │
   ▼
┌──────────────────────┐
│   DAG Runner         │
│  (节点 = Agent 调用) │
└──────────┬───────────┘
           │ for each node
           ▼
┌──────────────────────┐
│  agent run --task X  │  ← 单节点 = 一次 Agent 调用 + 一份 harness
│  (复用 Daemon API)   │
└──────────┬───────────┘
           ▼
       node output
```

- **声明式描述**：YAML 或 TS DSL，节点 / 依赖 / 条件 / 并发度 / 重试策略
- **节点执行者**：复用 Agent CLI / Daemon API；每个节点产出一份 harness，可独立审计
- **引擎选型一句话推荐**：
  - 内部团队场景 → **借用现有 CI**（Bits / GitHub Actions）+ Agent CLI 即可
  - 真要自研 → **minimal DAG runner**（200 行 TS），不要上 Temporal 这种重型框架，除非有持久化工作流的硬需求

### 13.5 强烈警告

| 警告                                         | 原因                                                            |
| -------------------------------------------- | --------------------------------------------------------------- |
| 不要在 Phase 0/1 抽象「工作流引擎接口」      | 没有真实场景的抽象 = 错的抽象                                   |
| 不要把 harness 设计成工作流节点              | harness 是单任务真相，不是 DAG 节点；二者的不可变性约束完全不同 |
| 不要把 Agent 内多步骤当工作流卖              | 误导用户预期，最终既不是好 Agent 也不是好工作流引擎             |
| 不要为「未来可能的工作流」而牺牲单进程简洁性 | 违背 §1 的核心信条                                              |

### 13.6 路线图位置

| 阶段          | 工作流相关动作                                                                       |
| ------------- | ------------------------------------------------------------------------------------ |
| MVP / Phase 1 | **不做**。不预留接口、不写抽象层                                                     |
| Phase 2       | **不做**。除非触发条件 ≥3 项被验证                                                   |
| Phase 3 之后  | **视真实诉求决定，可以永远不做**。若做，先 shell + CLI 拼，再考虑 minimal DAG runner |

### 13.7 决策表

| 问题                           | 答案                                                 |
| ------------------------------ | ---------------------------------------------------- |
| MVP 要不要预留工作流抽象       | 不要                                                 |
| harness 是否能演进为工作流节点 | 不能直接演进，但可作为节点的执行单元被复用           |
| 选自研还是 Temporal            | 99% 场景借用现有 CI；自研只在 minimal DAG 层级       |
| 多 Agent 协作怎么实现          | 暂不做；真要做就是 N 个 `agent run` 串接，不是新引擎 |

### 13.8 未决事项

- 「批量代码改造」是否值得做一个轻量 CLI（`agent batch --repos ... --task ...`）作为最小可用形态——这不算工作流引擎，只是循环
- 与外部 CI 集成的最小协议（job 输出 → harness 路径回传）
- 「永远不做」的判断节点：以触发条件计数器形式留在路线图，避免被随机需求带偏
