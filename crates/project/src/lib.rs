//! Tessera project model, shared by both editions.
//!
//! A project is saved as `project.json` next to its audio files. Every saved document carries
//! `schemaVersion`; [`load`] migrates older documents forward before deserializing, so old
//! projects keep opening. Bump [`SCHEMA_VERSION`] and add a migration to [`MIGRATIONS`]
//! whenever the saved shape changes.
//!
//! Timeline positions and lengths are frames at [`PROJECT_SAMPLE_RATE`], independent of the
//! audio device; the UI converts them to engine frames when talking to the engine.

pub mod archive;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current saved-document version.
pub const SCHEMA_VERSION: u32 = 1;

/// Unit of all timeline positions and lengths in a project.
pub const PROJECT_SAMPLE_RATE: u32 = 48_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Project {
    pub schema_version: u32,
    /// Stable identifier, also the storage key (web) or default folder name (desktop).
    pub id: String,
    pub name: String,
    /// Frames per second of every timeline position; always [`PROJECT_SAMPLE_RATE`] today.
    pub sample_rate: u32,
    pub tempo: f64,
    pub time_signature: TimeSignature,
    pub master_gain: f32,
    pub metronome: bool,
    #[serde(rename = "loop")]
    pub loop_region: LoopRegion,
    pub tracks: Vec<Track>,
    pub sources: Vec<Source>,
    /// Next id to hand out for tracks, clips and sources (one shared counter).
    pub next_id: u32,
    /// ISO 8601 timestamps, set by the UI.
    pub created_at: String,
    pub modified_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TimeSignature {
    pub numerator: u32,
    pub denominator: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct LoopRegion {
    pub enabled: bool,
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Track {
    pub id: u32,
    pub name: String,
    /// CSS color, e.g. `#ff9f0a`.
    pub color: String,
    /// Linear gain.
    pub gain: f32,
    /// −1 (left) … 1 (right).
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Clip {
    pub id: u32,
    pub source_id: u32,
    pub name: String,
    /// Timeline position of the clip's first frame.
    pub start: u64,
    /// First source frame played.
    pub offset: u64,
    pub length: u64,
    /// Linear gain.
    pub gain: f32,
    pub fade_in: u64,
    pub fade_out: u64,
}

/// An imported audio file. The original file is stored with the project and decoded again
/// on load; `frames` is its length in project frames.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Source {
    pub id: u32,
    /// Original file name, for display.
    pub name: String,
    /// Path of the stored file relative to the project root, e.g. `audio/3-take.wav`.
    pub file: String,
    pub frames: u64,
    pub channels: u32,
    pub original_sample_rate: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectError {
    /// Not JSON, or not shaped like a project after migration.
    Invalid(String),
    /// Saved by a newer Tessera than this one.
    TooNew { version: u32 },
    /// Well-formed but internally inconsistent (see [`Project::validate`]).
    Inconsistent(Vec<String>),
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::Invalid(e) => write!(f, "invalid project file: {e}"),
            ProjectError::TooNew { version } => write!(
                f,
                "this project was saved by a newer version of Tessera (schema {version}, this version reads up to {SCHEMA_VERSION})"
            ),
            ProjectError::Inconsistent(issues) => {
                write!(f, "the project file is inconsistent: {}", issues.join("; "))
            }
        }
    }
}

impl std::error::Error for ProjectError {}

/// A migration upgrades a document from version `n` to `n + 1`, in place.
pub type Migration = fn(&mut Value) -> Result<(), String>;

/// `MIGRATIONS[i]` upgrades version `i + 1` to `i + 2`. Empty while only v1 exists.
pub const MIGRATIONS: &[Migration] = &[];

/// Parses a saved project, migrating older schema versions forward, and rejects projects that
/// fail [`Project::validate`]. Every load path (web, desktop, archive import) goes through here.
pub fn load(json: &str) -> Result<Project, ProjectError> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| ProjectError::Invalid(e.to_string()))?;
    load_value(value, MIGRATIONS, SCHEMA_VERSION)
}

/// Serializes a project for saving (pretty-printed, so diffs and hand inspection stay easy).
pub fn save(project: &Project) -> String {
    serde_json::to_string_pretty(project).expect("projects always serialize")
}

fn load_value(
    mut value: Value,
    migrations: &[Migration],
    current: u32,
) -> Result<Project, ProjectError> {
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| ProjectError::Invalid("missing schemaVersion".into()))?
        as u32;
    if version == 0 {
        return Err(ProjectError::Invalid(
            "schemaVersion must be at least 1".into(),
        ));
    }
    if version > current {
        return Err(ProjectError::TooNew { version });
    }
    for v in version..current {
        let migrate = migrations
            .get((v - 1) as usize)
            .ok_or_else(|| ProjectError::Invalid(format!("no migration from schema {v}")))?;
        migrate(&mut value)
            .map_err(|e| ProjectError::Invalid(format!("migrating from schema {v}: {e}")))?;
        value["schemaVersion"] = Value::from(v + 1);
    }
    let project: Project =
        serde_json::from_value(value).map_err(|e| ProjectError::Invalid(e.to_string()))?;
    let issues = project.validate();
    if issues.is_empty() {
        Ok(project)
    } else {
        Err(ProjectError::Inconsistent(issues))
    }
}

impl Project {
    /// Problems that would make the project misbehave: duplicate ids, clips pointing at
    /// missing sources, an id counter that would reuse ids, clips outside their source.
    pub fn validate(&self) -> Vec<String> {
        let mut issues = Vec::new();
        let mut ids = std::collections::HashSet::new();
        let mut check_id = |kind: &str, id: u32, issues: &mut Vec<String>| {
            if !ids.insert(id) {
                issues.push(format!("duplicate id {id} ({kind})"));
            }
            if id >= self.next_id {
                issues.push(format!(
                    "{kind} id {id} is not below nextId {}",
                    self.next_id
                ));
            }
        };
        for source in &self.sources {
            check_id("source", source.id, &mut issues);
        }
        for track in &self.tracks {
            check_id("track", track.id, &mut issues);
            for clip in &track.clips {
                check_id("clip", clip.id, &mut issues);
                match self.sources.iter().find(|s| s.id == clip.source_id) {
                    None => issues.push(format!(
                        "clip {} uses missing source {}",
                        clip.id, clip.source_id
                    )),
                    Some(source) if clip.offset + clip.length > source.frames => {
                        issues.push(format!(
                            "clip {} extends past the end of source {}",
                            clip.id, source.id
                        ));
                    }
                    Some(_) => {}
                }
            }
        }
        if self.sample_rate != PROJECT_SAMPLE_RATE {
            issues.push(format!(
                "sampleRate {} is not {PROJECT_SAMPLE_RATE}",
                self.sample_rate
            ));
        }
        issues
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        Project {
            schema_version: SCHEMA_VERSION,
            id: "p1".into(),
            name: "Demo".into(),
            sample_rate: PROJECT_SAMPLE_RATE,
            tempo: 120.0,
            time_signature: TimeSignature {
                numerator: 4,
                denominator: 4,
            },
            master_gain: 1.0,
            metronome: false,
            loop_region: LoopRegion {
                enabled: false,
                start: 0,
                end: 0,
            },
            tracks: vec![Track {
                id: 2,
                name: "Vocals".into(),
                color: "#ff9f0a".into(),
                gain: 1.0,
                pan: 0.0,
                mute: false,
                solo: false,
                clips: vec![Clip {
                    id: 3,
                    source_id: 1,
                    name: "take".into(),
                    start: 48_000,
                    offset: 0,
                    length: 96_000,
                    gain: 1.0,
                    fade_in: 0,
                    fade_out: 480,
                }],
            }],
            sources: vec![Source {
                id: 1,
                name: "take.wav".into(),
                file: "audio/1-take.wav".into(),
                frames: 96_000,
                channels: 2,
                original_sample_rate: 44_100,
            }],
            next_id: 4,
            created_at: "2026-11-01T00:00:00Z".into(),
            modified_at: "2026-11-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn save_load_round_trip_with_camel_case_keys() {
        let project = sample();
        let json = save(&project);
        assert!(
            json.contains("\"schemaVersion\": 1")
                && json.contains("\"fadeOut\": 480")
                && json.contains("\"loop\"")
        );
        assert_eq!(load(&json).unwrap(), project);
        assert!(project.validate().is_empty(), "{:?}", project.validate());
    }

    #[test]
    fn rejects_newer_missing_and_garbage_versions() {
        let mut v = serde_json::to_value(sample()).unwrap();
        v["schemaVersion"] = Value::from(SCHEMA_VERSION + 1);
        assert_eq!(
            load(&v.to_string()),
            Err(ProjectError::TooNew {
                version: SCHEMA_VERSION + 1
            })
        );
        v.as_object_mut().unwrap().remove("schemaVersion");
        assert!(matches!(
            load(&v.to_string()),
            Err(ProjectError::Invalid(_))
        ));
        assert!(matches!(load("not json"), Err(ProjectError::Invalid(_))));
        assert!(matches!(
            load(r#"{"schemaVersion": 1}"#),
            Err(ProjectError::Invalid(_))
        ));
    }

    #[test]
    fn migrations_run_in_order_up_to_current() {
        // Pretend v1 named the field "title" and v2 renamed it "name"; v3 added "metronome".
        fn v1_to_v2(v: &mut Value) -> Result<(), String> {
            let title = v
                .as_object_mut()
                .unwrap()
                .remove("title")
                .ok_or("missing title")?;
            v["name"] = title;
            Ok(())
        }
        fn v2_to_v3(v: &mut Value) -> Result<(), String> {
            v["metronome"] = Value::Bool(true);
            Ok(())
        }
        let mut old = serde_json::to_value(sample()).unwrap();
        let obj = old.as_object_mut().unwrap();
        let name = obj.remove("name").unwrap();
        obj.remove("metronome");
        obj.insert("title".into(), name);
        obj.insert("schemaVersion".into(), Value::from(1));

        let migrated = load_value(old.clone(), &[v1_to_v2, v2_to_v3], 3).unwrap();
        assert_eq!(migrated.name, "Demo");
        assert!(migrated.metronome);
        assert_eq!(migrated.schema_version, 3);

        // A failing migration reports which version it started from.
        fn broken(_: &mut Value) -> Result<(), String> {
            Err("boom".into())
        }
        let err = load_value(old, &[broken], 2).unwrap_err();
        assert!(err.to_string().contains("schema 1: boom"), "{err}");
    }

    #[test]
    fn validate_reports_inconsistencies() {
        let mut p = sample();
        p.tracks[0].clips[0].source_id = 99;
        p.tracks[0].id = 1; // collides with the source
        p.next_id = 2;
        let issues = p.validate();
        assert!(issues.iter().any(|i| i.contains("missing source 99")));
        assert!(issues.iter().any(|i| i.contains("duplicate id 1")));
        assert!(issues.iter().any(|i| i.contains("not below nextId")));

        let mut p = sample();
        p.tracks[0].clips[0].offset = 10;
        assert!(p.validate().iter().any(|i| i.contains("past the end")));
    }

    #[test]
    fn load_rejects_inconsistent_projects_with_all_issues() {
        let mut p = sample();
        p.tracks[0].clips[0].source_id = 99;
        p.tracks[0].id = 1; // collides with the source
        let err = load(&save(&p)).unwrap_err();
        let ProjectError::Inconsistent(issues) = &err else {
            panic!("{err:?}")
        };
        assert_eq!(issues.len(), 2, "{issues:?}");
        let message = err.to_string();
        assert!(
            message.contains("duplicate id 1") && message.contains("missing source 99"),
            "{message}"
        );
    }

    /// Exports constants next to the ts-rs bindings so TypeScript never hardcodes them.
    #[cfg(feature = "ts")]
    #[test]
    fn export_project_constants() {
        let dir = std::path::PathBuf::from(std::env::var("TS_RS_EXPORT_DIR").unwrap());
        let out = format!(
            "// This file was generated by the project crate. Do not edit this file manually.\n\n\
             export const SCHEMA_VERSION = {SCHEMA_VERSION};\n\
             export const PROJECT_SAMPLE_RATE = {PROJECT_SAMPLE_RATE};\n"
        );
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("projectConstants.ts"), out).unwrap();
    }
}
