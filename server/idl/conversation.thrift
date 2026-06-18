namespace go liskin.server.idl.conversation

include "message.thrift"

struct Conversation {
  1: required string id
  2: required list<message.Message> messages
}
