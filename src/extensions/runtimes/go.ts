import { goIntegrations } from "./integrations/go.js";
import { goRuntimeModules } from "./modules/go.js";
import { goProviders } from "./providers/go.js";
import { createRuntimeTemplate, runtimeLoader } from "./shared.js";

const SOURCE = `package aiyokeruntime

import (
	"context"
	"errors"
	"math"
	"sort"
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
	InputTokens     int
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

type ModelResult interface{ modelResult() }

type ModelSuccess struct {
	Value any
	Usage Usage
}

func (ModelSuccess) modelResult() {}
func (ModelFailure) modelResult() {}

type ModelAdapter interface {
	Invoke(context.Context, ModelRequest) ModelResult
}

type EventSink interface {
	Emit(context.Context, map[string]any) error
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

type HumanFeedbackPort interface {
	Record(context.Context, string, float64, string) error
}

type GuardStage string

const (
	GuardInput  GuardStage = "input"
	GuardOutput GuardStage = "output"
	GuardTool   GuardStage = "tool"
)

type GuardContext struct {
	Stage   GuardStage
	Request ModelRequest
	Value   any
}

type GuardDecision interface{ guardDecision() }

type GuardAllowed struct{}
type GuardRejected struct{ Reason string }

func (GuardAllowed) guardDecision()  {}
func (GuardRejected) guardDecision() {}

type Guard interface {
	Check(context.Context, GuardContext) (GuardDecision, error)
}

type ValidationResult interface{ validationResult() }

type ValidationSuccess struct{ Value any }
type ValidationFailure struct{ Reason string }

func (ValidationSuccess) validationResult() {}
func (ValidationFailure) validationResult() {}

type OutputValidator interface {
	Validate(any) ValidationResult
}

type RepairPort interface {
	Repair(context.Context, ModelRequest, any, string) (any, error)
}

type RetryOptions struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	JitterRatio float64
}

type RuntimeOptions struct {
	Timeout                 time.Duration
	Retry                   RetryOptions
	FallbackRoutes          []string
	MaxRepairAttempts       int
	MaxInputTokens          int
	MaxOutputTokens         int
	MaxEstimatedCostUSD     *float64
	MaxConcurrency          int
	MaxBatchSize            int
	CircuitFailureThreshold int
	CircuitResetAfter       time.Duration
}

type ExecuteOptions struct {
	Validator      OutputValidator
	CacheKey       string
	ApprovalReason string
}

type AdapterRegistry struct {
	mu       sync.RWMutex
	adapters map[string]ModelAdapter
}

func NewAdapterRegistry() *AdapterRegistry {
	return &AdapterRegistry{adapters: make(map[string]ModelAdapter)}
}

func (registry *AdapterRegistry) Register(route string, adapter ModelAdapter) error {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if route == "" {
		return errors.New("route must not be empty")
	}
	if _, exists := registry.adapters[route]; exists {
		return errors.New("adapter already registered for route " + route)
	}
	registry.adapters[route] = adapter
	return nil
}

func (registry *AdapterRegistry) Get(route string) (ModelAdapter, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	adapter, exists := registry.adapters[route]
	return adapter, exists
}

type GuardRegistry struct {
	mu     sync.RWMutex
	guards map[GuardStage][]Guard
}

func NewGuardRegistry() *GuardRegistry {
	return &GuardRegistry{guards: make(map[GuardStage][]Guard)}
}

func (registry *GuardRegistry) Register(stage GuardStage, guard Guard) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.guards[stage] = append(registry.guards[stage], guard)
}

func (registry *GuardRegistry) Check(ctx context.Context, check GuardContext) (GuardDecision, error) {
	registry.mu.RLock()
	guards := append([]Guard(nil), registry.guards[check.Stage]...)
	registry.mu.RUnlock()
	for _, guard := range guards {
		decision, err := guard.Check(ctx, check)
		if err != nil {
			return GuardRejected{Reason: "guard evaluation failed"}, err
		}
		if _, rejected := decision.(GuardRejected); rejected {
			return decision, nil
		}
	}
	return GuardAllowed{}, nil
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

type RuntimeDependencies struct {
	Adapters   *AdapterRegistry
	Guards     *GuardRegistry
	Events     EventSink
	Cache      CachePort
	Approval   ApprovalPort
	Evaluation EvaluationPort
	Repair     RepairPort
	Clock      func() time.Time
	Random     func() float64
	Sleep      func(context.Context, time.Duration) error
}

type HarnessRuntime struct {
	options  RuntimeOptions
	deps     RuntimeDependencies
	capacity chan struct{}
	mu       sync.Mutex
	circuits map[string]*CircuitBreaker
}

func NewHarnessRuntime(options RuntimeOptions, deps RuntimeDependencies) (*HarnessRuntime, error) {
	if deps.Adapters == nil {
		return nil, errors.New("adapter registry is required")
	}
	if options.Timeout <= 0 || options.Retry.MaxAttempts < 1 {
		return nil, errors.New("timeout and max attempts must be positive")
	}
	if options.MaxConcurrency < 1 || options.MaxBatchSize < 1 {
		return nil, errors.New("concurrency and batch limits must be positive")
	}
	if options.CircuitFailureThreshold < 1 || options.CircuitResetAfter <= 0 {
		return nil, errors.New("circuit breaker limits must be positive")
	}
	if deps.Clock == nil {
		deps.Clock = time.Now
	}
	if deps.Random == nil {
		deps.Random = func() float64 { return 0.5 }
	}
	if deps.Sleep == nil {
		deps.Sleep = sleepWithContext
	}
	return &HarnessRuntime{
		options:  options,
		deps:     deps,
		capacity: make(chan struct{}, options.MaxConcurrency),
		circuits: make(map[string]*CircuitBreaker),
	}, nil
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (runtime *HarnessRuntime) Execute(
	ctx context.Context, request ModelRequest, executeOptions ExecuteOptions,
) ModelResult {
	select {
	case runtime.capacity <- struct{}{}:
		defer func() { <-runtime.capacity }()
	case <-ctx.Done():
		return ModelFailure{Kind: FailureCancelled, Message: "the request was cancelled", Retryable: false}
	}
	return runtime.executeWithCapacity(ctx, request, executeOptions)
}

func (runtime *HarnessRuntime) ExecuteBatch(
	ctx context.Context, requests []ModelRequest, executeOptions ExecuteOptions,
) ([]ModelResult, error) {
	if len(requests) > runtime.options.MaxBatchSize {
		return nil, errors.New("batch exceeds max batch size")
	}
	results := make([]ModelResult, len(requests))
	var wait sync.WaitGroup
	wait.Add(len(requests))
	for index, request := range requests {
		go func() {
			defer wait.Done()
			results[index] = runtime.Execute(ctx, request, executeOptions)
		}()
	}
	wait.Wait()
	return results, nil
}

func (runtime *HarnessRuntime) executeWithCapacity(
	ctx context.Context, request ModelRequest, executeOptions ExecuteOptions,
) ModelResult {
	startedAt := runtime.deps.Clock()
	runtime.emit(ctx, "request-started", request, nil)
	if failure := EnforceBudget(
		request, request.InputTokens, runtime.options.MaxInputTokens, runtime.options.MaxOutputTokens,
	); failure != nil {
		return runtime.finishFailure(ctx, request, *failure)
	}
	if runtime.deps.Guards != nil {
		decision, err := runtime.deps.Guards.Check(ctx, GuardContext{
			Stage: GuardInput, Request: request, Value: request.Input,
		})
		if rejected, ok := decision.(GuardRejected); ok || err != nil {
			reason := "guard evaluation failed"
			if ok {
				reason = rejected.Reason
			}
			return runtime.finishFailure(ctx, request, ModelFailure{
				Kind: FailureGuardRejected, Message: reason, Retryable: false,
			})
		}
	}
	if executeOptions.ApprovalReason != "" {
		approved := false
		if runtime.deps.Approval != nil {
			var err error
			approved, err = runtime.deps.Approval.Approve(ctx, request, executeOptions.ApprovalReason)
			if err != nil {
				approved = false
			}
		}
		if !approved {
			return runtime.finishFailure(ctx, request, ModelFailure{
				Kind:      FailureApprovalRequired,
				Message:   "the configured human approval was not granted",
				Retryable: false,
			})
		}
	}
	if executeOptions.CacheKey != "" && runtime.deps.Cache != nil {
		cached, found, err := runtime.deps.Cache.Get(ctx, executeOptions.CacheKey)
		if err != nil {
			runtime.emit(ctx, "cache-read-failed", request, nil)
		} else if found {
			runtime.emit(ctx, "cache-hit", request, nil)
			result := ModelSuccess{Value: cached, Usage: Usage{}}
			runtime.record(ctx, request, result)
			return result
		} else {
			runtime.emit(ctx, "cache-miss", request, nil)
		}
	}

	routes := uniqueRoutes(append([]string{request.Route}, runtime.options.FallbackRoutes...))
	finalFailure := ModelFailure{
		Kind: FailureProvider, Message: "no registered route could complete the request", Retryable: false,
	}
	for routeIndex, route := range routes {
		if routeIndex > 0 {
			runtime.emit(ctx, "fallback-selected", request, map[string]any{"route": route})
		}
		adapter, exists := runtime.deps.Adapters.Get(route)
		if !exists {
			finalFailure = ModelFailure{
				Kind:      FailureProvider,
				Message:   "no adapter is registered for route " + route,
				Retryable: false,
			}
			continue
		}
		circuit := runtime.circuit(route)
		if !circuit.Allow(runtime.deps.Clock()) {
			finalFailure = ModelFailure{
				Kind:      FailureCircuitOpen,
				Message:   "the circuit is open for route " + route,
				Retryable: true,
			}
			continue
		}
		for attempt := 1; attempt <= runtime.options.Retry.MaxAttempts; attempt++ {
			runtime.emit(ctx, "attempt-started", request, map[string]any{
				"route": route, "attempt": attempt,
			})
			result := runtime.invoke(ctx, adapter, request)
			if success, ok := result.(ModelSuccess); ok {
				resolved := runtime.validateAndRepair(ctx, request, success.Value, executeOptions.Validator)
				if failure, invalid := resultFailure(resolved); invalid {
					finalFailure = failure
					break
				}
				value := resolved.(ModelSuccess).Value
				if runtime.deps.Guards != nil {
					decision, err := runtime.deps.Guards.Check(ctx, GuardContext{
						Stage: GuardOutput, Request: request, Value: value,
					})
					if rejected, rejectedOutput := decision.(GuardRejected); rejectedOutput || err != nil {
						reason := "guard evaluation failed"
						if rejectedOutput {
							reason = rejected.Reason
						}
						return runtime.finishFailure(ctx, request, ModelFailure{
							Kind: FailureGuardRejected, Message: reason, Retryable: false,
						})
					}
				}
				if runtime.options.MaxEstimatedCostUSD != nil &&
					success.Usage.EstimatedCostUSD > *runtime.options.MaxEstimatedCostUSD {
					return runtime.finishFailure(ctx, request, ModelFailure{
						Kind:      FailureBudgetExhausted,
						Message:   "the result exceeds its configured cost budget",
						Retryable: false,
					})
				}
				circuit.Success()
				completed := ModelSuccess{Value: value, Usage: success.Usage}
				if executeOptions.CacheKey != "" && runtime.deps.Cache != nil {
					if err := runtime.deps.Cache.Set(ctx, executeOptions.CacheKey, value); err != nil {
						runtime.emit(ctx, "cache-write-failed", request, nil)
					} else {
						runtime.emit(ctx, "cache-stored", request, nil)
					}
				}
				runtime.emit(ctx, "request-succeeded", request, map[string]any{
					"usage":      success.Usage,
					"latency_ms": max(0, runtime.deps.Clock().Sub(startedAt).Milliseconds()),
				})
				runtime.record(ctx, request, completed)
				return completed
			}
			failure, validFailure := resultFailure(result)
			if !validFailure {
				failure = ModelFailure{Kind: FailureProvider, Message: "adapter returned an invalid result", Retryable: false}
			}
			finalFailure = failure
			if failure.Retryable {
				circuit.Failure(runtime.deps.Clock())
			}
			if !failure.Retryable || attempt >= runtime.options.Retry.MaxAttempts {
				break
			}
			delay, err := RetryDelay(
				attempt,
				runtime.options.Retry.BaseDelay,
				runtime.options.Retry.MaxDelay,
				runtime.options.Retry.JitterRatio,
				runtime.deps.Random(),
			)
			if err != nil {
				return runtime.finishFailure(ctx, request, ModelFailure{
					Kind: FailureProvider, Message: err.Error(), Retryable: false,
				})
			}
			runtime.emit(ctx, "retry-scheduled", request, map[string]any{
				"delay_ms": delay.Milliseconds(), "attempt": attempt,
			})
			if err := runtime.deps.Sleep(ctx, delay); err != nil {
				return runtime.finishFailure(ctx, request, ModelFailure{
					Kind: FailureCancelled, Message: "the request was cancelled during retry backoff", Retryable: false,
				})
			}
		}
		switch finalFailure.Kind {
		case FailureCancelled, FailureGuardRejected, FailureApprovalRequired, FailureBudgetExhausted:
			return runtime.finishFailure(ctx, request, finalFailure)
		}
	}
	return runtime.finishFailure(ctx, request, finalFailure)
}

func (runtime *HarnessRuntime) invoke(
	ctx context.Context, adapter ModelAdapter, request ModelRequest,
) ModelResult {
	attemptCtx, cancel := context.WithTimeout(ctx, runtime.options.Timeout)
	defer cancel()
	results := make(chan ModelResult, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				results <- ModelFailure{
					Kind: FailureProvider, Message: "provider adapter panicked", Retryable: true,
				}
			}
		}()
		results <- adapter.Invoke(attemptCtx, request)
	}()
	select {
	case result := <-results:
		return result
	case <-attemptCtx.Done():
		if errors.Is(ctx.Err(), context.Canceled) {
			return ModelFailure{Kind: FailureCancelled, Message: "the request was cancelled", Retryable: false}
		}
		return ModelFailure{Kind: FailureTimeout, Message: "the model deadline expired", Retryable: true}
	}
}

func (runtime *HarnessRuntime) validateAndRepair(
	ctx context.Context, request ModelRequest, initialValue any, validator OutputValidator,
) ModelResult {
	if validator == nil {
		return ModelSuccess{Value: initialValue}
	}
	candidate := initialValue
	for repairAttempt := 0; repairAttempt <= runtime.options.MaxRepairAttempts; repairAttempt++ {
		validation := validator.Validate(candidate)
		if success, ok := validation.(ValidationSuccess); ok {
			return ModelSuccess{Value: success.Value}
		}
		failure, ok := validation.(ValidationFailure)
		if !ok {
			return ModelFailure{Kind: FailureInvalidOutput, Message: "validator returned an invalid result", Retryable: false}
		}
		if repairAttempt >= runtime.options.MaxRepairAttempts || runtime.deps.Repair == nil {
			return ModelFailure{Kind: FailureInvalidOutput, Message: failure.Reason, Retryable: false}
		}
		var err error
		candidate, err = runtime.deps.Repair.Repair(ctx, request, candidate, failure.Reason)
		if err != nil {
			return ModelFailure{Kind: FailureInvalidOutput, Message: err.Error(), Retryable: false}
		}
	}
	return ModelFailure{Kind: FailureInvalidOutput, Message: "structured output could not be validated", Retryable: false}
}

func resultFailure(result ModelResult) (ModelFailure, bool) {
	switch selected := result.(type) {
	case ModelFailure:
		return selected, true
	case *ModelFailure:
		return *selected, true
	default:
		return ModelFailure{}, false
	}
}

func uniqueRoutes(routes []string) []string {
	seen := make(map[string]struct{}, len(routes))
	unique := make([]string, 0, len(routes))
	for _, route := range routes {
		if _, exists := seen[route]; exists {
			continue
		}
		seen[route] = struct{}{}
		unique = append(unique, route)
	}
	return unique
}

func (runtime *HarnessRuntime) circuit(route string) *CircuitBreaker {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if circuit, exists := runtime.circuits[route]; exists {
		return circuit
	}
	circuit, _ := NewCircuitBreaker(
		runtime.options.CircuitFailureThreshold, runtime.options.CircuitResetAfter,
	)
	runtime.circuits[route] = circuit
	return circuit
}

func (runtime *HarnessRuntime) finishFailure(
	ctx context.Context, request ModelRequest, failure ModelFailure,
) ModelResult {
	runtime.emit(ctx, "request-failed", request, map[string]any{"failure_kind": failure.Kind})
	runtime.record(ctx, request, failure)
	return failure
}

func (runtime *HarnessRuntime) record(
	ctx context.Context, request ModelRequest, result ModelResult,
) {
	if runtime.deps.Evaluation != nil {
		_ = runtime.deps.Evaluation.Record(ctx, request, result)
	}
}

func (runtime *HarnessRuntime) emit(
	ctx context.Context, eventType string, request ModelRequest, details map[string]any,
) {
	if runtime.deps.Events == nil {
		return
	}
	metadataKeys := make([]string, 0, len(request.Metadata))
	for key := range request.Metadata {
		metadataKeys = append(metadataKeys, key)
	}
	sort.Strings(metadataKeys)
	event := map[string]any{
		"type":           eventType,
		"request_id":     request.ID,
		"occurred_at":    runtime.deps.Clock(),
		"prompt_version": request.PromptVersion,
		"metadata_keys":  metadataKeys,
	}
	for key, value := range details {
		event[key] = value
	}
	_ = runtime.deps.Events.Emit(ctx, event)
}
`;

const TEST_SOURCE = `package aiyokeruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func testOptions() RuntimeOptions {
	return RuntimeOptions{
		Timeout:                 time.Second,
		Retry:                   RetryOptions{MaxAttempts: 2, BaseDelay: 10 * time.Millisecond, MaxDelay: 100 * time.Millisecond},
		FallbackRoutes:          []string{"fallback"},
		MaxRepairAttempts:       1,
		MaxInputTokens:          100,
		MaxOutputTokens:         100,
		MaxConcurrency:          2,
		MaxBatchSize:            4,
		CircuitFailureThreshold: 3,
		CircuitResetAfter:       time.Second,
	}
}

func testRequest(id string) ModelRequest {
	return ModelRequest{
		ID: id, Route: "primary", PromptVersion: "v1", Input: map[string]any{},
		InputTokens: 10, MaxOutputTokens: 100, Metadata: map[string]string{"tenant": "secret-value"},
	}
}

func TestRetryDelay(t *testing.T) {
	delay, err := RetryDelay(2, 100*time.Millisecond, time.Second, 0.5, 0)
	if err != nil || delay != 200*time.Millisecond {
		t.Fatalf("unexpected delay %v, error %v", delay, err)
	}
	if _, err := RetryDelay(0, time.Millisecond, time.Second, 0, 0); err == nil {
		t.Fatal("zero attempt must fail")
	}
}

func TestBudget(t *testing.T) {
	request := ModelRequest{MaxOutputTokens: 100}
	if failure := EnforceBudget(request, 10, 10, 100); failure != nil {
		t.Fatalf("valid budget rejected: %+v", failure)
	}
	if failure := EnforceBudget(request, 11, 10, 100); failure == nil || failure.Kind != FailureBudgetExhausted {
		t.Fatalf("budget must fail closed: %+v", failure)
	}
}

func TestCircuitTransitions(t *testing.T) {
	breaker, err := NewCircuitBreaker(2, 100*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	breaker.Failure(start)
	if !breaker.Allow(start.Add(time.Millisecond)) {
		t.Fatal("circuit opened too early")
	}
	breaker.Failure(start.Add(2 * time.Millisecond))
	if breaker.Allow(start.Add(50 * time.Millisecond)) {
		t.Fatal("open circuit allowed request")
	}
	if !breaker.Allow(start.Add(102 * time.Millisecond)) {
		t.Fatal("circuit did not half-open")
	}
	breaker.Success()
	if !breaker.Allow(start.Add(103 * time.Millisecond)) {
		t.Fatal("successful circuit did not close")
	}
}

type failingAdapter struct{ calls int }

func (adapter *failingAdapter) Invoke(context.Context, ModelRequest) ModelResult {
	adapter.calls++
	return ModelFailure{Kind: FailureRateLimit, Message: "busy", Retryable: true}
}

type fallbackAdapter struct{}

func (fallbackAdapter) Invoke(context.Context, ModelRequest) ModelResult {
	return ModelSuccess{
		Value: map[string]any{"answer": 42},
		Usage: Usage{InputTokens: 10, OutputTokens: 2, EstimatedCostUSD: 0.01},
	}
}

type answerValidator struct{}

func (answerValidator) Validate(value any) ValidationResult {
	answer := value.(map[string]any)["answer"]
	if _, valid := answer.(string); valid {
		return ValidationSuccess{Value: value}
	}
	return ValidationFailure{Reason: "answer must be a string"}
}

type answerRepair struct{}

func (answerRepair) Repair(_ context.Context, _ ModelRequest, _ any, _ string) (any, error) {
	return map[string]any{"answer": "42"}, nil
}

type memoryEvents struct {
	mu     sync.Mutex
	events []map[string]any
}

func (sink *memoryEvents) Emit(_ context.Context, event map[string]any) error {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	sink.events = append(sink.events, event)
	return nil
}

func TestRuntimeRetryFallbackRepairAndRedactedEvents(t *testing.T) {
	primary := &failingAdapter{}
	registry := NewAdapterRegistry()
	if err := registry.Register("primary", primary); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register("fallback", fallbackAdapter{}); err != nil {
		t.Fatal(err)
	}
	events := &memoryEvents{}
	var delays []time.Duration
	now := time.Unix(100, 0)
	runtime, err := NewHarnessRuntime(testOptions(), RuntimeDependencies{
		Adapters: registry,
		Events:   events,
		Repair:   answerRepair{},
		Clock:    func() time.Time { return now },
		Random:   func() float64 { return 0 },
		Sleep: func(_ context.Context, delay time.Duration) error {
			delays = append(delays, delay)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	result := runtime.Execute(context.Background(), testRequest("request-1"), ExecuteOptions{
		Validator: answerValidator{},
	})
	success, ok := result.(ModelSuccess)
	if !ok {
		t.Fatalf("expected success, got %#v", result)
	}
	if success.Value.(map[string]any)["answer"] != "42" {
		t.Fatalf("output was not repaired: %#v", success.Value)
	}
	if primary.calls != 2 || len(delays) != 1 || delays[0] != 10*time.Millisecond {
		t.Fatalf("unexpected retry behavior: calls=%d delays=%v", primary.calls, delays)
	}
	foundFallback := false
	for _, event := range events.events {
		if event["type"] == "fallback-selected" {
			foundFallback = true
		}
		if _, leaked := event["input"]; leaked {
			t.Fatal("event leaked model input")
		}
	}
	if !foundFallback {
		t.Fatal("fallback event was not emitted")
	}
	keys := events.events[0]["metadata_keys"].([]string)
	if len(keys) != 1 || keys[0] != "tenant" {
		t.Fatalf("metadata was not redacted: %v", keys)
	}
}

type terminalAdapter struct{}

func (terminalAdapter) Invoke(context.Context, ModelRequest) ModelResult {
	return ModelFailure{Kind: FailureCancelled, Message: "cancelled", Retryable: false}
}

func TestTerminalPolicyFailuresNeverFallThroughToFallbacks(t *testing.T) {
	registry := NewAdapterRegistry()
	if err := registry.Register("primary", terminalAdapter{}); err != nil {
		t.Fatal(err)
	}
	runtime, err := NewHarnessRuntime(testOptions(), RuntimeDependencies{Adapters: registry})
	if err != nil {
		t.Fatal(err)
	}
	result := runtime.Execute(context.Background(), testRequest("terminal"), ExecuteOptions{})
	failure, ok := result.(ModelFailure)
	if !ok || failure.Kind != FailureCancelled {
		t.Fatalf("terminal failure was replaced by fallback: %#v", result)
	}
}

type rejectingGuard struct{}

func (rejectingGuard) Check(context.Context, GuardContext) (GuardDecision, error) {
	return GuardRejected{Reason: "blocked by policy"}, nil
}

func TestRuntimeGuardsAndApprovalFailClosed(t *testing.T) {
	registry := NewAdapterRegistry()
	if err := registry.Register("primary", fallbackAdapter{}); err != nil {
		t.Fatal(err)
	}
	guards := NewGuardRegistry()
	guards.Register(GuardInput, rejectingGuard{})
	runtime, err := NewHarnessRuntime(testOptions(), RuntimeDependencies{
		Adapters: registry, Guards: guards,
	})
	if err != nil {
		t.Fatal(err)
	}
	guarded := runtime.Execute(context.Background(), testRequest("guarded"), ExecuteOptions{})
	failure, ok := guarded.(ModelFailure)
	if !ok || failure.Kind != FailureGuardRejected {
		t.Fatalf("guard did not fail closed: %#v", guarded)
	}
	runtime, _ = NewHarnessRuntime(testOptions(), RuntimeDependencies{Adapters: registry})
	approval := runtime.Execute(context.Background(), testRequest("approval"), ExecuteOptions{
		ApprovalReason: "external side effect",
	})
	failure, ok = approval.(ModelFailure)
	if !ok || failure.Kind != FailureApprovalRequired {
		t.Fatalf("approval did not fail closed: %#v", approval)
	}
}

type concurrentAdapter struct {
	mu      sync.Mutex
	active  int
	maximum int
}

func (adapter *concurrentAdapter) Invoke(context.Context, ModelRequest) ModelResult {
	adapter.mu.Lock()
	adapter.active++
	if adapter.active > adapter.maximum {
		adapter.maximum = adapter.active
	}
	adapter.mu.Unlock()
	time.Sleep(time.Millisecond)
	adapter.mu.Lock()
	adapter.active--
	adapter.mu.Unlock()
	return ModelSuccess{Value: "fresh", Usage: Usage{InputTokens: 1, OutputTokens: 1}}
}

func TestRuntimeBatchConcurrencyIsBounded(t *testing.T) {
	adapter := &concurrentAdapter{}
	registry := NewAdapterRegistry()
	if err := registry.Register("primary", adapter); err != nil {
		t.Fatal(err)
	}
	options := testOptions()
	options.MaxConcurrency = 1
	runtime, err := NewHarnessRuntime(options, RuntimeDependencies{Adapters: registry})
	if err != nil {
		t.Fatal(err)
	}
	results, err := runtime.ExecuteBatch(context.Background(), []ModelRequest{
		testRequest("one"), testRequest("two"), testRequest("three"),
	}, ExecuteOptions{})
	if err != nil || len(results) != 3 {
		t.Fatalf("batch failed: %v %#v", err, results)
	}
	if adapter.maximum != 1 {
		t.Fatalf("maximum concurrency was %d", adapter.maximum)
	}
}

type failingCache struct{}

func (failingCache) Get(context.Context, string) (any, bool, error) {
	return nil, false, errors.New("cache unavailable")
}

func (failingCache) Set(context.Context, string, any) error {
	return errors.New("cache unavailable")
}

func TestCacheFailuresAreContainedAndObservable(t *testing.T) {
	registry := NewAdapterRegistry()
	if err := registry.Register("primary", fallbackAdapter{}); err != nil {
		t.Fatal(err)
	}
	events := &memoryEvents{}
	runtime, err := NewHarnessRuntime(testOptions(), RuntimeDependencies{
		Adapters: registry, Cache: failingCache{}, Events: events,
	})
	if err != nil {
		t.Fatal(err)
	}
	result := runtime.Execute(context.Background(), testRequest("cache"), ExecuteOptions{CacheKey: "one"})
	if _, ok := result.(ModelSuccess); !ok {
		t.Fatalf("cache failure corrupted inference: %#v", result)
	}
	seenReadFailure := false
	seenWriteFailure := false
	for _, event := range events.events {
		seenReadFailure = seenReadFailure || event["type"] == "cache-read-failed"
		seenWriteFailure = seenWriteFailure || event["type"] == "cache-write-failed"
	}
	if !seenReadFailure || !seenWriteFailure {
		t.Fatalf("cache failures were not observable: %#v", events.events)
	}
}
`;

export const goRuntime = createRuntimeTemplate({
  id: "go-runtime",
  language: "go",
  displayName: "Go",
  fileName: "runtime.go",
  source: SOURCE,
  testFileName: "runtime_test.go",
  testSource: TEST_SOURCE,
  modules: goRuntimeModules,
  integrations: goIntegrations,
  providers: goProviders
});

export function createGoRuntimeLoader() {
  return runtimeLoader(goRuntime);
}

export const goRuntimeLoader = createGoRuntimeLoader();
