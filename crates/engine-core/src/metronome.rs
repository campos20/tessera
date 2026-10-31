use crate::SineOsc;

const CLICK_SECONDS: f64 = 0.03;
const DOWNBEAT_HZ: f32 = 1500.0;
const BEAT_HZ: f32 = 1000.0;

/// Sample-accurate click on every beat at a constant tempo. Stateless with respect to the
/// transport, so seeks and loops need no bookkeeping. Real-time safe.
pub(crate) struct Metronome {
    pub enabled: bool,
    pub gain: f32,
    pub beats_per_bar: u32,
    osc: SineOsc,
    env: f32,
    decay: f32,
    remaining: usize,
    click_frames: usize,
}

impl Metronome {
    pub fn new(sample_rate: f64) -> Self {
        let click_frames = (CLICK_SECONDS * sample_rate) as usize;
        Self {
            enabled: false,
            gain: 0.5,
            beats_per_bar: 4,
            osc: SineOsc::new(sample_rate as f32, BEAT_HZ),
            env: 0.0,
            // Decays to -60 dB over the click.
            decay: (-6.9 / click_frames.max(1) as f32).exp(),
            remaining: 0,
            click_frames,
        }
    }

    /// Adds clicks for timeline frames `[position, position + left.len())`.
    pub fn render(
        &mut self,
        position: u64,
        bpm: f64,
        sample_rate: f64,
        left: &mut [f32],
        right: &mut [f32],
    ) {
        if !(bpm.is_finite() && bpm > 0.0) {
            return;
        }
        let frames_per_beat = 60.0 * sample_rate / bpm;
        for (i, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
            let t = position + i as u64;
            if self.enabled {
                let beat = (t as f64 / frames_per_beat).round();
                if (beat * frames_per_beat).round() as u64 == t {
                    let downbeat = self.beats_per_bar > 0
                        && (beat as u64).is_multiple_of(u64::from(self.beats_per_bar));
                    self.osc = SineOsc::new(
                        sample_rate as f32,
                        if downbeat { DOWNBEAT_HZ } else { BEAT_HZ },
                    );
                    self.env = 1.0;
                    self.remaining = self.click_frames;
                }
            }
            if self.remaining > 0 {
                let s = self.osc.next_sample() * self.env * self.gain;
                self.env *= self.decay;
                self.remaining -= 1;
                *l += s;
                *r += s;
            }
        }
    }
}
