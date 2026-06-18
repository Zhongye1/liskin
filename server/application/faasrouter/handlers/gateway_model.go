package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	gatewayerrors "liskin/server/application/faasrouter/internal/errors"
	"liskin/server/application/faasrouter/internal/observability"
	"liskin/server/application/faasrouter/internal/protocol"
)

type UnifiedGatewayRequest struct {
	TargetURL string `json:"target_url"`
}

func (h *ForwardHandler) GatewayModel(c *gin.Context) {
	started := time.Now()
	requestID := c.GetHeader("X-Request-ID")
	if requestID == "" {
		requestID = c.GetHeader("X-Tt-Logid")
	}

	rawBody, err := io.ReadAll(c.Request.Body)
	if err != nil {
		h.respondError(c, requestID, protocol.ProtocolOpenAI, gatewayerrors.New("BAD_REQUEST", "failed to read request body", http.StatusBadRequest), started, "", "", "", false)
		return
	}

	var req UnifiedGatewayRequest
	if err := json.Unmarshal(rawBody, &req); err != nil {
		h.respondError(c, requestID, protocol.ProtocolOpenAI, gatewayerrors.New("BAD_REQUEST", err.Error(), http.StatusBadRequest), started, "", "", "", false)
		return
	}

	if req.TargetURL == "" {
		h.respondError(c, requestID, protocol.ProtocolOpenAI, gatewayerrors.New("BAD_REQUEST", "target_url is required", http.StatusBadRequest), started, "", "", "", false)
		return
	}

	canonicalReq, err := protocol.BuildCanonicalRequestFromBytes(c.Request, req.TargetURL, rawBody)
	if err != nil {
		proto := protocol.ProtocolOpenAI
		if errors.Is(err, protocol.ErrProtocolConflict) {
			h.respondError(c, requestID, proto, gatewayerrors.New("PROTOCOL_CONFLICT", err.Error(), http.StatusBadRequest), started, req.TargetURL, "", "", false)
			return
		}
		if errors.Is(err, protocol.ErrUndetermined) {
			h.respondError(c, requestID, proto, gatewayerrors.New("UNSUPPORTED_FORMAT", err.Error(), http.StatusBadRequest), started, req.TargetURL, "", "", false)
			return
		}
		h.respondError(c, requestID, proto, gatewayerrors.New("BAD_REQUEST", err.Error(), http.StatusBadRequest), started, req.TargetURL, "", "", false)
		return
	}

	payload := map[string]any{}
	if err := json.Unmarshal([]byte(canonicalReq.Body), &payload); err != nil {
		h.respondError(c, requestID, canonicalReq.Protocol, gatewayerrors.New("BAD_REQUEST", "invalid request payload", http.StatusBadRequest), started, canonicalReq.URL, canonicalReq.Protocol, canonicalReq.Format, canonicalReq.Stream)
		return
	}
	delete(payload, "target_url")
	forwardBody, err := json.Marshal(payload)
	if err != nil {
		h.respondError(c, requestID, canonicalReq.Protocol, gatewayerrors.New("BAD_REQUEST", "failed to build upstream payload", http.StatusBadRequest), started, canonicalReq.URL, canonicalReq.Protocol, canonicalReq.Format, canonicalReq.Stream)
		return
	}

	upReq, err := http.NewRequestWithContext(c.Request.Context(), canonicalReq.Method, canonicalReq.URL, bytes.NewReader(forwardBody))
	if err != nil {
		h.respondError(c, requestID, canonicalReq.Protocol, gatewayerrors.New("BAD_REQUEST", err.Error(), http.StatusBadRequest), started, canonicalReq.URL, canonicalReq.Protocol, canonicalReq.Format, canonicalReq.Stream)
		return
	}

	for k, v := range canonicalReq.Headers {
		upReq.Header.Set(k, v)
	}
	upReq.Header.Del("Content-Length")

	resp, err := h.client.Do(upReq)
	if err != nil {
		h.respondError(c, requestID, canonicalReq.Protocol, gatewayerrors.New("UPSTREAM_ERROR", err.Error(), http.StatusBadGateway), started, canonicalReq.URL, canonicalReq.Protocol, canonicalReq.Format, canonicalReq.Stream)
		return
	}
	defer resp.Body.Close()

	if canonicalReq.Stream {
		h.proxyStream(c, resp)
		observability.LogRequest(observability.RequestLog{
			RequestID:       requestID,
			Protocol:        canonicalReq.Protocol,
			Format:          canonicalReq.Format,
			DetectionSource: canonicalReq.DetectionSource,
			TargetURL:       canonicalReq.URL,
			Status:          resp.StatusCode,
			Stream:          true,
			FallbackCount:   0,
			Latency:         time.Since(started),
		})
		return
	}

	for k, values := range resp.Header {
		for _, v := range values {
			c.Writer.Header().Add(k, v)
		}
	}
	c.Status(resp.StatusCode)
	_, _ = io.Copy(c.Writer, resp.Body)

	observability.LogRequest(observability.RequestLog{
		RequestID:       requestID,
		Protocol:        canonicalReq.Protocol,
		Format:          canonicalReq.Format,
		DetectionSource: canonicalReq.DetectionSource,
		TargetURL:       canonicalReq.URL,
		Status:          resp.StatusCode,
		Stream:          false,
		FallbackCount:   0,
		Latency:         time.Since(started),
	})
}

func (h *ForwardHandler) proxyStream(c *gin.Context, resp *http.Response) {
	for k, values := range resp.Header {
		for _, v := range values {
			c.Writer.Header().Add(k, v)
		}
	}
	if c.Writer.Header().Get("Content-Type") == "" {
		c.Writer.Header().Set("Content-Type", "text/event-stream")
	}
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Status(resp.StatusCode)

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		return
	}

	buffer := make([]byte, 2048)
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			_, _ = c.Writer.Write(buffer[:n])
			flusher.Flush()
		}
		if readErr != nil {
			return
		}
	}
}

func (h *ForwardHandler) respondError(c *gin.Context, requestID string, proto protocol.Protocol, err error, started time.Time, targetURL string, p protocol.Protocol, f protocol.APIFormat, stream bool) {
	status, body := gatewayerrors.ToBytes(err, proto)
	c.Header("Content-Type", "application/json")
	if requestID != "" {
		c.Header("X-Request-ID", requestID)
	}
	c.Data(status, "application/json", body)

	observability.LogRequest(observability.RequestLog{
		RequestID:       requestID,
		Protocol:        p,
		Format:          f,
		DetectionSource: "",
		TargetURL:       targetURL,
		Status:          status,
		Stream:          stream,
		FallbackCount:   0,
		Latency:         time.Since(started),
	})
}
