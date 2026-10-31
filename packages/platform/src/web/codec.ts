import {
  type Command,
  CommandLayout,
  type Event,
  EventLayout,
  MAX_ARGS,
  type MessageLayout,
} from "@tessera/schema";

/**
 * Raw encoding of protocol messages, driven by the layout table generated from Rust
 * (engine-core `protocol.rs`), so opcodes and field order are never hand-written here.
 */

/** Writes `command`'s arguments to `out[base..base + MAX_ARGS]` and returns its opcode. */
export function encodeCommand(command: Command, out: Float64Array, base = 0): number {
  const layout: MessageLayout = CommandLayout[command.type];
  const fields = command as unknown as Record<string, number | boolean>;
  out.fill(0, base, base + MAX_ARGS);
  layout.fields.forEach(([name, kind], i) => {
    const value = fields[name];
    out[base + i] = kind === "bool" ? (value ? 1 : 0) : Number(value);
  });
  return layout.op;
}

const eventsByOp: (readonly [string, MessageLayout] | undefined)[] = [];
for (const [name, layout] of Object.entries(EventLayout) as [string, MessageLayout][]) {
  eventsByOp[layout.op] = [name, layout];
}

/** Decodes a raw event; `undefined` for unknown opcodes. Allocates (main thread only). */
export function decodeEvent(op: number, args: ArrayLike<number>, base = 0): Event | undefined {
  const entry = eventsByOp[op];
  if (!entry) return undefined;
  const [type, layout] = entry;
  const event: Record<string, unknown> = { type };
  layout.fields.forEach(([name, kind], i) => {
    const value = args[base + i] ?? 0;
    event[name] = kind === "bool" ? value !== 0 : value;
  });
  return event as Event;
}
