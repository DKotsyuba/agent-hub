//! Direct client of Agent Pool's read-only group observer socket (`observer_socket_v1`).
//!
//! Applies Pool's cross-user path policy for the configured resident UID before
//! connecting, checks the kernel peer UID, rechecks the path identity, then sends one
//! plain observer request line and reads one bounded envelope line.

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

/// Checks every ancestor (root or server-owned, no group/other write), the immediate
/// directory (no other access) and the socket (server-owned, no other access).
async fn trusted_path(path: &Path, server_uid: u32) -> Result<std::fs::Metadata, ReadError> {
    let socket = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| ReadError::unavailable("pool_endpoint"))?;
    if !socket.file_type().is_socket() || socket.uid() != server_uid || socket.mode() & 0o007 != 0 {
        return Err(ReadError::invalid("pool_endpoint_identity"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ReadError::invalid("pool_endpoint_parent"))?;
    let directory = tokio::fs::symlink_metadata(parent)
        .await
        .map_err(|_| ReadError::unavailable("pool_endpoint_parent"))?;
    if !directory.is_dir()
        || !(directory.uid() == 0 || directory.uid() == server_uid)
        || directory.mode() & 0o022 != 0
        || directory.mode() & 0o007 != 0
    {
        return Err(ReadError::invalid("pool_endpoint_parent"));
    }
    for ancestor in parent.ancestors().skip(1) {
        let meta = tokio::fs::symlink_metadata(ancestor)
            .await
            .map_err(|_| ReadError::unavailable("pool_endpoint_ancestor"))?;
        if !meta.is_dir()
            || !(meta.uid() == 0 || meta.uid() == server_uid)
            || meta.mode() & 0o022 != 0
        {
            return Err(ReadError::invalid("pool_endpoint_ancestor"));
        }
    }
    Ok(socket)
}

/// Sends one observer operation and returns the producer envelope unchanged.
/// The caller owns timeout/cancellation; dropping the future closes the socket.
pub(crate) async fn call(
    path: &Path,
    server_uid: u32,
    operation: &'static str,
    params: &Value,
) -> Result<Value, ReadError> {
    let before = trusted_path(path, server_uid).await?;
    let stream = UnixStream::connect(path)
        .await
        .map_err(|_| ReadError::unavailable("pool_connect"))?;
    let peer = stream
        .peer_cred()
        .map_err(|_| ReadError::invalid("pool_peer_identity"))?;
    let after = trusted_path(path, server_uid).await?;
    if peer.uid() != server_uid || before.ino() != after.ino() || before.dev() != after.dev() {
        return Err(ReadError::invalid("pool_peer_identity"));
    }
    exchange(stream, operation, params).await
}

/// Writes one plain observer request and reads one bounded envelope line.
async fn exchange(
    mut stream: UnixStream,
    operation: &str,
    params: &Value,
) -> Result<Value, ReadError> {
    let mut request =
        serde_json::to_vec(&json!({"schema_version": 1, "operation": operation, "params": params}))
            .map_err(|_| ReadError::invalid("observer_encode"))?;
    request.push(b'\n');
    // A refused peer gets one line before any input is read; a failed write still
    // reads that line so the refusal code is reported instead of a broken pipe.
    let written = stream.write_all(&request).await.is_ok();
    let mut line = Vec::new();
    BufReader::new(stream)
        .take((FRAME_LIMIT + 1) as u64)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|_| ReadError::unavailable("pool_read"))?;
    // decode() turns a refusal line into its error first; only then is a failed
    // write reported, so no producer data is accepted after an incomplete request.
    let value = decode(&line)?;
    if !written {
        return Err(ReadError::unavailable("pool_write"));
    }
    Ok(value)
}

/// Validates one framed JSON line and maps socket-level refusals to fixed safe codes.
pub(crate) fn decode(line: &[u8]) -> Result<Value, ReadError> {
    if line.len() > FRAME_LIMIT {
        return Err(ReadError::invalid("observer_frame"));
    }
    if !line.ends_with(b"\n") {
        return Err(ReadError::unavailable("pool_frame_incomplete"));
    }
    let value: Value = serde_json::from_slice(line)
        .map_err(|_| ReadError::incompatible("observer_json_required"))?;
    if value.get("kind").and_then(Value::as_str) == Some("error") {
        return Err(match value.pointer("/error/code").and_then(Value::as_str) {
            Some("unauthorized") => ReadError::unavailable("pool_unauthorized"),
            Some("unavailable") => ReadError::unavailable("pool_busy"),
            Some("invalid") => ReadError::invalid("pool_request_refused"),
            _ => ReadError::unavailable("source_error"),
        });
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encodes one reply line.
    fn line(value: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }

    /// Refusal lines map to fixed codes without echoing producer detail.
    #[test]
    fn refusals_are_sanitized() {
        let refusal = |code: &str| {
            decode(&line(json!({"schema_version":1,"kind":"error","error":{"code":code,"outcome":"blocked","detail":"PRIVATE"}})))
                .unwrap_err()
        };
        assert_eq!(refusal("unauthorized").code, "pool_unauthorized");
        assert_eq!(refusal("unavailable").code, "pool_busy");
        assert_eq!(refusal("invalid").code, "pool_request_refused");
        assert_eq!(refusal("other").code, "source_error");
        assert!(
            !serde_json::to_string(&refusal("other"))
                .unwrap()
                .contains("PRIVATE")
        );
        let ok = json!({"schema_version":1,"kind":"completion_page","data":{}});
        assert_eq!(decode(&line(ok.clone())).unwrap(), ok);
        let mut incomplete = line(ok);
        incomplete.pop();
        assert_eq!(
            decode(&incomplete).unwrap_err().code,
            "pool_frame_incomplete"
        );
    }

    /// One request line is written and one envelope line is returned unchanged.
    #[test]
    fn exchange_sends_one_plain_request() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (client, server) = UnixStream::pair().unwrap();
            let server = tokio::spawn(async move {
                let mut reader = BufReader::new(server);
                let mut request = String::new();
                reader.read_line(&mut request).await.unwrap();
                let reply = json!({"schema_version":1,"kind":"completion_page","data":{"ok":true}});
                reader
                    .into_inner()
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
                request
            });
            let params = json!({"pool_id":"p","completion_id":"c","section":"header","limit":1});
            let value = exchange(client, "completion_get", &params).await.unwrap();
            assert_eq!(value["data"]["ok"], true);
            let request: Value = serde_json::from_str(&server.await.unwrap()).unwrap();
            assert_eq!(
                request,
                json!({"schema_version":1,"operation":"completion_get","params":params})
            );
        });
    }
}
