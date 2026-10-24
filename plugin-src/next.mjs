// dedup for Next.js (Phase 5) — the config wrapper.
//
// The Vite path injects itself with no trace: dedup generates a wrapper config
// under `node_modules/.dedup/` and starts vite with `--config`, so the user's
// own files are never touched. Next.js has no equivalent — it reads
// `next.config.*` from the project root and takes no config flag — so the
// only honest options are (a) no element tagging on Next, or (b) a change the
// *user* makes to their own config.
//
// This module is (b), made as small and as reversible as a change can be: two
// lines in next.config, added only when the user asks, written through the
// same session-branch commit as every other dedup write, and undoable from
// the History panel like any other. Silently rewriting someone's build config
// would be the one thing the safety model forbids; offering them a diff is not.
//
// What it does when enabled:
//   * adds a webpack rule running the same `tagCode` the Vite plugin runs, so
//     element ids are identical across both pipelines — the ids are ordinals
//     in the shared jsxwalk, and two taggers that disagreed by one element
//     would be two different identity schemes for one write-back;
//   * prepends dedup's client entry (boot script + overlay), which is where
//     Next lets you put something that runs before the app;
//   * relaxes the frame-blocking headers the project's own `headers()`
//     declares. The canvas is an iframe, so `X-Frame-Options: DENY` — which
//     is boilerplate in any security-minded project — renders as a blank
//     white artboard with no error anywhere the user can see. `frameable.mjs`
//     holds the rule and the reasoning. This covers the config-declared path
//     only: a header set by a `middleware.ts` is served by Next itself, out of
//     a config wrapper's reach, and would still blank the canvas.
//
// It does not serve the component harness: rendering one component in
// isolation needs an arbitrary module URL from the dev server, which Vite
// gives you and Next does not. The Components tab says so rather than showing
// empty cards.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripFrameGuards, NOTICE } from "./frameable.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Files dedup writes next to this one; both are generated, never authored. */
export const LOADER_FILE = "next-loader.cjs";
export const CLIENT_ENTRY_FILE = "next-client.js";

/**
 * `withDedup(nextConfig)` — what the user adds to their next.config.
 *
 * Deliberately additive: the caller's own `webpack` hook still runs, and runs
 * last, so a project with webpack customisation keeps it. Anything that throws
 * in here is swallowed with a warning and the build continues untouched — a
 * broken editor integration must never be a broken build.
 *
 * Off unless `DEDUP_TAGGING=1`, which dedup sets on the dev server it starts.
 * So the wrapper is inert for the user's own `next dev`, their CI, and their
 * production build: the line in their config changes nothing they run.
 */
export function withDedup(nextConfig = {}, options = {}) {
  const enabled = options.enabled ?? process.env.DEDUP_TAGGING === "1";
  if (!enabled) return nextConfig;

  const loader = options.loader ?? path.join(HERE, LOADER_FILE);
  const clientEntry = options.clientEntry ?? path.join(HERE, CLIENT_ENTRY_FILE);

  let announced = false;
  const announce = () => {
    if (announced) return;
    announced = true;
    // eslint-disable-next-line no-console
    console.warn(NOTICE);
  };

  return {
    ...nextConfig,
    async headers() {
      const declared =
        typeof nextConfig.headers === "function"
          ? ((await nextConfig.headers()) ?? [])
          : [];
      return declared.map((rule) => ({
        ...rule,
        headers: stripFrameGuards(rule?.headers, announce),
      }));
    },
    webpack(config, context) {
      try {
        if (fs.existsSync(loader)) {
          config.module = config.module ?? {};
          config.module.rules = [
            {
              test: /\.[jt]sx$/,
              exclude: /node_modules/,
              enforce: "pre",
              use: [{ loader }],
            },
            ...(config.module.rules ?? []),
          ];
        }

        if (!context.isServer && fs.existsSync(clientEntry)) {
          const previous = config.entry;
          config.entry = async () => {
            const entries =
              typeof previous === "function" ? await previous() : previous;
            // App Router builds "main-app"; Pages Router builds "main".
            for (const key of ["main-app", "main.js", "main"]) {
              const entry = entries?.[key];
              if (!entry) continue;
              const list = Array.isArray(entry) ? entry : [entry];
              if (!list.includes(clientEntry)) entries[key] = [clientEntry, ...list];
              break;
            }
            return entries;
          };
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("dedup: could not instrument the Next build —", e);
      }
      return typeof nextConfig.webpack === "function"
        ? nextConfig.webpack(config, context)
        : config;
    },
  };
}

/**
 * The exact edit dedup offers to make to a next.config, as {find, add} pairs
 * the caller turns into a diff. Kept here so the snippet and the wrapper it
 * calls can never drift apart.
 */
export function configEdit(esm = true) {
  return esm
    ? {
        importLine: `import { withDedup } from "./node_modules/.dedup/next.mjs";`,
        wrap: (expr) => `withDedup(${expr})`,
      }
    : {
        importLine: `const { withDedup } = require("./node_modules/.dedup/next.cjs");`,
        wrap: (expr) => `withDedup(${expr})`,
      };
}
