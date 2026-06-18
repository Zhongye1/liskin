# liskin

本地 Coding Agent：在本地仓库里用自然语言完成「读代码 → 改代码 → 跑命令 → 看结果」的循环。

内核（agent 状态机 + 工具 + 模型适配）与调用方（CLI / Web / IDE）完全解耦——内核不知道自己是被 CLI 还是 Web 调用，越靠内的层越稳定、越不该知道外面是谁在用它。

## 架构

```
依赖方向（单向，越往下越稳定）
─────────────────────────────────────────────────────────
  L4 接入层     client/ (CLI)  ·  web/  ·  (未来 IDE 插件)
                     ↓ 只依赖 KernelClient 接口 + 协议类型
  传输适配      packages/server (daemon: HTTP/SSE)        ← Web 必经
                     ↓
  ┄┄┄┄┄┄ 协议边界（Op / EventMsg / KernelClient）┄┄┄┄┄┄
                     ↑
  L3 模型适配   packages/llm   (LLMProvider → LLMPort)
  L2 工具/执行  packages/tools (ToolRegistry → ToolPort)
  L1 内核       packages/core  (runAgent + ports + KernelClient)
                     ↑ 不依赖任何外层
```

| 包                | 层  | 职责                                                                                                             |
| ----------------- | --- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/core`   | L1  | Agent 状态机、`runAgent` 主循环、`Op`/`EventMsg` 协议、`KernelClient` 接口、`InProcessKernelClient`              |
| `packages/tools`  | L2  | `ToolRegistry` + Sandbox（路径白名单 / 危险命令拦截 / 确认策略）、内置工具 `fs.read` / `fs.write` / `shell.exec` |
| `packages/llm`    | L3  | `LLMProvider` 接口 + OpenAI 兼容适配器                                                                           |
| `packages/server` | L4  | Hono daemon：HTTP/SSE，把 Op 翻译给内核、把 EventMsg 序列化成 SSE，SQLite 持久化                                 |
| `client/`         | L4  | 产品入口 CLI：`agent serve`（daemon）、`agent exec`（headless 一次性任务）                                       |
| `web/`            | L4  | React + Vite + Tailwind（旧实现，待重写为时间线渲染）                                                            |

**搁置模块**：`server/`（Go + Gin + faasrouter + Thrift IDL）为历史遗留，Phase 2 后端按需时再激活，当前不修改。详见 `LEGACY.md`。

## 快速开始

### 前置

- Node ≥ 20、pnpm 9
- 一个 LLM API Key（OpenAI 兼容协议；）

### 1) 安装 + 构建

### 前置

- Node ≥ 20、pnpm 9
- 一个 LLM API Key（OpenAI 兼容协议；）

### 1) 安装 + 构建

```bash
pnpm install
pnpm -r run build
pnpm -r run build
```

### 2) 配置

```bash
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY（填入你的 API 地址和模型）
```

### 3) 跑任务（agent exec，in-process，无 daemon）

### 2) 配置

```bash
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY（填入你的 API 地址和模型）
```

### 3) 跑任务（agent exec，in-process，无 daemon）

```bash
./scripts/dev.sh exec "用 matplotlib 画个柱状图存到 output/bar.png 并写 README 附图"
# 指定工作目录与最大轮数
./scripts/dev.sh exec "..." --cwd /tmp/my-task --max-turns 30
./scripts/dev.sh exec "用 matplotlib 画个柱状图存到 output/bar.png 并写 README 附图"
# 指定工作目录与最大轮数
./scripts/dev.sh exec "..." --cwd /tmp/my-task --max-turns 30
```

`agent exec` 用 `InProcessKernelClient` 直连内核，auto 批准工具，实时渲染事件流到终端，跑完即退出。事件流包含 `Token`（流式文本）、`ToolCall`/`ToolProgress`/`ToolResult`（工具调用 + 实时 stdout/stderr）、`TurnEnd`（回合结束）。

### 4) 启动全栈（agent serve + web）

`agent exec` 用 `InProcessKernelClient` 直连内核，auto 批准工具，实时渲染事件流到终端，跑完即退出。事件流包含 `Token`（流式文本）、`ToolCall`/`ToolProgress`/`ToolResult`（工具调用 + 实时 stdout/stderr）、`TurnEnd`（回合结束）。

### 4) 启动全栈（agent serve + web）

```bash
./scripts/dev.sh          # 构建 + 启动 server(8787) + web(5173)
./scripts/dev.sh --no-build   # 跳过构建
./scripts/dev.sh stop         # 停掉
./scripts/dev.sh logs         # 看日志
./scripts/dev.sh          # 构建 + 启动 server(8787) + web(5173)
./scripts/dev.sh --no-build   # 跳过构建
./scripts/dev.sh stop         # 停掉
./scripts/dev.sh logs         # 看日志
```

### 5) 开发模式（改代码自动重建）

### 5) 开发模式（改代码自动重建）

```bash
./scripts/dev.sh watch     # 并行 tsup watch（core/tools/llm/server/client）
```

## CLI

```bash
./scripts/dev.sh watch     # 并行 tsup watch（core/tools/llm/server/client）
```

## CLI

```bash
# headless 一次性任务（已验证闭环）
agent exec --model opensource/glm5.2 --base-url https://api.openai.com/v1 \
  --cwd /tmp/task "你的任务"

# 起 daemon（给 Web 用）
agent serve --port 8787 --cwd /your/workspace --cors http://localhost:5173
```

也可用 `~/.liskin/config.json` 固化默认值（apiKey / baseURL / model / confirmPolicy）。

## 工具链

- 构建：tsup · 测试：vitest · 类型：TypeScript 5.5
- Lint：oxlint（0 error / 0 warning）· 格式化：pretttier
- 提交：commitlint (conventional) + husky + lint-staged
- 依赖边界巡检：dependency-cruiser（守住五层依赖红线）

常用脚本：

# headless 一次性任务（已验证闭环）

agent exec --model opensource/glm5.2 --base-url https://api.openai.com/v1 \
 --cwd /tmp/task "你的任务"

# 起 daemon（给 Web 用）

agent serve --port 8787 --cwd /your/workspace --cors http://localhost:5173

````

也可用 `~/.liskin/config.json` 固化默认值（apiKey / baseURL / model / confirmPolicy）。

## 工具链

- 构建：tsup · 测试：vitest · 类型：TypeScript 5.5
- Lint：oxlint（0 error / 0 warning）· 格式化：pretttier
- 提交：commitlint (conventional) + husky + lint-staged
- 依赖边界巡检：dependency-cruiser（守住五层依赖红线）

常用脚本：

```bash
pnpm build          # 构建 packages/* + client
pnpm test           # 全 workspace 测试
pnpm lint           # oxlint
pnpm typecheck      # 全 workspace 类型检查
pnpm deps:check     # 依赖边界巡检
pnpm format         # prettier
````

## 内核协议

内核对外暴露 `KernelClient` 接口（`createSession` / `submit(op)` / `interrupt` / `confirmTool`），客户端只依赖它，不感知内核实现。三种实现同一接口：

- `InProcessKernelClient` — CLI MVP / 测试（直连 `runAgent`，无序列化）
- `HttpSseKernelClient` — Web（HTTP + SSE）
- `JsonRpcKernelClient` — 未来 IDE 插件

核心纪律（架构红线）：

- `core` 不依赖 tools/llm/server/client，不知道用哪家模型、不知是 CLI 还是 Web
- `tools` 不依赖 llm/server，不关心结果渲染到终端还是网页
- `llm` 只暴露接口，不知被谁用
- Loop 里不存在 `if (provider === 'openai')`、不存在 `if (tool.source === 'mcp')`

详细设计见 `docs/architecture/`：

- `coding-agent-design.md` — 整体架构与路线图
- `kernel-protocol.md` — 内核↔Provider/Tool 协议（内层）
- `kernel-sqeq-protocol.md` — 内核↔Client SQ/EQ 理想形态
- `kernel-client-protocol.md` — 现状→理想的落地路径（MVP 顺序、解耦机制）

## 当前进度

- ✅ **Step 1**：内核协议落地（`Op`/`EventMsg`/`KernelClient` + `InProcessKernelClient` + 9 测试）
- ✅ **Step 2**：CLI `agent exec` 消费器，接入真实 LLM，端到端闭环验证通过
- ✅ **Step 3**：daemon + Web 时间线重写（`agent chat` 交互式 REPL / Web SQ-EQ 升级）

  ## 下一步可选项

  按 coding-agent-design.md §6 路线图,下一站是 Phase 1 完善(目标:终端常驻使用,覆盖 80% 日常编码)。Phase 1 的几条支线相互独立,可挑顺序做:
  1. 收尾性
  - 清掉剩余 5 个未用依赖(@radix-ui/\*/ahooks/axios/swr/usehooks-ts)
  - bundle 拆分:react-markdown/highlight.js 用 dynamic import,消除 614KB chunk 警告
  - 排查 lint-staged 在本环境的 stash-restore malfunction(影响后续提交体验)
  2. MCP 协议支持(Phase 1 核心能力)
     接入 Model Context Protocol,让 agent 能连外部工具/数据源。这是 Phase 1 价值最大的一块。

  3. 多 Provider(Phase 1)
     当前 LLM 层只有 OpenAI,加 Anthropic 等。DynamicLLMPort 已有骨架,主要是 llm 包加实现。

  4. 记忆 / AGENTS.md(Phase 1)
     让 agent 读取并遵守项目里的 AGENTS.md 约定(类似当前你看到的这套机制)。

  5. 终端 UI / agent chat REPL(Phase 1)
     coding-agent-design.md §7.2 提到终端 UI 是 Phase 1 加的,Core/UI 已解耦,可并行做 Ink/Bubble Tea 版。

  6. Harness 框架(§11,Phase 1)
     多步骤任务的"任务真相文档",支持可中断/可重连/可审计。是 Phase 1 较重的一项。

  7. 沙箱执行(Phase 1+)
     --sandbox 标志(macOS sandbox-exec / Linux bubblewrap),写/删前 diff 预览 + 撤销栈。

  Phase 2/3(后端网关 / IDE 插件 / 平台化)是支线,设计文档明确"不是必经之路,触发条件命中才做"。

  ———
