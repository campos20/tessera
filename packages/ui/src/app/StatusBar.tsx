import type { ReactNode } from "react";

/** Bottom bar. Plain strings are wrapped so each item gets its own spacing. */
export function StatusBar({ items }: { items: ReactNode[] }) {
  return (
    <footer className="status-bar">
      {items
        .filter(Boolean)
        .map((item, i) => (typeof item === "string" ? <span key={`s${i}`}>{item}</span> : item))}
    </footer>
  );
}
