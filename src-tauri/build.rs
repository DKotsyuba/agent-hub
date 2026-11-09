//! Build-time registration of the application's only renderer-callable commands.

/// Registers command ACL metadata and delegates platform assets to the pinned Tauri builder.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "hub_read",
            "hub_watch",
            "hub_unwatch",
            "hub_connections",
        ]),
    ))
    .expect("Tauri build metadata must be valid");
}
