import type { ReactNode } from "react";

/** Small inline transport icons (currentColor). */
const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
    {children}
  </svg>
);

export const PlayIcon = () => (
  <Svg>
    <path d="M3 1.5v11l9.5-5.5z" />
  </Svg>
);
export const StopIcon = () => (
  <Svg>
    <rect x="2.5" y="2.5" width="9" height="9" rx="1" />
  </Svg>
);
export const RecordIcon = () => (
  <Svg>
    <circle cx="7" cy="7" r="5" />
  </Svg>
);
export const RewindIcon = () => (
  <Svg>
    <path d="M2 2h2v10H2zM12.5 2v10L5 7z" />
  </Svg>
);
export const LoopIcon = () => (
  <Svg>
    <path
      d="M3 5.5A2.5 2.5 0 0 1 5.5 3h5l-1.5-1.5M11 8.5A2.5 2.5 0 0 1 8.5 11h-5L5 12.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);
export const MetronomeIcon = () => (
  <Svg>
    <path
      d="M5 1h4l3 12H2zM7 4.5v5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <path d="M7 9.5l3-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </Svg>
);
export const MagnetIcon = () => (
  <Svg>
    <path
      d="M3 2v5a4 4 0 0 0 8 0V2M3 4.5h2.5M8.5 4.5H11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </Svg>
);
