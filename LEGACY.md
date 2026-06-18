# Legacy directories

本仓库当前主线为本地 Coding Agent (TypeScript)。详见 `docs/architecture/coding-agent-design.md`。

以下目录为历史遗留模块，M0 阶段全部搁置，不纳入 pnpm workspace。

## `server/` — Go + Gin + faasrouter（搁置）

- 内容：`server/application/faasrouter/`（Go + Gin 后端）、`server/idl/`（Thrift IDL）。
- 搁置原因：项目方向已切换到本地 Coding Agent（TS Monorepo）。
- 重启条件：Phase 2「后端按需」阶段，若需要远程多用户/多租户/历史持久化等服务端能力，可重新激活。
- 当前不要修改本目录。

## `web/` — 现有 React + Vite + pnpm 独立工程（暂留）

- 当前是独立的 pnpm + Vite 工程，已有自己的 `package.json` 和 `pnpm-lock.yaml`。
- M0 不纳入 workspace（避免 lockfile 冲突）。
- 计划：M2 阶段改造为 Web UI 时再合并到 workspace。
- 当前不要修改本目录。

## Active 模块（M0）

- `packages/core` — L1 Agent 状态机内核 + Harness
- `packages/tools` — L2 Tool Registry + Sandbox + 内置工具
- `packages/llm` — L3 LLMProvider 接口与适配器
- `packages/server` — L4 Hono daemon + SSE + SQLite
- `client/` — 产品入口 CLI (`agent serve` / `agent chat`)
