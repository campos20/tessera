//! Writes captured input to WAV files on a background thread, one file per take.

use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use engine_core::CaptureChunk;
use media::wav::WavWriter;
use rtrb::Consumer;
use serde::Serialize;

const POLL_INTERVAL: Duration = Duration::from_millis(10);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Frames per min/max pair in live progress (matches the import peak resolution).
const PROGRESS_PEAK_FRAMES: usize = media::PEAK_FRAMES as usize;

/// A finished take: a contiguous recording of one track.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct RecordedTake {
    pub track: u32,
    /// The WAV file's name inside the recording folder.
    pub file: String,
    /// Timeline frame (engine rate) of the first sample, before latency compensation.
    pub start: u64,
    pub frames: u64,
    pub channels: u32,
}

/// Live state of a take being recorded, for drawing it while it grows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TakeProgress {
    pub track: u32,
    pub start: u64,
    /// Frames recorded so far.
    pub frames: u64,
    /// New `[min, max]` pairs since the last progress report (all channels mixed).
    pub peaks: Vec<f32>,
}

struct OpenTake {
    take: RecordedTake,
    writer: WavWriter<BufWriter<File>>,
    /// Peak accumulator for the current progress bucket.
    bucket: (f32, f32, usize),
    pending_peaks: Vec<f32>,
}

pub struct TakeRecorder {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<(Consumer<CaptureChunk>, std::io::Result<Vec<RecordedTake>>)>,
    progress: mpsc::Receiver<TakeProgress>,
}

impl TakeRecorder {
    /// Takes are written to `dir` as `{prefix}-{track}-{n}.wav`; give each recording session a
    /// unique prefix so files never collide.
    pub fn start(
        capture: Consumer<CaptureChunk>,
        dir: PathBuf,
        prefix: String,
        sample_rate: u32,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let stop = Arc::new(AtomicBool::new(false));
        let (progress_tx, progress) = mpsc::channel();
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("tessera-recorder".into())
            .spawn(move || {
                run(
                    capture,
                    dir,
                    prefix,
                    sample_rate,
                    &thread_stop,
                    &progress_tx,
                )
            })?;
        Ok(Self {
            stop,
            thread,
            progress,
        })
    }

    pub fn poll_progress(&mut self) -> Vec<TakeProgress> {
        self.progress.try_iter().collect()
    }

    /// Drains what's left, finalizes every file and returns the capture queue for reuse.
    pub fn finish(self) -> (Consumer<CaptureChunk>, std::io::Result<Vec<RecordedTake>>) {
        self.stop.store(true, Ordering::Release);
        self.thread.join().expect("recorder thread panicked")
    }
}

fn run(
    mut capture: Consumer<CaptureChunk>,
    dir: PathBuf,
    prefix: String,
    sample_rate: u32,
    stop: &AtomicBool,
    progress: &mpsc::Sender<TakeProgress>,
) -> (Consumer<CaptureChunk>, std::io::Result<Vec<RecordedTake>>) {
    let mut open: Vec<OpenTake> = Vec::new();
    let mut done: Vec<RecordedTake> = Vec::new();
    let mut count = 0usize;
    let mut last_progress = Instant::now();
    let result = (|| -> std::io::Result<()> {
        loop {
            let stopping = stop.load(Ordering::Acquire);
            while let Ok(chunk) = capture.pop() {
                write_chunk(
                    &chunk,
                    &mut open,
                    &mut done,
                    &dir,
                    &prefix,
                    sample_rate,
                    &mut count,
                )?;
            }
            if stopping {
                break;
            }
            if last_progress.elapsed() >= PROGRESS_INTERVAL {
                last_progress = Instant::now();
                for t in &mut open {
                    let _ = progress.send(TakeProgress {
                        track: t.take.track,
                        start: t.take.start,
                        frames: t.take.frames,
                        peaks: std::mem::take(&mut t.pending_peaks),
                    });
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        }
        for t in open.drain(..) {
            done.push(close(t)?);
        }
        Ok(())
    })();
    (capture, result.map(|()| done))
}

fn write_chunk(
    chunk: &CaptureChunk,
    open: &mut Vec<OpenTake>,
    done: &mut Vec<RecordedTake>,
    dir: &std::path::Path,
    prefix: &str,
    sample_rate: u32,
    count: &mut usize,
) -> std::io::Result<()> {
    let samples = &chunk.data[..(chunk.frames * chunk.channels) as usize];
    let index = open.iter().position(|t| t.take.track == chunk.track);
    // A take ends when the capture jumps (loop pass, punch) or changes channel count.
    let continues = index.is_some_and(|i| {
        let t = &open[i].take;
        t.start + t.frames == chunk.start && t.channels == chunk.channels
    });
    if !continues {
        if let Some(i) = index {
            done.push(close(open.remove(i))?);
        }
        *count += 1;
        let file = format!("{prefix}-{}-{}.wav", chunk.track, count);
        let writer = WavWriter::new(
            BufWriter::new(File::create(dir.join(&file))?),
            chunk.channels as u16,
            sample_rate,
        )?;
        open.push(OpenTake {
            take: RecordedTake {
                track: chunk.track,
                file,
                start: chunk.start,
                frames: 0,
                channels: chunk.channels,
            },
            writer,
            bucket: (0.0, 0.0, 0),
            pending_peaks: Vec::new(),
        });
    }
    let t = open
        .iter_mut()
        .find(|t| t.take.track == chunk.track)
        .expect("just opened");
    t.writer.write(samples)?;
    t.take.frames += u64::from(chunk.frames);
    for frame in samples.chunks(chunk.channels as usize) {
        for &s in frame {
            t.bucket.0 = t.bucket.0.min(s);
            t.bucket.1 = t.bucket.1.max(s);
        }
        t.bucket.2 += 1;
        if t.bucket.2 == PROGRESS_PEAK_FRAMES {
            t.pending_peaks.extend([t.bucket.0, t.bucket.1]);
            t.bucket = (0.0, 0.0, 0);
        }
    }
    Ok(())
}

fn close(t: OpenTake) -> std::io::Result<RecordedTake> {
    t.writer.finish()?;
    Ok(t.take)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::{Command, Engine};

    #[test]
    fn writes_contiguous_runs_as_separate_wav_takes() {
        let dir = std::env::temp_dir().join(format!("tessera-recorder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (mut engine, mut ctl) = Engine::new(48_000.0);
        let capture = ctl.take_capture().unwrap();
        let recorder = TakeRecorder::start(capture, dir.clone(), "take".into(), 48_000).unwrap();
        for c in [
            Command::AddTrack { track: 7 },
            Command::SetTrackArm {
                track: 7,
                armed: true,
            },
            Command::SetLoop {
                enabled: true,
                start: 0,
                end: 1_000,
            },
            Command::SetRecord { enabled: true },
            Command::Play,
        ] {
            ctl.send(c).unwrap();
        }
        let input = vec![0.5f32; 1_500];
        let mut out = vec![0.0f32; 1_500 * 2];
        engine.process_io(&input, 1, &mut out, 2); // one full pass + half a pass
        let (_capture, takes) = recorder.finish();
        let takes = takes.unwrap();
        let shape: Vec<(u32, u64, u64)> =
            takes.iter().map(|t| (t.track, t.start, t.frames)).collect();
        assert_eq!(shape, vec![(7, 0, 1_000), (7, 0, 500)]);
        let bytes = std::fs::read(dir.join(&takes[0].file)).unwrap();
        let decoded = media::decode(bytes, Some("wav")).unwrap();
        assert_eq!(decoded.channels[0].len(), 1_000);
        assert!(decoded.channels[0].iter().all(|&s| s == 0.5));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
