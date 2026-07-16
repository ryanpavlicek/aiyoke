import type { RuntimeModuleDefinition } from "../shared.js";

const tooling = `use crate::runtime::CancellationToken;
use std::any::Any;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

pub enum ToolValidation<T> {
    Valid(T),
    Invalid { code: String },
}

#[derive(Clone, Debug)]
pub enum ToolApprovalPolicy {
    None,
    Required { reason: String },
}

pub enum ToolOutputPolicy<O> {
    Unchecked,
    Validate(Arc<dyn Fn(&O) -> ToolValidation<()> + Send + Sync>),
}

#[derive(Clone, Debug)]
pub struct ModelCorrelation {
    pub request_id: String,
    pub prompt_version: String,
}

#[derive(Clone)]
pub struct ToolInvocationContext {
    pub request_id: String,
    pub correlation: Option<ModelCorrelation>,
    pub cancellation: CancellationToken,
    pub deadline: Instant,
}

pub struct ToolDefinition<I, O> {
    pub name: String,
    pub description: String,
    pub approval: ToolApprovalPolicy,
    pub output: ToolOutputPolicy<O>,
    pub validate_input: Arc<dyn Fn(&dyn Any) -> ToolValidation<I> + Send + Sync>,
    pub invoke: Arc<dyn Fn(I, ToolInvocationContext) -> Result<O, String> + Send + Sync>,
}

trait ErasedTool: Send + Sync {
    fn approval(&self) -> &ToolApprovalPolicy;
    fn validate_input(&self, value: &dyn Any) -> Result<Box<dyn Any + Send>, String>;
    fn invoke(
        &self,
        input: Box<dyn Any + Send>,
        context: ToolInvocationContext,
    ) -> Result<Box<dyn Any + Send>, ()>;
    fn validate_output(&self, value: &dyn Any) -> Result<(), String>;
}

struct RegisteredTool<I, O> {
    definition: ToolDefinition<I, O>,
}

impl<I, O> ErasedTool for RegisteredTool<I, O>
where
    I: Send + 'static,
    O: Send + 'static,
{
    fn approval(&self) -> &ToolApprovalPolicy {
        &self.definition.approval
    }

    fn validate_input(&self, value: &dyn Any) -> Result<Box<dyn Any + Send>, String> {
        match (self.definition.validate_input)(value) {
            ToolValidation::Valid(value) => Ok(Box::new(value)),
            ToolValidation::Invalid { code } => Err(code),
        }
    }

    fn invoke(
        &self,
        input: Box<dyn Any + Send>,
        context: ToolInvocationContext,
    ) -> Result<Box<dyn Any + Send>, ()> {
        let Ok(input) = input.downcast::<I>() else {
            return Err(());
        };
        (self.definition.invoke)(*input, context)
            .map(|value| Box::new(value) as Box<dyn Any + Send>)
            .map_err(|_| ())
    }

    fn validate_output(&self, value: &dyn Any) -> Result<(), String> {
        let Some(output) = value.downcast_ref::<O>() else {
            return Err("output_type".to_owned());
        };
        match &self.definition.output {
            ToolOutputPolicy::Unchecked => Ok(()),
            ToolOutputPolicy::Validate(validate) => match validate(output) {
                ToolValidation::Valid(()) => Ok(()),
                ToolValidation::Invalid { code } => Err(code),
            },
        }
    }
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn ErasedTool>>,
}

impl ToolRegistry {
    pub fn register<I, O>(&mut self, definition: ToolDefinition<I, O>) -> Result<(), String>
    where
        I: Send + 'static,
        O: Send + 'static,
    {
        if !valid_identifier(&definition.name) {
            return Err("tool name is invalid".to_owned());
        }
        if definition.description.trim().is_empty() {
            return Err("tool description must not be empty".to_owned());
        }
        if self.tools.contains_key(&definition.name) {
            return Err("tool already registered: ".to_owned() + &definition.name);
        }
        if let ToolApprovalPolicy::Required { reason } = &definition.approval {
            if reason.trim().is_empty() {
                return Err("approval reason must not be empty".to_owned());
            }
        }
        self.tools.insert(
            definition.name.clone(),
            Arc::new(RegisteredTool { definition }),
        );
        Ok(())
    }

    pub fn names(&self) -> Vec<String> {
        self.tools.keys().cloned().collect()
    }
}

fn valid_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some('a'..='z'))
        && value.len() <= 64
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

pub struct ToolExecutionRequest {
    pub request_id: String,
    pub tool: String,
    pub input: Box<dyn Any + Send + Sync>,
    pub timeout: Option<Duration>,
    pub metadata: BTreeMap<String, String>,
    pub correlation: Option<ModelCorrelation>,
}

#[derive(Clone, Debug)]
pub struct ToolApprovalRequest {
    pub request_id: String,
    pub tool: String,
    pub metadata_keys: Vec<String>,
    pub correlation_id: Option<String>,
}

pub trait ToolApprovalPort: Send + Sync {
    fn approve(&self, request: &ToolApprovalRequest, reason: &str) -> Result<bool, String>;
}

#[derive(Clone, Debug)]
pub struct ToolEvent {
    pub event_type: String,
    pub request_id: String,
    pub tool: String,
    pub occurred_at: Instant,
    pub metadata_keys: Vec<String>,
    pub correlation_id: Option<String>,
}

pub trait ToolEventSink: Send + Sync {
    fn emit(&self, event: &ToolEvent) -> Result<(), String>;
}

pub enum ToolExecutionResult {
    Success {
        value: Box<dyn Any + Send>,
        duration: Duration,
    },
    Failure(ToolFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolFailure {
    pub kind: String,
    pub phase: String,
    pub message: String,
    pub code: Option<String>,
    pub retryable: bool,
}

pub struct ToolRunner {
    pub registry: Arc<ToolRegistry>,
    pub default_timeout: Duration,
    pub max_timeout: Duration,
    pub approval: Option<Arc<dyn ToolApprovalPort>>,
    pub events: Option<Arc<dyn ToolEventSink>>,
    pub now: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl ToolRunner {
    pub fn new(
        registry: Arc<ToolRegistry>,
        default_timeout: Duration,
        max_timeout: Duration,
    ) -> Result<Self, String> {
        if default_timeout.is_zero() || max_timeout < default_timeout {
            return Err("tool timeout bounds are invalid".to_owned());
        }
        Ok(Self {
            registry,
            default_timeout,
            max_timeout,
            approval: None,
            events: None,
            now: Arc::new(Instant::now),
        })
    }

    fn emit(&self, request: &ToolExecutionRequest, event_type: &str) {
        let Some(events) = &self.events else {
            return;
        };
        let event = ToolEvent {
            event_type: event_type.to_owned(),
            request_id: request.request_id.clone(),
            tool: request.tool.clone(),
            occurred_at: (self.now)(),
            metadata_keys: request.metadata.keys().cloned().collect(),
            correlation_id: request
                .correlation
                .as_ref()
                .map(|correlation| correlation.request_id.clone()),
        };
        let _ = events.emit(&event);
    }

    fn failure(
        &self,
        request: &ToolExecutionRequest,
        kind: &str,
        phase: &str,
        message: &str,
        code: Option<&str>,
    ) -> ToolExecutionResult {
        self.emit(request, "tool-failed");
        ToolExecutionResult::Failure(ToolFailure {
            kind: kind.to_owned(),
            phase: phase.to_owned(),
            message: message.to_owned(),
            code: code.map(|value| {
                if valid_identifier(value) {
                    value.to_owned()
                } else {
                    "validation_failed".to_owned()
                }
            }),
            retryable: false,
        })
    }

    pub fn execute(
        &self,
        request: ToolExecutionRequest,
        parent_cancellation: Option<&CancellationToken>,
    ) -> ToolExecutionResult {
        let started = (self.now)();
        self.emit(&request, "tool-started");
        let Some(tool) = self.registry.tools.get(&request.tool).cloned() else {
            return self.failure(
                &request,
                "not-found",
                "lookup",
                "The tool is not registered.",
                None,
            );
        };
        let validated = catch_unwind(AssertUnwindSafe(|| {
            tool.validate_input(request.input.as_ref())
        }));
        let input = match validated {
            Ok(Ok(value)) => value,
            Ok(Err(code)) => {
                return self.failure(
                    &request,
                    "invalid-input",
                    "input",
                    "Tool input validation failed.",
                    Some(&code),
                )
            }
            Err(_) => {
                return self.failure(
                    &request,
                    "invalid-input",
                    "input",
                    "Tool input validation failed.",
                    Some("validator_error"),
                )
            }
        };
        if let ToolApprovalPolicy::Required { reason } = tool.approval() {
            self.emit(&request, "approval-requested");
            let Some(approval) = &self.approval else {
                return self.failure(
                    &request,
                    "approval-required",
                    "approval",
                    "A tool approval port is required.",
                    None,
                );
            };
            let approval_request = ToolApprovalRequest {
                request_id: request.request_id.clone(),
                tool: request.tool.clone(),
                metadata_keys: request.metadata.keys().cloned().collect(),
                correlation_id: request
                    .correlation
                    .as_ref()
                    .map(|correlation| correlation.request_id.clone()),
            };
            match approval.approve(&approval_request, reason) {
                Ok(true) => {}
                Ok(false) => {
                    return self.failure(
                        &request,
                        "approval-denied",
                        "approval",
                        "The tool execution was not approved.",
                        None,
                    )
                }
                Err(_) => {
                    return self.failure(
                        &request,
                        "approval-failed",
                        "approval",
                        "The approval decision could not be obtained.",
                        None,
                    )
                }
            }
        }
        let timeout = request
            .timeout
            .unwrap_or(self.default_timeout)
            .min(self.max_timeout);
        let cancellation = CancellationToken::default();
        let deadline = Instant::now() + timeout;
        let invocation = ToolInvocationContext {
            request_id: request.request_id.clone(),
            correlation: request.correlation.clone(),
            cancellation: cancellation.clone(),
            deadline,
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        let invocation_tool = Arc::clone(&tool);
        thread::spawn(move || {
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                invocation_tool.invoke(input, invocation)
            }))
            .map_err(|_| ())
            .and_then(|value| value);
            let _ = sender.send(outcome);
        });
        loop {
            if parent_cancellation.is_some_and(CancellationToken::is_cancelled) {
                cancellation.cancel();
                return self.failure(
                    &request,
                    "cancelled",
                    "execution",
                    "The tool execution was cancelled.",
                    None,
                );
            }
            let now = Instant::now();
            if now >= deadline {
                cancellation.cancel();
                return self.failure(
                    &request,
                    "timeout",
                    "execution",
                    "The tool execution deadline expired.",
                    None,
                );
            }
            let wait = (deadline - now).min(Duration::from_millis(5));
            match receiver.recv_timeout(wait) {
                Ok(Ok(output)) => {
                    match catch_unwind(AssertUnwindSafe(|| tool.validate_output(output.as_ref()))) {
                        Ok(Ok(())) => {
                            self.emit(&request, "tool-succeeded");
                            return ToolExecutionResult::Success {
                                value: output,
                                duration: (self.now)().saturating_duration_since(started),
                            };
                        }
                        Ok(Err(code)) => {
                            return self.failure(
                                &request,
                                "invalid-output",
                                "output",
                                "Tool output validation failed.",
                                Some(&code),
                            )
                        }
                        Err(_) => {
                            return self.failure(
                                &request,
                                "invalid-output",
                                "output",
                                "Tool output validation failed.",
                                Some("validator_error"),
                            )
                        }
                    }
                }
                Ok(Err(())) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return self.failure(
                        &request,
                        "handler-error",
                        "execution",
                        "The tool handler failed.",
                        None,
                    )
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
}
`;

const toolingTests = `#[path = "runtime.rs"]
mod runtime;
#[path = "tooling.rs"]
mod tooling;

use std::any::Any;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tooling::*;

fn number_tool() -> ToolDefinition<i64, i64> {
    ToolDefinition {
        name: "math.double".to_owned(),
        description: "Doubles a number.".to_owned(),
        approval: ToolApprovalPolicy::None,
        output: ToolOutputPolicy::Validate(Arc::new(|value| {
            if *value >= 0 {
                ToolValidation::Valid(())
            } else {
                ToolValidation::Invalid {
                    code: "negative".to_owned(),
                }
            }
        })),
        validate_input: Arc::new(|value: &dyn Any| match value.downcast_ref::<i64>() {
            Some(value) => ToolValidation::Valid(*value),
            None => ToolValidation::Invalid {
                code: "not_number".to_owned(),
            },
        }),
        invoke: Arc::new(|value, _| Ok(value * 2)),
    }
}

fn request(input: Box<dyn Any + Send + Sync>) -> ToolExecutionRequest {
    ToolExecutionRequest {
        request_id: "tool-1".to_owned(),
        tool: "math.double".to_owned(),
        input,
        timeout: None,
        metadata: BTreeMap::from([
            ("tenant".to_owned(), "one".to_owned()),
            ("secret".to_owned(), "must-not-be-emitted".to_owned()),
        ]),
        correlation: None,
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<ToolEvent>>);

impl ToolEventSink for Events {
    fn emit(&self, event: &ToolEvent) -> Result<(), String> {
        self.0.lock().unwrap().push(event.clone());
        Ok(())
    }
}

#[test]
fn executes_registered_tool_without_logging_values() {
    let mut registry = ToolRegistry::default();
    registry.register(number_tool()).unwrap();
    assert!(registry.register(number_tool()).is_err());
    let events = Arc::new(Events::default());
    let mut runner = ToolRunner::new(
        Arc::new(registry),
        Duration::from_millis(100),
        Duration::from_secs(1),
    )
    .unwrap();
    runner.events = Some(events.clone());
    let fixed = Instant::now();
    runner.now = Arc::new(move || fixed);
    match runner.execute(request(Box::new(3_i64)), None) {
        ToolExecutionResult::Success { value, duration } => {
            assert_eq!(*value.downcast::<i64>().unwrap(), 6);
            assert_eq!(duration, Duration::ZERO);
        }
        ToolExecutionResult::Failure(failure) => panic!("unexpected failure: {}", failure.kind),
    }
    assert!(!format!("{:?}", events.0.lock().unwrap()).contains("must-not-be-emitted"));
}

#[test]
fn validation_approval_and_timeout_fail_closed() {
    let mut registry = ToolRegistry::default();
    registry.register(number_tool()).unwrap();
    let runner = ToolRunner::new(
        Arc::new(registry),
        Duration::from_millis(10),
        Duration::from_millis(10),
    )
    .unwrap();
    let failure = match runner.execute(request(Box::new("secret input".to_owned())), None) {
        ToolExecutionResult::Failure(failure) => failure,
        ToolExecutionResult::Success { .. } => panic!("expected invalid input"),
    };
    assert_eq!(failure.kind, "invalid-input");
    assert!(!format!("{:?}", failure).contains("secret input"));

    let mut approval_registry = ToolRegistry::default();
    let mut approval_tool = number_tool();
    approval_tool.approval = ToolApprovalPolicy::Required {
        reason: "Changes external state.".to_owned(),
    };
    approval_registry.register(approval_tool).unwrap();
    let approval_runner = ToolRunner::new(
        Arc::new(approval_registry),
        Duration::from_millis(10),
        Duration::from_millis(10),
    )
    .unwrap();
    let failure = match approval_runner.execute(request(Box::new(3_i64)), None) {
        ToolExecutionResult::Failure(failure) => failure,
        ToolExecutionResult::Success { .. } => panic!("expected approval failure"),
    };
    assert_eq!(failure.kind, "approval-required");

    let mut slow_registry = ToolRegistry::default();
    let mut slow = number_tool();
    slow.invoke = Arc::new(|value, context| {
        while !context.cancellation.is_cancelled() {
            std::thread::yield_now();
        }
        Ok(value)
    });
    slow_registry.register(slow).unwrap();
    let slow_runner = ToolRunner::new(
        Arc::new(slow_registry),
        Duration::from_millis(1),
        Duration::from_millis(1),
    )
    .unwrap();
    let failure = match slow_runner.execute(request(Box::new(3_i64)), None) {
        ToolExecutionResult::Failure(failure) => failure,
        ToolExecutionResult::Success { .. } => panic!("expected timeout"),
    };
    assert_eq!(failure.kind, "timeout");
}
`;

const evaluation = `use crate::runtime::{CancellationToken, HumanFeedbackPort, ModelResult};
use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub enum EvaluationMode {
    Offline,
    SampledOnline { sample_rate: f64, seed: String },
}

#[derive(Clone, Debug)]
pub struct EvaluationCase<I, E> {
    pub id: String,
    pub input: I,
    pub expected: E,
    pub route: String,
    pub prompt_version: String,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct EvaluationSuite<I, E> {
    pub id: String,
    pub version: String,
    pub evaluator: String,
    pub threshold: f64,
    pub mode: EvaluationMode,
    pub model: String,
    pub policy_fingerprint: String,
    pub cases: Vec<EvaluationCase<I, E>>,
}

#[derive(Clone, Debug)]
pub struct EvaluationInvocationContext {
    pub case_id: String,
    pub route: String,
    pub prompt_version: String,
    pub model: String,
    pub policy_fingerprint: String,
}

pub trait EvaluationSubject<I, O>: Send + Sync {
    fn invoke(&self, input: &I, context: &EvaluationInvocationContext) -> ModelResult<O>;
}

pub struct EvaluatorDefinition<O, E> {
    pub id: String,
    pub score: Arc<dyn Fn(&O, &E) -> Result<f64, String> + Send + Sync>,
}

trait ErasedEvaluator: Send + Sync {
    fn score(&self, actual: &dyn Any, expected: &dyn Any) -> Result<f64, String>;
}

struct RegisteredEvaluator<O, E> {
    definition: EvaluatorDefinition<O, E>,
}

impl<O, E> ErasedEvaluator for RegisteredEvaluator<O, E>
where
    O: 'static,
    E: 'static,
{
    fn score(&self, actual: &dyn Any, expected: &dyn Any) -> Result<f64, String> {
        let actual = actual
            .downcast_ref::<O>()
            .ok_or_else(|| "evaluator actual type mismatch".to_owned())?;
        let expected = expected
            .downcast_ref::<E>()
            .ok_or_else(|| "evaluator expected type mismatch".to_owned())?;
        (self.definition.score)(actual, expected)
    }
}

#[derive(Default)]
pub struct EvaluatorRegistry {
    evaluators: BTreeMap<String, Arc<dyn ErasedEvaluator>>,
}

impl EvaluatorRegistry {
    pub fn register<O, E>(&mut self, definition: EvaluatorDefinition<O, E>) -> Result<(), String>
    where
        O: 'static,
        E: 'static,
    {
        if !valid_identifier(&definition.id) {
            return Err("evaluator id is invalid".to_owned());
        }
        if self.evaluators.contains_key(&definition.id) {
            return Err("evaluator already registered: ".to_owned() + &definition.id);
        }
        self.evaluators.insert(
            definition.id.clone(),
            Arc::new(RegisteredEvaluator { definition }),
        );
        Ok(())
    }
}

fn valid_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some('a'..='z'))
        && value.len() <= 64
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

#[derive(Clone, Debug)]
pub struct EvaluationCaseMetadata {
    pub case_id: String,
    pub route: String,
    pub prompt_version: String,
    pub model: String,
    pub policy_fingerprint: String,
    pub metadata_keys: Vec<String>,
    pub duration: Duration,
}

#[derive(Clone, Debug)]
pub enum EvaluationCaseResult {
    Scored {
        metadata: EvaluationCaseMetadata,
        passed: bool,
        score: f64,
    },
    ProviderFailure {
        metadata: EvaluationCaseMetadata,
        failure_kind: String,
    },
    ScorerError {
        metadata: EvaluationCaseMetadata,
    },
    Skipped {
        metadata: EvaluationCaseMetadata,
        reason: String,
    },
}

#[derive(Clone, Debug)]
pub enum EvaluationDelivery {
    NotConfigured,
    Stored,
    Failed { code: String },
}

#[derive(Clone, Debug)]
pub struct EvaluationReport {
    pub suite_id: String,
    pub suite_version: String,
    pub evaluator: String,
    pub model: String,
    pub policy_fingerprint: String,
    pub results: Vec<EvaluationCaseResult>,
    pub executed: usize,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub pass_rate: f64,
    pub mean_score: f64,
    pub delivery: EvaluationDelivery,
}

pub trait EvaluationReportSink: Send + Sync {
    fn write(&self, report: &EvaluationReport) -> Result<(), String>;
}

pub struct EvaluationRunner {
    pub max_concurrency: usize,
    pub registry: Arc<EvaluatorRegistry>,
    pub report_sink: Option<Arc<dyn EvaluationReportSink>>,
    pub now: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl EvaluationRunner {
    pub fn new(max_concurrency: usize, registry: Arc<EvaluatorRegistry>) -> Result<Self, String> {
        if max_concurrency == 0 {
            return Err("max concurrency must be positive".to_owned());
        }
        Ok(Self {
            max_concurrency,
            registry,
            report_sink: None,
            now: Arc::new(Instant::now),
        })
    }

    pub fn run<I, O, E>(
        &self,
        suite: &EvaluationSuite<I, E>,
        subject: &dyn EvaluationSubject<I, O>,
        cancellation: &CancellationToken,
    ) -> Result<EvaluationReport, String>
    where
        I: Clone + Send + Sync,
        O: Send + Sync + 'static,
        E: Clone + Send + Sync + 'static,
    {
        validate_suite(suite)?;
        let evaluator = self
            .registry
            .evaluators
            .get(&suite.evaluator)
            .cloned()
            .ok_or_else(|| "evaluator is not registered: ".to_owned() + &suite.evaluator)?;
        let results = Arc::new(Mutex::new(vec![None; suite.cases.len()]));
        let selected: Vec<usize> = suite
            .cases
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                if sampled(&item.id, &suite.mode) {
                    Some(index)
                } else {
                    results.lock().unwrap()[index] = Some(EvaluationCaseResult::Skipped {
                        metadata: metadata(suite, item, Duration::ZERO),
                        reason: "not-sampled".to_owned(),
                    });
                    None
                }
            })
            .collect();
        let cursor = AtomicUsize::new(0);
        thread::scope(|scope| {
            for _ in 0..self.max_concurrency.min(selected.len()) {
                let results = Arc::clone(&results);
                let evaluator = Arc::clone(&evaluator);
                let selected = &selected;
                let cursor = &cursor;
                let now = Arc::clone(&self.now);
                scope.spawn(move || loop {
                    let position = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some(index) = selected.get(position).copied() else {
                        break;
                    };
                    let item = &suite.cases[index];
                    if cancellation.is_cancelled() {
                        results.lock().unwrap()[index] = Some(EvaluationCaseResult::Skipped {
                            metadata: metadata(suite, item, Duration::ZERO),
                            reason: "cancelled".to_owned(),
                        });
                        continue;
                    }
                    let started = now();
                    let context = EvaluationInvocationContext {
                        case_id: item.id.clone(),
                        route: item.route.clone(),
                        prompt_version: item.prompt_version.clone(),
                        model: suite.model.clone(),
                        policy_fingerprint: suite.policy_fingerprint.clone(),
                    };
                    let result =
                        catch_unwind(AssertUnwindSafe(|| subject.invoke(&item.input, &context)));
                    let case_result = match result {
                        Ok(ModelResult::Success { value, .. }) => {
                            match catch_unwind(AssertUnwindSafe(|| {
                                evaluator.score(&value, &item.expected)
                            })) {
                                Ok(Ok(score))
                                    if score.is_finite() && (0.0..=1.0).contains(&score) =>
                                {
                                    EvaluationCaseResult::Scored {
                                        metadata: metadata(
                                            suite,
                                            item,
                                            now().saturating_duration_since(started),
                                        ),
                                        passed: score >= suite.threshold,
                                        score,
                                    }
                                }
                                _ => EvaluationCaseResult::ScorerError {
                                    metadata: metadata(
                                        suite,
                                        item,
                                        now().saturating_duration_since(started),
                                    ),
                                },
                            }
                        }
                        Ok(ModelResult::Failure(failure)) => {
                            EvaluationCaseResult::ProviderFailure {
                                metadata: metadata(
                                    suite,
                                    item,
                                    now().saturating_duration_since(started),
                                ),
                                failure_kind: format!("{:?}", failure.kind),
                            }
                        }
                        Err(_) => EvaluationCaseResult::ProviderFailure {
                            metadata: metadata(
                                suite,
                                item,
                                now().saturating_duration_since(started),
                            ),
                            failure_kind: "subject_error".to_owned(),
                        },
                    };
                    results.lock().unwrap()[index] = Some(case_result);
                });
            }
        });
        let mut ordered = Vec::with_capacity(suite.cases.len());
        for (index, result) in results.lock().unwrap().iter_mut().enumerate() {
            ordered.push(
                result
                    .take()
                    .unwrap_or_else(|| EvaluationCaseResult::Skipped {
                        metadata: metadata(suite, &suite.cases[index], Duration::ZERO),
                        reason: "cancelled".to_owned(),
                    }),
            );
        }
        let mut report = summarize(suite, ordered);
        if let Some(sink) = &self.report_sink {
            report.delivery = match sink.write(&report) {
                Ok(()) => EvaluationDelivery::Stored,
                Err(_) => EvaluationDelivery::Failed {
                    code: "report_sink_error".to_owned(),
                },
            };
        }
        Ok(report)
    }
}

fn sampled(case_id: &str, mode: &EvaluationMode) -> bool {
    let EvaluationMode::SampledOnline { sample_rate, seed } = mode else {
        return true;
    };
    let mut hash = 2_166_136_261_u32;
    for byte in (seed.to_owned() + ":" + case_id).bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    f64::from(hash) / 4_294_967_296.0 < *sample_rate
}

fn metadata<I, E>(
    suite: &EvaluationSuite<I, E>,
    item: &EvaluationCase<I, E>,
    duration: Duration,
) -> EvaluationCaseMetadata {
    EvaluationCaseMetadata {
        case_id: item.id.clone(),
        route: item.route.clone(),
        prompt_version: item.prompt_version.clone(),
        model: suite.model.clone(),
        policy_fingerprint: suite.policy_fingerprint.clone(),
        metadata_keys: item.metadata.keys().cloned().collect(),
        duration,
    }
}

fn summarize<I, E>(
    suite: &EvaluationSuite<I, E>,
    results: Vec<EvaluationCaseResult>,
) -> EvaluationReport {
    let mut executed = 0;
    let mut passed = 0;
    let mut scores = Vec::new();
    for result in &results {
        match result {
            EvaluationCaseResult::Scored {
                passed: case_passed,
                score,
                ..
            } => {
                executed += 1;
                passed += usize::from(*case_passed);
                scores.push(*score);
            }
            EvaluationCaseResult::ProviderFailure { .. }
            | EvaluationCaseResult::ScorerError { .. } => executed += 1,
            EvaluationCaseResult::Skipped { .. } => {}
        }
    }
    EvaluationReport {
        suite_id: suite.id.clone(),
        suite_version: suite.version.clone(),
        evaluator: suite.evaluator.clone(),
        model: suite.model.clone(),
        policy_fingerprint: suite.policy_fingerprint.clone(),
        executed,
        passed,
        failed: executed - passed,
        skipped: results.len() - executed,
        pass_rate: if executed == 0 {
            0.0
        } else {
            passed as f64 / executed as f64
        },
        mean_score: if scores.is_empty() {
            0.0
        } else {
            scores.iter().sum::<f64>() / scores.len() as f64
        },
        results,
        delivery: EvaluationDelivery::NotConfigured,
    }
}

fn validate_suite<I, E>(suite: &EvaluationSuite<I, E>) -> Result<(), String> {
    if !valid_identifier(&suite.id)
        || suite.version.trim().is_empty()
        || suite.model.trim().is_empty()
        || suite.policy_fingerprint.trim().is_empty()
    {
        return Err("evaluation suite reproducibility metadata is invalid".to_owned());
    }
    if !suite.threshold.is_finite() || !(0.0..=1.0).contains(&suite.threshold) {
        return Err("evaluation threshold is invalid".to_owned());
    }
    if let EvaluationMode::SampledOnline { sample_rate, .. } = &suite.mode {
        if !sample_rate.is_finite() || !(0.0..=1.0).contains(sample_rate) {
            return Err("evaluation sample rate is invalid".to_owned());
        }
    }
    let mut identifiers = BTreeSet::new();
    for item in &suite.cases {
        if !valid_identifier(&item.id) {
            return Err("evaluation case id is invalid".to_owned());
        }
        if !identifiers.insert(&item.id) {
            return Err("duplicate evaluation case: ".to_owned() + &item.id);
        }
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct EvaluationBaseline {
    pub suite_id: String,
    pub suite_version: String,
    pub pass_rate: f64,
    pub mean_score: f64,
}

#[derive(Clone, Debug)]
pub enum RegressionDecision {
    Accepted {
        pass_rate_drop: f64,
        mean_score_drop: f64,
    },
    Regressed {
        pass_rate_drop: f64,
        mean_score_drop: f64,
        reasons: Vec<String>,
    },
}

pub fn compare_baseline(
    report: &EvaluationReport,
    baseline: &EvaluationBaseline,
    max_pass_rate_drop: f64,
    max_mean_score_drop: f64,
) -> Result<RegressionDecision, String> {
    if report.suite_id != baseline.suite_id {
        return Err("baseline suite id does not match".to_owned());
    }
    let pass_rate_drop = (baseline.pass_rate - report.pass_rate).max(0.0);
    let mean_score_drop = (baseline.mean_score - report.mean_score).max(0.0);
    let mut reasons = Vec::new();
    if pass_rate_drop > max_pass_rate_drop {
        reasons.push("pass-rate".to_owned());
    }
    if mean_score_drop > max_mean_score_drop {
        reasons.push("mean-score".to_owned());
    }
    if reasons.is_empty() {
        Ok(RegressionDecision::Accepted {
            pass_rate_drop,
            mean_score_drop,
        })
    } else {
        Ok(RegressionDecision::Regressed {
            pass_rate_drop,
            mean_score_drop,
            reasons,
        })
    }
}

pub fn record_human_feedback(
    port: &dyn HumanFeedbackPort,
    request_id: &str,
    score: f64,
    note: Option<&str>,
) -> Result<(), String> {
    if !score.is_finite() || !(-1.0..=1.0).contains(&score) {
        return Err("feedback score must be between minus one and one".to_owned());
    }
    port.record(request_id, score, note)
}
`;

const evaluationTests = `#[path = "evaluation.rs"]
mod evaluation;
#[path = "runtime.rs"]
mod runtime;

use evaluation::*;
use runtime::{CancellationToken, FailureKind, ModelFailure, ModelResult, Usage};
use std::collections::BTreeMap;
use std::sync::Arc;

struct Subject;

impl EvaluationSubject<String, String> for Subject {
    fn invoke(
        &self,
        input: &String,
        _context: &EvaluationInvocationContext,
    ) -> ModelResult<String> {
        if input == "three" {
            ModelResult::Failure(ModelFailure {
                kind: FailureKind::Provider,
                message: "bad".to_owned(),
                retryable: false,
                provider_code: None,
            })
        } else {
            ModelResult::Success {
                value: if input == "one" {
                    "ONE".to_owned()
                } else {
                    "wrong".to_owned()
                },
                usage: Usage::default(),
            }
        }
    }
}

fn registry() -> Arc<EvaluatorRegistry> {
    let mut registry = EvaluatorRegistry::default();
    registry
        .register(EvaluatorDefinition::<String, String> {
            id: "exact".to_owned(),
            score: Arc::new(|actual, expected| Ok(if actual == expected { 1.0 } else { 0.0 })),
        })
        .unwrap();
    Arc::new(registry)
}

fn suite(mode: EvaluationMode) -> EvaluationSuite<String, String> {
    EvaluationSuite {
        id: "answers".to_owned(),
        version: "v1".to_owned(),
        evaluator: "exact".to_owned(),
        threshold: 1.0,
        mode,
        model: "test/model".to_owned(),
        policy_fingerprint: "sha256:test".to_owned(),
        cases: vec![
            EvaluationCase {
                id: "one".to_owned(),
                input: "one".to_owned(),
                expected: "ONE".to_owned(),
                route: "primary".to_owned(),
                prompt_version: "p1".to_owned(),
                metadata: BTreeMap::new(),
            },
            EvaluationCase {
                id: "two".to_owned(),
                input: "two".to_owned(),
                expected: "TWO".to_owned(),
                route: "primary".to_owned(),
                prompt_version: "p1".to_owned(),
                metadata: BTreeMap::new(),
            },
            EvaluationCase {
                id: "three".to_owned(),
                input: "three".to_owned(),
                expected: "THREE".to_owned(),
                route: "fallback".to_owned(),
                prompt_version: "p1".to_owned(),
                metadata: BTreeMap::new(),
            },
        ],
    }
}

#[test]
fn runs_offline_and_deterministic_sampling() {
    let runner = EvaluationRunner::new(2, registry()).unwrap();
    let report = runner
        .run(
            &suite(EvaluationMode::Offline),
            &Subject,
            &CancellationToken::default(),
        )
        .unwrap();
    assert_eq!((report.executed, report.passed, report.failed), (3, 1, 2));
    let sampled = runner
        .run(
            &suite(EvaluationMode::SampledOnline {
                sample_rate: 0.0,
                seed: "fixed".to_owned(),
            }),
            &Subject,
            &CancellationToken::default(),
        )
        .unwrap();
    assert_eq!((sampled.executed, sampled.skipped), (0, 3));
}

#[test]
fn rejects_duplicates_and_detects_regression() {
    let runner = EvaluationRunner::new(1, registry()).unwrap();
    let mut duplicate = suite(EvaluationMode::Offline);
    duplicate.cases.push(duplicate.cases[0].clone());
    assert!(runner
        .run(&duplicate, &Subject, &CancellationToken::default())
        .is_err());
    let report = EvaluationReport {
        suite_id: "answers".to_owned(),
        suite_version: "v2".to_owned(),
        evaluator: "exact".to_owned(),
        model: "test/model".to_owned(),
        policy_fingerprint: "sha256:test".to_owned(),
        results: Vec::new(),
        executed: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        pass_rate: 0.5,
        mean_score: 0.4,
        delivery: EvaluationDelivery::NotConfigured,
    };
    let decision = compare_baseline(
        &report,
        &EvaluationBaseline {
            suite_id: "answers".to_owned(),
            suite_version: "v1".to_owned(),
            pass_rate: 0.9,
            mean_score: 0.8,
        },
        0.1,
        0.1,
    )
    .unwrap();
    assert!(matches!(decision, RegressionDecision::Regressed { .. }));
}
`;

export const rustRuntimeModules: readonly RuntimeModuleDefinition[] = [
  {
    id: "tooling",
    description: "Registered, guarded, approval-aware tool execution.",
    artifacts: [
      { path: "tooling.rs", source: tooling },
      { path: "tooling_test.rs", source: toolingTests }
    ]
  },
  {
    id: "evaluation",
    description: "Versioned offline and sampled-online evaluation runner.",
    artifacts: [
      { path: "evaluation.rs", source: evaluation },
      { path: "evaluation_test.rs", source: evaluationTests }
    ]
  }
];
