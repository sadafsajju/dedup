import { useEffect, useRef } from "react";
import { useStore } from "../lib/store";
import {
  ChevronRightIcon,
  CodeIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";

export function ConsoleDrawer() {
  const logs = useStore((s) => s.logs);
  const open = useStore((s) => s.consoleOpen);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const clearLogs = useStore((s) => s.clearLogs);
  const errors = useStore((s) => s.errors);
  const askAiToFix = useStore((s) => s.askAiToFix);
  const canAsk = useStore((s) => s.selected !== null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Auto-scroll to bottom while the user is pinned there.
  useEffect(() => {
    if (open && pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, open]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  // Parsed build errors, not "lines on stderr": dev servers print banners and
  // warnings there constantly, and a count that cries wolf is worse than none.
  const errorCount = errors.length;

  return (
    // Floats with the rest of the chrome. Collapsed it is a small pill in the
    // bottom-left corner; open it grows into a panel that never covers the
    // toolbar (which lifts out of its way — see Toolbar).
    <div
      className={`panel absolute bottom-3 left-3 z-30 overflow-hidden ${
        open ? "right-3" : ""
      }`}
    >
      <button
        onClick={() => toggleConsole()}
        className="w-full h-8 flex items-center gap-2 px-3 text-2xs text-ink-dim hover:text-ink select-none"
      >
        <ChevronRightIcon
          width={14}
          height={14}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        <CodeIcon width={13} height={13} />
        <span>Console</span>
        <span className="text-ink-faint">({logs.length})</span>
        {errorCount > 0 && (
          <span className="text-danger">
            · {errorCount} {errorCount === 1 ? "error" : "errors"}
          </span>
        )}
        <span className="flex-1" />
        {open && logs.length > 0 && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              clearLogs();
            }}
            className="text-ink-faint hover:text-ink px-1.5"
          >
            Clear
          </span>
        )}
      </button>

      {/* The errors themselves, above the raw stream: what is broken now,
          separate from everything the dev server has ever said. */}
      {open && errors.length > 0 && (
        <div className="max-h-40 overflow-y-auto border-t border-line bg-danger/5">
          {errors.map((e) => (
            <div key={e.id} className="px-3 py-2 border-b border-line/60 last:border-b-0">
              <div className="flex items-start gap-2">
                <ExclamationTriangleIcon
                  width={12}
                  height={12}
                  className="text-danger shrink-0 mt-0.5"
                />
                <pre className="flex-1 whitespace-pre-wrap break-words font-mono text-2xs text-ink-dim select-text leading-relaxed">
                  {e.content}
                </pre>
                <button
                  onClick={askAiToFix}
                  disabled={!canAsk}
                  title={
                    canAsk
                      ? "Send this error to the inspector chat"
                      : "Select an element first — the chat edits one file at a time"
                  }
                  className="shrink-0 rounded border border-line px-1.5 py-0.5 text-2xs text-ink-dim hover:text-ink disabled:opacity-40"
                >
                  Ask AI
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-52 overflow-auto px-3 pb-2 font-mono text-2xs leading-[1.5]"
        >
          {logs.length === 0 ? (
            <div className="text-ink-faint py-2">No output yet.</div>
          ) : (
            logs.map((l, i) => (
              <div
                key={i}
                className={
                  l.stream === "stderr" ? "text-danger/90" : "text-ink-dim"
                }
              >
                {l.line || " "}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
