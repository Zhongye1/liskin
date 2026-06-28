# init

前端 web/ 你希望使用哪个包管理器？ → pnpm
后端初始化你希望我用哪种 HTTP 实现？ → gin
IDL 这一步你希望做到什么深度？ → 落文件+可生成命令

当前仓库仅有文档（Readme.md、docs/技术选型.md），无可执行前后端工程。用户目标是复刻 codin 2025 年 4 月初始化思路，优先构建“可运行最小闭环”：

1. 前后端分离的 Web（React+TS+Vite+Tailwind）；
2. Go 服务端分层骨架（application 风格）；
3. Thrift IDL 按公共/业务拆分；
4. FaaS 转发网关（普通 + 流式）；
5. 最终完成初始化并提交 commit。

本计划采用“先跑通、再规范化”：第一轮先保证本地可启动、可请求、可流式转发；第二轮再补 lint/test/CI/配置中心化。

---

已确认决策

- 前端包管理器：pnpm
- 后端 HTTP 框架：gin
- IDL 深度：落文件 + 提供可生成命令（不强制本地生成产物纳入编译）

推荐实施路径（仅推荐方案）

1. 初始化前准备（仓库与基线）

- 关键文件：
  - 新增：.gitignore、README.md（补充启动说明）
- 操作要点：
  - 若未初始化 git，则先 git init。
  - 统一忽略：node_modules/, dist/, .DS_Store, server/bin/, \*.log。
- 复用/依据：
  - 依据 Readme.md 中“工程化与可验证闭环”理念，先建立可运行基线。

2. 前端初始化（web/）

- 关键文件（创建）：
  - web/package.json
  - web/index.html
  - web/tsconfig.json, web/tsconfig.node.json
  - web/vite.config.ts
  - web/tailwind.config.ts, web/postcss.config.js
  - web/src/main.tsx, web/src/App.tsx
  - web/src/pages/Home.tsx, web/src/pages/Chat.tsx
  - web/src/router.tsx
  - web/src/index.css
  - web/src/services/chat/index.ts
  - web/src/services/conversation/index.ts
  - web/src/services/upload/index.ts
- 操作要点：
  - 用 React + TS + Vite 创建独立工程；路由提供 / (Home) 与 /chat (Chat)。
  - Tailwind 接入后，提供基础聊天骨架（输入框、消息区、发送按钮、流式结果区）。
  - services 先提供最小 API 包装（fetch + stream reader），不引入额外复杂状态库。
- 复用/依据：
  - 复用 docs/技术选型.md 中 D2C/Tailwind 精确样式原则，前端样式基于 Tailwind。

3. 后端初始化（server/，application 分层）

- 关键文件（创建）：
  - server/go.mod
  - server/application/prd/main.go
  - server/application/prd/build.sh
  - server/application/prd/script/bootstrap.sh
  - server/application/prd/entity/（占位结构）
  - server/application/prd/logic/（占位结构）
  - server/application/prd/repo/（占位结构）
  - server/application/prd/service/（占位结构）
- 操作要点：
  - application/prd/main.go 作为核心服务入口，启动 HTTP Server。
  - 分层目录先完成可编译骨架与最小职责注释，避免“空目录无意义”。
  - build.sh 统一构建，script/bootstrap.sh 统一启动/环境检查。
- 复用/依据：
  - 按用户明确要求的 entity/logic/repo/service 分层，不额外引入框架耦合。

4. IDL 初始化（Thrift）

- 关键文件（创建）：
  - server/idl/base.thrift
  - server/idl/message.thrift
  - server/idl/conversation.thrift
  - server/idl/prd/prd.thrift
  - server/idl/agw/agw.thrift
  - server/rgo_config.yaml
- 操作要点：
  - 公共协议与业务协议拆分；agw.thrift 使用 api.post / api.get 注解声明路由。
  - rgo_config.yaml 明确 service name 到 idl_path 映射，保证生成链路可读。
- 复用/依据：
  - 以“先跑通”为准：先确保 IDL 结构完整 + 生成配置可执行，再逐步细化字段。

5. FaaS 初始化（转发网关）

- 关键文件（创建）：
  - server/application/faasrouter/main.go
  - server/application/faasrouter/handlers/forward.go
  - server/application/faasrouter/handlers/forward_stream.go
  - server/application/faasrouter/bytefaas.yml
- 操作要点：
  - 路由：POST /forward、POST /forward/stream。
  - /forward：透传 method/url/headers/body，并回传状态码与响应体。
  - /forward/stream：透传流式请求，使用 io.Copy + Flush 将下游分块实时回传。
  - 处理 context cancel、上游断连、header 白名单/黑名单（最小安全约束）。
- 复用/依据：
  - 仓库无现成实现，按标准 net/http 最小依赖实现，降低初始化风险。

6. 前后端联调与脚本统一

- 关键文件（创建/修改）：
  - web/.env.development（后端地址）
  - README.md（运行指令、验证命令）
  - 可选：根目录 Makefile（make web, make server, make verify）
- 操作要点：
  - Web 调 faasrouter，完成普通请求与流式请求演示。
  - 统一脚本入口，避免手工命令分散。

7. 提交策略（按里程碑拆 commit）

- 建议提交序列：
  a. chore(init): bootstrap web with react-ts-vite-tailwind
  b. feat(web): add home/chat skeleton and service placeholders
  c. chore(server): init go application/prd layered scaffold
  d. feat(idl): add thrift contracts and rgo config mapping
  e. feat(faasrouter): add forward and forward/stream handlers
  f. docs: add bootstrap and verification guide

---

关键改动文件（代表性清单）

▎ 本次为“从 0 到 1”初始化，以下为必须落地文件。

- 前端
  - web/package.json
  - web/src/main.tsx
  - web/src/pages/Home.tsx
  - web/src/pages/Chat.tsx
  - web/src/services/chat/index.ts
  - web/src/services/conversation/index.ts
  - web/src/services/upload/index.ts
- 后端（PRD）
  - server/application/prd/main.go
  - server/application/prd/build.sh
  - server/application/prd/script/bootstrap.sh
- IDL
  - server/idl/prd/prd.thrift
  - server/idl/agw/agw.thrift
  - server/rgo_config.yaml
- FaaS Router
  - server/application/faasrouter/main.go
  - server/application/faasrouter/handlers/forward.go
  - server/application/faasrouter/handlers/forward_stream.go
  - server/application/faasrouter/bytefaas.yml

---

验证方案（端到端）

A. 前端可启动

- 命令：
  - cd web && npm install && npm run dev
- 预期：
  - 本地打开 Vite 地址可见 Home 页面；跳转 /chat 可见聊天骨架。

B. 后端可启动

- 命令：
  - cd server/application/prd && bash ./script/bootstrap.sh
  - 或 go run ./main.go
- 预期：
  - 服务监听端口成功，健康检查接口返回 200。

C. thrift 可生成代码

- 命令（示例，按本地工具实际替换）：
  - cd server && rgo gen -c rgo_config.yaml
- 预期：
  - 生成目录出现对应代码，且无语法错误。

D. faasrouter 普通转发可用

- 命令：
  - curl -X POST http://localhost:<port>/forward -H 'content-type: application/json' -d '{"method":"GET","url":"https://httpbin.org/get"}'
- 预期：
  - 返回下游响应体与状态码。

E. faasrouter 流式转发可用

- 命令：
  - curl -N -X POST http://localhost:<port>/forward/stream -H 'content-type: application/json' -d '{"method":"GET","url":"<stream-endpoint>"}'
- 预期：
  - 客户端持续接收分块输出，无整包阻塞。

F. 基础静态检查

- 命令：
  - cd web && npm run build
  - cd server && go test ./...
- 预期：
  - 均通过。

---

风险与处理

- 命令：
  - cd web && npm run build
  - cd server && go test ./...
- 预期：
  - 均通过。

---

风险与处理

- 风险1：本地缺少 thrift/rgo 工具链。
  - 处理：在 bootstrap.sh 中加入工具检查与安装指引。
- 风险2：流式链路被中间代理缓冲。
  - 处理：在 handler 显式设置 Cache-Control: no-cache、X-Accel-Buffering: no，并主动 Flush。
- 风险3：前后端跨域。
  - 处理：开发期在后端加最小 CORS 或在 Vite 配置代理。

---

完成定义（DoD）

1. web/ 与 server/ 工程都能本地启动。
2. Chat 页面可发起普通与流式调用。
3. server/idl/ 与 rgo_config.yaml 可被工具识别并生成代码。
4. faasrouter 两个路由可成功透传。
5. 至少 5 次原子 commit，覆盖前端/后端/IDL/FaaS/文档。

---

备注

- 当前计划严格按“先初始化并可跑通”执行，不在首轮引入复杂中间件、鉴权、灰度、可观测平台接入。
- 第二阶段规范化（lint、单测覆盖、CI、错误码体系、配置中心）在首轮完成后单独排期。file creations. Using B

---

# 4月计划

- Web（web/）：4 月有连续提交（4/15～4/29），包括前后端分离、rename、U
  I/流式/渲染等，说明在持续开发。
- IDE（agent-extension/）：最早提交是 2025-05-29（feat: init  
  agent-extension），不在 4 月。
- CLI（agent-cli/）：最早提交是 2025-09-02（feat: agent-cli  
  合入），更晚。
- JetBrains（jetbrains-extension/）：最早提交是 2026-01-20，更晚。

结论

- 4 月阶段可以认为：Web + 服务端/网关（AGW/PRD/FaaS 相关）在推进。
- “三端（web/ide/cli）都完成”这个结论，不成立。  
  更准确说法是：先完成 Web 主线，IDE 和 CLI 在后续月份陆续启动与合入。

4 月主要在做的事（按优先级）

1. 后端与协议底座初始化

- 大量 server、idl、thrift 相关提交（4/15 开始非常密集）。
- 先有一版 server 形态，随后很快重构到 application/_ + idl/_  
  的服务化结构。
- 持续更新 thrift/IDL，修复生成与联调问题（字段、命名、协议版本）。

关键词：初始化后端仓库、更新 thrift、修复 idl 生成、协议演进。

---

2. 前端从模板到独立工程的路线切换

- 早期引入 web（初始是模板化结构）。
- 很快做“前后端分离”，新增 web2（Vite/React 独立前端）。
- 4/25 左右把 web2 rename 回 web，再继续 UI、消息渲染、Mermaid  
  等能力。

关键词：前后端分离、web2 rename web、前端展示完善。

---

3. 流式链路联调（核心）

- 4/16～4/22 出现大量“stream/联调/截断/换行/停不下来”等修复提交。
- 说明主要在把模型流式输出从服务端到前端完整打通并稳定化。

关键词：support stream client、联调流式、修复截断与结束信号。

---

4. AGW/FaaS 方向定型与迭代

- 有 faas  
  相关提交（切换、回滚、再调整），说明在探索部署与网关转发方案。
- AGW 目录也在 4 月有结构合入与构建脚本调整。

关键词：faas 联调、agw 目录调整、跨域处理、构建脚本收敛。

---

---

5. 能力扩展（月底开始）

- 上传文件、文档处理（含转 html/TOS）、business domain/lark  
  mcp、会话持久化等开始进入。
- 这些更像“在底座跑通后开始加业务能力”。

---

一句话总结

4 月是“基础设施月”：  
先把后端+协议+网关+流式链路打通，再把前端从模板迁到独立架构，最后开始
叠加业务能力。  
不是三端（web/ide/cli）齐头并进的阶段，而是 后端与 Web 优先、IDE/CLI  
后续扩展 的阶段。

推荐顺序（实操版）

1. AGW 最小可用层：统一入口、认证、路由、基础观测
2. Model Gateway 核心层：provider 路由、fallback、协议转换、token/计费记录
3. Session Gateway：会话态、上下文编排、与 contextengine 联动
4. 再扩展高级能力：复杂策略、灰度编排、精细化治理面板

---

一句话策略

先“做对入口”，再“做大会话”。
也就是：先把 agw + modelgateway 做成稳定控制平面，再放大 session/context 侧能力。

---

# 5月计划
