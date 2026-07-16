import type { RuntimeModuleDefinition } from "../shared.js";

const tooling =
  `package aiyokeruntime

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"sync"
	"time"
)

var toolIdentifier = regexp.MustCompile(` +
  "`" +
  `^[a-z][a-z0-9._-]{0,63}$` +
  "`" +
  `)

type ToolValidation[T any] struct {
	Value T
	Valid bool
	Code  string
}

func ValidToolValue[T any](value T) ToolValidation[T] {
	return ToolValidation[T]{Value: value, Valid: true}
}

func InvalidToolValue[T any](code string) ToolValidation[T] {
	return ToolValidation[T]{Code: code}
}

type ToolApprovalPolicy interface{ toolApprovalPolicy() }

type NoToolApproval struct{}
type RequiredToolApproval struct{ Reason string }

func (NoToolApproval) toolApprovalPolicy()       {}
func (RequiredToolApproval) toolApprovalPolicy() {}

type ToolOutputPolicy[O any] interface {
	validateToolOutput(any) ToolValidation[O]
}

type UncheckedToolOutput[O any] struct{}

func (UncheckedToolOutput[O]) validateToolOutput(value any) ToolValidation[O] {
	typed, ok := value.(O)
	return ToolValidation[O]{Value: typed, Valid: ok, Code: "output_type"}
}

type ValidatedToolOutput[O any] struct {
	Validate func(any) ToolValidation[O]
}

func (policy ValidatedToolOutput[O]) validateToolOutput(value any) ToolValidation[O] {
	return policy.Validate(value)
}

type ModelCorrelation struct {
	RequestID     string
	PromptVersion string
}

type ToolInvocationContext struct {
	RequestID   string
	Correlation *ModelCorrelation
}

type ToolDefinition[I, O any] struct {
	Name          string
	Description   string
	Approval      ToolApprovalPolicy
	Output        ToolOutputPolicy[O]
	ValidateInput func(any) ToolValidation[I]
	Invoke        func(context.Context, I, ToolInvocationContext) (O, error)
}

type registeredTool struct {
	name           string
	description    string
	approval       ToolApprovalPolicy
	validateInput  func(any) (any, bool, string)
	invoke         func(context.Context, any, ToolInvocationContext) (any, error)
	validateOutput func(any) (bool, string)
}

type ToolRegistry struct {
	mu    sync.RWMutex
	tools map[string]registeredTool
}

func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{tools: make(map[string]registeredTool)}
}

func RegisterTool[I, O any](registry *ToolRegistry, definition ToolDefinition[I, O]) error {
	if registry == nil {
		return errors.New("tool registry is required")
	}
	if !toolIdentifier.MatchString(definition.Name) {
		return errors.New("tool name is invalid")
	}
	if definition.Description == "" {
		return errors.New("tool description must not be empty")
	}
	if definition.ValidateInput == nil || definition.Invoke == nil || definition.Output == nil {
		return errors.New("tool validation, handler, and output policy are required")
	}
	if approval, ok := definition.Approval.(RequiredToolApproval); ok && approval.Reason == "" {
		return errors.New("approval reason must not be empty")
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if _, exists := registry.tools[definition.Name]; exists {
		return errors.New("tool already registered: " + definition.Name)
	}
	registry.tools[definition.Name] = registeredTool{
		name:        definition.Name,
		description: definition.Description,
		approval:    definition.Approval,
		validateInput: func(value any) (any, bool, string) {
			result := definition.ValidateInput(value)
			return result.Value, result.Valid, result.Code
		},
		invoke: func(ctx context.Context, value any, invocation ToolInvocationContext) (any, error) {
			typed, ok := value.(I)
			if !ok {
				return nil, errors.New("validated input type mismatch")
			}
			return definition.Invoke(ctx, typed, invocation)
		},
		validateOutput: func(value any) (bool, string) {
			result := definition.Output.validateToolOutput(value)
			return result.Valid, result.Code
		},
	}
	return nil
}

func (registry *ToolRegistry) get(name string) (registeredTool, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	tool, found := registry.tools[name]
	return tool, found
}

func (registry *ToolRegistry) Names() []string {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	names := make([]string, 0, len(registry.tools))
	for name := range registry.tools {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

type ToolExecutionRequest struct {
	RequestID   string
	Tool        string
	Input       any
	Timeout     time.Duration
	Metadata    map[string]string
	Correlation *ModelCorrelation
}

type ToolApprovalRequest struct {
	RequestID     string
	Tool          string
	MetadataKeys  []string
	CorrelationID string
}

type ToolApprovalPort interface {
	Approve(context.Context, ToolApprovalRequest, string) (bool, error)
}

type ToolEvent struct {
	Type          string
	RequestID     string
	Tool          string
	OccurredAt    time.Time
	MetadataKeys  []string
	CorrelationID string
}

type ToolEventSink interface {
	Emit(context.Context, ToolEvent) error
}

type ToolResult interface{ toolResult() }

type ToolSuccess struct {
	Value    any
	Duration time.Duration
}

type ToolFailure struct {
	Kind      string
	Phase     string
	Message   string
	Code      string
	Retryable bool
}

func (ToolSuccess) toolResult() {}
func (ToolFailure) toolResult() {}

type ToolRunner struct {
	Registry       *ToolRegistry
	DefaultTimeout time.Duration
	MaxTimeout     time.Duration
	Approval       ToolApprovalPort
	Events         ToolEventSink
	Now            func() time.Time
}

func NewToolRunner(
	registry *ToolRegistry,
	defaultTimeout time.Duration,
	maxTimeout time.Duration,
) (*ToolRunner, error) {
	if registry == nil {
		return nil, errors.New("tool registry is required")
	}
	if defaultTimeout <= 0 || maxTimeout < defaultTimeout {
		return nil, errors.New("tool timeout bounds are invalid")
	}
	return &ToolRunner{
		Registry: registry, DefaultTimeout: defaultTimeout, MaxTimeout: maxTimeout, Now: time.Now,
	}, nil
}

func (runner *ToolRunner) event(ctx context.Context, request ToolExecutionRequest, eventType string) {
	if runner.Events == nil {
		return
	}
	keys := make([]string, 0, len(request.Metadata))
	for key := range request.Metadata {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	correlationID := ""
	if request.Correlation != nil {
		correlationID = request.Correlation.RequestID
	}
	_ = runner.Events.Emit(ctx, ToolEvent{
		Type: eventType, RequestID: request.RequestID, Tool: request.Tool,
		OccurredAt: runner.Now(), MetadataKeys: keys, CorrelationID: correlationID,
	})
}

func (runner *ToolRunner) fail(
	ctx context.Context,
	request ToolExecutionRequest,
	kind string,
	phase string,
	message string,
	code string,
) ToolFailure {
	runner.event(ctx, request, "tool-failed")
	if code != "" && !toolIdentifier.MatchString(code) {
		code = "validation_failed"
	}
	return ToolFailure{Kind: kind, Phase: phase, Message: message, Code: code}
}

type toolOutcome struct {
	value any
	err   error
}

func (runner *ToolRunner) Execute(ctx context.Context, request ToolExecutionRequest) ToolResult {
	started := runner.Now()
	runner.event(ctx, request, "tool-started")
	tool, found := runner.Registry.get(request.Tool)
	if !found {
		return runner.fail(ctx, request, "not-found", "lookup", "The tool is not registered.", "")
	}
	var input any
	valid := false
	code := "validator_error"
	func() {
		defer func() { _ = recover() }()
		input, valid, code = tool.validateInput(request.Input)
	}()
	if !valid {
		return runner.fail(ctx, request, "invalid-input", "input", "Tool input validation failed.", code)
	}
	if approval, required := tool.approval.(RequiredToolApproval); required {
		runner.event(ctx, request, "approval-requested")
		if runner.Approval == nil {
			return runner.fail(
				ctx, request, "approval-required", "approval", "A tool approval port is required.", "",
			)
		}
		keys := make([]string, 0, len(request.Metadata))
		for key := range request.Metadata {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		approvalRequest := ToolApprovalRequest{RequestID: request.RequestID, Tool: request.Tool, MetadataKeys: keys}
		if request.Correlation != nil {
			approvalRequest.CorrelationID = request.Correlation.RequestID
		}
		approved, err := runner.Approval.Approve(ctx, approvalRequest, approval.Reason)
		if err != nil {
			return runner.fail(
				ctx, request, "approval-failed", "approval", "The approval decision could not be obtained.", "",
			)
		}
		if !approved {
			return runner.fail(
				ctx, request, "approval-denied", "approval", "The tool execution was not approved.", "",
			)
		}
	}
	timeout := request.Timeout
	if timeout <= 0 {
		timeout = runner.DefaultTimeout
	}
	if timeout > runner.MaxTimeout {
		timeout = runner.MaxTimeout
	}
	invocationContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	outcomes := make(chan toolOutcome, 1)
	go func() {
		outcome := toolOutcome{}
		defer func() {
			if recover() != nil {
				outcome.err = errors.New("tool handler panicked")
			}
			outcomes <- outcome
		}()
		outcome.value, outcome.err = tool.invoke(
			invocationContext,
			input,
			ToolInvocationContext{RequestID: request.RequestID, Correlation: request.Correlation},
		)
	}()
	select {
	case outcome := <-outcomes:
		if outcome.err != nil {
			return runner.fail(ctx, request, "handler-error", "execution", "The tool handler failed.", "")
		}
		outputValid := false
		outputCode := "validator_error"
		func() {
			defer func() { _ = recover() }()
			outputValid, outputCode = tool.validateOutput(outcome.value)
		}()
		if !outputValid {
			return runner.fail(
				ctx, request, "invalid-output", "output", "Tool output validation failed.", outputCode,
			)
		}
		runner.event(ctx, request, "tool-succeeded")
		return ToolSuccess{Value: outcome.value, Duration: runner.Now().Sub(started)}
	case <-invocationContext.Done():
		if ctx.Err() != nil {
			return runner.fail(
				ctx, request, "cancelled", "execution", "The tool execution was cancelled.", "",
			)
		}
		return runner.fail(
			ctx, request, "timeout", "execution", "The tool execution deadline expired.", "",
		)
	}
}
`;

const toolingTests = `package aiyokeruntime

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type recordingToolEvents struct {
	mu     sync.Mutex
	events []ToolEvent
}

func (sink *recordingToolEvents) Emit(_ context.Context, event ToolEvent) error {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	sink.events = append(sink.events, event)
	return nil
}

func numberToolDefinition() ToolDefinition[int, int] {
	return ToolDefinition[int, int]{
		Name: "math.double", Description: "Doubles a number.", Approval: NoToolApproval{},
		Output: ValidatedToolOutput[int]{Validate: func(value any) ToolValidation[int] {
			number, ok := value.(int)
			if !ok {
				return InvalidToolValue[int]("not_number")
			}
			return ValidToolValue(number)
		}},
		ValidateInput: func(value any) ToolValidation[int] {
			number, ok := value.(int)
			if !ok {
				return InvalidToolValue[int]("not_number")
			}
			return ValidToolValue(number)
		},
		Invoke: func(_ context.Context, value int, _ ToolInvocationContext) (int, error) {
			return value * 2, nil
		},
	}
}

func toolRequest() ToolExecutionRequest {
	return ToolExecutionRequest{
		RequestID: "tool-1", Tool: "math.double", Input: 3,
		Metadata: map[string]string{"tenant": "one", "secret": "must-not-be-emitted"},
	}
}

func TestToolRunnerExecutesWithoutLoggingValues(t *testing.T) {
	registry := NewToolRegistry()
	definition := numberToolDefinition()
	if err := RegisterTool(registry, definition); err != nil {
		t.Fatal(err)
	}
	if err := RegisterTool(registry, definition); err == nil {
		t.Fatal("expected duplicate registration to fail")
	}
	runner, err := NewToolRunner(registry, 100*time.Millisecond, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	events := &recordingToolEvents{}
	runner.Events = events
	fixed := time.Unix(10, 0)
	runner.Now = func() time.Time { return fixed }
	result := runner.Execute(context.Background(), toolRequest())
	success, ok := result.(ToolSuccess)
	if !ok || success.Value != 6 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if strings.Contains(fmt.Sprint(events.events), "must-not-be-emitted") {
		t.Fatal("event leaked a metadata value")
	}
}

func TestToolRunnerFailsClosedForValidationAndTimeout(t *testing.T) {
	registry := NewToolRegistry()
	definition := numberToolDefinition()
	definition.Output = ValidatedToolOutput[int]{Validate: func(any) ToolValidation[int] {
		return InvalidToolValue[int]("rejected")
	}}
	if err := RegisterTool(registry, definition); err != nil {
		t.Fatal(err)
	}
	runner, _ := NewToolRunner(registry, 100*time.Millisecond, 100*time.Millisecond)
	request := toolRequest()
	request.Input = "secret input"
	failure := runner.Execute(context.Background(), request).(ToolFailure)
	if failure.Kind != "invalid-input" || strings.Contains(fmt.Sprint(failure), "secret input") {
		t.Fatalf("unsafe validation failure: %#v", failure)
	}
	request.Input = 3
	if failure = runner.Execute(context.Background(), request).(ToolFailure); failure.Kind != "invalid-output" {
		t.Fatalf("unexpected failure: %#v", failure)
	}

	slowRegistry := NewToolRegistry()
	slow := numberToolDefinition()
	slow.Invoke = func(ctx context.Context, value int, _ ToolInvocationContext) (int, error) {
		<-ctx.Done()
		return value, ctx.Err()
	}
	_ = RegisterTool(slowRegistry, slow)
	slowRunner, _ := NewToolRunner(slowRegistry, time.Millisecond, time.Millisecond)
	failure = slowRunner.Execute(context.Background(), toolRequest()).(ToolFailure)
	if failure.Kind != "timeout" {
		t.Fatalf("expected timeout, got %#v", failure)
	}
}

func TestToolRunnerRequiresApproval(t *testing.T) {
	registry := NewToolRegistry()
	definition := numberToolDefinition()
	definition.Approval = RequiredToolApproval{Reason: "Changes external state."}
	_ = RegisterTool(registry, definition)
	runner, _ := NewToolRunner(registry, time.Second, time.Second)
	failure := runner.Execute(context.Background(), toolRequest()).(ToolFailure)
	if failure.Kind != "approval-required" {
		t.Fatalf("unexpected failure: %#v", failure)
	}
}
`;

const evaluation =
  `package aiyokeruntime

import (
	"context"
	"errors"
	"hash/fnv"
	"math"
	"regexp"
	"sort"
	"sync"
	"time"
)

var evaluationIdentifier = regexp.MustCompile(` +
  "`" +
  `^[a-z][a-z0-9._-]{0,63}$` +
  "`" +
  `)

type EvaluationMode interface{ evaluationMode() }

type OfflineEvaluation struct{}
type SampledOnlineEvaluation struct {
	SampleRate float64
	Seed       string
}

func (OfflineEvaluation) evaluationMode()       {}
func (SampledOnlineEvaluation) evaluationMode() {}

type EvaluationCase[I, E any] struct {
	ID            string
	Input         I
	Expected      E
	Route         string
	PromptVersion string
	Metadata      map[string]string
}

type EvaluationSuite[I, E any] struct {
	ID                string
	Version           string
	Evaluator         string
	Threshold         float64
	Mode              EvaluationMode
	Model             string
	PolicyFingerprint string
	Cases             []EvaluationCase[I, E]
}

type EvaluationInvocationContext struct {
	CaseID            string
	Route             string
	PromptVersion     string
	Model             string
	PolicyFingerprint string
}

type EvaluationSubject[I any] interface {
	Invoke(context.Context, I, EvaluationInvocationContext) ModelResult
}

type EvaluatorDefinition[O, E any] struct {
	ID    string
	Score func(O, E) (float64, error)
}

type registeredEvaluator struct {
	score func(any, any) (float64, error)
}

type EvaluatorRegistry struct {
	mu         sync.RWMutex
	evaluators map[string]registeredEvaluator
}

func NewEvaluatorRegistry() *EvaluatorRegistry {
	return &EvaluatorRegistry{evaluators: make(map[string]registeredEvaluator)}
}

func RegisterEvaluator[O, E any](
	registry *EvaluatorRegistry,
	definition EvaluatorDefinition[O, E],
) error {
	if registry == nil || !evaluationIdentifier.MatchString(definition.ID) || definition.Score == nil {
		return errors.New("evaluator definition is invalid")
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if _, exists := registry.evaluators[definition.ID]; exists {
		return errors.New("evaluator already registered: " + definition.ID)
	}
	registry.evaluators[definition.ID] = registeredEvaluator{score: func(actual any, expected any) (float64, error) {
		typedActual, actualOK := actual.(O)
		typedExpected, expectedOK := expected.(E)
		if !actualOK || !expectedOK {
			return 0, errors.New("evaluator input type mismatch")
		}
		return definition.Score(typedActual, typedExpected)
	}}
	return nil
}

func (registry *EvaluatorRegistry) get(id string) (registeredEvaluator, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	evaluator, found := registry.evaluators[id]
	return evaluator, found
}

type EvaluationCaseMetadata struct {
	CaseID            string
	Route             string
	PromptVersion     string
	Model             string
	PolicyFingerprint string
	MetadataKeys      []string
	Duration          time.Duration
}

type EvaluationCaseResult interface {
	evaluationCaseResult()
	metadata() EvaluationCaseMetadata
}

type ScoredEvaluationCase struct {
	EvaluationCaseMetadata
	Passed bool
	Score  float64
}

type ProviderFailureEvaluationCase struct {
	EvaluationCaseMetadata
	FailureKind string
}

type ScorerErrorEvaluationCase struct{ EvaluationCaseMetadata }
type SkippedEvaluationCase struct {
	EvaluationCaseMetadata
	Reason string
}

func (ScoredEvaluationCase) evaluationCaseResult()          {}
func (ProviderFailureEvaluationCase) evaluationCaseResult() {}
func (ScorerErrorEvaluationCase) evaluationCaseResult()     {}
func (SkippedEvaluationCase) evaluationCaseResult()         {}
func (result ScoredEvaluationCase) metadata() EvaluationCaseMetadata { return result.EvaluationCaseMetadata }
func (result ProviderFailureEvaluationCase) metadata() EvaluationCaseMetadata {
	return result.EvaluationCaseMetadata
}
func (result ScorerErrorEvaluationCase) metadata() EvaluationCaseMetadata {
	return result.EvaluationCaseMetadata
}
func (result SkippedEvaluationCase) metadata() EvaluationCaseMetadata { return result.EvaluationCaseMetadata }

type EvaluationDelivery interface{ evaluationDelivery() }
type EvaluationNotConfigured struct{}
type EvaluationStored struct{}
type EvaluationDeliveryFailed struct{ Code string }

func (EvaluationNotConfigured) evaluationDelivery()   {}
func (EvaluationStored) evaluationDelivery()          {}
func (EvaluationDeliveryFailed) evaluationDelivery() {}

type EvaluationReport struct {
	SuiteID           string
	SuiteVersion      string
	Evaluator         string
	Model             string
	PolicyFingerprint string
	Results           []EvaluationCaseResult
	Executed          int
	Passed            int
	Failed            int
	Skipped           int
	PassRate          float64
	MeanScore         float64
	Delivery          EvaluationDelivery
}

type EvaluationReportSink interface {
	Write(context.Context, EvaluationReport) error
}

type EvaluationRunner struct {
	MaxConcurrency int
	Registry       *EvaluatorRegistry
	ReportSink     EvaluationReportSink
	Now            func() time.Time
}

func NewEvaluationRunner(maxConcurrency int, registry *EvaluatorRegistry) (*EvaluationRunner, error) {
	if maxConcurrency <= 0 || registry == nil {
		return nil, errors.New("evaluation runner options are invalid")
	}
	return &EvaluationRunner{MaxConcurrency: maxConcurrency, Registry: registry, Now: time.Now}, nil
}

func evaluationSampled(caseID string, mode EvaluationMode) bool {
	sampled, ok := mode.(SampledOnlineEvaluation)
	if !ok {
		return true
	}
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(sampled.Seed + ":" + caseID))
	return float64(hasher.Sum32())/float64(uint64(1)<<32) < sampled.SampleRate
}

func evaluationMetadata[I, E any](
	suite EvaluationSuite[I, E],
	item EvaluationCase[I, E],
	duration time.Duration,
) EvaluationCaseMetadata {
	keys := make([]string, 0, len(item.Metadata))
	for key := range item.Metadata {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return EvaluationCaseMetadata{
		CaseID: item.ID, Route: item.Route, PromptVersion: item.PromptVersion,
		Model: suite.Model, PolicyFingerprint: suite.PolicyFingerprint,
		MetadataKeys: keys, Duration: duration,
	}
}

func RunEvaluation[I, O, E any](
	runner *EvaluationRunner,
	ctx context.Context,
	suite EvaluationSuite[I, E],
	subject EvaluationSubject[I],
) (EvaluationReport, error) {
	if err := validateEvaluationSuite(suite); err != nil {
		return EvaluationReport{}, err
	}
	evaluator, found := runner.Registry.get(suite.Evaluator)
	if !found {
		return EvaluationReport{}, errors.New("evaluator is not registered: " + suite.Evaluator)
	}
	results := make([]EvaluationCaseResult, len(suite.Cases))
	selected := make([]int, 0, len(suite.Cases))
	for index, item := range suite.Cases {
		if evaluationSampled(item.ID, suite.Mode) {
			selected = append(selected, index)
		} else {
			results[index] = SkippedEvaluationCase{
				EvaluationCaseMetadata: evaluationMetadata(suite, item, 0), Reason: "not-sampled",
			}
		}
	}
	jobs := make(chan int)
	var workers sync.WaitGroup
	workerCount := min(runner.MaxConcurrency, len(selected))
	for range workerCount {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				results[index] = runEvaluationCase[I, O, E](runner, ctx, suite, suite.Cases[index], subject, evaluator)
			}
		}()
	}
	for _, index := range selected {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	report := summarizeEvaluation(suite, results)
	if runner.ReportSink != nil {
		if err := runner.ReportSink.Write(ctx, report); err != nil {
			report.Delivery = EvaluationDeliveryFailed{Code: "report_sink_error"}
		} else {
			report.Delivery = EvaluationStored{}
		}
	}
	return report, nil
}

func runEvaluationCase[I, O, E any](
	runner *EvaluationRunner,
	ctx context.Context,
	suite EvaluationSuite[I, E],
	item EvaluationCase[I, E],
	subject EvaluationSubject[I],
	evaluator registeredEvaluator,
) EvaluationCaseResult {
	started := runner.Now()
	result := subject.Invoke(ctx, item.Input, EvaluationInvocationContext{
		CaseID: item.ID, Route: item.Route, PromptVersion: item.PromptVersion,
		Model: suite.Model, PolicyFingerprint: suite.PolicyFingerprint,
	})
	metadata := evaluationMetadata(suite, item, runner.Now().Sub(started))
	switch value := result.(type) {
	case ModelFailure:
		return ProviderFailureEvaluationCase{EvaluationCaseMetadata: metadata, FailureKind: string(value.Kind)}
	case ModelSuccess:
		score, err := evaluator.score(value.Value, item.Expected)
		if err != nil || math.IsNaN(score) || math.IsInf(score, 0) || score < 0 || score > 1 {
			return ScorerErrorEvaluationCase{EvaluationCaseMetadata: metadata}
		}
		return ScoredEvaluationCase{
			EvaluationCaseMetadata: metadata, Passed: score >= suite.Threshold, Score: score,
		}
	default:
		return ProviderFailureEvaluationCase{
			EvaluationCaseMetadata: metadata, FailureKind: "subject_error",
		}
	}
}

func summarizeEvaluation[I, E any](
	suite EvaluationSuite[I, E],
	results []EvaluationCaseResult,
) EvaluationReport {
	executed, passed, scored := 0, 0, 0
	totalScore := 0.0
	for _, result := range results {
		switch value := result.(type) {
		case ScoredEvaluationCase:
			executed++
			scored++
			totalScore += value.Score
			if value.Passed {
				passed++
			}
		case ProviderFailureEvaluationCase, ScorerErrorEvaluationCase:
			executed++
		}
	}
	passRate, meanScore := 0.0, 0.0
	if executed > 0 {
		passRate = float64(passed) / float64(executed)
	}
	if scored > 0 {
		meanScore = totalScore / float64(scored)
	}
	return EvaluationReport{
		SuiteID: suite.ID, SuiteVersion: suite.Version, Evaluator: suite.Evaluator,
		Model: suite.Model, PolicyFingerprint: suite.PolicyFingerprint, Results: results,
		Executed: executed, Passed: passed, Failed: executed - passed, Skipped: len(results) - executed,
		PassRate: passRate, MeanScore: meanScore, Delivery: EvaluationNotConfigured{},
	}
}

func validateEvaluationSuite[I, E any](suite EvaluationSuite[I, E]) error {
	if !evaluationIdentifier.MatchString(suite.ID) || suite.Version == "" || suite.Model == "" || suite.PolicyFingerprint == "" {
		return errors.New("evaluation suite reproducibility metadata is invalid")
	}
	if suite.Threshold < 0 || suite.Threshold > 1 || math.IsNaN(suite.Threshold) {
		return errors.New("evaluation threshold is invalid")
	}
	if sampled, ok := suite.Mode.(SampledOnlineEvaluation); ok &&
		(sampled.SampleRate < 0 || sampled.SampleRate > 1 || math.IsNaN(sampled.SampleRate)) {
		return errors.New("evaluation sample rate is invalid")
	}
	identifiers := make(map[string]struct{}, len(suite.Cases))
	for _, item := range suite.Cases {
		if !evaluationIdentifier.MatchString(item.ID) {
			return errors.New("evaluation case id is invalid")
		}
		if _, exists := identifiers[item.ID]; exists {
			return errors.New("duplicate evaluation case: " + item.ID)
		}
		identifiers[item.ID] = struct{}{}
	}
	return nil
}

type EvaluationBaseline struct {
	SuiteID      string
	SuiteVersion string
	PassRate     float64
	MeanScore    float64
}

type RegressionDecision interface{ regressionDecision() }
type EvaluationAccepted struct {
	PassRateDrop, MeanScoreDrop float64
}
type EvaluationRegressed struct {
	PassRateDrop, MeanScoreDrop float64
	Reasons                     []string
}

func (EvaluationAccepted) regressionDecision()  {}
func (EvaluationRegressed) regressionDecision() {}

func CompareEvaluationBaseline(
	report EvaluationReport,
	baseline EvaluationBaseline,
	maxPassRateDrop float64,
	maxMeanScoreDrop float64,
) (RegressionDecision, error) {
	if report.SuiteID != baseline.SuiteID {
		return nil, errors.New("baseline suite id does not match")
	}
	passDrop := max(0, baseline.PassRate-report.PassRate)
	scoreDrop := max(0, baseline.MeanScore-report.MeanScore)
	reasons := make([]string, 0, 2)
	if passDrop > maxPassRateDrop {
		reasons = append(reasons, "pass-rate")
	}
	if scoreDrop > maxMeanScoreDrop {
		reasons = append(reasons, "mean-score")
	}
	if len(reasons) == 0 {
		return EvaluationAccepted{PassRateDrop: passDrop, MeanScoreDrop: scoreDrop}, nil
	}
	return EvaluationRegressed{PassRateDrop: passDrop, MeanScoreDrop: scoreDrop, Reasons: reasons}, nil
}

func RecordEvaluationHumanFeedback(
	ctx context.Context,
	port HumanFeedbackPort,
	requestID string,
	score float64,
	note string,
) error {
	if score < -1 || score > 1 || math.IsNaN(score) {
		return errors.New("feedback score must be between minus one and one")
	}
	return port.Record(ctx, requestID, score, note)
}
`;

const evaluationTests = `package aiyokeruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
)

type evaluationSubject struct {
	mu            sync.Mutex
	active        int
	maximumActive int
	calls         int
}

func (subject *evaluationSubject) Invoke(
	_ context.Context,
	input string,
	_ EvaluationInvocationContext,
) ModelResult {
	subject.mu.Lock()
	subject.calls++
	subject.active++
	if subject.active > subject.maximumActive {
		subject.maximumActive = subject.active
	}
	subject.mu.Unlock()
	subject.mu.Lock()
	subject.active--
	subject.mu.Unlock()
	if input == "three" {
		return ModelFailure{Kind: FailureProvider, Message: "bad"}
	}
	value := "wrong"
	if input == "one" {
		value = "ONE"
	}
	return ModelSuccess{Value: value, Usage: Usage{}}
}

func evaluationSuite(mode EvaluationMode) EvaluationSuite[string, string] {
	return EvaluationSuite[string, string]{
		ID: "answers", Version: "v1", Evaluator: "exact", Threshold: 1,
		Mode: mode, Model: "test/model", PolicyFingerprint: "sha256:test",
		Cases: []EvaluationCase[string, string]{
			{ID: "one", Input: "one", Expected: "ONE", Route: "primary", PromptVersion: "p1"},
			{ID: "two", Input: "two", Expected: "TWO", Route: "primary", PromptVersion: "p1"},
			{ID: "three", Input: "three", Expected: "THREE", Route: "fallback", PromptVersion: "p1"},
		},
	}
}

func evaluationRegistry(t *testing.T) *EvaluatorRegistry {
	registry := NewEvaluatorRegistry()
	err := RegisterEvaluator(registry, EvaluatorDefinition[string, string]{
		ID: "exact",
		Score: func(actual string, expected string) (float64, error) {
			if actual == expected {
				return 1, nil
			}
			return 0, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func TestEvaluationRunnerOfflineAndSampling(t *testing.T) {
	runner, _ := NewEvaluationRunner(2, evaluationRegistry(t))
	subject := &evaluationSubject{}
	report, err := RunEvaluation[string, string, string](
		runner, context.Background(), evaluationSuite(OfflineEvaluation{}), subject,
	)
	if err != nil {
		t.Fatal(err)
	}
	if report.Executed != 3 || report.Passed != 1 || report.Failed != 2 {
		t.Fatalf("unexpected report: %#v", report)
	}
	sampledSubject := &evaluationSubject{}
	report, err = RunEvaluation[string, string, string](
		runner,
		context.Background(),
		evaluationSuite(SampledOnlineEvaluation{SampleRate: 0, Seed: "fixed"}),
		sampledSubject,
	)
	if err != nil || sampledSubject.calls != 0 || report.Skipped != 3 {
		t.Fatalf("unexpected sampled report: %#v %v", report, err)
	}
}

func TestEvaluationRegistryBaselineAndDuplicates(t *testing.T) {
	registry := evaluationRegistry(t)
	if err := RegisterEvaluator(registry, EvaluatorDefinition[string, string]{
		ID: "exact", Score: func(string, string) (float64, error) { return 1, nil },
	}); err == nil {
		t.Fatal("expected duplicate evaluator failure")
	}
	runner, _ := NewEvaluationRunner(1, registry)
	suite := evaluationSuite(OfflineEvaluation{})
	suite.Cases = append(suite.Cases, suite.Cases[0])
	if _, err := RunEvaluation[string, string, string](
		runner, context.Background(), suite, &evaluationSubject{},
	); err == nil {
		t.Fatal("expected duplicate case failure")
	}
	decision, err := CompareEvaluationBaseline(
		EvaluationReport{SuiteID: "answers", PassRate: 0.5, MeanScore: 0.4},
		EvaluationBaseline{SuiteID: "answers", PassRate: 0.9, MeanScore: 0.8},
		0.1,
		0.1,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := decision.(EvaluationRegressed); !ok {
		t.Fatalf("expected regression, got %#v", decision)
	}
}

type failingFeedback struct{}

func (failingFeedback) Record(context.Context, string, float64, string) error {
	return errors.New("store unavailable")
}

func TestEvaluationFeedbackValidation(t *testing.T) {
	if err := RecordEvaluationHumanFeedback(
		context.Background(), failingFeedback{}, "request-1", 2, "bad",
	); err == nil {
		t.Fatal("expected invalid feedback score")
	}
}
`;

export const goRuntimeModules: readonly RuntimeModuleDefinition[] = [
  {
    id: "tooling",
    description: "Registered, guarded, approval-aware tool execution.",
    artifacts: [
      { path: "tooling.go", source: tooling },
      { path: "tooling_test.go", source: toolingTests }
    ]
  },
  {
    id: "evaluation",
    description: "Versioned offline and sampled-online evaluation runner.",
    artifacts: [
      { path: "evaluation.go", source: evaluation },
      { path: "evaluation_test.go", source: evaluationTests }
    ]
  }
];
