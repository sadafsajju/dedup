// Drift tab (FR-5.10) — repeated JSX subtrees: markup that was never a
// component at all.
//
// Read-only by design, for now. The detector is deterministic and the
// extraction codemod is not built, so this tab shows evidence and jumps to
// source; it never offers a fix it cannot land. That is the same rule the
// merge gates follow — what can't be done safely is shown with a reason.
//
// The one thing it must communicate, because it is the whole finding: copies
// don't just repeat, they *drift*. A row that said "15 copies" would be a
// lint rule. The per-knob value spread is the part nobody can see by looking.
import { useMemo } from "react";
import { useStore } from "../lib/store";
import type { DriftCandidate, DriftClassVariance } from "../lib/types";
import {
  CheckCircledIcon,
  ExclamationTriangleIcon,
  LayersIcon,
  MixerHorizontalIcon,
} from "@radix-ui/react-icons";

/** Distinct values of one knob, most common first, with their counts.
 *  `null` (the copy doesn't set the knob) is a real value and is shown as
 *  such — "8 of them have no disabled state" is a finding, not a gap. */
function spread(values: (string | null)[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v ?? "—";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function KnobRow({ v }: { v: DriftClassVariance }) {
  return (
    <div className="flex items-start gap-1.5 py-0.5">
      <span
        className={`shrink-0 font-mono text-[10px] leading-4 ${
          v.layout ? "text-ink-faint" : "text-ink-dim"
        }`}
        title={
          v.layout
            ? "A layout knob — where the copy was put, not what it is. This stays at the call site."
            : "A visual knob — what the copy is. This becomes a variant."
        }
      >
        {v.knob}
        {v.layout && "*"}
      </span>
      <span className="flex flex-wrap gap-1">
        {spread(v.values).map((s) => (
          <span
            key={s.label}
            className="rounded bg-surface-2 px-1 font-mono text-[10px] leading-4 text-ink"
          >
            {s.label}
            {s.count > 1 && (
              <span className="text-ink-faint"> ×{s.count}</span>
            )}
          </span>
        ))}
      </span>
    </div>
  );
}

function Candidate({ c }: { c: DriftCandidate }) {
  const open = useStore((s) => s.openDriftId) === c.id;
  const openDrift = useStore((s) => s.openDrift);
  const openCode = useStore((s) => s.openCode);

  // Visual knobs first: they're the variants, and the layout ones are a
  // footnote about where the copies were placed.
  const knobs = useMemo(
    () => [...c.varies.classes].sort((a, b) => Number(a.layout) - Number(b.layout)),
    [c.varies.classes],
  );
  const propCount = c.varies.attrs.length + c.varies.texts.length;

  return (
    <div className="border-b border-line">
      <button
        onClick={() => openDrift(open ? null : c.id)}
        className="w-full px-3 py-2 text-left hover:bg-surface-2"
      >
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-surface-2 px-1 font-mono text-[10px] leading-4 text-ink">
            &lt;{c.tag}&gt;
          </span>
          <span className="text-2xs text-ink">
            ×{c.occurrences.length}
          </span>
          <span className="text-2xs text-ink-faint">
            in {c.fileCount} file{c.fileCount === 1 ? "" : "s"}
          </span>
          <span className="flex-1" />
          <span className="text-[10px] text-ink-faint tabular-nums">
            −{c.elementsRemoved} el
          </span>
        </div>
        {c.existing && (
          <div className="mt-1 flex items-start gap-1 text-[10px] leading-4 text-warn">
            <ExclamationTriangleIcon width={11} height={11} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-medium">{c.existing.name}</span> already
              exists — {c.occurrences.length - 1} copies ignore it.
            </span>
          </div>
        )}
        {!open && knobs.length > 0 && (
          <div className="mt-1 truncate text-[10px] text-ink-faint">
            {knobs.length} knob{knobs.length === 1 ? "" : "s"} drifted
            {propCount > 0 && ` · ${propCount} prop${propCount === 1 ? "" : "s"}`}
          </div>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3">
          {knobs.length > 0 ? (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                What drifted
              </div>
              {knobs.map((v, i) => (
                <KnobRow key={`${v.node}-${v.knob}-${i}`} v={v} />
              ))}
              {knobs.some((v) => v.layout) && (
                <div className="mt-1 text-[10px] leading-4 text-ink-faint">
                  * a layout knob — where the copy was placed. That stays at
                  the call site rather than moving into the component.
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-1 py-1 text-[10px] text-ink-faint">
              <CheckCircledIcon width={11} height={11} />
              These copies are byte-identical.
            </div>
          )}

          {propCount > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                Would become props
              </div>
              <div className="flex flex-wrap gap-1">
                {c.varies.attrs.map((a, i) => (
                  <span
                    key={`a${i}`}
                    className="rounded bg-surface-2 px-1 font-mono text-[10px] leading-4 text-ink"
                  >
                    {a.name}
                  </span>
                ))}
                {c.varies.texts.map((_, i) => (
                  <span
                    key={`t${i}`}
                    className="rounded bg-surface-2 px-1 font-mono text-[10px] leading-4 text-ink"
                  >
                    children
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-2 mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            Shared structure
          </div>
          <pre className="overflow-x-auto rounded bg-surface-2 p-1.5 font-mono text-[10px] leading-4 text-ink-dim">
            {c.skeleton}
          </pre>

          <div className="mt-2 mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            Where
          </div>
          {c.occurrences.map((o, i) => (
            <button
              key={i}
              onClick={() => void openCode(o.file, o.line)}
              className="flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left hover:bg-surface-2"
            >
              <span className="truncate font-mono text-[10px] text-ink-dim">
                {o.file}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-ink-faint tabular-nums">
                :{o.line}
              </span>
              {o.component && (
                <span className="shrink-0 truncate text-[10px] text-ink-faint">
                  {o.component}
                </span>
              )}
            </button>
          ))}

          {c.refused.length > 0 && (
            <div className="mt-2 text-[10px] leading-4 text-ink-faint">
              {c.refused.length} more copy
              {c.refused.length === 1 ? "" : "ies"} found but not counted —{" "}
              {c.refused[0].reason}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Sidebar tab body: run state, then the ranked candidate list. */
export function DriftTab() {
  const framework = useStore((s) => s.project?.framework);
  const running = useStore((s) => s.driftRunning);
  const progress = useStore((s) => s.driftProgress);
  const result = useStore((s) => s.driftResult);
  const error = useStore((s) => s.driftError);
  const runDrift = useStore((s) => s.runDrift);

  const totals = useMemo(() => {
    if (!result) return null;
    return result.candidates.reduce(
      (acc, c) => ({
        copies: acc.copies + c.occurrences.length,
        elements: acc.elements + c.elementsRemoved,
      }),
      { copies: 0, elements: 0 },
    );
  }, [result]);

  if (framework === "static") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <MixerHorizontalIcon width={22} height={22} className="text-ink-faint" />
        <div className="text-2xs leading-relaxed text-ink-dim">
          Drift detection reads JSX subtrees, so it has nothing to read in a
          static site.
        </div>
      </div>
    );
  }

  if (running) {
    const pct =
      progress && progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : null;
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <MixerHorizontalIcon
          width={22}
          height={22}
          className="animate-pulse text-ink-faint"
        />
        <div className="text-2xs text-ink-dim">
          {progress?.stage === "grouping" ? "Grouping copies" : "Reading markup"}
          {pct !== null && ` · ${pct}%`}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <ExclamationTriangleIcon width={20} height={20} className="text-danger" />
        <div className="text-2xs break-all text-ink-dim">{error}</div>
        <button onClick={runDrift} className="text-2xs text-accent hover:underline">
          Try again
        </button>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <MixerHorizontalIcon width={22} height={22} className="text-ink-faint" />
        <div className="text-2xs leading-relaxed text-ink-dim">
          Find markup that was written out again instead of reused — the same
          button, card or field pasted across your pages.
        </div>
        <button
          onClick={runDrift}
          className="mt-1 rounded-md bg-accent px-2.5 py-1 text-2xs font-medium text-white hover:brightness-110"
        >
          Find drift
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="border-b border-line px-3 py-2 text-2xs text-ink-faint">
        <span className="text-ink-dim">
          {result.files} file{result.files === 1 ? "" : "s"}
        </span>
        {totals && totals.copies > 0 && (
          <>
            {" · "}
            {result.candidates.length} candidate
            {result.candidates.length === 1 ? "" : "s"} · {totals.copies} copies
          </>
        )}
        {" · "}
        {result.durationMs}ms
      </div>

      {result.candidates.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <CheckCircledIcon width={22} height={22} className="text-ink-faint" />
          <div className="text-2xs leading-relaxed text-ink-dim">
            No repeated markup worth extracting. Anything written out three or
            more times, with enough styling to be worth naming, would show here.
          </div>
          <button onClick={runDrift} className="text-2xs text-accent hover:underline">
            Run again
          </button>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {result.candidates.map((c) => (
              <Candidate key={c.id} c={c} />
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
            <LayersIcon width={11} height={11} />
            <span>
              {totals?.elements} elements would go
            </span>
            <span className="flex-1" />
            <button onClick={runDrift} className="text-accent hover:underline">
              Rerun
            </button>
          </div>
        </>
      )}
    </div>
  );
}
