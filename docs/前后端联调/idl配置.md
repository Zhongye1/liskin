```thrift

namespace go prd

struct TrafficEnv {
    1: bool Open = false,
    2: string Env = "",
}

struct Base {
    1: string LogID = "",
    2: string Caller = "",
    3: string Addr = "",
    4: string Client = "",
    5: optional TrafficEnv TrafficEnv,
    6: optional map<string, string> Extra,
}

struct BaseResp {
    1: string StatusMessage = "",
    2: i32 StatusCode = 0,
    3: optional map<string, string> Extra,
}

// 参数值类型，可以是多种类型之一
struct ParamValue {
    1: optional string StringValue,
    2: optional i64 IntValue,
    3: optional double DoubleValue,
    4: optional bool BoolValue,
    5: optional list<ParamValue> ListValue,
    6: optional map<string, ParamValue> MapValue,
}

// 模型消息结构
struct Message {
    1: required string Type,      // 消息类型：user, system, assistant
    2: required string Content,   // 消息内容
    3: optional map<string, string> Metadata, // 元数据
}

// 模型配置
struct ModelConfig {
    1: required string Type,      // 模型类型，如 "openai", "ark"
    2: required string Name,      // 模型名称
    3: required map<string, ParamValue> Parameters, // 参数，包括 api_key, model, base_url 等
}

// 文本生成请求
struct GenerateRequest {
    1: required list<Message> Messages,    // 消息列表
    2: optional ModelConfig ModelConfig,   // 模型配置
    3: optional string ModelConfigID,      // 模型配置ID，如果设置则优先使用指定的配置
    255: optional Base Base,
}

// 文本生成响应
struct GenerateResponse {
    1: optional Message Response,          // 模型回复
    2: optional map<string, i64> Usage,    // 使用统计
    255: optional BaseResp BaseResp,
}

// 流式文本生成响应块
struct GenerateStreamingResponse {
    1: optional string Content,            // 响应内容片段
    2: bool Done,                         // 是否完成
    255: optional BaseResp BaseResp,
}

service PrdService {
    // 文本生成接口
    GenerateResponse Generate (1: GenerateRequest request),
    // 流式文本生成接口
    GenerateStreamingResponse GenerateStreaming (1: GenerateRequest request) (streaming.mode="server"),
}

```
