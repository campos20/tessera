import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { RecordState, Session, SessionUiState, TransportState } from "./session";
import type { ProjectActions, ProjectState } from "./store";

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionContext.Provider>");
  return session;
}

/** Selects from the project store. Selectors must return stable references. */
export function useProject<T>(selector: (s: ProjectState & ProjectActions) => T): T {
  return useStore(useSession().store, selector);
}

export function useTransport<T>(selector: (s: TransportState) => T): T {
  return useStore(useSession().transport, selector);
}

export function useSessionUi<T>(selector: (s: SessionUiState) => T): T {
  return useStore(useSession().ui, selector);
}

export function useRecording<T>(selector: (s: RecordState) => T): T {
  return useStore(useSession().recording, selector);
}
