import type { FrameworkIntegrationDefinition } from "../shared.js";

const chi = `package aiyokeruntime

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type ChiRequestFactory func(*http.Request) (ModelRequest, error)

func chiFailureStatus(kind FailureKind) int {
	switch kind {
	case FailureGuardRejected:
		return http.StatusBadRequest
	case FailureApprovalRequired:
		return http.StatusForbidden
	case FailureBudgetExhausted, FailureRateLimit:
		return http.StatusTooManyRequests
	case FailureTimeout:
		return http.StatusGatewayTimeout
	default:
		return http.StatusBadGateway
	}
}

func RegisterAiyokeChi(
	router chi.Router, path string, runtime *HarnessRuntime, factory ChiRequestFactory,
) {
	router.Post(path, func(response http.ResponseWriter, request *http.Request) {
		modelRequest, err := factory(request)
		if err != nil {
			http.Error(response, "invalid model request", http.StatusBadRequest)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch result := runtime.Execute(request.Context(), modelRequest, ExecuteOptions{}).(type) {
		case ModelSuccess:
			_ = json.NewEncoder(response).Encode(map[string]any{"data": result.Value, "usage": result.Usage})
		case ModelFailure:
			response.WriteHeader(chiFailureStatus(result.Kind))
			_ = json.NewEncoder(response).Encode(map[string]any{
				"error": map[string]any{"kind": result.Kind, "message": result.Message},
			})
		}
	})
}
`;

const gin = `package aiyokeruntime

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type GinRequestFactory func(*gin.Context) (ModelRequest, error)

func ginFailureStatus(kind FailureKind) int {
	switch kind {
	case FailureGuardRejected:
		return http.StatusBadRequest
	case FailureApprovalRequired:
		return http.StatusForbidden
	case FailureBudgetExhausted, FailureRateLimit:
		return http.StatusTooManyRequests
	case FailureTimeout:
		return http.StatusGatewayTimeout
	default:
		return http.StatusBadGateway
	}
}

func RegisterAiyokeGin(
	router gin.IRoutes, path string, runtime *HarnessRuntime, factory GinRequestFactory,
) {
	router.POST(path, func(context *gin.Context) {
		request, err := factory(context)
		if err != nil {
			context.JSON(http.StatusBadRequest, gin.H{"error": "invalid model request"})
			return
		}
		switch result := runtime.Execute(context.Request.Context(), request, ExecuteOptions{}).(type) {
		case ModelSuccess:
			context.JSON(http.StatusOK, gin.H{"data": result.Value, "usage": result.Usage})
		case ModelFailure:
			context.JSON(ginFailureStatus(result.Kind), gin.H{
				"error": gin.H{"kind": result.Kind, "message": result.Message},
			})
		}
	})
}
`;

const fiber = `package aiyokeruntime

import "github.com/gofiber/fiber/v3"

type FiberRequestFactory func(fiber.Ctx) (ModelRequest, error)

func fiberFailureStatus(kind FailureKind) int {
	switch kind {
	case FailureGuardRejected:
		return fiber.StatusBadRequest
	case FailureApprovalRequired:
		return fiber.StatusForbidden
	case FailureBudgetExhausted, FailureRateLimit:
		return fiber.StatusTooManyRequests
	case FailureTimeout:
		return fiber.StatusGatewayTimeout
	default:
		return fiber.StatusBadGateway
	}
}

func RegisterAiyokeFiber(
	app *fiber.App, path string, runtime *HarnessRuntime, factory FiberRequestFactory,
) {
	app.Post(path, func(context fiber.Ctx) error {
		request, err := factory(context)
		if err != nil {
			return context.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid model request"})
		}
		switch result := runtime.Execute(context.Context(), request, ExecuteOptions{}).(type) {
		case ModelSuccess:
			return context.JSON(fiber.Map{"data": result.Value, "usage": result.Usage})
		case ModelFailure:
			return context.Status(fiberFailureStatus(result.Kind)).JSON(fiber.Map{
				"error": fiber.Map{"kind": result.Kind, "message": result.Message},
			})
		default:
			return context.SendStatus(fiber.StatusBadGateway)
		}
	})
}
`;

export const goIntegrations: readonly FrameworkIntegrationDefinition[] = [
  { framework: "chi", path: "chi_aiyoke.go", source: chi },
  { framework: "gin", path: "gin_aiyoke.go", source: gin },
  { framework: "fiber", path: "fiber_aiyoke.go", source: fiber }
];
