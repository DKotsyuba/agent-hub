//! Agent Hub desktop shell: closed read-only IPC and app-owned observer lifetimes.

#[cfg(all(feature = "native-e2e", not(debug_assertions)))]
compile_error!("native-e2e is restricted to debug acceptance builds");

mod adapters;
mod config;
mod contract;
mod hub;
mod mcp;
mod process;
mod run;
#[cfg(test)]
mod tests;

use contract::{ReadError, ReadRequest, ReadResponse};
use hub::Hub;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{Manager, State, ipc::Channel};

/// Reads one closed resource; the main local window receives a versioned result.
/// Source/configuration failures remain inside ReadResponse. The outer Result
/// satisfies Tauri's async borrowed-state lifetime contract and currently never rejects.
#[tauri::command]
async fn hub_read(
    hub: State<'_, Arc<Hub>>,
    request: ReadRequest,
) -> Result<ReadResponse, ReadError> {
    Ok(hub.read_once(request).await)
}

/// Starts one bounded ordered read subscription owned by a renderer view.
#[tauri::command]
async fn hub_watch(
    hub: State<'_, Arc<Hub>>,
    request: ReadRequest,
    channel: Channel<ReadResponse>,
) -> Result<String, ReadError> {
    hub.inner().watch(request, channel).await
}

/// Cooperatively cancels and joins one subscription; repeated IDs are harmless.
#[tauri::command]
async fn hub_unwatch(hub: State<'_, Arc<Hub>>, subscription_id: String) -> Result<(), ReadError> {
    if subscription_id.len() > 32 {
        return Err(ReadError::invalid("subscription_id"));
    }
    hub.unwatch(&subscription_id).await
}

/// Returns safe app-owned connection paths; never probes services or reveals credential values.
#[tauri::command]
fn hub_connections(hub: State<'_, Arc<Hub>>) -> serde_json::Value {
    hub.diagnostics()
}

/// Builds/runs the native shell and drains every owned observer before final app exit.
/// Creates no background observers during setup and never starts resident services.
/// Only explicit native-e2e debug builds register the loopback acceptance driver.
pub fn run() {
    let builder = tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.app_handle().webview_windows().len() == 1
            {
                api.prevent_close();
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let config = match app.path().app_config_dir() {
                Ok(path) => tauri::async_runtime::block_on(config::Connections::load(&path)),
                Err(_) => Err(ReadError::invalid("app_config_dir")),
            };
            app.manage(Hub::new(config));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hub_read,
            hub_watch,
            hub_unwatch,
            hub_connections
        ]);
    #[cfg(feature = "native-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let application = builder
        .build(tauri::generate_context!())
        .expect("Tauri desktop shell configuration must be valid");
    let exiting = Arc::new(AtomicBool::new(false));
    application.run(move |app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event
            && !exiting.swap(true, Ordering::AcqRel)
        {
            api.prevent_exit();
            let app = app.clone();
            let hub = app.state::<Arc<Hub>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                // Cleanup errors use a generic exit status, never private stderr/payloads.
                let status = if hub.close().await.is_ok() { 0 } else { 1 };
                app.exit(status);
            });
        }
    });
}
