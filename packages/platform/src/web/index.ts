import type { AudioDeviceList, Command } from "@tessera/schema";
import type { AudioPlatform, Diagnostics, EngineEventListener, PlatformCapabilities } from "../index";
import { CommandRing } from "./commandRing";
import { encodeCommand } from "./encode";
import { PROCESSOR_NAME, type ProcessorOptions, STATUS_BYTES } from "./protocol";
import wasmUrl from "./engine.wasm?url";
import workletUrl from "./worklet.ts?worker&url";

const SAMPLE_RATE = 48_000;

/** Web edition: AudioWorklet running engine-wasm, fed through SharedArrayBuffer rings. */
export class WebPlatform implements AudioPlatform {
  readonly edition = "web";
  readonly capabilities: PlatformCapabilities = {
    plugins: false,
    outputDeviceSelection: typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype,
    midi: typeof navigator !== "undefined" && "requestMIDIAccess" in navigator,
  };

  private ctx: AudioContext | undefined;
  private starting: Promise<void> | undefined;
  private ring: CommandRing | undefined;
  private status: Int32Array | undefined;
  private readonly listeners = new Set<EngineEventListener>();
  private pollHandle = 0;

  async start(): Promise<void> {
    this.starting ??= this.init().catch((e: unknown) => {
      this.starting = undefined;
      throw e;
    });
    await this.starting;
    await this.ctx?.resume();
  }

  send(command: Command): void {
    const [op, value] = encodeCommand(command);
    if (!this.commandRing().push(op, value)) {
      console.warn("tessera: command ring full, dropped", command);
    }
  }

  onEvent(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listDevices(): Promise<AudioDeviceList> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audio = devices.filter((d) => d.kind === "audioinput" || d.kind === "audiooutput");
    return {
      hosts: [
        {
          name: "Web Audio",
          isDefault: true,
          error: null,
          devices: audio.map((d) => ({
            id: `${d.kind}:${d.deviceId}`,
            // Labels stay empty until the page has microphone permission (M3).
            name:
              d.label ||
              (d.kind === "audioinput" ? "Input" : "Output") + (d.deviceId === "default" ? " (default)" : ""),
            // Browsers don't report channel counts; assume stereo.
            maxInputChannels: d.kind === "audioinput" ? 2 : 0,
            maxOutputChannels: d.kind === "audiooutput" ? 2 : 0,
            isDefaultInput: d.kind === "audioinput" && d.deviceId === "default",
            isDefaultOutput: d.kind === "audiooutput" && d.deviceId === "default",
          })),
        },
      ],
    };
  }

  async diagnostics(): Promise<Diagnostics> {
    const d: Diagnostics = {
      edition: this.edition,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
    };
    if (this.ctx) {
      d.sampleRate = this.ctx.sampleRate;
      d.state = this.ctx.state;
      d.baseLatencyMs = round(this.ctx.baseLatency * 1000);
      d.outputLatencyMs = round(this.ctx.outputLatency * 1000);
    }
    return d;
  }

  private commandRing(): CommandRing {
    if (!this.ring) {
      if (!globalThis.crossOriginIsolated) {
        throw new Error("Tessera needs cross-origin isolation (COOP/COEP headers) for SharedArrayBuffer.");
      }
      this.ring = CommandRing.create();
    }
    return this.ring;
  }

  private async init(): Promise<void> {
    const ring = this.commandRing();
    const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: SAMPLE_RATE });
    try {
      const [module] = await Promise.all([
        WebAssembly.compileStreaming(fetch(wasmUrl)),
        ctx.audioWorklet.addModule(workletUrl),
      ]);
      const status = new SharedArrayBuffer(STATUS_BYTES);
      const processorOptions: ProcessorOptions = {
        module,
        commands: ring.buffer,
        commandCapacity: ring.capacity,
        status,
      };
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
      });
      node.connect(ctx.destination);
      this.status = new Int32Array(status);
      this.ctx = ctx;
      this.pollEvents();
    } catch (e) {
      await ctx.close();
      throw e;
    }
  }

  /** Turns the worklet's shared status block into engine events, once per frame. */
  private pollEvents(): void {
    const f32 = new Float32Array(1);
    const i32 = new Int32Array(f32.buffer);
    const tick = () => {
      if (this.status && this.listeners.size > 0) {
        i32[0] = Atomics.load(this.status, 0);
        const event = { type: "Peak", value: f32[0]! } as const;
        for (const listener of this.listeners) listener(event);
      }
      this.pollHandle = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.pollHandle);
    this.pollHandle = requestAnimationFrame(tick);
  }
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}
