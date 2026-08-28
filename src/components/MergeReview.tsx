// Guarded-merge review (FR-5.4 → FR-5.7).
//
// This screen is the consent step of the whole product. Everything else dedup
// does is one file, undoable from the canvas; a merge rewrites components and
// their call sites across the project. So the screen is built around one rule:
// **nothing is claimed here that isn't shown.** The proposal's source is
// editable, every changed file is diffed in full, every warning the codemod
// raised is printed, and once it lands each gate reports its real verdict —
// including "couldn't run", which is never dressed up as a pass.
import { useMemo, useState } from "react";
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  FileIcon,
  MinusCircledIcon,
  Pencil1Icon,
  ReloadIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { useStore } from "../lib/store";
import { diffLines, diffStat, toHunks } from "../lib/diff";
import type { GateResult, MergeChange, MergeSession } from "../lib/types";
import type { IconType } from "./ui";

const KIND_LABEL: Record<MergeChange["kind"], string> = {
  canonical: "rewritten",
  created: "new file",
  callsite: "call sites",
  retired: "retired",
};

const KIND_TONE: Record<MergeChange["kind"], string> = {
  canonical: "text-accent",
  created: "text-positive",
  callsite: "text-ink-dim",
  retired: "text-warn",
};

/** One file's before/after, collapsed to hunks the way a patch reads. */
function FileDiff({ change }: { change: MergeChange }) {
  const [open, setOpen] = useState(true);
  const { hunks, stat } = useMemo(() => {
    const lines = diffLines(change.before, change.after);
    return { hunks: toHunks(lines), stat: diffStat(lines) };
  }, [change.before, change.after]);

  return (
    <div className="rounded-lg border border-line bg-surface-1 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2"
      >
        <FileIcon width={12} height={12} className="text-ink-faint shrink-0" />
        <span className="font-mono text-2xs truncate">{change.file}</span>
        <span className={`text-2xs shrink-0 ${KIND_TONE[change.kind]}`}>
          {KIND_LABEL[change.kind]}
        </span>
        <span className="flex-1" />
        <span className="text-2xs tabular-nums shrink-0">
          <span className="text-positive">+{stat.added}</span>{" "}
          <span className="text-danger">−{stat.removed}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-line overflow-x-auto">
          {hunks.length === 0 ? (
            <div className="px-3 py-2 text-2xs text-ink-faint">
              No textual change.
            </div>
          ) : (
            hunks.map((hunk, i) => (
              <div key={i}>
                {i > 0 && (
                  <div className="px-3 py-0.5 text-[10px] text-ink-faint bg-surface-2/60">
                    ⋯
                  </div>
                )}
                {hunk.lines.map((line, j) => (
                  <div
                    key={j}
                    className={`flex font-mono text-[11px] leading-[1.45] ${
                      line.op === "add"
                        ? "bg-positive/10"
                        : line.op === "remove"
                          ? "bg-danger/10"
                          : ""
                    }`}
                  >
                    <span className="w-10 shrink-0 select-none px-1 text-right text-ink-faint tabular-nums">
                      {line.before ?? ""}
                    </span>
                    <span className="w-10 shrink-0 select-none px-1 text-right text-ink-faint tabular-nums">
                      {line.after ?? ""}
                    </span>
                    <span
                      className={`w-4 shrink-0 select-none text-center ${
                        line.op === "add"
                          ? "text-positive"
                          : line.op === "remove"
                            ? "text-danger"
                            : "text-ink-faint"
                      }`}
                    >
                      {line.op === "add" ? "+" : line.op === "remove" ? "−" : " "}
                    </span>
                    <pre className="flex-1 whitespace-pre pr-3 text-ink">
                      {line.text || " "}
                    </pre>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const GATE_ICON: Record<GateResult["status"], IconType> = {
  passed: CheckCircledIcon,
  failed: CrossCircledIcon,
  skipped: MinusCircledIcon,
};

const GATE_TONE: Record<GateResult["status"], string> = {
  passed: "text-positive",
  failed: "text-danger",
  skipped: "text-warn",
};

const GATE_TITLE: Record<GateResult["kind"], string> = {
  typecheck: "Typecheck",
  build: "Build",
  visual: "Visual regression",
};

function GateRow({ gate }: { gate: GateResult }) {
  const [open, setOpen] = useState(gate.status === "failed");
  const Icon = GATE_ICON[gate.status];
  return (
    <div className="rounded-lg border border-line bg-surface-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <Icon width={14} height={14} className={GATE_TONE[gate.status]} />
        <span className="text-xs">{GATE_TITLE[gate.kind]}</span>
        <span className={`text-2xs ${GATE_TONE[gate.status]}`}>
          {gate.status}
        </span>
        <span className="flex-1" />
        {gate.command && (
          <span className="font-mono text-[10px] text-ink-faint truncate max-w-[45%]">
            {gate.command}
          </span>
        )}
        {gate.durationMs > 0 && (
          <span className="text-[10px] text-ink-faint tabular-nums shrink-0">
            {(gate.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </button>
      {open && gate.output && (
        <pre className="border-t border-line px-3 py-2 text-[11px] leading-snug text-ink-dim whitespace-pre-wrap max-h-64 overflow-auto">
          {gate.output}
        </pre>
      )}
    </div>
  );
}

/** Header line: what is being merged into what. */
function MergeHeading({ merge }: { merge: MergeSession }) {
  const target = merge.proposal?.name ?? merge.plan?.canonicalSuggestion.name;
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium truncate">
        Merge {merge.members.map((m) => m.name).join(", ")}
        {target ? ` → ${target}` : ""}
      </div>
      {merge.proposal?.summary && (
        <div className="text-2xs text-ink-dim truncate">
          {merge.proposal.summary}
        </div>
      )}
    </div>
  );
}

function Busy({ label }: { label: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
      <ReloadIcon width={20} height={20} className="text-accent animate-spin" />
      <div className="text-xs text-ink-dim">{label}</div>
    </div>
  );
}

export function MergeReview() {
  const merge = useStore((s) => s.merge);
  const cancelMerge = useStore((s) => s.cancelMerge);
  const confirmMerge = useStore((s) => s.confirmMerge);
  const repropose = useStore((s) => s.reproposeMerge);
  const editProposal = useStore((s) => s.editProposal);
  const [editing, setEditing] = useState<string | null>(null);

  if (!merge) return null;

  const stage = merge.stage;
  const preview = merge.preview;

  return (
    <div className="absolute inset-0 z-40 bg-black/45 backdrop-blur-[2px] flex items-center justify-center p-8">
      <div className="panel w-full max-w-5xl h-full flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 h-12 border-b border-line shrink-0">
          <MergeHeading merge={merge} />
          <span className="flex-1" />
          {stage === "review" && (
            <>
              <button
                onClick={() => void repropose()}
                className="rounded-md px-2.5 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink"
                title="Ask the model for a different canonical component"
              >
                Re-propose
              </button>
              <button
                onClick={() => void confirmMerge()}
                className="rounded-md px-3 py-1 text-2xs font-medium bg-accent text-white hover:brightness-110"
              >
                Merge &amp; run checks
              </button>
            </>
          )}
          <button
            onClick={cancelMerge}
            className="text-ink-faint hover:text-ink ml-1"
            title="Close"
          >
            <Cross2Icon width={15} height={15} />
          </button>
        </div>

        {stage === "planning" && <Busy label="Reading the components and tracing their call sites…" />}
        {stage === "proposing" && (
          <Busy label="Designing the canonical component — this is the one step a model does." />
        )}
        {stage === "applying" && (
          <Busy
            label={
              merge.rollbackReason
                ? `Rolling back — ${merge.rollbackReason}`
                : "Writing the merge and committing it…"
            }
          />
        )}

        {stage === "failed" && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-10">
            <ExclamationTriangleIcon width={22} height={22} className="text-danger" />
            <div className="text-xs text-ink-dim max-w-lg">{merge.error}</div>
            <div className="flex gap-2">
              {merge.plan && (
                <button
                  onClick={() => void repropose()}
                  className="rounded-md px-3 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink"
                >
                  Try again
                </button>
              )}
              <button
                onClick={cancelMerge}
                className="rounded-md px-3 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {(stage === "review" ||
          stage === "gating" ||
          stage === "done" ||
          stage === "rolledback") && (
          <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-3">
            {/* Outcome banner, once there is one. */}
            {stage === "done" && (
              <div className="rounded-lg border border-positive/40 bg-positive/10 px-3 py-2 text-xs text-positive">
                Merged and committed as{" "}
                <span className="font-mono">{merge.commit}</span>. Every check
                that could run, passed — undo it any time from History.
              </div>
            )}
            {stage === "rolledback" && (
              <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                Rolled back: {merge.rollbackReason}. Your project is exactly as
                it was — the merge commit was undone and the retired files put
                back.
              </div>
            )}

            {/* FR-5.8: behaviour differences are stated before approval. */}
            {merge.plan?.behaviorDiff.differs && stage === "review" && (
              <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                <div className="font-medium">
                  These components differ in behaviour, not just markup.
                </div>
                <div className="mt-0.5 text-2xs opacity-90">
                  {merge.plan.behaviorDiff.detail}
                </div>
                <div className="mt-1 text-2xs opacity-90">
                  Read the canonical component below and check the behaviour
                  survived before merging.
                </div>
              </div>
            )}

            {/* Anything the model wanted the reviewer to know. */}
            {merge.proposal?.notes.length ? (
              <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-2xs text-ink-dim">
                <div className="text-ink mb-1">Notes from the proposal</div>
                <ul className="list-disc pl-4 flex flex-col gap-0.5">
                  {merge.proposal.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Codemod warnings — things it did differently than asked. */}
            {preview?.warnings.length ? (
              <div className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-2xs text-warn">
                <ul className="list-disc pl-4 flex flex-col gap-0.5">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Gates. */}
            {(stage === "gating" || merge.gates.length > 0) && (
              <div className="flex flex-col gap-2">
                <div className="text-2xs text-ink-dim">
                  Safety gates — a merge only stays if none of these fail
                </div>
                {merge.gates.map((g) => (
                  <GateRow key={g.kind + g.command} gate={g} />
                ))}
                {merge.runningGate && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-line bg-surface-1 text-xs text-ink-dim">
                    <ReloadIcon width={13} height={13} className="animate-spin text-accent" />
                    Running {GATE_TITLE[merge.runningGate].toLowerCase()}…
                  </div>
                )}
              </div>
            )}

            {/* Prop mapping — how each old call site is reproduced. */}
            {merge.proposal && (
              <div className="rounded-lg border border-line bg-surface-1 px-3 py-2">
                <div className="text-2xs text-ink-dim mb-1.5">
                  How each call site is reproduced
                </div>
                <div className="flex flex-col gap-1">
                  {merge.proposal.mapping.map((m) => {
                    const props = Object.entries(m.props);
                    return (
                      <div key={m.name} className="flex items-baseline gap-2 text-2xs">
                        <span className="font-mono text-ink w-40 shrink-0 truncate">
                          &lt;{m.name} …&gt;
                        </span>
                        <span className="text-ink-faint">→</span>
                        <span className="font-mono text-ink truncate">
                          &lt;{merge.proposal!.name} …
                          {props.length > 0 && (
                            <span className="text-accent">
                              {" "}
                              {props
                                .map(([k, v]) =>
                                  typeof v === "string" ? `${k}="${v}"` : `${k}={${v}}`,
                                )
                                .join(" ")}
                            </span>
                          )}
                          &gt;
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* The canonical component, editable — the reviewer has the pen. */}
            {merge.proposal && stage === "review" && (
              <div className="rounded-lg border border-line bg-surface-1 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
                  <span className="font-mono text-2xs">{merge.proposal.file}</span>
                  <span className="flex-1" />
                  {editing === null ? (
                    <button
                      onClick={() => setEditing(merge.proposal!.source)}
                      className="inline-flex items-center gap-1 text-2xs text-ink-dim hover:text-ink"
                    >
                      <Pencil1Icon width={12} height={12} /> Edit
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => setEditing(null)}
                        className="text-2xs text-ink-dim hover:text-ink"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          const next = editing;
                          setEditing(null);
                          void editProposal(next);
                        }}
                        className="rounded px-2 py-0.5 text-2xs bg-accent text-white hover:brightness-110"
                      >
                        Use this
                      </button>
                    </>
                  )}
                </div>
                {editing === null ? (
                  <pre className="px-3 py-2 text-[11px] leading-[1.45] font-mono whitespace-pre overflow-auto max-h-80 text-ink">
                    {merge.proposal.source}
                  </pre>
                ) : (
                  <textarea
                    value={editing}
                    onChange={(e) => setEditing(e.target.value)}
                    spellCheck={false}
                    className="w-full h-80 px-3 py-2 bg-surface-2 text-[11px] leading-[1.45] font-mono text-ink outline-none resize-none"
                  />
                )}
              </div>
            )}

            {/* Every file the merge touches. */}
            {preview && (
              <>
                <div className="flex items-center gap-2 text-2xs text-ink-dim">
                  <span>
                    {preview.changes.length} file
                    {preview.changes.length === 1 ? "" : "s"} change
                    {preview.changes.length === 1 ? "s" : ""}
                    {preview.callSiteFiles > 0 &&
                      ` · ${preview.callSiteFiles} with call sites`}
                  </span>
                  {preview.retired.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-warn">
                      <TrashIcon width={11} height={11} />
                      {preview.retired.length} staged for deletion
                    </span>
                  )}
                </div>
                {preview.changes.map((c) => (
                  <FileDiff key={c.kind + c.file} change={c} />
                ))}
              </>
            )}

            {/* Members the codemod refused to retire, and why. */}
            {preview?.leftBehind.length ? (
              <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-2xs text-ink-dim">
                Left in place (the file declares other things too):{" "}
                {preview.leftBehind.map((l) => `${l.name} in ${l.file}`).join(", ")}
                . Their call sites moved to the canonical component; the
                declarations are now unused and safe to delete by hand.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
