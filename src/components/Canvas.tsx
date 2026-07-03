import { useEffect, useRef } from "react";
import { startDevServer, stopDevServer } from "../lib/api";
import { useStore } from "../lib/store";
import { VIEWPORTS } from "../lib/types";
import { RefreshIcon } from "./icons";

export function Canvas() {
  const project = useStore((s) => s.project);
  const devStatus = useStore((s) => s.devStatus);
  const devUrl = useStore((s) => s.devUrl);
  const viewportId = useStore((s) => s.viewportId);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const exitCode = useStore((s) => s.exitCode);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const setDevStatus = useStore((s) => s.setDevStatus);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const viewport = VIEWPORTS.find((v) => v.id === viewportId)!;

  // ⌘/Ctrl + scroll to zoom the canvas (FR-6.1).
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom(useStore.getState().zoom * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  async function restart() {
    if (!project) return;
    await stopDevServer();
    setDevStatus("starting");
    // Remount the iframe on next ready by clearing url handled via store elsewhere.
    try {
      await startDevServer(project.root, project.packageManager);
    } catch {
      setDevStatus("crashed");
    }
  }

  const booting =
    devStatus === "starting" || (devStatus === "idle" && !devUrl);
  const crashed = devStatus === "crashed";

  return (
    <div
      ref={scrollAreaRef}
      className="flex-1 min-w-0 relative overflow-auto bg-surface-0"
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--color-line) 1px, transparent 1px)",
        backgroundSize: "22px 22px",
      }}
    >
      {crashed ? (
        <CenteredPanel>
          <div className="text-danger font-medium text-[13px]">
            Dev server {exitCode === null ? "failed to start" : `exited (code ${exitCode})`}
          </div>
          <p className="text-2xs text-ink-dim mt-1.5 max-w-xs text-center">
            Check the console for the error, then restart once it's resolved.
          </p>
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => toggleConsole(true)}
              className="rounded-md px-3 py-1.5 text-2xs bg-surface-2 hover:bg-surface-3 text-ink"
            >
              Open console
            </button>
            <button
              onClick={restart}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-2xs bg-accent text-white hover:brightness-110"
            >
              <RefreshIcon size={13} /> Restart
            </button>
          </div>
        </CenteredPanel>
      ) : booting || !devUrl ? (
        <CenteredPanel>
          <Spinner />
          <div className="text-2xs text-ink-dim mt-3">
            Starting dev server…
          </div>
          <div className="text-2xs text-ink-faint mt-1 font-mono">
            {project?.packageManager} run dev
          </div>
        </CenteredPanel>
      ) : (
        <div className="min-h-full flex items-start justify-center p-10">
          <div
            className="shadow-2xl bg-white rounded-md overflow-hidden shrink-0"
            style={{
              width: viewport.width,
              height: viewport.height ?? "calc(100vh - 200px)",
              transform: `scale(${zoom})`,
              transformOrigin: "top center",
            }}
          >
            <iframe
              ref={iframeRef}
              src={devUrl}
              title="app-canvas"
              className="w-full h-full border-0 bg-white"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function CenteredPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center">
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-6 w-6 rounded-full border-2 border-line-strong border-t-accent animate-spin" />
  );
}
