# Android TV — implementation notes

Tauri 2 can generate the Android project with `npm run tauri android init`
(restore `crate-type = ["staticlib", "cdylib", "rlib"]` in `src-tauri/Cargo.toml`
first — see the comment there). To target TV afterwards:

1. In the generated `src-tauri/gen/android` manifest, add:
   - `<category android:name="android.intent.category.LEANBACK_LAUNCHER" />`
   - `<uses-feature android:name="android.software.leanback" android:required="true" />`
   - `<uses-feature android:name="android.hardware.touchscreen" android:required="false" />`
2. Provide a TV banner (`android:banner`, 320×180). Generated launcher icons
   already exist under `src-tauri/icons/android/`.
3. Verify D-pad navigation works in the FocusTown web UI (focus outlines,
   arrow-key traversal) — this is a website concern and may need an injected
   focus-navigation script in `overlay.js`.
4. `src-tauri/gen/` is generated; keep manifest customizations documented or
   scripted so they survive regeneration.

The navigation allowlist and capability model in `lib.rs` apply unchanged on
Android. Desktop-only plugins (tray, window-state, global shortcut,
autostart) are already gated behind `#[cfg(desktop)]` / target-specific
dependencies.
