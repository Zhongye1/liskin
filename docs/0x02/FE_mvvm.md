```
最终目录结构

web/src/
├── api/                          # 传输层（共享基础设施）
│   ├── client.ts                 # HttpSseKernelClient
│   ├── Http_Req/http.ts          # axios 实例
│   └── Http_Req/stream.ts        # SSE 流
│
├── pages/                        # 按页面分包（每页 = MVVM 三层）
│   ├── chat/
│   │   ├── Conversation.tsx      # View
│   │   ├── EmptyState.tsx        # View
│   │   ├── useConversationViewModel.ts  # ViewModel
│   │   ├── model/                # Model
│   │   │   ├── session-store.ts  # Zustand store（数据+API）
│   │   │   └── events.ts         # 领域逻辑（Turn/Event 转换）
│   │   └── components/           # View 子组件
│   │       ├── TurnItem.tsx
│   │       └── Steps.tsx
│   │
│   ├── settings/
│   │   ├── SettingsPage.tsx      # View
│   │   └── model/                # Model
│   │       └── providers.ts      # Provider CRUD API
│   │
│   ├── projects/
│   │   └── ProjectsPage.tsx
│   └── knowledge/
│       └── KnowledgePage.tsx
│
├── app/                          # 应用外壳
│   ├── App.tsx                   # → imports from pages/chat/model/
│   └── components/
│       ├── Sidebar_Router.tsx
│       └── Sidebar_Chat.tsx
│
├── shared/                       # 跨页面共享
│   ├── components/               # Markdown, ErrorBoundary
│   ├── lib/                      # utils, tool-views
│   └── ui/                       # primitives, button, icons
│
└── features/
    └── preview/                  # UI 走查预览（独立，不入 MVVM）

每页的 MVVM 三层

pages/chat/
  View        ← Conversation.tsx     (纯 JSX)
  ViewModel   ← useConversationViewModel.ts  (状态+逻辑 hook)
  Model       ← model/session-store.ts + events.ts  (数据+API+领域)

数据流：Model (Zustand) → ViewModel (hook) → View (JSX)
```
