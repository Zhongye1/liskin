package main

import (
	"github.com/gin-gonic/gin"

	"liskin/server/application/faasrouter/handlers"
)

func main() {
	r := gin.Default()
	h := handlers.NewForwardHandler()

	r.POST("/gateway/model", h.GatewayModel)
	r.POST("/forward", h.Forward)
	r.POST("/forward/stream", h.ForwardStream)
	r.GET("/healthz", h.Healthz)

	_ = r.Run(":8081")
}
