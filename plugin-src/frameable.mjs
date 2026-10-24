// The one rule about response headers that stop a page being framed.
//
// dedup's canvas renders the user's app in an iframe. A dev server that sends
// `X-Frame-Options: DENY` (or a CSP with `frame-ancestors`) makes the browser
// refuse to render that frame — and refuse *silently*: no console error the
// user can see, no network failure, just a white artboard. Security headers
// like these are boilerplate in production-minded projects, so this is not an
// exotic case; it is what a well-configured app looks like.
//
// So both dev pipelines neutralise these headers on the way out. Three things
// make that an honest thing to do rather than a quiet weakening of the user's
// security posture:
//
//   * it happens only in the dev server dedup itself starts (the Vite tagger
//     runs under dedup's generated config; the Next wrapper is inert without
//     `DEDUP_TAGGING=1`), so the user's own `next dev`, their CI and their
//     production build are untouched;
//   * the user's source and config keep saying exactly what they said — this
//     rewrites a response, never a file;
//   * it removes the *directive*, not the policy. A CSP keeps every other
//     directive it had, because those change how the app behaves and the whole
//     point of the canvas is that the user edits what they actually see.
//
// Callers announce what they did on the dev-server stream, which dedup shows
// in the console drawer. A silent fix for a silent failure is still silent.

/** Headers whose only job is to refuse framing — dropped entirely. */
export const FRAME_BLOCKING_HEADERS = ["x-frame-options"];

/** Headers that may *contain* a framing rule among unrelated ones. */
export const POLICY_HEADERS = [
  "content-security-policy",
  "content-security-policy-report-only",
];

export const NOTICE =
  "dedup: relaxed this dev server's frame-blocking headers so the canvas can " +
  "render the app (dev only — your config and your production build are unchanged)";

/**
 * Drop `frame-ancestors` from one CSP value, keeping every other directive.
 * Returns null when nothing is left worth sending, so the caller can remove
 * the header rather than send an empty one.
 */
export function stripFrameAncestors(value) {
  if (typeof value !== "string") return value;
  const kept = value
    .split(";")
    .filter((directive) => {
      const name = directive.trim().split(/\s+/)[0] ?? "";
      return name.toLowerCase() !== "frame-ancestors";
    })
    .map((directive) => directive.trim())
    .filter(Boolean);
  return kept.length ? kept.join("; ") : null;
}

/** Does this header name/value pair say anything about framing? */
export function blocksFraming(name, value) {
  const lower = String(name).toLowerCase();
  if (FRAME_BLOCKING_HEADERS.includes(lower)) return true;
  if (!POLICY_HEADERS.includes(lower)) return false;
  return stripFrameAncestors(value) !== value;
}

/**
 * Rewrite a list of `{key, value}` header entries — the shape Next's
 * `headers()` config uses. Returns the new list; `changed` is reported through
 * the optional `onChange` callback so the caller can announce it once.
 */
export function stripFrameGuards(entries, onChange) {
  if (!Array.isArray(entries)) return entries;
  let changed = false;
  const out = [];
  for (const entry of entries) {
    const name = String(entry?.key ?? "").toLowerCase();
    if (FRAME_BLOCKING_HEADERS.includes(name)) {
      changed = true;
      continue;
    }
    if (POLICY_HEADERS.includes(name)) {
      const stripped = stripFrameAncestors(entry.value);
      if (stripped !== entry.value) {
        changed = true;
        if (stripped === null) continue;
        out.push({ ...entry, value: stripped });
        continue;
      }
    }
    out.push(entry);
  }
  if (changed && typeof onChange === "function") onChange();
  return out;
}

/**
 * Patch a Node response so nothing later in the chain can reinstate a framing
 * guard. Both `setHeader` and `writeHead` are covered: Vite and its plugins
 * use either, and a header that arrives by the path we did not patch is a
 * blank artboard again.
 */
export function guardResponse(res, onChange) {
  const setHeader = res.setHeader.bind(res);
  const writeHead = res.writeHead.bind(res);

  res.setHeader = (name, value) => {
    if (blocksFraming(name, value)) {
      if (typeof onChange === "function") onChange();
      const lower = String(name).toLowerCase();
      if (FRAME_BLOCKING_HEADERS.includes(lower)) return res;
      const stripped = stripFrameAncestors(value);
      if (stripped === null) return res;
      return setHeader(name, stripped);
    }
    return setHeader(name, value);
  };

  res.writeHead = (...args) => {
    const headers = args.find(
      (arg) => arg && typeof arg === "object" && !Array.isArray(arg),
    );
    if (headers) {
      for (const name of Object.keys(headers)) {
        if (!blocksFraming(name, headers[name])) continue;
        if (typeof onChange === "function") onChange();
        const lower = name.toLowerCase();
        if (FRAME_BLOCKING_HEADERS.includes(lower)) {
          delete headers[name];
          continue;
        }
        const stripped = stripFrameAncestors(headers[name]);
        if (stripped === null) delete headers[name];
        else headers[name] = stripped;
      }
    }
    // A guard already committed by an earlier setHeader we did not see.
    for (const name of FRAME_BLOCKING_HEADERS) {
      if (res.hasHeader?.(name)) {
        if (typeof onChange === "function") onChange();
        res.removeHeader(name);
      }
    }
    return writeHead(...args);
  };
}
