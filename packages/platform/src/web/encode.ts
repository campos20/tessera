import { type Command, Opcode } from "@tessera/schema";

/** Encodes a command for the SharedArrayBuffer ring / WASM ABI (see engine-core `Opcode`). */
export function encodeCommand(command: Command): [op: Opcode, value: number] {
  switch (command.type) {
    case "Play":
      return [Opcode.Play, 0];
    case "Stop":
      return [Opcode.Stop, 0];
    case "SetFrequency":
      return [Opcode.SetFrequency, command.hz];
    case "SetGain":
      return [Opcode.SetGain, command.gain];
  }
}
