// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;
mod tune;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use engine_core::{Command, Event};
use engine_native::{
    AudioConfig, AudioDeviceList, AudioInfo, AudioIo, RecordedTake, TakeProgress, import_source,
};
use media::SourceInfo;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State};

/// Aborts if the audio callback allocates (debug builds only).
#[cfg(debug_assertions)]
#[global_allocator]
static ALLOCATOR: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

/// Must match the event names in packages/platform/src/tauri.
const ENGINE_EVENTS: &str = "engine-events";
const RECORDING_PROGRESS: &str = "recording-progress";
const AUDIO_XRUNS: &str = "audio-xruns";
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(33);

/// The running audio streams and the settings they were opened with. The mutexes are only
/// ever taken by UI-side threads; the audio thread talks to the engine through engine-core's
/// lock-free queues.
#[derive(Default)]
pub(crate) struct AudioState {
    io: Mutex<Option<AudioIo>>,
    config: Mutex<AudioConfig>,
    pub(crate) next_source_id: AtomicU32,
}

impl AudioState {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Option<AudioIo>> {
        self.io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts the streams with the current settings if needed and returns their info.
    pub(crate) fn ensure_started(&self) -> Result<AudioInfo, String> {
        let mut io = self.lock();
        if let Some(io) = io.as_ref() {
            return Ok(io.info().clone());
        }
        let config = self
            .config
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let started = AudioIo::start(&config).map_err(|e| e.to_string())?;
        let info = started.info().clone();
        *io = Some(started);
        Ok(info)
    }
}

#[tauri::command]
fn audio_start(state: State<'_, AudioState>) -> Result<AudioInfo, String> {
    state.ensure_started()
}

/// Reopens the streams with new settings. The engine restarts empty: the UI resends the
/// project and reloads its audio.
#[tauri::command]
async fn audio_configure(
    state: State<'_, AudioState>,
    config: AudioConfig,
) -> Result<AudioInfo, String> {
    let mut io = state.lock();
    // Stop the old streams first: some drivers (ASIO) allow only one client.
    drop(io.take());
    let started = AudioIo::start(&config).map_err(|e| e.to_string())?;
    let info = started.info().clone();
    *io = Some(started);
    *state.config.lock().unwrap_or_else(|p| p.into_inner()) = config;
    Ok(info)
}

/// Starts writing armed tracks' input to WAV files in the project's `audio/` folder.
#[tauri::command]
async fn recording_begin(
    app: AppHandle,
    state: State<'_, AudioState>,
    project_id: String,
    prefix: String,
) -> Result<(), String> {
    let dir = storage::project_audio_dir(&app, &project_id)?;
    let mut io = state.lock();
    io.as_mut()
        .ok_or("audio engine not started")?
        .begin_recording(dir, prefix)
}

/// Finishes the takes; their `file`s are inside the project's `audio/` folder.
#[tauri::command]
async fn recording_end(state: State<'_, AudioState>) -> Result<Vec<RecordedTake>, String> {
    let mut io = state.lock();
    io.as_mut()
        .ok_or("audio engine not started")?
        .end_recording()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Latency {
    frames: usize,
    confidence: f32,
}

/// Measures round-trip latency from a calibration take of the metronome at `bpm` that
/// started at timeline frame 0.
#[tauri::command]
async fn measure_latency(
    app: AppHandle,
    project_id: String,
    path: String,
    bpm: f64,
) -> Result<Option<Latency>, String> {
    let bytes = std::fs::read(storage::project_file_path(&app, &project_id, &path)?)
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let decoded = media::decode(bytes, Some("wav")).map_err(|e| e.to_string())?;
        let recorded = &decoded.channels[0];
        let reference = engine_core::calibration::click_track(
            f64::from(decoded.sample_rate),
            bpm,
            recorded.len(),
        );
        let max_lag = decoded.sample_rate as usize / 2;
        Ok(
            engine_core::calibration::measure_latency(&reference, recorded, max_lag).map(|m| {
                Latency {
                    frames: m.frames,
                    confidence: m.confidence,
                }
            }),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn audio_send(state: State<'_, AudioState>, command: Command) -> Result<(), String> {
    let mut output = state.lock();
    let output = output.as_mut().ok_or("audio engine not started")?;
    output
        .send(command)
        .map_err(|c| format!("command queue full, dropped {c:?}"))
}

#[tauri::command]
fn audio_info(state: State<'_, AudioState>) -> Option<AudioInfo> {
    state.lock().as_ref().map(|o| o.info().clone())
}

/// Async so device enumeration (which can be slow) runs off the main thread.
#[tauri::command]
async fn list_devices() -> AudioDeviceList {
    engine_native::list_devices()
}

/// Imports an audio file sent as the raw request body, with its name in the
/// percent-encoded `x-file-name` header. Decoding runs on a blocking worker thread.
#[tauri::command]
async fn import_audio(
    request: Request<'_>,
    state: State<'_, AudioState>,
) -> Result<SourceInfo, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file as a raw request body".into());
    };
    let bytes = bytes.clone();
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_else(|| "audio".into());

    let sample_rate = state.ensure_started()?.sample_rate;
    let id = state.next_source_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (info, buffer) =
        tauri::async_runtime::spawn_blocking(move || import_source(id, &name, bytes, sample_rate))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;

    let mut output = state.lock();
    let output = output.as_mut().ok_or("audio engine not started")?;
    output
        .add_source(id, buffer)
        .map_err(|_| "engine queue full, try again".to_string())?;
    Ok(info)
}

/// Decodes `%XX` escapes (as produced by `encodeURIComponent`).
pub(crate) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Forwards engine events to the webview in batches, keeping only the latest transport
/// state and meter reading per track, and frees audio the engine has released.
fn spawn_event_forwarder(app: AppHandle) {
    std::thread::Builder::new()
        .name("tessera-events".into())
        .spawn(move || {
            let mut batch: Vec<Event> = Vec::new();
            let mut progress: Vec<TakeProgress> = Vec::new();
            let mut last_xruns = 0;
            loop {
                std::thread::sleep(EVENT_POLL_INTERVAL);
                batch.clear();
                progress.clear();
                let mut xruns = last_xruns;
                if let Some(output) = app.state::<AudioState>().lock().as_mut() {
                    progress = output.poll_recording_progress();
                    xruns = output.xruns();
                    while let Some(event) = output.poll_event() {
                        let same_slot = |e: &Event| match (e, &event) {
                            (Event::Transport { .. }, Event::Transport { .. })
                            | (Event::MasterMeter { .. }, Event::MasterMeter { .. }) => true,
                            (
                                Event::TrackMeter { track: a, .. },
                                Event::TrackMeter { track: b, .. },
                            )
                            | (
                                Event::InputMeter { track: a, .. },
                                Event::InputMeter { track: b, .. },
                            ) => a == b,
                            _ => false,
                        };
                        match batch.iter_mut().find(|e| same_slot(e)) {
                            Some(slot) => *slot = event,
                            None => batch.push(event),
                        }
                    }
                    output.collect_garbage();
                }
                if !batch.is_empty() {
                    let _ = app.emit(ENGINE_EVENTS, &batch);
                }
                if !progress.is_empty() {
                    let _ = app.emit(RECORDING_PROGRESS, &progress);
                }
                if xruns != last_xruns {
                    last_xruns = xruns;
                    let _ = app.emit(AUDIO_XRUNS, xruns);
                }
            }
        })
        .expect("failed to spawn event forwarder thread");
}

fn main() {
    println!("Tessera audio devices:\n{}", engine_native::list_devices());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AudioState::default())
        .manage(tune::TuneState::default())
        .invoke_handler(tauri::generate_handler![
            audio_start,
            audio_configure,
            recording_begin,
            recording_end,
            measure_latency,
            audio_send,
            audio_info,
            list_devices,
            import_audio,
            storage::project_list,
            storage::project_open,
            storage::project_save,
            storage::project_write_file,
            storage::project_read_file,
            storage::project_delete,
            storage::project_delete_file,
            storage::project_export,
            storage::project_import,
            tune::tune_open,
            tune::tune_plan,
            tune::tune_close
        ])
        .setup(|app| {
            spawn_event_forwarder(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tessera");
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_encode_uri_component_output() {
        assert_eq!(
            percent_decode("Take%203%20(final).wav"),
            "Take 3 (final).wav"
        );
        assert_eq!(percent_decode("voz%C3%A3o.flac"), "vozão.flac");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
