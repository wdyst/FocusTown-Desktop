# Code signing (optional)

Releases are currently **unsigned**, so Windows SmartScreen shows an
"unknown publisher" prompt and macOS Gatekeeper needs a one-time
right-click → Open. Signing removes those warnings by stamping the
installers with a certificate tied to a verified identity. It costs money
and requires identity verification, so it's optional — fine to skip for a
small audience.

The release workflow (`.github/workflows/release.yml`) already has the
hook points; signing turns on automatically once the secrets below exist.

## Windows

Two options:

1. **Azure Trusted Signing** (recommended — ~$10/month, supports
   individuals). Enrol at https://learn.microsoft.com/azure/trusted-signing/,
   complete identity validation, then sign in CI with the
   `azure/trusted-signing-action`. Cheapest path with instant SmartScreen
   reputation.
2. **OV/EV code-signing certificate** from a CA (DigiCert, Sectigo, SSL.com;
   ~$200–600/yr). Since June 2023 the private key must live on a hardware
   token or cloud HSM, which is awkward in CI — Trusted Signing avoids this.

For a plain certificate, Tauri reads these env vars in CI (already wired):

- `TAURI_SIGNING_PRIVATE_KEY` — base64 of the `.pfx` (or the updater key)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Add them as GitHub repo secrets (Settings → Secrets and variables → Actions).

## macOS

Requires the **Apple Developer Program** ($99/yr). Create a "Developer ID
Application" certificate, then set these repo secrets (already wired into
`tauri-action`):

- `APPLE_CERTIFICATE` — base64 of the `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Your Name (TEAMID)`
- `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID` — for notarization

With these present the workflow signs and notarizes the `.app`/`.dmg`
automatically.

## Verifying

- Windows: right-click the exe → Properties → Digital Signatures.
- macOS: `codesign -dv --verbose=4 FocusTown.app` and `spctl -a -vv FocusTown.app`.
