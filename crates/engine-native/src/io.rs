use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, SupportedBufferSize};
use engine_core::{AudioBuffer, CaptureChunk, Command, Engine, EngineController, Event};
use rtrb::{Consumer, Producer, RingBuffer};
use serde::{Deserialize, Serialize};

use crate::recorder::{RecordedTake, TakeProgress, TakeRecorder};

/// Frames rendered per engine call when the driver hands us a larger buffer.
const MAX_BLOCK_FRAMES: usize = 4096;
/// Input → output bridge capacity, in seconds.
const BRIDGE_SECONDS: f64 = 0.5;

/// Which devices to open and how. `None` fields mean "the driver's default"; except
/// `input_device`, where `None` means no input ("default" picks the default input).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AudioConfig {
    /// Host (driver model) name as in [`crate::AudioHostInfo::name`].
    pub host: Option<String>,
    /// Device id as in [`crate::AudioDeviceInfo::id`].
    pub output_device: Option<String>,
    pub input_device: Option<String>,
    pub sample_rate: Option<u32>,
    /// Frames per callback. Ignored when the device doesn't support it.
    pub buffer_size: Option<u32>,
}

/// What was actually opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct AudioInfo {
    pub host: String,
    pub output_device: String,
    pub input_device: Option<String>,
    pub sample_rate: u32,
    pub output_channels: u16,
    pub input_channels: u16,
    /// Frames per callback when fixed; `None` when the driver chooses.
    pub buffer_size: Option<u32>,
    pub sample_format: String,
}

#[derive(Debug)]
pub enum AudioError {
    NoDevice(String),
    UnsupportedConfig(String),
    Backend(String),
}

impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AudioError::NoDevice(s) => write!(f, "audio device not found: {s}"),
            AudioError::UnsupportedConfig(s) => write!(f, "unsupported audio settings: {s}"),
            AudioError::Backend(s) => write!(f, "audio backend error: {s}"),
        }
    }
}

impl std::error::Error for AudioError {}

fn backend(e: impl std::fmt::Display) -> AudioError {
    AudioError::Backend(e.to_string())
}

/// Running audio streams driving an [`Engine`], with optional input and take recording.
///
/// The cpal streams live on a dedicated thread because they are not `Send` on every
/// platform; this handle is `Send` and talks to the engine only through its lock-free
/// queues. Dropping it stops the streams.
pub struct AudioIo {
    controller: EngineController,
    info: AudioInfo,
    xruns: Arc<AtomicU32>,
    capture: Option<Consumer<CaptureChunk>>,
    recorder: Option<TakeRecorder>,
    shutdown: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl AudioIo {
    /// Opens the default output (no input) of the default host.
    pub fn start_default() -> Result<Self, AudioError> {
        Self::start(&AudioConfig::default())
    }

    pub fn start(config: &AudioConfig) -> Result<Self, AudioError> {
        let config = config.clone();
        let xruns = Arc::new(AtomicU32::new(0));
        let thread_xruns = xruns.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("tessera-audio".into())
            .spawn(move || match open_streams(&config, thread_xruns) {
                Ok((streams, controller, info)) => {
                    let _ = ready_tx.send(Ok((controller, info)));
                    // Park until the handle is dropped, keeping the streams alive.
                    let _ = shutdown_rx.recv();
                    drop(streams);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(backend)?;
        let (mut controller, info) = ready_rx
            .recv()
            .map_err(|_| AudioError::Backend("audio thread exited during startup".into()))??;
        let capture = controller.take_capture();
        Ok(Self {
            controller,
            info,
            xruns,
            capture,
            recorder: None,
            shutdown: Some(shutdown_tx),
            thread: Some(thread),
        })
    }

    pub fn info(&self) -> &AudioInfo {
        &self.info
    }

    /// Queues a command for the audio thread. Returns it back if the queue is full.
    pub fn send(&mut self, command: Command) -> Result<(), Command> {
        self.controller.send(command)
    }

    /// See [`EngineController::set_automation`].
    pub fn set_automation(
        &mut self,
        lane: u32,
        track: u32,
        target: engine_core::automation::AutomationTarget,
        envelope: engine_core::automation::Envelope,
    ) -> bool {
        self.controller
            .set_automation(lane, track, target, envelope)
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        self.controller.poll_event()
    }

    /// Hands decoded audio (at [`AudioInfo::sample_rate`]) to the engine.
    pub fn add_source(
        &mut self,
        source: u32,
        buffer: Arc<AudioBuffer>,
    ) -> Result<(), Arc<AudioBuffer>> {
        self.controller.add_source(source, buffer)
    }

    /// Frees audio the engine has released. Call regularly (never from the audio thread).
    pub fn collect_garbage(&mut self) -> usize {
        self.controller.collect_garbage()
    }

    /// Dropouts since the streams started: driver-reported xruns plus input underruns.
    pub fn xruns(&self) -> u32 {
        self.xruns.load(Ordering::Relaxed)
    }

    /// Starts writing captured input to WAV files in `dir` named `{prefix}-{track}-{n}.wav`.
    /// Send `SetRecord` and `Play` afterwards; anything captured before this call is discarded.
    pub fn begin_recording(&mut self, dir: PathBuf, prefix: String) -> Result<(), String> {
        if self.recorder.is_some() {
            return Err("already recording".into());
        }
        let mut capture = self.capture.take().ok_or("capture queue unavailable")?;
        while capture.pop().is_ok() {}
        self.recorder = Some(
            TakeRecorder::start(capture, dir, prefix, self.info.sample_rate)
                .map_err(|e| e.to_string())?,
        );
        Ok(())
    }

    /// Finishes the takes (after `Stop`/`SetRecord false`) and returns them.
    pub fn end_recording(&mut self) -> Result<Vec<RecordedTake>, String> {
        let recorder = self.recorder.take().ok_or("not recording")?;
        let (capture, takes) = recorder.finish();
        self.capture = Some(capture);
        takes.map_err(|e| e.to_string())
    }

    /// Live waveform data for takes being recorded.
    pub fn poll_recording_progress(&mut self) -> Vec<TakeProgress> {
        self.recorder
            .as_mut()
            .map(TakeRecorder::poll_progress)
            .unwrap_or_default()
    }
}

impl Drop for AudioIo {
    fn drop(&mut self) {
        drop(self.shutdown.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn find_host(name: Option<&str>) -> Result<cpal::Host, AudioError> {
    let Some(name) = name else {
        return Ok(cpal::default_host());
    };
    let id = cpal::available_hosts()
        .into_iter()
        .find(|h| h.name() == name)
        .ok_or_else(|| AudioError::NoDevice(format!("host {name}")))?;
    cpal::host_from_id(id).map_err(backend)
}

fn find_device(host: &cpal::Host, id: &str) -> Result<cpal::Device, AudioError> {
    let parsed = id
        .parse()
        .map_err(|_| AudioError::NoDevice(id.to_string()))?;
    host.device_by_id(&parsed)
        .ok_or_else(|| AudioError::NoDevice(id.to_string()))
}

fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .or_else(|_| device.id().map(|id| id.to_string()))
        .unwrap_or_default()
}

/// The device's default config, at `rate` if requested and supported.
fn pick_config(
    default: cpal::SupportedStreamConfig,
    ranges: impl Iterator<Item = cpal::SupportedStreamConfigRange>,
    rate: Option<u32>,
) -> Result<cpal::SupportedStreamConfig, AudioError> {
    let Some(rate) = rate else { return Ok(default) };
    if default.sample_rate() == rate {
        return Ok(default);
    }
    let mut candidates: Vec<_> = ranges
        .filter_map(|r| r.try_with_sample_rate(rate))
        .collect();
    // Prefer the default's format and channel count, then f32.
    candidates.sort_by_key(|c| {
        (
            c.sample_format() != default.sample_format(),
            c.channels() != default.channels(),
            c.sample_format() != SampleFormat::F32,
        )
    });
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| AudioError::UnsupportedConfig(format!("{rate} Hz")))
}

fn buffer_size(supported: &SupportedBufferSize, requested: Option<u32>) -> cpal::BufferSize {
    match (requested, supported) {
        (Some(n), SupportedBufferSize::Range { min, max }) if (*min..=*max).contains(&n) => {
            cpal::BufferSize::Fixed(n)
        }
        _ => cpal::BufferSize::Default,
    }
}

type Streams = (cpal::Stream, Option<cpal::Stream>);

fn open_streams(
    config: &AudioConfig,
    xruns: Arc<AtomicU32>,
) -> Result<(Streams, EngineController, AudioInfo), AudioError> {
    let host = find_host(config.host.as_deref())?;
    let output = match &config.output_device {
        Some(id) => find_device(&host, id)?,
        None => host
            .default_output_device()
            .ok_or_else(|| AudioError::NoDevice("default output".into()))?,
    };
    let out_default = output.default_output_config().map_err(backend)?;
    let out_supported = pick_config(
        out_default,
        output.supported_output_configs().map_err(backend)?,
        config.sample_rate,
    )?;
    let format = out_supported.sample_format();
    let rate = out_supported.sample_rate();
    let mut out_config: cpal::StreamConfig = out_supported.into();
    out_config.buffer_size = buffer_size(out_supported.buffer_size(), config.buffer_size);

    // Optional input at the same rate.
    let input = match config.input_device.as_deref() {
        None => None,
        Some("default") => Some(
            host.default_input_device()
                .ok_or_else(|| AudioError::NoDevice("default input".into()))?,
        ),
        Some(id) => Some(find_device(&host, id)?),
    };
    let input_setup = match &input {
        None => None,
        Some(device) => {
            let default = device.default_input_config().map_err(backend)?;
            let supported = pick_config(
                default,
                device.supported_input_configs().map_err(backend)?,
                Some(rate),
            )?;
            let mut cfg: cpal::StreamConfig = supported.into();
            cfg.buffer_size = buffer_size(supported.buffer_size(), config.buffer_size);
            Some((device, supported.sample_format(), cfg))
        }
    };
    let in_channels = input_setup
        .as_ref()
        .map_or(0, |(_, _, c)| c.channels as usize);

    let (engine, controller) = Engine::new(rate as f32);
    let (bridge_tx, bridge_rx) =
        RingBuffer::new(((BRIDGE_SECONDS * f64::from(rate)) as usize * in_channels).max(1));

    let input_stream = match input_setup {
        None => None,
        Some((device, fmt, cfg)) => Some(match fmt {
            SampleFormat::F32 => build_input::<f32>(device, cfg, bridge_tx, xruns.clone()),
            SampleFormat::I16 => build_input::<i16>(device, cfg, bridge_tx, xruns.clone()),
            SampleFormat::I32 => build_input::<i32>(device, cfg, bridge_tx, xruns.clone()),
            SampleFormat::U16 => build_input::<u16>(device, cfg, bridge_tx, xruns.clone()),
            other => {
                return Err(AudioError::UnsupportedConfig(format!(
                    "input sample format {other}"
                )));
            }
        }?),
    };
    let bridge = input_stream.as_ref().map(|_| bridge_rx);

    let info = AudioInfo {
        host: host.id().name().to_string(),
        output_device: device_name(&output),
        input_device: input.as_ref().map(device_name),
        sample_rate: rate,
        output_channels: out_config.channels,
        input_channels: in_channels as u16,
        buffer_size: match out_config.buffer_size {
            cpal::BufferSize::Fixed(n) => Some(n),
            cpal::BufferSize::Default => None,
        },
        sample_format: format.to_string(),
    };

    let output_stream = match format {
        SampleFormat::F32 => build_output::<f32>(
            &output,
            out_config,
            engine,
            bridge,
            in_channels,
            xruns.clone(),
        ),
        SampleFormat::F64 => build_output::<f64>(
            &output,
            out_config,
            engine,
            bridge,
            in_channels,
            xruns.clone(),
        ),
        SampleFormat::I16 => build_output::<i16>(
            &output,
            out_config,
            engine,
            bridge,
            in_channels,
            xruns.clone(),
        ),
        SampleFormat::I32 => build_output::<i32>(
            &output,
            out_config,
            engine,
            bridge,
            in_channels,
            xruns.clone(),
        ),
        SampleFormat::U16 => build_output::<u16>(
            &output,
            out_config,
            engine,
            bridge,
            in_channels,
            xruns.clone(),
        ),
        other => {
            return Err(AudioError::UnsupportedConfig(format!(
                "output sample format {other}"
            )));
        }
    }?;
    if let Some(stream) = &input_stream {
        stream.play().map_err(backend)?;
    }
    output_stream.play().map_err(backend)?;
    Ok(((output_stream, input_stream), controller, info))
}

fn error_callback(xruns: Arc<AtomicU32>) -> impl FnMut(cpal::Error) + Send + 'static {
    move |err| {
        if err.kind() == cpal::ErrorKind::Xrun {
            xruns.fetch_add(1, Ordering::Relaxed);
        } else {
            eprintln!("tessera-audio: stream error: {err}");
        }
    }
}

fn build_input<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut bridge: Producer<f32>,
    xruns: Arc<AtomicU32>,
) -> Result<cpal::Stream, AudioError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let overflow = xruns.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                for &s in data {
                    if bridge.push(f32::from_sample(s)).is_err() {
                        // The output side stalled; it resynchronizes by itself.
                        overflow.fetch_add(1, Ordering::Relaxed);
                        break;
                    }
                }
            },
            error_callback(xruns),
            None,
        )
        .map_err(backend)
}

fn build_output<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut engine: Engine,
    mut bridge: Option<Consumer<f32>>,
    in_channels: usize,
    xruns: Arc<AtomicU32>,
) -> Result<cpal::Stream, AudioError>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    // Allocated here, off the audio thread, and reused by every callback.
    let mut scratch = vec![0.0f32; MAX_BLOCK_FRAMES * channels.max(1)];
    let mut input = vec![0.0f32; MAX_BLOCK_FRAMES * in_channels.max(1)];
    let mut primed = false;
    let underruns = xruns.clone();
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                // Aborts in debug builds if the callback allocates (when the binary installs
                // `assert_no_alloc::AllocDisabler` as its global allocator).
                assert_no_alloc::assert_no_alloc(|| {
                    for chunk in data.chunks_mut(scratch.len()) {
                        let frames = chunk.len() / channels.max(1);
                        let need = frames * in_channels;
                        let input = &mut input[..need];
                        if let Some(bridge) = bridge.as_mut() {
                            read_input(bridge, input, &mut primed, &underruns);
                        }
                        let block = &mut scratch[..chunk.len()];
                        engine.process_io(input, in_channels, block, channels);
                        for (out, &s) in chunk.iter_mut().zip(block.iter()) {
                            *out = T::from_sample(s);
                        }
                    }
                })
            },
            error_callback(xruns),
            None,
        )
        .map_err(backend)
}

/// Fills `input` from the input stream's bridge, keeping the bridge short (bounded latency)
/// and counting underruns once the input is flowing. Real-time safe.
fn read_input(
    bridge: &mut Consumer<f32>,
    input: &mut [f32],
    primed: &mut bool,
    underruns: &AtomicU32,
) {
    let need = input.len();
    let available = bridge.slots();
    if !*primed && available >= need {
        *primed = true;
    }
    if !*primed {
        input.fill(0.0);
        return;
    }
    // Too far behind (e.g. clock drift between devices): drop the oldest input.
    if available > need * 4
        && let Ok(chunk) = bridge.read_chunk(available - need * 2)
    {
        chunk.commit_all();
    }
    let take = bridge.slots().min(need);
    if let Ok(chunk) = bridge.read_chunk(take) {
        let (a, b) = chunk.as_slices();
        input[..a.len()].copy_from_slice(a);
        input[a.len()..a.len() + b.len()].copy_from_slice(b);
        chunk.commit_all();
    }
    if take < need {
        input[take..].fill(0.0);
        underruns.fetch_add(1, Ordering::Relaxed);
        *primed = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_primes_then_reads_and_counts_underruns() {
        let (mut tx, mut rx) = RingBuffer::<f32>::new(64);
        let underruns = AtomicU32::new(0);
        let mut primed = false;
        let mut input = [9.0f32; 8];
        read_input(&mut rx, &mut input, &mut primed, &underruns);
        assert_eq!(
            (input, primed),
            ([0.0; 8], false),
            "silence until a full block is buffered"
        );
        for i in 0..12 {
            tx.push(i as f32).unwrap();
        }
        read_input(&mut rx, &mut input, &mut primed, &underruns);
        assert_eq!(input, [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]);
        read_input(&mut rx, &mut input, &mut primed, &underruns);
        assert_eq!(input, [8.0, 9.0, 10.0, 11.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!((underruns.load(Ordering::Relaxed), primed), (1, false));
    }

    #[test]
    fn bridge_drops_old_input_when_far_behind() {
        let (mut tx, mut rx) = RingBuffer::<f32>::new(64);
        let underruns = AtomicU32::new(0);
        let mut primed = true;
        for i in 0..40 {
            tx.push(i as f32).unwrap();
        }
        let mut input = [0.0f32; 8];
        read_input(&mut rx, &mut input, &mut primed, &underruns);
        // 40 > 4·8 buffered: keep the newest 16, then read 8 of them.
        assert_eq!(input[0], 24.0);
        assert_eq!(rx.slots(), 8);
    }
}
