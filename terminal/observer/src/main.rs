//! One-request terminal observer using the native read contracts and transports.
//!
//! The parent writes one JSON line and keeps stdin open until the response. EOF
//! cancels the read; only an observer-owned source frontend is killed and reaped.

// The shared desktop modules contain additional resources/helpers intentionally
// unused by this narrower executable; no extra route is exposed by linking them.
// Desktop dispatch helpers; the terminal only routes Worktree reads through mcp.rs.
#[allow(dead_code)]
#[path = "../../../src-tauri/src/adapters.rs"]
mod adapters;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/config.rs"]
mod config;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/contract.rs"]
mod contract;
#[path = "../../../src-tauri/src/mcp.rs"]
mod mcp;
#[cfg(unix)]
mod pool_socket;
#[allow(dead_code)]
#[path = "../../../src-tauri/src/process.rs"]
mod process;
#[cfg(unix)]
mod quota;
#[cfg(unix)]
#[path = "../../../src-tauri/src/run.rs"]
mod run;

use config::Connections;
use contract::{FRAME_LIMIT, READ_TIMEOUT, ReadError, ReadRequest, ReadResponse, Resource};
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read, Write},
    path::PathBuf,
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{oneshot, watch};

/// One identity response can combine three independently bounded producer frames.
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;

/// Bounds runtime shutdown even if a malformed config path blocks a filesystem worker.
fn main() {
    if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        runtime.block_on(serve());
        runtime.shutdown_timeout(Duration::from_secs(1));
    }
}

/// Runs one finite request; stdin/output blocking threads own no source process.
/// Ordinary threads let process exit terminate a blocked parent pipe without
/// leaving Tokio blocking tasks that would hold runtime shutdown indefinitely.
async fn serve() {
    let (input_tx, input_rx) = oneshot::channel();
    let (cancel_tx, mut cancel) = watch::channel(false);
    let reader = std::thread::Builder::new()
        .name("observer-stdin".into())
        .spawn(move || {
            let mut input = std::io::BufReader::new(std::io::stdin());
            let mut line = Vec::new();
            let result = input
                .by_ref()
                .take((FRAME_LIMIT + 1) as u64)
                .read_until(b'\n', &mut line)
                .map_err(|_| ReadError::invalid("request_read"))
                .and_then(|_| {
                    if line.len() > FRAME_LIMIT {
                        Err(ReadError::invalid("request_budget"))
                    } else if !line.ends_with(b"\n") {
                        Err(ReadError::invalid("request_frame"))
                    } else {
                        Ok(line)
                    }
                });
            if input_tx.send(result).is_err() {
                return;
            }
            // EOF, a read error, or any second request closes this single-call
            // session. No second frame can dispatch another source operation.
            let _ = input.read(&mut [0_u8; 1]);
            let _ = cancel_tx.send(true);
        });
    let received = if reader.is_err() {
        Err(ReadError::unavailable("stdin_thread"))
    } else {
        match tokio::time::timeout(READ_TIMEOUT, input_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ReadError::unavailable("request_read")),
            Err(_) => Err(ReadError::unavailable("request_timeout")),
        }
    };
    let response = match received {
        Ok(line) => match serde_json::from_slice::<ReadRequest>(&line) {
            Ok(request) => {
                let result = observe(&request, &mut cancel).await;
                encode_response(ReadResponse::from_result(request.resource, result))
            }
            Err(_) => {
                let resource = serde_json::from_slice::<Value>(&line)
                    .ok()
                    .and_then(|value| value.get("resource").cloned())
                    .and_then(|value| serde_json::from_value::<Resource>(value).ok());
                failure_response(resource, ReadError::invalid("request_json"))
            }
        },
        Err(error) => failure_response(None, error),
    };
    let (written_tx, written_rx) = oneshot::channel();
    let writer = std::thread::Builder::new()
        .name("observer-stdout".into())
        .spawn(move || {
            let mut stdout = std::io::stdout().lock();
            let result = stdout.write_all(&response).and_then(|_| stdout.flush());
            let _ = written_tx.send(result);
        });
    if writer.is_ok() {
        // A parent that stops draining stdout cannot retain this finite adapter.
        let _ = tokio::time::timeout(READ_TIMEOUT, written_rx).await;
    }
}

/// Serializes a recognized read envelope with room for all identity discovery frames.
fn encode_response(response: ReadResponse) -> Vec<u8> {
    let resource = response.resource;
    match serde_json::to_vec(&response) {
        Ok(mut bytes) if bytes.len() < RESPONSE_LIMIT => {
            bytes.push(b'\n');
            bytes
        }
        _ => failure_response(Some(resource), ReadError::invalid("response_budget")),
    }
}

/// Produces a static safe failure; unidentifiable requests have null resource.
/// Unknown input text, source diagnostics and credential values are never echoed.
fn failure_response(resource: Option<Resource>, error: ReadError) -> Vec<u8> {
    let response = if let Some(resource) = resource {
        json!(ReadResponse::from_result(resource, Err(error)))
    } else {
        json!({
            "schema_version": 1,
            "source": "unknown",
            "resource": null,
            "observed_at_ms": SystemTime::now().duration_since(UNIX_EPOCH)
                .unwrap_or_default().as_millis().min(u64::MAX as u128) as u64,
            "outcome": error.outcome,
            "data": null,
            "error": error,
        })
    };
    let mut bytes = response.to_string().into_bytes();
    bytes.push(b'\n');
    bytes
}

/// Validates the narrower terminal allowlist before config or source I/O.
async fn observe(
    request: &ReadRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, ReadError> {
    if !matches!(
        request.resource,
        Resource::RunIdentity
            | Resource::RunAgents
            | Resource::RunStatus
            | Resource::RunTranscript
            | Resource::RunTranscriptExact
            | Resource::RunInitialTask
            | Resource::RunAnswer
            | Resource::RunAnswerChunk
            | Resource::RunModels
            | Resource::RunLimits
            | Resource::QuotaStatus
            | Resource::QuotaSnapshot
            | Resource::PoolIdentity
            | Resource::PoolList
            | Resource::PoolGet
            | Resource::PoolRunProof
            | Resource::PoolInventorySnapshot
            | Resource::PoolCompletionGet
            | Resource::PoolEnrollmentGet
            | Resource::BridgeIdentity
            | Resource::BridgeOverview
            | Resource::BridgeDeliveries
            | Resource::BridgeIncidents
            | Resource::HubRepositories
            | Resource::WorktreeIdentity
            | Resource::WorktreeList
            | Resource::WorktreeInspect
    ) {
        return Err(ReadError::invalid("resource_denied"));
    }
    request.validate()?;
    if extra_authority(&request.params) {
        return Err(ReadError::invalid("authority_denied"));
    }
    worktree_params(request)?;
    if *cancel.borrow() {
        return Err(ReadError::unavailable("cancelled"));
    }
    let app_config = app_config_dir()?;
    let config = tokio::select! {
        biased;
        _ = cancel.changed() => return Err(ReadError::unavailable("cancelled")),
        result = tokio::time::timeout(READ_TIMEOUT, Connections::load(&app_config)) =>
            result.map_err(|_| ReadError::unavailable("config_timeout"))??,
    };
    match request.resource.source() {
        "run" => read_run(&config, request, cancel).await,
        "quota" => read_quota(&config, request, cancel).await,
        "hub"
            if request
                .params
                .as_object()
                .is_some_and(|params| params.is_empty()) =>
        {
            Ok(json!({ "repositories": config.repositories }))
        }
        "hub" => Err(ReadError::invalid("hub_params")),
        "pool" | "bridge" => read_observer(&config, request, cancel).await,
        // A presentation-only isError flag keeps the validated structured payload.
        "worktree" => mcp::read(&config, request, cancel)
            .await
            .map(|(value, _)| value),
        _ => Err(ReadError::invalid("resource_denied")),
    }
}

/// Closes Worktree read arguments to the documented read-only shapes; size
/// measurement and discovery scans stay off unless explicitly bounded here.
fn worktree_params(request: &ReadRequest) -> Result<(), ReadError> {
    let Some(params) = request.params.as_object() else {
        return Ok(());
    };
    let text = |key: &str| {
        params
            .get(key)
            .is_none_or(|value| value.as_str().is_some_and(|text| !text.is_empty()))
    };
    let valid = match request.resource {
        Resource::WorktreeIdentity => params.is_empty(),
        Resource::WorktreeList => {
            params
                .keys()
                .all(|key| matches!(key.as_str(), "repo" | "cursor" | "limit" | "discovery"))
                && text("repo")
                && text("cursor")
                && params.get("limit").is_none_or(|limit| {
                    limit
                        .as_u64()
                        .is_some_and(|limit| (1..=20).contains(&limit))
                })
                && params.get("discovery").is_none_or(Value::is_boolean)
                && params
                    .get("repo")
                    .and_then(Value::as_str)
                    .is_none_or(|repo| repo.starts_with('/'))
        }
        Resource::WorktreeInspect => {
            params
                .keys()
                .all(|key| matches!(key.as_str(), "repo" | "name" | "path" | "checks"))
                && params
                    .get("repo")
                    .and_then(Value::as_str)
                    .is_some_and(|repo| repo.starts_with('/'))
                && params.contains_key("name") != params.contains_key("path")
                && text("name")
                && params
                    .get("path")
                    .is_none_or(|path| path.as_str().is_some_and(|path| path.starts_with('/')))
                && params.get("checks").is_none_or(|checks| {
                    checks.as_object().is_some_and(|checks| {
                        checks.iter().all(|(key, value)| {
                            matches!(
                                key.as_str(),
                                "status" | "integration" | "processes" | "submodules"
                            ) && value.is_boolean()
                        })
                    })
                })
        }
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(ReadError::invalid("worktree_params"))
    }
}

/// Rejects grant/assertion aliases in addition to the native recursive key guard.
fn extra_authority(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "grant"
                    | "grants"
                    | "assertion"
                    | "assertions"
                    | "authorization"
                    | "auth"
                    | "native_actor"
                    | "native_session"
                    | "session_token"
                    | "access_token"
                    | "api_key"
                    | "secret"
                    | "operation"
                    | "action"
                    | "env"
                    | "environment"
            ) || extra_authority(value)
        }),
        Value::Array(items) => items.iter().any(extra_authority),
        _ => false,
    }
}

/// Resolves Tauri's app-config location without linking its desktop runtime.
/// The shared loader still gives AGENT_HUB_CONFIG priority and checks absoluteness.
fn app_config_dir() -> Result<PathBuf, ReadError> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| ReadError::invalid("home_unavailable"))?;
    let base = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| ReadError::invalid("config_directory"))?
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"))
    };
    Ok(base.join("dev.agent-mcp.hub"))
}

/// Runs finite allowlisted RPCs, preserving native identity and capability checks.
#[cfg(unix)]
async fn read_run(
    config: &Connections,
    request: &ReadRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, ReadError> {
    if *cancel.borrow() {
        return Err(ReadError::unavailable("cancelled"));
    }
    let wait = if request.resource == Resource::RunAgents {
        request
            .params
            .get("wait_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(60)
    } else {
        0
    };
    let operation = async {
        if request.resource == Resource::RunAnswerChunk {
            let tools = run::call(&config.socket, config.broker_uid, "tools", json!({})).await?;
            if !advertises(&tools, "answer_chunk") {
                return Err(ReadError::incompatible("answer_chunk_unavailable"));
            }
        }
        let result = run::call(
            &config.socket,
            config.broker_uid,
            request.resource.method(),
            request.params.clone(),
        )
        .await?;
        if request.resource != Resource::RunIdentity {
            return Ok(result);
        }
        let tools = run::call(&config.socket, config.broker_uid, "tools", json!({})).await?;
        let capabilities = if advertises(&tools, "capabilities") {
            Some(
                run::capabilities(
                    &config.socket,
                    config.broker_uid,
                    advertises(&tools, "initial_task"),
                )
                .await?,
            )
        } else {
            None
        };
        let version = capabilities
            .as_ref()
            .and_then(|value| value.get("version"))
            .cloned()
            .unwrap_or(Value::Null);
        Ok(
            json!({"ping": result, "tools": tools, "capabilities": capabilities, "version": version}),
        )
    };
    tokio::select! {
        biased;
        _ = cancel.changed() => Err(ReadError::unavailable("cancelled")),
        result = tokio::time::timeout(READ_TIMEOUT + Duration::from_secs(wait), operation) =>
            result.unwrap_or_else(|_| Err(ReadError::unavailable("client_timeout"))),
    }
}

/// Reads one Quota status or snapshot from the configured trusted service socket.
#[cfg(unix)]
async fn read_quota(
    config: &Connections,
    request: &ReadRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, ReadError> {
    let (socket, server_uid) = config
        .quota
        .as_ref()
        .ok_or_else(|| ReadError::incompatible("not_configured"))?;
    tokio::select! {
        biased;
        _ = cancel.changed() => Err(ReadError::unavailable("cancelled")),
        result = tokio::time::timeout(
            READ_TIMEOUT,
            quota::call(socket, *server_uid, request.resource.method(), &request.params),
        ) => result.unwrap_or_else(|_| Err(ReadError::unavailable("client_timeout"))),
    }
}

/// Reports the unsupported Quota transport on hosts without Unix sockets.
#[cfg(not(unix))]
async fn read_quota(
    _config: &Connections,
    _request: &ReadRequest,
    _cancel: &mut watch::Receiver<bool>,
) -> Result<Value, ReadError> {
    Err(ReadError::incompatible("quota_platform"))
}

/// Reports the unsupported Run transport on hosts without Unix sockets.
#[cfg(not(unix))]
async fn read_run(
    _config: &Connections,
    _request: &ReadRequest,
    _cancel: &mut watch::Receiver<bool>,
) -> Result<Value, ReadError> {
    Err(ReadError::incompatible("run_platform"))
}

/// Inspects actual finite tool entries only, never schemas or prose examples.
#[cfg(unix)]
fn advertises(discovery: &Value, method: &str) -> bool {
    discovery
        .as_array()
        .or_else(|| discovery.get("tools").and_then(Value::as_array))
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.as_str() == Some(method)
                    || item.get("name").and_then(Value::as_str) == Some(method)
            })
        })
}

/// Calls the selected configured Pool or Bridge observer with fixed argv and temp paths.
/// The shared executor owns cancellation, timeout, bounded output and reaping.
async fn read_observer(
    config: &Connections,
    request: &ReadRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, ReadError> {
    let connection = config
        .programs
        .get(request.resource.source())
        .ok_or_else(|| ReadError::invalid("source_config"))?;
    #[cfg(unix)]
    if let (Some(socket), Some(server_uid)) = (&connection.socket, connection.server_uid) {
        return read_pool_socket(socket, server_uid, request, cancel).await;
    }
    let program = connection
        .program
        .as_deref()
        .ok_or_else(|| ReadError::incompatible("not_configured"))?;
    let mut args = vec!["observe".to_owned()];
    if let Some(path) = &connection.config {
        args.extend([
            "--config".into(),
            path.to_str()
                .ok_or_else(|| ReadError::invalid("config_utf8"))?
                .to_owned(),
        ]);
    }
    for variable in ["TMPDIR", "TMP", "TEMP"] {
        if std::env::var_os(variable).is_none_or(|path| {
            let path = PathBuf::from(path);
            !path.is_absolute()
                || std::fs::canonicalize(path).map_or(true, |resolved| {
                    resolved.starts_with("/tmp") || resolved.starts_with("/private/tmp")
                })
        }) {
            return Err(ReadError::invalid("temp_environment"));
        }
    }
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut input = serde_json::to_vec(&json!({
        "schema_version": 1, "operation": request.resource.method(), "params": request.params,
    }))
    .map_err(|_| ReadError::invalid("observer_encode"))?;
    input.push(b'\n');
    // Do not wrap this future in another timeout/select: cooperative cancellation
    // must finish execute's child cleanup before the adapter exits.
    let (output, exit_code) = process::execute(command, input, cancel).await?;
    if !output.ends_with(b"\n") || output.iter().filter(|byte| **byte == b'\n').count() != 1 {
        return Err(ReadError::invalid("observer_frame"));
    }
    let value: Value = serde_json::from_slice(&output)
        .map_err(|_| ReadError::incompatible("observer_json_required"))?;
    validate_observer(value, request.resource, exit_code)
}

/// Reads Pool through its group observer socket. That socket refuses private
/// mappings (bindings, Run proof), so those reads are denied before any I/O.
#[cfg(unix)]
async fn read_pool_socket(
    socket: &std::path::Path,
    server_uid: u32,
    request: &ReadRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, ReadError> {
    if request.resource == Resource::PoolRunProof
        || request.params.get("include_bindings") == Some(&Value::Bool(true))
    {
        return Err(ReadError::incompatible("pool_socket_private_section"));
    }
    let value = tokio::select! {
        biased;
        _ = cancel.changed() => return Err(ReadError::unavailable("cancelled")),
        result = tokio::time::timeout(
            READ_TIMEOUT,
            pool_socket::call(socket, server_uid, request.resource.method(), &request.params),
        ) => result.unwrap_or_else(|_| Err(ReadError::unavailable("client_timeout")))?,
    };
    validate_observer(value, request.resource, Some(0))
}

/// Preserves valid producer envelopes and clocks; maps failures to safe static errors.
fn validate_observer(
    value: Value,
    resource: Resource,
    exit_code: Option<i32>,
) -> Result<Value, ReadError> {
    if !value.is_object() || value.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Err(ReadError::incompatible("source_schema"));
    }
    if value.get("kind").and_then(Value::as_str) != resource.kind() {
        return Err(ReadError::incompatible("source_kind"));
    }
    if value.get("data").is_some() == value.get("error").is_some()
        || value.get("data").is_some_and(|data| !data.is_object())
        || value.get("error").is_some_and(Value::is_null)
    {
        return Err(ReadError::invalid("source_envelope"));
    }
    if value
        .get("operation")
        .is_some_and(|value| value.as_str() != Some(resource.method()))
    {
        return Err(ReadError::invalid("source_operation"));
    }
    if let Some(error) = value
        .get("error")
        .filter(|error| !error.is_null())
        .or_else(|| {
            value
                .pointer("/data/error")
                .filter(|error| !error.is_null())
        })
    {
        return Err(ReadError::source(error));
    }
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(ReadError::source(&value));
    }
    if exit_code != Some(0) {
        return Err(ReadError::invalid("helper_exit_contract"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Worktree reads accept only documented read-only argument shapes.
    #[test]
    fn worktree_params_are_closed() {
        let check = |resource, params: Value| worktree_params(&ReadRequest { resource, params });
        assert!(check(Resource::WorktreeIdentity, json!({})).is_ok());
        assert!(check(Resource::WorktreeIdentity, json!({"repo":"/r"})).is_err());
        assert!(check(Resource::WorktreeList, json!({})).is_ok());
        assert!(
            check(
                Resource::WorktreeList,
                json!({"repo":"/r","limit":20,"cursor":"c","discovery":false})
            )
            .is_ok()
        );
        for invalid in [
            json!({"size":true}),
            json!({"repo":"relative"}),
            json!({"limit":21}),
            json!({"limit":0}),
            json!({"cursor":""}),
        ] {
            assert!(check(Resource::WorktreeList, invalid).is_err());
        }
        assert!(
            check(
                Resource::WorktreeInspect,
                json!({"repo":"/r","path":"/r/w"})
            )
            .is_ok()
        );
        assert!(
            check(
                Resource::WorktreeInspect,
                json!({"repo":"/r","name":"w","checks":{"status":true}})
            )
            .is_ok()
        );
        for invalid in [
            json!({"repo":"/r"}),
            json!({"repo":"/r","name":"w","path":"/r/w"}),
            json!({"path":"/r/w"}),
            json!({"repo":"/r","path":"w"}),
            json!({"repo":"/r","name":"w","checks":{"size":true}}),
        ] {
            assert!(check(Resource::WorktreeInspect, invalid).is_err());
        }
    }

    /// Archived Tasks and IDE sources are never reachable from the terminal observer.
    #[test]
    fn archived_tasks_and_ide_are_denied() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (_tx, mut cancel) = watch::channel(false);
        for resource in [
            Resource::TasksIdentity,
            Resource::TasksPeek,
            Resource::IdeIdentity,
            Resource::IdeObserve,
        ] {
            let request = ReadRequest {
                resource,
                params: json!({}),
            };
            let error = runtime
                .block_on(observe(&request, &mut cancel))
                .expect_err("denied");
            assert_eq!(error.code, "resource_denied");
        }
    }

    /// Linux defaults to the shared broker; a configured socket never inherits its UID.
    #[cfg(target_os = "linux")]
    #[test]
    fn run_defaults_to_shared_broker_on_linux() {
        let home = std::path::Path::new("/home/example");
        let defaults = Connections::resolve(home, None).expect("defaults");
        assert_eq!(defaults.socket, PathBuf::from("/run/agent-mcp/api.sock"));
        assert_eq!(defaults.broker_uid, Some(1003));
        let parse = |value: Value| serde_json::from_value::<config::FileConfig>(value).unwrap();
        let empty = Connections::resolve(home, Some(parse(json!({"schema_version":1})))).unwrap();
        assert_eq!(empty.broker_uid, Some(1003));
        let private = Connections::resolve(
            home,
            Some(parse(
                json!({"schema_version":1,"run":{"socket":"/home/example/.agent-run/api.sock"}}),
            )),
        )
        .unwrap();
        assert_eq!(private.broker_uid, None);
        assert_eq!(
            config::SYSTEM_CONFIG,
            Some("/etc/agent-hub/connections.json")
        );
    }

    /// Builds one Pool inventory request for the closed-shape checks.
    fn inventory(params: Value) -> ReadRequest {
        ReadRequest {
            resource: Resource::PoolInventorySnapshot,
            params,
        }
    }

    /// The inventory read is one fixed owner operation with a closed parameter shape.
    #[test]
    fn pool_inventory_snapshot_is_a_closed_read() {
        let request = inventory(json!({"filter":"all","limit":1}));
        request.validate().expect("first page");
        assert_eq!(request.resource.method(), "inventory_snapshot");
        assert_eq!(request.resource.kind(), Some("inventory_snapshot"));
        assert_eq!(request.resource.source(), "pool");
        inventory(json!({"filter":"closed","limit":10,"cursor":{"version":1}}))
            .validate()
            .expect("cursor is forwarded unchanged");
        for invalid in [
            json!({}),
            json!({"filter":"all"}),
            json!({"limit":1}),
            json!({"filter":"open","limit":1}),
            json!({"filter":"all","limit":0}),
            json!({"filter":"all","limit":11}),
            json!({"filter":"all","limit":"1"}),
            json!({"filter":"all","limit":1,"cursor":"x"}),
            json!({"filter":"all","limit":1,"after":"pool"}),
            json!({"filter":"all","limit":1,"pool_id":"pool"}),
        ] {
            assert_eq!(
                inventory(invalid)
                    .validate()
                    .expect_err("closed shape")
                    .code,
                "pool_inventory_params"
            );
        }
        assert!(!extra_authority(
            &json!({"filter":"all","limit":1,"cursor":{"version":1,"source":{"store_id":"s","read_epoch":"e","revision":"1"},"filter":"all","limit":1,"after":"p"}})
        ));
    }

    /// A producer envelope of another kind, or one carrying a stale error, never becomes data.
    #[test]
    fn pool_inventory_snapshot_envelope_is_exact() {
        let ok = json!({"schema_version":1,"kind":"inventory_snapshot","data":{"pools":[]}});
        assert!(validate_observer(ok, Resource::PoolInventorySnapshot, Some(0)).is_ok());
        let wrong = json!({"schema_version":1,"kind":"pool_page","data":{"pools":[]}});
        assert_eq!(
            validate_observer(wrong, Resource::PoolInventorySnapshot, Some(0))
                .expect_err("wrong kind")
                .code,
            "source_kind"
        );
        let stale = json!({"schema_version":1,"kind":"inventory_snapshot","error":{"code":"stale","outcome":"blocked","detail":"x"}});
        let error = validate_observer(stale, Resource::PoolInventorySnapshot, Some(1))
            .expect_err("stale is an error branch");
        assert_eq!(error.code, "stale");
        assert_eq!(error.outcome, contract::Outcome::Unavailable);
        let blocked = json!({"schema_version":1,"kind":"inventory_snapshot","error":{"code":"blocked","outcome":"blocked","detail":"x"}});
        assert_eq!(
            validate_observer(blocked, Resource::PoolInventorySnapshot, Some(1))
                .expect_err("other producer codes stay generic")
                .code,
            "source_error"
        );
        let prose = json!({"schema_version":1,"kind":"inventory_snapshot","error":{"code":"stale","outcome":"blocked","detail":"credential=TOPSECRET"}});
        let reflected = validate_observer(prose, Resource::PoolInventorySnapshot, Some(1))
            .expect_err("stale carries no producer prose");
        assert!(
            !serde_json::to_string(&reflected)
                .expect("safe error")
                .contains("TOPSECRET")
        );
    }

    /// The initial-task read is one fixed Run method with a closed, null-free request shape.
    #[test]
    fn run_initial_task_is_a_closed_read() {
        let task = |params: Value| ReadRequest {
            resource: Resource::RunInitialTask,
            params,
        };
        let request = task(json!({"version":1,"mode":"current","agent_id":"ag-1"}));
        request.validate().expect("current first page");
        assert_eq!(request.resource.method(), "initial_task");
        assert_eq!(request.resource.kind(), None);
        assert_eq!(request.resource.source(), "run");
        task(json!({"version":1,"mode":"strict","expected_store_id":"s","agent_id":"ag-1","sequence":1,"execution_ref":"r","pin_id":"p","offset":4,"max_bytes":4,"expected_sha256":"h","expected_total_bytes":9}))
            .validate()
            .expect("strict continuation");
        for invalid in [
            json!({}),
            json!({"version":1,"mode":"current"}),
            json!({"version":2,"mode":"current","agent_id":"ag-1"}),
            json!({"version":1,"mode":"loose","agent_id":"ag-1"}),
            json!({"version":1,"mode":"current","agent_id":""}),
            json!({"version":1,"mode":"current","agent_id":"ag-1","pin_id":null}),
            json!({"version":1,"mode":"current","agent_id":"ag-1","task":"x"}),
            json!({"version":1,"mode":"current","agent_id":"ag-1","command":"x"}),
        ] {
            let code = task(invalid).validate().expect_err("closed shape").code;
            assert!(
                matches!(code, "initial_task_params" | "authority_denied"),
                "{code}"
            );
        }
    }
}
