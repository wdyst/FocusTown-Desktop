# Security Policy

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
