//! Closed renderer requests and producer-preserving, versioned read results.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Largest encoded renderer parameter object, in bytes.
pub(crate) const PARAM_LIMIT: usize = 64 * 1024;
/// Largest complete producer frame, in bytes, including its newline.
pub(crate) const FRAME_LIMIT: usize = 1024 * 1024;
/// Deadline for ordinary finite reads; long-polls have a separate deadline.
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(15);

/// All renderer-readable resources; deserialization rejects every other operation.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Resource {
    /// Run transport discovery, without invented broker version information.
    #[serde(rename = "run.identity")]
    RunIdentity,
    /// One producer-paginated agent inventory page.
    #[serde(rename = "run.agents")]
    RunAgents,
    /// One source-reported agent snapshot, addressed by its exact identity.
    #[serde(rename = "run.status")]
    RunStatus,
    /// Producer-cursor transcript page.
    #[serde(rename = "run.transcript")]
    RunTranscript,
    /// One bounded exact-execution transcript fragment, fenced by source identity.
    #[serde(rename = "run.transcript_exact")]
    RunTranscriptExact,
    /// Verified pages of one root execution's exact initial task, fenced by the caller.
    #[serde(rename = "run.initial_task")]
    RunInitialTask,
    /// Inline answer and original attribution; paths are never opened.
    #[serde(rename = "run.answer")]
    RunAnswer,
    /// Proof-bound UTF-8 answer bytes, only when the broker advertises chunk support.
    #[serde(rename = "run.answer_chunk")]
    RunAnswerChunk,
    /// Cached model compatibility information; never inference.
    #[serde(rename = "run.models")]
    RunModels,
    /// Cached quota information.
    #[serde(rename = "run.limits")]
    RunLimits,
    /// Legacy Run pool inventory, separate from standalone Pool.
    #[serde(rename = "run.pools")]
    RunPools,
    /// Legacy Run pool detail.
    #[serde(rename = "run.pool")]
    RunPool,
    /// Structured Worktree product identity.
    #[serde(rename = "worktree.identity")]
    WorktreeIdentity,
    /// Cheap paginated worktree inventory.
    #[serde(rename = "worktree.list")]
    WorktreeList,
    /// On-demand worktree inspection.
    #[serde(rename = "worktree.inspect")]
    WorktreeInspect,
    /// Structured Tasks product identity.
    #[serde(rename = "tasks.identity")]
    TasksIdentity,
    /// Retained plan/report/pending snapshot; never settlement.
    #[serde(rename = "tasks.peek")]
    TasksPeek,
    /// Standalone Pool observer identity.
    #[serde(rename = "pool.identity")]
    PoolIdentity,
    /// Standalone Pool observer inventory.
    #[serde(rename = "pool.list")]
    PoolList,
    /// Standalone Pool observer detail/history.
    #[serde(rename = "pool.get")]
    PoolGet,
    /// Pool-fenced execution evidence for one member.
    #[serde(rename = "pool.run_proof")]
    PoolRunProof,
    /// Source-wide retained Pool totals and one fenced snapshot page.
    #[serde(rename = "pool.inventory_snapshot")]
    PoolInventorySnapshot,
    /// Bridge diagnostic observer identity.
    #[serde(rename = "bridge.identity")]
    BridgeIdentity,
    /// Bridge diagnostic counts and retention coverage.
    #[serde(rename = "bridge.overview")]
    BridgeOverview,
    /// Content-free delivery diagnostics.
    #[serde(rename = "bridge.deliveries")]
    BridgeDeliveries,
    /// Bounded diagnostic incidents.
    #[serde(rename = "bridge.incidents")]
    BridgeIncidents,
    /// Explicit read-only IDE installation diagnostics; never the mutating no-argument doctor.
    #[serde(rename = "ide.identity")]
    IdeIdentity,
    /// Retained IDE repository observations.
    #[serde(rename = "ide.observe")]
    IdeObserve,
}

impl Resource {
    /// Returns the immutable product namespace for this resource.
    pub(crate) fn source(self) -> &'static str {
        match self {
            Self::RunIdentity
            | Self::RunAgents
            | Self::RunStatus
            | Self::RunTranscript
            | Self::RunTranscriptExact
            | Self::RunInitialTask
            | Self::RunAnswer
            | Self::RunAnswerChunk
            | Self::RunModels
            | Self::RunLimits
            | Self::RunPools
            | Self::RunPool => "run",
            Self::WorktreeIdentity | Self::WorktreeList | Self::WorktreeInspect => "worktree",
            Self::TasksIdentity | Self::TasksPeek => "tasks",
            Self::PoolIdentity
            | Self::PoolList
            | Self::PoolGet
            | Self::PoolRunProof
            | Self::PoolInventorySnapshot => "pool",
            Self::BridgeIdentity
            | Self::BridgeOverview
            | Self::BridgeDeliveries
            | Self::BridgeIncidents => "bridge",
            Self::IdeIdentity | Self::IdeObserve => "ide",
        }
    }

    /// Resolves the fixed read method; renderer input can never select another method.
    pub(crate) fn method(self) -> &'static str {
        match self {
            Self::RunIdentity => "ping",
            Self::RunAgents => "list_agents",
            Self::RunStatus => "status",
            Self::RunTranscript => "transcript",
            Self::RunTranscriptExact => "transcript_exact",
            Self::RunInitialTask => "initial_task",
            Self::RunAnswer => "answer",
            Self::RunAnswerChunk => "answer_chunk",
            Self::RunModels => "models",
            Self::RunLimits => "limits",
            Self::RunPools => "list_pools",
            Self::RunPool => "pool",
            Self::WorktreeIdentity | Self::TasksIdentity => "get_status",
            Self::WorktreeList => "list_worktrees",
            Self::WorktreeInspect => "inspect_worktree",
            Self::TasksPeek => "peek",
            Self::PoolIdentity | Self::BridgeIdentity => "identity",
            Self::PoolList => "list",
            Self::PoolGet | Self::PoolRunProof => "get",
            Self::PoolInventorySnapshot => "inventory_snapshot",
            Self::BridgeOverview => "overview",
            Self::BridgeDeliveries => "deliveries",
            Self::BridgeIncidents => "incidents",
            Self::IdeIdentity => "doctor",
            Self::IdeObserve => "observe",
        }
    }

    /// Returns the expected versioned producer envelope kind, or none for unwrapped Run/IDE reads.
    pub(crate) fn kind(self) -> Option<&'static str> {
        match self {
            Self::WorktreeIdentity => Some("identity"),
            Self::WorktreeList => Some("worktree_page"),
            Self::WorktreeInspect => Some("worktree_detail"),
            Self::TasksIdentity => Some("product_identity"),
            Self::TasksPeek => Some("project_snapshot"),
            Self::PoolIdentity => Some("identity"),
            Self::PoolList => Some("pool_page"),
            Self::PoolGet => Some("pool_detail"),
            Self::PoolRunProof => Some("run_proof"),
            Self::PoolInventorySnapshot => Some("inventory_snapshot"),
            Self::BridgeIdentity => Some("identity"),
            Self::BridgeOverview => Some("bridge_overview"),
            Self::BridgeDeliveries => Some("delivery_page"),
            Self::BridgeIncidents => Some("incident_page"),
            Self::IdeObserve => Some("ide_observation"),
            _ => None,
        }
    }

    /// Returns the default non-overlapping poll interval for visible resources.
    pub(crate) fn interval(self) -> Duration {
        Duration::from_secs(match self {
            Self::RunModels | Self::RunLimits => 60,
            Self::PoolGet | Self::PoolRunProof => 2,
            Self::WorktreeIdentity
            | Self::WorktreeList
            | Self::WorktreeInspect
            | Self::IdeIdentity
            | Self::IdeObserve => 15,
            _ => 5,
        })
    }
}

/// Single closed read request; params remain product-owned domain input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    /// Read-only resource selecting exactly one native method.
    pub resource: Resource,
    /// Object of product arguments, bounded to 64 KiB; defaults to an empty object.
    #[serde(default = "empty_object")]
    pub params: Value,
}

/// Creates the documented absent-params default without permitting JSON null.
fn empty_object() -> Value {
    json!({})
}

impl ReadRequest {
    /// Rejects nonobjects, oversized input and authority-bearing renderer keys.
    /// Source products retain validation of their actual domain arguments.
    pub(crate) fn validate(&self) -> Result<(), ReadError> {
        if !self.params.is_object() {
            return Err(ReadError::invalid("params_object"));
        }
        if serde_json::to_vec(&self.params)
            .map_err(|_| ReadError::invalid("params_json"))?
            .len()
            > PARAM_LIMIT
        {
            return Err(ReadError::invalid("params_budget"));
        }
        if carries_authority(&self.params) {
            return Err(ReadError::invalid("authority_denied"));
        }
        if self.resource == Resource::PoolRunProof {
            let params = self
                .params
                .as_object()
                .ok_or_else(|| ReadError::invalid("params_object"))?;
            if params.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "pool_id" | "section" | "member_id" | "expected_revision"
                )
            }) || params.get("section").and_then(Value::as_str) != Some("run_proof")
                || params
                    .get("pool_id")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                || params
                    .get("member_id")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                || params
                    .get("expected_revision")
                    .is_none_or(|value| value.as_u64().is_none_or(|revision| revision == 0))
            {
                return Err(ReadError::invalid("pool_proof_params"));
            }
        }
        if self.resource == Resource::RunInitialTask {
            let params = self
                .params
                .as_object()
                .ok_or_else(|| ReadError::invalid("params_object"))?;
            // The producer owns fence semantics; only the closed outer shape is checked here.
            if params.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "version"
                        | "mode"
                        | "expected_store_id"
                        | "agent_id"
                        | "sequence"
                        | "execution_ref"
                        | "pin_id"
                        | "offset"
                        | "max_bytes"
                        | "expected_sha256"
                        | "expected_total_bytes"
                )
            }) || params.get("version").and_then(Value::as_u64) != Some(1)
                || !matches!(
                    params.get("mode").and_then(Value::as_str),
                    Some("strict" | "current")
                )
                || params
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                || params.values().any(Value::is_null)
            {
                return Err(ReadError::invalid("initial_task_params"));
            }
        }
        if self.resource == Resource::PoolInventorySnapshot {
            let params = self
                .params
                .as_object()
                .ok_or_else(|| ReadError::invalid("params_object"))?;
            // The producer owns cursor validation; only the closed outer shape is checked here.
            if params
                .keys()
                .any(|key| !matches!(key.as_str(), "filter" | "limit" | "cursor"))
                || !matches!(
                    params.get("filter").and_then(Value::as_str),
                    Some("all" | "closed" | "not_closed")
                )
                || !params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .is_some_and(|limit| (1..=10).contains(&limit))
                || params
                    .get("cursor")
                    .is_some_and(|cursor| !cursor.is_null() && !cursor.is_object())
            {
                return Err(ReadError::invalid("pool_inventory_params"));
            }
        }
        Ok(())
    }
}

/// Rejects authority-bearing keys at every nesting level without interpreting domain values.
/// Input has already passed JSON parsing and the 64 KiB parameter budget.
fn carries_authority(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            matches!(
                key.as_str(),
                "method"
                    | "command"
                    | "executable"
                    | "program"
                    | "argv"
                    | "token"
                    | "credential"
                    | "credentials"
                    | "actor"
                    | "native_identity"
                    | "caller"
                    | "caller_context"
                    | "config"
                    | "socket"
                    | "broker_uid"
            ) || carries_authority(value)
        }),
        Value::Array(items) => items.iter().any(carries_authority),
        _ => false,
    }
}

/// Stable classifications shared by renderer and connection diagnostics.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Valid complete producer response.
    Ok,
    /// Producer explicitly reported incomplete coverage or partial state.
    Partial,
    /// Transport, timeout or source read failed.
    Unavailable,
    /// Source does not implement the required structured read contract.
    Incompatible,
    /// Source explicitly reported a missing object.
    Missing,
    /// Invalid caller, configuration, framing or producer envelope.
    Invalid,
}

/// Credential-safe static error; raw producer errors and stderr never enter this type.
#[derive(Clone, Debug, Serialize)]
pub struct ReadError {
    /// Stable bounded diagnostic identifier.
    pub code: &'static str,
    /// Safe English technical description, localized by the renderer if desired.
    pub message: &'static str,
    /// Response classification, omitted from the serialized error itself.
    #[serde(skip)]
    pub(crate) outcome: Outcome,
}

impl ReadError {
    /// Constructs a sanitized invalid-input/protocol error with a static code.
    pub(crate) fn invalid(code: &'static str) -> Self {
        Self {
            code,
            message: "Read request or source response is invalid.",
            outcome: Outcome::Invalid,
        }
    }
    /// Constructs a sanitized transport/read error; never includes private source text.
    pub(crate) fn unavailable(code: &'static str) -> Self {
        Self {
            code,
            message: "Source read is unavailable; no agent was cancelled.",
            outcome: Outcome::Unavailable,
        }
    }
    /// Constructs a missing-capability error without falling back to another route.
    pub(crate) fn incompatible(code: &'static str) -> Self {
        Self {
            code,
            message: "Source does not support the required read contract.",
            outcome: Outcome::Incompatible,
        }
    }

    /// Classifies only explicit structured producer outcomes; private error prose
    /// and arbitrary producer codes are replaced with a fixed safe error contract.
    pub(crate) fn source(error: &Value) -> Self {
        if error.get("code").and_then(Value::as_str) == Some("observer_unconfigured") {
            return Self {
                code: "observer_unconfigured",
                message: "Observer access is not configured.",
                outcome: Outcome::Unavailable,
            };
        }
        // A changed snapshot is retryable and distinct from a broken source; nothing else is echoed.
        if error.get("code").and_then(Value::as_str) == Some("stale") {
            return Self {
                code: "stale",
                message: "Source snapshot changed; read again from the first page.",
                outcome: Outcome::Unavailable,
            };
        }
        let outcome = match error.get("outcome").and_then(Value::as_str) {
            Some("missing") => Outcome::Missing,
            Some("invalid") => Outcome::Invalid,
            Some("incompatible") => Outcome::Incompatible,
            _ => Outcome::Unavailable,
        };
        Self {
            code: "source_error",
            message: "Source returned a structured read error.",
            outcome,
        }
    }
}

/// Versioned read result preserving source payload, clocks, revisions and coverage.
#[derive(Clone, Debug, Serialize)]
pub struct ReadResponse {
    /// Native seam version; currently exactly one.
    pub schema_version: u8,
    /// Product namespace, independent of legacy naming in producer payloads.
    pub source: &'static str,
    /// Original closed resource.
    pub resource: Resource,
    /// Native receipt wall time in Unix milliseconds, never a producer timestamp.
    pub observed_at_ms: u64,
    /// Explicit data/transport state.
    pub outcome: Outcome,
    /// Original structured producer payload; null for failed reads.
    pub data: Value,
    /// Bounded sanitized error, or null on successful/partial reads.
    pub error: Option<ReadError>,
}

impl ReadResponse {
    /// Wraps one validated producer result without normalizing domain fields.
    pub(crate) fn from_result(resource: Resource, result: Result<Value, ReadError>) -> Self {
        let (outcome, data, error) = match result {
            Ok(data) => {
                let partial = data.get("partial").and_then(Value::as_bool) == Some(true)
                    || data.get("complete").and_then(Value::as_bool) == Some(false)
                    || data.pointer("/coverage/complete").and_then(Value::as_bool) == Some(false)
                    || data
                        .pointer("/data/coverage/complete")
                        .and_then(Value::as_bool)
                        == Some(false)
                    || data.get("outcome").and_then(Value::as_str) == Some("partial");
                (
                    if partial {
                        Outcome::Partial
                    } else {
                        Outcome::Ok
                    },
                    data,
                    None,
                )
            }
            Err(error) => (error.outcome, Value::Null, Some(error)),
        };
        Self {
            schema_version: 1,
            source: resource.source(),
            resource,
            observed_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            outcome,
            data,
            error,
        }
    }
}
