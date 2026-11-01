//! Automation envelopes: breakpoints with linear ramps, evaluated per sample.

/// What an automation lane controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutomationTarget {
    /// Track fader (linear gain, 0…4).
    Volume,
    /// Track pan (−1…1).
    Pan,
    /// Send level (linear gain) of send `index`.
    Send(u32),
    /// Parameter `param` of device `device` (plain value).
    Param { device: u32, param: u32 },
}

impl AutomationTarget {
    /// Decodes the `(kind, index, device)` triple used by the WASM ABI and Tauri IPC:
    /// kind 0 = volume, 1 = pan, 2 = send `index`, 3 = parameter `index` of `device`.
    pub fn from_parts(kind: u32, index: u32, device: u32) -> Option<Self> {
        match kind {
            0 => Some(AutomationTarget::Volume),
            1 => Some(AutomationTarget::Pan),
            2 => Some(AutomationTarget::Send(index)),
            3 => Some(AutomationTarget::Param {
                device,
                param: index,
            }),
            _ => None,
        }
    }
}

/// Breakpoints `(frame, value)` sorted by frame, at the engine's sample rate. The value is
/// held before the first and after the last point, and ramps linearly in between.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    frames: Vec<u64>,
    values: Vec<f32>,
}

impl Envelope {
    /// Builds an envelope from points in any order. Non-finite values are dropped; of several
    /// points at the same frame the last one given wins. Allocates.
    pub fn new(points: impl IntoIterator<Item = (u64, f32)>) -> Self {
        let mut pts: Vec<(u64, f32)> = points.into_iter().filter(|p| p.1.is_finite()).collect();
        pts.sort_by_key(|p| p.0);
        let mut frames: Vec<u64> = Vec::with_capacity(pts.len());
        let mut values: Vec<f32> = Vec::with_capacity(pts.len());
        for (f, v) in pts {
            if frames.last() == Some(&f) {
                *values.last_mut().unwrap() = v;
            } else {
                frames.push(f);
                values.push(v);
            }
        }
        Self { frames, values }
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// Value at `frame` (binary search).
    pub fn value_at(&self, frame: u64) -> f32 {
        let i = self.frames.partition_point(|&f| f <= frame);
        self.interpolate(i, frame)
    }

    /// Value at `frame`, where `i` is the number of points at or before it.
    #[inline]
    fn interpolate(&self, i: usize, frame: u64) -> f32 {
        match i {
            0 => self.values.first().copied().unwrap_or(0.0),
            i if i >= self.frames.len() => self.values[self.frames.len() - 1],
            i => {
                let (f0, f1) = (self.frames[i - 1], self.frames[i]);
                let (v0, v1) = (self.values[i - 1], self.values[i]);
                let t = (frame - f0) as f64 / (f1 - f0) as f64;
                (f64::from(v0) + (f64::from(v1) - f64::from(v0)) * t) as f32
            }
        }
    }
}

/// Sequential reader of an envelope: amortized O(1) per sample while frames increase,
/// falling back to a binary search after jumps (seeks, loops).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Cursor {
    /// Number of points at or before the last frame read.
    index: usize,
    last: Option<u64>,
}

impl Cursor {
    #[inline]
    pub fn value(&mut self, env: &Envelope, frame: u64) -> f32 {
        let sequential = self.last.is_some_and(|l| frame >= l);
        if sequential {
            while self.index < env.frames.len() && env.frames[self.index] <= frame {
                self.index += 1;
            }
        } else {
            self.index = env.frames.partition_point(|&f| f <= frame);
        }
        self.last = Some(frame);
        env.interpolate(self.index, frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_outside_and_ramps_linearly_between_points() {
        let env = Envelope::new([(100, 1.0), (0, 0.0), (200, 1.0), (300, 0.5)]);
        assert_eq!(env.value_at(0), 0.0);
        assert_eq!(env.value_at(50), 0.5);
        assert_eq!(env.value_at(150), 1.0);
        assert_eq!(env.value_at(250), 0.75);
        assert_eq!(env.value_at(10_000), 0.5);
        let single = Envelope::new([(500, 0.3)]);
        assert_eq!(single.value_at(0), 0.3);
        assert_eq!(single.value_at(900), 0.3);
    }

    #[test]
    fn cursor_matches_random_access_across_jumps() {
        let env = Envelope::new((0..50).map(|i| (i * 97, ((i * 7) % 11) as f32)));
        let mut cursor = Cursor::default();
        let frames = (0..3000).chain(1000..2000).chain([4000, 10, 11, 12]);
        for f in frames {
            assert_eq!(cursor.value(&env, f), env.value_at(f), "frame {f}");
        }
    }

    #[test]
    fn duplicate_frames_keep_the_last_value() {
        let env = Envelope::new([(10, 1.0), (10, 2.0), (20, f32::NAN)]);
        assert_eq!(env.len(), 1);
        assert_eq!(env.value_at(10), 2.0);
    }
}
