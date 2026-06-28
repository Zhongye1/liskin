# feat(web): Claude Code 风格 UI 重构

## 背景

基于 `liskin` 现有前端（React 18 + Vite + TypeScript + Tailwind + Radix + zustand + react-router），
按设计稿（Claude Code 风格 Web 界面）重做 Web 端 UI 与基础交互。改动仅限 `web/`，
不触碰内核 / 协议 / 传输层，沿用既有 `KernelClient` 数据流与 `session-store`。

## 改动总览

### 1) UI Harness（commit 1）

为 UI 提供可独立走查、可测试的地基：

- **设计令牌**：`web/tailwind.config.ts` 集中定义语义色板（canvas / sidebar / panel / accent / ink / 状态色）、字体、圆角、阴影，组件只消费语义 token，便于换肤。
- **展示型基元**：`web/src/shared/ui/primitives.tsx`（Avatar / Badge / Pill / IconButton）+ `icons.tsx`（内联 SVG 图标集，零图标库依赖）。
- **Fixtures**：`web/src/shared/ui/harness-fixtures.ts` 提供 mock 项目 / 会话 / 对话流，供预览页与单测复用。
- **测试**：`web/test/harness-fixtures.test.ts` 6 条形状契约测试。

### 2) UI 重构（commit 2）

- **顶部浏览器外壳** `BrowserChrome.tsx`：红绿灯 + 标签页 + 地址栏（装饰层）。
- **侧栏** `Sidebar.tsx`：品牌头 + 内联 composer 卡片 + 项目/Cloud 选择 Pill + 会话列表 + 设置入口；纯展示组件，数据/回调由 `App` 注入。
- **对话面板** `Conversation.tsx`：新增面板标题栏；底部 composer 改为圆角卡片 + textarea + 图标发送/停止按钮。
- **步骤渲染** `Steps.tsx` / `TurnItem.tsx`：工具调用改为「状态点 · 工具名 · 参数」单行样式，贴合设计稿；用户气泡改用陶土橙主题。
- **预览路由** `/ui-preview`：用 fixtures 全量渲染新 UI，无需后端即可走查/截图。

## 顺带修复

`Steps.tsx` 中 `ConfirmCard` 调用 `approveTool()/denyTool()` 缺少必传的 `sessionId` 参数
（原代码 `tsc` 编译不通过）。现从路由 `useParams` 取 `sessionId` 后再调用。

## 验证

- `pnpm --filter liskin-web build` ✅（tsc -b + vite build 通过）
- `pnpm --filter liskin-web test` ✅（23 passed：原 17 + 新增 6）
- `oxlint src test` ✅ 无 error
- 全仓 `tsc -b` ✅

## 走查方式

```bash
pnpm install
pnpm --filter liskin-web dev
# 打开 http://localhost:5173/ui-preview 查看新 UI（mock 数据）
```

## 影响面

- 仅 `web/`，不改协议 / 内核 / server。
- 现有 `session-store`、事件 reducer、虚拟列表逻辑保持不变，仅替换表现层。
