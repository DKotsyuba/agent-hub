//! Fixed product read routing; no renderer-controlled RPC, executable or credentials.

use crate::{
    config::Connections,
    contract::{READ_TIMEOUT, ReadError, ReadRequest, Resource},
    process, run,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::watch;

/// Dispatches one closed resource to its fixed product read, returning original data
/// and whether Worktree reported a text-only presentation failure. Run sockets are
/// finite; helper cancellation always performs owned-child cleanup.
pub(crate) async fn read(
    config: &Connections,
    request: &ReadRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(Value, bool), ReadError> {
    match request.resource.source() {
        "run" => {
            let wait = request
                .params
                .get("wait_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(60);
            let deadline = if request.resource == Resource::RunAgents {
                READ_TIMEOUT + Duration::from_secs(wait)
            } else {
                READ_TIMEOUT
            };
            let operation = async {
                if request.resource == Resource::RunAnswerChunk {
                    let tools =
                        run::call(&config.socket, config.broker_uid, "tools", json!({})).await?;
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
                if request.resource == Resource::RunIdentity {
                    let tools =
                        run::call(&config.socket, config.broker_uid, "tools", json!({})).await?;
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
                        .and_then(|c| c.get("version"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    Ok(
                        json!({"ping":result,"tools":tools,"capabilities":capabilities,"version":version}),
                    )
                } else {
                    Ok(result)
                }
            };
            let result = tokio::select! {
                biased;
                _ = cancel.changed() => Err(ReadError::unavailable("cancelled")),
                result = tokio::time::timeout(deadline, operation) => result.unwrap_or_else(|_| Err(ReadError::unavailable("client_timeout"))),
            };
            result.map(|data| (data, false))
        }
        "worktree" | "tasks" => crate::mcp::read(config, request, cancel).await,
        "pool" | "bridge" | "ide" => cli(config, request, cancel).await.map(|data| (data, false)),
        _ => Err(ReadError::invalid("resource_source")),
    }
}

/// Tests only finite discovery entries, never arbitrary producer strings or schema examples.
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

/// Executes an absolute app-configured observer with native-owned argv and one JSON line.
/// Unsupported CLI versions remain incompatible; there is no text/database/write fallback.
async fn cli(
    config: &Connections,
    request: &ReadRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value, ReadError> {
    let source = request.resource.source();
    let connection = config
        .programs
        .get(source)
        .ok_or_else(|| ReadError::invalid("source_config"))?;
    let program = connection
        .program
        .as_deref()
        .ok_or_else(|| ReadError::incompatible("not_configured"))?;
    let (mut args, input) = if source == "ide" {
        if request.resource == Resource::IdeIdentity {
            if request.params.as_object().is_none_or(|p| !p.is_empty()) {
                return Err(ReadError::invalid("ide_identity_params"));
            }
            (vec!["doctor".into(), "--read-only".into()], Vec::new())
        } else {
            let params = request
                .params
                .as_object()
                .ok_or_else(|| ReadError::invalid("params_object"))?;
            if params
                .keys()
                .any(|key| !matches!(key.as_str(), "repository" | "cursor"))
            {
                return Err(ReadError::invalid("ide_observe_params"));
            }
            let repository = params
                .get("repository")
                .and_then(Value::as_str)
                .filter(|p| std::path::Path::new(p).is_absolute())
                .ok_or_else(|| ReadError::invalid("repository_absolute"))?;
            let mut args = vec![
                "observe".into(),
                "--repo".into(),
                repository.into(),
                "--json".into(),
            ];
            if let Some(cursor) = params.get("cursor") {
                let cursor = cursor
                    .as_u64()
                    .ok_or_else(|| ReadError::invalid("ide_cursor"))?;
                args.extend(["--cursor".into(), cursor.to_string()]);
            }
            (args, Vec::new())
        }
    } else {
        let mut input = serde_json::to_vec(&json!({"schema_version":1,"operation":request.resource.method(),"params":request.params}))
            .map_err(|_| ReadError::invalid("observer_encode"))?;
        input.push(b'\n');
        (vec!["observe".into()], input)
    };
    if let Some(path) = &connection.config {
        args.push("--config".into());
        args.push(
            path.to_str()
                .ok_or_else(|| ReadError::invalid("config_utf8"))?
                .to_owned(),
        );
    }
    let mut command = process::command(program, &args, source)?;
    if let Some(home) = &connection.home {
        command.env("AGENT_IDE_HOME", home);
    }
    let (output, exit_code) = process::execute(command, input, cancel).await?;
    if matches!(source, "pool" | "bridge")
        && (!output.ends_with(b"\n") || output.iter().filter(|byte| **byte == b'\n').count() != 1)
    {
        return Err(ReadError::invalid("observer_frame"));
    }
    let value: Value = serde_json::from_slice(&output)
        .map_err(|_| ReadError::incompatible("observer_json_required"))?;
    if request.resource == Resource::IdeIdentity {
        if !value.is_object()
            || value.get("read_only").and_then(Value::as_bool) != Some(true)
            || !value.get("version").is_some_and(Value::is_string)
            || !value.get("home").is_some_and(Value::is_string)
            || !value.get("checked_at").is_some_and(Value::is_string)
            || !value
                .get("findings")
                .and_then(Value::as_array)
                .is_some_and(|findings| {
                    findings.len() <= 256
                        && findings.iter().all(|finding| {
                            finding.is_object()
                                && ["code", "component", "detail"]
                                    .iter()
                                    .all(|field| finding.get(*field).is_some_and(Value::is_string))
                                && matches!(
                                    finding.get("severity").and_then(Value::as_str),
                                    Some("info" | "warn" | "error")
                                )
                        })
                })
        {
            return Err(ReadError::incompatible("ide_doctor_schema"));
        }
        // Doctor's exit 2 reports installation errors inside an otherwise valid read.
        // Every other failure, signal or incomplete request delivery remains unavailable.
        let has_error = value["findings"].as_array().is_some_and(|findings| {
            findings
                .iter()
                .any(|finding| finding["severity"] == "error")
        });
        if !matches!((exit_code, has_error), (Some(0), false) | (Some(2), true)) {
            return Err(ReadError::unavailable("helper_exit"));
        }
        return Ok(value);
    }
    let value = validate_structured(value, request.resource, true)?;
    if exit_code != Some(0) {
        return Err(ReadError::invalid("helper_exit_contract"));
    }
    Ok(value)
}

/// Validates the versioned structured outer envelope without rebuilding product schemas.
/// Source domain failures remain errors; arbitrary text is never parsed for replacement data.
pub(crate) fn validate_structured(
    value: Value,
    resource: Resource,
    require_version: bool,
) -> Result<Value, ReadError> {
    if !value.is_object()
        || (require_version && value.get("schema_version").and_then(Value::as_u64) != Some(1))
    {
        return Err(ReadError::incompatible("source_schema"));
    }
    if let Some(kind) = resource.kind() {
        if value.get("kind").and_then(Value::as_str) != Some(kind) {
            return Err(ReadError::incompatible("source_kind"));
        }
        if value.get("data").is_some() == value.get("error").is_some()
            || value.get("data").is_some_and(|data| !data.is_object())
        {
            return Err(ReadError::invalid("source_envelope"));
        }
    }
    if value
        .get("operation")
        .is_some_and(|v| v.as_str() != Some(resource.method()))
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
    Ok(value)
}
