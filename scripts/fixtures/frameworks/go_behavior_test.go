package aiyokeruntime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/go-chi/chi/v5"
	"github.com/gofiber/fiber/v3"
)

type frameworkAdapter struct{}

func (frameworkAdapter) Invoke(_ context.Context, request ModelRequest) ModelResult {
	if request.Route == "cancelled" {
		return ModelFailure{Kind: FailureCancelled, Message: "cancelled", Retryable: false}
	}
	if request.Metadata["authorization"] != "Bearer fixture" {
		return ModelFailure{Kind: FailureGuardRejected, Message: "missing authorization", Retryable: false}
	}
	return ModelSuccess{
		Value: map[string]any{"answer": float64(42)},
		Usage: Usage{InputTokens: 4, OutputTokens: 2, EstimatedCostUSD: 0.001},
	}
}

func frameworkRuntime(t *testing.T) *HarnessRuntime {
	t.Helper()
	registry := NewAdapterRegistry()
	if err := registry.Register("primary", frameworkAdapter{}); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register("cancelled", frameworkAdapter{}); err != nil {
		t.Fatal(err)
	}
	runtime, err := NewHarnessRuntime(testOptions(), RuntimeDependencies{Adapters: registry})
	if err != nil {
		t.Fatal(err)
	}
	return runtime
}

func frameworkRequest(route, authorization string) ModelRequest {
	return ModelRequest{
		ID: "request-1", Route: route, PromptVersion: "v1", Input: map[string]any{},
		InputTokens: 4, MaxOutputTokens: 16,
		Metadata: map[string]string{"authorization": authorization},
	}
}

func assertSuccessBody(t *testing.T, response *http.Response) {
	t.Helper()
	defer response.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	data, ok := body["data"].(map[string]any)
	if !ok || data["answer"] != float64(42) {
		t.Fatalf("unexpected response body: %#v", body)
	}
	usage, ok := body["usage"].(map[string]any)
	if !ok || usage["inputTokens"] != float64(4) || usage["outputTokens"] != float64(2) ||
		usage["estimatedCostUsd"] != 0.001 || len(usage) != 3 {
		t.Fatalf("wire usage is not canonical: %#v", body)
	}
}

func TestChiRequestLifecycle(t *testing.T) {
	router := chi.NewRouter()
	RegisterAiyokeChi(router, "/ai", frameworkRuntime(t), func(request *http.Request) (ModelRequest, error) {
		return frameworkRequest("primary", request.Header.Get("Authorization")), nil
	})
	request := httptest.NewRequest(http.MethodPost, "/ai", nil)
	request.Header.Set("Authorization", "Bearer fixture")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	assertSuccessBody(t, response.Result())

	invalid := chi.NewRouter()
	RegisterAiyokeChi(invalid, "/ai", frameworkRuntime(t), func(*http.Request) (ModelRequest, error) {
		return ModelRequest{}, errors.New("bad input")
	})
	invalidResponse := httptest.NewRecorder()
	invalid.ServeHTTP(invalidResponse, httptest.NewRequest(http.MethodPost, "/ai", nil))
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", invalidResponse.Code)
	}
}

func TestGinRequestLifecycleAndCancellationMapping(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterAiyokeGin(router, "/ai", frameworkRuntime(t), func(context *gin.Context) (ModelRequest, error) {
		route := "primary"
		if context.GetHeader("X-Cancel") == "1" {
			route = "cancelled"
		}
		return frameworkRequest(route, context.GetHeader("Authorization")), nil
	})
	request := httptest.NewRequest(http.MethodPost, "/ai", nil)
	request.Header.Set("Authorization", "Bearer fixture")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	assertSuccessBody(t, response.Result())

	cancelled := httptest.NewRequest(http.MethodPost, "/ai", nil)
	cancelled.Header.Set("Authorization", "Bearer fixture")
	cancelled.Header.Set("X-Cancel", "1")
	cancelledResponse := httptest.NewRecorder()
	router.ServeHTTP(cancelledResponse, cancelled)
	if cancelledResponse.Code != 499 {
		t.Fatalf("expected 499, got %d", cancelledResponse.Code)
	}
}

func TestFiberRequestLifecycle(t *testing.T) {
	app := fiber.New()
	RegisterAiyokeFiber(app, "/ai", frameworkRuntime(t), func(context fiber.Ctx) (ModelRequest, error) {
		return frameworkRequest("primary", context.Get("Authorization")), nil
	})
	request := httptest.NewRequest(http.MethodPost, "http://example.test/ai", nil)
	request.Header.Set("Authorization", "Bearer fixture")
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.StatusCode)
	}
	assertSuccessBody(t, response)
}
