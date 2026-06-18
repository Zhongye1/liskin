package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type Protocol string

type APIFormat string

const (
	ProtocolOpenAI    Protocol = "openai"
	ProtocolAnthropic Protocol = "anthropic"
)

const (
	FormatOpenAIChatCompletions APIFormat = "openai-chat-completions"
	FormatOpenAIResponses       APIFormat = "openai-responses"
	FormatAnthropicMessages     APIFormat = "anthropic-messages"
)

const (
	SourceHeaderProtocol  = "header_x_protocol"
	SourceHeaderAPIFormat = "header_x_api_format"
	SourceBodyShape       = "body_shape"
)

var (
	ErrProtocolConflict = errors.New("protocol and api-format conflict")
	ErrUndetermined     = errors.New("cannot determine protocol/format")
)

type DetectionResult struct {
	Protocol Protocol
	Format   APIFormat
	Source   string
}

func DetectProtocol(r *http.Request, body map[string]json.RawMessage) (DetectionResult, error) {
	xProtocol := strings.ToLower(strings.TrimSpace(r.Header.Get("x-protocol")))
	xAPIFormat := strings.ToLower(strings.TrimSpace(r.Header.Get("x-api-format")))

	if xProtocol != "" {
		proto, err := parseProtocol(xProtocol)
		if err != nil {
			return DetectionResult{}, err
		}
		if xAPIFormat != "" {
			format, err := parseFormat(xAPIFormat)
			if err != nil {
				return DetectionResult{}, err
			}
			if !isFormatCompatible(proto, format) {
				return DetectionResult{}, ErrProtocolConflict
			}
			return DetectionResult{Protocol: proto, Format: format, Source: SourceHeaderProtocol}, nil
		}
		return DetectionResult{Protocol: proto, Format: defaultFormatByProtocol(proto), Source: SourceHeaderProtocol}, nil
	}

	if xAPIFormat != "" {
		format, err := parseFormat(xAPIFormat)
		if err != nil {
			return DetectionResult{}, err
		}
		return DetectionResult{Protocol: protocolByFormat(format), Format: format, Source: SourceHeaderAPIFormat}, nil
	}

	if _, ok := body["input"]; ok {
		return DetectionResult{Protocol: ProtocolOpenAI, Format: FormatOpenAIResponses, Source: SourceBodyShape}, nil
	}

	if _, ok := body["messages"]; ok {
		if _, hasVersion := body["anthropic_version"]; hasVersion {
			return DetectionResult{Protocol: ProtocolAnthropic, Format: FormatAnthropicMessages, Source: SourceBodyShape}, nil
		}
		if strings.TrimSpace(r.Header.Get("x-anthropic-version")) != "" {
			return DetectionResult{Protocol: ProtocolAnthropic, Format: FormatAnthropicMessages, Source: SourceBodyShape}, nil
		}
		return DetectionResult{Protocol: ProtocolOpenAI, Format: FormatOpenAIChatCompletions, Source: SourceBodyShape}, nil
	}

	return DetectionResult{}, ErrUndetermined
}

func parseProtocol(v string) (Protocol, error) {
	switch strings.ToLower(v) {
	case string(ProtocolOpenAI):
		return ProtocolOpenAI, nil
	case string(ProtocolAnthropic):
		return ProtocolAnthropic, nil
	default:
		return "", fmt.Errorf("unsupported x-protocol: %s", v)
	}
}

func parseFormat(v string) (APIFormat, error) {
	switch strings.ToLower(v) {
	case string(FormatOpenAIChatCompletions):
		return FormatOpenAIChatCompletions, nil
	case string(FormatOpenAIResponses):
		return FormatOpenAIResponses, nil
	case string(FormatAnthropicMessages):
		return FormatAnthropicMessages, nil
	default:
		return "", fmt.Errorf("unsupported x-api-format: %s", v)
	}
}

func isFormatCompatible(p Protocol, f APIFormat) bool {
	switch p {
	case ProtocolOpenAI:
		return f == FormatOpenAIChatCompletions || f == FormatOpenAIResponses
	case ProtocolAnthropic:
		return f == FormatAnthropicMessages
	default:
		return false
	}
}

func protocolByFormat(f APIFormat) Protocol {
	switch f {
	case FormatAnthropicMessages:
		return ProtocolAnthropic
	default:
		return ProtocolOpenAI
	}
}

func defaultFormatByProtocol(p Protocol) APIFormat {
	if p == ProtocolAnthropic {
		return FormatAnthropicMessages
	}
	return FormatOpenAIChatCompletions
}
