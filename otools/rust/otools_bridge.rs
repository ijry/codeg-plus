use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;
use tower::util::ServiceExt;

use crate::app_state::AppState;
use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};
use crate::web::{find_static_dir_standalone, generate_random_token, WebServerState};

static OTOOLS_RUNTIME: OnceLock<Arc<OtoolsPluginRuntime>> = OnceLock::new();
static OTOOLS_RUNTIME_BLOCKING_GATE: Mutex<()> = Mutex::new(());
static OTOOLS_TOKIO_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub struct OtoolsPluginRuntime {
    state: Arc<AppState>,
    router: Router,
    token: String,
    queue: Arc<AsyncMutex<VecDeque<Value>>>,
    #[cfg(test)]
    test_root: Option<PathBuf>,
}

impl OtoolsPluginRuntime {
    pub async fn invoke(&self, command: &str, payload: Value) -> Result<Value, String> {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/{command}"))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {}", self.token))
            .body(Body::from(payload.to_string()))
            .map_err(|error| format!("build request failed: {error}"))?;

        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .map_err(|error| format!("invoke routing failed: {error}"))?;

        decode_json_response(response).await
    }

    pub async fn poll_events(&self) -> Result<Vec<Value>, String> {
        let mut queue = self.queue.lock().await;
        Ok(queue.drain(..).collect())
    }

    #[cfg(test)]
    pub async fn for_tests() -> Self {
        let test_root = build_test_root_dir();
        std::fs::create_dir_all(&test_root).expect("create test root");
        std::fs::create_dir_all(test_root.join("static")).expect("create static dir");
        std::fs::write(test_root.join("static").join("index.html"), "<!doctype html>")
            .expect("write index.html");

        Self::build(test_root.join("data"), test_root.join("static"), false, Some(test_root))
            .await
            .expect("create otools plugin runtime for tests")
    }

    #[cfg(test)]
    pub async fn emit_test_event(&self, topic: &str, payload: Value) {
        self.state
            .event_broadcaster
            .send_value(topic, Arc::new(payload));
        tokio::task::yield_now().await;
    }

    async fn build(
        data_dir: PathBuf,
        static_dir: PathBuf,
        install_experts: bool,
        test_root: Option<PathBuf>,
    ) -> Result<Self, String> {
        #[cfg(not(test))]
        let _ = &test_root;

        let app_version = env!("CARGO_PKG_VERSION");
        let db = crate::db::init_database(&data_dir, app_version)
            .await
            .map_err(|error| format!("failed to initialize database: {error}"))?;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::WebOnly(broadcaster.clone());
        let state = Arc::new(AppState {
            db,
            connection_manager: crate::app_state::default_connection_manager(),
            terminal_manager: crate::app_state::default_terminal_manager(),
            event_broadcaster: broadcaster,
            emitter,
            data_dir,
            web_server_state: WebServerState::new(),
            chat_channel_manager: crate::app_state::default_chat_channel_manager(),
        });
        let token = generate_random_token();
        let shutdown_signal = state.web_server_state.shutdown_signal();
        let router = crate::web::router::build_router(
            state.clone(),
            token.clone(),
            static_dir,
            shutdown_signal,
        );
        let queue = Arc::new(AsyncMutex::new(VecDeque::new()));

        let runtime = Self {
            state: state.clone(),
            router,
            token,
            queue: queue.clone(),
            #[cfg(test)]
            test_root,
        };
        runtime.start_event_bridge();
        runtime.start_background_tasks(install_experts).await;

        Ok(runtime)
    }

    fn start_event_bridge(&self) {
        let mut receiver = self.state.event_broadcaster.subscribe();
        let queue = self.queue.clone();

        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(message) => {
                        let mut guard = queue.lock().await;
                        guard.push_back(json!({
                            "topic": message.channel,
                            "payload": message.payload.as_ref(),
                        }));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    async fn start_background_tasks(&self, install_experts: bool) {
        if install_experts {
            std::thread::spawn(|| {
                let _ = std::panic::catch_unwind(|| {
                    crate::sweep_acp_binary_trash();
                });
            });

            tokio::spawn(async move {
                let report = crate::commands::experts::ensure_central_experts_installed().await;
                if !report.errors.is_empty() {
                    eprintln!(
                        "[Experts] install finished with {} error(s): {:?}",
                        report.errors.len(),
                        report.errors
                    );
                } else {
                    eprintln!(
                        "[Experts] install ok: installed={} updated={} pending_review={}",
                        report.installed_count,
                        report.updated_count,
                        report.pending_user_review.len()
                    );
                }
            });
        }

        self.state
            .chat_channel_manager
            .start_background(
                self.state.event_broadcaster.clone(),
                self.state.db.conn.clone(),
                self.state.connection_manager.clone_ref(),
                self.state.emitter.clone(),
            )
            .await;

        tokio::spawn(crate::lifecycle_subscriber_task(
            self.state.db.conn.clone(),
            self.state.connection_manager.clone_ref(),
            self.state.event_broadcaster.clone(),
        ));

        if let Some(idle_timeout) = crate::idle_timeout_from_env() {
            tokio::spawn(crate::idle_sweep_task(
                self.state.connection_manager.clone_ref(),
                idle_timeout,
                std::time::Duration::from_secs(crate::SWEEP_INTERVAL_SECS),
            ));
        }
    }
}

impl Drop for OtoolsPluginRuntime {
    fn drop(&mut self) {
        #[cfg(test)]
        if let Some(root) = self.test_root.take() {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

pub fn invoke_blocking(method: &str, payload: Value) -> Result<Value, String> {
    let _gate = OTOOLS_RUNTIME_BLOCKING_GATE
        .lock()
        .map_err(|_| "otools runtime lock poisoned".to_string())?;

    blocking_runtime()
        .block_on(async {
            let runtime = shared_runtime().await?;
            runtime.invoke(method, payload).await
        })
}

pub fn poll_events_blocking() -> Result<Vec<Value>, String> {
    let _gate = OTOOLS_RUNTIME_BLOCKING_GATE
        .lock()
        .map_err(|_| "otools runtime lock poisoned".to_string())?;

    blocking_runtime()
        .block_on(async {
            let runtime = shared_runtime().await?;
            runtime.poll_events().await
        })
}

fn blocking_runtime() -> &'static tokio::runtime::Runtime {
    OTOOLS_TOKIO_RUNTIME.get_or_init(|| {
        crate::process::ensure_node_in_path();
        crate::process::ensure_user_npm_prefix_in_path();

        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap_or_else(|error| panic!("failed to create otools tokio runtime: {error}"))
    })
}

async fn shared_runtime() -> Result<Arc<OtoolsPluginRuntime>, String> {
    if let Some(runtime) = OTOOLS_RUNTIME.get() {
        return Ok(runtime.clone());
    }

    let data_dir = default_data_dir();
    let explicit_static_dir = std::env::var("CODEG_STATIC_DIR").ok();
    let static_dir = find_static_dir_standalone(explicit_static_dir.as_deref());
    let runtime = Arc::new(
        OtoolsPluginRuntime::build(data_dir, static_dir, true, None)
            .await
            .map_err(|error| format!("failed to initialize otools runtime: {error}"))?,
    );

    if OTOOLS_RUNTIME.set(runtime.clone()).is_ok() {
        Ok(runtime)
    } else {
        OTOOLS_RUNTIME
            .get()
            .cloned()
            .ok_or_else(|| "otools runtime unavailable after initialization".to_string())
    }
}

fn default_data_dir() -> PathBuf {
    dirs::data_dir()
        .map(|dir| dir.join("codeg"))
        .unwrap_or_else(|| PathBuf::from(".codeg-data"))
}

async fn decode_json_response(response: axum::response::Response) -> Result<Value, String> {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .map_err(|error| format!("read response failed: {error}"))?;

    if !status.is_success() {
        return Err(render_error_response(status, &bytes));
    }

    serde_json::from_slice(&bytes).map_err(|error| {
        let raw = String::from_utf8_lossy(&bytes);
        format!("decode response failed: {error}; body={raw}")
    })
}

fn render_error_response(status: StatusCode, bytes: &[u8]) -> String {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(value) => {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("request failed");
            let detail = value.get("detail").and_then(Value::as_str).unwrap_or_default();
            if detail.is_empty() {
                format!("{message} ({status})")
            } else {
                format!("{message} ({status}): {detail}")
            }
        }
        Err(_) => {
            let raw = String::from_utf8_lossy(bytes);
            format!("request failed ({status}): {raw}")
        }
    }
}

#[cfg(test)]
fn build_test_root_dir() -> PathBuf {
    std::env::temp_dir().join(format!("codeg-otools-test-{}", uuid::Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn open_settings_window_returns_web_path_without_http_server() {
        let runtime = OtoolsPluginRuntime::for_tests().await;
        let value = runtime
            .invoke("open_settings_window", json!({ "section": "system" }))
            .await
            .expect("invoke");
        assert_eq!(value["path"], "/settings/system");
    }

    #[tokio::test]
    async fn poll_events_drains_buffered_backend_events() {
        let runtime = OtoolsPluginRuntime::for_tests().await;
        runtime
            .emit_test_event("acp://event", json!({ "seq": 1 }))
            .await;

        let drained = runtime.poll_events().await.expect("poll_events");
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0]["topic"], "acp://event");
        assert_eq!(drained[0]["payload"]["seq"], 1);

        let empty = runtime.poll_events().await.expect("poll_events second");
        assert!(empty.is_empty());
    }

    #[tokio::test]
    async fn open_project_boot_window_returns_popup_path() {
        let runtime = OtoolsPluginRuntime::for_tests().await;
        let value = runtime
            .invoke("open_project_boot_window", json!({ "source": "toolbar" }))
            .await
            .expect("invoke");
        assert_eq!(value["path"], "/project-boot");
    }
}
