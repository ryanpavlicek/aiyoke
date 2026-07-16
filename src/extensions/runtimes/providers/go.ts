import type { ProviderIntegrationDefinition } from "../shared.js";

const responses = `package aiyokeruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxProviderResponseBytes int64 = 4 << 20

type SecretResolver func(string) (string, bool)

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type ResponsesProvider string

const (
	ResponsesOpenRouter ResponsesProvider = "openrouter"
	ResponsesXAI        ResponsesProvider = "xai"
)

type ResponsesAdapterConfig struct {
	Endpoint                   string
	Model                      string
	APIKeyEnvironment          string
	Headers                    map[string]string
	Timeout                    time.Duration
	InputCostPerMillionTokens  float64
	OutputCostPerMillionTokens float64
	CostTickDivisor            float64
}

func ResponsesConfig(provider ResponsesProvider, model string) ResponsesAdapterConfig {
	config := ResponsesAdapterConfig{Model: model, Timeout: 30 * time.Second}
	switch provider {
	case ResponsesOpenRouter:
		config.Endpoint = "https://openrouter.ai/api/v1/responses"
		config.APIKeyEnvironment = "OPENROUTER_API_KEY"
	case ResponsesXAI:
		config.Endpoint = "https://api.x.ai/v1/responses"
		config.APIKeyEnvironment = "XAI_API_KEY"
		config.CostTickDivisor = 10_000_000_000
	}
	return config
}

type ResponsesOutput struct {
	ID     string
	Status string
	Text   string
	Output []any
}

type ResponsesAPIAdapter struct {
	config        ResponsesAdapterConfig
	resolveSecret SecretResolver
	http          HTTPDoer
}

func NewResponsesAPIAdapter(
	config ResponsesAdapterConfig,
	resolveSecret SecretResolver,
	httpClient HTTPDoer,
) (*ResponsesAPIAdapter, error) {
	endpoint, err := url.Parse(config.Endpoint)
	if err != nil || endpoint.Hostname() == "" {
		return nil, errors.New("endpoint must be an absolute URL")
	}
	local := endpoint.Hostname() == "localhost" || endpoint.Hostname() == "127.0.0.1"
	if endpoint.User != nil {
		return nil, errors.New("endpoint must not contain credentials")
	}
	if endpoint.Scheme != "https" && !(local && endpoint.Scheme == "http") {
		return nil, errors.New("endpoint must use HTTPS except for local tests")
	}
	if strings.TrimSpace(config.Model) == "" {
		return nil, errors.New("model must not be empty")
	}
	if strings.TrimSpace(config.APIKeyEnvironment) == "" {
		return nil, errors.New("APIKeyEnvironment must not be empty")
	}
	if config.Timeout <= 0 {
		return nil, errors.New("timeout must be positive")
	}
	if resolveSecret == nil {
		return nil, errors.New("secret resolver is required")
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &ResponsesAPIAdapter{config: config, resolveSecret: resolveSecret, http: httpClient}, nil
}

func providerFailure(message string, retryable bool, providerCode string, secret string) ModelFailure {
	if secret != "" {
		message = strings.ReplaceAll(message, secret, "[REDACTED]")
		providerCode = strings.ReplaceAll(providerCode, secret, "[REDACTED]")
	}
	return ModelFailure{
		Kind: FailureProvider, Message: message, Retryable: retryable, ProviderCode: providerCode,
	}
}

func (adapter *ResponsesAPIAdapter) Invoke(ctx context.Context, request ModelRequest) ModelResult {
	input, ok := request.Input.(map[string]any)
	if !ok {
		return providerFailure("Responses API input must be an object.", false, "invalid_input", "")
	}
	providerInput, present := input["input"]
	if !present {
		return providerFailure("Responses API input.input is required.", false, "invalid_input", "")
	}
	switch providerInput.(type) {
	case string, []any, []map[string]any:
	default:
		return providerFailure(
			"Responses API input.input must be text or an item array.", false, "invalid_input", "",
		)
	}
	apiKey, found := adapter.resolveSecret(adapter.config.APIKeyEnvironment)
	if !found || apiKey == "" {
		return providerFailure(
			"The configured API key environment variable is unavailable.",
			false,
			"missing_credentials",
			"",
		)
	}
	payload := map[string]any{
		"model":             adapter.config.Model,
		"input":             providerInput,
		"max_output_tokens": request.MaxOutputTokens,
		"store":             false,
		"stream":            false,
	}
	for _, optional := range []string{"tools", "text", "reasoning"} {
		if value, exists := input[optional]; exists {
			payload[optional] = value
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return providerFailure("Responses API input is not JSON serializable.", false, "invalid_input", "")
	}
	deadlineContext, cancel := context.WithTimeout(ctx, adapter.config.Timeout)
	defer cancel()
	httpRequest, err := http.NewRequestWithContext(
		deadlineContext, http.MethodPost, adapter.config.Endpoint, bytes.NewReader(body),
	)
	if err != nil {
		return providerFailure(err.Error(), false, "invalid_request", apiKey)
	}
	for key, value := range adapter.config.Headers {
		httpRequest.Header.Set(key, value)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Authorization", "Bearer "+apiKey)
	response, err := adapter.http.Do(httpRequest)
	if err != nil {
		if errors.Is(deadlineContext.Err(), context.DeadlineExceeded) {
			return ModelFailure{
				Kind: FailureTimeout, Message: "The provider request deadline expired.", Retryable: true,
			}
		if ctx.Err() != nil {
			return ModelFailure{Kind: FailureCancelled, Message: "The provider request was cancelled."}
		}
		return providerFailure(err.Error(), true, "network_error", apiKey)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxProviderResponseBytes+1))
	if err != nil {
		return providerFailure(err.Error(), true, "response_read_error", apiKey)
	}
	if int64(len(responseBody)) > maxProviderResponseBytes {
		return providerFailure("The provider response exceeded the size limit.", false, "response_too_large", "")
	}
	var parsed map[string]any
	if err := json.Unmarshal(responseBody, &parsed); err != nil {
		return providerFailure("The provider returned invalid JSON.", false, "invalid_response", "")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || parsed["error"] != nil {
		message := "The provider rejected the request."
		code := fmt.Sprint(response.StatusCode)
		if providerError, ok := parsed["error"].(map[string]any); ok {
			if value, ok := providerError["message"].(string); ok {
				message = value
			}
			if value, ok := providerError["code"].(string); ok {
				code = value
			}
		}
		retryable := response.StatusCode == 408 || response.StatusCode == 429 || response.StatusCode >= 500
		return providerFailure(message, retryable, code, apiKey)
	}
	usageRecord, _ := parsed["usage"].(map[string]any)
	inputTokens := jsonNumberAsInt(usageRecord["input_tokens"])
	outputTokens := jsonNumberAsInt(usageRecord["output_tokens"])
	estimatedCostUSD := 0.0
	if ticks, ok := usageRecord["cost_in_usd_ticks"].(float64); ok && adapter.config.CostTickDivisor > 0 {
		estimatedCostUSD = ticks / adapter.config.CostTickDivisor
	} else {
		estimatedCostUSD = (float64(inputTokens)*adapter.config.InputCostPerMillionTokens +
			float64(outputTokens)*adapter.config.OutputCostPerMillionTokens) / 1_000_000
	}
	output, _ := parsed["output"].([]any)
	status, _ := parsed["status"].(string)
	if status == "" {
		status = "completed"
	}
	id, _ := parsed["id"].(string)
	return ModelSuccess{
		Value: ResponsesOutput{ID: id, Status: status, Text: responsesText(parsed), Output: output},
		Usage: Usage{InputTokens: inputTokens, OutputTokens: outputTokens, EstimatedCostUSD: estimatedCostUSD},
	}
}

func jsonNumberAsInt(value any) int {
	if number, ok := value.(float64); ok {
		return int(number)
	}
	return 0
}

func responsesText(payload map[string]any) string {
	if text, ok := payload["output_text"].(string); ok {
		return text
	}
	var builder strings.Builder
	output, _ := payload["output"].([]any)
	for _, item := range output {
		itemRecord, _ := item.(map[string]any)
		content, _ := itemRecord["content"].([]any)
		for _, part := range content {
			partRecord, _ := part.(map[string]any)
			if partRecord["type"] == "output_text" {
				if text, ok := partRecord["text"].(string); ok {
					builder.WriteString(text)
				}
			}
		}
	}
	return builder.String()
}

func RegisterResponsesAdapter(
	registry *AdapterRegistry,
	route string,
	config ResponsesAdapterConfig,
	resolveSecret SecretResolver,
	httpClient HTTPDoer,
) (*ResponsesAPIAdapter, error) {
	adapter, err := NewResponsesAPIAdapter(config, resolveSecret, httpClient)
	if err != nil {
		return nil, err
	}
	if err := registry.Register(route, adapter); err != nil {
		return nil, err
	}
	return adapter, nil
}
`;

const tests = `package aiyokeruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func providerRequest() ModelRequest {
	return ModelRequest{
		ID: "provider-1", Route: "primary", PromptVersion: "v1",
		Input: map[string]any{"input": "hello"}, InputTokens: 1, MaxOutputTokens: 20,
	}
}

func TestResponsesProviderMapsOutputUsageAndRegistration(t *testing.T) {
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"id": "response-1", "status": "completed", "output_text": "world", "output": []any{},
			"usage": map[string]any{"input_tokens": 2, "output_tokens": 3},
		})
	}))
	defer server.Close()
	config := ResponsesConfig(ResponsesOpenRouter, "test/model")
	config.Endpoint = server.URL
	config.InputCostPerMillionTokens = 1
	config.OutputCostPerMillionTokens = 2
	registry := NewAdapterRegistry()
	adapter, err := RegisterResponsesAdapter(
		registry, "primary", config, func(string) (string, bool) { return "test-secret", true }, server.Client(),
	)
	if err != nil {
		t.Fatal(err)
	}
	registered, found := registry.Get("primary")
	if !found || registered != adapter {
		t.Fatal("adapter was not registered")
	}
	result := adapter.Invoke(context.Background(), providerRequest())
	success, ok := result.(ModelSuccess)
	if !ok {
		t.Fatalf("expected success, got %#v", result)
	}
	output := success.Value.(ResponsesOutput)
	if output.Text != "world" || success.Usage.EstimatedCostUSD != 0.000008 {
		t.Fatalf("unexpected response: %#v %#v", output, success.Usage)
	}
	if authorization != "Bearer test-secret" {
		t.Fatalf("unexpected authorization: %q", authorization)
	}
}

func TestResponsesProviderRedactsRateLimitError(t *testing.T) {
	secret := "credential-that-must-not-leak"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusTooManyRequests)
		_, _ = writer.Write([]byte("{\\"error\\":{\\"message\\":\\"" + secret + "\\",\\"code\\":\\"" + secret + "\\"}}"))
	}))
	defer server.Close()
	config := ResponsesConfig(ResponsesXAI, "grok-test")
	config.Endpoint = server.URL
	adapter, err := NewResponsesAPIAdapter(
		config, func(string) (string, bool) { return secret, true }, server.Client(),
	)
	if err != nil {
		t.Fatal(err)
	}
	failure := adapter.Invoke(context.Background(), providerRequest()).(ModelFailure)
	if !failure.Retryable || strings.Contains(failure.Message+failure.ProviderCode, secret) {
		t.Fatalf("unsafe failure: %#v", failure)
	}
}

func TestResponsesProviderFailsClosed(t *testing.T) {
	config := ResponsesConfig(ResponsesOpenRouter, "test/model")
	adapter, err := NewResponsesAPIAdapter(
		config, func(string) (string, bool) { return "", false }, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	failure := adapter.Invoke(context.Background(), providerRequest()).(ModelFailure)
	if failure.ProviderCode != "missing_credentials" {
		t.Fatalf("unexpected failure: %#v", failure)
	}
	config.Endpoint = "http://example.com"
	if _, err := NewResponsesAPIAdapter(config, func(string) (string, bool) { return "secret", true }, nil); err == nil {
		t.Fatal("expected an unsafe endpoint error")
	}
}
`;

export const goProviders: readonly ProviderIntegrationDefinition[] = [
  {
    targets: ["openrouter", "xai-api"],
    artifacts: [
      { path: "responses_provider.go", source: responses },
      { path: "responses_provider_test.go", source: tests }
    ]
  }
];
