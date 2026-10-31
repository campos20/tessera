// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use engine_core::{Command, Event};
use engine_native::{AudioDeviceList, AudioOutput, OutputInfo};
use tauri::{AppHandle, Emitter, Manager, State};

/// Aborts if the audio callback allocates (debug builds only).
#[cfg(debug_assertions)]
#[global_allocator]
static ALLOCATOR: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

/// Must match `ENGINE_EVENT` in packages/platform/src/tauri.
const ENGINE_EVENT: &str = "engine-event";
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(33);

/// The running output stream. The mutex is only ever taken by UI-side threads; the audio
/// thread talks to the engine through engine-core's lock-free queues.
#[derive(Default)]
struct AudioState(Mutex<Option<AudioOutput>>);

impl AudioState {
    fn lock(&self) -> MutexGuard<'_, Option<AudioOutput>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[tauri::command]
fn audio_start(state: State<'_, AudioState>) -> Result<OutputInfo, String> {
    let mut audio = state.lock();
    if let Some(output) = audio.as_ref() {
        return Ok(output.info().clone());
    }
    let output = AudioOutput::start_default().map_err(|e| e.to_string())?;
    let info = output.info().clone();
    *audio = Some(output);
    Ok(info)
}

#[tauri::command]
fn audio_send(state: State<'_, AudioState>, command: Command) -> Result<(), String> {
    let mut audio = state.lock();
    let output = audio.as_mut().ok_or("audio engine not started")?;
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

/// Forwards engine events to the webview. Only the latest peak per tick is sent.
fn spawn_event_forwarder(app: AppHandle) {
    std::thread::Builder::new()
        .name("tessera-events".into())
        .spawn(move || {
            loop {
                std::thread::sleep(EVENT_POLL_INTERVAL);
                let mut peak = None;
                if let Some(output) = app.state::<AudioState>().lock().as_mut() {
                    while let Some(event) = output.poll_event() {
                        match event {
                            Event::Peak { .. } => peak = Some(event),
                        }
                    }
                }
                if let Some(event) = peak {
                    let _ = app.emit(ENGINE_EVENT, event);
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
            list_devices
        ])
        .setup(|app| {
            spawn_event_forwarder(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tessera");
}
