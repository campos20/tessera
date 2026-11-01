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
- **Protocol.** UI ↔ engine messages are defined once in `engine-core/src/protocol.rs` (the
  `protocol!` macro). It derives the serde/JSON form (Tauri IPC), the raw `opcode + f64 args` form
  (web rings and WASM ABI) and the generated TypeScript layout table. Add commands there, never
  by hand-writing opcodes in TypeScript. Positions are frames at the engine sample rate.
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
| `pnpm e2e:pages`         | Playwright as deployed on GitHub Pages (sub-path, no COOP/COEP)   |
| `pnpm lint`              | ESLint + Prettier check                                           |
| `pnpm typecheck`         | `tsc` in every package                                            |
| `pnpm gen:schema`        | Regenerate TS types from Rust                                     |

Before handing work back, run `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace`, `pnpm lint`, `pnpm typecheck` and `pnpm test`.

## Layout

```
crates/engine-core     engine: DSP, transport, mixer, command/event protocol. No I/O, no threads
crates/tune            pitch analysis, note segmentation, key/tempo, PSOLA rendering
crates/project         project model, schema versions and migrations, .tessera archives
crates/engine-wasm     raw C-ABI WASM build of engine-core for the AudioWorklet (no wasm-bindgen)
crates/engine-native   cpal I/O, device management, MIDI (desktop)
crates/media           decoding (symphonia), resampling (rubato), waveform peaks; no engine dependency
crates/worker-wasm     raw C-ABI WASM for the web worker: decoding, project loading, archives
crates/plugin-host     VST3/CLAP scanning and hosting (desktop)
apps/web               Vite app using WebPlatform (COOP/COEP headers, or public/coi-sw.js on GitHub Pages)
apps/desktop           Tauri v2 app using TauriPlatform; Rust backend in src-tauri/
packages/platform      AudioPlatform interface + WebPlatform + TauriPlatform
packages/ui            shared React UI: arrange view, store (Zustand + immer undo), EngineSync, Session
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

- [x] **M0** Skeleton, CI, "hello sine" in both editions from the same engine-core oscillator.
- [x] **M1** Engine core: graph, transport, clip playback, mixer basics, file import, offline render.
  - Accept: a 2-track project rendered offline matches a golden file (−90 dB); a project with no
    processing renders within −90 dB of its sources; no allocations on the audio thread
    (`assert_no_alloc`, including a 64-track random-command stress test); 16 tracks play
    glitch-free in the web edition on a mid-range laptop.
  - Decisions: decoding lives in `crates/media`; the web edition stays on stable Rust, so decoded
    audio is copied into the worklet's WASM memory in chunks at import time, never in `process()`.
- [x] **M2** Timeline UI and projects: arrange view, undo/redo, save/load, `.tessera` zip, migrations.
  - Accept: create, edit, save, reload and continue editing a project in both editions; a
    Playwright E2E test covers the web flow.
  - Decisions: timeline positions are frames at a fixed 48 kHz project rate (`crates/project`),
    converted to engine frames only in `EngineSync`; `.tessera` is an uncompressed zip written by
    one Rust implementation (native on desktop, `worker-wasm` on the web); desktop projects live in
    the app data folder, web projects in OPFS; the engine keeps imported audio for the session so
    undo/redo of imports never re-decodes.
- [ ] **M3** Devices and recording: device settings, latency calibration, recording with punch.
- [ ] **M4** Tune: analysis, note editing, pitch correction, timing quantize, incremental re-render.
      First public release ("record + Tune" on the web).
- [ ] **M5** Mixer, built-in effects, automation.
- [ ] **M6** MIDI: piano roll, synth/sampler, MIDI I/O, export Tune notes as MIDI.
- [ ] **M7** Desktop plugin hosting (VST3 + CLAP), out-of-process scanner.
- [ ] **M8** Export, polish, signed installers, web deployment.
- [ ] **M9** Optional AI backend (stem separation, robust pitch tracking), feature-flagged.
