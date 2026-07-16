import { createRuntimeTemplate, runtimeLoader } from "./shared.js";

const SOURCE = `package aiyokeruntime

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"
)

type FailureKind string

const (
	FailureTimeout          FailureKind = "timeout"
	FailureRateLimit        FailureKind = "rate-limit"
	FailureProvider         FailureKind = "provider"
	FailureInvalidOutput    FailureKind = "invalid-output"
	FailureGuardRejected    FailureKind = "guard-rejected"
	FailureApprovalRequired FailureKind = "approval-required"
	FailureBudgetExhausted  FailureKind = "budget-exhausted"
	FailureCircuitOpen      FailureKind = "circuit-open"
	FailureCancelled        FailureKind = "cancelled"
)

type ModelRequest struct {
	ID              string
	Route           string
	PromptVersion   string
	Input           any
	MaxOutputTokens int
	Metadata        map[string]string
}

type Usage struct {
	InputTokens      int
	OutputTokens     int
	EstimatedCostUSD float64
}

type ModelFailure struct {
	Kind         FailureKind
	Message      string
	Retryable    bool
	ProviderCode string
}

type ModelResult struct {
	Value   any
	Usage   Usage
	Failure *ModelFailure
}

type ModelAdapter interface {
	Invoke(context.Context, ModelRequest) ModelResult
}

type EventSink interface {
	Emit(context.Context, map[string]any) error
}

type Guard interface {
	Check(context.Context, ModelRequest) (allowed bool, reason string)
}

type CachePort interface {
	Get(context.Context, string) (any, bool, error)
	Set(context.Context, string, any) error
}

type ApprovalPort interface {
	Approve(context.Context, ModelRequest, string) (bool, error)
}

type EvaluationPort interface {
	Record(context.Context, ModelRequest, ModelResult) error
}

func RetryDelay(attempt int, base, maximum time.Duration, jitterRatio, randomValue float64) (time.Duration, error) {
	if attempt < 1 {
		return 0, errors.New("attempt must be positive")
	}
	bounded := float64(base) * math.Pow(2, float64(attempt-1))
	if bounded > float64(maximum) {
		bounded = float64(maximum)
	}
	randomValue = math.Max(0, math.Min(1, randomValue))
	return time.Duration(math.Round(bounded + bounded*jitterRatio*randomValue)), nil
}

func EnforceBudget(request ModelRequest, inputTokens, maxInputTokens, maxOutputTokens int) *ModelFailure {
	if inputTokens <= maxInputTokens && request.MaxOutputTokens <= maxOutputTokens {
		return nil
	}
	return &ModelFailure{
		Kind:      FailureBudgetExhausted,
		Message:   "the request exceeds its configured token budget",
		Retryable: false,
	}
}

type CircuitState string

const (
	CircuitClosed   CircuitState = "closed"
	CircuitOpen     CircuitState = "open"
	CircuitHalfOpen CircuitState = "half-open"
)

type CircuitBreaker struct {
	mu               sync.Mutex
	state            CircuitState
	failures         int
	openedAt         time.Time
	failureThreshold int
	resetAfter       time.Duration
}

func NewCircuitBreaker(failureThreshold int, resetAfter time.Duration) (*CircuitBreaker, error) {
	if failureThreshold < 1 || resetAfter <= 0 {
		return nil, errors.New("circuit breaker limits must be positive")
	}
	return &CircuitBreaker{
		state: CircuitClosed, failureThreshold: failureThreshold, resetAfter: resetAfter,
	}, nil
}

func (breaker *CircuitBreaker) State(now time.Time) CircuitState {
	breaker.mu.Lock()
	defer breaker.mu.Unlock()
	if breaker.state == CircuitOpen && now.Sub(breaker.openedAt) >= breaker.resetAfter {
		breaker.state = CircuitHalfOpen
	}
	return breaker.state
}

func (breaker *CircuitBreaker) Allow(now time.Time) bool {
	return breaker.State(now) != CircuitOpen
}

func (breaker *CircuitBreaker) Success() {
	breaker.mu.Lock()
	defer breaker.mu.Unlock()
	breaker.state = CircuitClosed
	breaker.failures = 0
}

func (breaker *CircuitBreaker) Failure(now time.Time) {
	breaker.mu.Lock()
	defer breaker.mu.Unlock()
	breaker.failures++
	if breaker.state == CircuitHalfOpen || breaker.failures >= breaker.failureThreshold {
		breaker.state = CircuitOpen
		breaker.openedAt = now
	}
}
`;

export const goRuntime = createRuntimeTemplate({
  id: "go-runtime",
  language: "go",
  displayName: "Go",
  fileName: "runtime.go",
  source: SOURCE
});

export function createGoRuntimeLoader() {
  return runtimeLoader(goRuntime);
}

export const goRuntimeLoader = createGoRuntimeLoader();
