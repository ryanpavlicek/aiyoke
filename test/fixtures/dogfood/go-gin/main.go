package main

import "github.com/gin-gonic/gin"

func main() {
	router := gin.New()
	router.GET("/health", func(context *gin.Context) {
		context.JSON(200, gin.H{"status": "ok"})
	})
}
