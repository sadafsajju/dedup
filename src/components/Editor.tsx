import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  onDevServerExit,
  onDevServerLog,
  onDevServerReady,
  onDevServerStatus,
  onInstrumentation,
  onDriftProgress,
  onScanProgress,
  startDevServer,
  stopDevServer,
} from "../lib/api";
import { useStore } from "../lib/store";
import { CLI_AGENTS } from "../lib/types";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { Canvas } from "./Canvas";
import { ComponentsView } from "./ComponentsView";
import { DriftView } from "./DriftView";
import { Inspector } from "./Inspector";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { SessionModal } from "./SessionModal";
import { ClusterReview } from "./Duplicates";
import { MergeReview } from "./MergeReview";
import { HistoryPanel } from "./History";
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
        onScanProgress((p) => useStore.getState().setScanProgress(p)),
      );
      await track(
        onDriftProgress((p) => useStore.getState().setDriftProgress(p)),
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
      // A previous session's scan renders immediately instead of demanding
      // a rescan every time the project is reopened.
      void useStore.getState().restoreScan();
      void useStore.getState().restoreDrift();
      // Probe every agent so the AI switch can say which are installed.
      for (const agent of CLI_AGENTS) {
        void useStore.getState().detectAgent(agent.id);
      }
      void useStore.getState().loadSessionSeed();
      // The history panel is the session branch read back, and the trash tray
      // may hold files a previous session staged — both are project state, so
      // they load with the project rather than on first open.
      void useStore.getState().loadHistory();
      void useStore.getState().loadTrash();
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
      const inField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
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
        // A merge in flight owns Escape first — it is the modal on top, and
        // dismissing something under it would leave it stranded.
        if (s.merge) {
          // Only when it is safe to walk away: mid-apply, closing would
          // orphan a rollback the user still needs to see.
          if (s.merge.stage !== "applying" && s.merge.stage !== "gating") {
            s.cancelMerge();
          }
        } else if (s.historyOpen) s.toggleHistory(false);
        else if (s.codePanel) s.closeCode();
        else if (s.openClusterId) s.openCluster(null);
        else if (s.insertKind) s.setInsertKind(null);
        // Escape *while typing* is handled inside the canvas (it puts the
        // original text back), so reaching here means the caret is already
        // gone and only the tool is left to leave.
        else if (s.tool === "text") s.setTool("select");
        else if (s.selected) s.clearSelection();
        else s.toggleConsole(false);
      } else if ((e.key === "Delete" || e.key === "Backspace") && !inField) {
        // Delete the selected element (staged like any other edit). Refused
        // elements just do nothing — the inspector says why.
        useStore.getState().removeSelected();
        e.preventDefault();
      } else if (!inField) {
        // Tool shortcuts (FR-6.4), Figma-style: V select, H hand, B browse,
        // T text. (The overlay forwards these from inside the canvas, but
        // never while a caret is in an element — see its keydown handler.)
        const s = useStore.getState();
        if (e.key === "v") s.setTool("select");
        else if (e.key === "h") s.setTool("hand");
        else if (e.key === "b") s.setTool("browse");
        else if (e.key === "t") s.setTool("text");
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
        {/* Canvas and ComponentsView both stay mounted (hidden via CSS) so
            switching tabs never reloads the app or harness iframes. */}
        <Canvas />
        <ComponentsView />
        <DriftView />
      </div>
      <TopBar />
      <Sidebar />
      <CodePanel />
      <Inspector />
      <ConsoleDrawer />
      <ClusterReview />
      <MergeReview />
      <HistoryPanel />
      <SessionModal />
    </div>
  );
}
