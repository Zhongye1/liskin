namespace go liskin.server.idl.prd

include "../base.thrift"

struct PrdPingRequest {
  1: optional string caller
}

struct PrdPingResponse {
  1: required base.BaseResp base
  2: required string data
}

service PrdService {
  PrdPingResponse Ping(1: PrdPingRequest req)
}
