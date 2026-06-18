package errors

import (
	"encoding/json"
	"fmt"
	"net/http"

	"liskin/server/application/faasrouter/internal/protocol"
)

type GatewayError struct {
	Code    string
	Message string
	Status  int
}

func (e *GatewayError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func New(code, message string, status int) *GatewayError {
	return &GatewayError{Code: code, Message: message, Status: status}
}

func ToBody(err error, proto protocol.Protocol) (int, map[string]any) {
	ge, ok := err.(*GatewayError)
	if !ok {
		ge = &GatewayError{Code: "INTERNAL_ERROR", Message: err.Error(), Status: http.StatusInternalServerError}
	}

	if proto == protocol.ProtocolAnthropic {
		return ge.Status, map[string]any{
			"type": "error",
			"error": map[string]any{
				"type":    normalizeAnthropicErrorType(ge.Code),
				"message": ge.Message,
			},
		}
	}

	return ge.Status, map[string]any{
		"error": map[string]any{
			"message": ge.Message,
			"type":    ge.Code,
			"code":    ge.Code,
		},
	}
}

func ToBytes(err error, proto protocol.Protocol) (int, []byte) {
	status, body := ToBody(err, proto)
	b, marshalErr := json.Marshal(body)
	if marshalErr != nil {
		fallback := []byte(fmt.Sprintf(`{"error":{"message":"%s","code":"INTERNAL_ERROR"}}`, marshalErr.Error()))
		return http.StatusInternalServerError, fallback
	}
	return status, b
}

func normalizeAnthropicErrorType(code string) string {
	switch code {
	case "BAD_REQUEST", "PROTOCOL_CONFLICT", "UNSUPPORTED_FORMAT":
		return "invalid_request_error"
	case "UNAUTHORIZED":
		return "authentication_error"
	case "FORBIDDEN":
		return "permission_error"
	case "RATE_LIMITED":
		return "rate_limit_error"
	case "UPSTREAM_TIMEOUT":
		return "api_error"
	case "UPSTREAM_ERROR", "INTERNAL_ERROR":
		return "api_error"
	default:
		return "api_error"
	}
}
