import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  closeAllTerminals,
  onDevServerExit,
  onDevServerLog,
  onDevServerReady,
  onDevServerStatus,
  onInstrumentation,
  startDevServer,
  stopDevServer,
} from "../lib/api";
import { useStore } from "../lib/store";
import { typingInEditor } from "../lib/keys";
import { CLI_AGENTS } from "../lib/types";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { Canvas } from "./Canvas";
import { Inspector } from "./Inspector";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { SessionModal } from "./SessionModal";
import { DirectWritePrompt } from "./DirectWritePrompt";
import { CodePanel } from "./CodePanel";

export function Editor() {
  const project = useStore((s) => s.project);
  const appendLog = useStore((s) => s.appendLog);
  const setDevStatus = useStore((s) => s.setDevStatus);
  const setDevReady = useStore((s) => s.setDevReady);
  const setCrashed = useStore((s) => s.setCrashed);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!project) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    // StrictMode mounts effects twice; listen() resolves after the first
    // cleanup has already run. Register through `track` so late-resolving
    // listeners from a disposed mount unsubscribe immediately instead of
    // leaking (leaked log listeners = every console line rendered twice).
    const track = async (p: Promise<() => void>) => {
      const fn = await p;
      if (disposed) fn();
      else unlisteners.push(fn);
    };

    (async () => {
      await track(onDevServerLog(appendLog));
      await track(onDevServerReady((e) => setDevReady(e.url, e.port)));
      await track(
        onDevServerStatus((e) => {
          if (e.status === "starting") setDevStatus("starting");
          else if (e.status === "stopping") setDevStatus("stopping");
        }),
      );
      await track(
        onInstrumentation((i) => useStore.getState().setInstrumentation(i)),
      );
      await track(
        onDevServerExit((e) => {
          if (e.requested) setDevStatus("stopped");
          else {
            setCrashed(e.code);
            toggleConsole(true); // surface logs on crash (FR-1.6)
          }
        }),
      );

      // Stop the server before the app window closes so we never orphan it.
      const win = getCurrentWindow();
      await track(
        win.onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await stopDevServer();
          } finally {
            await win.destroy();
          }
        }),
      );

      if (disposed) return;
      // Shells belong to the panes that render them. A webview that reloaded
      // under a running app has forgotten its panes, so any shell still open
      // in the core is an orphan nobody can type into.
      void closeAllTerminals();
      // Probe every agent so Settings → AI can say which are installed.
      for (const agent of CLI_AGENTS) {
        void useStore.getState().detectAgent(agent.id);
      }
      void useStore.getState().loadSessionSeed();
      // Read the session branch back for the history panel.
      void useStore.getState().loadHistory();
      if (!startedRef.current) {
        startedRef.current = true;
        setDevStatus("starting");
        try {
          await startDevServer(
            project,
            useStore.getState().customCommand ?? undefined,
          );
        } catch (e) {
          appendLog({ stream: "stderr", line: `dedup: ${String(e)}` });
          setCrashed(null);
        }
      }
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.root]);

  // Keyboard (FR-6.4): ⌘S save, ⌘Z/⇧⌘Z undo/redo, ⌘1/2/3 viewports, Esc,
  // ⌫ delete. Keystrokes inside the canvas iframe arrive here too — the
  // overlay forwards them as synthetic events (see Canvas).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The focused element as well as the target: a keystroke the canvas
      // forwards is replayed on `window`, so its target is never a field.
      const inField = typingInEditor(e.target, document.activeElement);
      if (e.metaKey || e.ctrlKey) {
        const s = useStore.getState();
        if (e.key === "1") s.setViewport("mobile");
        else if (e.key === "2") s.setViewport("tablet");
        else if (e.key === "3") s.setViewport("desktop");
        else if (e.key === "s") void s.saveAll();
        else if (e.key === "z" && !inField) {
          // In fields, let the browser's own text undo work.
          if (e.shiftKey) s.redo();
          else s.undo();
        }
        // Cut/copy/paste act on the selected element (FR-6.4). Only when
        // nothing else has a claim on the gesture: text highlighted anywhere,
        // a field, or a caret in an element on the canvas all mean the user
        // is copying *text*, and the browser's own answer is the right one.
        else if (
          (e.key === "c" || e.key === "x" || e.key === "v") &&
          !inField &&
          s.textEditing === null &&
          (window.getSelection()?.isCollapsed ?? true)
        ) {
          if (e.key === "c") void s.copySelected();
          else if (e.key === "x") void s.cutSelected();
          else void s.pasteClipboard();
        } else return;
        e.preventDefault();
      } else if (e.key === "Escape" && !inField) {
        const s = useStore.getState();
        if (s.codePanel) s.closeCode();
        else if (s.insertKind) s.setInsertKind(null);
        // Escape *while typing* is handled inside the canvas (it puts the
        // original text back), so reaching here means the caret is already
        // gone and only the tool is left to leave.
        else if (s.tool === "text") s.setTool("select");
        // The markup layer takes Escape first while a stroke is in flight
        // (it cancels the stroke); reaching here means there is none, and
        // only the tool is left to leave.
        else if (s.tool === "annotate") s.setTool("select");
        else if (s.selected || s.multi.length > 0) s.clearSelection();
        else s.toggleConsole(false);
      } else if ((e.key === "Delete" || e.key === "Backspace") && !inField) {
        // Delete the selected element (staged like any other edit). Refused
        // elements just do nothing — the inspector says why.
        useStore.getState().removeSelected();
        e.preventDefault();
      } else if (!inField) {
        // Tool shortcuts (FR-6.4), Figma-style: V select, H hand, B browse,
        // T text, A annotate. (The overlay forwards these from inside the
        // canvas, but never while a caret is in an element — see its keydown
        // handler.)
        const s = useStore.getState();
        if (e.key === "v") s.setTool("select");
        else if (e.key === "h") s.setTool("hand");
        else if (e.key === "b") s.setTool("browse");
        else if (e.key === "t") s.setTool("text");
        else if (e.key === "a") s.setTool("annotate");
        else return;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!project) return null;

  return (
    // Full-bleed canvas with the chrome floating over it, rather than docked
    // columns squeezing it. The panels are `position: absolute` siblings, so
    // the artboards keep the whole window and the app being designed is the
    // thing at the centre of the screen.
    <div className="relative h-full bg-surface-0 overflow-hidden">
      <div className="absolute inset-0 flex">
        <Canvas />
      </div>
      <TopBar />
      <Sidebar />
      <CodePanel />
      <Inspector />
      <ConsoleDrawer />
      <SessionModal />
      <DirectWritePrompt />
    </div>
  );
}
