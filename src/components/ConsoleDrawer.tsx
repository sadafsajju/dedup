import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useStore, type TerminalTab } from "../lib/store";
import {
  closeTerminal,
  onTerminalExit,
  openTerminal,
  resizeTerminal,
  writeTerminal,
} from "../lib/api";
import {
  ChevronRightIcon,
  CodeIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
  PlusIcon,
} from "@radix-ui/react-icons";

/** Live xterm instances by tab key — the toolbar's Clear needs to reach the
 * one on screen, and xterm objects are not store state. */
const xterms = new Map<number, Terminal>();

export function ConsoleDrawer() {
  const logs = useStore((s) => s.logs);
  const open = useStore((s) => s.consoleOpen);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const clearLogs = useStore((s) => s.clearLogs);
  const errors = useStore((s) => s.errors);
  const tab = useStore((s) => s.consoleTab);
  const setTab = useStore((s) => s.setConsoleTab);
  const height = useStore((s) => s.consoleHeight);
  const setHeight = useStore((s) => s.setConsoleHeight);
  const terminals = useStore((s) => s.terminals);
  const newTerminal = useStore((s) => s.newTerminal);
  const closeTab = useStore((s) => s.closeTerminalTab);

  // Parsed build errors, not "lines on stderr": dev servers print banners and
  // warnings there constantly, and a count that cries wolf is worse than none.
  const errorCount = errors.length;

  // Drag the top edge to resize. The cap keeps the canvas (and the toolbar
  // that rides above the drawer) on screen.
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const max = window.innerHeight * 0.75;
    const move = (ev: PointerEvent) =>
      setHeight(Math.min(max, startH + startY - ev.clientY));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Shells number by order of opening ("zsh", "zsh 2"), so two tabs never
  // share a label.
  const labels = new Map<number, string>();
  const seen = new Map<string, number>();
  for (const t of terminals) {
    const base = t.title || "shell";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    labels.set(t.key, n === 1 ? base : `${base} ${n}`);
  }

  return (
    // Floats with the rest of the chrome. Collapsed it is a small pill in the
    // bottom-left corner; open it grows into a panel that never covers the
    // toolbar (which lifts out of its way — see Toolbar).
    <div
      className={`panel absolute bottom-3 left-3 z-30 overflow-hidden ${
        open ? "right-3" : ""
      }`}
    >
      {open && (
        <div
          onPointerDown={startResize}
          className="absolute inset-x-0 top-0 h-1.5 cursor-row-resize z-10"
          title="Drag to resize"
        />
      )}
      <div className="h-8 flex items-center gap-1 pr-2 text-2xs text-ink-dim select-none">
        <button
          onClick={() => toggleConsole()}
          className="h-full flex items-center gap-2 pl-3 pr-2 hover:text-ink"
        >
          <ChevronRightIcon
            width={14}
            height={14}
            className={`transition-transform ${open ? "rotate-90" : ""}`}
          />
          <CodeIcon width={13} height={13} />
          <span>Console</span>
          {!open && (
            <>
              <span className="text-ink-faint">({logs.length})</span>
              {errorCount > 0 && (
                <span className="text-danger">
                  · {errorCount} {errorCount === 1 ? "error" : "errors"}
                </span>
              )}
              {terminals.length > 0 && (
                <span className="text-ink-faint">
                  · {terminals.length}{" "}
                  {terminals.length === 1 ? "terminal" : "terminals"}
                </span>
              )}
            </>
          )}
        </button>

        {open && (
          <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
            <TabButton active={tab === "output"} onClick={() => setTab("output")}>
              Dev server
              <span className="text-ink-faint">({logs.length})</span>
              {errorCount > 0 && (
                <span className="text-danger">· {errorCount}</span>
              )}
            </TabButton>
            {terminals.map((t) => (
              <TabButton
                key={t.key}
                active={tab === t.key}
                onClick={() => setTab(t.key)}
                onClose={() => closeTab(t.key)}
              >
                <span className={t.exited !== undefined ? "text-ink-faint" : ""}>
                  {labels.get(t.key)}
                </span>
              </TabButton>
            ))}
            <button
              onClick={newTerminal}
              title="New terminal in the project folder"
              className="shrink-0 h-6 w-6 grid place-items-center rounded-control text-ink-faint hover:text-ink hover:bg-surface-3"
            >
              <PlusIcon width={12} height={12} />
            </button>
          </div>
        )}

        <span className="flex-1" />
        {open && tab === "output" && logs.length > 0 && (
          <button onClick={clearLogs} className="text-ink-faint hover:text-ink px-1.5">
            Clear
          </button>
        )}
        {open && tab !== "output" && (
          <button
            onClick={() => xterms.get(tab)?.clear()}
            title="Clear (⌘K)"
            className="text-ink-faint hover:text-ink px-1.5"
          >
            Clear
          </button>
        )}
      </div>

      {/* Always mounted, hidden when collapsed: a terminal's shell lives as
          long as its pane does, and folding the drawer away is not closing
          the terminal. */}
      <div
        style={{ height }}
        className={`relative border-t border-line ${open ? "" : "hidden"}`}
      >
        <OutputPane visible={open && tab === "output"} />
        {terminals.map((t) => (
          <TerminalPane key={t.key} tab={t} visible={open && tab === t.key} />
        ))}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  onClose,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      onAuxClick={(e) => {
        // Middle-click closes, as in every tabbed terminal.
        if (e.button === 1 && onClose) onClose();
      }}
      className={`group shrink-0 h-6 flex items-center gap-1.5 rounded-control px-2 cursor-default ${
        active ? "bg-surface-3 text-ink" : "hover:text-ink hover:bg-surface-2"
      }`}
    >
      {children}
      {onClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close terminal"
          className={`-mr-1 h-4 w-4 grid place-items-center rounded text-ink-faint hover:text-ink hover:bg-surface-2 ${
            active ? "" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <Cross2Icon width={10} height={10} />
        </button>
      )}
    </div>
  );
}

/** The dev server's own stream, with the build errors parsed out of it above. */
function OutputPane({ visible }: { visible: boolean }) {
  const logs = useStore((s) => s.logs);
  const errors = useStore((s) => s.errors);
  const askAiToFix = useStore((s) => s.askAiToFix);
  // No selection needed: the agent reads the project itself, which is the
  // only workable answer when the error is *why* nothing rendered.
  const canAsk = useStore((s) => s.activeAiBackend() !== null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Auto-scroll to bottom while the user is pinned there.
  useEffect(() => {
    if (visible && pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, visible]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? "" : "hidden"}`}>
      {/* The errors themselves, above the raw stream: what is broken now,
          separate from everything the dev server has ever said. */}
      {errors.length > 0 && (
        <div className="shrink-0 max-h-[40%] overflow-y-auto border-b border-line bg-danger/5">
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
                      ? "Send this error to the chat"
                      : "Switch on an AI backend first (Settings → AI, ⌘,)"
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
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto px-3 py-1.5 font-mono text-2xs leading-[1.5] select-text"
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
              {l.line || " "}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * One shell. The pane owns the PTY: mounting opens it in the project root,
 * unmounting (closing the tab, leaving the project) hangs it up. Nothing else
 * in dedup — the chat agent least of all — can write to it.
 */
function TerminalPane({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  const root = useStore((s) => s.project?.root);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !root) return;
    const { updateTerminal, closeTerminalTab } = useStore.getState();
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: true,
      // ⌥ as Meta, so ⌥← / ⌥→ move by word in the shell as in Terminal.app.
      macOptionIsMeta: true,
      theme: {
        background: "#00000000",
        foreground: "#ededf0",
        cursor: "#ededf0",
        selectionBackground: "#2b8fff55",
        black: "#26262c",
        brightBlack: "#6b6b76",
        red: "#f2555a",
        green: "#34d399",
        yellow: "#f0b34a",
        blue: "#2b8fff",
        white: "#c9c9d0",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    xterms.set(tab.key, term);

    let id: number | null = null;
    let exited = false;
    let disposed = false;
    let unlistenExit: (() => void) | null = null;

    const refit = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    };
    refit();

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.metaKey && e.key === "k") {
        term.clear();
        return false;
      }
      return true;
    });
    const subs = [
      term.onData((data) => {
        // Like Terminal.app: once the shell is gone, a key closes the tab.
        if (exited) closeTerminalTab(tab.key);
        else if (id !== null) void writeTerminal(id, data);
      }),
      term.onResize(({ cols, rows }) => {
        if (id !== null) void resizeTerminal(id, cols, rows);
      }),
    ];

    // Size changes from every direction — the drawer dragged, the window
    // resized, the pane shown after being hidden — all arrive here.
    const ro = new ResizeObserver(refit);
    ro.observe(host);

    void onTerminalExit((e) => {
      if (e.id !== id) return;
      exited = true;
      id = null;
      updateTerminal(tab.key, { exited: e.code });
      term.write(
        `\r\n\x1b[2m[process exited${
          e.code === null ? "" : ` with code ${e.code}`
        } — press any key to close]\x1b[0m\r\n`,
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlistenExit = fn;
    });

    openTerminal(root, term.cols, term.rows, (bytes) => {
      if (!disposed) term.write(bytes);
    })
      .then((o) => {
        // StrictMode (and a tab closed in the first few ms) can unmount the
        // pane before its shell exists — close the orphan straight away.
        if (disposed) {
          void closeTerminal(o.id);
          return;
        }
        id = o.id;
        updateTerminal(tab.key, { title: o.shell });
        // The pane may have been resized while the shell was starting.
        void resizeTerminal(o.id, term.cols, term.rows);
      })
      .catch((err) => {
        if (!disposed) term.write(`\x1b[31mCould not start a shell: ${err}\x1b[0m\r\n`);
      });

    return () => {
      disposed = true;
      ro.disconnect();
      subs.forEach((s) => s.dispose());
      unlistenExit?.();
      if (id !== null) void closeTerminal(id);
      xterms.delete(tab.key);
      termRef.current = null;
      term.dispose();
    };
    // The pane is the terminal's lifetime: keyed by tab, never re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Showing a terminal hands it the keyboard, as switching tabs does in any
  // terminal app.
  useEffect(() => {
    if (visible) requestAnimationFrame(() => termRef.current?.focus());
  }, [visible]);

  return (
    <div className={`absolute inset-0 pl-3 pr-1 py-1.5 ${visible ? "" : "invisible"}`}>
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
