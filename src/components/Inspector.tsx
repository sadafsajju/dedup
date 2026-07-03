import { useStore } from "../lib/store";

export function Inspector() {
  const project = useStore((s) => s.project);

  return (
    <aside className="w-64 shrink-0 flex flex-col border-l border-line bg-surface-1">
      <div className="h-9 shrink-0 flex items-center px-3 border-b border-line">
        <span className="text-2xs uppercase tracking-wider text-ink-faint">
          Inspector
        </span>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
        <div className="text-2xs text-ink-dim leading-relaxed">
          Select an element on the canvas to inspect and tune its Tailwind
          classes.
        </div>
        <div className="text-2xs text-ink-faint">
          Selection &amp; the Figma-style controls arrive in{" "}
          <span className="text-ink">Phase 1–2</span>.
        </div>
      </div>

      <div className="border-t border-line px-3 py-2 text-2xs text-ink-faint flex items-center justify-between">
        <span>{project?.hasTailwind ? "Tailwind detected" : "No Tailwind"}</span>
        <span className="font-mono">{project?.framework}</span>
      </div>
    </aside>
  );
}
