import { useEffect, useState } from "react";
import { captureCanvasThumbnail, stopDevServer } from "../lib/api";
import { SetUpGit } from "./SetUpGit";
import { useStore } from "../lib/store";
import { isValueAction } from "../lib/types";
import { VIEWPORTS } from "../lib/types";
import type { DevServerStatus } from "../lib/types";
import {
  ChevronLeftIcon,
  CopyIcon,
  DesktopIcon,
  LaptopIcon,
  MobileIcon,
  Share2Icon,
} from "@radix-ui/react-icons";
import { ReviewPanel } from "./ReviewPanel";
import { AiSwitch } from "./AiSwitch";
import { HistoryButton } from "./History";
import type { IconType } from "./ui";

/** Device glyph per viewport preset (FR-1.4). */
const VIEWPORT_ICON: Record<string, IconType> = {
  mobile: MobileIcon,
  tablet: LaptopIcon,
  desktop: DesktopIcon,
};

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
  const actions = useStore((s) => s.actions);
  const saving = useStore((s) => s.saving);
  const saveError = useStore((s) => s.saveError);
  const notice = useStore((s) => s.notice);
  const discardAllEdits = useStore((s) => s.discardAllEdits);
  const lastSave = useStore((s) => s.lastSave);
  const pendingEdit = useStore((s) => s.pendingEdit);
  const setInspectorTab = useStore((s) => s.setInspectorTab);
  const saveAll = useStore((s) => s.saveAll);
  const scanning = useStore((s) => s.scanning);
  const categorizing = useStore((s) => s.categorizing);
  const runScan = useStore((s) => s.runScan);
  const editorTab = useStore((s) => s.editorTab);
  const driftCount = useStore(
    (s) =>
      s.driftResult?.candidates.find((c) => c.id === s.openDriftId)
        ?.occurrences.length ?? 0,
  );
  const setEditorTab = useStore((s) => s.setEditorTab);
  const selectedRoute = useStore((s) => s.selectedRoute);
  const instrumentation = useStore((s) => s.instrumentation);
  const galleryCount = useStore((s) => s.scanResult?.gallery.length ?? 0);
  // A live, tagged canvas scans one artboard at a time — Scan waits for the
  // user to pick one (click its name). Untagged sessions keep the honest
  // whole-project fallback, so no selection is demanded there.
  const needsArtboard =
    devStatus === "ready" && !!instrumentation?.active && !selectedRoute;
  const dirtyCount = actions.filter(
    (a) => !isValueAction(a) || a.before !== a.after,
  ).length;
  const [reviewOpen, setReviewOpen] = useState(false);

  // Nothing left to review → close the popover.
  useEffect(() => {
    if (dirtyCount === 0) setReviewOpen(false);
  }, [dirtyCount]);

  async function goBack() {
    // Snapshot the canvas first — it's the launch grid's card image, and it
    // has to happen while the project is still rendered.
    if (project) await captureCanvasThumbnail(project.root);
    await stopDevServer();
    backToLaunch();
  }

  const status = STATUS_META[devStatus];

  return (
    // Floating chrome: the canvas runs under it, so the bar carries its own
    // blur and hairline instead of a hard divider against a column layout.
    <header className="panel absolute top-3 left-3 right-3 z-30 h-11 flex items-center gap-3 px-2.5 select-none">
      <button
        onClick={goBack}
        className="flex items-center gap-1 text-ink-dim hover:text-ink text-2xs px-1.5 py-1 rounded hover:bg-surface-2"
        title="Close project"
      >
        <ChevronLeftIcon width={15} height={15} />
      </button>

      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[13px] font-medium truncate">{project?.name}</span>
        {git?.isRepo && (
          <span
            className="inline-flex items-center gap-1 text-2xs text-ink-dim bg-surface-2 rounded px-1.5 py-0.5 shrink-0"
            title={
              git.isDirty
                ? `${git.changedFiles} uncommitted change${git.changedFiles === 1 ? "" : "s"} in this repo. dedup commits only its own files, on its own branch.`
                : "Working tree is clean"
            }
          >
            <Share2Icon width={11} height={11} />
            <span className="font-mono">{git.branch ?? "?"}</span>
            {/* The compatibility card used to be the only place the dirty
                tree was ever mentioned, and it is now skipped on a project
                whose verdict the user has already seen. The signal moves
                here, where it stays visible for the whole session instead of
                flashing past once. */}
            {git.isDirty && (
              <span className="text-warn tabular-nums">
                {git.changedFiles}
                <span className="ml-0.5">●</span>
              </span>
            )}
          </span>
        )}
        {/* No repository: everything can be looked at, nothing can be saved.
            Said here, where it stays visible, with the way out beside it. */}
        {git && !git.isRepo && (
          <span
            className="inline-flex items-center gap-1.5 text-2xs text-warn shrink-0"
            title="dedup saves every change as a commit on its own branch. With no git it can only write into your files in place — it warns before the first save."
          >
            <span>no git — saves overwrite files</span>
            <SetUpGit compact />
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* Top-level view switch: live canvas vs. scanned component gallery. */}
      <div className="flex items-center gap-0.5 bg-surface-2 rounded-[10px] p-0.5">
        {(
          [
            ["canvas", "Canvas"],
            ["components", "Components"],
            ["drift", "Drift"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setEditorTab(id)}
            className={`h-6 px-2.5 rounded-lg text-2xs ${
              editorTab === id
                ? "bg-surface-3 text-ink"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {label}
            {id === "components" && galleryCount > 0 && (
              <span className="ml-1 text-ink-faint tabular-nums">
                {galleryCount}
              </span>
            )}
            {id === "drift" && driftCount > 0 && (
              <span className="ml-1 text-ink-faint tabular-nums">
                {driftCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* Viewport switcher (FR-1.4, FR-6.4 ⌘1/2/3) */}
      <div className="flex items-center gap-0.5 bg-surface-2 rounded-[10px] p-0.5">
        {VIEWPORTS.map((v) => {
          const Icon = VIEWPORT_ICON[v.id];
          return (
            <button
              key={v.id}
              onClick={() => setViewport(v.id)}
              className={`flex h-6 w-7 items-center justify-center rounded-lg ${
                viewportId === v.id
                  ? "bg-surface-3 text-ink"
                  : "text-ink-dim hover:text-ink"
              }`}
              title={`${v.label} · ${v.width}px`}
            >
              <Icon width={13} height={13} />
            </button>
          );
        })}
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
        {/* Whatever the last gesture had to say — what was copied, or why it
            couldn't be. Its own slot, not part of the chain below: a paste
            says something *and* leaves an edit staged, so both must show. */}
        {notice ? (
          <span
            className="max-w-[24rem] truncate rounded-lg bg-surface-2 px-2.5 py-1 text-2xs text-ink-dim"
            title={notice}
          >
            {notice}
          </span>
        ) : null}
        {/* A previewed chat edit is on disk and on the canvas but committed
            to nothing. It has to be visible from outside the chat tab, or a
            user who switched away has uncommitted AI edits and no sign of it. */}
        {pendingEdit?.previewing ? (
          <button
            onClick={() => setInspectorTab("chat")}
            className="rounded-lg px-2.5 py-1 text-2xs bg-accent/15 text-accent hover:bg-accent/25"
            title={`${pendingEdit.summary} — previewing ${pendingEdit.files.length} file${
              pendingEdit.files.length === 1 ? "" : "s"
            }, not committed`}
          >
            AI preview — keep or discard
          </button>
        ) : saveError ? (
          // The reason, not just the fact. It used to live in the button's
          // tooltip, which is where a save that can never succeed became
          // indistinguishable from one worth retrying — and the staged edits
          // block the chat too, so "retry" was the only thing on offer and it
          // was the one thing that could not work.
          <>
            <span
              className="max-w-[22rem] truncate text-2xs text-danger"
              title={saveError}
            >
              Save failed: {saveError}
            </span>
            <button
              onClick={saveAll}
              disabled={saving}
              className="rounded-lg px-2.5 py-1 text-2xs bg-danger/15 text-danger hover:bg-danger/25 disabled:opacity-60"
            >
              Retry
            </button>
            <button
              onClick={discardAllEdits}
              title="Throw the staged edits away. Nothing was written, so there is nothing to put back."
              className="rounded-lg px-2.5 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink"
            >
              Discard edits
            </button>
          </>
        ) : dirtyCount > 0 ? (
          <>
            <button
              onClick={() => setReviewOpen((v) => !v)}
              className={`rounded-lg px-2 py-1 text-2xs ${
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
              className="rounded-lg px-2.5 py-1 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-60"
              title="⌘S"
            >
              {saving ? "Saving…" : "Save ⌘S"}
            </button>
          </>
        ) : lastSave ? (
          <span
            className="text-2xs text-ink-faint px-1.5"
            title={
              lastSave.direct
                ? "Written into the files in place — no git, so no commit"
                : `Committed on ${lastSave.branch}`
            }
          >
            {lastSave.direct ? (
              "Saved in place"
            ) : (
              <>
                Saved <span className="font-mono">{lastSave.hash}</span>
              </>
            )}
          </span>
        ) : null}
        {reviewOpen && <ReviewPanel onClose={() => setReviewOpen(false)} />}
      </div>

      <HistoryButton />

      <AiSwitch />

      <button
        onClick={runScan}
        disabled={scanning || categorizing || needsArtboard}
        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-2xs ${
          scanning || categorizing
            ? "bg-surface-2 text-ink-faint cursor-wait"
            : needsArtboard
              ? "bg-surface-2 text-ink-faint cursor-not-allowed"
              : "bg-surface-2 text-ink-dim hover:text-ink"
        }`}
        title={
          needsArtboard
            ? "Select an artboard first — click its name above the frame"
            : "Scan the selected artboard for duplicate components"
        }
      >
        <CopyIcon
          width={13}
          height={13}
          className={scanning || categorizing ? "animate-pulse" : ""}
        />
        {scanning ? "Scanning…" : categorizing ? "Organizing…" : "Scan"}
      </button>
    </header>
  );
}
