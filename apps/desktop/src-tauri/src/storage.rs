//! Project storage for the desktop edition: `<app data>/projects/<id>/project.json` plus the
//! project's audio files. Mirrors the web edition's OPFS layout, so `.tessera` archives move
//! between editions unchanged.

use std::path::{Path, PathBuf};

use project::{Project, archive};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

const PROJECT_FILE: &str = "project.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    id: String,
    name: String,
    modified_at: String,
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects"))
}

fn project_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    dir_in(&projects_dir(app)?, id)
}

/// Joins a project-relative path after checking it can't escape the project folder.
fn project_file(app: &AppHandle, id: &str, path: &str) -> Result<PathBuf, String> {
    file_in(&projects_dir(app)?, id, path)
}

fn dir_in(root: &Path, id: &str) -> Result<PathBuf, String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("invalid project id: {id:?}"));
    }
    Ok(root.join(id))
}

fn file_in(root: &Path, id: &str, path: &str) -> Result<PathBuf, String> {
    archive::check_path(path).map_err(|e| e.to_string())?;
    Ok(dir_in(root, id)?.join(path))
}

/// Writes via a temporary file and rename, so a crash never leaves a half-written file.
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp-write");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(crate::percent_decode)
        .ok_or_else(|| format!("missing {name} header"))
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("expected a raw request body".into()),
    }
}

#[tauri::command]
pub async fn project_list(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    Ok(list_in(&projects_dir(&app)?))
}

fn list_in(dir: &Path) -> Vec<ProjectSummary> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path().join(PROJECT_FILE)) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let id = entry.file_name().to_string_lossy().into_owned();
        out.push(ProjectSummary {
            name: json["name"].as_str().unwrap_or(&id).to_string(),
            modified_at: json["modifiedAt"].as_str().unwrap_or_default().to_string(),
            id,
        });
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

#[tauri::command]
pub async fn project_open(app: AppHandle, id: String) -> Result<Project, String> {
    let text = std::fs::read_to_string(project_dir(&app, &id)?.join(PROJECT_FILE))
        .map_err(|e| e.to_string())?;
    project::load(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn project_save(app: AppHandle, project: Project) -> Result<(), String> {
    let path = project_dir(&app, &project.id)?.join(PROJECT_FILE);
    write_atomic(&path, project::save(&project).as_bytes())
}

/// Raw body: the file bytes. Headers: `x-project-id`, `x-path` (percent-encoded).
#[tauri::command]
pub async fn project_write_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let path = project_file(
        &app,
        &header(&request, "x-project-id")?,
        &header(&request, "x-path")?,
    )?;
    write_atomic(&path, &raw_body(&request)?)
}

#[tauri::command]
pub async fn project_read_file(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<Response, String> {
    let bytes = std::fs::read(project_file(&app, &id, &path)?).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn project_delete(app: AppHandle, id: String) -> Result<(), String> {
    std::fs::remove_dir_all(project_dir(&app, &id)?).map_err(|e| e.to_string())
}

/// Writes the project folder as a `.tessera` archive at `dest` (chosen in a save dialog).
#[tauri::command]
pub async fn project_export(app: AppHandle, id: String, dest: String) -> Result<(), String> {
    let zip = export_in(&projects_dir(&app)?, &id)?;
    std::fs::write(dest, zip).map_err(|e| e.to_string())
}

fn export_in(root: &Path, id: &str) -> Result<Vec<u8>, String> {
    let dir = dir_in(root, id)?;
    let mut entries = Vec::new();
    collect(&dir, &dir, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    archive::write(&entries).map_err(|e| e.to_string())
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, out)?;
        } else if path.extension().is_none_or(|e| e != "tmp-write") {
            let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
            let rel = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, std::fs::read(&path).map_err(|e| e.to_string())?));
        }
    }
    Ok(())
}

/// Raw body: a `.tessera` archive. Header: `x-project-id` (the new project's id).
#[tauri::command]
pub async fn project_import(app: AppHandle, request: Request<'_>) -> Result<Project, String> {
    import_in(
        &projects_dir(&app)?,
        &header(&request, "x-project-id")?,
        &raw_body(&request)?,
    )
}

fn import_in(root: &Path, id: &str, zip: &[u8]) -> Result<Project, String> {
    let id = id.to_string();
    let entries = archive::read(zip).map_err(|e| e.to_string())?;
    let (_, json) = entries
        .iter()
        .find(|(path, _)| path == PROJECT_FILE)
        .ok_or("this .tessera file has no project.json")?;
    let mut project = project::load(std::str::from_utf8(json).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    project.id = id.clone();
    for (path, data) in &entries {
        if path != PROJECT_FILE {
            write_atomic(&file_in(root, &id, path)?, data)?;
        }
    }
    write_atomic(
        &dir_in(root, &id)?.join(PROJECT_FILE),
        project::save(&project).as_bytes(),
    )?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tessera-storage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_project(id: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"id":"{id}","name":"Song","sampleRate":48000,"tempo":120.0,
            "timeSignature":{{"numerator":4,"denominator":4}},"masterGain":1.0,"metronome":false,
            "loop":{{"enabled":false,"start":0,"end":0}},"tracks":[],"sources":[],"nextId":1,
            "createdAt":"2026-01-01T00:00:00Z","modifiedAt":"2026-01-02T00:00:00Z"}}"#
        )
    }

    #[test]
    fn exports_and_imports_under_a_new_id() {
        let root = temp_root("roundtrip");
        write_atomic(
            &dir_in(&root, "orig").unwrap().join(PROJECT_FILE),
            sample_project("orig").as_bytes(),
        )
        .unwrap();
        write_atomic(
            &file_in(&root, "orig", "audio/1-take.wav").unwrap(),
            b"RIFF...",
        )
        .unwrap();

        let zip = export_in(&root, "orig").unwrap();
        let imported = import_in(&root, "copy", &zip).unwrap();
        assert_eq!(
            (imported.id.as_str(), imported.name.as_str()),
            ("copy", "Song")
        );
        assert_eq!(
            std::fs::read(root.join("copy/audio/1-take.wav")).unwrap(),
            b"RIFF..."
        );
        let listed: Vec<String> = list_in(&root).into_iter().map(|p| p.id).collect();
        assert_eq!(listed.len(), 2);
        assert!(listed.contains(&"copy".to_string()) && listed.contains(&"orig".to_string()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_bad_ids_and_escaping_paths() {
        let root = temp_root("paths");
        for id in ["", "../x", "a/b", "x".repeat(65).as_str()] {
            assert!(dir_in(&root, id).is_err(), "{id:?}");
        }
        for path in ["../escape", "/abs", "audio/../../x", "a\\b"] {
            assert!(file_in(&root, "ok", path).is_err(), "{path:?}");
        }
        assert!(import_in(&root, "bad", b"not a zip").is_err());
        let no_project = archive::write(&[("audio/a.wav".into(), vec![1])]).unwrap();
        assert!(
            import_in(&root, "bad", &no_project)
                .unwrap_err()
                .contains("no project.json")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
