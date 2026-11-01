//! Tune sessions for the desktop edition. Rendered regions go straight into the engine as
//! sources; only plans (segment lists and source ids) cross IPC, never audio.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use engine_core::{AudioBuffer, Command};
use serde::Serialize;
use tauri::{AppHandle, State};
use tune::{Note, PlannedSegment, TuneAnalysis, TuneSession};

use crate::AudioState;

struct Session {
    tune: TuneSession,
    /// Engine source id of every region rendered in this session, by region key.
    sources: HashMap<String, u32>,
}

#[derive(Default)]
pub struct TuneState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunePlan {
    segments: Vec<PlannedSegment>,
    output_frames: u64,
    sources: HashMap<String, u32>,
}

#[tauri::command]
pub async fn tune_open(
    app: AppHandle,
    audio: State<'_, AudioState>,
    state: State<'_, TuneState>,
    session_id: String,
    project_id: String,
    path: String,
) -> Result<TuneAnalysis, String> {
    let rate = audio.ensure_started()?.sample_rate;
    let file = crate::storage::project_file_path(&app, &project_id, &path)?;
    let (session, analysis) = tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        let ext = media::extension_hint(&path);
        let imported = media::import(bytes, ext.as_deref(), rate).map_err(|e| e.to_string())?;
        let session = TuneSession::open(imported.channels, f64::from(rate));
        let analysis = session.describe();
        Ok::<_, String>((session, analysis))
    })
    .await
    .map_err(|e| e.to_string())??;
    let old = state
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            session_id,
            Session {
                tune: session,
                sources: HashMap::new(),
            },
        );
    if let Some(old) = old {
        release(&audio, old.sources.into_values());
    }
    Ok(analysis)
}

#[tauri::command]
pub async fn tune_plan(
    audio: State<'_, AudioState>,
    state: State<'_, TuneState>,
    session_id: String,
    notes: Vec<Note>,
) -> Result<TunePlan, String> {
    let mut sessions = state.sessions.lock().unwrap_or_else(|p| p.into_inner());
    let session = sessions
        .get_mut(&session_id)
        .ok_or("tune session is not open")?;
    let known: HashSet<String> = session.sources.keys().cloned().collect();
    // Regions render in a few milliseconds, so this runs inline.
    let plan = session.tune.plan(&notes, &known);
    if !plan.new_regions.is_empty() {
        let mut io = audio.lock();
        let io = io.as_mut().ok_or("audio engine not started")?;
        for (key, channels) in plan.new_regions {
            let id = audio.next_source_id.fetch_add(1, Ordering::Relaxed) + 1;
            io.add_source(id, Arc::new(AudioBuffer::new(channels)))
                .map_err(|_| "engine queue full, try again".to_string())?;
            session.sources.insert(key, id);
        }
    }
    let mut sources = HashMap::new();
    for seg in &plan.segments {
        if let PlannedSegment::Rendered { key, .. } = seg {
            sources.insert(key.clone(), session.sources[key]);
        }
    }
    Ok(TunePlan {
        segments: plan.segments,
        output_frames: plan.output_frames,
        sources,
    })
}

#[tauri::command]
pub async fn tune_close(
    audio: State<'_, AudioState>,
    state: State<'_, TuneState>,
    session_id: String,
) -> Result<(), String> {
    let removed = state
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&session_id);
    if let Some(session) = removed {
        release(&audio, session.sources.into_values());
    }
    Ok(())
}

/// Frees a session's rendered regions in the engine.
fn release(audio: &AudioState, sources: impl Iterator<Item = u32>) {
    if let Some(io) = audio.lock().as_mut() {
        for source in sources {
            let _ = io.send(Command::RemoveSource { source });
        }
    }
}
