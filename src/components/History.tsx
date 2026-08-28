// Session history (FR-5.7) and the staged-deletion tray (FR-5.5).
//
// Every dedup write is a commit on the session branch, so this panel is simply
// that branch, read back — no parallel undo log that could disagree with git.
// The revert it offers is the same one the gates use on a failed merge:
// restore exactly the paths that commit touched, and commit *that*, leaving
// the user's own in-flight work alone.
import { useEffect, useState } from "react";
import {
  CounterClockwiseClockIcon,
  Cross2Icon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { useStore } from "../lib/store";

function HistoryRow({
  hash,
  subject,
  when,
  files,
  isMerge,
}: {
  hash: string;
  subject: string;
  when: string;
  files: string[];
  isMerge: boolean;
}) {
  const revertEntry = useStore((s) => s.revertEntry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="px-3 py-2 border-b border-line last:border-0">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] text-ink-faint shrink-0">{hash}</span>
        <span className={`text-2xs truncate ${isMerge ? "text-ink" : "text-ink-dim"}`}>
          {subject.replace(/^dedup:\s*/, "")}
        </span>
        <span className="flex-1" />
        <span className="text-[10px] text-ink-faint shrink-0">{when}</span>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await revertEntry(hash);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink hover:bg-surface-2 disabled:opacity-50"
          title="Restore the files this commit touched to their previous state"
        >
          {busy ? "Undoing…" : "Undo"}
        </button>
      </div>
      <div className="mt-0.5 pl-[3.1rem] text-[10px] text-ink-faint truncate">
        {files.slice(0, 3).join(", ")}
        {files.length > 3 && ` +${files.length - 3} more`}
      </div>
      {error && (
        <div className="mt-1 pl-[3.1rem] text-[10px] text-danger">{error}</div>
      )}
    </div>
  );
}

/** Files a merge staged for deletion — deleted only on explicit confirmation. */
function TrashTray() {
  const trash = useStore((s) => s.trash);
  const restoreTrash = useStore((s) => s.restoreTrash);
  const emptyTrash = useStore((s) => s.emptyTrash);
  const [confirming, setConfirming] = useState(false);

  if (trash.length === 0) return null;

  return (
    <div className="border-t border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <TrashIcon width={12} height={12} className="text-warn" />
        <span className="text-2xs text-ink">
          {trash.length} file{trash.length === 1 ? "" : "s"} staged for deletion
        </span>
        <span className="flex-1" />
        <button
          onClick={() => void restoreTrash()}
          className="text-[10px] text-ink-dim hover:text-ink"
        >
          Restore all
        </button>
        {confirming ? (
          <button
            onClick={() => {
              setConfirming(false);
              void emptyTrash();
            }}
            className="rounded px-1.5 py-0.5 text-[10px] bg-danger/20 text-danger hover:bg-danger/30"
          >
            Delete permanently
          </button>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="text-[10px] text-ink-dim hover:text-ink"
          >
            Empty
          </button>
        )}
      </div>
      <div className="mt-1 text-[10px] text-ink-faint">
        {trash.map((f) => f.path).join(", ")}
      </div>
      <div className="mt-1 text-[10px] text-ink-faint">
        They live in <span className="font-mono">.dedup-trash/</span> until you
        say otherwise — the merge commit already removed them from the tree.
      </div>
    </div>
  );
}

export function HistoryPanel() {
  const open = useStore((s) => s.historyOpen);
  const toggle = useStore((s) => s.toggleHistory);
  const history = useStore((s) => s.history);
  const trashCount = useStore((s) => s.trash.length);
  const loadTrash = useStore((s) => s.loadTrash);

  useEffect(() => {
    if (open) void loadTrash();
  }, [open, loadTrash]);

  if (!open) return null;

  return (
    <div className="panel absolute right-3 top-16 z-40 w-[26rem] max-h-[70vh] flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line shrink-0">
        <CounterClockwiseClockIcon width={13} height={13} className="text-ink-dim" />
        <span className="text-2xs text-ink">Session history</span>
        <span className="flex-1" />
        <button
          onClick={() => toggle(false)}
          className="text-ink-faint hover:text-ink"
        >
          <Cross2Icon width={13} height={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {history.length === 0 ? (
          <div className="px-3 py-6 text-center text-2xs text-ink-faint">
            Nothing committed yet this session. Every save and every merge lands
            here as its own commit.
          </div>
        ) : (
          history.map((h) => <HistoryRow key={h.hash} {...h} />)
        )}
      </div>
      {trashCount > 0 && <TrashTray />}
    </div>
  );
}

/** Top-bar entry point. */
export function HistoryButton() {
  const toggle = useStore((s) => s.toggleHistory);
  const open = useStore((s) => s.historyOpen);
  const trashCount = useStore((s) => s.trash.length);
  return (
    <button
      onClick={() => toggle()}
      className={`relative flex h-6 w-7 items-center justify-center rounded-lg ${
        open ? "bg-surface-3 text-ink" : "text-ink-dim hover:text-ink hover:bg-surface-2"
      }`}
      title="Session history — every dedup commit, individually undoable"
    >
      <CounterClockwiseClockIcon width={14} height={14} />
      {trashCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-warn" />
      )}
    </button>
  );
}
