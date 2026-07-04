# Security Policy

## Security model

The wrapped website is treated as untrusted-but-primary content: it gets the privileges of a browser tab plus a small set of window-control commands, nothing else. The trusted computing base is the small Rust shell plus Tauri and the OS WebView.

| Control | Where |
| --- | --- |
| IPC limited to window/session-control commands (fullscreen, mini mode, zoom, pin, tray/startup behavior, page-overlay prefs, clear-own-data), granted only to the FocusTown origin | `src-tauri/capabilities/remote.json`, commands in `src-tauri/src/lib.rs`; worst case for a compromised page is window manipulation and signing itself out. `withGlobalTauri: false`, `capabilities/default.json` stays empty |
| Navigation allowlist (HTTPS-only, `focustown.app` + auth providers) | `is_navigation_allowed` in `src-tauri/src/lib.rs`, enforced in Rust via `on_navigation` |
| Everything else opens in the system browser | same handler, via `tauri-plugin-opener` (Rust-side only; not exposed to the page) |
| Popups / `target="_blank"` funneled through the allowlist | `src-tauri/src/overlay.js` (injected; also renders the settings overlay) |
| Lookalike-domain protection | suffix matching requires a `.` boundary (`focustown.app.evil.com` is rejected — unit tested) |
| DevTools disabled in release builds | Tauri default (no `devtools` feature enabled) |
| Dependency auditing in CI | `cargo audit` + `npm audit` (`.github/workflows/ci.yml`); acknowledged advisories documented in `.cargo/audit.toml` |

Things this app deliberately does **not** do: persist or read cookies itself, inject analytics, intercept requests, or expose filesystem/shell/clipboard APIs to the page. The Windows installer embeds the WebView2 bootstrapper (`embedBootstrapper`) so fresh machines get the runtime; rendering uses the OS WebView, which is patched by the OS vendor.

## Scope

This project is a thin desktop shell around https://focustown.app. Vulnerabilities in the FocusTown **website** itself should be reported to FocusTown, not here.

In scope for this repository:

- Bypasses of the navigation allowlist (`is_navigation_allowed` in `src-tauri/src/lib.rs`), e.g. loading an attacker-controlled origin inside the app window.
- Any way for web content to reach Tauri IPC, native APIs, or the local filesystem — beyond the window/session-control commands deliberately exposed to the FocusTown origin in `src-tauri/capabilities/remote.json` (privilege escalation *through* those commands is in scope).
- Injection or spoofing issues in the shell itself (window title, external-link handoff, etc.).
- Supply-chain issues in the build or release workflows.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories ("Report a vulnerability" on the repository's Security tab) rather than opening a public issue. You should receive an initial response within 7 days.

Please include the app version, OS and WebView version, and reproduction steps.

## Supported versions

Only the latest release receives fixes. Because the OS WebView (WebView2 / WKWebView / WebKitGTK) is patched by the OS vendor, keeping your operating system updated covers most rendering-engine CVEs; shell updates cover Tauri advisories.
