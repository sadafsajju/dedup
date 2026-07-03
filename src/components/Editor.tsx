import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  onDevServerExit,
  onDevServerLog,
  onDevServerReady,
  onDevServerStatus,
  startDevServer,
  stopDevServer,
} from "../lib/api";
import { useStore } from "../lib/store";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { Canvas } from "./Canvas";
import { Inspector } from "./Inspector";
import { ConsoleDrawer } from "./ConsoleDrawer";

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

    (async () => {
      unlisteners.push(await onDevServerLog(appendLog));
      unlisteners.push(
        await onDevServerReady((e) => setDevReady(e.url, e.port)),
      );
      unlisteners.push(
        await onDevServerStatus((e) => {
          if (e.status === "starting") setDevStatus("starting");
          else if (e.status === "stopping") setDevStatus("stopping");
        }),
      );
      unlisteners.push(
        await onDevServerExit((e) => {
          if (e.requested) setDevStatus("stopped");
          else {
            setCrashed(e.code);
            toggleConsole(true); // surface logs on crash (FR-1.6)
          }
        }),
      );

      // Stop the server before the app window closes so we never orphan it.
      const win = getCurrentWindow();
      unlisteners.push(
        await win.onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await stopDevServer();
          } finally {
            await win.destroy();
          }
        }),
      );

      if (disposed) return;
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
        if (s.selected) s.clearSelection();
        else s.toggleConsole(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!project) return null;

  return (
    <div className="h-full flex flex-col bg-surface-0">
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
    </div>
  );
}
