//! Finite rmcp clients over bounded stdio; only the app-created frontend is reaped.

use crate::{
    adapters::validate_structured,
    config::Connections,
    contract::{FRAME_LIMIT, READ_TIMEOUT, ReadError, ReadRequest},
    process,
};
use rmcp::{
    RoleClient, ServiceExt,
    model::{CallToolRequestParams, CallToolResponse},
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::Transport,
};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    io,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::{Mutex, watch},
    time::Instant,
};

/// Shared writer and outstanding JSON-RPC ids; one fixed call follows initialization.
struct Writer {
    /// Owned frontend stdin; closing it never affects a resident daemon.
    stdin: Option<ChildStdin>,
    /// IDs recorded before writing and removed exactly once on response.
    ids: BTreeSet<String>,
}

/// Bounded rmcp transport preserving partial frames across cancelled receive polls.
struct BoundedTransport {
    /// App-owned frontend stdout, with no shared connection reuse.
    reader: BufReader<ChildStdout>,
    /// Partial frame retained if rmcp cancels a receive poll.
    line: Vec<u8>,
    /// Cumulative bytes accepted for this finite initialization/read exchange.
    total: usize,
    /// Shared fixed-call writer and correlation set.
    writer: Arc<Mutex<Writer>>,
    /// First static framing rejection for the final sanitized read result.
    failure: Arc<StdMutex<Option<ReadError>>>,
    /// Whether initialization emitted JSON-looking protocol bytes, distinguishing
    /// malformed MCP replies from legacy CLI usage text after a natural exit.
    protocol_output: Arc<AtomicBool>,
}

impl BoundedTransport {
    /// Records a static transport rejection without retaining any private producer text.
    fn reject(&self, code: &'static str) {
        if let Ok(mut failure) = self.failure.lock()
            && failure.is_none()
        {
            *failure = Some(ReadError::invalid(code));
        }
    }
}

impl Transport<RoleClient> for BoundedTransport {
    /// Safe transport failures consumed by rmcp; renderer receives static read errors only.
    type Error = io::Error;

    /// Writes only initialization, initialized notification and allowlisted product tool calls.
    /// Request ids are registered under the same lock before any bytes become visible.
    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let writer = self.writer.clone();
        async move {
            let value = serde_json::to_value(item).map_err(io::Error::other)?;
            let allowed = match value.get("method").and_then(Value::as_str) {
                Some("initialize" | "notifications/initialized") => true,
                Some("tools/call") => matches!(
                    value.pointer("/params/name").and_then(Value::as_str),
                    Some("get_status" | "list_worktrees" | "inspect_worktree" | "peek")
                ),
                _ => false,
            };
            if !allowed {
                return Err(io::Error::other("MCP method denied"));
            }
            let mut line = serde_json::to_vec(&value).map_err(io::Error::other)?;
            line.push(b'\n');
            if line.len() > FRAME_LIMIT {
                return Err(io::Error::other("MCP input budget"));
            }
            let mut writer = writer.lock().await;
            if let Some(id) = value.get("id") {
                writer.ids.insert(id.to_string());
            }
            let stdin = writer
                .stdin
                .as_mut()
                .ok_or_else(|| io::Error::other("MCP closed"))?;
            stdin.write_all(&line).await?;
            stdin.flush().await
        }
    }

    /// Receives one strict correlated NDJSON frame; a finite exchange accepts at most 4 MiB.
    /// Notifications/callback requests are rejected instead of activating client capabilities.
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        if !self.line.ends_with(b"\n") {
            let remaining = FRAME_LIMIT.saturating_sub(self.line.len()) + 1;
            let bytes = (&mut self.reader)
                .take(remaining as u64)
                .read_until(b'\n', &mut self.line)
                .await;
            if !matches!(bytes, Ok(count) if count > 0) {
                self.reject("mcp_frame_incomplete");
                return None;
            }
        }
        if matches!(
            self.line.iter().find(|byte| !byte.is_ascii_whitespace()),
            Some(b'{' | b'[')
        ) {
            self.protocol_output.store(true, Ordering::Relaxed);
        }
        if self.line.len() > FRAME_LIMIT
            || self.total.saturating_add(self.line.len()) > FRAME_LIMIT * 4
        {
            self.reject("frame_budget");
            return None;
        }
        if !self.line.ends_with(b"\n") {
            self.reject("mcp_frame_incomplete");
            return None;
        }
        let value: Value = match serde_json::from_slice(&self.line) {
            Ok(value) => value,
            Err(_) => {
                self.reject("frame_json");
                return None;
            }
        };
        self.protocol_output.store(true, Ordering::Relaxed);
        if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || value.get("method").is_some()
            || value.get("result").is_some() == value.get("error").is_some()
        {
            self.reject("mcp_envelope");
            return None;
        }
        let Some(id) = value.get("id") else {
            self.reject("mcp_correlation");
            return None;
        };
        if !self.writer.lock().await.ids.remove(&id.to_string()) {
            self.reject("mcp_correlation");
            return None;
        }
        self.total = self.total.saturating_add(self.line.len());
        let parsed = serde_json::from_value(value).ok();
        self.line.clear();
        if parsed.is_none() {
            self.reject("mcp_envelope");
        }
        parsed
    }

    /// Closes only app-owned frontend stdin; the outer owner explicitly kills/reaps its child.
    async fn close(&mut self) -> Result<(), Self::Error> {
        self.writer.lock().await.stdin.take();
        Ok(())
    }
}

/// Calls exactly one structured MCP read, returning its unchanged payload and a
/// presentation-degraded flag only for valid Worktree data with isError=true.
/// One deadline covers initialization/call. Every exit kills/reaps its frontend
/// before joining the rmcp worker, so a blocked stdin send cannot hang cleanup.
/// A failed non-protocol initialization gets at most 100 ms to observe a natural
/// child exit; a status caused by our cleanup never establishes incompatibility.
pub(crate) async fn read(
    config: &Connections,
    request: &ReadRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(Value, bool), ReadError> {
    if *cancel.borrow() {
        return Err(ReadError::unavailable("cancelled"));
    }
    let source = request.resource.source();
    let connection = config
        .programs
        .get(source)
        .ok_or_else(|| ReadError::invalid("source_config"))?;
    let program = connection
        .program
        .as_deref()
        .ok_or_else(|| ReadError::incompatible("not_configured"))?;
    let mut args = Vec::new();
    if source == "tasks"
        && let Some(path) = &connection.config
    {
        args.extend([
            "--config".into(),
            path.to_str()
                .ok_or_else(|| ReadError::invalid("config_utf8"))?
                .into(),
        ]);
    }
    args.push("mcp".into());
    let mut command = process::command(program, &args, source)?;
    if let Some(home) = &connection.home {
        command.env("AGENT_WORKTREE_HOME", home);
    }
    let arguments = request
        .params
        .as_object()
        .cloned()
        .ok_or_else(|| ReadError::invalid("params_object"))?;
    let (mut child, group) = process::spawn_helper(&mut command).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ReadError::incompatible("executable_missing")
        } else {
            ReadError::unavailable("mcp_spawn")
        }
    })?;
    let failure = Arc::new(StdMutex::new(None));
    let protocol_output = Arc::new(AtomicBool::new(false));
    let (stdin, stdout) = match (child.stdin.take(), child.stdout.take()) {
        (Some(stdin), Some(stdout)) => (stdin, stdout),
        _ => {
            group.kill();
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(ReadError::unavailable("mcp_pipes"));
        }
    };
    let transport = BoundedTransport {
        reader: BufReader::new(stdout),
        line: Vec::new(),
        total: 0,
        writer: Arc::new(Mutex::new(Writer {
            stdin: Some(stdin),
            ids: BTreeSet::new(),
        })),
        failure: failure.clone(),
        protocol_output: protocol_output.clone(),
    };
    let deadline = Instant::now() + READ_TIMEOUT;
    let initialized = tokio::select! {
        biased;
        _ = cancel.changed() => Err(ReadError::unavailable("cancelled")),
        initialized = tokio::time::timeout_at(deadline, ().serve(transport)) => match initialized {
            Ok(Ok(client)) => Ok(client),
            Ok(Err(_)) => Err(ReadError::incompatible("mcp_initialize")),
            Err(_) => Err(ReadError::unavailable("client_timeout")),
        },
    };
    let (result, client) = match initialized {
        Ok(client) => {
            let params =
                CallToolRequestParams::new(request.resource.method()).with_arguments(arguments);
            let mut result = tokio::select! {
                biased;
                _ = cancel.changed() => Err(ReadError::unavailable("cancelled")),
                result = tokio::time::timeout_at(deadline, client.call_tool_once(params)) => match result {
                    Ok(Ok(CallToolResponse::Complete(result))) => {
                        let is_error = result.is_error == Some(true);
                        let validated = result.structured_content.ok_or_else(|| if is_error { ReadError::unavailable("mcp_source_error") } else { ReadError::incompatible("structured_content_required") })
                            .and_then(|value| validate_structured(value, request.resource, true));
                        validated.and_then(|value| {
                            if is_error && request.resource.source() != "worktree" { Err(ReadError::unavailable("mcp_source_error")) }
                            else { Ok((value, is_error)) }
                        })
                    },
                    Ok(Ok(_)) => Err(ReadError::incompatible("mcp_read_requires_interaction")),
                    Ok(Err(rmcp::ServiceError::McpError(error))) if error.code == rmcp::model::ErrorCode::METHOD_NOT_FOUND => Err(ReadError::incompatible("mcp_method_unavailable")),
                    Ok(Err(_)) => Err(ReadError::unavailable("mcp_read")),
                    Err(_) => Err(ReadError::unavailable("client_timeout")),
                },
            };
            if result.as_ref().is_err_and(|error| error.code == "mcp_read") {
                match failure.lock() {
                    Ok(failure) => {
                        if let Some(error) = failure.clone() {
                            result = Err(error);
                        }
                    }
                    Err(_) => result = Err(ReadError::unavailable("mcp_transport_state")),
                }
            }
            (result, Some(client))
        }
        Err(error) => (Err(error), None),
    };
    let init_failed = result
        .as_ref()
        .is_err_and(|error| error.code == "mcp_initialize");
    // ponytail: legacy usage and plain-text protocol corruption are indistinguishable;
    // require a natural failure exit until helpers supply a typed startup contract.
    let legacy_output = !protocol_output.load(Ordering::Relaxed)
        && failure.lock().is_ok_and(|failure| {
            failure
                .as_ref()
                .is_none_or(|error| matches!(error.code, "mcp_frame_incomplete" | "frame_json"))
        });
    let natural_exit = if init_failed && legacy_output {
        match tokio::time::timeout(Duration::from_millis(100), child.wait()).await {
            Ok(Ok(status)) => Some(status),
            _ => None,
        }
    } else {
        None
    };
    // Stop the owned frontend and any desktop-owned group before cancellation joins rmcp:
    // the worker may hold Writer's mutex while awaiting a full stdin pipe.
    group.kill();
    let killed = child.kill().await;
    let waited = child.wait().await;
    let worker_failed = if let Some(client) = client {
        client.cancel().await.is_err()
    } else {
        false
    };
    if killed.is_err() && waited.is_err() {
        return Err(ReadError::unavailable("helper_cleanup"));
    }
    if worker_failed {
        return Err(ReadError::unavailable("mcp_cleanup"));
    }
    if natural_exit.is_some_and(|status| !status.success()) {
        return Err(ReadError::incompatible("mcp_initialize_unsupported"));
    }
    if let Some(error) = failure
        .lock()
        .map_err(|_| ReadError::unavailable("mcp_transport_state"))?
        .clone()
    {
        // Initialization errors may precede rmcp worker creation; preserve source/cancel
        // errors instead of replacing them with EOF observed during orderly cleanup.
        if result
            .as_ref()
            .is_err_and(|error| error.code == "mcp_initialize")
        {
            return Err(error);
        }
    }
    result
}
