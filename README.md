# FocusTown Desktop

Unofficial desktop client for [focustown.app](https://focustown.app) — your town in its own app, with fullscreen, mini mode, themes, and a system tray.

**[⬇ Download the latest release](https://github.com/wdyst/FocusTown-Desktop/releases/latest)** — Windows (`-setup.exe`), macOS (`.dmg`, Apple Silicon + Intel), Linux (`.AppImage` / `.deb` / `.rpm`).

> First launch: the builds aren't code-signed yet, so Windows shows a SmartScreen prompt (More info → Run anyway) and macOS needs a one-time right-click → Open.

## Features

- **Fullscreen** (`F11`) — no title bar, just the town
- **Mini mode** (`F9`) — compact always-on-top window that keeps your timer visible in a corner while you work
- **Themes** — a dozen visual filters (Dark Academia, Pastel, Midnight, Noir, Vaporwave…) with an adjustable strength slider
- **Auto camera** — rotates the in-game camera angle on an interval for a dynamic, ambient feel
- **Tidy up the game UI** — hide the bug-report button, radio, chat tab, and more, individually or all at once (`F10`)
- **System tray** — close to tray and keep your town running; left-click the tray icon to show/hide
- **Quality of life** — zoom controls, keep-screen-awake, start-at-login, global show/hide hotkey (`Ctrl+Alt+F`), single instance, remembers your window exactly as you left it

Open the settings panel with the draggable ⚙ button (bottom-right) or `Ctrl+,`.

## Shortcuts

| Key | Action |
| --- | --- |
| `F11` | Fullscreen |
| `F9` | Mini mode |
| `F10` | Hide/show all game UI |
| `Ctrl+,` | Settings panel |
| `Ctrl +` / `Ctrl −` / `Ctrl 0` | Zoom |
| `Ctrl+Alt+F` | Global show/hide (opt-in) |

## Building from source

Needs [Rust](https://rustup.rs) and Node.js 18+ (plus [platform prerequisites](https://tauri.app/start/prerequisites/) on Linux/macOS):

```sh
npm install
npm run build    # installers land in src-tauri/target/release/bundle/
```

On Windows with the GNU toolchain, use `npm run build:windows-gnu` instead. Official releases are built by GitHub Actions ([release.yml](.github/workflows/release.yml), which also has the code-signing hook points).

## Security

The app treats the website like a browser tab: content loads live from focustown.app, navigation is restricted to FocusTown and login providers (everything else opens in your real browser), and the site gets no access to your files or system — just a handful of window controls for the settings panel. Details, threat model, and reporting in [SECURITY.md](SECURITY.md).

## Roadmap

Android TV support is planned — Tauri 2 already builds for Android; implementation notes are in [docs/android-tv.md](docs/android-tv.md).

## Disclaimer & license

This is an unofficial community project, not affiliated with or endorsed by FocusTown. The FocusTown name, logo, and website content belong to their respective owners; this app simply displays the live website. If you're from FocusTown and want anything changed or taken down, open an issue and it'll happen promptly.

Code is [MIT](LICENSE).
