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

  // Keyboard: ⌘1/2/3 viewport presets, Esc closes console (FR-6.4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "1") useStore.getState().setViewport("mobile");
        else if (e.key === "2") useStore.getState().setViewport("tablet");
        else if (e.key === "3") useStore.getState().setViewport("desktop");
        else return;
        e.preventDefault();
      } else if (e.key === "Escape") {
        useStore.getState().toggleConsole(false);
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
