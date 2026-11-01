import { useSession } from "../state/hooks";
import type { Recipe } from "../state/store";

/**
 * Continuous controls (sliders, drags): one undo step per pointer drag, plain undoable edits
 * for keyboard changes. Recipes must set absolute values: each update replaces the last.
 */
export function useGesture() {
  const store = useSession().store;
  return (label: string) => ({
    onPointerDown: () => store.getState().beginGesture(label),
    onPointerUp: () => store.getState().commitGesture(),
    onPointerCancel: () => store.getState().commitGesture(),
    apply: (recipe: Recipe) => {
      const s = store.getState();
      if (s.gesture) s.updateGesture(recipe);
      else s.edit(label, recipe);
    },
  });
}
