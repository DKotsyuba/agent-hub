//! Bounded app-owned read helpers with cooperative cancellation and explicit reaping.

use crate::contract::{FRAME_LIMIT, READ_TIMEOUT, ReadError};
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::watch,
};

/// Builds an absolute, fixed-argv child command with explicit product temporary paths.
/// Credentials remain in product configuration; stderr is discarded at the OS pipe boundary.
pub(crate) fn command(program: &Path, args: &[String], source: &str) -> Result<Command, ReadError> {
    if !program.is_absolute() {
        return Err(ReadError::invalid("program_absolute"));
    }
    let tool = match source {
        "pool" => "agent-pool",
        "bridge" => "agent-bridge",
        "worktree" => "agent-worktree",
        "tasks" => "agent-tasks",
        "ide" => "agent-ide",
        _ => return Err(ReadError::invalid("program_source")),
    };
    let temp = std::env::temp_dir().join(tool).join("hub-runtime");
    let mut command = Command::new(program);
    command
        .args(args)
        .env("TMPDIR", &temp)
        .env("TMP", &temp)
        .env("TEMP", &temp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    Ok(command)
}

/// Runs one owned observer helper, returning bounded stdout and its exit code only
/// when request delivery completed. A signal or incomplete delivery returns no code.
/// Typed error output is retained even when an early exit breaks stdin; the adapter
/// never accepts data without full request delivery and a documented exit code.
/// Concurrently writes input and drains output; the adapter rejects success/exit contradictions.
/// Cancellation, deadline and overflow reap the direct child. Its group is swept by the owning supervisor.
pub(crate) async fn execute(
    mut command: Command,
    input: Vec<u8>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(Vec<u8>, Option<i32>), ReadError> {
    if *cancel.borrow() {
        return Err(ReadError::unavailable("cancelled"));
    }
    let (mut child, group) = spawn_helper(&mut command).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ReadError::incompatible("executable_missing")
        } else {
            ReadError::unavailable("helper_spawn")
        }
    })?;
    let (mut stdin, stdout) = match (child.stdin.take(), child.stdout.take()) {
        (Some(stdin), Some(stdout)) => (stdin, stdout),
        _ => {
            group.kill();
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(ReadError::unavailable("helper_pipes"));
        }
    };
    let result = {
        let io = async {
            let write = async {
                stdin
                    .write_all(&input)
                    .await
                    .map_err(|_| ReadError::unavailable("helper_write"))?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|_| ReadError::unavailable("helper_write"))?;
                drop(stdin);
                Ok::<_, ReadError>(())
            };
            let read = async {
                let mut output = Vec::new();
                stdout
                    .take((FRAME_LIMIT + 1) as u64)
                    .read_to_end(&mut output)
                    .await
                    .map_err(|_| ReadError::unavailable("helper_read"))?;
                if output.len() > FRAME_LIMIT {
                    return Err(ReadError::invalid("frame_budget"));
                }
                Ok(output)
            };
            let (written, output) = tokio::join!(write, read);
            let output = output?;
            let status = child
                .wait()
                .await
                .map_err(|_| ReadError::unavailable("helper_wait"))?;
            // A typed JSON error may accompany a nonzero exit; the adapter validates it.
            if !status.success() && output.is_empty() {
                return Err(ReadError::incompatible("helper_read_unsupported"));
            }
            Ok((output, written.is_ok().then(|| status.code()).flatten()))
        };
        tokio::select! {
            biased;
            _ = cancel.changed() => Err(ReadError::unavailable("cancelled")),
            result = tokio::time::timeout(READ_TIMEOUT, io) => result.unwrap_or_else(|_| Err(ReadError::unavailable("client_timeout"))),
        }
    };
    group.kill();
    if result.is_err() {
        // kill().await includes reaping; a child that already exited is still waited below.
        let kill = child.kill().await;
        let waited = child.wait().await;
        if kill.is_err() && waited.is_err() {
            return Err(ReadError::unavailable("helper_cleanup"));
        }
    }
    result
}

/// Tracks a private helper group when no observer supervisor owns the group.
pub(crate) struct HelperGroup {
    #[cfg(unix)]
    private: Option<rustix::process::Pid>,
}

impl HelperGroup {
    /// Stops descendants in a desktop-owned group without signaling the desktop process.
    pub(crate) fn kill(self) {
        #[cfg(unix)]
        if let Some(group) = self.private {
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        }
    }
}

/// Both frontend protocols inherit the supervised observer group on Unix.
/// Direct desktop and unsupervised invocations isolate each helper instead.
pub(crate) fn spawn_helper(command: &mut Command) -> std::io::Result<(Child, HelperGroup)> {
    #[cfg(unix)]
    let isolate = {
        use rustix::process::{getpgrp, getpid};
        let supervised = env!("CARGO_PKG_NAME") == "agent-hub-observer"
            && std::env::var_os("AGENT_HUB_SUPERVISED_OBSERVER").is_some_and(|value| value == "1")
            && getpgrp() == getpid();
        let isolate = !supervised;
        if isolate {
            command.process_group(0);
        }
        isolate
    };
    let child = command.spawn()?;
    let group = HelperGroup {
        #[cfg(unix)]
        private: child
            .id()
            .filter(|_| isolate)
            .and_then(|id| i32::try_from(id).ok())
            .and_then(rustix::process::Pid::from_raw),
    };
    Ok((child, group))
}
