// Pages tab (FR-6.3): the project's routes, as discovered by the tagger's
// static react-router scan (served at /__dedup/routes), merged with whatever
// artboards are already open (routes visited by browsing spawn artboards the
// scan can't know about — dynamic paths like /orders/42). Clicking a row
// opens the route as a page artboard if it isn't one and pans the canvas to
// it — the same focusRoute path a canvas navigation takes.
//
// Nothing is on the canvas until a row here is clicked. Mounting an artboard
// boots the user's real app — their auth guards, their data fetching, their
// analytics — so dedup opens the page they asked for and no others.
import { useEffect } from "react";
import { useStore } from "../lib/store";
import {
  Cross2Icon,
  FileTextIcon,
  LockClosedIcon,
  LockOpen1Icon,
  ReloadIcon,
} from "@radix-ui/react-icons";

/** A drifted frame that landed on one of these is behind an auth guard —
 * the lock affordance points at zero-login editing. */
const AUTH_PATH_RE = /(^|\/)(log-?in|sign-?in|sign-?up|auth|unauthorized|forbidden)(\/|$)/i;

export function PagesTab() {
  const devUrl = useStore((s) => s.devUrl);
  const devStatus = useStore((s) => s.devStatus);
  const instrumentation = useStore((s) => s.instrumentation);
  const detectedRoutes = useStore((s) => s.detectedRoutes);
  const routes = useStore((s) => s.routes);
  const pageMeta = useStore((s) => s.pageMeta);
  const pagePaths = useStore((s) => s.pagePaths);
  const selectedRoute = useStore((s) => s.selectedRoute);
  const fetchDetectedRoutes = useStore((s) => s.fetchDetectedRoutes);
  const focusRoute = useStore((s) => s.focusRoute);
  const closeRoute = useStore((s) => s.closeRoute);
  const sessionSeed = useStore((s) => s.sessionSeed);
  const openSessionModal = useStore((s) => s.openSessionModal);
  const sessionModes = useStore((s) => s.sessionModes);
  const setSessionMode = useStore((s) => s.setSessionMode);
  const devAltUrl = useStore((s) => s.devAltUrl);
  const heldRoutes = useStore((s) => s.heldRoutes);
  const toggleHold = useStore((s) => s.toggleHold);
  const offlineRoutes = useStore((s) => s.offlineRoutes);
  const toggleOffline = useStore((s) => s.toggleOffline);

  useEffect(() => {
    if (devUrl && detectedRoutes === null) void fetchDetectedRoutes();
  }, [devUrl, detectedRoutes, fetchDetectedRoutes]);

  if (devStatus !== "ready" || detectedRoutes === null) {
    return (
      <Empty
        text={
          devStatus !== "ready"
            ? "No pages yet — waiting for the dev server."
            : "Detecting routes…"
        }
      />
    );
  }

  // Detected first (the scan orders them, "/" leading), then artboards the
  // user browsed to that the static scan couldn't know about.
  const rows = [
    ...detectedRoutes,
    ...routes.filter((r) => !detectedRoutes.includes(r)),
  ];
  if (!rows.includes("/")) rows.unshift("/");

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-2 text-2xs border-b border-line flex items-center gap-2">
        <span className="text-ink-faint">
          {rows.length} page{rows.length === 1 ? "" : "s"} ·{" "}
          {routes.length === 0 ? "none open" : `${routes.length} open`}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => void fetchDetectedRoutes()}
          className="text-ink-faint hover:text-ink"
          title="Re-scan the project for routes"
        >
          <ReloadIcon width={12} height={12} />
        </button>
      </div>
      {/* Static scan only sees absolute react-router path literals — say so
          rather than presenting the list as complete. */}
      {detectedRoutes.length === 0 && (
        <div className="px-3 py-2 text-2xs text-ink-dim border-b border-line">
          {instrumentation && !instrumentation.active
            ? "Route detection needs element tagging, which is off for this session. Open the home page below, then browse from there — where you land is added here."
            : "No routes detected — only static react-router and Next file routes are found. Open the home page below, then use the browse tool; where you land is added here."}
        </div>
      )}
      {routes.length === 0 && (
        <div className="px-3 py-2 text-2xs text-ink-dim border-b border-line">
          Click a page to open it as an artboard.
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-1">
        {rows.map((route) => {
          const open = routes.includes(route);
          const drifted = open && pagePaths[route] && pagePaths[route] !== route;
          // A frame the app bounced to its login page: protected. The lock
          // opens zero-login setup instead of pretending the page is fine.
          const locked = !!drifted && AUTH_PATH_RE.test(pagePaths[route]);
          return (
            <div
              key={route}
              onClick={() => focusRoute(route)}
              title={
                open
                  ? "Go to this page's artboard"
                  : "Open this page as an artboard"
              }
              className="group flex items-center gap-2 px-3 py-1.5 text-2xs cursor-pointer select-none text-ink-dim hover:bg-surface-2 hover:text-ink"
            >
              <FileTextIcon
                width={13}
                height={13}
                className={`shrink-0 ${open ? "text-ink-dim" : "text-ink-faint"}`}
              />
              <span className={`truncate ${open ? "text-ink" : ""}`}>
                {route === "/" ? pageMeta?.title || "Home" : route}
              </span>
              {route === "/" && (
                <span className="text-ink-faint font-mono shrink-0">/</span>
              )}
              {/* Honesty over magic: a frame its app redirected away says so
                  here too, matching the canvas label. */}
              {drifted && !locked && (
                <span className="text-warn font-mono truncate shrink-0">
                  → {pagePaths[route]}
                </span>
              )}
              <span className="flex-1" />
              {open && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleHold(route);
                    }}
                    title={
                      heldRoutes[route]
                        ? "Let this page continue — its splash/redirect finishes and the app carries on."
                        : "Freeze this page on its first screen, so a splash or interstitial stays put long enough to edit."
                    }
                    className={`shrink-0 rounded px-1 ${
                      heldRoutes[route]
                        ? "bg-accent/15 text-accent"
                        : "text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink"
                    }`}
                  >
                    {heldRoutes[route] ? "held" : "hold"}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleOffline(route);
                    }}
                    title={
                      offlineRoutes[route]
                        ? "Put this page back on the network — its requests reach the world again."
                        : "Render this page with no internet: the app's own requests fail, so its offline and error states show. The dev server keeps working, so the frame still reloads as you edit."
                    }
                    className={`shrink-0 rounded px-1 ${
                      offlineRoutes[route]
                        ? "bg-warn/15 text-warn"
                        : "text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink"
                    }`}
                  >
                    {offlineRoutes[route] ? "offline" : "cut net"}
                  </button>
                  <SessionToggle
                    mode={sessionModes[route] ?? "auto"}
                    canSignOut={!!devAltUrl}
                    onPick={(next) => setSessionMode(route, next)}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeRoute(route);
                    }}
                    title="Close this artboard — stops running this page. Staged edits are kept."
                    className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-surface-3"
                  >
                    <Cross2Icon width={11} height={11} />
                  </button>
                </>
              )}
              {locked && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openSessionModal();
                  }}
                  title={`This page redirected to ${pagePaths[route]} — it needs a session. Sign in once, or set up a mock session.`}
                  className="shrink-0 text-warn hover:text-ink"
                >
                  <LockClosedIcon width={12} height={12} />
                </button>
              )}
              {selectedRoute === route && (
                <span
                  className="shrink-0 text-accent"
                  title="Scan targets this artboard"
                >
                  scan
                </span>
              )}
              {!open && <span className="shrink-0 text-ink-faint">＋</span>}
            </div>
          );
        })}
      </div>
      {/* Zero-login editing: always reachable from here (locks appear only
          after a protected page has bounced once), with its state shown. */}
      <button
        onClick={openSessionModal}
        className="flex items-center gap-2 px-3 py-2 border-t border-line text-2xs text-ink-dim hover:text-ink hover:bg-surface-2"
      >
        {sessionSeed?.enabled ? (
          <LockOpen1Icon width={12} height={12} className="text-warn" />
        ) : (
          <LockClosedIcon width={12} height={12} className="text-ink-faint" />
        )}
        Protected pages
        <span className="flex-1" />
        <span className={sessionSeed?.enabled ? "text-warn" : "text-ink-faint"}>
          {sessionSeed?.enabled ? "mock session on" : "sign in / mock"}
        </span>
      </button>
    </div>
  );
}

/**
 * Which session one artboard renders under. "auto" follows the redirect
 * heuristic; the explicit settings are how a page guarded *against* signed-in
 * users (a welcome or marketing page) stays on screen while you are signed
 * in, and how a dashboard stays rendered while you are not.
 *
 * "Signed out" is a second loopback spelling of the same dev server — a
 * different origin, so a separate storage bucket, so the app truly has no
 * session there. Nothing is mocked; it is a browser that never logged in.
 */
function SessionToggle({
  mode,
  canSignOut,
  onPick,
}: {
  mode: "auto" | "in" | "out";
  canSignOut: boolean;
  onPick: (next: "auto" | "in" | "out") => void;
}) {
  // Cycle toward the common need first: hold this page signed out.
  const order: ("auto" | "in" | "out")[] = canSignOut
    ? ["auto", "out", "in"]
    : ["auto", "in"];
  const next = order[(order.indexOf(mode) + 1) % order.length] ?? "auto";
  const label = mode === "out" ? "signed out" : mode === "in" ? "signed in" : "auto";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onPick(next);
      }}
      title={
        canSignOut
          ? `This artboard renders ${
              mode === "auto" ? "however the app redirects it" : `as ${label}`
            }. Click for "${next === "auto" ? "auto" : `signed ${next}`}".`
          : "Only one dev-server origin is reachable, so a signed-out artboard isn't available — dedup needs a second loopback address for that."
      }
      className={`shrink-0 rounded px-1 ${
        mode === "auto"
          ? "text-ink-faint opacity-0 group-hover:opacity-100"
          : "bg-surface-2 text-ink-dim"
      }`}
    >
      {label}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
      <FileTextIcon width={22} height={22} className="text-ink-faint" />
      <div className="text-2xs text-ink-dim">{text}</div>
    </div>
  );
}
