import { rustIntegrations } from "./integrations/rust.js";
import { rustRuntimeModules } from "./modules/rust.js";
import { rustPolicyArtifact } from "./policy.js";
import { rustProviders } from "./providers/rust.js";
import { createRuntimeTemplate, runtimeLoader } from "./shared.js";

const SOURCE = `use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureKind {
    Timeout,
    RateLimit,
    Provider,
    InvalidOutput,
    GuardRejected,
    ApprovalRequired,
    BudgetExhausted,
    CircuitOpen,
    Cancelled,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::RateLimit => "rate-limit",
            Self::Provider => "provider",
            Self::InvalidOutput => "invalid-output",
            Self::GuardRejected => "guard-rejected",
            Self::ApprovalRequired => "approval-required",
            Self::BudgetExhausted => "budget-exhausted",
            Self::CircuitOpen => "circuit-open",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ModelRequest<T> {
    pub id: String,
    pub route: String,
    pub prompt_version: String,
    pub input: T,
    pub input_tokens: u64,
    pub max_output_tokens: u64,
    pub metadata: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Clone, Debug)]
pub struct ModelFailure {
    pub kind: FailureKind,
    pub message: String,
    pub retryable: bool,
    pub provider_code: Option<String>,
}

pub enum ModelResult<T> {
    Success { value: T, usage: Usage },
    Failure(ModelFailure),
}

pub trait ModelAdapter<I, O>: Send + Sync {
    fn invoke(&self, request: &ModelRequest<I>, context: &InvocationContext) -> ModelResult<O>;
}

#[derive(Clone, Debug)]
pub struct EventContext {
    pub request_id: String,
    pub prompt_version: String,
    pub metadata_keys: Vec<String>,
    pub occurred_at: Instant,
}

#[derive(Clone, Debug)]
pub enum RuntimeEventKind {
    RequestStarted,
    AttemptStarted { route: String, attempt: u32 },
    RetryScheduled { delay: Duration, attempt: u32 },
    FallbackSelected { route: String },
    CacheHit,
    CacheMiss,
    CacheReadFailed,
    CacheStored,
    CacheWriteFailed,
    RequestSucceeded { usage: Usage, latency: Duration },
    RequestFailed { failure_kind: FailureKind },
}

#[derive(Clone, Debug)]
pub struct RuntimeEvent {
    pub context: EventContext,
    pub kind: RuntimeEventKind,
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &RuntimeEvent) -> Result<(), String>;
}

pub trait InputGuard<T>: Send + Sync {
    fn check(&self, request: &ModelRequest<T>) -> Result<(), String>;
}

pub trait OutputGuard<T, O>: Send + Sync {
    fn check(&self, request: &ModelRequest<T>, output: &O) -> Result<(), String>;
}

pub trait CachePort<T>: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<T>, String>;
    fn set(&self, key: &str, value: &T) -> Result<(), String>;
}

pub trait ApprovalPort<T>: Send + Sync {
    fn approve(&self, request: &ModelRequest<T>, reason: &str) -> Result<bool, String>;
}

pub trait EvaluationPort<I, O>: Send + Sync {
    fn record(&self, request: &ModelRequest<I>, result: &ModelResult<O>) -> Result<(), String>;
}

pub trait HumanFeedbackPort: Send + Sync {
    fn record(&self, request_id: &str, score: f64, note: Option<&str>) -> Result<(), String>;
}

pub enum ValidationResult<T> {
    Valid(T),
    Invalid { value: T, reason: String },
}

pub trait OutputValidator<T>: Send + Sync {
    fn validate(&self, value: T) -> ValidationResult<T>;
}

pub trait RepairPort<I, O>: Send + Sync {
    fn repair(
        &self,
        request: &ModelRequest<I>,
        invalid: O,
        reason: &str,
        context: &InvocationContext,
    ) -> Result<O, String>;
}

#[derive(Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Clone)]
pub struct InvocationContext {
    pub deadline: Instant,
    pub cancellation: CancellationToken,
}

#[derive(Clone, Debug)]
pub struct RetryOptions {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub jitter_ratio: f64,
}

#[derive(Clone, Debug)]
pub struct RuntimeOptions {
    pub timeout: Duration,
    pub retry: RetryOptions,
    pub fallback_routes: Vec<String>,
    pub max_repair_attempts: u32,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub max_estimated_cost_usd: Option<f64>,
    pub max_concurrency: usize,
    pub max_batch_size: usize,
    pub circuit_failure_threshold: u32,
    pub circuit_reset_after: Duration,
    pub circuit_half_open_max_attempts: u32,
}

pub struct ExecuteOptions<O> {
    pub validator: Option<Arc<dyn OutputValidator<O>>>,
    pub cache_key: Option<String>,
    pub approval_reason: Option<String>,
    pub cancellation: CancellationToken,
}

impl<O> Default for ExecuteOptions<O> {
    fn default() -> Self {
        Self {
            validator: None,
            cache_key: None,
            approval_reason: None,
            cancellation: CancellationToken::default(),
        }
    }
}

pub struct AdapterRegistry<I, O> {
    adapters: BTreeMap<String, Arc<dyn ModelAdapter<I, O>>>,
}

impl<I, O> AdapterRegistry<I, O> {
    pub fn new() -> Self {
        Self {
            adapters: BTreeMap::new(),
        }
    }

    pub fn register(
        &mut self,
        route: impl Into<String>,
        adapter: Arc<dyn ModelAdapter<I, O>>,
    ) -> Result<(), String> {
        let route = route.into();
        if route.trim().is_empty() {
            return Err("route must not be empty".to_owned());
        }
        if self.adapters.contains_key(&route) {
            return Err("adapter already registered for route ".to_owned() + &route);
        }
        self.adapters.insert(route, adapter);
        Ok(())
    }

    fn get(&self, route: &str) -> Option<Arc<dyn ModelAdapter<I, O>>> {
        self.adapters.get(route).cloned()
    }
}

impl<I, O> Default for AdapterRegistry<I, O> {
    fn default() -> Self {
        Self::new()
    }
}

pub struct GuardRegistry<I, O> {
    input: Vec<Arc<dyn InputGuard<I>>>,
    output: Vec<Arc<dyn OutputGuard<I, O>>>,
}

impl<I, O> GuardRegistry<I, O> {
    pub fn new() -> Self {
        Self {
            input: Vec::new(),
            output: Vec::new(),
        }
    }

    pub fn register_input(&mut self, guard: Arc<dyn InputGuard<I>>) {
        self.input.push(guard);
    }

    pub fn register_output(&mut self, guard: Arc<dyn OutputGuard<I, O>>) {
        self.output.push(guard);
    }
}

impl<I, O> Default for GuardRegistry<I, O> {
    fn default() -> Self {
        Self::new()
    }
}

pub fn retry_delay(
    attempt: u32,
    base: Duration,
    maximum: Duration,
    jitter_ratio: f64,
    random_value: f64,
) -> Result<Duration, &'static str> {
    if attempt == 0 {
        return Err("attempt must be positive");
    }
    let exponent = attempt.saturating_sub(1).min(31);
    let multiplier = 1_u32 << exponent;
    let bounded = base.saturating_mul(multiplier).min(maximum);
    let random = random_value.clamp(0.0, 1.0);
    let jitter = bounded.mul_f64(jitter_ratio * random);
    Ok(bounded.saturating_add(jitter))
}

fn system_random() -> f64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos() as u64;
    let mut value = timestamp ^ COUNTER.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    let sample = value.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11;
    sample as f64 / ((1_u64 << 53) as f64)
}

pub fn enforce_budget<T>(
    request: &ModelRequest<T>,
    input_tokens: u64,
    max_input_tokens: u64,
    max_output_tokens: u64,
) -> Option<ModelFailure> {
    if input_tokens <= max_input_tokens && request.max_output_tokens <= max_output_tokens {
        return None;
    }
    Some(ModelFailure {
        kind: FailureKind::BudgetExhausted,
        message: "the request exceeds its configured token budget".to_owned(),
        retryable: false,
        provider_code: None,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

pub struct CircuitBreaker {
    state: CircuitState,
    failures: u32,
    opened_at: Option<Instant>,
    failure_threshold: u32,
    reset_after: Duration,
    half_open_max_attempts: u32,
    half_open_attempts: u32,
}

impl CircuitBreaker {
    pub fn new(
        failure_threshold: u32,
        reset_after: Duration,
        half_open_max_attempts: u32,
    ) -> Result<Self, &'static str> {
        if failure_threshold == 0 || reset_after.is_zero() || half_open_max_attempts == 0 {
            return Err("circuit breaker limits must be positive");
        }
        Ok(Self {
            state: CircuitState::Closed,
            failures: 0,
            opened_at: None,
            failure_threshold,
            reset_after,
            half_open_max_attempts,
            half_open_attempts: 0,
        })
    }

    pub fn state(&mut self, now: Instant) -> CircuitState {
        if self.state == CircuitState::Open
            && self
                .opened_at
                .is_some_and(|opened| now.duration_since(opened) >= self.reset_after)
        {
            self.state = CircuitState::HalfOpen;
            self.half_open_attempts = 0;
        }
        self.state
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        let state = self.state(now);
        if state == CircuitState::Open {
            return false;
        }
        if state == CircuitState::HalfOpen {
            if self.half_open_attempts >= self.half_open_max_attempts {
                return false;
            }
            self.half_open_attempts = self.half_open_attempts.saturating_add(1);
        }
        true
    }

    pub fn success(&mut self) {
        self.state = CircuitState::Closed;
        self.failures = 0;
        self.opened_at = None;
        self.half_open_attempts = 0;
    }

    pub fn failure(&mut self, now: Instant) {
        self.failures = self.failures.saturating_add(1);
        if self.state == CircuitState::HalfOpen || self.failures >= self.failure_threshold {
            self.state = CircuitState::Open;
            self.opened_at = Some(now);
            self.half_open_attempts = 0;
        }
    }
}

pub struct RuntimePorts<I, O> {
    pub guards: GuardRegistry<I, O>,
    pub events: Option<Arc<dyn EventSink>>,
    pub cache: Option<Arc<dyn CachePort<O>>>,
    pub approval: Option<Arc<dyn ApprovalPort<I>>>,
    pub evaluation: Option<Arc<dyn EvaluationPort<I, O>>>,
    pub repair: Option<Arc<dyn RepairPort<I, O>>>,
}

impl<I, O> Default for RuntimePorts<I, O> {
    fn default() -> Self {
        Self {
            guards: GuardRegistry::new(),
            events: None,
            cache: None,
            approval: None,
            evaluation: None,
            repair: None,
        }
    }
}

struct ConcurrencyGate {
    active: Mutex<usize>,
    changed: Condvar,
    maximum: usize,
}

struct GatePermit<'a> {
    gate: &'a ConcurrencyGate,
}

impl ConcurrencyGate {
    fn acquire(&self, cancellation: &CancellationToken) -> Option<GatePermit<'_>> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while *active >= self.maximum {
            if cancellation.is_cancelled() {
                return None;
            }
            let waited = self
                .changed
                .wait_timeout(active, Duration::from_millis(10))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            active = waited.0;
        }
        *active += 1;
        Some(GatePermit { gate: self })
    }

    fn release(&self) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *active = active.saturating_sub(1);
        self.changed.notify_one();
    }
}

impl Drop for GatePermit<'_> {
    fn drop(&mut self) {
        self.gate.release();
    }
}

pub struct HarnessRuntime<I, O> {
    options: RuntimeOptions,
    adapters: AdapterRegistry<I, O>,
    ports: RuntimePorts<I, O>,
    circuits: Mutex<BTreeMap<String, CircuitBreaker>>,
    gate: ConcurrencyGate,
    random_value: fn() -> f64,
}

impl<I, O> HarnessRuntime<I, O>
where
    I: Clone + Send + Sync + 'static,
    O: Clone + Send + Sync + 'static,
{
    pub fn new(
        options: RuntimeOptions,
        adapters: AdapterRegistry<I, O>,
        ports: RuntimePorts<I, O>,
    ) -> Result<Self, String> {
        if options.timeout.is_zero() || options.retry.max_attempts == 0 {
            return Err("timeout and max attempts must be positive".to_owned());
        }
        if options.max_concurrency == 0 || options.max_batch_size == 0 {
            return Err("concurrency and batch limits must be positive".to_owned());
        }
        if options.circuit_failure_threshold == 0
            || options.circuit_reset_after.is_zero()
            || options.circuit_half_open_max_attempts == 0
        {
            return Err("circuit breaker limits must be positive".to_owned());
        }
        let maximum = options.max_concurrency;
        Ok(Self {
            options,
            adapters,
            ports,
            circuits: Mutex::new(BTreeMap::new()),
            gate: ConcurrencyGate {
                active: Mutex::new(0),
                changed: Condvar::new(),
                maximum,
            },
            random_value: system_random,
        })
    }

    pub fn with_random(mut self, random_value: fn() -> f64) -> Self {
        self.random_value = random_value;
        self
    }

    pub fn execute(
        &self,
        request: ModelRequest<I>,
        execute_options: &ExecuteOptions<O>,
    ) -> ModelResult<O> {
        let Some(_permit) = self.gate.acquire(&execute_options.cancellation) else {
            return ModelResult::Failure(failure(
                FailureKind::Cancelled,
                "the request was cancelled while waiting for capacity",
                false,
            ));
        };
        self.execute_with_capacity(request, execute_options)
    }

    pub fn execute_batch(
        &self,
        requests: &[ModelRequest<I>],
        execute_options: &ExecuteOptions<O>,
    ) -> Result<Vec<ModelResult<O>>, String> {
        if requests.len() > self.options.max_batch_size {
            return Err("batch exceeds max batch size".to_owned());
        }
        Ok(thread::scope(|scope| {
            let handles: Vec<_> = requests
                .iter()
                .cloned()
                .map(|request| scope.spawn(move || self.execute(request, execute_options)))
                .collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle.join().unwrap_or_else(|_| {
                        ModelResult::Failure(failure(
                            FailureKind::Provider,
                            "runtime worker panicked",
                            false,
                        ))
                    })
                })
                .collect()
        }))
    }

    fn execute_with_capacity(
        &self,
        request: ModelRequest<I>,
        execute_options: &ExecuteOptions<O>,
    ) -> ModelResult<O> {
        let started_at = Instant::now();
        self.emit(&request, RuntimeEventKind::RequestStarted);
        if let Some(budget_failure) = enforce_budget(
            &request,
            request.input_tokens,
            self.options.max_input_tokens,
            self.options.max_output_tokens,
        ) {
            return self.finish_failure(&request, budget_failure);
        }
        for guard in &self.ports.guards.input {
            if let Err(reason) = guard.check(&request) {
                return self.finish_failure(
                    &request,
                    failure(FailureKind::GuardRejected, &reason, false),
                );
            }
        }
        if let Some(reason) = &execute_options.approval_reason {
            let approved = self
                .ports
                .approval
                .as_ref()
                .is_some_and(|approval| approval.approve(&request, reason).unwrap_or(false));
            if !approved {
                return self.finish_failure(
                    &request,
                    failure(
                        FailureKind::ApprovalRequired,
                        "the configured human approval was not granted",
                        false,
                    ),
                );
            }
        }
        if let (Some(cache_key), Some(cache)) = (&execute_options.cache_key, &self.ports.cache) {
            match cache.get(cache_key) {
                Ok(Some(cached)) => {
                    self.emit(&request, RuntimeEventKind::CacheHit);
                    let result = ModelResult::Success {
                        value: cached,
                        usage: Usage::default(),
                    };
                    self.record(&request, &result);
                    return result;
                }
                Ok(None) => self.emit(&request, RuntimeEventKind::CacheMiss),
                Err(_) => self.emit(&request, RuntimeEventKind::CacheReadFailed),
            }
        }

        let routes = unique_routes(
            std::iter::once(request.route.clone())
                .chain(self.options.fallback_routes.iter().cloned()),
        );
        let mut final_failure = failure(
            FailureKind::Provider,
            "no registered route could complete the request",
            false,
        );
        for (route_index, route) in routes.into_iter().enumerate() {
            if route_index > 0 {
                self.emit(
                    &request,
                    RuntimeEventKind::FallbackSelected {
                        route: route.clone(),
                    },
                );
            }
            let Some(adapter) = self.adapters.get(&route) else {
                final_failure = failure(
                    FailureKind::Provider,
                    &("no adapter is registered for route ".to_owned() + &route),
                    false,
                );
                continue;
            };
            if !self.circuit_allows(&route, Instant::now()) {
                final_failure = failure(
                    FailureKind::CircuitOpen,
                    &("the circuit is open for route ".to_owned() + &route),
                    true,
                );
                continue;
            }

            for attempt in 1..=self.options.retry.max_attempts {
                if execute_options.cancellation.is_cancelled() {
                    return self.finish_failure(
                        &request,
                        failure(FailureKind::Cancelled, "the request was cancelled", false),
                    );
                }
                self.emit(
                    &request,
                    RuntimeEventKind::AttemptStarted {
                        route: route.clone(),
                        attempt,
                    },
                );
                match self.invoke(
                    adapter.clone(),
                    request.clone(),
                    &execute_options.cancellation,
                ) {
                    ModelResult::Success { value, usage } => {
                        let resolved = self.validate_and_repair(
                            &request,
                            value,
                            execute_options.validator.as_ref(),
                            &execute_options.cancellation,
                        );
                        let value = match resolved {
                            ModelResult::Success { value, .. } => value,
                            ModelResult::Failure(invalid) => {
                                final_failure = invalid;
                                break;
                            }
                        };
                        for guard in &self.ports.guards.output {
                            if let Err(reason) = guard.check(&request, &value) {
                                return self.finish_failure(
                                    &request,
                                    failure(FailureKind::GuardRejected, &reason, false),
                                );
                            }
                        }
                        if self
                            .options
                            .max_estimated_cost_usd
                            .is_some_and(|maximum| usage.estimated_cost_usd > maximum)
                        {
                            return self.finish_failure(
                                &request,
                                failure(
                                    FailureKind::BudgetExhausted,
                                    "the result exceeds its configured cost budget",
                                    false,
                                ),
                            );
                        }
                        self.circuit_success(&route);
                        if let (Some(cache_key), Some(cache)) =
                            (&execute_options.cache_key, &self.ports.cache)
                        {
                            self.emit(
                                &request,
                                if cache.set(cache_key, &value).is_ok() {
                                    RuntimeEventKind::CacheStored
                                } else {
                                    RuntimeEventKind::CacheWriteFailed
                                },
                            );
                        }
                        let result = ModelResult::Success { value, usage };
                        self.emit(
                            &request,
                            RuntimeEventKind::RequestSucceeded {
                                usage,
                                latency: started_at.elapsed(),
                            },
                        );
                        self.record(&request, &result);
                        return result;
                    }
                    ModelResult::Failure(provider_failure) => {
                        final_failure = provider_failure;
                        if final_failure.retryable {
                            self.circuit_failure(&route, Instant::now());
                        }
                        if !final_failure.retryable || attempt >= self.options.retry.max_attempts {
                            break;
                        }
                        let delay = retry_delay(
                            attempt,
                            self.options.retry.base_delay,
                            self.options.retry.max_delay,
                            self.options.retry.jitter_ratio,
                            (self.random_value)(),
                        )
                        .unwrap_or(self.options.retry.max_delay);
                        self.emit(
                            &request,
                            RuntimeEventKind::RetryScheduled { delay, attempt },
                        );
                        if !sleep_cancellable(delay, &execute_options.cancellation) {
                            return self.finish_failure(
                                &request,
                                failure(
                                    FailureKind::Cancelled,
                                    "the request was cancelled during retry backoff",
                                    false,
                                ),
                            );
                        }
                    }
                }
            }
            if matches!(
                final_failure.kind,
                FailureKind::Cancelled
                    | FailureKind::GuardRejected
                    | FailureKind::ApprovalRequired
                    | FailureKind::BudgetExhausted
            ) {
                return self.finish_failure(&request, final_failure);
            }
        }
        self.finish_failure(&request, final_failure)
    }

    fn invoke(
        &self,
        adapter: Arc<dyn ModelAdapter<I, O>>,
        request: ModelRequest<I>,
        external_cancellation: &CancellationToken,
    ) -> ModelResult<O> {
        if external_cancellation.is_cancelled() {
            return ModelResult::Failure(failure(
                FailureKind::Cancelled,
                "the request was cancelled",
                false,
            ));
        }
        let cancellation = CancellationToken::default();
        let context = InvocationContext {
            deadline: Instant::now() + self.options.timeout,
            cancellation: cancellation.clone(),
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| adapter.invoke(&request, &context)))
                .unwrap_or_else(|_| {
                    ModelResult::Failure(failure(
                        FailureKind::Provider,
                        "provider adapter panicked",
                        true,
                    ))
                });
            let _ = sender.send(result);
        });
        let deadline = Instant::now() + self.options.timeout;
        loop {
            if external_cancellation.is_cancelled() {
                cancellation.cancel();
                return ModelResult::Failure(failure(
                    FailureKind::Cancelled,
                    "the request was cancelled",
                    false,
                ));
            }
            let now = Instant::now();
            if now >= deadline {
                cancellation.cancel();
                return ModelResult::Failure(failure(
                    FailureKind::Timeout,
                    "the model deadline expired",
                    true,
                ));
            }
            let wait = deadline.duration_since(now).min(Duration::from_millis(10));
            match receiver.recv_timeout(wait) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return ModelResult::Failure(failure(
                        FailureKind::Provider,
                        "provider adapter disconnected",
                        true,
                    ));
                }
            }
        }
    }

    fn validate_and_repair(
        &self,
        request: &ModelRequest<I>,
        initial_value: O,
        validator: Option<&Arc<dyn OutputValidator<O>>>,
        cancellation: &CancellationToken,
    ) -> ModelResult<O> {
        let Some(validator) = validator else {
            return ModelResult::Success {
                value: initial_value,
                usage: Usage::default(),
            };
        };
        let mut candidate = initial_value;
        for repair_attempt in 0..=self.options.max_repair_attempts {
            match validator.validate(candidate) {
                ValidationResult::Valid(value) => {
                    return ModelResult::Success {
                        value,
                        usage: Usage::default(),
                    };
                }
                ValidationResult::Invalid { value, reason } => {
                    if repair_attempt >= self.options.max_repair_attempts {
                        return ModelResult::Failure(failure(
                            FailureKind::InvalidOutput,
                            &reason,
                            false,
                        ));
                    }
                    let Some(repair) = &self.ports.repair else {
                        return ModelResult::Failure(failure(
                            FailureKind::InvalidOutput,
                            &reason,
                            false,
                        ));
                    };
                    let context = InvocationContext {
                        deadline: Instant::now() + self.options.timeout,
                        cancellation: cancellation.clone(),
                    };
                    candidate = match repair.repair(request, value, &reason, &context) {
                        Ok(repaired) => repaired,
                        Err(error) => {
                            return ModelResult::Failure(failure(
                                FailureKind::InvalidOutput,
                                &error,
                                false,
                            ));
                        }
                    };
                }
            }
        }
        ModelResult::Failure(failure(
            FailureKind::InvalidOutput,
            "structured output could not be validated",
            false,
        ))
    }

    fn circuit_allows(&self, route: &str, now: Instant) -> bool {
        let mut circuits = self
            .circuits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        circuits
            .entry(route.to_owned())
            .or_insert_with(|| {
                CircuitBreaker::new(
                    self.options.circuit_failure_threshold,
                    self.options.circuit_reset_after,
                    self.options.circuit_half_open_max_attempts,
                )
                .expect("runtime options validate circuit settings")
            })
            .allow(now)
    }

    fn circuit_success(&self, route: &str) {
        if let Some(circuit) = self
            .circuits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(route)
        {
            circuit.success();
        }
    }

    fn circuit_failure(&self, route: &str, now: Instant) {
        if let Some(circuit) = self
            .circuits
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(route)
        {
            circuit.failure(now);
        }
    }

    fn finish_failure(
        &self,
        request: &ModelRequest<I>,
        model_failure: ModelFailure,
    ) -> ModelResult<O> {
        self.emit(
            request,
            RuntimeEventKind::RequestFailed {
                failure_kind: model_failure.kind,
            },
        );
        let result = ModelResult::Failure(model_failure);
        self.record(request, &result);
        result
    }

    fn record(&self, request: &ModelRequest<I>, result: &ModelResult<O>) {
        if let Some(evaluation) = &self.ports.evaluation {
            let _ = evaluation.record(request, result);
        }
    }

    fn emit(&self, request: &ModelRequest<I>, kind: RuntimeEventKind) {
        let Some(events) = &self.ports.events else {
            return;
        };
        let event = RuntimeEvent {
            context: EventContext {
                request_id: request.id.clone(),
                prompt_version: request.prompt_version.clone(),
                metadata_keys: request.metadata.keys().cloned().collect(),
                occurred_at: Instant::now(),
            },
            kind,
        };
        let _ = events.emit(&event);
    }
}

fn failure(kind: FailureKind, message: &str, retryable: bool) -> ModelFailure {
    ModelFailure {
        kind,
        message: message.to_owned(),
        retryable,
        provider_code: None,
    }
}

fn unique_routes(routes: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeMap::new();
    routes
        .into_iter()
        .filter(|route| seen.insert(route.clone(), ()).is_none())
        .collect()
}

fn sleep_cancellable(delay: Duration, cancellation: &CancellationToken) -> bool {
    let deadline = Instant::now() + delay;
    while Instant::now() < deadline {
        if cancellation.is_cancelled() {
            return false;
        }
        thread::sleep(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(10)),
        );
    }
    !cancellation.is_cancelled()
}
`;

const TEST_SOURCE = `#[path = "policy.rs"]
mod policy;
#[path = "runtime.rs"]
mod runtime;

const CONFORMANCE: &str = include_str!("conformance.json");

use runtime::{
    enforce_budget, retry_delay, AdapterRegistry, CircuitBreaker, ExecuteOptions, FailureKind,
    GuardRegistry, HarnessRuntime, InputGuard, InvocationContext, ModelAdapter, ModelFailure,
    ModelRequest, ModelResult, OutputValidator, RepairPort, RetryOptions, RuntimeEvent,
    RuntimeEventKind, RuntimeOptions, RuntimePorts, Usage, ValidationResult,
};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn test_request(id: &str) -> ModelRequest<()> {
    ModelRequest {
        id: id.to_owned(),
        route: "primary".to_owned(),
        prompt_version: "v1".to_owned(),
        input: (),
        input_tokens: 10,
        max_output_tokens: 100,
        metadata: BTreeMap::from([("tenant".to_owned(), "secret-value".to_owned())]),
    }
}

fn test_options() -> RuntimeOptions {
    RuntimeOptions {
        timeout: Duration::from_secs(1),
        retry: RetryOptions {
            max_attempts: 2,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(10),
            jitter_ratio: 0.0,
        },
        fallback_routes: vec!["fallback".to_owned()],
        max_repair_attempts: 1,
        max_input_tokens: 100,
        max_output_tokens: 100,
        max_estimated_cost_usd: None,
        max_concurrency: 2,
        max_batch_size: 4,
        circuit_failure_threshold: 3,
        circuit_reset_after: Duration::from_secs(1),
        circuit_half_open_max_attempts: 1,
    }
}

fn conformance_option_value(field: &str) -> u64 {
    let field_marker = format!(r#""field": "{field}""#);
    let tail = CONFORMANCE
        .split_once(&field_marker)
        .unwrap_or_else(|| panic!("missing conformance option {field}"))
        .1;
    let value = tail
        .split_once(r#""value":"#)
        .expect("option value is missing")
        .1
        .trim_start();
    value
        .split(|character: char| !character.is_ascii_digit())
        .next()
        .expect("option value is empty")
        .parse()
        .expect("option value is not an integer")
}

#[test]
fn shared_conformance_options_fail_during_construction() {
    assert!(CONFORMANCE.contains(r#""schemaVersion": 1"#));
    assert!(CONFORMANCE.contains("guardStages"));
    assert!(CONFORMANCE.contains(r#""input""#));
    assert!(CONFORMANCE.contains(r#""output""#));
    let mut options = test_options();
    options.circuit_failure_threshold = conformance_option_value("circuitFailureThreshold") as u32;
    assert!(HarnessRuntime::<(), ()>::new(
        options,
        AdapterRegistry::new(),
        RuntimePorts::default()
    )
    .is_err());
    let mut options = test_options();
    options.circuit_reset_after =
        Duration::from_millis(conformance_option_value("circuitResetAfterMs"));
    assert!(HarnessRuntime::<(), ()>::new(
        options,
        AdapterRegistry::new(),
        RuntimePorts::default()
    )
    .is_err());
    let mut options = test_options();
    options.circuit_half_open_max_attempts =
        conformance_option_value("circuitHalfOpenMaxAttempts") as u32;
    assert!(HarnessRuntime::<(), ()>::new(
        options,
        AdapterRegistry::new(),
        RuntimePorts::default()
    )
    .is_err());
}

#[test]
fn generated_policy_preserves_units_and_values() {
    let options = policy::generated_runtime_options();
    assert_eq!(options.timeout, Duration::from_secs(30));
    assert_eq!(options.circuit_reset_after, Duration::from_secs(30));
    assert_eq!(options.retry.max_attempts, 3);
    assert_eq!(options.circuit_half_open_max_attempts, 1);
}

#[test]
fn bounded_retry_delay_is_deterministic() {
    assert_eq!(
        retry_delay(
            2,
            Duration::from_millis(100),
            Duration::from_secs(1),
            0.5,
            0.0,
        ),
        Ok(Duration::from_millis(200))
    );
    assert!(retry_delay(0, Duration::ZERO, Duration::ZERO, 0.0, 0.0).is_err());
}

#[test]
fn token_budget_fails_closed() {
    let request = ModelRequest {
        id: "request-1".to_owned(),
        route: "primary".to_owned(),
        prompt_version: "v1".to_owned(),
        input: (),
        input_tokens: 10,
        max_output_tokens: 100,
        metadata: BTreeMap::new(),
    };
    assert!(enforce_budget(&request, 10, 10, 100).is_none());
    assert_eq!(
        enforce_budget(&request, 11, 10, 100).map(|failure| failure.kind),
        Some(FailureKind::BudgetExhausted)
    );
}

#[test]
fn circuit_opens_half_opens_and_closes() {
    let start = Instant::now();
    let mut breaker = CircuitBreaker::new(2, Duration::from_millis(100), 1).unwrap();
    breaker.failure(start);
    assert!(breaker.allow(start + Duration::from_millis(1)));
    breaker.failure(start + Duration::from_millis(2));
    assert!(!breaker.allow(start + Duration::from_millis(50)));
    assert!(breaker.allow(start + Duration::from_millis(102)));
    breaker.success();
    assert!(breaker.allow(start + Duration::from_millis(103)));
}

#[test]
fn half_open_probes_are_bounded() {
    let start = Instant::now();
    let mut breaker = CircuitBreaker::new(1, Duration::from_millis(100), 1).unwrap();
    breaker.failure(start);
    assert!(breaker.allow(start + Duration::from_millis(100)));
    assert!(!breaker.allow(start + Duration::from_millis(100)));
    breaker.success();
    assert!(breaker.allow(start + Duration::from_millis(101)));
}

struct PanickingAdapter;

impl ModelAdapter<(), String> for PanickingAdapter {
    fn invoke(
        &self,
        _request: &ModelRequest<()>,
        _context: &InvocationContext,
    ) -> ModelResult<String> {
        panic!("synchronous adapter failure")
    }
}

#[test]
fn synchronous_adapter_panic_is_contained() {
    assert!(CONFORMANCE.contains(r#""synchronousAdapterThrow": "provider-failure""#));
    let mut adapters = AdapterRegistry::new();
    adapters
        .register("primary", Arc::new(PanickingAdapter))
        .unwrap();
    let mut options = test_options();
    options.retry.max_attempts = 1;
    options.fallback_routes.clear();
    let runtime = HarnessRuntime::new(options, adapters, RuntimePorts::default()).unwrap();
    match runtime.execute(test_request("panic"), &ExecuteOptions::default()) {
        ModelResult::Failure(failure) => assert_eq!(failure.kind, FailureKind::Provider),
        ModelResult::Success { .. } => panic!("panicking adapter unexpectedly succeeded"),
    }
}

struct FailingAdapter {
    calls: AtomicUsize,
}

impl ModelAdapter<(), String> for FailingAdapter {
    fn invoke(
        &self,
        _request: &ModelRequest<()>,
        _context: &InvocationContext,
    ) -> ModelResult<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        ModelResult::Failure(ModelFailure {
            kind: FailureKind::RateLimit,
            message: "busy".to_owned(),
            retryable: true,
            provider_code: None,
        })
    }
}

struct FallbackAdapter;

impl ModelAdapter<(), String> for FallbackAdapter {
    fn invoke(
        &self,
        _request: &ModelRequest<()>,
        _context: &InvocationContext,
    ) -> ModelResult<String> {
        ModelResult::Success {
            value: "42".to_owned(),
            usage: Usage {
                input_tokens: 10,
                output_tokens: 2,
                estimated_cost_usd: 0.01,
            },
        }
    }
}

struct AnswerValidator;

impl OutputValidator<String> for AnswerValidator {
    fn validate(&self, value: String) -> ValidationResult<String> {
        if value.starts_with("answer:") {
            ValidationResult::Valid(value)
        } else {
            ValidationResult::Invalid {
                value,
                reason: "answer must be labeled".to_owned(),
            }
        }
    }
}

struct AnswerRepair;

impl RepairPort<(), String> for AnswerRepair {
    fn repair(
        &self,
        _request: &ModelRequest<()>,
        invalid: String,
        _reason: &str,
        _context: &InvocationContext,
    ) -> Result<String, String> {
        Ok("answer:".to_owned() + &invalid)
    }
}

#[derive(Default)]
struct MemoryEvents {
    events: Mutex<Vec<RuntimeEvent>>,
}

impl runtime::EventSink for MemoryEvents {
    fn emit(&self, event: &RuntimeEvent) -> Result<(), String> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }
}

#[test]
fn runtime_retries_falls_back_repairs_and_redacts_events() {
    let primary = Arc::new(FailingAdapter {
        calls: AtomicUsize::new(0),
    });
    let mut adapters = AdapterRegistry::new();
    adapters.register("primary", primary.clone()).unwrap();
    adapters
        .register("fallback", Arc::new(FallbackAdapter))
        .unwrap();
    let events = Arc::new(MemoryEvents::default());
    let ports = RuntimePorts {
        events: Some(events.clone()),
        repair: Some(Arc::new(AnswerRepair)),
        ..RuntimePorts::default()
    };
    let runtime = HarnessRuntime::new(test_options(), adapters, ports)
        .unwrap()
        .with_random(|| 0.0);
    let result = runtime.execute(
        test_request("request-1"),
        &ExecuteOptions {
            validator: Some(Arc::new(AnswerValidator)),
            ..ExecuteOptions::default()
        },
    );
    match result {
        ModelResult::Success { value, usage } => {
            assert_eq!(value, "answer:42");
            assert_eq!(usage.output_tokens, 2);
        }
        ModelResult::Failure(failure) => panic!("unexpected failure: {}", failure.message),
    }
    assert_eq!(primary.calls.load(Ordering::SeqCst), 2);
    let captured = events.events.lock().unwrap();
    assert!(captured
        .iter()
        .any(|event| matches!(event.kind, RuntimeEventKind::FallbackSelected { .. })));
    assert_eq!(captured[0].context.metadata_keys, vec!["tenant"]);
}

struct TerminalAdapter;

impl ModelAdapter<(), String> for TerminalAdapter {
    fn invoke(
        &self,
        _request: &ModelRequest<()>,
        _context: &InvocationContext,
    ) -> ModelResult<String> {
        ModelResult::Failure(ModelFailure {
            kind: FailureKind::Cancelled,
            message: "cancelled".to_owned(),
            retryable: false,
            provider_code: None,
        })
    }
}

#[test]
fn terminal_policy_failures_never_fall_through_to_fallbacks() {
    let mut adapters = AdapterRegistry::new();
    adapters
        .register("primary", Arc::new(TerminalAdapter))
        .unwrap();
    let runtime = HarnessRuntime::new(test_options(), adapters, RuntimePorts::default()).unwrap();
    let result = runtime.execute(test_request("terminal"), &ExecuteOptions::default());
    assert!(matches!(
        result,
        ModelResult::Failure(ModelFailure {
            kind: FailureKind::Cancelled,
            ..
        })
    ));
}

struct SlowAdapter;

impl ModelAdapter<(), String> for SlowAdapter {
    fn invoke(
        &self,
        _request: &ModelRequest<()>,
        context: &InvocationContext,
    ) -> ModelResult<String> {
        while !context.cancellation.is_cancelled() {
            thread::sleep(Duration::from_millis(1));
        }
        ModelResult::Success {
            value: "late".to_owned(),
            usage: Usage::default(),
        }
    }
}

#[test]
fn deadline_and_caller_cancellation_remain_distinct() {
    let mut adapters = AdapterRegistry::new();
    adapters.register("primary", Arc::new(SlowAdapter)).unwrap();
    let mut options = test_options();
    options.timeout = Duration::from_millis(1);
    options.retry.max_attempts = 1;
    options.fallback_routes.clear();
    let runtime = HarnessRuntime::new(options, adapters, RuntimePorts::default()).unwrap();
    let timed_out = runtime.execute(test_request("timeout"), &ExecuteOptions::default());
    assert!(matches!(
        timed_out,
        ModelResult::Failure(ModelFailure {
            kind: FailureKind::Timeout,
            ..
        })
    ));

    let cancellation = runtime::CancellationToken::default();
    cancellation.cancel();
    let cancelled = runtime.execute(
        test_request("cancelled"),
        &ExecuteOptions {
            cancellation,
            ..ExecuteOptions::default()
        },
    );
    assert!(matches!(
        cancelled,
        ModelResult::Failure(ModelFailure {
            kind: FailureKind::Cancelled,
            ..
        })
    ));
}

#[derive(Default)]
struct PolicyPressureAdapter {
    active: AtomicUsize,
    maximum: AtomicUsize,
    calls: AtomicUsize,
}

impl ModelAdapter<(), String> for PolicyPressureAdapter {
    fn invoke(
        &self,
        _request: &ModelRequest<()>,
        _context: &InvocationContext,
    ) -> ModelResult<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        let mut observed = self.maximum.load(Ordering::SeqCst);
        while active > observed {
            match self.maximum.compare_exchange(
                observed,
                active,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(current) => observed = current,
            }
        }
        thread::sleep(Duration::from_millis(1));
        self.active.fetch_sub(1, Ordering::SeqCst);
        ModelResult::Success {
            value: "ok".to_owned(),
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
                estimated_cost_usd: 0.001,
            },
        }
    }
}

#[test]
fn policy_pressure_is_bounded_and_cost_budget_fails_closed() {
    let adapter = Arc::new(PolicyPressureAdapter::default());
    let mut adapters = AdapterRegistry::new();
    adapters.register("primary", adapter.clone()).unwrap();
    let mut options = test_options();
    options.max_concurrency = 4;
    options.max_batch_size = 32;
    options.retry.max_attempts = 1;
    options.fallback_routes.clear();
    let events = Arc::new(MemoryEvents::default());
    let runtime = HarnessRuntime::new(
        options.clone(),
        adapters,
        RuntimePorts {
            events: Some(events.clone()),
            ..RuntimePorts::default()
        },
    )
    .unwrap();
    let requests: Vec<_> = (0..32)
        .map(|index| test_request(&format!("pressure-{index}")))
        .collect();
    let rounds = 8;
    for _round in 0..rounds {
        let results = runtime
            .execute_batch(&requests, &ExecuteOptions::default())
            .unwrap();
        assert!(results
            .iter()
            .all(|result| matches!(result, ModelResult::Success { .. })));
    }
    let total_requests = requests.len() * rounds;
    assert_eq!(adapter.calls.load(Ordering::SeqCst), total_requests);
    assert_eq!(
        adapter.maximum.load(Ordering::SeqCst),
        options.max_concurrency
    );
    let captured = events.events.lock().unwrap();
    assert_eq!(
        captured
            .iter()
            .filter(|event| matches!(event.kind, RuntimeEventKind::RequestStarted))
            .count(),
        total_requests
    );
    assert_eq!(
        captured
            .iter()
            .filter(|event| matches!(event.kind, RuntimeEventKind::AttemptStarted { .. }))
            .count(),
        total_requests
    );
    assert_eq!(
        captured
            .iter()
            .filter(|event| matches!(event.kind, RuntimeEventKind::RequestSucceeded { .. }))
            .count(),
        total_requests
    );
    assert!(!format!("{captured:?}").contains("secret-value"));
    drop(captured);

    let mut budget_options = options;
    budget_options.max_estimated_cost_usd = Some(0.0001);
    let mut budget_adapters = AdapterRegistry::new();
    budget_adapters
        .register("primary", Arc::new(FallbackAdapter))
        .unwrap();
    let budget_runtime =
        HarnessRuntime::new(budget_options, budget_adapters, RuntimePorts::default()).unwrap();
    let budget_results = budget_runtime
        .execute_batch(&requests, &ExecuteOptions::default())
        .unwrap();
    assert!(budget_results.iter().all(|result| {
        matches!(
            result,
            ModelResult::Failure(ModelFailure {
                kind: FailureKind::BudgetExhausted,
                ..
            })
        )
    }));
}

struct RejectingGuard;

impl InputGuard<()> for RejectingGuard {
    fn check(&self, _request: &ModelRequest<()>) -> Result<(), String> {
        Err("blocked by policy".to_owned())
    }
}

#[test]
fn runtime_guards_and_approval_fail_closed() {
    let mut adapters = AdapterRegistry::new();
    adapters
        .register("primary", Arc::new(FallbackAdapter))
        .unwrap();
    let mut guards = GuardRegistry::new();
    guards.register_input(Arc::new(RejectingGuard));
    let runtime = HarnessRuntime::new(
        test_options(),
        adapters,
        RuntimePorts {
            guards,
            ..RuntimePorts::default()
        },
    )
    .unwrap();
    let result = runtime.execute(test_request("guarded"), &ExecuteOptions::default());
    assert!(matches!(
        result,
        ModelResult::Failure(ModelFailure {
            kind: FailureKind::GuardRejected,
            ..
        })
    ));

    let mut adapters = AdapterRegistry::new();
    adapters
        .register("primary", Arc::new(FallbackAdapter))
        .unwrap();
    let runtime = HarnessRuntime::new(test_options(), adapters, RuntimePorts::default()).unwrap();
    let result = runtime.execute(
        test_request("approval"),
        &ExecuteOptions {
            approval_reason: Some("external side effect".to_owned()),
            ..ExecuteOptions::default()
        },
    );
    assert!(matches!(
        result,
        ModelResult::Failure(ModelFailure {
            kind: FailureKind::ApprovalRequired,
            ..
        })
    ));
}

struct ConcurrentAdapter {
    active: AtomicUsize,
    maximum: AtomicUsize,
}

impl ModelAdapter<(), String> for ConcurrentAdapter {
    fn invoke(
        &self,
        _request: &ModelRequest<()>,
        _context: &InvocationContext,
    ) -> ModelResult<String> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum.fetch_max(active, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(1));
        self.active.fetch_sub(1, Ordering::SeqCst);
        ModelResult::Success {
            value: "fresh".to_owned(),
            usage: Usage::default(),
        }
    }
}

#[test]
fn runtime_batch_concurrency_is_bounded() {
    let adapter = Arc::new(ConcurrentAdapter {
        active: AtomicUsize::new(0),
        maximum: AtomicUsize::new(0),
    });
    let mut adapters = AdapterRegistry::new();
    adapters.register("primary", adapter.clone()).unwrap();
    let mut options = test_options();
    options.max_concurrency = 1;
    let runtime = HarnessRuntime::new(options, adapters, RuntimePorts::default()).unwrap();
    let results = runtime
        .execute_batch(
            &[
                test_request("one"),
                test_request("two"),
                test_request("three"),
            ],
            &ExecuteOptions::default(),
        )
        .unwrap();
    assert_eq!(results.len(), 3);
    assert_eq!(adapter.maximum.load(Ordering::SeqCst), 1);
}

struct FailingCache;

impl runtime::CachePort<String> for FailingCache {
    fn get(&self, _key: &str) -> Result<Option<String>, String> {
        Err("cache unavailable".to_owned())
    }

    fn set(&self, _key: &str, _value: &String) -> Result<(), String> {
        Err("cache unavailable".to_owned())
    }
}

#[test]
fn cache_failures_are_contained_and_observable() {
    let mut adapters = AdapterRegistry::new();
    adapters
        .register("primary", Arc::new(FallbackAdapter))
        .unwrap();
    let events = Arc::new(MemoryEvents::default());
    let runtime = HarnessRuntime::new(
        test_options(),
        adapters,
        RuntimePorts {
            events: Some(events.clone()),
            cache: Some(Arc::new(FailingCache)),
            ..RuntimePorts::default()
        },
    )
    .unwrap();
    let result = runtime.execute(
        test_request("cache"),
        &ExecuteOptions {
            cache_key: Some("one".to_owned()),
            ..ExecuteOptions::default()
        },
    );
    assert!(matches!(result, ModelResult::Success { .. }));
    let captured = events.events.lock().unwrap();
    assert!(captured
        .iter()
        .any(|event| matches!(event.kind, RuntimeEventKind::CacheReadFailed)));
    assert!(captured
        .iter()
        .any(|event| matches!(event.kind, RuntimeEventKind::CacheWriteFailed)));
}
`;

export const rustRuntime = createRuntimeTemplate({
  id: "rust-runtime",
  language: "rust",
  displayName: "Rust",
  fileName: "runtime.rs",
  source: SOURCE,
  testFileName: "runtime_test.rs",
  testSource: TEST_SOURCE,
  policyArtifact: rustPolicyArtifact,
  modules: rustRuntimeModules,
  integrations: rustIntegrations,
  providers: rustProviders
});

export function createRustRuntimeLoader() {
  return runtimeLoader(rustRuntime);
}

export const rustRuntimeLoader = createRustRuntimeLoader();
