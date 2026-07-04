use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

/// User-adjustable wrapper settings, persisted as JSON in the app config dir.
/// Window geometry (size/position/fullscreen) is handled separately by
/// tauri-plugin-window-state.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub zoom: f64,
    pub always_on_top: bool,
    pub hide_gear: bool,
    /// Closing the window hides to the tray instead of quitting.
    pub close_to_tray: bool,
    /// Prevent the display (and system) from sleeping while the app runs.
    pub keep_awake: bool,
    /// Global Ctrl+Alt+F show/hide hotkey.
    pub global_shortcut: bool,
    /// Page-side preferences applied by the injected overlay (overlay.js).
    pub web: WebPrefs,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            always_on_top: false,
            hide_gear: false,
            close_to_tray: false,
            keep_awake: false,
            global_shortcut: false,
            web: WebPrefs::default(),
        }
    }
}

/// Preferences that only affect the injected page overlay: themes, the
/// draggable gear position, auto camera rotation, and game-UI hiding.
/// The Rust side just persists these; overlay.js interprets them.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WebPrefs {
    /// Gear button position as viewport percentages; None = default corner.
    pub gear_x: Option<f64>,
    pub gear_y: Option<f64>,
    /// Click the game's "Camera Angle" button on an interval.
    pub auto_camera: bool,
    pub auto_camera_secs: u32,
    /// Visual theme id (see THEMES in overlay.js) and strength 0–100.
    pub theme: String,
    pub theme_intensity: u32,
    /// Game-UI hiding (best-effort, position-based heuristics).
    pub hide_bug: bool,
    pub hide_radio: bool,
    pub hide_chat: bool,
    pub hide_game_settings: bool,
    pub hide_friends: bool,
    pub hide_bottom_popup: bool,
    pub hide_all_ui: bool,
    /// EXPERIMENTAL: supersampling factor (1.0–2.0). Applied by overriding
    /// devicePixelRatio before the game boots; takes effect on reload.
    pub render_scale: f64,
    /// Usernames captured from player cards, waiting to be friended.
    pub friend_queue: Vec<String>,
}

impl Default for WebPrefs {
    fn default() -> Self {
        Self {
            gear_x: None,
            gear_y: None,
            auto_camera: false,
            auto_camera_secs: 45,
            theme: "none".into(),
            theme_intensity: 100,
            // The bug-report button is hidden by default (user request);
            // everything else starts visible.
            hide_bug: true,
            hide_radio: false,
            hide_chat: false,
            hide_game_settings: false,
            hide_friends: false,
            hide_bottom_popup: false,
            hide_all_ui: false,
            render_scale: 1.0,
            friend_queue: Vec::new(),
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(config_dir: PathBuf) -> Self {
        let path = config_dir.join("settings.json");
        let current = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    /// Applies `f` to the settings and persists the result. Failures to
    /// write are ignored: settings then just don't survive a restart.
    pub fn update(&self, f: impl FnOnce(&mut Settings)) {
        let mut guard = self.current.lock().unwrap();
        f(&mut guard);
        let snapshot = guard.clone();
        drop(guard);

        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&snapshot) {
            let _ = fs::write(&self.path, json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_settings() {
        let dir = std::env::temp_dir().join("focustown-wrapper-settings-test");
        let _ = fs::remove_dir_all(&dir);

        let store = SettingsStore::load(dir.clone());
        store.update(|s| {
            s.zoom = 1.5;
            s.always_on_top = true;
        });

        let reloaded = SettingsStore::load(dir.clone());
        assert_eq!(reloaded.get().zoom, 1.5);
        assert!(reloaded.get().always_on_top);
        assert!(!reloaded.get().hide_gear);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let dir = std::env::temp_dir().join("focustown-wrapper-settings-corrupt");
        let _ = fs::create_dir_all(&dir);
        fs::write(dir.join("settings.json"), "not json{{{").unwrap();

        let store = SettingsStore::load(dir.clone());
        assert_eq!(store.get().zoom, 1.0);

        let _ = fs::remove_dir_all(&dir);
    }
}
