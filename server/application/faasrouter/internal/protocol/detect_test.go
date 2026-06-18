package protocol

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestDetectProtocol_HeaderPriority(t *testing.T) {
	req := httptest.NewRequest("POST", "/gateway/model", nil)
	req.Header.Set("x-protocol", "anthropic")

	body := map[string]json.RawMessage{
		"messages": json.RawMessage(`[]`),
	}

	result, err := DetectProtocol(req, body)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if result.Protocol != ProtocolAnthropic {
		t.Fatalf("expected anthropic protocol, got %s", result.Protocol)
	}
	if result.Format != FormatAnthropicMessages {
		t.Fatalf("expected anthropic messages format, got %s", result.Format)
	}
	if result.Source != SourceHeaderProtocol {
		t.Fatalf("expected header source, got %s", result.Source)
	}
}

func TestDetectProtocol_Conflict(t *testing.T) {
	req := httptest.NewRequest("POST", "/gateway/model", nil)
	req.Header.Set("x-protocol", "openai")
	req.Header.Set("x-api-format", "anthropic-messages")

	_, err := DetectProtocol(req, map[string]json.RawMessage{})
	if err == nil {
		t.Fatal("expected conflict error")
	}
	if err != ErrProtocolConflict {
		t.Fatalf("expected ErrProtocolConflict, got %v", err)
	}
}

func TestDetectProtocol_BodyFallback(t *testing.T) {
	req := httptest.NewRequest("POST", "/gateway/model", nil)

	result, err := DetectProtocol(req, map[string]json.RawMessage{
		"input": json.RawMessage(`"hello"`),
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if result.Protocol != ProtocolOpenAI || result.Format != FormatOpenAIResponses {
		t.Fatalf("unexpected detection result: %#v", result)
	}
}
