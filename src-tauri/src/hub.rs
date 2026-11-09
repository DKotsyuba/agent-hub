//! Bounded read admission and ordered, cooperatively cancelled view subscriptions.

use crate::{
    adapters,
    config::Connections,
    contract::{Outcome, ReadError, ReadRequest, ReadResponse, Resource},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tauri::ipc::Channel;
use tokio::sync::{Mutex, Semaphore, watch};

/// Maximum independently admitted finite reads, including subscription reads.
const READS: usize = 8;
/// Maximum active renderer subscriptions; completed channels are reclaimed on admission.
const SUBSCRIPTIONS: usize = 24;

/// One view-owned polling task and its cooperative stop sender.
struct Subscription {
    /// Cancellation signal; never maps to cancelling an agent or resident service.
    cancel: watch::Sender<bool>,
    /// Owned handle, joined on explicit unwatch or app shutdown.
    task: tauri::async_runtime::JoinHandle<()>,
}

/// Serialized subscription admission and application shutdown state.
struct Registry {
    /// Monotonically increasing app-local channel generation.
    next_id: u64,
    /// Shutdown closes subscription admission before awaiting task termination.
    closed: bool,
    /// All app-owned subscription tasks.
    subscriptions: BTreeMap<String, Subscription>,
}

/// App-owned immutable connections and bounded read/watch lifecycle.
pub(crate) struct Hub {
    /// Explicit configuration failure is retained rather than silently defaulting.
    connections: Result<Connections, ReadError>,
    /// Shared finite-read admission budget.
    reads: Arc<Semaphore>,
    /// Serialized subscription admission and handles.
    registry: Mutex<Registry>,
    /// Global cancellation for command reads and subscription tasks.
    stop: watch::Sender<bool>,
}

impl Hub {
    /// Creates a Hub from one app-owned configuration load; starts no services or observers.
    pub(crate) fn new(connections: Result<Connections, ReadError>) -> Arc<Self> {
        let (stop, _) = watch::channel(false);
        Arc::new(Self {
            connections,
            reads: Arc::new(Semaphore::new(READS)),
            registry: Mutex::new(Registry {
                next_id: 1,
                closed: false,
                subscriptions: BTreeMap::new(),
            }),
            stop,
        })
    }

    /// Performs one validated read, with bounded admission and cooperative child cleanup.
    /// A full budget returns busy immediately; shutdown rejects every new read.
    pub(crate) async fn read(
        &self,
        request: ReadRequest,
        cancel: &mut watch::Receiver<bool>,
    ) -> ReadResponse {
        let result = async {
            request.validate()?;
            if *self.stop.borrow() || *cancel.borrow() {
                return Err(ReadError::unavailable("cancelled"));
            }
            let _permit = self
                .reads
                .clone()
                .try_acquire_owned()
                .map_err(|_| ReadError::unavailable("read_budget"))?;
            let connections = self.connections.as_ref().map_err(Clone::clone)?;
            adapters::read(connections, &request, cancel).await
        }
        .await;
        let (result, presentation_degraded) = match result {
            Ok((data, degraded)) => (Ok(data), degraded),
            Err(error) => (Err(error), false),
        };
        let mut response = ReadResponse::from_result(request.resource, result);
        if presentation_degraded {
            response.outcome = Outcome::Partial;
            response.error = Some(ReadError {
                code: "presentation_degraded",
                message: "Structured data is available; source text presentation failed.",
                outcome: Outcome::Partial,
            });
        }
        response
    }

    /// Reads on the global shutdown signal for a renderer's finite hub_read command.
    pub(crate) async fn read_once(&self, request: ReadRequest) -> ReadResponse {
        self.read(request, &mut self.stop.subscribe()).await
    }

    /// Adds one bounded ordered channel stream; the first read begins immediately.
    /// Invalid requests/admission fail before spawning; unwatch joins the owned task.
    pub(crate) async fn watch(
        self: &Arc<Self>,
        request: ReadRequest,
        channel: Channel<ReadResponse>,
    ) -> Result<String, ReadError> {
        request.validate()?;
        let mut registry = self.registry.lock().await;
        if registry.closed {
            return Err(ReadError::unavailable("closed"));
        }
        let finished: Vec<_> = registry
            .subscriptions
            .iter()
            .filter(|(_, entry)| entry.task.inner().is_finished())
            .map(|(id, _)| id.clone())
            .collect();
        for id in finished {
            if let Some(entry) = registry.subscriptions.remove(&id) {
                entry
                    .task
                    .await
                    .map_err(|_| ReadError::unavailable("watch_join"))?;
            }
        }
        if registry.subscriptions.len() >= SUBSCRIPTIONS {
            return Err(ReadError::unavailable("subscription_budget"));
        }
        let id = registry.next_id.to_string();
        registry.next_id = registry
            .next_id
            .checked_add(1)
            .ok_or_else(|| ReadError::unavailable("subscription_ids"))?;
        let (cancel, mut receiver) = watch::channel(false);
        let mut global = self.stop.subscribe();
        let hub = Arc::clone(self);
        let task = tauri::async_runtime::spawn(async move {
            let mut request = request;
            let mut backoff = Duration::from_secs(1);
            loop {
                if *receiver.borrow() || *global.borrow() {
                    break;
                }
                // The read itself owns cancellation cleanup. Global shutdown also signals
                // every subscription's local sender before awaiting these handles.
                let response = hub.read(request.clone(), &mut receiver).await;
                if *receiver.borrow() || *global.borrow() {
                    break;
                }
                let success = matches!(response.outcome, Outcome::Ok | Outcome::Partial);
                if success && request.resource == Resource::RunAgents {
                    advance_revisions(&mut request.params, &response.data);
                }
                if channel.send(response).is_err() {
                    break;
                }
                let delay = if success {
                    backoff = Duration::from_secs(1);
                    if request.resource == Resource::RunAgents {
                        Duration::from_secs(1)
                    } else {
                        request.resource.interval()
                    }
                } else {
                    let delay = backoff;
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                    delay
                };
                // Delay after completion skips missed ticks and prevents overlapping reads.
                tokio::select! {
                    biased;
                    _ = receiver.changed() => break,
                    _ = global.changed() => break,
                    _ = tokio::time::sleep(delay) => {},
                }
            }
        });
        registry
            .subscriptions
            .insert(id.clone(), Subscription { cancel, task });
        Ok(id)
    }

    /// Cancels and joins one subscription; unknown IDs are idempotent success.
    /// Keeps admission serialized through joining so shutdown cannot lose a handle
    /// concurrently removed by unwatch; subscription tasks never acquire this lock.
    pub(crate) async fn unwatch(&self, id: &str) -> Result<(), ReadError> {
        let mut registry = self.registry.lock().await;
        let subscription = registry.subscriptions.remove(id);
        if let Some(subscription) = subscription {
            subscription.cancel.send_replace(true);
            subscription
                .task
                .await
                .map_err(|_| ReadError::unavailable("watch_join"))?;
        }
        Ok(())
    }

    /// Closes admission, stops/joins all observers, then waits for finite read cleanup.
    /// Only app-owned frontend/read children are stopped; resident services remain untouched.
    pub(crate) async fn close(&self) -> Result<(), ReadError> {
        let subscriptions = {
            let mut registry = self.registry.lock().await;
            registry.closed = true;
            self.stop.send_replace(true);
            let subscriptions = std::mem::take(&mut registry.subscriptions);
            for subscription in subscriptions.values() {
                subscription.cancel.send_replace(true);
            }
            subscriptions
        };
        let mut failed = false;
        for subscription in subscriptions.into_values() {
            failed |= subscription.task.await.is_err();
        }
        let permits = self
            .reads
            .clone()
            .acquire_many_owned(READS as u32)
            .await
            .map_err(|_| ReadError::unavailable("read_cleanup"))?;
        drop(permits);
        if failed {
            Err(ReadError::unavailable("watch_join"))
        } else {
            Ok(())
        }
    }

    /// Reports configuration provenance and safe paths without probing/launching a service.
    pub(crate) fn diagnostics(&self) -> Value {
        match &self.connections {
            Ok(config) => {
                json!({"schema_version":1,"state":"configured","run":{"socket":config.socket,"broker_uid":config.broker_uid,"version":null},
                "programs":config.programs,"repositories":config.repositories})
            }
            Err(error) => json!({"schema_version":1,"state":"invalid","error":error}),
        }
    }
}

/// Carries producer revision fences into the next Run long-poll without changing page cursors.
fn advance_revisions(params: &mut Value, data: &Value) {
    if let Some(params) = params.as_object_mut() {
        if let Some(revision) = data.get("revision") {
            params.insert("after_revision".into(), revision.clone());
        }
        if let Some(revision) = data.get("message_revision") {
            params.insert("after_message_revision".into(), revision.clone());
        }
        params.insert("wait_seconds".into(), json!(25));
    }
}
