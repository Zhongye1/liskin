---
脚本测试用例

TC-01 健康检查

- 目标：服务可用性验证
- 请求：GET /healthz
- 期望：
- HTTP 200
- body 包含："status":"ok"
---

TC-02 统一入口必填参数校验

- 目标：校验 target_url 必填
- 请求：POST /gateway/model，body 不含 target_url
- 期望：
  - HTTP 400
  - body 包含：target_url is required

---

TC-03 协议冲突校验（显式头优先）

- 目标：验证 x-protocol 与 x-api-format 冲突时拒绝
- 请求：
  - x-protocol: openai
  - x-api-format: anthropic-messages
- 期望：
  - HTTP 400
  - body 包含：PROTOCOL_CONFLICT

---

TC-04 上游真实联调（可选）

- 目标：验证统一网关到上游 LLM 的真实链路
- 前置：设置 TOKEN
- 请求：POST /gateway/model，OpenAI chat-completions payload
- 期望：
  - 成功时 HTTP 200
  - 失败时记录 WARN（不计入 fail），输出上游返回摘要

---

建议补充（你可以加到脚本里）

TC-05 OpenAI Responses 格式识别（body 兜底）

- body 包含 input，不传 x-api-format
- 期望被识别为 openai-responses，并成功转发/或返回合理错误

TC-06 Anthropic Messages 格式识别

- body 包含 messages + anthropic_version
- 期望识别为 anthropic-messages，冲突时返回 PROTOCOL_CONFLICT

TC-07 流式模式

- stream=true 或 Accept: text/event-stream
- 期望返回 text/event-stream，连接可持续接收 chunk

server/application/faasrouter/scripts/run_gateway_api_tests.sh

== API tests for faasrouter gateway ==
BASE_URL=http://127.0.0.1:8081
✅ PASS: GET /healthz returns service ok
✅ PASS: POST /gateway/model validates required target_url
✅ PASS: Protocol conflict is rejected with PROTOCOL_CONFLICT
⚠️ WARN: Live upstream request returned 400 (body truncated): {"error":{"message":"Request body is not valid JSON","type":"invalid_request_error"}}

Summary: pass=3 fail=0 warn=1
