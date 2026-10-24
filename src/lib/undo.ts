// Undo and redo over the staged program, one *gesture* at a time.
//
// Most gestures stage one action, so a step is one action. A few stage
// several — a drag from one artboard into another is a paste and a removal —
// and undoing half of one leaves a state nobody made: the element in both
// pages, or in neither. Actions that share a `gesture` id are one step.
// Pure, so `pnpm test:parking` pins it.

import type { EditAction } from "./types";

const gestureOf = (a: EditAction | undefined) =>
  a && (a.kind === "remove" || a.kind === "insert") ? (a.gesture ?? null) : null;

/** How many actions at the end of `list` form its last step. */
function lastStepLength(list: EditAction[]): number {
  const g = gestureOf(list[list.length - 1]);
  if (g === null) return list.length > 0 ? 1 : 0;
  let n = 0;
  while (n < list.length && gestureOf(list[list.length - 1 - n]) === g) n++;
  return n;
}

/** The program and redo stack after undoing one step. */
export function undoStep(actions: EditAction[], redo: EditAction[]) {
  const n = lastStepLength(actions);
  if (n === 0) return null;
  const taken = actions.slice(actions.length - n);
  // The redo stack is popped from its end, so the step goes on reversed: the
  // first action of the step comes back first.
  return { actions: actions.slice(0, actions.length - n), redo: [...redo, ...taken.reverse()] };
}

/** The program and redo stack after redoing one step. */
export function redoStep(actions: EditAction[], redo: EditAction[]) {
  const n = lastStepLength(redo);
  if (n === 0) return null;
  const taken = redo.slice(redo.length - n).reverse();
  return { actions: [...actions, ...taken], redo: redo.slice(0, redo.length - n) };
}
