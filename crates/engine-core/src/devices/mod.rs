//! Built-in audio effects ("devices") for track and master insert chains.
//!
//! Every device processes stereo audio in place and is described by a static parameter
//! table ([`DeviceKind::params`]), exported to TypeScript so the UI builds its controls from
//! the same source. Parameters are plain values in their natural unit (dB, Hz, ms, 0…1).
//!
//! Devices are created off the audio thread ([`create`]) because they allocate their delay
//! lines; after that, [`Device::set_param`] and [`Device::process`] are real-time safe.

mod chorus;
mod delay;
mod dsp;
mod dynamics;
mod eq;
mod reverb;
mod saturation;
mod utility;

pub use dsp::{Biquad, FilterType};

/// Most parameters any device has (the EQ's 8 bands × 5 + output).
pub const MAX_PARAMS: usize = 48;

/// What a device may read about the transport while processing.
#[derive(Debug, Clone, Copy)]
pub struct ProcessContext {
    pub tempo: f64,
}

/// A built-in effect. Created by [`create`]; real-time safe afterwards.
pub trait Device: Send {
    /// Sets parameter `index` (a plain value already clamped to its range). Takes effect
    /// from the next [`Device::process`] call, with whatever smoothing the device needs.
    fn set_param(&mut self, index: usize, value: f32);
    /// Processes `l` and `r` (same length, at most [`crate::BLOCK_FRAMES`]) in place.
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &ProcessContext);
    /// Clears internal state (tails, envelopes), e.g. after a seek.
    fn reset(&mut self);
    /// Current gain reduction in dB (≥ 0) for dynamics devices; 0 for everything else.
    fn gain_reduction(&self) -> f32 {
        0.0
    }
}

/// How a parameter maps to a control.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scale {
    Linear,
    /// Logarithmic (frequencies, times); `min` must be positive.
    Log,
    /// Integer choice among `options` (value = index).
    Choice(&'static [&'static str]),
    /// On/off (0 or 1).
    Toggle,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParamInfo {
    /// Stable id saved in projects (never rename).
    pub id: &'static str,
    pub name: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub unit: &'static str,
    pub scale: Scale,
}

impl ParamInfo {
    /// Clamps (and for choices and toggles, rounds) `value` into range; NaN gives the default.
    pub fn clamp(&self, value: f32) -> f32 {
        if !value.is_finite() {
            return self.default;
        }
        let v = value.clamp(self.min, self.max);
        match self.scale {
            Scale::Choice(_) | Scale::Toggle => v.round(),
            _ => v,
        }
    }
}

const fn p(
    id: &'static str,
    name: &'static str,
    min: f32,
    max: f32,
    default: f32,
    unit: &'static str,
    scale: Scale,
) -> ParamInfo {
    ParamInfo {
        id,
        name,
        min,
        max,
        default,
        unit,
        scale,
    }
}

const LIN: Scale = Scale::Linear;
const LOG: Scale = Scale::Log;
const TOGGLE: Scale = Scale::Toggle;

macro_rules! kinds {
    ($($variant:ident = $code:literal, $id:literal, $name:literal;)*) => {
        /// The built-in device types. The numeric code is used by the engine protocol; the
        /// string id is saved in projects.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum DeviceKind { $($variant = $code),* }

        impl DeviceKind {
            pub const ALL: &'static [DeviceKind] = &[$(DeviceKind::$variant),*];

            pub fn from_code(code: u32) -> Option<Self> {
                match code { $($code => Some(DeviceKind::$variant),)* _ => None }
            }

            pub fn code(self) -> u32 {
                self as u32
            }

            pub fn id(self) -> &'static str {
                match self { $(DeviceKind::$variant => $id),* }
            }

            pub fn name(self) -> &'static str {
                match self { $(DeviceKind::$variant => $name),* }
            }
        }
    };
}

kinds! {
    Utility = 0, "utility", "Utility";
    Eq = 1, "eq", "EQ";
    Compressor = 2, "compressor", "Compressor";
    Gate = 3, "gate", "Gate";
    Limiter = 4, "limiter", "Limiter";
    Delay = 5, "delay", "Delay";
    Reverb = 6, "reverb", "Reverb";
    Chorus = 7, "chorus", "Chorus";
    Saturation = 8, "saturation", "Saturation";
}

impl DeviceKind {
    pub fn params(self) -> &'static [ParamInfo] {
        match self {
            DeviceKind::Utility => utility::PARAMS,
            DeviceKind::Eq => &eq::PARAMS,
            DeviceKind::Compressor => dynamics::COMPRESSOR_PARAMS,
            DeviceKind::Gate => dynamics::GATE_PARAMS,
            DeviceKind::Limiter => dynamics::LIMITER_PARAMS,
            DeviceKind::Delay => delay::PARAMS,
            DeviceKind::Reverb => reverb::PARAMS,
            DeviceKind::Chorus => chorus::PARAMS,
            DeviceKind::Saturation => saturation::PARAMS,
        }
    }

    /// Default value of every parameter, padded to [`MAX_PARAMS`].
    pub fn defaults(self) -> [f32; MAX_PARAMS] {
        let mut out = [0.0; MAX_PARAMS];
        for (o, p) in out.iter_mut().zip(self.params()) {
            *o = p.default;
        }
        out
    }
}

/// Creates a device at `sample_rate` with default parameters. Allocates: call off the audio
/// thread.
pub fn create(kind: DeviceKind, sample_rate: f64) -> Box<dyn Device> {
    let mut device: Box<dyn Device> = match kind {
        DeviceKind::Utility => Box::new(utility::Utility::new(sample_rate)),
        DeviceKind::Eq => Box::new(eq::Eq::new(sample_rate)),
        DeviceKind::Compressor => Box::new(dynamics::Compressor::new(sample_rate)),
        DeviceKind::Gate => Box::new(dynamics::Gate::new(sample_rate)),
        DeviceKind::Limiter => Box::new(dynamics::Limiter::new(sample_rate)),
        DeviceKind::Delay => Box::new(delay::Delay::new(sample_rate)),
        DeviceKind::Reverb => Box::new(reverb::Reverb::new(sample_rate)),
        DeviceKind::Chorus => Box::new(chorus::Chorus::new(sample_rate)),
        DeviceKind::Saturation => Box::new(saturation::Saturation::new(sample_rate)),
    };
    for (i, p) in kind.params().iter().enumerate() {
        device.set_param(i, p.default);
    }
    device
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_tables_are_consistent() {
        for &kind in DeviceKind::ALL {
            assert_eq!(DeviceKind::from_code(kind.code()), Some(kind));
            let params = kind.params();
            assert!(params.len() <= MAX_PARAMS, "{kind:?}");
            for (i, p) in params.iter().enumerate() {
                assert!(p.min < p.max, "{kind:?}.{}", p.id);
                assert!((p.min..=p.max).contains(&p.default), "{kind:?}.{}", p.id);
                if p.scale == Scale::Log {
                    assert!(p.min > 0.0, "{kind:?}.{}", p.id);
                }
                if let Scale::Choice(options) = p.scale {
                    assert_eq!(p.min, 0.0);
                    assert_eq!(p.max as usize, options.len() - 1, "{kind:?}.{}", p.id);
                }
                assert!(
                    params[..i].iter().all(|q| q.id != p.id),
                    "duplicate {kind:?}.{}",
                    p.id
                );
            }
        }
    }

    /// Every device, at default and extreme settings, stays finite and quiet on silence.
    #[test]
    fn devices_are_stable_at_extremes() {
        let ctx = ProcessContext { tempo: 120.0 };
        for &kind in DeviceKind::ALL {
            for setting in [0, 1, 2] {
                let mut d = create(kind, 48_000.0);
                for (i, p) in kind.params().iter().enumerate() {
                    let v = match setting {
                        0 => p.default,
                        1 => p.min,
                        _ => p.max,
                    };
                    d.set_param(i, v);
                }
                let mut l = vec![0.0f32; 256];
                let mut r = vec![0.0f32; 256];
                for block in 0..400 {
                    for i in 0..256 {
                        let t = (block * 256 + i) as f32 / 48_000.0;
                        let on = block < 200;
                        l[i] = if on { (t * 2400.0).sin() * 0.9 } else { 0.0 };
                        r[i] = if on { (t * 1700.0).sin() * 0.9 } else { 0.0 };
                    }
                    d.process(&mut l, &mut r, &ctx);
                    assert!(
                        l.iter().chain(&r).all(|s| s.is_finite() && s.abs() < 64.0),
                        "{kind:?} setting {setting} block {block}"
                    );
                }
            }
        }
    }

    #[cfg(feature = "ts")]
    #[test]
    fn export_device_catalog() {
        use std::fmt::Write;
        let dir = std::path::PathBuf::from(
            std::env::var("TS_RS_EXPORT_DIR")
                .expect("TS_RS_EXPORT_DIR is set in .cargo/config.toml"),
        );
        let mut out = String::from(
            "// This file was generated by engine-core (devices/mod.rs). Do not edit this file manually.\n\n",
        );
        out.push_str(
            "export type ParamScale = \"linear\" | \"log\" | \"choice\" | \"toggle\";\n\n\
             export interface ParamInfo {\n  readonly id: string;\n  readonly name: string;\n  \
             readonly min: number;\n  readonly max: number;\n  readonly default: number;\n  \
             readonly unit: string;\n  readonly scale: ParamScale;\n  \
             readonly options?: readonly string[];\n}\n\n\
             export interface DeviceInfo {\n  readonly code: number;\n  readonly name: string;\n  \
             readonly params: readonly ParamInfo[];\n}\n\n",
        );
        writeln!(out, "export const MAX_DEVICE_PARAMS = {MAX_PARAMS};\n").unwrap();
        out.push_str("export const DEVICES = {\n");
        for &kind in DeviceKind::ALL {
            writeln!(
                out,
                "  {}: {{\n    code: {},\n    name: \"{}\",\n    params: [",
                kind.id(),
                kind.code(),
                kind.name()
            )
            .unwrap();
            for p in kind.params() {
                let (scale, options) = match p.scale {
                    Scale::Linear => ("linear", String::new()),
                    Scale::Log => ("log", String::new()),
                    Scale::Toggle => ("toggle", String::new()),
                    Scale::Choice(o) => (
                        "choice",
                        format!(
                            ", options: [{}]",
                            o.iter()
                                .map(|s| format!("\"{s}\""))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    ),
                };
                writeln!(
                    out,
                    "      {{ id: \"{}\", name: \"{}\", min: {}, max: {}, default: {}, unit: \"{}\", scale: \"{scale}\"{options} }},",
                    p.id,
                    p.name,
                    p.min,
                    p.max,
                    p.default,
                    p.unit
                )
                .unwrap();
            }
            out.push_str("    ],\n  },\n");
        }
        out.push_str("} as const satisfies Record<string, DeviceInfo>;\n\n");
        out.push_str("export type DeviceKind = keyof typeof DEVICES;\n");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("devices.ts"), out).unwrap();
    }
}
