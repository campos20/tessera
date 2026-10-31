# Tessera: guide for coding agents

Tessera is a free DAW whose differentiator is **Tune**: graphical, note-level pitch and timing
editing (in the spirit of existing pitch-alignment software), monophonic only (vocals, bass, solo
instruments). It ships as two editions from one codebase:

- **Web**: browser, Chromium first. AudioWorklet running the engine compiled to WASM.
- **Desktop**: Tauri v2 (Windows, macOS, Linux). Native engine on cpal (ASIO, WASAPI, CoreAudio,
  ALSA/JACK); VST3/CLAP hosting later.

## Architecture

```
React UI (packages/ui) ──► AudioPlatform interface (packages/platform)
                              ├─ WebPlatform:   AudioWorklet + engine-wasm, SharedArrayBuffer rings
                              └─ TauriPlatform: Tauri IPC → engine-native (cpal)
                                        both run ► engine-core (+ tune), platform-agnostic Rust
```

All DSP lives in Rust crates that compile to both `wasm32-unknown-unknown` and native. Platform
layers only do I/O.

## Rules

- **Real-time rules (non-negotiable).** Nothing reachable from an audio callback, `Engine::process`
  or the AudioWorklet's `process()` may allocate, lock, do I/O, log or panic.
  - Messages go through `rtrb` SPSC rings (web: the SharedArrayBuffer `CommandRing`).
  - Large data is prepared off-thread and handed over by pointer swap (`arc-swap` / triple buffer).
  - `assert_no_alloc` guards the audio path in debug builds and tests; keep it that way.
- **DSP placement.** DSP goes in `engine-core` / `tune`. Platform crates and layers only move
  samples and messages.
- **UI isolation.** `packages/ui` talks only to the `AudioPlatform` interface. It never imports
  Tauri or uses Web Audio directly; ESLint enforces this.
- **Generated types.** Protocol and project types are defined in Rust and generated to
  `packages/schema/src/generated` (`pnpm gen:schema`). Never hand-edit generated files; commit the
  regenerated output (CI checks it is fresh).
- **Tests.** Every DSP change needs a test. Prefer offline-render golden tests with dB tolerances,
  never bit-exact comparisons across platforms.
- **Ask first** before:
  - adding a dependency whose license isn't GPLv3-compatible;
  - changing the command protocol or project schema without a migration;
  - making a decision the roadmap below doesn't cover.
- **Third-party products.** Don't name proprietary products or competitors in code, docs or
  commits. Describe the capability instead (e.g. "existing pitch-alignment software").
- **License.** GPL-3.0-or-later; the ASIO SDK's GPLv3 option depends on it.

## Workflow

Work one milestone at a time. At the start of a milestone, propose a task list and wait for
approval before coding. Before calling a milestone done, make sure its acceptance criteria pass.

## Commands

| Command                  | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `pnpm install`           | Install JS dependencies                                           |
| `pnpm dev:web`           | Build `engine.wasm` and start the web edition (localhost:5173)    |
| `pnpm dev:desktop`       | Run the desktop edition (Tauri dev)                               |
| `cargo test --workspace` | Rust tests                                                        |
| `pnpm test`              | Build `engine.wasm` and run Vitest                                |
| `pnpm e2e`               | Playwright against the production web build (`E2E_DEV=1` for dev) |
| `pnpm lint`              | ESLint + Prettier check                                           |
| `pnpm typecheck`         | `tsc` in every package                                            |
| `pnpm gen:schema`        | Regenerate TS types from Rust                                     |

Before handing work back, run `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace`, `pnpm lint`, `pnpm typecheck` and `pnpm test`.

## Layout

```
crates/engine-core     engine: DSP, transport, mixer, command/event protocol. No I/O, no threads
crates/tune            pitch analysis, note segmentation, key/tempo, PSOLA rendering
crates/project         project model, serde schema versions, migrations
crates/engine-wasm     raw C-ABI WASM build of engine-core for the AudioWorklet (no wasm-bindgen)
crates/engine-native   cpal I/O, device management, MIDI (desktop)
crates/plugin-host     VST3/CLAP scanning and hosting (desktop)
apps/web               Vite app using WebPlatform (COOP/COEP headers required)
apps/desktop           Tauri v2 app using TauriPlatform; Rust backend in src-tauri/
packages/platform      AudioPlatform interface + WebPlatform + TauriPlatform
packages/ui            shared React UI
packages/schema        generated TS types
```

## Stack

- **Engine:** Rust (edition 2024), Tauri v2.
- **UI:** React 18 + TypeScript + Vite, Zustand (+ immer patches for undo), Canvas 2D for the
  editors.
- **Audio and data crates:** `cpal`, `midir`, `symphonia` (decoding), `rubato` (resampling),
  `rtrb`, `ts-rs`.
- **Tooling:** pnpm + Cargo workspaces. Tests use `cargo test`, Vitest and Playwright.

## Roadmap

- [ ] **M0** Skeleton, CI, "hello sine" in both editions from the same engine-core oscillator.
- [ ] **M1** Engine core: graph, transport, clip playback, mixer basics, file import, offline render.
- [ ] **M2** Timeline UI and projects: arrange view, undo/redo, save/load, `.tessera` zip, migrations.
- [ ] **M3** Devices and recording: device settings, latency calibration, recording with punch.
- [ ] **M4** Tune: analysis, note editing, pitch correction, timing quantize, incremental re-render.
      First public release ("record + Tune" on the web).
- [ ] **M5** Mixer, built-in effects, automation.
- [ ] **M6** MIDI: piano roll, synth/sampler, MIDI I/O, export Tune notes as MIDI.
- [ ] **M7** Desktop plugin hosting (VST3 + CLAP), out-of-process scanner.
- [ ] **M8** Export, polish, signed installers, web deployment.
- [ ] **M9** Optional AI backend (stem separation, robust pitch tracking), feature-flagged.
