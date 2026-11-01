# Tessera

A free DAW with graphical, note-level pitch and timing editing ("Tune"), in the spirit of existing
pitch-alignment software. It is built from one codebase in two editions:

- **Web edition**: runs in the browser (Chromium first). Web Audio, AudioWorklet + WASM engine.
- **Desktop edition**: Tauri v2 app for Windows, macOS and Linux. Native drivers (ASIO, WASAPI,
  CoreAudio, ALSA/JACK); VST3 and CLAP plugin hosting later on.

All DSP lives in Rust crates that compile to both WebAssembly and native code. See
[AGENTS.md](AGENTS.md) for the architecture, conventions and roadmap.

**Status:** M2 (arrange view with clip editing, undo/redo, projects with autosave and `.tessera`
import/export) on top of the M1 engine.

## Using it

- **Import audio:** drop files on the timeline (onto a track, or below the tracks for new ones) or
  use **Import…**. WAV, FLAC, MP3, OGG Vorbis and M4A/AAC are supported.
- **Edit clips:** drag to move (also across tracks), drag the edges to trim, drag the small handles
  at the top corners for fades, Alt-drag vertically for clip gain. Edits snap to the visible grid;
  hold ⌘/Ctrl while dragging to bypass.
- **Projects** save automatically. The project name menu (top left) creates, renames, opens,
  deletes, exports and imports projects (`.tessera` files carry the project and its audio).

| Shortcut                         | Action                                                       |
| -------------------------------- | ------------------------------------------------------------ |
| Space                            | Play / pause                                                 |
| Home / Enter, End                | Go to start / end                                            |
| S                                | Split selected clips (or the selected track) at the playhead |
| ⌘/Ctrl D                         | Duplicate selected clips                                     |
| Delete / Backspace               | Delete selected clips, or the selected track                 |
| ⌘/Ctrl Z, ⇧⌘/Ctrl Z              | Undo, redo                                                   |
| ⌘/Ctrl A, Esc                    | Select all clips, clear selection                            |
| L, C, N                          | Loop, metronome, snap                                        |
| + / −, ⌘/Ctrl-scroll or pinch    | Zoom                                                         |
| Shift-scroll or horizontal swipe | Scroll the timeline                                          |

## Prerequisites

- Rust via [rustup](https://rustup.rs). `rust-toolchain.toml` pins stable plus the
  `wasm32-unknown-unknown` target, `rustfmt` and `clippy`.
- Node.js 22+ and pnpm (the version is pinned in `package.json` → `packageManager`).
- Desktop edition: the [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS. On Linux you also need `libasound2-dev`.

```sh
pnpm install
```

## Commands

| Command                  | What it does                                                                  |
| ------------------------ | ----------------------------------------------------------------------------- |
| `pnpm dev:web`           | Builds `engine.wasm`, then starts the web edition at http://localhost:5173    |
| `pnpm dev:desktop`       | Runs the desktop edition (Tauri dev, hot reload)                              |
| `cargo test --workspace` | Rust tests (engine-core includes an `assert_no_alloc` test of the audio path) |
| `pnpm test`              | Builds `engine.wasm`, runs Vitest (including tests against the real module)   |
| `pnpm e2e`               | Playwright (Chromium) against the production web build                        |
| `pnpm e2e:pages`         | Same, served as on GitHub Pages (sub-path, no COOP/COEP headers)              |
| `pnpm lint`              | ESLint + Prettier check                                                       |
| `pnpm typecheck`         | `tsc` in every package                                                        |
| `pnpm gen:schema`        | Regenerates `packages/schema/src/generated` from the Rust protocol types      |
| `pnpm build:web`         | Production web build in `apps/web/dist`                                       |
| `pnpm build:desktop`     | Desktop installers via `tauri build`                                          |

Optional desktop audio hosts are Cargo features of `engine-native`, forwarded by the desktop app:

- `asio` (Windows): needs the ASIO SDK (`CPAL_ASIO_DIR`) and LLVM/clang at build time.
- `jack` (Linux): JACK, including PipeWire through its JACK layer.

For example: `pnpm --filter @tessera/desktop tauri dev --features asio`.

## Layout

```
crates/engine-core     platform-agnostic engine (DSP, command/event protocol); no I/O, no threads
crates/engine-wasm     raw C-ABI WASM build of engine-core, run inside the AudioWorklet
crates/engine-native   cpal output stream, device enumeration, file import (desktop)
crates/media           decoding (WAV, FLAC, MP3, OGG Vorbis, AAC/M4A), resampling, waveform peaks
crates/worker-wasm     raw C-ABI WASM for the web worker: decoding, project loading, archives
crates/tune            Tune pitch editor DSP (M4)
crates/project         project model, schema versions and migrations, .tessera archives
crates/plugin-host     VST3/CLAP hosting (M7)
apps/web               Vite app using WebPlatform
apps/desktop           Tauri v2 app using TauriPlatform (Rust backend in src-tauri/)
packages/platform      AudioPlatform interface + WebPlatform + TauriPlatform
packages/ui            shared React UI (arrange view, store, engine sync); talks only to AudioPlatform
packages/schema        TS types generated from Rust (never hand-edit src/generated)
```

## Web hosting

The web edition uses `SharedArrayBuffer`, so every response must be served with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Vite dev and preview servers already send them. The status panel shows
`crossOriginIsolated: true` when they are in effect.

### GitHub Pages

`.github/workflows/pages.yml` deploys the web edition on every push to `main` (or manually from the
Actions tab) to `https://<owner>.github.io/<repo>/`. One-time setup: **Settings → Pages → Source:
GitHub Actions**.

GitHub Pages can't send custom headers. Instead, `apps/web/public/coi-sw.js` is a service worker
that adds them: on the first visit the page installs it and reloads once. Build with
`BASE_PATH=/<repo>/` for sub-path hosting; `pnpm e2e:pages` tests this setup locally.

## License

Tessera is free software, licensed under the **GNU General Public License v3.0 or later**. See
[LICENSE](LICENSE).

GPLv3 is required for the desktop edition's ASIO support: Steinberg's ASIO SDK is available under
GPLv3 or a proprietary agreement. The VST3 SDK is MIT-licensed since v3.8.
