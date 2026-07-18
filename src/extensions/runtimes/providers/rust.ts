import type { ProviderIntegrationDefinition } from "../shared.js";

const responses = `use crate::runtime::{
    AdapterRegistry, FailureKind, InvocationContext, ModelAdapter, ModelFailure, ModelRequest,
    ModelResult, Usage,
};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponsesProvider {
    OpenRouter,
    Xai,
}

#[derive(Clone, Debug)]
pub enum ResponsesInputValue {
    Text(String),
    Items(Vec<BTreeMap<String, String>>),
}

#[derive(Clone, Debug)]
pub struct ResponsesInput {
    pub input: ResponsesInputValue,
    pub tools: Vec<BTreeMap<String, String>>,
    pub text: Option<BTreeMap<String, String>>,
    pub reasoning: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResponsesOutput {
    pub id: String,
    pub status: String,
    pub text: String,
    pub output: Vec<BTreeMap<String, String>>,
}

#[derive(Clone, Debug)]
pub struct ResponsesAdapterConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key_environment: String,
    pub headers: BTreeMap<String, String>,
    pub timeout: Duration,
    pub input_cost_per_million_tokens: f64,
    pub output_cost_per_million_tokens: f64,
    pub cost_tick_divisor: Option<f64>,
    pub max_response_bytes: usize,
}

impl ResponsesAdapterConfig {
    pub fn for_provider(provider: ResponsesProvider, model: impl Into<String>) -> Self {
        let (endpoint, api_key_environment, cost_tick_divisor) = match provider {
            ResponsesProvider::OpenRouter => (
                "https://openrouter.ai/api/v1/responses",
                "OPENROUTER_API_KEY",
                None,
            ),
            ResponsesProvider::Xai => (
                "https://api.x.ai/v1/responses",
                "XAI_API_KEY",
                Some(10_000_000_000.0),
            ),
        };
        Self {
            endpoint: endpoint.to_owned(),
            model: model.into(),
            api_key_environment: api_key_environment.to_owned(),
            headers: BTreeMap::new(),
            timeout: Duration::from_secs(30),
            input_cost_per_million_tokens: 0.0,
            output_cost_per_million_tokens: 0.0,
            cost_tick_divisor,
            max_response_bytes: 4 * 1024 * 1024,
        }
    }
}

pub trait SecretResolver: Send + Sync {
    fn resolve(&self, environment_variable: &str) -> Option<String>;
}

impl<F> SecretResolver for F
where
    F: Fn(&str) -> Option<String> + Send + Sync,
{
    fn resolve(&self, environment_variable: &str) -> Option<String> {
        self(environment_variable)
    }
}

#[derive(Clone, Debug)]
pub struct ResponsesTransportRequest {
    pub endpoint: String,
    pub headers: BTreeMap<String, String>,
    pub model: String,
    pub input: ResponsesInput,
    pub max_output_tokens: u64,
    pub store: bool,
    pub stream: bool,
    pub timeout: Duration,
    pub max_response_bytes: usize,
}

#[derive(Clone, Debug, Default)]
pub struct ResponsesTransportUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_in_usd_ticks: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct ResponsesTransportError {
    pub message: String,
    pub code: String,
}

#[derive(Clone, Debug)]
pub struct ResponsesTransportResponse {
    pub status_code: u16,
    pub id: String,
    pub status: String,
    pub text: String,
    pub output: Vec<BTreeMap<String, String>>,
    pub usage: ResponsesTransportUsage,
    pub error: Option<ResponsesTransportError>,
    pub encoded_size_bytes: usize,
}

// Implement this port with reqwest, ureq, or the consuming application's HTTP stack.
// The transport must stop reading after request.max_response_bytes + 1 bytes.
pub trait ResponsesTransport: Send + Sync {
    fn send(
        &self,
        request: &ResponsesTransportRequest,
        context: &InvocationContext,
    ) -> Result<ResponsesTransportResponse, String>;
}

pub struct ResponsesApiAdapter {
    config: ResponsesAdapterConfig,
    secrets: Arc<dyn SecretResolver>,
    transport: Arc<dyn ResponsesTransport>,
}

impl ResponsesApiAdapter {
    pub fn new(
        config: ResponsesAdapterConfig,
        secrets: Arc<dyn SecretResolver>,
        transport: Arc<dyn ResponsesTransport>,
    ) -> Result<Self, String> {
        validate_endpoint(&config.endpoint)?;
        if config.model.trim().is_empty() {
            return Err("model must not be empty".to_owned());
        }
        if config.api_key_environment.trim().is_empty() {
            return Err("api_key_environment must not be empty".to_owned());
        }
        if config.timeout.is_zero() {
            return Err("timeout must be positive".to_owned());
        }
        if config.max_response_bytes == 0 {
            return Err("max_response_bytes must be positive".to_owned());
        }
        Ok(Self {
            config,
            secrets,
            transport,
        })
    }
}

fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let lower = endpoint.to_ascii_lowercase();
    let local = lower.starts_with("http://localhost/")
        || lower.starts_with("http://localhost:")
        || lower.starts_with("http://127.0.0.1/")
        || lower.starts_with("http://127.0.0.1:");
    if !lower.starts_with("https://") && !local {
        return Err("endpoint must use HTTPS except for local tests".to_owned());
    }
    let authority = endpoint
        .split("//")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    if authority.is_empty() {
        return Err("endpoint must be an absolute URL".to_owned());
    }
    if authority.contains('@') {
        return Err("endpoint must not contain credentials".to_owned());
    }
    Ok(())
}

fn redact(value: &str, secret: &str) -> String {
    if secret.is_empty() {
        value.to_owned()
    } else {
        value.replace(secret, "[REDACTED]")
    }
}

fn failure(
    message: &str,
    retryable: bool,
    code: &str,
    secret: &str,
) -> ModelResult<ResponsesOutput> {
    ModelResult::Failure(ModelFailure {
        kind: FailureKind::Provider,
        message: redact(message, secret),
        retryable,
        provider_code: Some(redact(code, secret)),
    })
}

impl ModelAdapter<ResponsesInput, ResponsesOutput> for ResponsesApiAdapter {
    fn invoke(
        &self,
        request: &ModelRequest<ResponsesInput>,
        context: &InvocationContext,
    ) -> ModelResult<ResponsesOutput> {
        if context.cancellation.is_cancelled() {
            return ModelResult::Failure(ModelFailure {
                kind: FailureKind::Cancelled,
                message: "The provider request was cancelled.".to_owned(),
                retryable: false,
                provider_code: None,
            });
        }
        let Some(api_key) = self.secrets.resolve(&self.config.api_key_environment) else {
            return failure(
                "The configured API key environment variable is unavailable.",
                false,
                "missing_credentials",
                "",
            );
        };
        if api_key.is_empty() {
            return failure(
                "The configured API key environment variable is unavailable.",
                false,
                "missing_credentials",
                "",
            );
        }
        let mut headers = self.config.headers.clone();
        headers.insert("Content-Type".to_owned(), "application/json".to_owned());
        headers.insert("Authorization".to_owned(), "Bearer ".to_owned() + &api_key);
        let transport_request = ResponsesTransportRequest {
            endpoint: self.config.endpoint.clone(),
            headers,
            model: self.config.model.clone(),
            input: request.input.clone(),
            max_output_tokens: request.max_output_tokens,
            store: false,
            stream: false,
            timeout: self.config.timeout,
            max_response_bytes: self.config.max_response_bytes,
        };
        let response = match self.transport.send(&transport_request, context) {
            Ok(response) => response,
            Err(error) => return failure(&error, true, "network_error", &api_key),
        };
        if response.encoded_size_bytes > self.config.max_response_bytes {
            return failure(
                "The provider response exceeded the size limit.",
                false,
                "response_too_large",
                "",
            );
        }
        if !(200..300).contains(&response.status_code)
            || response.error.is_some()
            || response.status == "failed"
        {
            let provider_error = response.error.unwrap_or(ResponsesTransportError {
                message: "The provider rejected the request.".to_owned(),
                code: response.status_code.to_string(),
            });
            let retryable = response.status_code == 408
                || response.status_code == 429
                || response.status_code >= 500;
            return failure(
                &provider_error.message,
                retryable,
                &provider_error.code,
                &api_key,
            );
        }
        let estimated_cost_usd = match (
            response.usage.cost_in_usd_ticks,
            self.config.cost_tick_divisor,
        ) {
            (Some(ticks), Some(divisor)) if divisor > 0.0 => ticks / divisor,
            _ => {
                (response.usage.input_tokens as f64 * self.config.input_cost_per_million_tokens
                    + response.usage.output_tokens as f64
                        * self.config.output_cost_per_million_tokens)
                    / 1_000_000.0
            }
        };
        ModelResult::Success {
            value: ResponsesOutput {
                id: response.id,
                status: if response.status.is_empty() {
                    "completed".to_owned()
                } else {
                    response.status
                },
                text: response.text,
                output: response.output,
            },
            usage: Usage {
                input_tokens: response.usage.input_tokens,
                output_tokens: response.usage.output_tokens,
                estimated_cost_usd,
            },
        }
    }
}

pub fn register_responses_adapter(
    registry: &mut AdapterRegistry<ResponsesInput, ResponsesOutput>,
    route: impl Into<String>,
    config: ResponsesAdapterConfig,
    secrets: Arc<dyn SecretResolver>,
    transport: Arc<dyn ResponsesTransport>,
) -> Result<Arc<ResponsesApiAdapter>, String> {
    let adapter = Arc::new(ResponsesApiAdapter::new(config, secrets, transport)?);
    registry.register(route, adapter.clone())?;
    Ok(adapter)
}
`;

const tests = `#[path = "responses_provider.rs"]
mod responses_provider;
#[path = "runtime.rs"]
mod runtime;

const CONFORMANCE: &str = include_str!("conformance.json");

use responses_provider::*;
use runtime::{
    AdapterRegistry, CancellationToken, InvocationContext, ModelAdapter, ModelRequest, ModelResult,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct FakeTransport {
    response: ResponsesTransportResponse,
    authorization: Mutex<String>,
}

impl ResponsesTransport for FakeTransport {
    fn send(
        &self,
        request: &ResponsesTransportRequest,
        _context: &InvocationContext,
    ) -> Result<ResponsesTransportResponse, String> {
        *self.authorization.lock().unwrap() = request.headers["Authorization"].clone();
        Ok(self.response.clone())
    }
}

fn request() -> ModelRequest<ResponsesInput> {
    ModelRequest {
        id: "provider-1".to_owned(),
        route: "primary".to_owned(),
        prompt_version: "v1".to_owned(),
        input: ResponsesInput {
            input: ResponsesInputValue::Text("hello".to_owned()),
            tools: Vec::new(),
            text: None,
            reasoning: None,
        },
        input_tokens: 1,
        max_output_tokens: 20,
        metadata: BTreeMap::new(),
    }
}

fn context() -> InvocationContext {
    InvocationContext {
        deadline: Instant::now() + Duration::from_secs(30),
        cancellation: CancellationToken::default(),
    }
}

fn success_response() -> ResponsesTransportResponse {
    ResponsesTransportResponse {
        status_code: 200,
        id: "response-1".to_owned(),
        status: "completed".to_owned(),
        text: "world".to_owned(),
        output: Vec::new(),
        usage: ResponsesTransportUsage {
            input_tokens: 2,
            output_tokens: 3,
            cost_in_usd_ticks: None,
        },
        error: None,
        encoded_size_bytes: 128,
    }
}

#[test]
fn classifies_shared_provider_failure_vector() {
    assert!(CONFORMANCE.contains(r#""id": "http-200-failed-response""#));
    assert!(CONFORMANCE.contains(r#""providerCode": "response_failed""#));
    let transport = Arc::new(FakeTransport {
        response: ResponsesTransportResponse {
            status: "failed".to_owned(),
            error: Some(ResponsesTransportError {
                message: "provider rejected response".to_owned(),
                code: "response_failed".to_owned(),
            }),
            ..success_response()
        },
        authorization: Mutex::new(String::new()),
    });
    let adapter = ResponsesApiAdapter::new(
        ResponsesAdapterConfig::for_provider(ResponsesProvider::OpenRouter, "test/model"),
        Arc::new(|_: &str| Some("secret".to_owned())),
        transport,
    )
    .unwrap();
    match adapter.invoke(&request(), &context()) {
        ModelResult::Failure(failure) => {
            assert_eq!(failure.kind, runtime::FailureKind::Provider);
            assert_eq!(failure.provider_code.as_deref(), Some("response_failed"));
            assert!(!failure.retryable);
        }
        ModelResult::Success { .. } => panic!("failed response was classified as success"),
    }
}

#[test]
fn maps_output_usage_and_registration() {
    let transport = Arc::new(FakeTransport {
        response: success_response(),
        authorization: Mutex::new(String::new()),
    });
    let mut config =
        ResponsesAdapterConfig::for_provider(ResponsesProvider::OpenRouter, "test/model");
    config.input_cost_per_million_tokens = 1.0;
    config.output_cost_per_million_tokens = 2.0;
    let mut registry = AdapterRegistry::new();
    let adapter = register_responses_adapter(
        &mut registry,
        "primary",
        config,
        Arc::new(|_: &str| Some("test-secret".to_owned())),
        transport.clone(),
    )
    .unwrap();
    match adapter.invoke(&request(), &context()) {
        ModelResult::Success { value, usage } => {
            assert_eq!(value.text, "world");
            assert_eq!(usage.estimated_cost_usd, 0.000008);
        }
        ModelResult::Failure(failure) => panic!("unexpected failure: {}", failure.message),
    }
    assert_eq!(
        *transport.authorization.lock().unwrap(),
        "Bearer test-secret"
    );
}

#[test]
fn redacts_rate_limit_errors() {
    let secret = "credential-that-must-not-leak";
    let transport = Arc::new(FakeTransport {
        response: ResponsesTransportResponse {
            status_code: 429,
            error: Some(ResponsesTransportError {
                message: secret.to_owned(),
                code: secret.to_owned(),
            }),
            ..success_response()
        },
        authorization: Mutex::new(String::new()),
    });
    let adapter = ResponsesApiAdapter::new(
        ResponsesAdapterConfig::for_provider(ResponsesProvider::Xai, "grok-test"),
        Arc::new(move |_: &str| Some(secret.to_owned())),
        transport,
    )
    .unwrap();
    match adapter.invoke(&request(), &context()) {
        ModelResult::Failure(failure) => {
            assert!(failure.retryable);
            assert!(!failure.message.contains(secret));
            assert!(!failure.provider_code.unwrap().contains(secret));
        }
        ModelResult::Success { .. } => panic!("expected a failure"),
    }
}

#[test]
fn fails_closed_for_missing_credentials_and_unsafe_endpoints() {
    let transport = Arc::new(FakeTransport {
        response: success_response(),
        authorization: Mutex::new(String::new()),
    });
    let adapter = ResponsesApiAdapter::new(
        ResponsesAdapterConfig::for_provider(ResponsesProvider::OpenRouter, "test/model"),
        Arc::new(|_: &str| None),
        transport.clone(),
    )
    .unwrap();
    match adapter.invoke(&request(), &context()) {
        ModelResult::Failure(failure) => {
            assert_eq!(
                failure.provider_code.as_deref(),
                Some("missing_credentials")
            );
        }
        ModelResult::Success { .. } => panic!("expected a failure"),
    }
    let mut unsafe_config =
        ResponsesAdapterConfig::for_provider(ResponsesProvider::OpenRouter, "test/model");
    unsafe_config.endpoint = "http://example.com".to_owned();
    assert!(ResponsesApiAdapter::new(
        unsafe_config,
        Arc::new(|_: &str| Some("secret".to_owned())),
        transport,
    )
    .is_err());
}

#[test]
fn rejects_oversized_transport_responses() {
    let transport = Arc::new(FakeTransport {
        response: ResponsesTransportResponse {
            encoded_size_bytes: 9,
            ..success_response()
        },
        authorization: Mutex::new(String::new()),
    });
    let mut config =
        ResponsesAdapterConfig::for_provider(ResponsesProvider::OpenRouter, "test/model");
    config.max_response_bytes = 8;
    let adapter = ResponsesApiAdapter::new(
        config,
        Arc::new(|_: &str| Some("secret".to_owned())),
        transport,
    )
    .unwrap();
    match adapter.invoke(&request(), &context()) {
        ModelResult::Failure(failure) => {
            assert_eq!(failure.provider_code.as_deref(), Some("response_too_large"));
        }
        ModelResult::Success { .. } => panic!("expected a failure"),
    }
}
`;

export const rustProviders: readonly ProviderIntegrationDefinition[] = [
  {
    targets: ["openrouter", "xai-api"],
    artifacts: [
      { path: "responses_provider.rs", source: responses },
      { path: "responses_provider_test.rs", source: tests }
    ]
  }
];
