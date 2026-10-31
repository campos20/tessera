//! UI ↔ engine message protocol, shared by both editions.
//!
//! Every message has two encodings:
//! - **JSON** (serde, `type`-tagged, camelCase fields): Tauri IPC and debugging.
//! - **Raw** ([`RawMessage`]: an opcode plus up to [`MAX_ARGS`] `f64` arguments): the web
//!   edition's SharedArrayBuffer rings and the WASM ABI.
//!
//! Both come from the single definition in the `protocol!` invocations below. The TypeScript
//! types and the raw field layout table are generated from them (`pnpm gen:schema`); never
//! hand-edit `packages/schema/src/generated`.

/// Largest number of fields in any message.
pub const MAX_ARGS: usize = 9;

/// Fixed-size binary form of a [`Command`] or [`Event`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RawMessage {
    pub op: u32,
    pub args: [f64; MAX_ARGS],
}

/// A field type that fits in one `f64` argument. Integers are exact up to 2^53.
pub trait Arg: Copy {
    /// `"bool"` or `"number"`: how TypeScript should decode the argument.
    const KIND: &'static str;
    fn to_arg(self) -> f64;
    fn from_arg(value: f64) -> Self;
}

macro_rules! impl_numeric_arg {
    ($($ty:ty),*) => {$(
        impl Arg for $ty {
            const KIND: &'static str = "number";
            fn to_arg(self) -> f64 {
                self as f64
            }
            // `as` saturates and maps NaN to 0, so decoding never panics.
            fn from_arg(value: f64) -> Self {
                value as $ty
            }
        }
    )*};
}
impl_numeric_arg!(u32, u64, f32, f64);

impl Arg for bool {
    const KIND: &'static str = "bool";
    fn to_arg(self) -> f64 {
        if self { 1.0 } else { 0.0 }
    }
    fn from_arg(value: f64) -> Self {
        value != 0.0
    }
}

/// One entry of the raw layout table: `(variant, opcode, [(field, kind)])`.
pub type LayoutEntry = (&'static str, u32, &'static [(&'static str, &'static str)]);

macro_rules! protocol {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $(
                $(#[$vmeta:meta])*
                $variant:ident $({ $( $(#[$fmeta:meta])* $field:ident : $ty:ty ),* $(,)? })? = $op:literal
            ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq)]
        #[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
        #[cfg_attr(feature = "serde", serde(tag = "type", rename_all_fields = "camelCase"))]
        #[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
        pub enum $name {
            $(
                $(#[$vmeta])*
                $variant $({ $( $(#[$fmeta])* $field: $ty ),* })?
            ),*
        }

        impl $name {
            /// Raw encoding layout, in argument order. Exported to TypeScript.
            pub const LAYOUT: &'static [LayoutEntry] = &[
                $( (stringify!($variant), $op, &[ $($( (stringify!($field), <$ty as Arg>::KIND) ),*)? ]) ),*
            ];

            #[allow(unused_mut, unused_assignments, unused_variables)]
            pub fn to_raw(&self) -> RawMessage {
                match *self {
                    $(
                        $name::$variant $({ $($field),* })? => {
                            let mut args = [0.0; MAX_ARGS];
                            let mut i = 0;
                            $($( args[i] = Arg::to_arg($field); i += 1; )*)?
                            RawMessage { op: $op, args }
                        }
                    ),*
                }
            }

            /// Decodes a raw message; `None` for unknown opcodes. Never panics.
            #[allow(unused_mut, unused_assignments, unused_variables)]
            pub fn from_raw(raw: &RawMessage) -> Option<Self> {
                match raw.op {
                    $(
                        // Struct expression fields are evaluated in the order written.
                        $op => {
                            let mut i = 0;
                            Some($name::$variant $({ $(
                                $field: {
                                    let value = <$ty as Arg>::from_arg(raw.args[i]);
                                    i += 1;
                                    value
                                }
                            ),* })?)
                        }
                    ),*
                    _ => None,
                }
            }
        }
    };
}

protocol! {
    /// UI → engine. Positions and lengths are in frames at the engine's sample rate; ids are
    /// assigned by the UI.
    pub enum Command {
        Play = 0,
        /// Stops with a short fade; the position stays where playback ended.
        Stop = 1,
        Seek { frame: u64 } = 2,
        SetLoop { enabled: bool, start: u64, end: u64 } = 3,
        SetTempo { bpm: f64 } = 4,
        SetMetronome { enabled: bool, gain: f32, beats_per_bar: u32 } = 5,
        SetMasterGain { gain: f32 } = 6,
        AddTrack { track: u32 } = 7,
        /// Also removes the track's clips.
        RemoveTrack { track: u32 } = 8,
        SetTrackGain { track: u32, gain: f32 } = 9,
        /// −1 (left) … 1 (right). Balance law with unity gain at the center.
        SetTrackPan { track: u32, pan: f32 } = 10,
        SetTrackMute { track: u32, mute: bool } = 11,
        SetTrackSolo { track: u32, solo: bool } = 12,
        /// Adds or updates a clip. Plays `length` frames of `source` starting at `offset`,
        /// placed at timeline frame `start`, with linear fades.
        SetClip {
            clip: u32,
            track: u32,
            source: u32,
            start: u64,
            offset: u64,
            length: u64,
            gain: f32,
            fade_in: u64,
            fade_out: u64,
        } = 13,
        RemoveClip { clip: u32 } = 14,
        /// Releases a source's audio. Clips that use it go silent.
        RemoveSource { source: u32 } = 15,
    }
}

protocol! {
    /// Engine → UI. Meter values are linear amplitudes over the last meter interval (~33 ms).
    pub enum Event {
        Transport { playing: bool, position: u64 } = 0,
        TrackMeter { track: u32, peak_l: f32, peak_r: f32, rms_l: f32, rms_r: f32 } = 1,
        MasterMeter { peak_l: f32, peak_r: f32, rms_l: f32, rms_r: f32 } = 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_commands() -> Vec<Command> {
        vec![
            Command::Play,
            Command::Stop,
            Command::Seek {
                frame: 123_456_789_012,
            },
            Command::SetLoop {
                enabled: true,
                start: 10,
                end: 20,
            },
            Command::SetTempo { bpm: 128.5 },
            Command::SetMetronome {
                enabled: true,
                gain: 0.5,
                beats_per_bar: 3,
            },
            Command::SetMasterGain { gain: 0.75 },
            Command::AddTrack { track: 1 },
            Command::RemoveTrack { track: 2 },
            Command::SetTrackGain {
                track: 3,
                gain: 0.25,
            },
            Command::SetTrackPan {
                track: 4,
                pan: -0.5,
            },
            Command::SetTrackMute {
                track: 5,
                mute: true,
            },
            Command::SetTrackSolo {
                track: 6,
                solo: true,
            },
            Command::SetClip {
                clip: 1,
                track: 2,
                source: 3,
                start: 4,
                offset: 5,
                length: 6,
                gain: 0.5,
                fade_in: 8,
                fade_out: 9,
            },
            Command::RemoveClip { clip: 7 },
            Command::RemoveSource { source: 8 },
        ]
    }

    #[test]
    fn raw_round_trip() {
        let commands = all_commands();
        assert_eq!(
            commands.len(),
            Command::LAYOUT.len(),
            "test covers every command"
        );
        for cmd in commands {
            assert_eq!(Command::from_raw(&cmd.to_raw()), Some(cmd));
        }
        let event = Event::TrackMeter {
            track: 1,
            peak_l: 0.5,
            peak_r: 0.25,
            rms_l: 0.125,
            rms_r: 0.0625,
        };
        assert_eq!(Event::from_raw(&event.to_raw()), Some(event));
        assert_eq!(
            Command::from_raw(&RawMessage {
                op: 999,
                args: [0.0; MAX_ARGS]
            }),
            None
        );
    }

    #[test]
    fn layouts_fit_and_opcodes_are_unique() {
        for layout in [Command::LAYOUT, Event::LAYOUT] {
            let mut ops: Vec<u32> = layout.iter().map(|(_, op, _)| *op).collect();
            ops.sort();
            ops.dedup();
            assert_eq!(ops.len(), layout.len());
            assert!(layout.iter().all(|(_, _, fields)| fields.len() <= MAX_ARGS));
        }
    }

    #[test]
    fn decoding_garbage_does_not_panic() {
        for op in 0..20 {
            let raw = RawMessage {
                op,
                args: [
                    f64::NAN,
                    -1.0,
                    1e300,
                    f64::INFINITY,
                    0.5,
                    0.0,
                    1.0,
                    2.0,
                    3.0,
                ],
            };
            let _ = Command::from_raw(&raw);
            let _ = Event::from_raw(&raw);
        }
    }

    /// The layout table must list fields in the same order `to_raw` writes them, under the
    /// names JSON uses. Checked through serde so a mismatch can't hide.
    #[cfg(feature = "serde")]
    #[test]
    fn layout_matches_json_field_order() {
        for cmd in all_commands() {
            let raw = cmd.to_raw();
            let json = serde_json::to_value(cmd).unwrap();
            let name = json["type"].as_str().unwrap();
            let (_, op, fields) = Command::LAYOUT.iter().find(|(n, _, _)| *n == name).unwrap();
            assert_eq!(*op, raw.op);
            for (i, (field, kind)) in fields.iter().enumerate() {
                let value = &json[camel_case(field)];
                let expected = match *kind {
                    "bool" => f64::from(u8::from(value.as_bool().unwrap())),
                    _ => value.as_f64().unwrap(),
                };
                assert_eq!(raw.args[i], expected, "{name}.{field}");
            }
        }
    }

    #[cfg(feature = "serde")]
    #[test]
    fn json_shape() {
        let cmd: Command =
            serde_json::from_str(r#"{"type":"SetTrackPan","track":2,"pan":-1}"#).unwrap();
        assert_eq!(
            cmd,
            Command::SetTrackPan {
                track: 2,
                pan: -1.0
            }
        );
        let event = serde_json::to_string(&Event::Transport {
            playing: true,
            position: 48_000,
        })
        .unwrap();
        assert_eq!(
            event,
            r#"{"type":"Transport","playing":true,"position":48000}"#
        );
    }

    #[cfg(any(feature = "serde", feature = "ts"))]
    pub(crate) fn camel_case(snake: &str) -> String {
        let mut out = String::new();
        let mut upper = false;
        for c in snake.chars() {
            if c == '_' {
                upper = true;
            } else if upper {
                out.extend(c.to_uppercase());
                upper = false;
            } else {
                out.push(c);
            }
        }
        out
    }

    /// Writes the raw layout table next to the ts-rs bindings so TypeScript never
    /// hardcodes opcodes or field order.
    #[cfg(feature = "ts")]
    #[test]
    fn export_protocol_layout() {
        use std::fmt::Write;
        let dir = std::path::PathBuf::from(
            std::env::var("TS_RS_EXPORT_DIR")
                .expect("TS_RS_EXPORT_DIR is set in .cargo/config.toml"),
        );
        let mut out = String::from(
            "// This file was generated by engine-core (protocol.rs). Do not edit this file manually.\n\n",
        );
        writeln!(out, "export const MAX_ARGS = {MAX_ARGS};\n").unwrap();
        writeln!(out, "export type FieldKind = \"bool\" | \"number\";\n").unwrap();
        writeln!(
            out,
            "export interface MessageLayout {{\n  readonly op: number;\n  readonly fields: readonly (readonly [name: string, kind: FieldKind])[];\n}}\n"
        )
        .unwrap();
        for (name, layout) in [
            ("CommandLayout", Command::LAYOUT),
            ("EventLayout", Event::LAYOUT),
        ] {
            writeln!(out, "export const {name} = {{").unwrap();
            for (variant, op, fields) in layout {
                let fields: Vec<String> = fields
                    .iter()
                    .map(|(f, k)| format!("[\"{}\", \"{k}\"]", camel_case(f)))
                    .collect();
                writeln!(
                    out,
                    "  {variant}: {{ op: {op}, fields: [{}] }},",
                    fields.join(", ")
                )
                .unwrap();
            }
            writeln!(
                out,
                "}} as const satisfies Record<string, MessageLayout>;\n"
            )
            .unwrap();
        }
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("protocolLayout.ts"), out).unwrap();
        let _ = std::fs::remove_file(dir.join("Opcode.ts"));
    }
}
