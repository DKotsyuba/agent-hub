//! App-owned configuration; renderer input never chooses execution authority.

use crate::contract::{PARAM_LIMIT, ReadError};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::io::AsyncReadExt;

/// Optional Run socket and explicit trusted broker identity.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RunConfig {
    /// Absolute Unix socket path; absence uses the platform default Run endpoint.
    pub socket: Option<PathBuf>,
    /// Expected Unix UID for an explicitly configured shared broker socket.
    pub broker_uid: Option<u32>,
}

/// Optional Quota service socket and its trusted service identity.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct QuotaConfig {
    /// Absolute Unix socket path; absence uses the platform default when one exists.
    pub socket: Option<PathBuf>,
    /// Expected Unix UID of the Quota service; required with an explicit socket.
    pub server_uid: Option<u32>,
}

/// Reviewed executable and observer configuration paths, never arbitrary argv.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProgramConfig {
    /// Absolute installed or reviewed-candidate executable path.
    pub program: Option<PathBuf>,
    /// Absolute product-owned observer config path; credentials are never read by Hub.
    pub config: Option<PathBuf>,
    /// Absolute Worktree/IDE home override, supplied through the product's own environment.
    pub home: Option<PathBuf>,
}

/// Strict connections.json schema; omitted products retain installed defaults.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FileConfig {
    /// Exact configuration schema version, currently one.
    pub schema_version: u8,
    /// Optional Run endpoint override.
    #[serde(default)]
    pub run: RunConfig,
    /// Optional Quota service endpoint override.
    #[serde(default)]
    pub quota: QuotaConfig,
    /// Optional Worktree executable override.
    #[serde(default)]
    pub worktree: ProgramConfig,
    /// Optional Tasks executable override.
    #[serde(default)]
    pub tasks: ProgramConfig,
    /// Optional standalone Pool observer executable/configuration.
    #[serde(default)]
    pub pool: ProgramConfig,
    /// Optional Bridge diagnostics executable/configuration.
    #[serde(default)]
    pub bridge: ProgramConfig,
    /// Optional IDE observer executable override.
    #[serde(default)]
    pub ide: ProgramConfig,
    /// Known absolute repository paths; informative and never execution commands.
    #[serde(default)]
    pub repositories: Vec<PathBuf>,
}

/// Resolved immutable native connection settings, loaded once at app creation.
#[derive(Clone, Debug)]
pub(crate) struct Connections {
    /// Run endpoint, private unless an explicit broker UID is configured.
    pub socket: PathBuf,
    /// Trusted broker UID for the explicitly configured shared endpoint.
    pub broker_uid: Option<u32>,
    /// Quota socket and trusted service UID; `None` when not configured on this platform.
    pub quota: Option<(PathBuf, u32)>,
    /// Fixed product executable/config paths keyed only by native namespaces.
    pub programs: BTreeMap<&'static str, ProgramConfig>,
    /// Known repository paths for diagnostics.
    pub repositories: Vec<PathBuf>,
}

/// Host-wide fallback read only when no explicit or per-user file exists.
#[cfg(target_os = "linux")]
pub(crate) const SYSTEM_CONFIG: Option<&str> = Some("/etc/agent-hub/connections.json");
/// Non-Linux desktop builds keep the per-user file as the only configuration.
#[cfg(not(target_os = "linux"))]
pub(crate) const SYSTEM_CONFIG: Option<&str> = None;

/// Linux default: the shared Run broker socket and its trusted service UID on the
/// reference host. Any connections.json `run.socket` replaces both values.
#[cfg(target_os = "linux")]
const DEFAULT_RUN: Option<(&str, u32)> = Some(("/run/agent-mcp/api.sock", 1003));
/// Other platforms default to the private per-user Run socket.
#[cfg(not(target_os = "linux"))]
const DEFAULT_RUN: Option<(&str, u32)> = None;

/// Linux default: the reference host's Quota service socket and service UID.
#[cfg(target_os = "linux")]
const DEFAULT_QUOTA: Option<(&str, u32)> = Some(("/run/agent-quota/quota.sock", 999));
/// Other platforms have no Quota default; configure `quota` explicitly.
#[cfg(not(target_os = "linux"))]
const DEFAULT_QUOTA: Option<(&str, u32)> = None;

/// Reads one bounded config file; only NotFound maps to `None`.
async fn read_file(path: &Path) -> Result<Option<FileConfig>, ReadError> {
    if !path.is_absolute() {
        return Err(ReadError::invalid("config_absolute"));
    }
    match tokio::fs::File::open(path).await {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take((PARAM_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| ReadError::invalid("config_read"))?;
            if bytes.len() > PARAM_LIMIT {
                return Err(ReadError::invalid("config_budget"));
            }
            Ok(Some(
                serde_json::from_slice::<FileConfig>(&bytes)
                    .map_err(|_| ReadError::invalid("config_json"))?,
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ReadError::invalid("config_read")),
    }
}

impl Connections {
    /// Reads at most 64 KiB from the explicit config override, else the per-user app
    /// config, else the host-wide fallback. Only NotFound moves to the next location;
    /// an explicit override never falls back, and malformed/unreadable files fail closed.
    pub async fn load(app_config: &Path) -> Result<Self, ReadError> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or_else(|| ReadError::invalid("home_unavailable"))?;
        let config = if let Some(path) = std::env::var_os("AGENT_HUB_CONFIG") {
            read_file(&PathBuf::from(path)).await?
        } else {
            match read_file(&app_config.join("connections.json")).await? {
                Some(config) => Some(config),
                None => match SYSTEM_CONFIG {
                    Some(system) => read_file(Path::new(system)).await?,
                    None => None,
                },
            }
        };
        let mut resolved = Self::resolve(&home, config)?;
        let socket = std::env::var_os("AGENT_HUB_SESSION_SOCKET");
        let broker_uid = std::env::var_os("AGENT_HUB_SESSION_BROKER_UID");
        match (socket, broker_uid) {
            (Some(socket), uid) => {
                let socket = PathBuf::from(socket);
                if !socket.is_absolute() {
                    return Err(ReadError::invalid("run_session_socket_absolute"));
                }
                resolved.socket = socket;
                resolved.broker_uid = uid
                    .map(|value| {
                        value
                            .to_str()
                            .filter(|text| {
                                !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
                            })
                            .and_then(|text| text.parse::<u32>().ok())
                            .ok_or_else(|| ReadError::invalid("run_session_broker_uid"))
                    })
                    .transpose()?;
            }
            (None, Some(_)) => return Err(ReadError::invalid("run_broker_socket_required")),
            (None, None) => {}
        }
        Ok(resolved)
    }

    /// Applies documented defaults to an already parsed file, rejecting relative paths/version.
    pub(crate) fn resolve(home: &Path, file: Option<FileConfig>) -> Result<Self, ReadError> {
        let mut programs = BTreeMap::new();
        for (source, name) in [
            ("worktree", "agent-worktree"),
            ("tasks", "agent-tasks"),
            ("pool", "agent-pool"),
            ("bridge", "bridge"),
            ("ide", "agent-ide"),
        ] {
            programs.insert(
                source,
                ProgramConfig {
                    program: Some(home.join(".local/bin").join(name)),
                    config: None,
                    home: None,
                },
            );
        }
        let (socket, broker_uid) = match DEFAULT_RUN {
            Some((socket, uid)) => (PathBuf::from(socket), Some(uid)),
            None => (home.join(".agent-run/api.sock"), None),
        };
        let mut resolved = Self {
            socket,
            broker_uid,
            quota: DEFAULT_QUOTA.map(|(socket, uid)| (PathBuf::from(socket), uid)),
            programs,
            repositories: Vec::new(),
        };
        if let Some(file) = file {
            if file.schema_version != 1 {
                return Err(ReadError::invalid("config_version"));
            }
            if file.run.broker_uid.is_some() && file.run.socket.is_none() {
                return Err(ReadError::invalid("run_broker_socket_required"));
            }
            // A configured socket carries its own trust: an omitted broker UID means a
            // private same-user socket, never the default shared broker UID.
            if let Some(socket) = file.run.socket {
                resolved.socket = socket;
                resolved.broker_uid = file.run.broker_uid;
            }
            match (file.quota.socket, file.quota.server_uid) {
                (Some(socket), Some(uid)) => resolved.quota = Some((socket, uid)),
                (None, None) => {}
                _ => return Err(ReadError::invalid("quota_config_incomplete")),
            }
            resolved.repositories = file.repositories;
            for (source, input) in [
                ("worktree", file.worktree),
                ("tasks", file.tasks),
                ("pool", file.pool),
                ("bridge", file.bridge),
                ("ide", file.ide),
            ] {
                if let Some(entry) = resolved.programs.get_mut(source) {
                    if input.program.is_some() {
                        entry.program = input.program;
                    }
                    entry.config = input.config;
                    entry.home = input.home;
                }
            }
        }
        if !resolved.socket.is_absolute()
            || resolved
                .quota
                .as_ref()
                .is_some_and(|(socket, _)| !socket.is_absolute())
            || resolved.repositories.iter().any(|p| !p.is_absolute())
            || resolved.programs.values().any(|p| {
                p.program.as_ref().is_none_or(|p| !p.is_absolute())
                    || p.config.as_ref().is_some_and(|p| !p.is_absolute())
                    || p.home.as_ref().is_some_and(|p| !p.is_absolute())
            })
        {
            return Err(ReadError::invalid("config_absolute"));
        }
        if ["worktree", "ide"]
            .iter()
            .any(|source| resolved.programs[*source].config.is_some())
            || ["tasks", "pool", "bridge"]
                .iter()
                .any(|source| resolved.programs[*source].home.is_some())
        {
            return Err(ReadError::invalid("config_unsupported_override"));
        }
        Ok(resolved)
    }
}
