//! Finite Quota NDJSON reads (protocol 1, snapshot schema 2) with an explicitly
//! trusted service UID, checked on the socket owner and on the connected peer.

use crate::contract::ReadError;
use serde_json::{Value, json};
use std::{
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::Path,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

/// Largest accepted Quota reply, below the observer's 4 MiB response budget.
pub(crate) const REPLY_LIMIT: usize = 3 * 1024 * 1024;
/// The only snapshot schema whose required fields this reader understands.
const SNAPSHOT_SCHEMA: u64 = 2;

/// Sends one fixed read method and returns the producer result object verbatim.
/// The caller owns timeout/cancellation; dropping this future closes the socket.
pub(crate) async fn call(
    path: &Path,
    server_uid: u32,
    method: &'static str,
    params: &Value,
) -> Result<Value, ReadError> {
    if !matches!(method, "status" | "snapshot") {
        return Err(ReadError::invalid("method_denied"));
    }
    let before = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| ReadError::unavailable("quota_endpoint"))?;
    if !before.file_type().is_socket() || before.uid() != server_uid || before.mode() & 0o007 != 0 {
        return Err(ReadError::invalid("quota_endpoint_identity"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ReadError::invalid("quota_endpoint_parent"))?;
    let parent_meta = tokio::fs::metadata(parent)
        .await
        .map_err(|_| ReadError::unavailable("quota_endpoint_parent"))?;
    if parent_meta.uid() != server_uid || parent_meta.mode() & 0o022 != 0 {
        return Err(ReadError::invalid("quota_endpoint_parent"));
    }
    let mut stream = UnixStream::connect(path)
        .await
        .map_err(|_| ReadError::unavailable("quota_connect"))?;
    let peer = stream
        .peer_cred()
        .map_err(|_| ReadError::invalid("quota_peer_identity"))?;
    let after = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| ReadError::unavailable("quota_endpoint"))?;
    if peer.uid() != server_uid || before.ino() != after.ino() || before.dev() != after.dev() {
        return Err(ReadError::invalid("quota_peer_identity"));
    }
    let mut request = json!({"version": 1, "method": method, "accounts": []});
    if method == "snapshot" {
        if let Some(accounts) = params.get("accounts") {
            request["accounts"] = accounts.clone();
        }
        if let Some(model) = params.get("model") {
            request["model"] = model.clone();
        }
    }
    let mut bytes = serde_json::to_vec(&request).map_err(|_| ReadError::invalid("quota_encode"))?;
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| ReadError::unavailable("quota_write"))?;
    let mut line = Vec::new();
    BufReader::new(stream)
        .take((REPLY_LIMIT + 1) as u64)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|_| ReadError::unavailable("quota_read"))?;
    decode(&line, method)
}

/// Validates framing, the exact `version` + `result`|`error` envelope and, for
/// snapshots, the schema version. Producer error codes map to fixed safe codes.
pub(crate) fn decode(line: &[u8], method: &str) -> Result<Value, ReadError> {
    if line.len() > REPLY_LIMIT {
        return Err(ReadError::invalid("quota_frame_budget"));
    }
    if !line.ends_with(b"\n") {
        return Err(ReadError::invalid("quota_frame_incomplete"));
    }
    let envelope: Value =
        serde_json::from_slice(line).map_err(|_| ReadError::invalid("quota_frame_json"))?;
    let fields = envelope
        .as_object()
        .ok_or_else(|| ReadError::invalid("quota_envelope"))?;
    if fields.get("version").and_then(Value::as_u64) != Some(1)
        || fields.len() != 2
        || fields.contains_key("result") == fields.contains_key("error")
    {
        return Err(ReadError::invalid("quota_envelope"));
    }
    if let Some(error) = fields.get("error") {
        return Err(match error.as_str() {
            Some("unknown_account") => ReadError {
                code: "quota_unknown_account",
                message: "Quota does not know the requested account.",
                outcome: crate::contract::Outcome::Missing,
            },
            Some("response_too_large") => ReadError::unavailable("quota_response_too_large"),
            Some("history_too_large") => ReadError::unavailable("quota_history_too_large"),
            Some("unauthorized") | Some("forbidden") => {
                ReadError::unavailable("quota_peer_not_allowed")
            }
            _ => ReadError::unavailable("quota_source_error"),
        });
    }
    let result = fields
        .get("result")
        .filter(|value| value.is_object())
        .ok_or_else(|| ReadError::invalid("quota_result"))?;
    if method == "snapshot" {
        if result.get("schema_version").and_then(Value::as_u64) != Some(SNAPSHOT_SCHEMA) {
            return Err(ReadError::incompatible("quota_snapshot_schema"));
        }
        if !result.get("accounts").is_some_and(Value::is_array)
            || !result.get("coverage").is_some_and(Value::is_object)
        {
            return Err(ReadError::invalid("quota_snapshot_shape"));
        }
    }
    Ok(result.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encodes one reply line as the service frames it.
    fn line(value: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }

    /// Snapshot schema 2 passes verbatim; other schemas and shapes are rejected.
    #[test]
    fn decodes_only_exact_envelopes() {
        let snapshot = json!({"schema_version":2,"accounts":[],"coverage":{"state":"unknown"}});
        assert_eq!(
            decode(
                &line(json!({"version":1,"result":snapshot.clone()})),
                "snapshot"
            )
            .unwrap(),
            snapshot
        );
        let code = |value: Value, method: &str| decode(&line(value), method).unwrap_err().code;
        assert_eq!(
            code(
                json!({"version":1,"result":{"schema_version":1,"accounts":[],"coverage":{}}}),
                "snapshot"
            ),
            "quota_snapshot_schema"
        );
        assert_eq!(
            code(json!({"version":2,"result":{}}), "status"),
            "quota_envelope"
        );
        assert_eq!(
            code(json!({"version":1,"result":{},"error":"x"}), "status"),
            "quota_envelope"
        );
        assert_eq!(
            code(json!({"version":1,"result":{},"extra":1}), "status"),
            "quota_envelope"
        );
        assert_eq!(
            code(json!({"version":1,"error":"unknown_account"}), "snapshot"),
            "quota_unknown_account"
        );
        assert_eq!(
            code(json!({"version":1,"error":"credential=SECRET"}), "snapshot"),
            "quota_source_error"
        );
        assert_eq!(
            code(json!({"version":1,"result":[]}), "status"),
            "quota_result"
        );
        let mut incomplete = line(json!({"version":1,"result":{}}));
        incomplete.pop();
        assert_eq!(
            decode(&incomplete, "status").unwrap_err().code,
            "quota_frame_incomplete"
        );
        assert!(
            decode(
                &line(json!({"version":1,"result":{"status":"running"}})),
                "status"
            )
            .is_ok()
        );
    }

    /// The checked-in agent-quota contract fixture decodes without loss.
    #[test]
    fn decodes_reference_fixture() {
        let fixture = include_str!("../../../terminal/test/fixtures/quota-snapshot-v2.json");
        let value: Value = serde_json::from_str(fixture).unwrap();
        let decoded = decode(&line(value.clone()), "snapshot").unwrap();
        assert_eq!(decoded, value["result"]);
    }
}
