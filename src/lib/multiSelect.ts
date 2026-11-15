// The rules a multi-selection obeys in the editor, pure so `pnpm
// test:marquee` pins them. (Which elements a marquee picks up is the
// overlay's rule and lives in plugin-src/marquee.mjs.)

interface Picked {
  dedupId: string;
  /** Innermost-first chain of tagged ancestors, including the element. */
  ancestry: Array<{ dedupId: string }>;
}

/**
 * The selection with everything nested inside another selected element taken
 * out — what a structural gesture (delete, copy, cut) actually acts on.
 *
 * A marquee never selects a parent and its child together, but a shift-click
 * can. Deleting both is one deletion said twice, and the write-back is right
 * to refuse the second: its target is already inside something being removed.
 * Copying both would paste the child twice — once inside its parent and once
 * beside it. The parent speaks for everything in it.
 */
export function outermostOnly<T extends Picked>(list: T[]): T[] {
  const ids = new Set(list.map((el) => el.dedupId));
  const seen = new Set<string>();
  return list.filter((el) => {
    if (seen.has(el.dedupId)) return false;
    seen.add(el.dedupId);
    return !el.ancestry.some((a) => a.dedupId !== el.dedupId && ids.has(a.dedupId));
  });
}

/** Shift-click: the id joins the selection, or leaves it if it was there. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];
}

/** "3 elements" — how a notice counts a selection. */
export function countLabel(n: number): string {
  return `${n} element${n === 1 ? "" : "s"}`;
}
