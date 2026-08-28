// The gate runner (FR-5.6). Kept out of the store because it is the part of
// the merge that has to be reasoned about on its own: three checks, each of
// which can pass, fail, or be unavailable, and a failure of any one of them
// means the merge is undone rather than reported.
//
// The rule the whole file exists to enforce: **a gate that cannot run is not a
// gate that passed.** A project with no typecheck script, an artboard that
// isn't mounted, a dev server that isn't up — each of those produces a
// `skipped` verdict with the reason attached, and the review says plainly that
// the merge landed with weaker evidence than usual. Rounding those up to
// "passed" is how a tool ends up corrupting a codebase while showing green.

import { artboardRect, runCheck, visualCapture, visualCompare } from "./api";
import type { GateResult, ParsedErrorLike } from "./types";
import { VISUAL_TOLERANCE } from "./types";

/** Label a capture so before/after pairs can't be crossed between merges. */
export const captureLabel = (phase: "before" | "after", route: string) =>
  `merge:${phase}:${route}`;

/**
 * Snapshot every artboard currently on screen. Returns the routes actually
 * captured — an off-screen artboard unmounts its frame, so it genuinely
 * cannot be compared, and the visual gate has to know that rather than
 * assume a missing capture means a clean one.
 */
export async function captureArtboards(
  phase: "before" | "after",
  routes: string[],
): Promise<string[]> {
  const captured: string[] = [];
  for (const route of routes) {
    const rect = artboardRect(route);
    if (!rect) continue;
    try {
      await visualCapture(captureLabel(phase, route), rect);
      captured.push(route);
    } catch {
      // A capture that fails is a route we cannot vouch for; the gate below
      // counts it as uncovered rather than as unchanged.
    }
  }
  return captured;
}

export interface VisualGateInput {
  /** Routes captured before the merge. */
  before: string[];
  /** Routes captured after it. */
  after: string[];
  tolerance?: number;
}

/**
 * Compare every artboard captured on both sides. Any route above tolerance
 * fails the gate; a route captured on only one side is reported as uncovered,
 * because a frame that unmounted mid-merge proves nothing either way.
 */
export async function runVisualGate({
  before,
  after,
  tolerance = VISUAL_TOLERANCE,
}: VisualGateInput): Promise<GateResult> {
  const started = Date.now();
  const comparable = before.filter((r) => after.includes(r));
  const uncovered = [...new Set([...before, ...after])].filter(
    (r) => !comparable.includes(r),
  );

  if (comparable.length === 0) {
    return {
      kind: "visual",
      status: "skipped",
      command: "canvas snapshot diff",
      output:
        "No artboard could be captured on both sides of the merge — scroll the affected pages into view on the canvas to get a visual check. The merge was gated on typecheck and build only.",
      durationMs: Date.now() - started,
    };
  }

  const lines: string[] = [];
  const failures: string[] = [];
  for (const route of comparable) {
    try {
      const diff = await visualCompare(
        captureLabel("before", route),
        captureLabel("after", route),
      );
      const pct = (diff.ratio * 100).toFixed(2);
      const note = diff.sizeChanged ? " (layout size changed)" : "";
      lines.push(`${route}: ${pct}% of pixels differ${note}`);
      if (diff.ratio > tolerance) failures.push(`${route} (${pct}%)`);
    } catch (e) {
      lines.push(`${route}: could not be compared — ${errText(e)}`);
      failures.push(`${route} (comparison failed)`);
    }
  }
  if (uncovered.length > 0) {
    lines.push(
      `Not checked (artboard not on screen): ${uncovered.join(", ")}`,
    );
  }

  return {
    kind: "visual",
    status: failures.length > 0 ? "failed" : "passed",
    command: `canvas snapshot diff (tolerance ${(tolerance * 100).toFixed(0)}%)`,
    output:
      failures.length > 0
        ? `Past tolerance on ${failures.join(", ")}.\n${lines.join("\n")}`
        : lines.join("\n"),
    durationMs: Date.now() - started,
  };
}

/**
 * The dev server's own compile verdict — the fast half of FR-5.6 #2. It is
 * deliberately not the whole of it: a dev server only compiles the modules a
 * loaded route pulled in, so a clean HMR proves the pages on the canvas are
 * fine, not the project. The build script is what proves the project, and the
 * caller runs both.
 */
export function hmrGate(
  devReady: boolean,
  errors: ParsedErrorLike[],
  elapsedMs: number,
): GateResult {
  if (!devReady) {
    return {
      kind: "build",
      status: "skipped",
      command: "dev server",
      output: "The dev server isn't running, so there was no live compile to check.",
      durationMs: elapsedMs,
    };
  }
  return {
    kind: "build",
    status: errors.length > 0 ? "failed" : "passed",
    command: "dev server (live compile)",
    output:
      errors.length > 0
        ? errors.map((e) => `${e.source}: ${e.content}`).join("\n")
        : "The dev server recompiled the merged files with no errors.",
    durationMs: elapsedMs,
  };
}

/** Typecheck + production build, in the order that fails fastest. */
export async function runBuildGates(
  root: string,
  onProgress: (kind: GateResult["kind"]) => void,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  onProgress("typecheck");
  results.push(await runCheck(root, "typecheck"));
  onProgress("build");
  results.push(await runCheck(root, "build"));
  return results;
}

/** A merge lands only if nothing failed (FR-5.6). Skips are not failures —
 * they are recorded as weaker evidence and surfaced as such. */
export function gatesPassed(gates: GateResult[]): boolean {
  return gates.every((g) => g.status !== "failed");
}

export function gateSummary(gates: GateResult[]): string {
  const failed = gates.filter((g) => g.status === "failed");
  if (failed.length > 0) {
    return `${failed.map((g) => g.kind).join(" and ")} failed`;
  }
  const skipped = gates.filter((g) => g.status === "skipped");
  if (skipped.length > 0) {
    return `passed, with ${skipped.map((g) => g.kind).join(" and ")} unavailable`;
  }
  return "all checks passed";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
