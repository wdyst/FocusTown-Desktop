mod settings;

use std::sync::Mutex;

use serde::Serialize;
use settings::{Settings, SettingsStore, WebPrefs};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

/// The page the app opens on launch. `/app` redirects to the login page
/// when the user is not authenticated.
const START_URL: &str = "https://www.focustown.app/app";

/// Global show/hide hotkey (opt-in via settings).
#[cfg(desktop)]
const GLOBAL_SHORTCUT: &str = "ctrl+alt+f";

/// Mini-mode window size (logical pixels).
const MINI_SIZE: (f64, f64) = (400.0, 640.0);

/// Hosts that are allowed to load *inside* the app window.
///
/// Everything else is blocked and opened in the user's default browser
/// instead. Keep this list as small as possible: every host added here
/// runs inside the app window.
///
/// The OAuth provider hosts are included so that "Sign in with ..." flows
/// can complete in-window (the session cookie must land in this WebView,
/// so the flow cannot be bounced to the external browser).
const ALLOWED_HOSTS: &[&str] = &[
    // FocusTown itself (exact + subdomains via suffix match below)
    "focustown.app",
    // Common hosted-auth backends (harmless if unused by the site)
    "supabase.co",
    "firebaseapp.com",
    // OAuth identity providers
    "accounts.google.com",
    "appleid.apple.com",
    "github.com",
    "login.microsoftonline.com",
];

/// Returns true when `url` may be loaded inside the app window.
fn is_navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        // `tauri://` (macOS/Linux) and `http(s)://tauri.localhost` (Windows)
        // serve the bundled placeholder page.
        "tauri" => return true,
        "http" | "https" => {
            if let Some(host) = url.host_str() {
                if host == "tauri.localhost" {
                    return true;
                }
            }
        }
        // about:blank shows up transiently during some SPA navigations
        "about" => return true,
        _ => return false,
    }

    // Real web content must be HTTPS.
    if url.scheme() != "https" {
        return false;
    }

    let Some(host) = url.host_str() else {
        return false;
    };

    ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// Injected before any page script runs. Funnels popups through the
/// navigation policy and renders the wrapper settings overlay (which talks
/// to the commands below — the only IPC exposed to the site, see
/// capabilities/remote.json).
const INIT_SCRIPT: &str = include_str!("overlay.js");

/// Saved window geometry while mini mode is active (None = not in mini mode).
#[derive(Default)]
struct MiniMode(Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>);

#[derive(Serialize)]
struct UiState {
    settings: Settings,
    fullscreen: bool,
    mini: bool,
    autostart: bool,
    keep_awake_supported: bool,
    version: String,
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn toggle_window_visibility(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) && !win.is_minimized().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_main_window(app);
        }
    }
}

/// Keeps the display/system awake while enabled. `ES_CONTINUOUS` is bound to
/// the calling thread, so this always runs on the main thread (which lives
/// for the duration of the app).
#[cfg(windows)]
fn apply_keep_awake(app: &AppHandle, on: bool) {
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
    };
    let _ = app.run_on_main_thread(move || unsafe {
        if on {
            SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
        } else {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    });
}

#[cfg(not(windows))]
fn apply_keep_awake(_app: &AppHandle, _on: bool) {}

fn autostart_enabled(app: &AppHandle) -> bool {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        return app.autolaunch().is_enabled().unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

// ---------------------------------------------------------------------------
// Commands — the only IPC surface exposed to web content (see
// capabilities/remote.json). All of them are window/session controls; none
// touch the filesystem (beyond the wrapper's own settings file), shell, or
// any other native capability.
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_ui_state(
    window: WebviewWindow,
    store: State<SettingsStore>,
    mini: State<MiniMode>,
) -> UiState {
    UiState {
        settings: store.get(),
        fullscreen: window.is_fullscreen().unwrap_or(false),
        mini: mini.0.lock().unwrap().is_some(),
        autostart: autostart_enabled(window.app_handle()),
        keep_awake_supported: cfg!(windows),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) -> bool {
    let target = !window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(target);
    target
}

#[tauri::command]
fn toggle_mini_mode(
    window: WebviewWindow,
    store: State<SettingsStore>,
    mini: State<MiniMode>,
) -> bool {
    let mut saved = mini.0.lock().unwrap();
    if let Some((pos, size)) = saved.take() {
        // Leave mini mode: restore geometry and the user's pin preference.
        let _ = window.set_always_on_top(store.get().always_on_top);
        let _ = window.set_size(size);
        let _ = window.set_position(pos);
        false
    } else {
        if window.is_fullscreen().unwrap_or(false) {
            let _ = window.set_fullscreen(false);
        }
        if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
            *saved = Some((pos, size));
        }
        let _ = window.set_size(tauri::LogicalSize::new(MINI_SIZE.0, MINI_SIZE.1));
        let _ = window.set_always_on_top(true);
        true
    }
}

#[tauri::command]
fn set_zoom(window: WebviewWindow, store: State<SettingsStore>, zoom: f64) -> f64 {
    let zoom = if zoom.is_finite() {
        zoom.clamp(0.5, 3.0)
    } else {
        1.0
    };
    let _ = window.set_zoom(zoom);
    store.update(|s| s.zoom = zoom);
    zoom
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, store: State<SettingsStore>, on: bool) {
    let _ = window.set_always_on_top(on);
    store.update(|s| s.always_on_top = on);
}

#[tauri::command]
fn set_hide_gear(store: State<SettingsStore>, hide: bool) {
    store.update(|s| s.hide_gear = hide);
}

/// Persists the page-side preferences (themes, gear position, auto camera,
/// game-UI hiding). Values are clamped here so a compromised page cannot
/// store unbounded data.
#[tauri::command]
fn set_web_prefs(store: State<SettingsStore>, prefs: WebPrefs) -> WebPrefs {
    let mut p = prefs;
    p.auto_camera_secs = p.auto_camera_secs.clamp(10, 600);
    p.theme_intensity = p.theme_intensity.clamp(0, 100);
    if p.theme.len() > 40
        || !p
            .theme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        p.theme = "none".into();
    }
    let clamp_pct = |v: Option<f64>| {
        v.map(|x| {
            if x.is_finite() {
                x.clamp(0.0, 100.0)
            } else {
                50.0
            }
        })
    };
    p.gear_x = clamp_pct(p.gear_x);
    p.gear_y = clamp_pct(p.gear_y);
    p.render_scale = if p.render_scale.is_finite() {
        p.render_scale.clamp(1.0, 2.0)
    } else {
        1.0
    };
    store.update(|s| s.web = p.clone());
    p
}

#[tauri::command]
fn set_close_to_tray(store: State<SettingsStore>, on: bool) {
    store.update(|s| s.close_to_tray = on);
}

#[tauri::command]
fn set_keep_awake(window: WebviewWindow, store: State<SettingsStore>, on: bool) {
    apply_keep_awake(window.app_handle(), on);
    store.update(|s| s.keep_awake = on);
}

#[tauri::command]
fn set_autostart(window: WebviewWindow, on: bool) -> bool {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let autolaunch = window.app_handle().autolaunch();
        let _ = if on {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
    }
    let _ = on;
    autostart_enabled(window.app_handle())
}

#[tauri::command]
fn set_global_shortcut(window: WebviewWindow, store: State<SettingsStore>, on: bool) -> bool {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let shortcuts = window.app_handle().global_shortcut();
        let applied = if on {
            shortcuts.register(GLOBAL_SHORTCUT).is_ok()
        } else {
            shortcuts.unregister(GLOBAL_SHORTCUT).is_ok()
        };
        if applied {
            store.update(|s| s.global_shortcut = on);
        }
        return store.get().global_shortcut;
    }
    #[allow(unreachable_code)]
    {
        let _ = (window, store, on);
        false
    }
}

/// Wipes cookies, storage, and cache (logs the user out), then returns to
/// the start page. Recovery hatch for broken login/session states.
#[tauri::command]
fn clear_browsing_data(window: WebviewWindow) {
    let _ = window.clear_all_browsing_data();
    let _ = window.eval(format!("window.location.replace('{START_URL}')"));
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show_item = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit FocusTown", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("FocusTown")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_window_visibility(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window_visibility(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = {
        use tauri_plugin_global_shortcut::ShortcutState;
        use tauri_plugin_window_state::StateFlags;

        builder
            // Must be first: relaunching the app focuses the existing window.
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                show_main_window(app);
            }))
            // Remembers size/position/maximized/fullscreen across sessions.
            // VISIBLE is excluded so `--hidden` (autostart) launches stay
            // hidden regardless of how the app was last closed.
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                    .build(),
            )
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            toggle_window_visibility(app);
                        }
                    })
                    .build(),
            )
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ))
    };

    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_ui_state,
            toggle_fullscreen,
            toggle_mini_mode,
            set_zoom,
            set_always_on_top,
            set_hide_gear,
            set_web_prefs,
            set_close_to_tray,
            set_keep_awake,
            set_autostart,
            set_global_shortcut,
            clear_browsing_data
        ])
        .setup(|app| {
            let store = SettingsStore::load(app.path().app_config_dir()?);
            let initial = store.get();
            app.manage(store);
            app.manage(MiniMode::default());

            // Autostart launches with `--hidden`: start in the tray.
            let start_hidden = std::env::args().any(|a| a == "--hidden");

            let handle = app.handle().clone();
            let start_url: Url = START_URL.parse().expect("START_URL must be a valid URL");

            // EXPERIMENTAL: supersampling. Overrides devicePixelRatio before
            // any page script runs so the game engine sizes its render
            // buffer larger, then downscales to the screen (sharper 3D).
            let scale = initial.web.render_scale.clamp(1.0, 2.0);
            let dpr_script = format!(
                "(function(){{var s={scale};if(s>1.01){{var d=window.devicePixelRatio||1;\
                 try{{Object.defineProperty(window,'devicePixelRatio',{{get:function(){{return d*s;}}}});}}catch(e){{}}}}}})();"
            );

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start_url))
                .title("FocusTown")
                .inner_size(1280.0, 800.0)
                .min_inner_size(360.0, 500.0)
                .visible(!start_hidden)
                .always_on_top(initial.always_on_top)
                .initialization_script(&dpr_script)
                .initialization_script(INIT_SCRIPT)
                .on_navigation(move |url| {
                    if is_navigation_allowed(url) {
                        return true;
                    }
                    // Blocked in-window; hand off to the default browser,
                    // but never forward non-web schemes (file:, etc.).
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;

            if (initial.zoom - 1.0).abs() > f64::EPSILON {
                let _ = window.set_zoom(initial.zoom);
            }
            if initial.keep_awake {
                apply_keep_awake(app.handle(), true);
            }

            #[cfg(desktop)]
            {
                setup_tray(app)?;
                if initial.global_shortcut {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    let _ = app.global_shortcut().register(GLOBAL_SHORTCUT);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let store = window.state::<SettingsStore>();
                    if store.get().close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(s: &str) -> bool {
        is_navigation_allowed(&s.parse().unwrap())
    }

    #[test]
    fn allows_focustown_and_subdomains() {
        assert!(allowed("https://focustown.app/"));
        assert!(allowed("https://www.focustown.app/app"));
        assert!(allowed("https://api.focustown.app/v1"));
    }

    #[test]
    fn allows_auth_providers() {
        assert!(allowed("https://accounts.google.com/o/oauth2/v2/auth"));
        assert!(allowed("https://appleid.apple.com/auth/authorize"));
        assert!(allowed("https://xyzproject.supabase.co/auth/v1/authorize"));
    }

    #[test]
    fn blocks_lookalike_domains() {
        assert!(!allowed("https://evilfocustown.app/"));
        assert!(!allowed("https://focustown.app.evil.com/"));
        assert!(!allowed("https://notgithub.com/"));
    }

    #[test]
    fn blocks_non_https_web_content() {
        assert!(!allowed("http://focustown.app/"));
        assert!(!allowed("ftp://focustown.app/"));
        assert!(!allowed("file:///C:/Windows/system32/"));
        assert!(!allowed("javascript:alert(1)"));
    }

    #[test]
    fn allows_internal_schemes() {
        assert!(allowed("tauri://localhost/"));
        assert!(allowed("http://tauri.localhost/"));
        assert!(allowed("about:blank"));
    }
}
