import { useEffect, useRef } from "react";
import { useStore } from "../lib/store";
import { ChevronIcon, TerminalIcon } from "./icons";

export function ConsoleDrawer() {
  const logs = useStore((s) => s.logs);
  const open = useStore((s) => s.consoleOpen);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const clearLogs = useStore((s) => s.clearLogs);
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

  const errorCount = logs.filter((l) => l.stream === "stderr").length;

  return (
    <div className="shrink-0 border-t border-line bg-surface-1">
      <button
        onClick={() => toggleConsole()}
        className="w-full h-8 flex items-center gap-2 px-3 text-2xs text-ink-dim hover:text-ink select-none"
      >
        <ChevronIcon
          size={13}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        <TerminalIcon size={13} />
        <span>Console</span>
        <span className="text-ink-faint">({logs.length})</span>
        {errorCount > 0 && (
          <span className="text-danger">· {errorCount} err</span>
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
