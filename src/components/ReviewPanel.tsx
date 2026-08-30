// Live review of the staged (unsaved) edit program — what ⌘S will write, in
// application order, with per-action revert. The pre-save half of the PRD's
// "every change is reviewable" trust story.
import { useStore } from "../lib/store";
import { isValueAction } from "../lib/types";
import type { EditAction } from "../lib/types";
import { Cross2Icon } from "@radix-ui/react-icons";

function tokenDiff(original: string, current: string) {
  const o = original.split(/\s+/).filter(Boolean);
  const c = current.split(/\s+/).filter(Boolean);
  const oSet = new Set(o);
  const cSet = new Set(c);
  return {
    removed: o.filter((t) => !cSet.has(t)),
    added: c.filter((t) => !oSet.has(t)),
    kept: c.filter((t) => oSet.has(t)),
  };
}

/** How a structural action reads in one line. */
function structuralSummary(action: EditAction): string {
  switch (action.kind) {
    case "remove":
      return `Delete ${action.label}`;
    case "insert":
      return `Add ${action.label} ${action.position} ${action.target.dedupId.split("/").pop()}`;
    case "move":
      return `Move ${action.label} ${action.position === "inside" ? "into" : action.position} ${action.to.dedupId.split("/").pop()}`;
    default:
      return "";
  }
}

function Row({ action, index }: { action: EditAction; index: number }) {
  const revertAction = useStore((s) => s.revertAction);
  const selectById = useStore((s) => s.selectById);
  const file = action.target.file.split("/").pop();

  return (
    <div className="px-3 py-2.5 border-b border-line last:border-b-0">
      <div className="flex items-center gap-2">
        <button
          onClick={() => selectById(action.target.dedupId)}
          className="text-2xs font-medium text-ink hover:text-accent truncate"
          title="Select on canvas"
        >
          {isValueAction(action)
            ? (action.component ?? "element")
            : structuralSummary(action)}
        </button>
        <span className="text-2xs font-mono text-ink-faint truncate">{file}</span>
        <span className="flex-1" />
        <button
          onClick={() => revertAction(index)}
          className="text-ink-faint hover:text-danger p-0.5 rounded shrink-0"
          title="Discard this edit"
        >
          <Cross2Icon width={12} height={12} />
        </button>
      </div>
      {action.kind === "class" && <ClassDiff action={action} />}
      {action.kind === "text" && (
        <div className="mt-1.5 font-mono text-2xs leading-tight select-text">
          <span className="px-1 py-0.5 rounded bg-danger/10 text-danger line-through decoration-danger/60">
            {action.before || "(empty)"}
          </span>{" "}
          <span className="px-1 py-0.5 rounded bg-positive/10 text-positive">
            {action.after || "(empty)"}
          </span>
        </div>
      )}
    </div>
  );
}

function ClassDiff({
  action,
}: {
  action: Extract<EditAction, { kind: "class" }>;
}) {
  const { removed, added, kept } = tokenDiff(action.before, action.after);
  return (
    <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-2xs leading-tight select-text">
      {removed.map((t, i) => (
        <span
          key={`r${i}`}
          className="px-1 py-0.5 rounded bg-danger/10 text-danger line-through decoration-danger/60"
        >
          {t}
        </span>
      ))}
      {added.map((t, i) => (
        <span
          key={`a${i}`}
          className="px-1 py-0.5 rounded bg-positive/10 text-positive"
        >
          {t}
        </span>
      ))}
      {removed.length === 0 && added.length === 0 && (
        <span className="text-ink-faint">reordered only</span>
      )}
      {kept.length > 0 && (
        <span className="text-ink-faint px-1 py-0.5" title={kept.join(" ")}>
          +{kept.length} unchanged
        </span>
      )}
    </div>
  );
}

export function ReviewPanel({ onClose }: { onClose: () => void }) {
  const actions = useStore((s) => s.actions);
  const saveAll = useStore((s) => s.saveAll);
  const saving = useStore((s) => s.saving);
  const discardAllEdits = useStore((s) => s.discardAllEdits);
  // A class scrubbed back to where it started is staged but not a change.
  const dirty = actions
    .map((action, index) => ({ action, index }))
    .filter(
      ({ action }) => !isValueAction(action) || action.before !== action.after,
    );

  return (
    <div className="absolute top-full right-0 mt-1.5 w-80 max-h-96 flex flex-col rounded-lg border border-line bg-surface-1 shadow-2xl z-50">
      <div className="flex items-center px-3 py-2 border-b border-line">
        <span className="text-2xs uppercase tracking-wider text-ink-faint">
          Staged changes
        </span>
        <span className="flex-1" />
        {dirty.length > 0 && (
          <button
            onClick={discardAllEdits}
            disabled={saving}
            title="Throw every staged edit away. Nothing here has been written, so there is nothing to put back."
            className="mr-1 rounded px-1.5 py-0.5 text-2xs text-ink-faint hover:text-danger disabled:opacity-40"
          >
            Discard all
          </button>
        )}
        <button
          onClick={onClose}
          className="text-ink-faint hover:text-ink p-0.5 rounded"
        >
          <Cross2Icon width={13} height={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {dirty.length === 0 ? (
          <div className="px-3 py-4 text-2xs text-ink-faint text-center">
            Nothing staged — all edits saved or reverted.
          </div>
        ) : (
          dirty.map(({ action, index }) => (
            <Row key={index} action={action} index={index} />
          ))
        )}
      </div>

      {dirty.length > 0 && (
        <div className="px-3 py-2 border-t border-line flex justify-end">
          <button
            onClick={saveAll}
            disabled={saving}
            className="rounded-md px-3 py-1 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-60"
          >
            {saving ? "Saving…" : `Save ${dirty.length} ⌘S`}
          </button>
        </div>
      )}
    </div>
  );
}
