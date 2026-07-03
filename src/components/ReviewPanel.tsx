// Live review of staged (unsaved) edits — what ⌘S will write, shown as
// token-level class diffs with per-element revert. The pre-save half of the
// PRD's "every change is reviewable" trust story.
import { useStore } from "../lib/store";
import { parseDedupId } from "../lib/types";
import type { StagedEdit } from "../lib/types";
import { XIcon } from "./icons";

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

function DiffRow({ edit }: { edit: StagedEdit }) {
  const revertEdit = useStore((s) => s.revertEdit);
  const selectById = useStore((s) => s.selectById);
  const { removed, added, kept } = tokenDiff(edit.original, edit.current);
  const src = parseDedupId(edit.dedupId);

  return (
    <div className="px-3 py-2.5 border-b border-line last:border-b-0">
      <div className="flex items-center gap-2">
        <button
          onClick={() => selectById(edit.dedupId)}
          className="text-2xs font-medium text-ink hover:text-accent truncate"
          title="Select on canvas"
        >
          {edit.component ?? "element"}
        </button>
        {src && (
          <span className="text-2xs font-mono text-ink-faint truncate">
            {src.file.split("/").pop()}:{src.line}
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={() => revertEdit(edit.dedupId)}
          className="text-ink-faint hover:text-danger p-0.5 rounded shrink-0"
          title="Discard this edit"
        >
          <XIcon size={12} />
        </button>
      </div>
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
    </div>
  );
}

export function ReviewPanel({ onClose }: { onClose: () => void }) {
  const staged = useStore((s) => s.staged);
  const saveAll = useStore((s) => s.saveAll);
  const saving = useStore((s) => s.saving);
  const dirty = Object.values(staged).filter((e) => e.current !== e.original);

  return (
    <div className="absolute top-full right-0 mt-1.5 w-80 max-h-96 flex flex-col rounded-lg border border-line bg-surface-1 shadow-2xl z-50">
      <div className="flex items-center px-3 py-2 border-b border-line">
        <span className="text-2xs uppercase tracking-wider text-ink-faint">
          Staged changes
        </span>
        <span className="flex-1" />
        <button
          onClick={onClose}
          className="text-ink-faint hover:text-ink p-0.5 rounded"
        >
          <XIcon size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {dirty.length === 0 ? (
          <div className="px-3 py-4 text-2xs text-ink-faint text-center">
            Nothing staged — all edits saved or reverted.
          </div>
        ) : (
          dirty.map((e) => <DiffRow key={e.dedupId} edit={e} />)
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
