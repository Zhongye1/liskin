Model Gateway 在你们项目里本质是一个 LLM 统一接入层 +  
 治理层，主要负责这几件事：

1. 统一 API 协议入口  
   对外提供标准化接口（OpenAI/Anthropic 兼容）：
   - /api/model/chat/completions
   - /api/model/responses
   - /api/model/v1/messages

见 server/application/modelgateway/router.go:12  
 2. 鉴权、权限、配额控制  
 每个请求先过：

- AKAuth
- ModelAccessCheck
- QuotaCheck  
  见 server/application/modelgateway/router.go:12

3.  模型请求路由与多 Provider 转发  
     把请求转发到具体 provider（openrouter/ark/modelhub 等），并支持动态按
    TCC 配置创建 provider。  
     见 server/application/modelgateway/biz/logic/app.go:26
4.  失败兜底与降级（fallback）  
    当 provider 异常或限流时按策略切换下一个 provider，保证可用性。  
    见 server/application/modelgateway/biz/logic/proxy.go:553
5.  协议兼容与流式处理  
     支持 responses/chat-completions 互转、流式 SSE 处理与聚合。  
     见 server/application/modelgateway/biz/logic/proxy.go:140、server/appl
    ication/modelgateway/biz/handler/responses.go:111
6.  用量统计、计费与观测埋点  
     记录 token usage、tool calls、请求链路指标和上报，支撑计费与运维观测。
    见 server/application/modelgateway/biz/handler/chat_completion.go:196

一句话总结：  
 Model Gateway 不是“单纯转发层”，而是你们 LLM  
 调用的统一治理中枢（接入标准化 + 安全/配额 + 路由容灾 + 观测计费）。

---

## 当前仓落地补充（统一路径）

由于当前仓可运行入口在 `server/application/faasrouter`，新增统一入口：

- `POST /gateway/model`

并保留兼容入口：

- `POST /forward`
- `POST /forward/stream`

协议识别采用“显式优先 + body 兜底”：

1. `x-protocol`
2. `x-api-format`
3. body shape（`input` / `messages` / `anthropic_version`）

这套方案用于在现仓先落地 AGW + ModelGateway 的逻辑分层，后续可再拆分为独立服务。
