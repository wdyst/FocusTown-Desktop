fn main() {
    // Registering the app commands here generates `allow-*` permissions for
    // them, which capabilities/remote.json grants to the FocusTown origin.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_ui_state",
            "toggle_fullscreen",
            "toggle_mini_mode",
            "set_zoom",
            "set_always_on_top",
            "set_hide_gear",
            "set_web_prefs",
            "set_close_to_tray",
            "set_keep_awake",
            "set_autostart",
            "set_global_shortcut",
            "clear_browsing_data",
        ]),
    ))
    .expect("failed to run tauri-build");
}
