// Re-exports the types generated from Rust. Regenerate with `pnpm gen:schema`.
export type { AudioDeviceInfo } from "./generated/AudioDeviceInfo";
export type { AudioDeviceList } from "./generated/AudioDeviceList";
export type { AudioHostInfo } from "./generated/AudioHostInfo";
export type { AutomationPoint } from "./generated/AutomationPoint";
export type { Clip } from "./generated/Clip";
export type { Command } from "./generated/Command";
export type { Device } from "./generated/Device";
export {
  DEVICES,
  type DeviceInfo,
  type DeviceKind,
  MAX_DEVICE_PARAMS,
  type ParamInfo,
  type ParamScale,
} from "./generated/devices";
export type { Event } from "./generated/Event";
export type { Key } from "./generated/Key";
export type { Lane } from "./generated/Lane";
export type { LaneTarget } from "./generated/LaneTarget";
export type { Mode } from "./generated/Mode";
export type { Note } from "./generated/Note";
export type { PlannedSegment } from "./generated/PlannedSegment";
export type { LoopRegion } from "./generated/LoopRegion";
export type { AudioConfig } from "./generated/AudioConfig";
export type { AudioInfo } from "./generated/AudioInfo";
export type { RecordedTake } from "./generated/RecordedTake";
export type { TakeProgress } from "./generated/TakeProgress";
export type { Peaks } from "./generated/Peaks";
export type { Project } from "./generated/Project";
export { PROJECT_SAMPLE_RATE, SCHEMA_VERSION } from "./generated/projectConstants";
export {
  CommandLayout,
  EventLayout,
  type FieldKind,
  MASTER_TRACK,
  MAX_ARGS,
  MAX_SENDS,
  type MessageLayout,
} from "./generated/protocolLayout";
export type { Send } from "./generated/Send";
export type { Source } from "./generated/Source";
export type { SourceInfo } from "./generated/SourceInfo";
export type { Tempo } from "./generated/Tempo";
export type { TimeSignature } from "./generated/TimeSignature";
export type { Track } from "./generated/Track";
export type { TrackKind } from "./generated/TrackKind";
export type { TuneAnalysis } from "./generated/TuneAnalysis";
export type { TuneEdits } from "./generated/TuneEdits";
