package tests

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"liskin/server/application/faasrouter/handlers"
)

func setupRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := handlers.NewForwardHandler()
	r.GET("/healthz", h.Healthz)
	r.POST("/gateway/model", h.GatewayModel)
	return r
}

func TestTC01Healthz(t *testing.T) {
	r := setupRouter()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("expected body contains status ok, got: %s", w.Body.String())
	}
}

func TestTC02TargetURLRequired(t *testing.T) {
	r := setupRouter()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/gateway/model", strings.NewReader(`{"model":"x"}`))
	req.Header.Set("Content-Type", "application/json")

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "target_url is required") {
		t.Fatalf("expected target_url validation message, got: %s", w.Body.String())
	}
}

func TestTC03ProtocolConflict(t *testing.T) {
	r := setupRouter()
	w := httptest.NewRecorder()
	body := `{"target_url":"https://example.com","messages":[]}`
	req := httptest.NewRequest(http.MethodPost, "/gateway/model", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-protocol", "openai")
	req.Header.Set("x-api-format", "anthropic-messages")

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "PROTOCOL_CONFLICT") {
		t.Fatalf("expected protocol conflict error code, got: %s", w.Body.String())
	}
}

func TestTC04LiveUpstreamOptional(t *testing.T) {
	token := "plat_uo6M4mMBniZUjk34e8ZgHIu_1eM6qznsySZ9pBe7L0Q"

	r := setupRouter()
	w := httptest.NewRecorder()
	body := `{
		"target_url": "https://api.openai.com/v1/chat/completions",
		"model": "ark/seed-code-0611",
		"messages": [{"role":"user","content":"Hello"}],
		"stream": false
	}`
	req := httptest.NewRequest(http.MethodPost, "/gateway/model", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("x-protocol", "openai")
	req.Header.Set("x-api-format", "openai-chat-completions")

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200 for live request, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestTC05OpenAIResponsesBodyFallback(t *testing.T) {
	var received map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &received)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	r := setupRouter()
	w := httptest.NewRecorder()
	body := `{
		"target_url": "` + upstream.URL + `",
		"model": "ark/seed-code-0608",
		"input": "Summarize Hamlet"
	}`
	req := httptest.NewRequest(http.MethodPost, "/gateway/model", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d body=%s", w.Code, w.Body.String())
	}
	if _, ok := received["input"]; !ok {
		t.Fatalf("expected upstream receives input field, got: %#v", received)
	}
	if _, ok := received["target_url"]; ok {
		t.Fatalf("expected target_url stripped before forwarding, got: %#v", received)
	}
}

func TestTC06AnthropicMessagesBodyFallback(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","content":[{"type":"text","text":"ok"}]}`))
	}))
	defer upstream.Close()

	r := setupRouter()
	w := httptest.NewRecorder()
	body := `{
		"target_url": "` + upstream.URL + `",
		"model": "claude-sonnet-4-6",
		"anthropic_version": "2023-06-01",
		"messages": [{"role":"user","content":"hello"}]
	}`
	req := httptest.NewRequest(http.MethodPost, "/gateway/model", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestTC07StreamMode(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: hello\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer upstream.Close()

	r := setupRouter()
	w := httptest.NewRecorder()
	body := `{
		"target_url": "` + upstream.URL + `",
		"model": "ark/seed-code-0608",
		"messages": [{"role":"user","content":"hello"}],
		"stream": true
	}`
	req := httptest.NewRequest(http.MethodPost, "/gateway/model", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-protocol", "openai")
	req.Header.Set("x-api-format", "openai-chat-completions")

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("expected SSE content-type, got %s", ct)
	}
	if !strings.Contains(w.Body.String(), "data: hello") {
		t.Fatalf("expected streamed chunk in body, got: %s", w.Body.String())
	}
}
