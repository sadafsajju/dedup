// Drift view — every copy of one drifted subtree, rendered together.
//
// This is the answer to "why does a duplicate-finder need to run your app".
// A list of file:line is a lint rule and ESLint could print it. Fifteen
// buttons side by side, where three are visibly a different size and one is
// visibly a lighter weight, is a finding you cannot get from reading code —
// and it is the same finding, shown in the only form that makes it obvious.
//
// The copies render through the tagger's `/__dedup/snippet` route rather than
// the component harness, because a drift occurrence has no name and no export
// for the harness to import. It has markup, and the route drops that markup
// into a page carrying the project's own stylesheet, so these are the real
// pixels rather than an approximation of them.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import type { DriftCandidate, DriftOccurrence } from "../lib/types";
import {
  CheckIcon,
  ExclamationTriangleIcon,
  MagicWandIcon,
} from "@radix-ui/react-icons";

/** Cards start here and resize to whatever the snippet reports. */
const FALLBACK = { w: 180, h: 44 };
/** Wider than this and the copy is a section, not a control — scale it down
 *  the way the Components gallery does rather than letting one card own the
 *  row. */
const MAX_W = 460;

function OccurrenceCard({
  occ,
  origin,
  selected,
  onToggle,
}: {
  occ: DriftOccurrence;
  origin: string | null;
  selected: boolean;
  onToggle: () => void;
}) {
  const key = `${occ.file}:${occ.start}`;
  const [size, setSize] = useState(FALLBACK);
  const frame = useRef<HTMLIFrameElement | null>(null);

  const src = origin
    ? `${origin}/__dedup/snippet?id=${encodeURIComponent(key)}` +
      `&html=${encodeURIComponent(occ.html)}`
    : null;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m?.__dedup || m.type !== "snippet-size" || m.id !== key) return;
      if (m.width > 0 && m.height > 0) setSize({ w: m.width, h: m.height });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [key]);

  const scale = Math.min(1, MAX_W / size.w);
  const cardW = Math.round(size.w * scale);
  const cardH = Math.round(size.h * scale);

  return (
    <button
      onClick={onToggle}
      className="group shrink-0 text-left"
      title={`${occ.file}:${occ.line}`}
    >
      <div className="mb-1 flex items-center gap-1 text-2xs">
        <span
          className={`flex h-3 w-3 items-center justify-center rounded-[3px] border ${
            selected
              ? "border-accent bg-accent text-white"
              : "border-line-strong text-transparent"
          }`}
        >
          <CheckIcon width={9} height={9} />
        </span>
        <span className="truncate text-ink-faint" style={{ maxWidth: cardW }}>
          {occ.component ?? occ.file.split("/").pop()}:{occ.line}
        </span>
      </div>
      <div
        style={{ width: cardW, height: cardH }}
        className={`overflow-hidden rounded-lg bg-white ring-1 transition-shadow ${
          selected ? "ring-accent" : "ring-line group-hover:ring-line-strong"
        }`}
      >
        {src ? (
          <iframe
            ref={frame}
            src={src}
            // Inert previews: a click anywhere on the card is a selection, not
            // an interaction with the markup inside it.
            className="pointer-events-none origin-top-left border-0"
            style={{
              width: size.w,
              height: size.h,
              transform: `scale(${scale})`,
            }}
            sandbox="allow-scripts allow-same-origin"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] text-ink-faint">
            Start the dev server to see this rendered.
          </div>
        )}
      </div>
    </button>
  );
}

export function DriftView() {
  const editorTab = useStore((s) => s.editorTab);
  const result = useStore((s) => s.driftResult);
  const openDriftId = useStore((s) => s.openDriftId);
  const selection = useStore((s) => s.driftSelection);
  const toggle = useStore((s) => s.toggleDriftOccurrence);
  const devUrl = useStore((s) => s.devUrl);
  const instrumentation = useStore((s) => s.instrumentation);

  const candidate: DriftCandidate | undefined = useMemo(
    () => result?.candidates.find((c) => c.id === openDriftId),
    [result, openDriftId],
  );

  const origin =
    devUrl && instrumentation?.active ? new URL(devUrl).origin : null;
  const selectedCount = candidate
    ? candidate.occurrences.filter((o) => selection[`${o.file}:${o.start}`])
        .length
    : 0;
  const propose = useStore((s) => s.proposeExtraction);
  const proposing = useStore((s) => s.driftProposing);
  const proposal = useStore((s) => s.driftProposal);
  const proposalError = useStore((s) => s.driftProposalError);

  return (
    <div
      // Kept mounted and hidden, like the canvas and the gallery: switching
      // tabs must not reload every preview iframe.
      className={`absolute inset-0 overflow-y-auto ${
        editorTab === "drift" ? "" : "hidden"
      }`}
    >
      {!candidate ? (
        <div className="flex h-full items-center justify-center px-8 text-center text-2xs text-ink-dim">
          Pick something from the Drift tab to see every copy of it here.
        </div>
      ) : (
        <div className="px-8 pb-24 pt-20">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="font-mono text-sm text-ink">
              &lt;{candidate.tag}&gt;
            </span>
            <span className="text-2xs text-ink-dim">
              {candidate.occurrences.length} copies in {candidate.fileCount}{" "}
              file{candidate.fileCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mb-5 text-2xs text-ink-faint">
            {selectedCount} selected · click a copy to include or exclude it.
            {candidate.existing && (
              <span className="text-warn">
                {" "}
                <ExclamationTriangleIcon
                  width={11}
                  height={11}
                  className="inline align-[-1px]"
                />{" "}
                {candidate.existing.name} already exists in{" "}
                {candidate.existing.file}.
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-start gap-5">
            {candidate.occurrences.map((o) => {
              const key = `${o.file}:${o.start}`;
              return (
                <OccurrenceCard
                  key={key}
                  occ={o}
                  origin={origin}
                  selected={!!selection[key]}
                  onToggle={() => toggle(key)}
                />
              );
            })}
          </div>

          <div className="mt-7 flex items-center gap-2">
            <button
              onClick={() => void propose()}
              disabled={proposing || selectedCount < 2}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-2xs font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              <MagicWandIcon width={12} height={12} />
              {proposing
                ? "Designing the component…"
                : `Combine ${selectedCount} into one component`}
            </button>
            {proposalError && (
              <span className="text-2xs text-danger">{proposalError}</span>
            )}
          </div>

          {proposal && (
            <div className="panel mt-4 max-w-3xl overflow-hidden">
              <div className="border-b border-line px-4 py-2.5">
                <div className="text-2xs text-ink">
                  <span className="font-medium">{proposal.name}</span>
                  <span className="text-ink-faint"> · {proposal.file}</span>
                </div>
                {proposal.summary && (
                  <div className="mt-0.5 text-2xs text-ink-dim">
                    {proposal.summary}
                  </div>
                )}
              </div>
              <pre className="overflow-x-auto px-4 py-3 font-mono text-[11px] leading-5 text-ink-dim">
                {proposal.source}
              </pre>
              {proposal.notes && proposal.notes.toLowerCase() !== "none" && (
                <div className="border-t border-line px-4 py-2.5 text-2xs leading-relaxed text-ink-dim">
                  {proposal.notes}
                </div>
              )}
              {/* Honesty over magic: the write-back for this path does not
                  exist, and a disabled Apply with the reason on it is the
                  same answer the merge gates give when they cannot run. */}
              <div className="flex items-center gap-2 border-t border-line bg-surface-2 px-4 py-2.5">
                <button
                  disabled
                  title="The extraction codemod isn't built yet — this proposal is read-only."
                  className="rounded-md bg-surface-3 px-2.5 py-1 text-2xs text-ink-faint"
                >
                  Apply
                </button>
                <span className="text-2xs text-ink-faint">
                  Not writable yet — dedup won't offer an edit it can't land
                  safely. Copy it, or wait for the codemod.
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
