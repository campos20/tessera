import type { Peaks, Project } from "@tessera/schema";
import { applyPatches, type Draft, enablePatches, type Patch, produce, produceWithPatches } from "immer";
import { createStore } from "zustand/vanilla";

enablePatches();

export type Recipe = (draft: Draft<Project>) => void;

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
}

export interface Selection {
  clips: ReadonlySet<number>;
  track: number | undefined;
}

export interface ProjectState {
  project: Project;
  /** Waveform overviews by source id (runtime only, not saved or undone). */
  peaks: ReadonlyMap<number, Peaks>;
  selection: Selection;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Increments on every project change, including undo/redo (drives autosave). */
  revision: number;
  /** Set during a drag: edits preview from `base` and become one undo step on commit. */
  gesture: { base: Project; label: string; recipe: Recipe | undefined } | undefined;
}

export interface ProjectActions {
  /** Applies an undoable edit. */
  edit(label: string, recipe: Recipe): void;
  beginGesture(label: string): void;
  /** Replaces the gesture's preview with `recipe` applied to the gesture's starting state. */
  updateGesture(recipe: Recipe): void;
  commitGesture(): void;
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  /** Replaces the whole project (open/new); clears history and selection. */
  load(project: Project, peaks?: ReadonlyMap<number, Peaks>): void;
  setPeaks(sourceId: number, peaks: Peaks): void;
  select(selection: Partial<Selection>): void;
}

export type ProjectStore = ReturnType<typeof createProjectStore>;

const HISTORY_LIMIT = 200;
const EMPTY_SELECTION: Selection = { clips: new Set(), track: undefined };

export function createProjectStore(initial: Project) {
  return createStore<ProjectState & ProjectActions>()((set, get) => {
    const record = (label: string, base: Project, recipe: Recipe) => {
      const [next, patches, inverse] = produceWithPatches(base, recipe);
      if (patches.length === 0) return;
      set((s) => ({
        project: next,
        past: [...s.past, { label, patches, inverse }].slice(-HISTORY_LIMIT),
        future: [],
        revision: s.revision + 1,
        selection: pruneSelection(s.selection, next),
      }));
    };

    return {
      project: initial,
      peaks: new Map(),
      selection: EMPTY_SELECTION,
      past: [],
      future: [],
      revision: 0,
      gesture: undefined,

      edit(label, recipe) {
        if (get().gesture) get().commitGesture();
        record(label, get().project, recipe);
      },

      beginGesture(label) {
        if (get().gesture) get().commitGesture();
        set({ gesture: { base: get().project, label, recipe: undefined } });
      },

      updateGesture(recipe) {
        const gesture = get().gesture;
        if (!gesture) return;
        set((s) => ({
          project: produce(gesture.base, recipe),
          gesture: { ...gesture, recipe },
          revision: s.revision + 1,
        }));
      },

      commitGesture() {
        const gesture = get().gesture;
        if (!gesture) return;
        set({ gesture: undefined, project: gesture.base });
        if (gesture.recipe) record(gesture.label, gesture.base, gesture.recipe);
      },

      cancelGesture() {
        const gesture = get().gesture;
        if (gesture) set((s) => ({ gesture: undefined, project: gesture.base, revision: s.revision + 1 }));
      },

      undo() {
        if (get().gesture) get().cancelGesture();
        const entry = get().past.at(-1);
        if (!entry) return;
        set((s) => {
          const project = applyPatches(s.project, entry.inverse);
          return {
            project,
            past: s.past.slice(0, -1),
            future: [...s.future, entry],
            revision: s.revision + 1,
            selection: pruneSelection(s.selection, project),
          };
        });
      },

      redo() {
        const entry = get().future.at(-1);
        if (!entry) return;
        set((s) => {
          const project = applyPatches(s.project, entry.patches);
          return {
            project,
            future: s.future.slice(0, -1),
            past: [...s.past, entry],
            revision: s.revision + 1,
            selection: pruneSelection(s.selection, project),
          };
        });
      },

      load(project, peaks = new Map()) {
        set((s) => ({
          project,
          peaks,
          past: [],
          future: [],
          gesture: undefined,
          selection: EMPTY_SELECTION,
          revision: s.revision + 1,
        }));
      },

      setPeaks(sourceId, peaks) {
        set((s) => ({ peaks: new Map(s.peaks).set(sourceId, peaks) }));
      },

      select(selection) {
        set((s) => ({ selection: { ...s.selection, ...selection } }));
      },
    };
  });
}

/** Drops selected ids that no longer exist (after delete, undo, ...). */
function pruneSelection(selection: Selection, project: Project): Selection {
  const clipIds = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const clips = [...selection.clips].filter((id) => clipIds.has(id));
  const track = project.tracks.some((t) => t.id === selection.track) ? selection.track : undefined;
  if (clips.length === selection.clips.size && track === selection.track) return selection;
  return { clips: new Set(clips), track };
}
