package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type CanonicalRequest struct {
	Protocol        Protocol
	Format          APIFormat
	DetectionSource string
	Method          string
	URL             string
	Headers         map[string]string
	Body            string
	Stream          bool
	Model           string
}

type CanonicalResponse struct {
	Protocol Protocol
	Format   APIFormat
	Status   int
	Headers  map[string][]string
	Body     []byte
}

func BuildCanonicalRequest(r *http.Request, targetURL string) (*CanonicalRequest, error) {
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	return BuildCanonicalRequestFromBytes(r, targetURL, bodyBytes)
}

func BuildCanonicalRequestFromBytes(r *http.Request, targetURL string, bodyBytes []byte) (*CanonicalRequest, error) {
	r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))

	var bodyMap map[string]json.RawMessage
	if len(bytes.TrimSpace(bodyBytes)) > 0 {
		if err := json.Unmarshal(bodyBytes, &bodyMap); err != nil {
			return nil, fmt.Errorf("invalid json body: %w", err)
		}
	} else {
		bodyMap = map[string]json.RawMessage{}
	}

	detection, err := DetectProtocol(r, bodyMap)
	if err != nil {
		return nil, err
	}

	stream := false
	if v, ok := bodyMap["stream"]; ok {
		_ = json.Unmarshal(v, &stream)
	}
	if !stream {
		stream = r.Header.Get("Accept") == "text/event-stream"
	}

	var model string
	if v, ok := bodyMap["model"]; ok {
		_ = json.Unmarshal(v, &model)
	}

	headers := map[string]string{}
	for k, values := range r.Header {
		if len(values) == 0 {
			continue
		}
		lk := strings.ToLower(k)
		if lk == "content-length" || lk == "host" {
			continue
		}
		headers[k] = values[0]
	}
	if _, ok := headers["Content-Type"]; !ok {
		headers["Content-Type"] = "application/json"
	}

	return &CanonicalRequest{
		Protocol:        detection.Protocol,
		Format:          detection.Format,
		DetectionSource: detection.Source,
		Method:          http.MethodPost,
		URL:             targetURL,
		Headers:         headers,
		Body:            string(bodyBytes),
		Stream:          stream,
		Model:           model,
	}, nil
}
