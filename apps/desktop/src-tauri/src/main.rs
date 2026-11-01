// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use engine_core::{Command, Event};
use engine_native::{AudioDeviceList, AudioOutput, OutputInfo, import_source};
use media::SourceInfo;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, State};

/// Aborts if the audio callback allocates (debug builds only).
#[cfg(debug_assertions)]
#[global_allocator]
static ALLOCATOR: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

/// Must match `ENGINE_EVENTS` in packages/platform/src/tauri.
const ENGINE_EVENTS: &str = "engine-events";
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(33);

/// The running output stream. The mutex is only ever taken by UI-side threads; the audio
/// thread talks to the engine through engine-core's lock-free queues.
#[derive(Default)]
struct AudioState {
    output: Mutex<Option<AudioOutput>>,
    next_source_id: AtomicU32,
}

impl AudioState {
    fn lock(&self) -> MutexGuard<'_, Option<AudioOutput>> {
        self.output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts the default output if needed and returns its info.
    fn ensure_started(&self) -> Result<OutputInfo, String> {
        let mut output = self.lock();
        if let Some(output) = output.as_ref() {
            return Ok(output.info().clone());
        }
        let started = AudioOutput::start_default().map_err(|e| e.to_string())?;
        let info = started.info().clone();
        *output = Some(started);
        Ok(info)
    }
}

#[tauri::command]
fn audio_start(state: State<'_, AudioState>) -> Result<OutputInfo, String> {
    state.ensure_started()
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
fn audio_info(state: State<'_, AudioState>) -> Option<OutputInfo> {
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
fn percent_decode(s: &str) -> String {
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
            loop {
                std::thread::sleep(EVENT_POLL_INTERVAL);
                batch.clear();
                if let Some(output) = app.state::<AudioState>().lock().as_mut() {
                    while let Some(event) = output.poll_event() {
                        let same_slot = |e: &Event| match (e, &event) {
                            (Event::Transport { .. }, Event::Transport { .. })
                            | (Event::MasterMeter { .. }, Event::MasterMeter { .. }) => true,
                            (
                                Event::TrackMeter { track: a, .. },
                                Event::TrackMeter { track: b, .. },
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
            }
        })
        .expect("failed to spawn event forwarder thread");
}

fn main() {
    println!("Tessera audio devices:\n{}", engine_native::list_devices());

    tauri::Builder::default()
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            audio_start,
            audio_send,
            audio_info,
            list_devices,
            import_audio
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
