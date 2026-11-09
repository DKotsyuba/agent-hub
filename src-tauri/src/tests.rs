//! Isolated contract tests; fake services never call installed agents, models or daemons.

use crate::{
    adapters,
    config::{Connections, FileConfig},
    contract::{FRAME_LIMIT, Outcome, PARAM_LIMIT, ReadRequest, ReadResponse, Resource},
    hub::Hub,
    process, run,
};
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    sync::{oneshot, watch},
};

/// Creates an isolated private test directory below the caller's explicit TMPDIR artifact root.
fn directory() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("native-test-")
        .tempdir()
        .expect("TMPDIR prepares writable test artifacts")
}

/// Returns native defaults whose Run endpoint is an isolated fake socket.
fn connections(socket: &Path) -> Connections {
    let mut config = Connections::resolve(Path::new("/nonexistent/hub-test-user"), None)
        .expect("absolute defaults");
    config.socket = socket.to_owned();
    config
}

/// Creates one private same-user fake endpoint before returning, avoiding readiness sleeps.
fn listener(directory: &Path) -> (PathBuf, UnixListener) {
    let socket = directory.join("run.sock");
    let listener = UnixListener::bind(&socket).expect("bind fake socket");
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
        .expect("private socket");
    (socket, listener)
}

/// Reads one complete fake-service request, asserting its fixed transport identity fields.
async fn request(socket: tokio::net::UnixStream) -> (Value, tokio::net::UnixStream) {
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    reader.read_line(&mut line).await.expect("fake read");
    let value: Value = serde_json::from_str(&line).expect("JSON request");
    assert_eq!(value["jsonrpc"], "2.0");
    assert_eq!(value["id"], 1);
    (value, reader.into_inner())
}

/// Writes a correlated response and closes only this fake finite connection.
async fn reply(mut socket: tokio::net::UnixStream, data: Value) {
    let mut bytes =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"result":data})).expect("fake encode");
    bytes.push(b'\n');
    socket.write_all(&bytes).await.expect("fake write");
}

/// Verifies every accepted resource maps to an immutable product read and mutations deserialize nowhere.
#[test]
fn exact_closed_read_allowlist() {
    let expected = [
        ("run.identity", "ping"),
        ("run.agents", "list_agents"),
        ("run.transcript", "transcript"),
        ("run.transcript_exact", "transcript_exact"),
        ("run.initial_task", "initial_task"),
        ("run.answer", "answer"),
        ("run.answer_chunk", "answer_chunk"),
        ("run.models", "models"),
        ("run.limits", "limits"),
        ("run.pools", "list_pools"),
        ("run.pool", "pool"),
        ("worktree.identity", "get_status"),
        ("worktree.list", "list_worktrees"),
        ("worktree.inspect", "inspect_worktree"),
        ("tasks.identity", "get_status"),
        ("tasks.peek", "peek"),
        ("pool.identity", "identity"),
        ("pool.list", "list"),
        ("pool.get", "get"),
        ("pool.run_proof", "get"),
        ("pool.inventory_snapshot", "inventory_snapshot"),
        ("bridge.identity", "identity"),
        ("bridge.overview", "overview"),
        ("bridge.deliveries", "deliveries"),
        ("bridge.incidents", "incidents"),
        ("ide.identity", "doctor"),
        ("ide.observe", "observe"),
    ];
    for (resource, method) in expected {
        let read: ReadRequest =
            serde_json::from_value(json!({"resource":resource})).expect("documented resource");
        assert_eq!(read.resource.method(), method);
        if !matches!(
            resource,
            "pool.run_proof" | "pool.inventory_snapshot" | "run.initial_task"
        ) {
            read.validate().expect("empty object default");
        }
    }
    for mutation in [
        "run.spawn",
        "run.cancel",
        "pool.create",
        "pool.settle",
        "bridge.recover",
        "tasks.status",
        "tasks.plan-save",
        "ide.check",
        "worktree.create",
        "answer_chunk",
        "tools/call",
    ] {
        assert!(
            serde_json::from_value::<ReadRequest>(json!({"resource":mutation,"params":{}}))
                .is_err(),
            "{mutation}"
        );
    }
    assert!(
        serde_json::from_value::<ReadRequest>(json!({"resource":"run.agents","method":"spawn"}))
            .is_err()
    );
}

/// Rejects renderer authority and nonobject/oversized params, including encoded Unicode byte size.
#[test]
fn renderer_params_and_authority_are_bounded() {
    for params in [
        Value::Null,
        json!([]),
        json!({"method":"spawn"}),
        json!({"token":"secret"}),
        json!({"caller_context":{}}),
        json!({"filter":{"native_identity":"not-renderer-authority"}}),
        json!({"program":"/bin/sh"}),
    ] {
        assert!(
            ReadRequest {
                resource: Resource::RunAgents,
                params
            }
            .validate()
            .is_err()
        );
    }
    let mut read = ReadRequest {
        resource: Resource::RunAgents,
        params: json!({"query":"x".repeat(PARAM_LIMIT)}),
    };
    assert_eq!(
        read.validate().expect_err("encoded params budget").code,
        "params_budget"
    );
    read.params = json!({"query":"я".repeat(PARAM_LIMIT/2)});
    assert!(read.validate().is_err());
    read.params = json!({"offset":200,"limit":100,"active":false});
    read.validate().expect("source-owned pagination params");
}

/// Rejects malformed, oversized, uncorrelated and ambiguous RPC frames without leaking errors.
#[test]
fn run_frames_validate_identity_and_budgets() {
    let valid = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"revision\":17,\"items\":[]}}\n";
    assert_eq!(run::decode(valid, 1).expect("valid frame")["revision"], 17);
    for invalid in [
        b"not json\n".as_slice(),
        b"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n",
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{},\"error\":{}}\n",
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}",
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}\n",
    ] {
        assert!(run::decode(invalid, 1).is_err());
    }
    assert_eq!(
        run::decode(&vec![b'x'; FRAME_LIMIT + 1], 1)
            .expect_err("budget")
            .code,
        "frame_budget"
    );
    let unavailable = run::decode(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"token=TOPSECRET\"}}\n", 1).expect_err("unsupported read");
    assert_eq!(unavailable.outcome, Outcome::Incompatible);
    assert!(
        !serde_json::to_string(&unavailable)
            .expect("safe error")
            .contains("TOPSECRET")
    );
}

/// Preserves producer pagination, Unicode answers, clocks and raw payload without normalization.
#[test]
fn response_retains_source_clocks_coverage_and_unicode() {
    let data = json!({"complete":false,"observed_at":"2000-01-01T00:00:00Z","revision":9,"message_revision":12,"next_offset":100,"answer":"ответ 🐈","coverage":{"total":253}});
    let result = ReadResponse::from_result(Resource::RunAgents, Ok(data.clone()));
    assert_eq!(result.data, data);
    assert_eq!(result.outcome, Outcome::Partial);
    assert!(result.error.is_none());
    let error = ReadResponse::from_result(
        Resource::RunAgents,
        Err(crate::contract::ReadError::unavailable("test_source")),
    );
    assert_eq!(error.data, Value::Null);
    assert!(error.error.is_some());
}

/// Strict configuration rejects typos, unsupported per-product switches, relative paths and versions.
#[test]
fn configuration_defaults_only_for_missing_fields() {
    let defaults = Connections::resolve(Path::new("/Users/example"), None).expect("defaults");
    assert_eq!(
        defaults.socket,
        Path::new("/Users/example/.agent-run/api.sock")
    );
    assert_eq!(defaults.broker_uid, None);
    assert_eq!(
        defaults.programs["tasks"].program.as_deref(),
        Some(Path::new("/Users/example/.local/bin/agent-tasks"))
    );
    for invalid in [
        json!({"schema_version":2}),
        json!({"schema_version":1,"run":{"socket":"relative"}}),
        json!({"schema_version":1,"run":{"broker_uid":1000}}),
        json!({"schema_version":1,"ide":{"config":"/private/config"}}),
        json!({"schema_version":1,"tasks":{"home":"/private/home"}}),
    ] {
        let parsed: FileConfig = serde_json::from_value(invalid).expect("structural config");
        assert!(Connections::resolve(Path::new("/Users/example"), Some(parsed)).is_err());
    }
    for invalid in [
        json!({"schema_version":1,"tasks":{"argv":["status"]}}),
        json!({"schema_version":1,"credentials":"secret"}),
    ] {
        assert!(serde_json::from_value::<FileConfig>(invalid).is_err());
    }
    let configured: FileConfig = serde_json::from_value(
        json!({"schema_version":1,"run":{"socket":"/run/agent-run/client.sock","broker_uid":1000}}),
    )
    .expect("explicit shared broker config");
    assert_eq!(
        Connections::resolve(Path::new("/Users/example"), Some(configured))
            .expect("trusted broker UID")
            .broker_uid,
        Some(1000)
    );
}

/// Producer errors are failures, and MCP outer kinds/versions are mandatory rather than parsed prose.
#[test]
fn structured_contract_rejects_error_and_text_fallbacks() {
    let valid = json!({"schema_version":1,"kind":"project_snapshot","data":{"pending":{"state":"pending"},"error":null}});
    assert_eq!(
        adapters::validate_structured(valid.clone(), Resource::TasksPeek, true)
            .expect("pending is retained"),
        valid
    );
    for invalid in [
        json!("readable text"),
        json!({"schema_version":1,"kind":"wrong","data":{}}),
        json!({"schema_version":2,"kind":"project_snapshot","data":{}}),
    ] {
        assert!(adapters::validate_structured(invalid, Resource::TasksPeek, true).is_err());
    }
    let error = json!({"schema_version":1,"kind":"project_snapshot","data":{"error":{"code":"private","message":"credential=TOPSECRET"}}});
    let result = adapters::validate_structured(error, Resource::TasksPeek, true)
        .expect_err("source failure stays failure");
    assert!(
        !serde_json::to_string(&result)
            .expect("safe error")
            .contains("TOPSECRET")
    );
}

/// Follows three independent fake Run pages (>200 agents) and preserves explicit source coverage.
#[tokio::test]
async fn run_all_pages_and_fixed_methods() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let server = tokio::spawn(async move {
        for offset in [0, 100, 200] {
            let (stream, _) = listener.accept().await.expect("accept finite read");
            let (request, stream) = request(stream).await;
            assert_eq!(request["method"], "list_agents");
            assert_eq!(request["params"]["offset"], offset);
            let end = (offset + 100).min(253);
            let items: Vec<_> = (offset..end)
                .map(|id| json!({"agent_id":format!("a{id}"),"sequence":1}))
                .collect();
            reply(stream,json!({"items":items,"total":253,"offset":offset,"limit":100,"complete":end==253,"next_offset":if end<253 {Some(end)} else {None},"revision":3,"message_revision":8,"observed_at":"original"})).await;
        }
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let mut offset = 0;
    let mut ids = std::collections::BTreeSet::new();
    loop {
        let response = hub
            .read_once(ReadRequest {
                resource: Resource::RunAgents,
                params: json!({"offset":offset,"limit":100,"active":false}),
            })
            .await;
        assert!(response.error.is_none(), "{:?}", response.error);
        assert_eq!(response.data["observed_at"], "original");
        for item in response.data["items"].as_array().expect("page") {
            ids.insert(item["agent_id"].as_str().expect("stable id").to_owned());
        }
        let Some(next) = response.data["next_offset"].as_u64() else {
            break;
        };
        offset = next;
    }
    assert_eq!(ids.len(), 253);
    server.await.expect("fake served exactly allowed pages");
    hub.close().await.expect("read cleanup");
}

/// Cancelling a partially received Run frame closes its connection and never contaminates the next read.
#[tokio::test]
async fn run_partial_frame_cancellation_is_connection_local() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let (partial, received) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept first");
        let (_, mut stream) = request(stream).await;
        stream
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":")
            .await
            .expect("partial frame");
        partial.send(()).expect("ready receiver");
        let mut trailing = Vec::new();
        assert_eq!(
            stream
                .read_to_end(&mut trailing)
                .await
                .expect("cancel closes socket"),
            0
        );
        let (stream, _) = listener.accept().await.expect("independent second");
        let (_, stream) = request(stream).await;
        reply(stream, json!({"items":[],"complete":true})).await;
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let (cancel, mut receiver) = watch::channel(false);
    let reader = Arc::clone(&hub);
    let pending = tokio::spawn(async move {
        reader
            .read(
                ReadRequest {
                    resource: Resource::RunAgents,
                    params: json!({}),
                },
                &mut receiver,
            )
            .await
    });
    received
        .await
        .expect("partial bytes sent before cancellation");
    cancel.send_replace(true);
    let cancelled = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .expect("bounded cancellation")
        .expect("reader join");
    assert_eq!(cancelled.error.expect("cancelled error").code, "cancelled");
    let next = hub
        .read_once(ReadRequest {
            resource: Resource::RunAgents,
            params: json!({}),
        })
        .await;
    assert!(next.error.is_none());
    server.await.expect("closed then independent call");
}

/// Unavailable and non-private endpoints produce explicit failures without calling another source.
#[tokio::test]
async fn run_unavailable_and_wrong_endpoint_permissions() {
    let directory = directory();
    assert_eq!(
        run::call(
            &directory.path().join("missing.sock"),
            None,
            "ping",
            json!({})
        )
        .await
        .expect_err("absent")
        .outcome,
        Outcome::Unavailable
    );
    assert_eq!(
        run::call(
            &directory.path().join("missing.sock"),
            None,
            "spawn",
            json!({})
        )
        .await
        .expect_err("mutation denied before I/O")
        .code,
        "method_denied"
    );
    let (socket, _listener) = listener(directory.path());
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o666))
        .expect("insecure fake");
    assert_eq!(
        run::call(&socket, None, "ping", json!({}))
            .await
            .expect_err("private only")
            .code,
        "run_endpoint_identity"
    );
}

/// Writes an isolated executable fake; its source is never supplied by renderer arguments.
fn executable(directory: &Path, body: &str) -> PathBuf {
    let file = directory.join("fake-helper");
    std::fs::write(&file, format!("#!/bin/sh\n{body}\n")).expect("fake script");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700))
        .expect("executable fake");
    file
}

/// Validates observer stdin/argv using a fake helper, with no real service or credentials.
#[tokio::test]
async fn observer_cli_is_fixed_and_errors_are_redacted() {
    let directory = directory();
    let program = executable(
        directory.path(),
        r#"[ "$1" = observe ] || exit 9
IFS= read -r line
case "$line" in *'"operation":"list"'*) ;; *) exit 10 ;; esac
printf '%s\n' '{"schema_version":1,"kind":"pool_page","data":{"pools":[],"coverage":{"complete":true}}}'"#,
    );
    let mut config = connections(&directory.path().join("absent.sock"));
    config.programs.get_mut("pool").expect("pool").program = Some(program);
    let (_cancel, mut receiver) = watch::channel(false);
    let result = adapters::read(
        &config,
        &ReadRequest {
            resource: Resource::PoolList,
            params: json!({"limit":100}),
        },
        &mut receiver,
    )
    .await
    .expect("fake observer");
    assert_eq!(result.0["data"]["pools"], json!([]));
    let bad = executable(
        directory.path(),
        "printf '%s\\n' 'credential=TOPSECRET' >&2\nexit 2",
    );
    config.programs.get_mut("pool").expect("pool").program = Some(bad);
    let failure = adapters::read(
        &config,
        &ReadRequest {
            resource: Resource::PoolList,
            params: json!({}),
        },
        &mut receiver,
    )
    .await
    .expect_err("unsupported helper");
    assert_eq!(failure.outcome, Outcome::Incompatible);
    assert!(
        !serde_json::to_string(&failure)
            .expect("sanitized")
            .contains("TOPSECRET")
    );
}

/// Output overflow kills/reaps a fake helper instead of retaining an unbounded frame.
#[tokio::test]
async fn cli_output_budget_is_enforced() {
    let directory = directory();
    let program = executable(directory.path(), "exec /usr/bin/yes x");
    let (_cancel, mut receiver) = watch::channel(false);
    let failure = process::execute(
        process::command(&program, &[], "pool").expect("fixed command"),
        Vec::new(),
        &mut receiver,
    )
    .await
    .expect_err("overflow");
    assert_eq!(failure.code, "frame_budget");
}

/// Cooperative cancellation reaps only the app-owned fake child after a concrete readiness handshake.
#[tokio::test]
async fn cli_cancel_reaps_owned_child() {
    let directory = directory();
    let readiness = directory.path().join("ready.sock");
    let ready = UnixListener::bind(&readiness).expect("readiness endpoint");
    // nc is only an isolated fake readiness client; no installed product is invoked.
    let program = executable(
        directory.path(),
        "printf '%s\\n' \"$$\"\nexec /usr/bin/nc -U \"$1\"",
    );
    let (cancel, mut receiver) = watch::channel(false);
    let command = process::command(
        &program,
        &[readiness.to_str().expect("test UTF8").into()],
        "pool",
    )
    .expect("owned fake");
    let pending =
        tokio::spawn(async move { process::execute(command, Vec::new(), &mut receiver).await });
    let (mut peer, _) = tokio::time::timeout(Duration::from_secs(3), ready.accept())
        .await
        .expect("fake reaches I/O")
        .expect("connected fake");
    cancel.send_replace(true);
    let failure = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .expect("cleanup bounded")
        .expect("task joined")
        .expect_err("cancelled");
    assert_eq!(failure.code, "cancelled");
    let mut bytes = Vec::new();
    assert_eq!(
        peer.read_to_end(&mut bytes)
            .await
            .expect("owned child closed endpoint"),
        0
    );
}

/// Creates a fake MCP frontend with real NDJSON initialization and one structured read reply.
fn mcp_executable(directory: &Path, result: &Value) -> PathBuf {
    let result = serde_json::to_string(result)
        .expect("fake structured result")
        .replace('\'', "'\\''");
    let log = directory.join("calls.ndjson");
    executable(
        directory,
        &format!(
            r#"[ "$1" = mcp ] || exit 9
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{log}'
  id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":"2024-11-05","capabilities":{{"tools":{{}}}},"serverInfo":{{"name":"fake-read","version":"1"}}}}}}\n' "$id" ;;
    *'"method":"tools/call"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":%s}}\n' "$id" '{result}' ;;
    *'"method":"notifications/initialized"'*) ;;
    *) exit 10 ;;
  esac
done"#,
            log = log.display()
        ),
    )
}

/// Verifies real rmcp initialization, fixed peek-only invocation and original pending data retention.
#[tokio::test]
async fn mcp_peek_uses_structured_content_only() {
    let directory = directory();
    let structured = json!({"schema_version":1,"kind":"project_snapshot","data":{"repository":{"id":"repo","common_dir":"/repo/.git","source_path":"/repo"},"plan_state":"missing","plan":null,"report_state":"missing","report":null,"pending":{"state":"pending","analysis_id":"a1","plan_revision":"p1"},"error":null}});
    let program = mcp_executable(
        directory.path(),
        &json!({"content":[{"type":"text","text":"ignored producer prose"}],"structuredContent":structured,"isError":false}),
    );
    let mut config = connections(&directory.path().join("absent.sock"));
    config.programs.get_mut("tasks").expect("tasks").program = Some(program);
    let (_cancel, mut receiver) = watch::channel(false);
    let result = adapters::read(
        &config,
        &ReadRequest {
            resource: Resource::TasksPeek,
            params: json!({"repository":"/repo"}),
        },
        &mut receiver,
    )
    .await
    .expect("structured fake MCP");
    assert_eq!(result.0, structured);
    let calls =
        std::fs::read_to_string(directory.path().join("calls.ndjson")).expect("observed calls");
    let calls: Vec<Value> = calls
        .lines()
        .map(|line| serde_json::from_str(line).expect("request JSON"))
        .collect();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[2]["method"], "tools/call");
    assert_eq!(calls[2]["params"]["name"], "peek");
    assert_eq!(
        calls[2]["params"]["arguments"],
        json!({"repository":"/repo"})
    );
}

/// Text-only MCP responses remain incompatible and source errors never turn into successful data.
#[tokio::test]
async fn mcp_text_and_source_errors_are_explicit() {
    let directory = directory();
    let mut config = connections(&directory.path().join("absent.sock"));
    let (_cancel, mut receiver) = watch::channel(false);
    for (payload, code) in [
        (
            json!({"content":[{"type":"text","text":"{\"schema_version\":1}"}],"isError":false}),
            "structured_content_required",
        ),
        (
            json!({"content":[{"type":"text","text":"credential=TOPSECRET"}],"isError":true}),
            "mcp_source_error",
        ),
    ] {
        config.programs.get_mut("tasks").expect("tasks").program =
            Some(mcp_executable(directory.path(), &payload));
        let failure = adapters::read(
            &config,
            &ReadRequest {
                resource: Resource::TasksPeek,
                params: json!({"repository":"/repo"}),
            },
            &mut receiver,
        )
        .await
        .expect_err("explicit failure");
        assert_eq!(failure.code, code);
        assert!(
            !serde_json::to_string(&failure)
                .expect("sanitized")
                .contains("TOPSECRET")
        );
    }
}

/// Shutdown rejects further work and interrupts a finite read after a source handshake.
#[tokio::test]
async fn shutdown_closes_read_admission_and_joins_cleanup() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let (ready, observed) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("read accepted");
        let (_, mut stream) = request(stream).await;
        ready.send(()).expect("read readiness");
        let mut bytes = Vec::new();
        assert_eq!(
            stream
                .read_to_end(&mut bytes)
                .await
                .expect("shutdown closes"),
            0
        );
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let reader = hub.clone();
    let pending = tokio::spawn(async move {
        reader
            .read_once(ReadRequest {
                resource: Resource::RunAgents,
                params: json!({}),
            })
            .await
    });
    observed.await.expect("admitted socket read");
    tokio::time::timeout(Duration::from_secs(3), hub.close())
        .await
        .expect("shutdown deadline")
        .expect("joined read cleanup");
    assert_eq!(
        pending
            .await
            .expect("reader joined")
            .error
            .expect("cancelled")
            .code,
        "cancelled"
    );
    let rejected = hub
        .read_once(ReadRequest {
            resource: Resource::RunAgents,
            params: json!({}),
        })
        .await;
    assert_eq!(rejected.error.expect("closed admission").code, "cancelled");
    server.await.expect("fake sees close");
}

/// Valid Worktree structured data survives its legacy text-presentation isError flag.
#[tokio::test]
async fn worktree_presentation_failure_preserves_data_as_partial() {
    let directory = directory();
    let structured = json!({"schema_version":1,"kind":"worktree_page","data":{"returned":0,"has_more":false,"cursor":null,"rows":[],"coverage":{"failed":[]}}});
    let program = mcp_executable(
        directory.path(),
        &json!({"content":[{"type":"text","text":"formatter failed"}],"structuredContent":structured,"isError":true}),
    );
    let mut config = connections(&directory.path().join("absent.sock"));
    config
        .programs
        .get_mut("worktree")
        .expect("worktree")
        .program = Some(program);
    let hub = Hub::new(Ok(config));
    let response = hub
        .read_once(ReadRequest {
            resource: Resource::WorktreeList,
            params: json!({}),
        })
        .await;
    assert_eq!(response.outcome, Outcome::Partial);
    assert_eq!(
        response.error.expect("presentation warning").code,
        "presentation_degraded"
    );
    assert_eq!(response.data, structured);
    hub.close().await.expect("all owned readers closed");
}

/// Opaque subscription cancellation joins a blocked read and emits no obsolete channel message.
#[tokio::test]
async fn unwatch_joins_partial_read_without_obsolete_emission() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let (ready, observed) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("watch accepted");
        let (_, mut stream) = request(stream).await;
        stream
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,")
            .await
            .expect("partial watch response");
        ready.send(()).expect("source handshake");
        let mut bytes = Vec::new();
        assert_eq!(
            stream
                .read_to_end(&mut bytes)
                .await
                .expect("unwatch closes socket"),
            0
        );
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let messages = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = Arc::clone(&messages);
    let channel = tauri::ipc::Channel::new(move |_| {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    });
    let id = hub
        .watch(
            ReadRequest {
                resource: Resource::RunAgents,
                params: json!({}),
            },
            channel,
        )
        .await
        .expect("bounded subscription");
    observed
        .await
        .expect("blocked partial frame before unwatch");
    tokio::time::timeout(Duration::from_secs(3), hub.unwatch(&id))
        .await
        .expect("unwatch deadline")
        .expect("task joined");
    assert_eq!(messages.load(std::sync::atomic::Ordering::SeqCst), 0);
    hub.unwatch(&id).await.expect("idempotent unwatch");
    hub.close().await.expect("registry drained");
    server.await.expect("fake stream closed");
}

/// Ordered channel emissions advance both Run revisions, retaining user pagination and bounded long-poll.
#[tokio::test]
async fn watch_orders_messages_and_tracks_dual_revisions() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let server = tokio::spawn(async move {
        for message_revision in [4, 5] {
            let (stream, _) = listener.accept().await.expect("watched read");
            let (read, stream) = request(stream).await;
            assert_eq!(read["params"]["offset"], 200);
            if message_revision == 5 {
                assert_eq!(read["params"]["after_revision"], 3);
                assert_eq!(read["params"]["after_message_revision"], 4);
                assert_eq!(read["params"]["wait_seconds"], 25);
            }
            reply(stream,json!({"items":[],"revision":3,"message_revision":message_revision,"complete":true})).await;
        }
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let channel = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(body) = body {
            let value: Value = serde_json::from_str(&body).expect("serialized read response");
            sender.send(value).expect("bounded test receiver open");
        }
        Ok(())
    });
    let id = hub
        .watch(
            ReadRequest {
                resource: Resource::RunAgents,
                params: json!({"offset":200,"limit":100}),
            },
            channel,
        )
        .await
        .expect("watch");
    for expected in [4, 5] {
        let response = tokio::time::timeout(Duration::from_secs(4), receiver.recv())
            .await
            .expect("ordered watch deadline")
            .expect("channel message");
        assert_eq!(response["data"]["message_revision"], expected);
    }
    hub.unwatch(&id).await.expect("stop watcher");
    hub.close().await.expect("no observer remains");
    server.await.expect("exact dual cursor requests");
}

/// MCP malformed frames and wrong ids terminate safely instead of being interpreted as text.
#[tokio::test]
async fn mcp_rejects_malformed_and_uncorrelated_frames() {
    let directory = directory();
    let mut config = connections(&directory.path().join("absent.sock"));
    let (_cancel, mut receiver) = watch::channel(false);
    for (frame, code) in [
        ("not JSON", "frame_json"),
        (
            r#"{"jsonrpc":"2.0","id":999999,"result":{}}"#,
            "mcp_correlation",
        ),
    ] {
        let program = executable(
            directory.path(),
            &format!(
                "IFS= read -r line\nprintf '%s\\n' '{frame}'\nwhile IFS= read -r line; do :; done"
            ),
        );
        config.programs.get_mut("tasks").expect("tasks").program = Some(program);
        let failure = adapters::read(
            &config,
            &ReadRequest {
                resource: Resource::TasksIdentity,
                params: json!({}),
            },
            &mut receiver,
        )
        .await
        .expect_err("bad source frame");
        assert_eq!(failure.code, code);
    }
}

/// IDE identity requires its explicit read-only flag and attestation; warnings remain source health facts.
#[tokio::test]
async fn ide_doctor_uses_existing_json_contract() {
    let directory = directory();
    let data = json!({"version":"0.10.9","read_only":true,"home":"/fake/home","checked_at":"original","findings":[{"code":"warning","severity":"warn","component":"volume","detail":"not a daemon qualification"}]});
    let program = executable(
        directory.path(),
        &format!(
            "[ \"$#\" = 2 ] && [ \"$1\" = doctor ] && [ \"$2\" = --read-only ] || exit 9\nprintf '%s\\n' '{}'",
            serde_json::to_string(&data).expect("safe fixed JSON")
        ),
    );
    let mut config = connections(&directory.path().join("absent.sock"));
    config.programs.get_mut("ide").expect("ide").program = Some(program);
    let (_cancel, mut receiver) = watch::channel(false);
    let result = adapters::read(
        &config,
        &ReadRequest {
            resource: Resource::IdeIdentity,
            params: json!({}),
        },
        &mut receiver,
    )
    .await
    .expect("existing doctor output");
    assert_eq!(result.0, data);
}

/// Doctor exit 2 preserves valid installation errors; unrelated exits and malformed
/// or contradictory reports never become successful diagnostic reads.
#[tokio::test]
async fn ide_doctor_preserves_documented_error_findings_only() {
    let directory = directory();
    let report = json!({"version":"0.10.9","read_only":true,"home":"/fake/home","checked_at":"original","findings":[{"code":"missing","severity":"error","component":"launcher_config","detail":"launcher configuration is missing"}]});
    let mut config = connections(&directory.path().join("absent.sock"));
    let (_cancel, mut receiver) = watch::channel(false);
    for (data, exit, expected) in [
        (report.clone(), 2, true),
        (report.clone(), 1, false),
        (report.clone(), 0, false),
        (
            json!({"read_only":true,"version":"0.10.9","findings":[]}),
            2,
            false,
        ),
        (
            json!({"read_only":true,"version":"0.10.9","home":"/fake/home","checked_at":"original","findings":[]}),
            2,
            false,
        ),
        (
            json!({"read_only":true,"version":"0.10.9","home":"/fake/home","checked_at":"original","findings":[{"code":"missing","severity":"error","detail":"incomplete finding"}]}),
            2,
            false,
        ),
    ] {
        let program = executable(
            directory.path(),
            &format!(
                "printf '%s\\n' '{}'\nexit {exit}",
                serde_json::to_string(&data).expect("fixed diagnostic fixture")
            ),
        );
        config.programs.get_mut("ide").expect("ide").program = Some(program);
        let result = adapters::read(
            &config,
            &ReadRequest {
                resource: Resource::IdeIdentity,
                params: json!({}),
            },
            &mut receiver,
        )
        .await;
        if expected {
            assert_eq!(result.expect("documented diagnostic exit").0, report);
        } else {
            assert!(result.is_err(), "exit {exit} must not validate {data}");
        }
    }
}

/// Channel panics are observed as join errors; no source read or child is left running.
#[tokio::test]
async fn subscription_panic_is_observed_during_unwatch() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("watch accepted");
        let (_, stream) = request(stream).await;
        reply(stream, json!({"items":[],"complete":true})).await;
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let (ready, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let channel = tauri::ipc::Channel::new(move |_| {
        ready.send(()).expect("panic readiness");
        panic!("isolated channel failure");
    });
    let id = hub
        .watch(
            ReadRequest {
                resource: Resource::RunAgents,
                params: json!({}),
            },
            channel,
        )
        .await
        .expect("watch");
    tokio::time::timeout(Duration::from_secs(3), observed.recv())
        .await
        .expect("actual callback before join")
        .expect("callback readiness");
    let failure = hub.unwatch(&id).await.expect_err("panic is observed");
    assert_eq!(failure.code, "watch_join");
    hub.close()
        .await
        .expect("remaining registry and reads clean");
    server.await.expect("fake exited normally");
}

/// Subscription budget rejects overload without creating extra read helpers or tasks.
#[tokio::test]
async fn subscription_admission_is_bounded() {
    let hub = Hub::new(Err(crate::contract::ReadError::invalid("isolated_config")));
    let mut ids = Vec::new();
    for _ in 0..24 {
        ids.push(
            hub.watch(
                ReadRequest {
                    resource: Resource::PoolList,
                    params: json!({}),
                },
                tauri::ipc::Channel::new(|_| Ok(())),
            )
            .await
            .expect("within subscription budget"),
        );
    }
    let rejected = hub
        .watch(
            ReadRequest {
                resource: Resource::PoolList,
                params: json!({}),
            },
            tauri::ipc::Channel::new(|_| Ok(())),
        )
        .await
        .expect_err("25th subscription denied");
    assert_eq!(rejected.code, "subscription_budget");
    for id in ids {
        hub.unwatch(&id).await.expect("bounded task joined");
    }
    hub.close().await.expect("all tasks drained");
}

/// Answer chunks are never requested from a broker whose finite discovery lacks the method.
#[tokio::test]
async fn answer_chunk_requires_discovery_without_artifact_fallback() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("discovery only");
        let (read, stream) = request(stream).await;
        assert_eq!(read["method"], "tools");
        reply(stream, json!([{"name":"ping"},{"name":"answer"}])).await;
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let response = hub.read_once(ReadRequest{resource:Resource::RunAnswerChunk,params:json!({"agent_id":"a","sequence":1,"expected_sha256":"0".repeat(64),"offset_bytes":0})}).await;
    assert_eq!(response.outcome, Outcome::Incompatible);
    assert_eq!(
        response.error.expect("capability missing").code,
        "answer_chunk_unavailable"
    );
    server.await.expect("only discovery observed");
    hub.close().await.expect("closed");
}

/// Legacy identity preserves unknown broker build instead of inferring it from ping or installed code.
#[tokio::test]
async fn run_identity_keeps_unknown_version_null() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let server = tokio::spawn(async move {
        for method in ["ping", "tools"] {
            let (stream, _) = listener.accept().await.expect("finite identity read");
            let (read, stream) = request(stream).await;
            assert_eq!(read["method"], method);
            reply(
                stream,
                if method == "ping" {
                    json!({"ok":true})
                } else {
                    json!([{"name":"ping"}])
                },
            )
            .await;
        }
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let response = hub
        .read_once(ReadRequest {
            resource: Resource::RunIdentity,
            params: json!({}),
        })
        .await;
    assert!(response.error.is_none());
    assert_eq!(response.data["version"], Value::Null);
    assert_eq!(response.data["capabilities"], Value::Null);
    assert_eq!(response.data["ping"], json!({"ok":true}));
    server.await.expect("no invented capability call");
    hub.close().await.expect("closed");
}

/// Observer framing and exit status cannot contradict an apparently successful JSON payload.
#[tokio::test]
async fn observer_rejects_extra_frames_and_failed_success_exit() {
    let directory = directory();
    let mut config = connections(&directory.path().join("absent.sock"));
    let (_cancel, mut receiver) = watch::channel(false);
    for (body, expected) in [
        (
            "printf '%s' '{\"schema_version\":1,\"operation\":\"list\",\"data\":{},\"error\":null}'",
            "observer_frame",
        ),
        ("printf '%s\\n%s\\n' '{}' '{}'", "observer_frame"),
        (
            "printf '%s\\n' '{\"schema_version\":1,\"kind\":\"pool_page\",\"data\":{}}'\nexit 1",
            "helper_exit_contract",
        ),
    ] {
        config.programs.get_mut("pool").expect("pool").program =
            Some(executable(directory.path(), body));
        let failure = adapters::read(
            &config,
            &ReadRequest {
                resource: Resource::PoolList,
                params: json!({}),
            },
            &mut receiver,
        )
        .await
        .expect_err("contradictory observer reply");
        assert_eq!(failure.code, expected);
    }
}

/// Standalone Pool uses its own typed pages/details and exclusive source error branch.
#[test]
fn pool_observer_envelope_preserves_namespace_and_coverage() {
    for (resource, kind) in [
        (Resource::PoolIdentity, "identity"),
        (Resource::PoolList, "pool_page"),
        (Resource::PoolGet, "pool_detail"),
        (Resource::PoolRunProof, "run_proof"),
        (Resource::PoolInventorySnapshot, "inventory_snapshot"),
    ] {
        let payload = json!({"schema_version":1,"kind":kind,"data":{"source_timestamp":null,"observed_at_unix_ms":123,"coverage":{"source_timestamp":"unavailable"}}});
        assert_eq!(
            adapters::validate_structured(payload.clone(), resource, true)
                .expect("typed Pool envelope"),
            payload
        );
        let blocked = json!({"schema_version":1,"kind":kind,"error":{"code":"not_configured","outcome":"blocked","detail":"credential=TOPSECRET"}});
        let failure =
            adapters::validate_structured(blocked, resource, true).expect_err("blocked source");
        assert_eq!(failure.outcome, Outcome::Unavailable);
        assert!(
            !serde_json::to_string(&failure)
                .expect("safe error")
                .contains("TOPSECRET")
        );
        assert!(
            adapters::validate_structured(
                json!({"schema_version":1,"kind":kind,"data":{},"error":null}),
                resource,
                true
            )
            .is_err()
        );
        assert!(
            adapters::validate_structured(
                json!({"schema_version":1,"kind":"worktree_page","data":{}}),
                resource,
                true
            )
            .is_err()
        );
    }
}

/// Pool execution proofs require one exact member and a positive roster revision.
#[test]
fn pool_run_proof_requires_a_fenced_member_request() {
    let params = json!({"pool_id":"pool", "section":"run_proof", "member_id":"member", "expected_revision":1});
    let valid = ReadRequest {
        resource: Resource::PoolRunProof,
        params: params.clone(),
    };
    valid.validate().expect("valid read-only proof request");
    for invalid in [
        json!({"pool_id":"pool", "section":"members", "member_id":"member", "expected_revision":1}),
        json!({"pool_id":"pool", "section":"run_proof", "member_id":"member"}),
        json!({"pool_id":"pool", "section":"run_proof", "member_id":"member", "expected_revision":0}),
        json!({"pool_id":"pool", "section":"run_proof", "member_id":"member", "expected_revision":1, "after":0}),
    ] {
        let request = ReadRequest {
            resource: Resource::PoolRunProof,
            params: invalid,
        };
        assert_eq!(
            request.validate().expect_err("invalid proof input").code,
            "pool_proof_params"
        );
    }
}

/// IDE helpers must attest explicit read-only diagnostics; legacy/unattested reports never fall back.
#[tokio::test]
async fn ide_identity_requires_read_only_attestation() {
    let directory = directory();
    let mut config = connections(&directory.path().join("absent.sock"));
    let (_cancel, mut receiver) = watch::channel(false);
    for attestation in [Value::Null, json!(false)] {
        let report = json!({"version":"legacy","home":"/fake/home","checked_at":"original","findings":[],"read_only":attestation});
        let program = executable(
            directory.path(),
            &format!(
                "[ \"$#\" = 2 ] && [ \"$1\" = doctor ] && [ \"$2\" = --read-only ] || exit 9\nprintf '%s\\n' '{}'",
                serde_json::to_string(&report).expect("fixed report")
            ),
        );
        config.programs.get_mut("ide").expect("ide").program = Some(program);
        let failure = adapters::read(
            &config,
            &ReadRequest {
                resource: Resource::IdeIdentity,
                params: json!({}),
            },
            &mut receiver,
        )
        .await
        .expect_err("read-only flag attestation required");
        assert_eq!(failure.outcome, Outcome::Incompatible);
        assert_eq!(failure.code, "ide_doctor_schema");
    }
}

/// Bridge diagnostics preserve retention/sequence coverage and reject mismatched or failed envelopes.
#[test]
fn bridge_observer_envelopes_preserve_retained_history() {
    for (resource, kind) in [
        (Resource::BridgeIdentity, "identity"),
        (Resource::BridgeOverview, "bridge_overview"),
        (Resource::BridgeDeliveries, "delivery_page"),
        (Resource::BridgeIncidents, "incident_page"),
    ] {
        let data = json!({"coverage":"retained_history","through_seq":120,"next_after_seq":37,"retention":{"events":42,"payload_compacted":1,"envelope_bytes":800,"oldest_accepted_at_ms":100,"newest_accepted_at_ms":200}});
        let payload = json!({"schema_version":1,"kind":kind,"data":data});
        assert_eq!(
            adapters::validate_structured(payload.clone(), resource, true)
                .expect("typed diagnostics"),
            payload
        );
        assert!(
            adapters::validate_structured(
                json!({"schema_version":1,"kind":"pool_page","data":{}}),
                resource,
                true
            )
            .is_err()
        );
        let failure = adapters::validate_structured(json!({"schema_version":1,"kind":kind,"error":{"code":"blocked","outcome":"blocked","detail":"operator-token=TOPSECRET"}}),resource,true).expect_err("explicit diagnostics failure");
        assert_eq!(failure.outcome, Outcome::Unavailable);
        assert!(
            !serde_json::to_string(&failure)
                .expect("safe diagnostics")
                .contains("TOPSECRET")
        );
    }
}

/// IDE observation maps only absolute repository/cursor argv and preserves explicitly unknown/stale facts.
#[tokio::test]
async fn ide_observe_cursor_and_source_coverage_are_preserved() {
    let directory = directory();
    let data = json!({"schema_version":1,"kind":"ide_observation","data":{"product":"agent-ide","package_version":"candidate","received_at_ms":123,"repository":{"identity":"repo","common_dir":"/repo/.git","source_path":"/repo"},"instances":[],"checks":{"availability":"available","snapshots":[{"snapshot_id":"s1","observed_at_ms":null,"freshness":"unknown","rechecking":false}],"coverage":"partial","next_cursor":8},"telemetry":{"availability":"unavailable","reason":"no retained telemetry"},"coverage":{"scope":"shared_repository_daemon","complete":false,"reason":"private instances not covered"}}});
    let program = executable(
        directory.path(),
        &format!(
            "[ \"$#\" = 6 ] && [ \"$1\" = observe ] && [ \"$2\" = --repo ] && [ \"$3\" = /repo ] && [ \"$4\" = --json ] && [ \"$5\" = --cursor ] && [ \"$6\" = 7 ] || exit 9\nprintf '%s\\n' '{}'",
            serde_json::to_string(&data).expect("fixed typed payload")
        ),
    );
    let mut config = connections(&directory.path().join("absent.sock"));
    config.programs.get_mut("ide").expect("ide").program = Some(program);
    let hub = Hub::new(Ok(config));
    let response = hub
        .read_once(ReadRequest {
            resource: Resource::IdeObserve,
            params: json!({"repository":"/repo","cursor":7}),
        })
        .await;
    assert_eq!(response.data, data);
    assert_eq!(response.outcome, Outcome::Partial);
    assert!(response.error.is_none());
    for invalid in [
        json!({"repository":"relative"}),
        json!({"repository":"/repo","cursor":-1}),
        json!({"repository":"/repo","cursor":"7"}),
        json!({"repository":"/repo","refresh":true}),
    ] {
        let response = hub
            .read_once(ReadRequest {
                resource: Resource::IdeObserve,
                params: invalid,
            })
            .await;
        assert_eq!(response.outcome, Outcome::Invalid);
    }
    hub.close().await.expect("no IDE observer remains");
}

/// A local helper deadline reaps the owned child and reports client_timeout without agent cancellation.
#[tokio::test]
async fn cli_deadline_is_local_and_reaps_owned_child() {
    let directory = directory();
    let readiness = directory.path().join("deadline.sock");
    let ready = UnixListener::bind(&readiness).expect("deadline readiness endpoint");
    let program = executable(directory.path(), "exec /usr/bin/nc -U \"$1\"");
    let (_cancel, mut receiver) = watch::channel(false);
    let command = process::command(
        &program,
        &[readiness.to_str().expect("test UTF8").into()],
        "pool",
    )
    .expect("owned read helper");
    let pending =
        tokio::spawn(async move { process::execute(command, Vec::new(), &mut receiver).await });
    let (mut peer, _) = tokio::time::timeout(Duration::from_secs(3), ready.accept())
        .await
        .expect("actual blocking read reached")
        .expect("fake connected");
    let failure = tokio::time::timeout(Duration::from_secs(20), pending)
        .await
        .expect("outer test hang guard")
        .expect("read task joined")
        .expect_err("local deadline");
    assert_eq!(failure.code, "client_timeout");
    let mut bytes = Vec::new();
    assert_eq!(
        peer.read_to_end(&mut bytes)
            .await
            .expect("owned helper reaped and disconnected"),
        0
    );
}

/// Capability-gated answer chunks preserve proof attribution and large Unicode bytes without opening paths.
#[tokio::test]
async fn answer_chunk_preserves_proof_and_large_unicode() {
    let directory = directory();
    let (socket, listener) = listener(directory.path());
    let content = "🦀я".repeat(16000);
    let answer = json!({"agent_id":"a1","sequence":3,"sha256":"a".repeat(64),"total_bytes":192000,"offset_bytes":0,"next_offset":content.len(),"content":content,"complete":false});
    let expected = answer.clone();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("chunk discovery");
        let (read, stream) = request(stream).await;
        assert_eq!(read["method"], "tools");
        reply(stream, json!([{"name":"answer_chunk"}])).await;
        let (stream, _) = listener.accept().await.expect("proof-bound chunk");
        let (read, stream) = request(stream).await;
        assert_eq!(read["method"], "answer_chunk");
        assert_eq!(
            read["params"],
            json!({"agent_id":"a1","sequence":3,"expected_sha256":"a".repeat(64),"offset_bytes":0,"max_bytes":131072})
        );
        reply(stream, answer).await;
    });
    let hub = Hub::new(Ok(connections(&socket)));
    let response = hub.read_once(ReadRequest{resource:Resource::RunAnswerChunk,params:json!({"agent_id":"a1","sequence":3,"expected_sha256":"a".repeat(64),"offset_bytes":0,"max_bytes":131072})}).await;
    assert!(response.error.is_none());
    assert_eq!(response.data, expected);
    assert_eq!(response.outcome, Outcome::Partial);
    server.await.expect("only finite allowed chunk calls");
    hub.close().await.expect("closed");
}

/// Signals a recorded app-created fixture only when recovering a failed regression;
/// normal assertions require that the native owner already killed and reaped it.
fn fixture_signal(pid: &str, signal: &str) -> bool {
    std::process::Command::new("/bin/kill")
        .args([signal, pid])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("inspect or recover owned fixture")
        .success()
}

/// Initializes MCP, consumes exactly one tools/call byte, then execs a direct
/// child that keeps stdin open without reading it. The readiness connection is
/// established only after the partial request; sed/dd exit before exec, so no
/// fixture grandchildren survive the handshake. Returns program, socket and pid file.
fn blocked_mcp_fixture(directory: &Path) -> (PathBuf, UnixListener, PathBuf) {
    let endpoint = directory.join("blocked.sock");
    let listener = UnixListener::bind(&endpoint).expect("blocked-send readiness");
    let pid = directory.join("frontend.pid");
    let program = executable(
        directory,
        &format!(
            r#"[ "$1" = mcp ] || exit 9
IFS= read -r initialize
id=$(printf '%s' "$initialize" | /usr/bin/sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":"2024-11-05","capabilities":{{"tools":{{}}}},"serverInfo":{{"name":"blocked-read","version":"1"}}}}}}\n' "$id"
IFS= read -r initialized
case "$initialized" in *'"method":"notifications/initialized"'*) ;; *) exit 10 ;; esac
/bin/dd bs=1 count=1 >/dev/null 2>/dev/null
printf '%s\n' "$$" > '{pid}'
exec /usr/bin/nc -d -U '{endpoint}'"#,
            pid = pid.display(),
            endpoint = endpoint.display()
        ),
    );
    (program, listener, pid)
}

/// A real initialized frontend stops consuming a maximum-sized request after
/// one byte. Cancellation, unwatch, shutdown and read deadlines must finish and
/// reap that exact child. A failed old implementation is recovered before the
/// test asserts failure, rather than leaving detached tasks or fixture descendants.
#[tokio::test]
async fn mcp_blocked_send_cancellation_and_shutdown_reap_frontend() {
    for action in ["cancel", "unwatch", "shutdown", "deadline"] {
        let directory = directory();
        let (program, ready, pid_file) = blocked_mcp_fixture(directory.path());
        let mut config = connections(&directory.path().join("absent.sock"));
        config.programs.get_mut("tasks").expect("tasks").program = Some(program);
        let hub = Hub::new(Ok(config));
        let mut params = json!({"repository":"/repo","padding":""});
        let overhead = serde_json::to_vec(&params).expect("params encoding").len();
        params["padding"] = json!("x".repeat(PARAM_LIMIT - overhead));
        assert_eq!(
            serde_json::to_vec(&params).expect("maximum params").len(),
            PARAM_LIMIT
        );
        let read = ReadRequest {
            resource: Resource::TasksPeek,
            params,
        };
        let (cancel, mut receiver) = watch::channel(false);
        let reader = Arc::clone(&hub);
        let mut direct = if matches!(action, "cancel" | "deadline") {
            Some(tokio::spawn(async move {
                reader.read(read, &mut receiver).await
            }))
        } else {
            None
        };
        let id = if matches!(action, "unwatch" | "shutdown") {
            Some(hub.watch(ReadRequest{resource:Resource::TasksPeek,params:json!({"repository":"/repo","padding":"x".repeat(PARAM_LIMIT-overhead)})},tauri::ipc::Channel::new(|_|Ok(()))).await.expect("watch large read"))
        } else {
            None
        };
        let (mut peer, _) = tokio::time::timeout(Duration::from_secs(5), ready.accept())
            .await
            .expect("fixture consumed partial tools/call before stop")
            .expect("readiness connected");
        let pid = std::fs::read_to_string(&pid_file).expect("owned frontend pid");
        let pid = pid.trim().to_owned();
        assert!(
            fixture_signal(&pid, "-0"),
            "fixture is alive at blocked-send handshake"
        );
        let owner = Arc::clone(&hub);
        let mut finished = match action {
            "unwatch" => tokio::spawn(async move { owner.unwatch(&id.expect("watch id")).await }),
            "shutdown" => tokio::spawn(async move { owner.close().await }),
            _ => {
                if action == "cancel" {
                    cancel.send_replace(true);
                }
                tokio::spawn(async move {
                    let response = direct
                        .take()
                        .expect("direct read")
                        .await
                        .expect("read joined");
                    assert_eq!(
                        response.error.expect("stopped read").code,
                        if action == "deadline" {
                            "client_timeout"
                        } else {
                            "cancelled"
                        }
                    );
                    Ok(())
                })
            }
        };
        let limit = if action == "deadline" {
            Duration::from_secs(20)
        } else {
            Duration::from_secs(3)
        };
        let result = tokio::time::timeout(limit, &mut finished).await;
        let timed_out = result.is_err();
        if timed_out {
            assert!(
                fixture_signal(&pid, "-KILL"),
                "recover only our blocked fixture"
            );
            tokio::time::timeout(Duration::from_secs(3), &mut finished)
                .await
                .expect("recovery unblocks worker")
                .expect("recovery joins owner")
                .expect("recovery cleanup");
        } else {
            result
                .expect("completed within bound")
                .expect("owner joined")
                .expect("native cleanup");
        }
        assert!(
            !fixture_signal(&pid, "-0"),
            "owned frontend must be reaped: {action}"
        );
        let mut bytes = Vec::new();
        assert_eq!(
            peer.read_to_end(&mut bytes)
                .await
                .expect("fixture endpoint closed"),
            0
        );
        hub.close().await.expect("all permits and tasks released");
        assert!(!timed_out, "{action} hung while rmcp send held a full pipe");
    }
}

/// Early helpers cannot discard typed error stdout on EPIPE or claim success
/// for a maximum-size request they never read. No fixture starts descendants.
#[tokio::test]
async fn cli_early_exit_retains_errors_and_rejects_undelivered_success() {
    let directory = directory();
    let mut config = connections(&directory.path().join("absent.sock"));
    let mut params = json!({"padding":""});
    let overhead = serde_json::to_vec(&params).expect("params encoding").len();
    params["padding"] = json!("x".repeat(PARAM_LIMIT - overhead));
    for (body, outcome, code) in [
        ("exit 2", Outcome::Incompatible, "helper_read_unsupported"),
        (
            "printf '%s\\n' '{\"schema_version\":1,\"kind\":\"pool_page\",\"error\":{\"code\":\"blocked\",\"outcome\":\"blocked\",\"detail\":\"secret=PRIVATE\"}}'\nexit 2",
            Outcome::Unavailable,
            "source_error",
        ),
        (
            "printf '%s\\n' '{\"schema_version\":1,\"kind\":\"pool_page\",\"data\":{}}'\nexit 0",
            Outcome::Invalid,
            "helper_exit_contract",
        ),
    ] {
        config.programs.get_mut("pool").expect("pool").program =
            Some(executable(directory.path(), body));
        let (_cancel, mut receiver) = watch::channel(false);
        let failure = adapters::read(
            &config,
            &ReadRequest {
                resource: Resource::PoolList,
                params: params.clone(),
            },
            &mut receiver,
        )
        .await
        .expect_err("early source exit");
        assert_eq!(failure.outcome, outcome);
        assert_eq!(failure.code, code);
        assert!(
            !serde_json::to_string(&failure)
                .expect("safe error")
                .contains("PRIVATE")
        );
    }
}

/// Only observed natural nonzero exits with empty/plain-text initialization
/// output identify legacy helpers. Protocol-looking malformed replies stay invalid.
#[tokio::test]
async fn mcp_legacy_subcommand_exit_is_incompatible() {
    let directory = directory();
    let mut config = connections(&directory.path().join("absent.sock"));
    for (body, outcome) in [
        ("exit 2", Outcome::Incompatible),
        (
            "printf '%s\\n' 'Usage: old-helper (mcp is unknown)'\nexit 2",
            Outcome::Incompatible,
        ),
        (
            "IFS= read -r request\nprintf '%s\\n' '{not JSON}'\nexit 2",
            Outcome::Invalid,
        ),
        (
            "IFS= read -r request\nprintf '%s\\n' 'null'\nexit 2",
            Outcome::Invalid,
        ),
        (
            "IFS= read -r request\nprintf '%s' '{broken'\nexit 2",
            Outcome::Invalid,
        ),
        (
            "IFS= read -r request\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":999999,\"result\":{}}'\nexit 2",
            Outcome::Invalid,
        ),
    ] {
        config.programs.get_mut("tasks").expect("tasks").program =
            Some(executable(directory.path(), body));
        let (_cancel, mut receiver) = watch::channel(false);
        let failure = adapters::read(
            &config,
            &ReadRequest {
                resource: Resource::TasksIdentity,
                params: json!({}),
            },
            &mut receiver,
        )
        .await
        .expect_err("initialization failed");
        assert_eq!(failure.outcome, outcome, "{}", failure.code);
    }
}

/// Product observer config paths remain app-owned fixed argv for both CLI products.
#[tokio::test]
async fn observer_config_paths_are_forwarded_as_fixed_arguments() {
    for (source, resource) in [
        ("pool", Resource::PoolIdentity),
        ("bridge", Resource::BridgeIdentity),
    ] {
        let directory = directory();
        let path = directory.path().join("observer config.toml");
        let program = executable(
            directory.path(),
            &format!(
                "[ \"$#\" = 3 ] && [ \"$1\" = observe ] && [ \"$2\" = --config ] && [ \"$3\" = '{}' ] || exit 9\nIFS= read -r request\nprintf '%s\\n' '{{\"schema_version\":1,\"kind\":\"identity\",\"data\":{{\"source\":\"{source}\"}}}}'",
                path.display()
            ),
        );
        let mut config = connections(&directory.path().join("absent.sock"));
        let connection = config.programs.get_mut(source).expect("observer product");
        connection.program = Some(program);
        connection.config = Some(path);
        let (_cancel, mut receiver) = watch::channel(false);
        let response = adapters::read(
            &config,
            &ReadRequest {
                resource,
                params: json!({}),
            },
            &mut receiver,
        )
        .await
        .expect("fixed observer config argv");
        assert_eq!(response.0["data"]["source"], source);
    }
}
