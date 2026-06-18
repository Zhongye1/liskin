package observability

import (
	"log"
	"time"

	"liskin/server/application/faasrouter/internal/protocol"
)

type RequestLog struct {
	RequestID       string
	Protocol        protocol.Protocol
	Format          protocol.APIFormat
	DetectionSource string
	TargetURL       string
	Status          int
	Stream          bool
	FallbackCount   int
	Latency         time.Duration
}

func LogRequest(v RequestLog) {
	log.Printf(
		"request_id=%s protocol=%s format=%s detection_source=%s target_url=%s status=%d stream=%t fallback_count=%d latency_ms=%d",
		v.RequestID,
		v.Protocol,
		v.Format,
		v.DetectionSource,
		v.TargetURL,
		v.Status,
		v.Stream,
		v.FallbackCount,
		v.Latency.Milliseconds(),
	)
}
