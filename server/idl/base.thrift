namespace go liskin.server.idl.base

struct BaseResp {
  1: required i32 code
  2: required string message
  3: optional string request_id
}
