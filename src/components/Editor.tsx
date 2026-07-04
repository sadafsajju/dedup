import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  onDevServerExit,
  onDevServerLog,
  onDevServerReady,
  onDevServerStatus,
  onInstrumentation,
  onScanProgress,
  startDevServer,
  stopDevServer,
} from "../lib/api";
import { useStore } from "../lib/store";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { Canvas } from "./Canvas";
import { Inspector } from "./Inspector";
import { ConsoleDrawer } from "./ConsoleDrawer";
import { ClusterReview } from "./Duplicates";

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
      void useStore.getState().detectClaudeCode();
      if (!startedRef.current) {
        startedRef.current = true;
        setDevStatus("starting");
        try {
          await startDevServer(
            project.root,
            project.packageManager,
            project.framework,
            project.devScript,
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

  // Keyboard (FR-6.4): ⌘S save, ⌘Z/⇧⌘Z undo/redo, ⌘1/2/3 viewports, Esc.
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
        } else return;
        e.preventDefault();
      } else if (e.key === "Escape" && !inField) {
        const s = useStore.getState();
        if (s.openClusterId) s.openCluster(null);
        else if (s.selected) s.clearSelection();
        else s.toggleConsole(false);
      } else if (!inField) {
        // Tool shortcuts (FR-6.4), Figma-style: V select, H hand, B browse.
        const s = useStore.getState();
        if (e.key === "v") s.setTool("select");
        else if (e.key === "h") s.setTool("hand");
        else if (e.key === "b") s.setTool("browse");
        else return;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!project) return null;

  return (
    <div className="relative h-full flex flex-col bg-surface-0">
      <TopBar />
      <div className="flex-1 min-h-0 flex">
        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 flex">
            <Canvas />
            <Inspector />
          </div>
          <ConsoleDrawer />
        </div>
      </div>
      <ClusterReview />
    </div>
  );
}
