import { useEffect, useRef, useState } from "react";
import { useRecording, useSession } from "../state/hooks";

/** Count-in and punch settings next to the record button. */
export function RecordOptions() {
  const session = useSession();
  const countInBars = useRecording((s) => s.countInBars);
  const punch = useRecording((s) => s.punch);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="record-options" ref={ref}>
      <button
        className="icon-button narrow"
        aria-label="Recording options"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ▾
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Recording options">
          <label>
            Count-in
            <select
              value={countInBars}
              onChange={(e) => session.setCountIn(Number(e.target.value))}
              aria-label="Count-in"
            >
              <option value={0}>Off</option>
              <option value={1}>1 bar</option>
              <option value={2}>2 bars</option>
            </select>
          </label>
          <label title="Record only inside the loop region">
            <input
              type="checkbox"
              checked={punch}
              onChange={(e) => session.setPunch(e.target.checked)}
              aria-label="Punch"
            />
            Punch in/out at the loop region
          </label>
        </div>
      )}
    </div>
  );
}
