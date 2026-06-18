package handlers

import (
	"bytes"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
)

func (h *ForwardHandler) ForwardStream(c *gin.Context) {
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

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Status(resp.StatusCode)

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming not supported"})
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
			if readErr == io.EOF {
				return
			}
			return
		}
	}
}
