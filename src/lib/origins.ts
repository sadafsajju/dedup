// Which dev-server origin a page artboard loads from.
//
// dedup can reach the same dev server through more than one loopback spelling
// (localhost, [::1], 127.0.0.1). Those are different *origins* to the browser,
// so each has its own cookies, localStorage and IndexedDB — which means a
// frame loaded from the alternate one has no session, no matter what the user
// signed into elsewhere. That is the whole mechanism behind rendering a page
// "signed out": nothing is mocked or stubbed, it is simply a browser that
// never logged in.
//
// Two things decide the origin, and this module is where they are reconciled:
// the user's explicit per-artboard choice, and the automatic fallback that
// reacts to an app redirecting a frame off its pinned route.

/**
 * Query flag asking a frame to freeze on its first screen, so a splash or
 * interstitial can be inspected instead of vanishing. It has to reach the
 * page before the app boots, and the frame's URL is the only channel that
 * early — the boot script the tagger injects reads it from `location`.
 *
 * Must match `HOLD_FLAG` in plugin-src/tagger.mjs, which is bundled
 * separately and cannot share a module with this one; `pnpm test:origins`
 * asserts the two agree.
 */
export const HOLD_FLAG = "__dedup_hold";

/** A route's frame URL, carrying the hold flag when that artboard is frozen. */
export function frameUrl(route: string, origin: string, held: boolean): string {
  const url = new URL(route, origin);
  if (held) url.searchParams.set(HOLD_FLAG, "1");
  return url.toString();
}

/** The user's choice for one artboard. "auto" defers to the fallback. */
export type SessionMode = "auto" | "in" | "out";

/** Automatic state per frame: where the redirect heuristic has put it. */
export type FrameOrigin = "shared" | "alt" | "stuck";

export interface OriginInputs {
  sessionModes: Record<string, SessionMode>;
  frameOrigins: Record<string, FrameOrigin>;
  devUrl: string | null;
  devAltUrl: string | null;
}

/**
 * The origin `route`'s frame should load from, or null before the dev server
 * is up.
 *
 * An explicit choice always wins: the automatic fallback is a guess from one
 * redirect, and the user watching the canvas knows better. When no alternate
 * origin exists there is nowhere to be signed out, so "out" degrades to the
 * normal origin rather than breaking the frame — the Pages tab disables the
 * control and says why instead of letting it silently do nothing.
 *
 * Pure so React can call it with subscribed values (staying reactive) while
 * the store calls it with `get()` — one implementation, no drift.
 */
export function resolveOrigin(route: string, s: OriginInputs): string | null {
  const mode = s.sessionModes[route] ?? "auto";
  if (mode === "out") return s.devAltUrl ?? s.devUrl;
  if (mode === "in") return s.devUrl;
  return s.frameOrigins[route] === "alt" && s.devAltUrl ? s.devAltUrl : s.devUrl;
}
