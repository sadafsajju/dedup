import { useEffect, useRef, useState } from "react";
import { startDevServer, stopDevServer } from "../lib/api";
import { registerCanvasIframe, sendToOverlay } from "../lib/bridge";
import { Toolbar } from "./Toolbar";
import { Artboards, FIELD_OFFSET } from "./Artboards";
import { useStore } from "../lib/store";
import { VIEWPORTS } from "../lib/types";
import type { SelectedElement } from "../lib/types";
import { RefreshIcon } from "./icons";

/** Zoom about a point given in canvas-container coordinates, keeping the
 * point visually fixed (Figma semantics). */
function zoomAt(cx: number, cy: number, factor: number) {
  const s = useStore.getState();
  const next = Math.min(2, Math.max(0.25, s.zoom * factor));
  if (next === s.zoom) return;
  const k = next / s.zoom;
  s.setZoomPan(next, {
    x: cx - (cx - s.pan.x) * k,
    y: cy - (cy - s.pan.y) * k,
  });
}

export function Canvas() {
  const project = useStore((s) => s.project);
  const devStatus = useStore((s) => s.devStatus);
  const devUrl = useStore((s) => s.devUrl);
  const viewportId = useStore((s) => s.viewportId);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const setPan = useStore((s) => s.setPan);
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

  const pageMeta = useStore((s) => s.pageMeta);
  const tool = useStore((s) => s.tool);
  const containerRef = useRef<HTMLDivElement>(null);
  // Space-held hand tool + active drag (space-drag or middle-drag).
  const [spaceHeld, setSpaceHeld] = useState(false);
  const hand = tool === "hand" || spaceHeld;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  // Distinguish zooms we made (cursor-anchored) from TopBar's ± buttons.
  const zoomRef = useRef(zoom);

  // Overlay → editor messages (FR-2.2): selections, page size, and wheel
  // events forwarded from inside the iframe so panning works over the page.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.__dedup !== true) return;
      if (m.type === "selected") {
        useStore.getState().setSelected(m.payload as SelectedElement);
      } else if (m.type === "page-size") {
        useStore.getState().setContentHeight(m.height as number);
      } else if (m.type === "page-meta") {
        useStore.getState().setPageMeta({
          title: (m.title as string) ?? "",
          path: (m.path as string) ?? "/",
        });
      } else if (m.type === "overlay-ready") {
        // Fresh overlay (first load or full-reload HMR) defaults to inspect —
        // re-assert the currently selected tool.
        const { tool } = useStore.getState();
        sendToOverlay({
          type: "set-mode",
          mode: tool === "browse" ? "browse" : "inspect",
        });
      } else if (m.type === "wheel") {
        const s = useStore.getState();
        if (m.zoomMod) {
          // Iframe-local coords → container coords: frame origin is at pan.
          zoomAt(
            s.pan.x + (m.x as number) * s.zoom,
            s.pan.y + (m.y as number) * s.zoom,
            Math.exp(-(m.dy as number) * 0.01),
          );
          zoomRef.current = useStore.getState().zoom; // cursor-anchored, skip recenter
        } else {
          s.setPan({
            x: s.pan.x - (m.dx as number),
            y: s.pan.y - (m.dy as number),
          });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Wheel on the canvas surface: pan; with ⌘/Ctrl (or pinch): zoom to cursor.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.metaKey || e.ctrlKey) {
        zoomAt(
          e.clientX - rect.left,
          e.clientY - rect.top,
          Math.exp(-e.deltaY * 0.01),
        );
        zoomRef.current = useStore.getState().zoom; // cursor-anchored, skip recenter
      } else {
        const s = useStore.getState();
        s.setPan({ x: s.pan.x - e.deltaX, y: s.pan.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // TopBar ± buttons change zoom without a cursor — keep the center fixed.
  useEffect(() => {
    if (zoomRef.current === zoom) return;
    const from = zoomRef.current;
    zoomRef.current = zoom;
    const el = containerRef.current;
    if (!el || !from) return;
    const { width, height } = el.getBoundingClientRect();
    const k = zoom / from;
    const s = useStore.getState();
    setPan({
      x: width / 2 - (width / 2 - s.pan.x) * k,
      y: height / 2 - (height / 2 - s.pan.y) * k,
    });
  }, [zoom, setPan]);

  // Space = hand tool (FR-6.1), Figma-style. Ignored while typing.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      setSpaceHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Center the frame when the canvas first shows or the viewport changes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !devUrl) return;
    const { width } = el.getBoundingClientRect();
    const z = useStore.getState().zoom;
    setPan({ x: Math.max((width - viewport.width * z) / 2, 24), y: 40 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devUrl, viewportId]);

  // A FRESH scan just landed → bring the artboard field into view. Restored
  // scans (project reopen) render in place without yanking the canvas.
  const scanSeq = useStore((s) => s.scanSeq);
  useEffect(() => {
    if (scanSeq === 0) return;
    const s = useStore.getState();
    if (!s.scanResult || s.scanResult.gallery.length === 0) return;
    setPan({ x: -(viewport.width + FIELD_OFFSET) * s.zoom + 80, y: 64 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanSeq]);

  function startDrag(e: React.PointerEvent<HTMLElement>) {
    dragRef.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveDrag(e: React.PointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (!d) return;
    const s = useStore.getState();
    s.setPan({ x: s.pan.x + e.clientX - d.x, y: s.pan.y + e.clientY - d.y });
    dragRef.current = { x: e.clientX, y: e.clientY };
  }
  function endDrag() {
    dragRef.current = null;
    setDragging(false);
  }

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
      ref={containerRef}
      className="flex-1 min-w-0 relative overflow-hidden bg-surface-0"
      style={{
        backgroundImage:
          "radial-gradient(circle, var(--color-line) 1px, transparent 1px)",
        // Dot grid moves and scales with the canvas (Figma feel).
        backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
        touchAction: "none",
      }}
      onPointerDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          startDrag(e);
        }
      }}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
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
        <>
          {httpsWarning && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 max-w-md rounded-md border border-warn/40 bg-surface-1 px-3 py-2 text-2xs text-warn shadow-lg">
              dedup couldn't tunnel this self-signed HTTPS dev server (see
              console), so the canvas may stay blank. Re-open the project with
              a custom dev command that serves plain HTTP.
            </div>
          )}
          {/* Frame label (Figma artboard name): pans with the frame but keeps
              constant size — positioned in container space, not scaled. */}
          <div
            className="absolute flex items-baseline gap-1.5 text-2xs select-none pointer-events-none"
            style={{
              left: pan.x,
              top: pan.y - 22,
              maxWidth: Math.max(viewport.width * zoom, 160),
            }}
          >
            <span className="text-ink-dim truncate">
              {pageMeta?.title || project?.name || "Page"}
            </span>
            {pageMeta && pageMeta.path !== "/" && (
              <span className="text-ink-faint font-mono truncate shrink-0">
                {pageMeta.path}
              </span>
            )}
            <span className="text-ink-faint shrink-0">
              {viewport.label} · {viewport.width}
            </span>
          </div>
          {/* Pannable surface: frame origin lives at `pan`, scaled by zoom. */}
          <div
            className="absolute top-0 left-0 will-change-transform"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            <div
              className="shadow-2xl bg-white rounded-md overflow-hidden"
              style={{ width: viewport.width, height: frameHeight }}
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
            {/* Rendered component artboards from the last scan (FR-5.3). */}
            <Artboards />
          </div>
          {/* Space-held hand tool: catches drags everywhere, including over
              the iframe (which would otherwise swallow pointer events). */}
          {hand && (
            <div
              className="absolute inset-0 z-20"
              style={{ cursor: dragging ? "grabbing" : "grab" }}
              onPointerDown={(e) => {
                if (e.button === 0) startDrag(e);
              }}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          )}
          <Toolbar />
        </>
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
