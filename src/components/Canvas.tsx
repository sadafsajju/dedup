import { useEffect, useRef, useState } from "react";
import { startDevServer, stopDevServer } from "../lib/api";
import {
  registerCanvasIframe,
  routeOfWindow,
  sendToFrame,
  sendToOverlay,
} from "../lib/bridge";
import { Toolbar } from "./Toolbar";
import { PAGE_GAP, useStore } from "../lib/store";

/** Inset from a floating panel's outer edge to the artboards: the panel's own
 * 12px margin plus a little air. */
const CHROME_GUTTER = 24;
/** Clears the floating top bar *and* the artboard's label above the frame. */
const CHROME_TOP = 120;
import { frameUrl, resolveOrigin } from "../lib/origins";
import { PALETTE } from "../lib/palette";
import { VIEWPORTS } from "../lib/types";
import type { DropPosition, LayerNode, SelectedElement } from "../lib/types";
import { ReloadIcon } from "@radix-ui/react-icons";

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

/**
 * What the armed gesture is waiting for. Without it, "insert" mode is a lit
 * toolbar button and nothing else — the canvas gives no sign that it is now
 * waiting for a click, or that Esc backs out.
 */
function GestureHint() {
  const draggingId = useStore((s) => s.draggingId);
  const insertKind = useStore((s) => s.insertKind);
  if (!draggingId && !insertKind) return null;
  const label = draggingId
    ? "Drop to move — release inside an element to re-parent it"
    : `Click where the ${PALETTE[insertKind!].label.toLowerCase()} should go`;
  return (
    <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-30 rounded-full border border-line bg-surface-1/95 backdrop-blur px-3 py-1 text-2xs text-ink-dim shadow-lg select-none">
      {label}
      <span className="text-ink-faint"> · Esc to cancel</span>
    </div>
  );
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

  const viewport = VIEWPORTS.find((v) => v.id === viewportId)!;
  const routes = useStore((s) => s.routes);
  const pageHeights = useStore((s) => s.pageHeights);
  const pagePaths = useStore((s) => s.pagePaths);
  const devAltUrl = useStore((s) => s.devAltUrl);
  const frameOrigins = useStore((s) => s.frameOrigins);
  const sessionModes = useStore((s) => s.sessionModes);
  const heldRoutes = useStore((s) => s.heldRoutes);

  // Every discovered route is its own page artboard, Figma-style, in a row.
  // Each frame shows its full page: at least the device height, grown to the
  // page's reported natural height, sanity-capped for runaway layouts.
  const minHeight = viewport.height ?? 800;
  const heightFor = (route: string) =>
    Math.min(Math.max(minHeight, pageHeights[route] ?? 0), 12000);
  const pageStep = viewport.width + PAGE_GAP;
  // De-dupe cross-frame selection sync: broadcast each dedupId once.
  const lastSelectRef = useRef<string | null>(null);

  const pageMeta = useStore((s) => s.pageMeta);
  const mockSession = useStore((s) => s.sessionSeed?.enabled ?? false);
  const tool = useStore((s) => s.tool);
  const editorTab = useStore((s) => s.editorTab);
  const selectedRoute = useStore((s) => s.selectedRoute);
  const setSelectedRoute = useStore((s) => s.setSelectedRoute);
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
        const sel = m.payload as SelectedElement;
        useStore.getState().setSelected(sel);
        // Same source element can exist on several page artboards; broadcast
        // so the holder frames highlight it and the rest drop stale boxes.
        if (sel && sel.dedupId !== lastSelectRef.current) {
          lastSelectRef.current = sel.dedupId;
          sendToOverlay({ type: "select-id", id: sel.dedupId });
        }
      } else if (m.type === "page-size") {
        // Height belongs to the frame that measured it, keyed by its route.
        const route = routeOfWindow(e.source) ?? (m.path as string) ?? "/";
        useStore.getState().setPageHeight(route, m.height as number);
      } else if (m.type === "page-log") {
        // Runtime output from inside the canvas iframe. Tagged so it reads as
        // the app talking rather than the dev server, and so the build-error
        // parser (which watches for vite/tsc patterns) leaves it alone.
        const where = (m.path as string) || "/";
        useStore
          .getState()
          .appendPageLog(`[page ${where}] ${m.text as string}`);
      } else if (m.type === "layers") {
        // Layer tree belongs to the frame that walked it, keyed by its route.
        const route = routeOfWindow(e.source) ?? "/";
        useStore.getState().setLayers(route, (m.layers as LayerNode[]) ?? []);
      } else if (m.type === "page-meta") {
        const route = routeOfWindow(e.source);
        const path = (m.path as string) ?? "/";
        if (!route) return;
        const s = useStore.getState();
        // Live path per frame — labels show drift (auth-guard redirects).
        s.setPagePath(route, path);
        if (route === "/") {
          s.setPageMeta({ title: (m.title as string) ?? "", path });
        }
        // Browse mode is the user driving their own app, so dedup stops
        // steering: both reactions below would wreck a multi-step flow. A
        // login wizard (phone → OTP), a checkout, any form that advances in
        // steps navigates on its own schedule — and the gesture window below
        // is 1.5s, far shorter than an SMS round-trip, so the step change
        // reads as an app redirect and flips the frame to the guest origin.
        // That swaps the iframe's src, which is a full reload, and anything
        // the flow held in memory (Firebase's ConfirmationResult, for one) is
        // gone — the user lands back on step one. The path is still tracked
        // above, so labels stay honest; nothing here touches the frame.
        if (s.tool === "browse") return;
        // App-initiated redirect off a pinned route (auth guard): retry the
        // frame on the guest origin — logged out there, so public pages the
        // app guards against signed-in users render again. If the guest
        // origin redirects too (the page truly needs auth), stay on the
        // shared origin with the drift label and stop flipping.
        if (path !== route && m.gesture !== true && route !== "/") {
          const cur = s.frameOrigins[route] ?? "shared";
          if (cur === "shared" && s.devAltUrl) s.setFrameOrigin(route, "alt");
          else if (cur === "alt") s.setFrameOrigin(route, "stuck");
        }
        // User navigation to somewhere new: pin the destination as its own
        // artboard and snap this frame back to its route. Redirects (no
        // gesture) stay put — an auth guard would spawn/snap-back forever.
        if (path !== route && m.gesture === true) {
          const isNew = !s.routes.includes(path);
          sendToFrame(route, { type: "navigate", path: route });
          // Pin the destination as its own artboard and bring it into view
          // (it lands at the row's end) — same path as a Pages-tab click.
          if (isNew) s.focusRoute(path);
        }
      } else if (m.type === "drop") {
        // A canvas drag finished on a valid target — stage the move.
        const s = useStore.getState();
        s.setDragging(null);
        s.moveElement(
          m.id as string,
          m.to as string,
          m.position as DropPosition,
        );
      } else if (m.type === "insert-at") {
        const s = useStore.getState();
        if (s.insertKind) {
          s.insertElement(s.insertKind, m.id as string, m.position as DropPosition);
        }
      } else if (m.type === "text-edit-request") {
        useStore.getState().requestTextEdit(m.id as string);
      } else if (m.type === "text-input") {
        // Typed on the canvas — staged exactly like a Content-field edit.
        const s = useStore.getState();
        if (s.selected?.dedupId === m.id) s.applyTextEdit(m.text as string);
      } else if (m.type === "drag-start") {
        useStore.getState().setDragging(m.id as string);
      } else if (m.type === "drag-end") {
        useStore.getState().setDragging(null);
      } else if (m.type === "key") {
        // The iframe has focus, so the editor's own window never saw this
        // keystroke. Replay it as a real event and let the one keyboard
        // handler in Editor decide what it means.
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: m.key as string,
            metaKey: m.meta === true,
            shiftKey: m.shift === true,
            bubbles: true,
          }),
        );
      } else if (m.type === "overlay-ready") {
        // Fresh overlay (first load or full-reload HMR) defaults to inspect —
        // re-assert the currently selected tool and re-apply staged edits it
        // knows nothing about yet.
        const { tool, viewportId, actions, insertKind } = useStore.getState();
        sendToOverlay({
          type: "set-mode",
          mode: tool === "browse" ? "browse" : "inspect",
        });
        sendToOverlay({
          type: "set-edit-mode",
          drag: tool === "select",
          insert: insertKind !== null,
        });
        if (actions.length > 0) useStore.getState().resyncCanvas();
        // Device viewport height for the overlay's vh-freeze: after an HMR
        // reload inside an already-grown frame, the overlay can't infer it
        // from window.innerHeight.
        const vp = VIEWPORTS.find((v) => v.id === viewportId)!;
        sendToOverlay({ type: "set-viewport", height: vp.height ?? 800 });
      } else if (m.type === "wheel") {
        const s = useStore.getState();
        if (m.zoomMod) {
          // Iframe-local coords → container coords: offset by the sending
          // frame's slot in the pages row, then by pan.
          const vp = VIEWPORTS.find((v) => v.id === s.viewportId)!;
          const idx = Math.max(0, s.routes.indexOf(routeOfWindow(e.source) ?? "/"));
          const frameX = idx * (vp.width + PAGE_GAP);
          zoomAt(
            s.pan.x + (frameX + (m.x as number)) * s.zoom,
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

  // Probe for an alternate loopback origin to the same dev server ([::1] vs
  // localhost vs 127.0.0.1). A different host spelling is a different origin —
  // separate localStorage — so frames there stay logged out. That's what lets
  // a public page pinned as an artboard survive the app's "already logged in"
  // redirect after the user signs in on the shared origin.
  useEffect(() => {
    if (!devUrl) return;
    let dead = false;
    const base = new URL(devUrl);
    const candidates = ["[::1]", "127.0.0.1"].filter((h) => h !== base.hostname);
    (async () => {
      for (const host of candidates) {
        const alt = new URL(devUrl);
        alt.hostname = host;
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 1500);
          await fetch(new URL("/__dedup/routes", alt), { signal: ctl.signal });
          clearTimeout(timer);
          if (!dead) useStore.getState().setDevAltUrl(alt.origin);
          return;
        } catch {
          // unreachable on this loopback — try the next spelling
        }
      }
    })();
    return () => {
      dead = true;
    };
  }, [devUrl]);

  // Keep the overlay's vh-freeze in sync with the selected device viewport.
  useEffect(() => {
    if (!devUrl) return;
    sendToOverlay({ type: "set-viewport", height: viewport.height ?? 800 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devUrl, viewportId]);

  // Center the frame when the canvas first shows or the viewport changes.
  //
  // "Centre" means centred in the space the user can actually see: the canvas
  // is full-bleed and the chrome floats on top of it, so centring on the raw
  // container would park the artboard's label under the top bar and its left
  // edge under the sidebar.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !devUrl) return;
    const { width } = el.getBoundingClientRect();
    const z = useStore.getState().zoom;
    const { sidebar, inspector } = useStore.getState().panelWidths;
    const left = sidebar + CHROME_GUTTER;
    const right = inspector + CHROME_GUTTER;
    const free = Math.max(width - left - right, 0);
    setPan({
      x: Math.max(left + (free - viewport.width * z) / 2, left),
      y: CHROME_TOP,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devUrl, viewportId]);

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
      data-canvas-root
      // Hidden (not unmounted) on the Components tab: unmounting would
      // reload the app frames and drop live state + staged class previews.
      className={`flex-1 min-w-0 relative overflow-hidden bg-surface-0 ${
        editorTab === "canvas" ? "" : "hidden"
      }`}
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
              <ReloadIcon width={13} height={13} /> Restart
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
          {/* Frame labels (Figma artboard names): pan with their frame but
              keep constant size — positioned in container space, not scaled.
              Clicking one selects the artboard — the scan's scope. */}
          {routes.map((route, i) => (
            <div
              key={route}
              className="absolute flex items-baseline gap-1.5 text-2xs select-none cursor-pointer"
              style={{
                left: pan.x + i * pageStep * zoom,
                top: pan.y - 22,
                maxWidth: Math.max(viewport.width * zoom, 160),
              }}
              onClick={() =>
                setSelectedRoute(selectedRoute === route ? null : route)
              }
              title={
                selectedRoute === route
                  ? "Selected — Scan targets this artboard"
                  : "Select this artboard to scan it"
              }
            >
              <span
                className={`truncate ${
                  selectedRoute === route
                    ? "text-accent font-medium"
                    : "text-ink-dim hover:text-ink"
                }`}
              >
                {route === "/"
                  ? pageMeta?.title || project?.name || "Page"
                  : route}
              </span>
              {route === "/" && pageMeta && pageMeta.path !== "/" && (
                <span className="text-ink-faint font-mono truncate shrink-0">
                  {pageMeta.path}
                </span>
              )}
              {/* Honesty over magic: a frame its app redirected away (auth
                  guard) says where it actually landed. */}
              {route !== "/" && pagePaths[route] && pagePaths[route] !== route && (
                <span className="text-warn font-mono truncate shrink-0">
                  → {pagePaths[route]}
                </span>
              )}
              {/* Which session this artboard renders under, whenever it
                  isn't the live one — the label must never let the user
                  wonder why two frames of the same app disagree. */}
              {(sessionModes[route] === "out" ||
                (sessionModes[route] !== "in" &&
                  frameOrigins[route] === "alt")) && (
                <span className="text-ink-faint shrink-0">signed out</span>
              )}
              {sessionModes[route] === "in" && (
                <span className="text-ink-faint shrink-0">signed in</span>
              )}
              {/* A held frame is deliberately not showing what the app would
                  do on its own — that has to be visible on the artboard. */}
              {heldRoutes[route] && (
                <span className="rounded bg-accent/15 px-1 text-accent shrink-0">
                  held
                </span>
              )}
              {i === 0 && (
                <span className="text-ink-faint shrink-0">
                  {viewport.label} · {viewport.width}
                </span>
              )}
              {/* Honesty over magic: pages rendered under a seeded session
                  say so — the app believes a login that never happened. */}
              {i === 0 && mockSession && (
                <span className="rounded bg-warn/15 px-1 text-warn shrink-0">
                  mock session
                </span>
              )}
            </div>
          ))}
          {/* Pannable surface: pages-row origin lives at `pan`, scaled by
              zoom. One frame per route; the root frame stays mounted (it's
              the live, navigable app), off-screen siblings unmount so a
              route-heavy project doesn't run 20 live copies of itself. */}
          <div
            className="absolute top-0 left-0 will-change-transform"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {routes.map((route, i) => {
              const x = i * pageStep;
              const h = heightFor(route);
              const view = {
                left: -pan.x / zoom - 400,
                right: (-pan.x + window.innerWidth) / zoom + 400,
                top: -pan.y / zoom - 400,
                bottom: (-pan.y + window.innerHeight) / zoom + 400,
              };
              const near =
                x < view.right && x + viewport.width > view.left &&
                0 < view.bottom && h > view.top;
              return (
                <div
                  key={route}
                  // The visual regression gate finds its capture regions by
                  // this attribute — an artboard has to be addressable from
                  // outside the canvas for a before/after to mean anything.
                  data-artboard={route}
                  className={`absolute shadow-2xl bg-white rounded-md overflow-hidden ${
                    selectedRoute === route ? "ring-2 ring-accent" : ""
                  }`}
                  style={{ left: x, top: 0, width: viewport.width, height: h }}
                >
                  {route === "/" || near ? (
                    <iframe
                      ref={(el) => registerCanvasIframe(el, route)}
                      // Built from subscribed values, so switching an
                      // artboard's session or holding it re-points the frame
                      // immediately — and for a hold, that reload is exactly
                      // what arms it (the flag must be there before boot).
                      src={frameUrl(
                        route,
                        resolveOrigin(route, {
                          sessionModes,
                          frameOrigins,
                          devUrl,
                          devAltUrl,
                        }) ?? devUrl,
                        !!heldRoutes[route],
                      )}
                      title={`page ${route}`}
                      className="w-full h-full border-0 bg-white"
                    />
                  ) : (
                    <div className="h-full bg-white" />
                  )}
                </div>
              );
            })}
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
          <GestureHint />
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
