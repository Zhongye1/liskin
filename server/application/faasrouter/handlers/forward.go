package handlers

import (
	"bytes"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
)

type ForwardHandler struct {
	client *http.Client
}

type ForwardRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

func NewForwardHandler() *ForwardHandler {
	return &ForwardHandler{client: &http.Client{}}
}

func (h *ForwardHandler) Healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "faasrouter"})
}

func (h *ForwardHandler) Forward(c *gin.Context) {
	var reqPayload ForwardRequest
	if err := c.ShouldBindJSON(&reqPayload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if reqPayload.Method == "" {
		reqPayload.Method = http.MethodGet
	}

	req, err := http.NewRequestWithContext(c.Request.Context(), reqPayload.Method, reqPayload.URL, bytes.NewBufferString(reqPayload.Body))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	for k, v := range reqPayload.Headers {
		req.Header.Set(k, v)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	for k, values := range resp.Header {
		for _, v := range values {
			c.Writer.Header().Add(k, v)
		}
	}

	c.Status(resp.StatusCode)
	_, _ = io.Copy(c.Writer, resp.Body)
}
