//! Desktop executable entry point; no service/model lifecycle is owned here.

/// Runs the normal macOS Tauri window with its closed read-only IPC surface.
fn main() {
    agent_hub::run();
}
