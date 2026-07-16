import { createRuntimeTemplate, runtimeLoader } from "./shared.js";

const SOURCE = `use std::collections::BTreeMap;
use std::time::{Duration, Instant};

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

#[derive(Clone, Debug)]
pub struct ModelRequest<T> {
    pub id: String,
    pub route: String,
    pub prompt_version: String,
    pub input: T,
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

pub trait ModelAdapter<I, O> {
    fn invoke(&self, request: &ModelRequest<I>) -> ModelResult<O>;
}

pub trait EventSink {
    fn emit(&self, event: &BTreeMap<String, String>) -> Result<(), String>;
}

pub trait Guard<T> {
    fn check(&self, request: &ModelRequest<T>) -> Result<(), String>;
}

pub trait CachePort<T> {
    fn get(&self, key: &str) -> Result<Option<T>, String>;
    fn set(&self, key: &str, value: &T) -> Result<(), String>;
}

pub trait ApprovalPort<T> {
    fn approve(&self, request: &ModelRequest<T>, reason: &str) -> Result<bool, String>;
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
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, reset_after: Duration) -> Result<Self, &'static str> {
        if failure_threshold == 0 || reset_after.is_zero() {
            return Err("circuit breaker limits must be positive");
        }
        Ok(Self {
            state: CircuitState::Closed,
            failures: 0,
            opened_at: None,
            failure_threshold,
            reset_after,
        })
    }

    pub fn state(&mut self, now: Instant) -> CircuitState {
        if self.state == CircuitState::Open
            && self.opened_at.is_some_and(|opened| now.duration_since(opened) >= self.reset_after)
        {
            self.state = CircuitState::HalfOpen;
        }
        self.state
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        self.state(now) != CircuitState::Open
    }

    pub fn success(&mut self) {
        self.state = CircuitState::Closed;
        self.failures = 0;
        self.opened_at = None;
    }

    pub fn failure(&mut self, now: Instant) {
        self.failures = self.failures.saturating_add(1);
        if self.state == CircuitState::HalfOpen || self.failures >= self.failure_threshold {
            self.state = CircuitState::Open;
            self.opened_at = Some(now);
        }
    }
}
`;

export const rustRuntime = createRuntimeTemplate({
  id: "rust-runtime",
  language: "rust",
  displayName: "Rust",
  fileName: "runtime.rs",
  source: SOURCE
});

export function createRustRuntimeLoader() {
  return runtimeLoader(rustRuntime);
}

export const rustRuntimeLoader = createRustRuntimeLoader();
