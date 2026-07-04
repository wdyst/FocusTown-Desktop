# FocusTown Desktop (unofficial)

An unofficial, security-hardened desktop wrapper around [focustown.app](https://focustown.app), built with [Tauri 2](https://tauri.app). All content loads live from the FocusTown website — this app ships no FocusTown code and grants the site **no native capabilities**.

> **Disclaimer:** This project is not affiliated with or endorsed by FocusTown. Before distributing binaries publicly, review FocusTown's Terms of Service and consider contacting them — wrapping a third-party service and using its name/branding may require permission. The bundled placeholder icon is intentionally generic; do not ship FocusTown's logo without authorization.

## Why Tauri (and not Electron)

- **Least privilege by default.** The window renders remote content with zero IPC permissions (see `src-tauri/capabilities/default.json`). There is no Node.js in the renderer and no `invoke` surface — even a full XSS compromise of the website gains nothing beyond what a browser tab has.
- **Small and current.** Installers are a few MB and rendering uses the OS WebView (WebView2 on Windows), which is patched by the OS vendor rather than pinned to an app release.
- **Android path.** Tauri 2 builds for Android, which is the base for the planned Android TV target (see below).

## Using the app

Shortcuts (work while the app is focused):

- **F11** — fullscreen (hides the title bar)
- **F9** — mini mode: a compact always-on-top window that keeps your town/timer visible in a corner while you work; F9 again restores your previous window exactly
- **Ctrl+,** — wrapper settings panel (also via the ⚙ button, bottom-right)
- **Ctrl + / Ctrl − / Ctrl 0** — zoom in / out / reset
- **Ctrl+Alt+F** — global show/hide from any app (opt-in, off by default)

Settings panel (⚙): fullscreen, always-on-top, mini mode, zoom, close-to-tray, keep-screen-awake (Windows), start-with-computer (launches hidden in the tray), global hotkey, reload, clear app data (fixes broken logins), hide the ⚙ button.

Other behavior:

- **Tray icon** — left-click shows/hides the window; right-click for Show/Quit. With "close to tray" enabled, the ✕ button hides the app and your town keeps running.
- **Single instance** — launching the app again just focuses the existing window.
- Zoom and toggles persist (`settings.json` in the app config dir); window size, position, and fullscreen state are remembered automatically — close it fullscreen and it opens fullscreen.
- Connection loss/restore and external-link handoffs show a small toast.

## Security model

| Control | Where |
| --- | --- |
| IPC limited to window/session-control commands (fullscreen, mini mode, zoom, pin, tray/startup behavior, clear-own-data), granted only to the FocusTown origin | `src-tauri/capabilities/remote.json`, commands in `src-tauri/src/lib.rs`; worst case for a compromised page is window manipulation and signing itself out. `withGlobalTauri: false`, `capabilities/default.json` stays empty |
| Navigation allowlist (HTTPS-only, `focustown.app` + auth providers) | `is_navigation_allowed` in `src-tauri/src/lib.rs`, enforced in Rust via `on_navigation` |
| Everything else opens in the system browser | same handler, via `tauri-plugin-opener` (Rust-side only; not exposed to the page) |
| Popups / `target="_blank"` funneled through the allowlist | `src-tauri/src/overlay.js` (injected, also renders the settings overlay) |
| Lookalike-domain protection | suffix matching requires a `.` boundary (`focustown.app.evil.com` is rejected — unit tested) |
| DevTools disabled in release builds | Tauri default (no `devtools` feature enabled) |

Things this app deliberately does **not** do: persist or read cookies itself, inject analytics, intercept requests, or expose filesystem/shell/clipboard APIs to the page.

### Trust boundary

The wrapped website is treated as untrusted-but-primary content: it gets the privileges of a browser tab plus the five window-control commands above, nothing else. The trusted computing base is the small Rust shell plus Tauri and the OS WebView.

### Installer

The Windows installer embeds the WebView2 bootstrapper (`bundle.windows.webviewInstallMode: embedBootstrapper`), so a machine without the WebView2 runtime gets it installed automatically (requires internet — which the app needs anyway). For fully offline installs, switch to `offlineInstaller` (~130 MB larger).

## Building

Prerequisites: [Rust](https://rustup.rs), Node.js 18+, and on Windows the WebView2 runtime (preinstalled on Windows 10/11). See [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Linux/macOS packages.

```sh
npm install
npm run dev      # run locally with hot shell rebuild
npm run build    # produce installers in src-tauri/target/release/bundle/
cargo test --manifest-path src-tauri/Cargo.toml   # navigation-policy unit tests
```

**Windows + GNU toolchain only:** use `npm run build:windows-gnu` instead of `npm run build`. GNU builds link `WebView2Loader.dll` dynamically, and this script layers `src-tauri/tauri.gnu-windows.conf.json` on top of the base config so the DLL is packaged into the installer next to the exe. MSVC builds (including CI) link the loader statically and must not use this overlay.

## Releasing publicly — checklist

- [ ] **Code signing.** Unsigned binaries trigger SmartScreen (Windows) and Gatekeeper (macOS) warnings. Get an OV/EV code-signing cert for Windows and an Apple Developer ID for macOS; wire them into the release workflow secrets (`.github/workflows/release.yml` has the hook points).
- [ ] **Updates.** This wrapper has no auto-updater. Because all product code lives on the website, that is mostly fine — but plan to ship new binaries for Tauri/WebView security advisories. Consider `tauri-plugin-updater` with signed update manifests if you want auto-update.
- [ ] **Dependency auditing.** CI runs `cargo audit` and `npm audit` (see `.github/workflows/ci.yml`). Fix or acknowledge advisories before tagging a release.
- [ ] **ToS / branding permission** from FocusTown (see disclaimer above).
- [ ] Replace placeholder icons in `src-tauri/icons/` (use `npm run tauri icon path/to/icon.png` with a 1024×1024 source you have rights to).

## Android TV (planned)

Tauri 2 can generate the Android project with `npm run tauri android init`. To target TV afterwards:

1. In the generated `src-tauri/gen/android` project, add to the manifest: `<category android:name="android.intent.category.LEANBACK_LAUNCHER" />`, `<uses-feature android:name="android.software.leanback" android:required="true" />`, and `<uses-feature android:name="android.hardware.touchscreen" android:required="false" />`.
2. Provide a TV banner (`android:banner`, 320×180).
3. Verify D-pad navigation works in the FocusTown web UI (focus outlines, arrow-key traversal) — this is a website concern and may need upstream changes or an injected focus-navigation script.
4. Note that `src-tauri/gen/` is generated; keep manifest customizations documented (or scripted) so they survive regeneration.

The navigation allowlist and empty-capability model in `lib.rs` apply unchanged on Android.

## License

[MIT](LICENSE). The FocusTown name and website content belong to their respective owners.
