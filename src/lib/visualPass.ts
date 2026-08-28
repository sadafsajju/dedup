// Visual similarity signal (FR-5.2, the third of the three scan signals).
//
// The structural signal compares JSX trees and the class signal compares
// Tailwind knobs — both read source. Neither can tell you that two components
// with the same markup render as a 320px card and a full-bleed banner, or that
// two structurally different trees produce the same thing on screen. That is
// what pixels are for.
//
// The renders already exist: the Components tab draws every scanned component
// in an isolated harness iframe with mock props, which is exactly the sandbox
// the PRD describes. This module walks those cards, perceptually hashes each
// one through the webview's own snapshot, and compares hashes within a
// cluster.
//
// Two honesty constraints shape the whole design:
//
//  * A component that will not render in isolation (needs a provider, a
//    router, real data) has NO hash, and its cluster is reported as scored on
//    structure alone rather than quietly averaged as if it had agreed.
//  * The pass refines confidence and can *warn*; it never silently adds or
//    removes a cluster member. A user who dismissed a cluster, or kept one,
//    should not find that decision rewritten by a screenshot.

import { visualHash, visualSimilarity } from "./api";
import type { ScanCluster } from "./types";

/** How long a freshly scrolled-in harness iframe gets to paint. */
const PAINT_MS = 420;

export interface VisualScore {
  /** Mean pairwise visual similarity, 0–1; null when fewer than two members
   * could be rendered and hashed. */
  score: number | null;
  /** Members that produced a hash. */
  hashed: string[];
  /** Members that could not be rendered in isolation, with no hash. */
  unrendered: string[];
}

export const memberKey = (m: { file: string; name: string }) =>
  `${m.file}#${m.name}`;

/**
 * Scroll one component card into view and hash what the webview draws.
 * Returns null when the card isn't in the DOM or the capture fails — both of
 * which mean "no evidence", never "no similarity".
 */
async function hashCard(key: string): Promise<string | null> {
  const el = document.querySelector(
    `[data-component-surface="${CSS.escape(key)}"]`,
  );
  if (!(el instanceof HTMLElement)) return null;

  // The snapshot API rasterises a region of the window, so the card has to be
  // *on screen* — and the gallery unmounts off-screen iframes, so scrolling
  // is what causes it to exist at all.
  el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  await new Promise((r) => setTimeout(r, PAINT_MS));

  const r = el.getBoundingClientRect();
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const width = Math.min(r.right, window.innerWidth) - x;
  const height = Math.min(r.bottom, window.innerHeight) - y;
  if (width < 8 || height < 8) return null;
  try {
    return await visualHash({ x, y, width, height });
  } catch {
    return null;
  }
}

/**
 * Hash every member of every cluster and score each cluster by the mean
 * pairwise agreement of the hashes it got.
 */
export async function runVisualPass(
  clusters: ScanCluster[],
  onProgress: (done: number, total: number) => void,
  isCancelled: () => boolean,
): Promise<{ scores: Record<string, VisualScore>; hashes: Record<string, string> }> {
  const scores: Record<string, VisualScore> = {};
  const hashes: Record<string, string> = {};
  const total = clusters.reduce((n, c) => n + c.members.length, 0);
  let done = 0;

  for (const cluster of clusters) {
    if (isCancelled()) break;
    const hashed: string[] = [];
    const unrendered: string[] = [];
    for (const member of cluster.members) {
      if (isCancelled()) break;
      const key = memberKey(member);
      const hash = hashes[key] ?? (await hashCard(key));
      onProgress(++done, total);
      if (hash) {
        hashes[key] = hash;
        hashed.push(key);
      } else {
        unrendered.push(key);
      }
    }

    let score: number | null = null;
    if (hashed.length >= 2) {
      let sum = 0;
      let pairs = 0;
      for (let i = 0; i < hashed.length; i++) {
        for (let j = i + 1; j < hashed.length; j++) {
          try {
            sum += await visualSimilarity(hashes[hashed[i]], hashes[hashed[j]]);
            pairs++;
          } catch {
            // A comparison that fails contributes nothing rather than zero —
            // "we couldn't tell" is not "they look different".
          }
        }
      }
      if (pairs > 0) score = sum / pairs;
    }
    scores[cluster.id] = { score, hashed, unrendered };
  }
  return { scores, hashes };
}

/** Weight of the visual signal when it is available. Deliberately modest: a
 * perceptual hash of a small card is coarse evidence next to a tree edit
 * distance over the real markup, and it is the newest of the three signals. */
const VISUAL_WEIGHT = 0.25;

/**
 * The confidence a cluster is shown with. Without a visual score this is the
 * scan's structural confidence unchanged — the pass adds a signal, it does not
 * replace the one that was already there.
 */
export function combinedConfidence(
  structural: number,
  visual: VisualScore | undefined,
): number {
  if (!visual || visual.score === null) return structural;
  return structural * (1 - VISUAL_WEIGHT) + visual.score * VISUAL_WEIGHT;
}

/** Below this, the renders disagree enough to be worth saying out loud. */
const DISAGREEMENT = 0.75;

/**
 * A sentence for the cluster review, or null when there is nothing to add.
 * This is where the pass earns its place: it is allowed to contradict the
 * structural score, and when it does, the user hears about it.
 */
export function visualNote(visual: VisualScore | undefined): string | null {
  if (!visual) return null;
  if (visual.score === null) {
    return visual.unrendered.length > 0
      ? `Scored on structure alone — ${visual.unrendered.length} member${
          visual.unrendered.length === 1 ? "" : "s"
        } could not be rendered in isolation.`
      : null;
  }
  const pct = Math.round(visual.score * 100);
  if (visual.score < DISAGREEMENT) {
    return `These render quite differently (${pct}% visual match) despite similar markup — look at the previews before merging.`;
  }
  const tail =
    visual.unrendered.length > 0
      ? ` (${visual.unrendered.length} member${
          visual.unrendered.length === 1 ? "" : "s"
        } could not be rendered)`
      : "";
  return `Renders match at ${pct}%${tail}.`;
}
