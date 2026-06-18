namespace go liskin.server.idl.agw

include "../base.thrift"

struct ForwardRequest {
  1: required string method
  2: required string url
  3: optional map<string, string> headers
  4: optional string body
}

struct ForwardResponse {
  1: required base.BaseResp base
  2: required string data
}

struct UnifiedModelRequest {
  // 目标上游地址（由网关做协议识别 + 统一治理后转发）
  1: required string target_url
  // 请求体（OpenAI/Anthropic 原始 JSON）
  2: optional string body
  // 可选透传头（例如 Authorization、x-protocol、x-api-format）
  3: optional map<string, string> headers
}

service AGWService {
  // 新统一入口：单路径兼容 OpenAI + Anthropic
  ForwardResponse GatewayModel(1: UnifiedModelRequest req) (api.post="/gateway/model")

  // 兼容保留：计划逐步迁移至 /gateway/model
  ForwardResponse Forward(1: ForwardRequest req) (api.post="/forward")
  ForwardResponse ForwardStream(1: ForwardRequest req) (api.post="/forward/stream")
  ForwardResponse Health(1: ForwardRequest req) (api.get="/healthz")
}
