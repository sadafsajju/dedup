import { useEffect, useRef, useState } from "react";
import { startDevServer, stopDevServer } from "../lib/api";
import { registerCanvasIframe } from "../lib/bridge";
import { useStore } from "../lib/store";
import { VIEWPORTS } from "../lib/types";
import type { SelectedElement } from "../lib/types";
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
  const contentHeight = useStore((s) => s.contentHeight);

  // Frame shows the full page (Figma-style): at least the device height,
  // grown to the page's natural height, sanity-capped for runaway layouts.
  const minHeight = viewport.height ?? 800;
  const frameHeight = Math.min(Math.max(minHeight, contentHeight ?? 0), 12000);

  // Overlay → editor messages (FR-2.2): element selections from the iframe.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.__dedup !== true) return;
      if (m.type === "selected") {
        useStore.getState().setSelected(m.payload as SelectedElement);
      } else if (m.type === "page-size") {
        useStore.getState().setContentHeight(m.height as number);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
    try {
      await startDevServer(
        project.root,
        project.packageManager,
        project.framework,
        project.devScript,
        useStore.getState().customCommand ?? undefined,
      );
    } catch {
      setDevStatus("crashed");
    }
  }

  const booting =
    devStatus === "starting" || (devStatus === "idle" && !devUrl);
  const crashed = devStatus === "crashed";

  // Surface a hint if the server runs but we never spot a ready URL (FR-1.6).
  const [slowStart, setSlowStart] = useState(false);
  useEffect(() => {
    if (!booting) {
      setSlowStart(false);
      return;
    }
    const t = setTimeout(() => setSlowStart(true), 20_000);
    return () => clearTimeout(t);
  }, [booting]);

  // Self-signed https is normally fronted by dedup's plain-HTTP tunnel, so a
  // still-https URL here means the tunnel failed — warn instead of leaving the
  // user with a silently blank canvas.
  const httpsWarning = devUrl?.startsWith("https://") ?? false;

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
            {useStore.getState().customCommand ??
              `${project?.packageManager} run dev`}
          </div>
          {slowStart && (
            <div className="mt-5 max-w-xs text-center">
              <p className="text-2xs text-warn">
                Still waiting for a ready URL. The server may be running but
                printing an address dedup doesn't recognize.
              </p>
              <button
                onClick={() => toggleConsole(true)}
                className="mt-2 rounded-md px-3 py-1.5 text-2xs bg-surface-2 hover:bg-surface-3 text-ink"
              >
                Open console
              </button>
            </div>
          )}
        </CenteredPanel>
      ) : (
        <div className="min-h-full flex items-start justify-center p-10 relative">
          {httpsWarning && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 max-w-md rounded-md border border-warn/40 bg-surface-1 px-3 py-2 text-2xs text-warn shadow-lg">
              dedup couldn't tunnel this self-signed HTTPS dev server (see
              console), so the canvas may stay blank. Re-open the project with
              a custom dev command that serves plain HTTP.
            </div>
          )}
          {/* Wrapper reserves the *scaled* size so canvas scrolling stays
              correct at any zoom with tall full-page frames. */}
          <div
            className="shrink-0"
            style={{
              width: viewport.width * zoom,
              height: frameHeight * zoom,
            }}
          >
            <div
              className="shadow-2xl bg-white rounded-md overflow-hidden"
              style={{
                width: viewport.width,
                height: frameHeight,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
              }}
            >
              <iframe
                ref={(el) => {
                  iframeRef.current = el;
                  registerCanvasIframe(el);
                }}
                src={devUrl}
                title="app-canvas"
                className="w-full h-full border-0 bg-white"
              />
            </div>
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
