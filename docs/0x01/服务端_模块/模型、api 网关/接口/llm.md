Unified Gateway 接口请求文档

1. 统一入口

- Method: POST
- Path: /gateway/model
- Content-Type: application/json

▎ 兼容保留（迁移期）：
▎ - POST /forward
▎ - POST /forward/stream

---

2. 协议识别规则

按以下优先级识别请求协议：

1. x-protocol（o

---

2. 兼容迁移策略已落地

- 保留旧接口：
  - /forward
  - /forward/stream
- 新接口并行，不

关键文件：

- server/application/faasrouter/main.go:14
- server/application/faasrouter/main.go:15
- server/applica7

---

3. 错误映射和观

- OpenAI / Anthropic 错误 envelope 统一映射
- 加入结构化请求日志（协议、格式、检测来源、耗时、stream 等）

关键文件：

- server/application/faasrouter/internal/errors/map.go:28
- server/applicarvability/logging.go:22

---

4. IDL 已补充统

- AGWService 新增 GatewayModel
- 新增 UnifiedMo
- Forward/ForwardStream 明确为兼容保留

关键文件：

- server/idl/agw/agw.thrift:17
- server/idl/agw

---

5. 文档已同步更新

- 设计文档新增“当前仓单路径双协议落地说明”
- 接口文档增加 UnifiedGateway 章节
- llm接入层 增加
- 架构迭代 增加当前仓落地说明

关键文档：

- docs/服务端\_模块/模型、api 网关/设计文档.md:5
- docs/服务端\_模TERFACE_DOC.md:619
- docs/服务端\_模块/llm接入层.md:40
- docs/框架/架构

---

✅ 测试结果

在 server/applic

- go test ./... 通过
  - internal/protocol 测试通过（含 header 优先、冲突、body
    兜底）

---

说明（重要）

你要求的“AGW + ModelGateway 双层”在当前仓里我按逻辑双层落地到 faasrouter（因为eway目录当前为空）。
也就是说：已经具备你要的核心能力和分层边界，后续可以平滑拆成独
立 modelgateway

---

如果你现在要，我

1. curl 示例（OpenAI/Anthropic 各一份）针对 /gateway/model
2. 流式终止事件的协议细化（[DONE] / message_stop 对齐）
3. fallback prov 。

✻ Brewed for 15m 39s

❯ 给出接口请求的文档

可以，下面给你一 （针对统一入口）。

---

Unified Gateway 接口请求文档

1. 统一入口

- Method: POST
- Path: /gateway/model
- Content-Type: application/json

▎ 兼容保留（迁移期）：
▎ - POST /forward
▎ - POST /forward/stream

---

2. 协议识别规则

按以下优先级识别请求协议：

1. x-protocol（openai / anthropic）
2. x-api-format（openai-chat-completions / openai-responses /
   anthropic-messag
3. body 结构兜底：

- 有 input → OpenAI Responses
- 有 messagesx-anthropic-version）→ Anthropic Messages
- 其他 messages → OpenAI Chat Completions

---

3. 通用请求字段

{
"target_url":
"model": "ark/seed-code-0611",
"stream": fals
}

- target_url：必填，上游实际地址
- model：建议填
- stream：可选，true 时走流式（SSE）

---

4. OpenAI Chat Completions 示例

curl -X POST 'http://<gateway-host>/gateway/model' \
 -H 'Content-Type: application/json' \
 -H 'Authorizat
-H 'x-protocol: openai' \
 -H 'x-api-form\
 -d '{
"target_url":"https://api.openai.com/v1/chat/completions",
"model": "ar
"messages": [
{"role": "user", "content": "Hello"}
],
"stream": false
}'

---

5. OpenAI Respon

curl -X POST 'htodel' \
 -H 'Content-Type: application/json' \
 -H 'Authorizat
-H 'x-api-format: openai-responses' \
 -d '{
"target_url"org/v1/responses",
"model": "ark/seed-code-0611",
"input": "Hello",
"stream": fa
}'

---

6. Anthropic Messages 示例

curl -X POST 'http://<gateway-host>/gateway/model' \
 -H 'Content-Type: application/json' \
 -H 'Authorizat
-H 'x-protocol: anthropic' \
 -H 'x-api-form
-d '{
"target_url"org/v1/messages",
"model": "claude-sonnet-4-6",
"anthropic_v
"max_tokens": 512,
"messages": [
{"role": "
],
"stream": false
}'

---

7. 流式请求说明

- 请求："stream": true（或 Accept: text/event-stream）
- 响应：SSE（Con

---

8. 常见错误码

- BAD_REQUEST：请求体不合法/字段缺失
- PROTOCOL_CONFLICT：x-protocol 与 x-api-format 冲突
- UNSUPPORTED_FO
- UPSTREAM_ERROR：上游调用失败
