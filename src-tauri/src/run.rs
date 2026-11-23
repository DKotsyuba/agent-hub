//! Finite Run NDJSON reads with an explicitly trusted socket owner and peer.

use crate::contract::{FRAME_LIMIT, ReadError};
use serde_json::{Value, json};
use std::{
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::Path,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

/// Reads one fixed RPC method after checking socket, directory and peer identity.
/// A configured broker UID permits group access; otherwise the socket stays private.
/// The caller owns timeout/cancellation; dropping this future closes partial frames.
pub(crate) async fn call(
    path: &Path,
    broker_uid: Option<u32>,
    method: &'static str,
    params: Value,
) -> Result<Value, ReadError> {
    if !matches!(
        method,
        "ping"
            | "capabilities"
            | "answer_chunk"
            | "tools"
            | "list_agents"
            | "status"
            | "agent_integration"
            | "transcript"
            | "transcript_exact"
            | "initial_task"
            | "answer"
            | "models"
            | "limits"
            | "list_pools"
            | "pool"
    ) {
        return Err(ReadError::invalid("method_denied"));
    }
    let uid = broker_uid.unwrap_or_else(|| rustix::process::getuid().as_raw());
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| ReadError::unavailable("run_endpoint"))?;
    let forbidden_mode = if broker_uid.is_some() { 0o007 } else { 0o077 };
    if !metadata.file_type().is_socket()
        || metadata.uid() != uid
        || metadata.mode() & forbidden_mode != 0
    {
        return Err(ReadError::invalid("run_endpoint_identity"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ReadError::invalid("run_endpoint_parent"))?;
    let parent_meta = tokio::fs::metadata(parent)
        .await
        .map_err(|_| ReadError::unavailable("run_endpoint_parent"))?;
    if parent_meta.uid() != uid || parent_meta.mode() & 0o022 != 0 {
        return Err(ReadError::invalid("run_endpoint_parent"));
    }
    let mut stream = UnixStream::connect(path)
        .await
        .map_err(|_| ReadError::unavailable("run_connect"))?;
    if stream
        .peer_cred()
        .map_err(|_| ReadError::invalid("run_peer_identity"))?
        .uid()
        != uid
    {
        return Err(ReadError::invalid("run_peer_identity"));
    }
    let request = json!({"jsonrpc":"2.0", "id":1, "method":method, "params":params});
    let mut bytes = serde_json::to_vec(&request).map_err(|_| ReadError::invalid("rpc_encode"))?;
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| ReadError::unavailable("run_write"))?;
    let mut line = Vec::new();
    BufReader::new(stream)
        .take((FRAME_LIMIT + 1) as u64)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|_| ReadError::unavailable("run_read"))?;
    match decode(&line, 1, method) {
        Err(_)
            if method == "transcript"
                && params.get("view").and_then(Value::as_str) == Some("blocks")
                && blocks_unsupported(&line, 1) =>
        {
            Err(ReadError::incompatible("run_blocks_unsupported"))
        }
        result => result,
    }
}

/// Reads `capabilities`, adding the optional exact-initial-task entry only when `tools` advertises
/// that method. A source that rejects the optional flag still answers the plain read, so identity
/// discovery never depends on it and an absent entry simply means the capability is unsupported.
pub(crate) async fn capabilities(
    path: &Path,
    broker_uid: Option<u32>,
    initial_task: bool,
) -> Result<Value, ReadError> {
    if initial_task
        && let Ok(value) = call(
            path,
            broker_uid,
            "capabilities",
            json!({"include_initial_task": true}),
        )
        .await
    {
        return Ok(value);
    }
    call(path, broker_uid, "capabilities", json!({})).await
}

/// Classifies only a correlated invalid-params response naming unsupported block options.
/// The producer's text is inspected locally and never returned to the renderer.
fn blocks_unsupported(line: &[u8], id: u64) -> bool {
    if line.len() > FRAME_LIMIT || !line.ends_with(b"\n") {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return false;
    };
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || value.get("id").and_then(Value::as_u64) != Some(id)
        || value.get("result").is_some()
        || value.pointer("/error/code").and_then(Value::as_i64) != Some(-32602)
    {
        return false;
    }
    let Some(message) = value.pointer("/error/message").and_then(Value::as_str) else {
        return false;
    };
    let message = message.to_ascii_lowercase();
    ["view", "blocks", "tail_blocks", "before_cursor"]
        .iter()
        .any(|key| message.contains(key))
        && [
            "unknown",
            "unsupported",
            "unexpected",
            "unrecognized",
            "invalid",
            "not supported",
        ]
        .iter()
        .any(|reason| message.contains(reason))
}

/// Validates byte framing, exact correlation, envelope exclusivity and source failures.
/// Producer result objects are returned verbatim; error messages are never reflected.
pub(crate) fn decode(line: &[u8], id: u64, method: &str) -> Result<Value, ReadError> {
    if line.len() > FRAME_LIMIT {
        return Err(ReadError::invalid("frame_budget"));
    }
    if !line.ends_with(b"\n") {
        return Err(ReadError::invalid("frame_incomplete"));
    }
    let envelope: Value =
        serde_json::from_slice(line).map_err(|_| ReadError::invalid("frame_json"))?;
    if envelope.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || envelope.get("id").and_then(Value::as_u64) != Some(id)
        || envelope.get("result").is_some() == envelope.get("error").is_some()
    {
        return Err(ReadError::invalid("rpc_envelope"));
    }
    if let Some(error) = envelope.get("error") {
        let class = error.pointer("/data/code").and_then(Value::as_str);
        let code = error.get("code").and_then(Value::as_i64);
        return Err(match (method, code, class) {
            (_, Some(-32601), _) => ReadError::incompatible("run_method_unavailable"),
            ("list_agents", Some(-32000), Some("StorageError")) => {
                ReadError::unavailable("run_inventory_storage")
            }
            ("agent_integration", Some(-32000), Some("AgentNotFound")) => {
                ReadError::missing("run_agent_missing")
            }
            _ => ReadError::unavailable("run_source_error"),
        });
    }
    let result = envelope
        .get("result")
        .filter(|v| v.is_object() || v.is_array())
        .ok_or_else(|| ReadError::invalid("rpc_result"))?;
    if result.get("error").is_some_and(|v| !v.is_null()) {
        return Err(ReadError::unavailable("run_source_error"));
    }
    Ok(result.clone())
}

#[cfg(test)]
mod tests {
    use super::{blocks_unsupported, decode};
    use crate::contract::Outcome;

    /// Maps the observed Run 0.33.2 RPC errors without forwarding producer diagnostics.
    #[test]
    fn classifies_correlated_inventory_storage_error_and_missing_agent() {
        let storage = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"data\":{\"code\":\"StorageError\",\"message\":\"state database operation failed\"},\"message\":\"state database operation failed\"}}\n";
        let error = decode(storage, 1, "list_agents").unwrap_err();
        assert_eq!(error.outcome, Outcome::Unavailable);
        assert_eq!(error.code, "run_inventory_storage");
        assert_eq!(
            decode(storage, 2, "list_agents").unwrap_err().code,
            "rpc_envelope"
        );
        assert_eq!(
            decode(storage, 1, "status").unwrap_err().code,
            "run_source_error"
        );

        let missing = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"data\":{\"code\":\"AgentNotFound\",\"message\":\"private producer text\"},\"message\":\"private producer text\"}}\n";
        let error = decode(missing, 1, "agent_integration").unwrap_err();
        assert_eq!(error.outcome, Outcome::Missing);
        assert_eq!(error.code, "run_agent_missing");
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("private producer text")
        );
    }

    /// Unsupported options are distinguished without forwarding source error text.
    #[test]
    fn classifies_only_correlated_block_option_errors() {
        let response = |id: u64, code: i32, message: &str| {
            let mut line = serde_json::to_vec(&serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})).unwrap();
            line.push(b'\n');
            line
        };
        assert!(blocks_unsupported(
            &response(1, -32602, "unknown field 'view'"),
            1
        ));
        assert!(!blocks_unsupported(
            &response(2, -32602, "unknown field 'view'"),
            1
        ));
        assert!(!blocks_unsupported(
            &response(1, -32000, "unknown field 'view'"),
            1
        ));
        assert!(!blocks_unsupported(
            &response(1, -32602, "state database operation failed"),
            1
        ));
        let mut incomplete = response(1, -32602, "unknown field 'view'");
        incomplete.pop();
        assert!(!blocks_unsupported(&incomplete, 1));
    }
}
