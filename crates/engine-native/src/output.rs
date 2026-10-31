use std::sync::mpsc;
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use engine_core::{Command, Engine, EngineController, Event};
use serde::Serialize;

/// Frames rendered per engine call when the driver hands us a larger buffer.
const MAX_BLOCK_FRAMES: usize = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct OutputInfo {
    pub host: String,
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
}

#[derive(Debug)]
pub enum AudioError {
    NoOutputDevice,
    UnsupportedSampleFormat(String),
    Backend(String),
}

impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AudioError::NoOutputDevice => write!(f, "no default output device"),
            AudioError::UnsupportedSampleFormat(s) => write!(f, "unsupported sample format {s}"),
            AudioError::Backend(s) => write!(f, "audio backend error: {s}"),
        }
    }
}

impl std::error::Error for AudioError {}

/// A running output stream driving an [`Engine`].
///
/// The cpal stream lives on a dedicated thread because it is not `Send` on every platform;
/// this handle is `Send` and talks to the engine only through its lock-free queues.
/// Dropping it stops the stream.
pub struct AudioOutput {
    controller: EngineController,
    info: OutputInfo,
    shutdown: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl AudioOutput {
    /// Opens the default output device of the default host and starts streaming (silence
    /// until [`Command::Play`]).
    pub fn start_default() -> Result<Self, AudioError> {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("tessera-audio".into())
            .spawn(move || match open_default_stream() {
                Ok((stream, controller, info)) => {
                    let _ = ready_tx.send(Ok((controller, info)));
                    // Park until the handle is dropped, keeping the stream alive.
                    let _ = shutdown_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|e| AudioError::Backend(e.to_string()))?;

        let (controller, info) = ready_rx
            .recv()
            .map_err(|_| AudioError::Backend("audio thread exited during startup".into()))??;
        Ok(Self {
            controller,
            info,
            shutdown: Some(shutdown_tx),
            thread: Some(thread),
        })
    }

    pub fn info(&self) -> &OutputInfo {
        &self.info
    }

    /// Queues a command for the audio thread. Returns it back if the queue is full.
    pub fn send(&mut self, command: Command) -> Result<(), Command> {
        self.controller.send(command)
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        self.controller.poll_event()
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        drop(self.shutdown.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn open_default_stream() -> Result<(cpal::Stream, EngineController, OutputInfo), AudioError> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or(AudioError::NoOutputDevice)?;
    let supported = device
        .default_output_config()
        .map_err(|e| AudioError::Backend(e.to_string()))?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let info = OutputInfo {
        host: host.id().name().to_string(),
        device: device
            .description()
            .map(|d| d.name().to_string())
            .or_else(|_| device.id().map(|id| id.to_string()))
            .unwrap_or_default(),
        sample_rate: config.sample_rate,
        channels: config.channels,
        sample_format: format.to_string(),
    };

    let (engine, controller) = Engine::new(config.sample_rate as f32);
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, config, engine),
        SampleFormat::F64 => build::<f64>(&device, config, engine),
        SampleFormat::I16 => build::<i16>(&device, config, engine),
        SampleFormat::I32 => build::<i32>(&device, config, engine),
        SampleFormat::U16 => build::<u16>(&device, config, engine),
        other => return Err(AudioError::UnsupportedSampleFormat(other.to_string())),
    }?;
    stream
        .play()
        .map_err(|e| AudioError::Backend(e.to_string()))?;
    Ok((stream, controller, info))
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut engine: Engine,
) -> Result<cpal::Stream, AudioError>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    // Allocated here, off the audio thread, and reused by every callback.
    let mut scratch = vec![0.0f32; MAX_BLOCK_FRAMES * channels.max(1)];
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                // Aborts in debug builds if the callback allocates (when the binary installs
                // `assert_no_alloc::AllocDisabler` as its global allocator).
                assert_no_alloc::assert_no_alloc(|| {
                    for chunk in data.chunks_mut(scratch.len()) {
                        let block = &mut scratch[..chunk.len()];
                        engine.process(block, channels);
                        for (out, &s) in chunk.iter_mut().zip(block.iter()) {
                            *out = T::from_sample(s);
                        }
                    }
                })
            },
            // Error callback runs off the audio thread.
            |err| eprintln!("tessera-audio: stream error: {err}"),
            None,
        )
        .map_err(|e| AudioError::Backend(e.to_string()))
}
