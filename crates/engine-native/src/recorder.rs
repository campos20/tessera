//! Writes captured input to WAV files on a background thread, one file per take.

use std::fs::File;
use std::io::{BufWriter, Seek, Write};
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
    writer: WavWriter<Box<dyn TakeFile>>,
    /// Peak accumulator for the current progress bucket.
    bucket: (f32, f32, usize),
    pending_peaks: Vec<f32>,
}

/// Anything a take can be streamed to (a file; an in-memory stand-in in tests).
pub(crate) trait TakeFile: Write + Seek + Send {}
impl<T: Write + Seek + Send> TakeFile for T {}

/// Creates the file for a take, given its name.
pub(crate) type Opener = Box<dyn FnMut(&str) -> std::io::Result<Box<dyn TakeFile>> + Send>;

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
        let opener: Opener = Box::new(move |name| {
            Ok(Box::new(BufWriter::new(File::create(dir.join(name))?)) as Box<dyn TakeFile>)
        });
        Self::start_with(capture, opener, prefix, sample_rate)
    }

    pub(crate) fn start_with(
        capture: Consumer<CaptureChunk>,
        opener: Opener,
        prefix: String,
        sample_rate: u32,
    ) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let (progress_tx, progress) = mpsc::channel();
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("tessera-recorder".into())
            .spawn(move || {
                run(
                    capture,
                    opener,
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

    /// Drains what's left, finalizes every file and returns the capture queue for reuse. If a
    /// write failed, every take is still finalized (valid WAV headers) before the first error
    /// is returned.
    pub fn finish(self) -> (Consumer<CaptureChunk>, std::io::Result<Vec<RecordedTake>>) {
        self.stop.store(true, Ordering::Release);
        self.thread.join().expect("recorder thread panicked")
    }
}

fn run(
    mut capture: Consumer<CaptureChunk>,
    mut opener: Opener,
    prefix: String,
    sample_rate: u32,
    stop: &AtomicBool,
    progress: &mpsc::Sender<TakeProgress>,
) -> (Consumer<CaptureChunk>, std::io::Result<Vec<RecordedTake>>) {
    let mut open: Vec<OpenTake> = Vec::new();
    let mut done: Vec<RecordedTake> = Vec::new();
    let mut count = 0usize;
    let mut last_progress = Instant::now();
    // The first failure. After it nothing more is written, but the capture queue keeps being
    // drained (so the engine doesn't overrun) and every take is still finalized below.
    let mut error: Option<std::io::Error> = None;
    loop {
        let stopping = stop.load(Ordering::Acquire);
        while let Ok(chunk) = capture.pop() {
            if error.is_some() {
                continue;
            }
            if let Err(e) = write_chunk(
                &chunk,
                &mut open,
                &mut done,
                &mut opener,
                &prefix,
                sample_rate,
                &mut count,
            ) {
                error = Some(e);
            }
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
        match close(t) {
            Ok(take) => done.push(take),
            Err(e) => {
                error.get_or_insert(e);
            }
        }
    }
    (capture, error.map_or(Ok(done), Err))
}

fn write_chunk(
    chunk: &CaptureChunk,
    open: &mut Vec<OpenTake>,
    done: &mut Vec<RecordedTake>,
    opener: &mut Opener,
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
        let writer = WavWriter::new(opener(&file)?, chunk.channels as u16, sample_rate)?;
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

/// Patches the WAV header sizes (counting only frames that were written successfully).
fn close(t: OpenTake) -> std::io::Result<RecordedTake> {
    t.writer.finish()?;
    Ok(t.take)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::{CAPTURE_CHUNK_FRAMES, Command, Engine};
    use rtrb::RingBuffer;
    use std::io::{Cursor, SeekFrom};
    use std::sync::Mutex;

    type SharedFile = Arc<Mutex<Cursor<Vec<u8>>>>;

    /// An in-memory file shared with the test; writes of sample data fail after `limit` bytes
    /// (like a full disk), but header patches at the start of the file still succeed.
    struct FlakyFile {
        data: SharedFile,
        limit: u64,
    }

    impl Write for FlakyFile {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let mut data = self.data.lock().unwrap();
            if data.position() >= 44 && data.position() + buf.len() as u64 > self.limit {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::StorageFull,
                    "disk full",
                ));
            }
            data.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Seek for FlakyFile {
        fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
            self.data.lock().unwrap().seek(pos)
        }
    }

    fn chunk(track: u32, start: u64) -> CaptureChunk {
        CaptureChunk {
            track,
            start,
            frames: 256,
            channels: 1,
            data: [0.25; 2 * CAPTURE_CHUNK_FRAMES],
        }
    }

    #[test]
    fn finalizes_every_take_even_after_a_write_failure() {
        let (mut tx, rx) = RingBuffer::new(64);
        let files: Arc<Mutex<Vec<(String, SharedFile)>>> = Arc::default();
        let opened = files.clone();
        // Track 1's file fills up after two chunks; track 2's never does.
        let opener: Opener = Box::new(move |name| {
            let data = Arc::new(Mutex::new(Cursor::new(Vec::new())));
            opened
                .lock()
                .unwrap()
                .push((name.to_string(), data.clone()));
            let limit = if name.contains("-1-") {
                44 + 2 * 256 * 4
            } else {
                u64::MAX
            };
            Ok(Box::new(FlakyFile { data, limit }) as Box<dyn TakeFile>)
        });
        for i in 0..4 {
            tx.push(chunk(1, i * 256)).unwrap();
            tx.push(chunk(2, i * 256)).unwrap();
        }
        let recorder = TakeRecorder::start_with(rx, opener, "rec".into(), 48_000).unwrap();
        let (mut capture, result) = recorder.finish();
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::StorageFull);
        assert!(
            capture.pop().is_err(),
            "the queue is drained even after the failure"
        );

        // Chunks arrive 1, 2, 1, 2, 1 (fails): after the failure nothing more is written (a
        // full disk would fail every track), but both files get valid, patched headers covering
        // the two chunks each had written.
        let files = files.lock().unwrap();
        assert_eq!(files.len(), 2);
        for (name, data) in files.iter() {
            let bytes = data.lock().unwrap().get_ref().clone();
            let decoded =
                media::decode(bytes, Some("wav")).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(decoded.channels[0].len(), 2 * 256, "{name}");
        }
    }

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
