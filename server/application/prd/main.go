package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "prd"})
	})

	r.GET("/api/prd/ping", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"message": "prd service initialized"})
	})

	_ = r.Run(":8080")
}
