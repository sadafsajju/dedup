import { useStore } from "../lib/store";
import { parseDedupId } from "../lib/types";
import { ChevronIcon } from "./icons";

export function Inspector() {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  const selectById = useStore((s) => s.selectById);

  // Ancestry arrives innermost-first; breadcrumb reads root-first (FR-2.4).
  const crumbs = selected ? [...selected.ancestry].reverse() : [];
  const src = selected ? parseDedupId(selected.dedupId) : null;

  return (
    <aside className="w-64 shrink-0 flex flex-col border-l border-line bg-surface-1">
      <div className="h-9 shrink-0 flex items-center px-3 border-b border-line">
        <span className="text-2xs uppercase tracking-wider text-ink-faint">
          Inspector
        </span>
      </div>

      {selected ? (
        <div className="flex-1 overflow-y-auto">
          {/* Selection header (FR-3.1 seed) */}
          <div className="px-3 py-3 border-b border-line">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold truncate">
                {selected.component ?? selected.tag}
              </span>
              <span className="text-2xs font-mono text-ink-faint bg-surface-2 rounded px-1 py-0.5">
                {selected.tag}
              </span>
              {selected.instanceCount > 1 && (
                <span
                  className="text-2xs text-warn bg-warn/10 rounded px-1.5 py-0.5 shrink-0"
                  title="This source element renders multiple DOM instances (e.g. inside a .map()). Edits affect all of them."
                >
                  ×{selected.instanceCount}
                </span>
              )}
            </div>
            {src && (
              <div className="mt-1.5 text-2xs font-mono text-ink-dim truncate">
                {src.file}
                <span className="text-ink-faint">
                  :{src.line}:{src.col}
                </span>
              </div>
            )}
          </div>

          {/* Component ancestry breadcrumb (FR-2.4) */}
          <div className="px-3 py-3 border-b border-line">
            <div className="text-2xs uppercase tracking-wider text-ink-faint mb-2">
              Ancestry
            </div>
            <div className="flex flex-wrap items-center gap-y-1">
              {crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1;
                return (
                  <span key={`${c.dedupId}-${i}`} className="flex items-center">
                    <button
                      onClick={() => !isLast && selectById(c.dedupId)}
                      disabled={isLast}
                      className={`text-2xs rounded px-1 py-0.5 ${
                        isLast
                          ? "text-ink font-medium"
                          : "text-ink-dim hover:text-ink hover:bg-surface-2"
                      }`}
                      title={c.dedupId}
                    >
                      {c.component ?? c.tag}
                      {c.component && (
                        <span className="text-ink-faint"> · {c.tag}</span>
                      )}
                    </button>
                    {!isLast && (
                      <ChevronIcon size={11} className="text-ink-faint mx-0.5" />
                    )}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="px-3 py-3 text-2xs text-ink-faint leading-relaxed">
            Style controls (layout, size, typography, fill) land in Phase 2 —
            the Tailwind class editor writes back to source from here.
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
          <div className="text-2xs text-ink-dim leading-relaxed">
            Click an element on the canvas to inspect it. Hover shows the
            component under the cursor.
          </div>
        </div>
      )}

      <div className="border-t border-line px-3 py-2 text-2xs text-ink-faint flex items-center justify-between">
        <span>{project?.hasTailwind ? "Tailwind detected" : "No Tailwind"}</span>
        <span className="font-mono">{project?.framework}</span>
      </div>
    </aside>
  );
}
