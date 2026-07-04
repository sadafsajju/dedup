import { useEffect, useState } from "react";
import { stopDevServer } from "../lib/api";
import { useStore } from "../lib/store";
import { VIEWPORTS } from "../lib/types";
import type { DevServerStatus } from "../lib/types";
import { ChevronIcon, GitBranchIcon, DuplicatesIcon } from "./icons";
import { ReviewPanel } from "./ReviewPanel";
import { AiSwitch } from "./AiSwitch";

const STATUS_META: Record<DevServerStatus, { label: string; dot: string }> = {
  idle: { label: "Idle", dot: "bg-ink-faint" },
  starting: { label: "Starting", dot: "bg-warn animate-pulse" },
  ready: { label: "Running", dot: "bg-positive" },
  stopping: { label: "Stopping", dot: "bg-warn" },
  stopped: { label: "Stopped", dot: "bg-ink-faint" },
  crashed: { label: "Crashed", dot: "bg-danger" },
};

export function TopBar() {
  const project = useStore((s) => s.project);
  const git = useStore((s) => s.git);
  const devStatus = useStore((s) => s.devStatus);
  const devPort = useStore((s) => s.devPort);
  const viewportId = useStore((s) => s.viewportId);
  const setViewport = useStore((s) => s.setViewport);
  const backToLaunch = useStore((s) => s.backToLaunch);
  const staged = useStore((s) => s.staged);
  const saving = useStore((s) => s.saving);
  const saveError = useStore((s) => s.saveError);
  const lastSave = useStore((s) => s.lastSave);
  const saveAll = useStore((s) => s.saveAll);
  const scanning = useStore((s) => s.scanning);
  const categorizing = useStore((s) => s.categorizing);
  const runScan = useStore((s) => s.runScan);
  const dirtyCount = Object.values(staged).filter(
    (e) => e.current !== e.original,
  ).length;
  const [reviewOpen, setReviewOpen] = useState(false);

  // Nothing left to review → close the popover.
  useEffect(() => {
    if (dirtyCount === 0) setReviewOpen(false);
  }, [dirtyCount]);

  async function goBack() {
    await stopDevServer();
    backToLaunch();
  }

  const status = STATUS_META[devStatus];

  return (
    <header className="h-11 shrink-0 flex items-center gap-3 px-3 border-b border-line bg-surface-1 select-none">
      <button
        onClick={goBack}
        className="flex items-center gap-1 text-ink-dim hover:text-ink text-2xs px-1.5 py-1 rounded hover:bg-surface-2"
        title="Close project"
      >
        <ChevronIcon size={14} className="rotate-180" />
      </button>

      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[13px] font-medium truncate">{project?.name}</span>
        {git?.isRepo && (
          <span className="inline-flex items-center gap-1 text-2xs text-ink-dim bg-surface-2 rounded px-1.5 py-0.5 shrink-0">
            <GitBranchIcon size={11} />
            <span className="font-mono">{git.branch ?? "?"}</span>
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* Viewport switcher (FR-1.4, FR-6.4 ⌘1/2/3) */}
      <div className="flex items-center gap-0.5 bg-surface-2 rounded-md p-0.5">
        {VIEWPORTS.map((v) => (
          <button
            key={v.id}
            onClick={() => setViewport(v.id)}
            className={`text-2xs px-2 py-1 rounded ${
              viewportId === v.id
                ? "bg-surface-3 text-ink"
                : "text-ink-dim hover:text-ink"
            }`}
            title={`${v.label} · ${v.width}px`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Dev-server status */}
      <div className="flex items-center gap-1.5 text-2xs text-ink-dim px-2">
        <span className={`h-2 w-2 rounded-full ${status.dot}`} />
        <span>{status.label}</span>
        {devPort && devStatus === "ready" && (
          <span className="font-mono text-ink-faint">:{devPort}</span>
        )}
      </div>

      {/* Save state + staged-diff review (FR-3.7, FR-4.5) */}
      <div className="relative flex items-center gap-1.5">
        {saveError ? (
          <button
            onClick={saveAll}
            className="rounded-md px-2.5 py-1 text-2xs bg-danger/15 text-danger hover:bg-danger/25"
            title={saveError}
          >
            Save failed — retry
          </button>
        ) : dirtyCount > 0 ? (
          <>
            <button
              onClick={() => setReviewOpen((v) => !v)}
              className={`rounded-md px-2 py-1 text-2xs ${
                reviewOpen
                  ? "bg-surface-3 text-ink"
                  : "bg-surface-2 text-ink-dim hover:text-ink"
              }`}
              title="Review staged changes"
            >
              {dirtyCount} edit{dirtyCount === 1 ? "" : "s"}
            </button>
            <button
              onClick={saveAll}
              disabled={saving}
              className="rounded-md px-2.5 py-1 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-60"
              title="⌘S"
            >
              {saving ? "Saving…" : "Save ⌘S"}
            </button>
          </>
        ) : lastSave ? (
          <span
            className="text-2xs text-ink-faint px-1.5"
            title={`Committed on ${lastSave.branch}`}
          >
            Saved <span className="font-mono">{lastSave.hash}</span>
          </span>
        ) : null}
        {reviewOpen && <ReviewPanel onClose={() => setReviewOpen(false)} />}
      </div>

      <AiSwitch />

      <button
        onClick={runScan}
        disabled={scanning || categorizing}
        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-2xs ${
          scanning || categorizing
            ? "bg-surface-2 text-ink-faint cursor-wait"
            : "bg-surface-2 text-ink-dim hover:text-ink"
        }`}
        title="Find duplicate components and auto-organize the canvas"
      >
        <DuplicatesIcon
          size={13}
          className={scanning || categorizing ? "animate-pulse" : ""}
        />
        {scanning ? "Scanning…" : categorizing ? "Organizing…" : "Scan"}
      </button>
    </header>
  );
}
