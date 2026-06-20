# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / Test / Lint

```bash
pnpm build          # 构建所有包 (protocol → config → core → llm → tools → server → client)
pnpm test           # 运行所有测试 (vitest)
pnpm lint           # oxlint 全仓检查
pnpm typecheck      # tsc --noEmit 全仓

# 单包操作
pnpm --filter @liskin/core build
pnpm --filter @liskin/core test
pnpm --filter @liskin/llm test -- --reporter=verbose  # 单包测试 + 详细输出

# 开发
./scripts/dev.sh           # 构建 + 启动 server (8787) + web (5173)
./scripts/dev.sh chat      # 启动交互式 REPL (in-process, 不走 daemon)
./scripts/dev.sh exec "prompt"  # 一次性任务
./scripts/dev.sh stop      # 停掉 server + web
./scripts/dev.sh watch     # 并行 tsup watch (热构建)

# 依赖检查
pnpm deps:check            # dependency-cruiser 验证架构红线
```

**构建顺序有依赖**：`protocol` 必须先构建（core 依赖它的 `.d.ts`），`config` 同理。全仓 `pnpm build` 按 `pnpm -r` 的拓扑顺序自动处理，但批量构建时 protocol 的 DTS 可能稍慢。如果下游报 "Cannot find module @liskin/protocol"，单独 `pnpm --filter @liskin/protocol build` 再重试。

**pre-commit**：husky + lint-staged 自动运行 `prettier --write` + `oxlint --fix`。如果 oxlint 报 error（不是 warning），commit 会被拒绝。常见阻碍：未使用的 import（`no-unused-vars` error）、文件名非 kebab-case。

## 架构

### 五层单向依赖

```
L4 接入层     client/ (CLI)  ·  web/  ·  (未来 IDE)
                  ↓ 只依赖 KernelClient 接口 + 协议类型
 传输适配      packages/server (HTTP/SSE daemon)
                  ↓
 ┄┄┄┄┄┄ 协议边界（Op / EventMsg / KernelClient）┄┄┄┄┄┄
                  ↑
 L3 模型适配   packages/llm   (LLMProvider → LLMPort)
                  ↑
 L2 工具/执行  packages/tools (ToolRegistry → ToolPort + Sandbox)
                  ↑
 L1 内核       packages/core  (runAgent + 状态机 + Port 接口)
                  ↑ 零外部依赖
```

**核心原则**：内核不知道是谁在调它。`runAgent` 不 import CLI/Web/Server 的任何代码，不读 `process.stdout`，不假设 `confirm` 由人回答。内核只跟三个 Port 接口对话：`LLMPort`、`ToolPort`、`StorePort`。接口定义在 core，实现在外层。

### 依赖反转

```
core 定义接口              外层实现
──────────────────────────────────────────
LLMPort.chatStream()  →  packages/llm (OpenAIProvider)
ToolPort.invoke()     →  packages/tools (ToolRegistry + Sandbox)
StorePort.load/save   →  packages/server (SqliteStore)
KernelClient (协议)    →  core (InProcessKernelClient)
                      →  web (HttpSseKernelClient)
```

### 协议层 (@liskin/protocol)

`packages/protocol` 是前后端共享的类型契约包，**零依赖（仅 zod）**，定义：

- `Op` / `EventMsg` — 上行操作和下行事件，zod discriminatedUnion 派生
- `KernelClient` — 内核服务接口（CLI/Web/IDE 共用）
- `SessionInfo/Handle/Record`、`ToolCall/Result/Definition`
- `wire.ts` — `encodeOp/decodeOp/encodeEvent/decodeEvent/toSseFrame`

**关键规则**：跨网络的每一帧都应经过 `wire.ts` 的 `parse()` 校验。server 发事件用 `toSseFrame()`，web 收事件用 `decodeEvent()`。

### 包依赖总览

```
protocol (零依赖)
    ↑
    ├── core (依赖 protocol, 兼容 re-export 给历史 import)
    │       ↑
    │   ├── llm / tools / server
    │
    ├── config (零依赖, 仅 zod + node)
    │
    └── client → protocol + config + core + llm + tools + server
        web    → protocol + core
```

`dependency-cruiser` 在 CI 强制：core 不能 import llm/tools/server；tools 不能 import llm/server；接入层不能互相 import。

### 工具名 sanitize

`packages/llm/src/openai/translate.ts` 的 `toOpenAITools()` 自动把工具名中的非法字符（如 `.`）替换为 `_`，并维护 `sanitized → original` 映射。流解析时 `resolveOriginalName()` 还原原名。这样 ToolPort 可以用 `fs.read` 这样的自然名，OpenAI API 得到 `fs_read`，往返透明。

### Server 的两路由

| 路由                                             | 驱动                                  | 状态                           |
| ------------------------------------------------ | ------------------------------------- | ------------------------------ |
| `POST /v1/chat` (app.ts)                         | 直接调 `runAgent()`                   | Phase 0 遗留，旧 web 用        |
| `POST /v1/sessions/:id/turns` (kernel-routes.ts) | 通过 `InProcessKernelClient.submit()` | 新协议路由，web 下一步迁移至此 |

### 确认流程

工具需要确认时，`ToolRegistry` 抛 `ConfirmRequiredError` → `InProcessKernelClient.wrapToolsForConfirm()` 捕获 → push `ToolConfirmRequired` 事件到 AsyncQueue → await Deferred。消费者（CLI 的 `[y/n]` 或 Web 的确认按钮）调用 `kernel.confirmTool()` → resolve Deferred → 事件流继续。**不产生假 user 消息**。

### 测试分布

```
packages/protocol  test/wire.test.ts        24 往返测试
packages/core      test/loop + kernel       15
packages/llm       test/openai + translate  33
packages/tools     test/fs + shell + reg    42
packages/server    test/app + logs + prov   20
web                test/events.test.ts      17
```

### 特别提示

每轮编辑代码后，记得pnpm lint 和 pnpm format 保证代码质量
