namespace go liskin.server.idl.message

struct Message {
  1: required string id
  2: required string role
  3: required string content
  4: optional i64 created_at
}
