// Types for the wrapper the user adds to their next.config.
//
// Not cosmetic: a TypeScript next.config under `strict` that imports an
// untyped `.mjs` fails with TS7016 (implicit any), and `skipLibCheck` does not
// help — it skips checking declaration files, not the absence of one. Since
// dedup's own typecheck gate runs the project's `tsc`, shipping the wrapper
// without this would mean dedup's config line breaks dedup's safety gate.
//
// Deliberately loose about the config shape: importing `NextConfig` here would
// tie dedup's declaration to a Next version the project may not have.

/** Options dedup passes; every one has a working default. */
export interface WithDedupOptions {
  /** Force tagging on/off. Default: on only when DEDUP_TAGGING=1. */
  enabled?: boolean;
  /** Absolute path to the webpack loader. Defaults next to this file. */
  loader?: string;
  /** Absolute path to the client entry. Defaults next to this file. */
  clientEntry?: string;
}

/**
 * Wrap a Next config so dedup can tag JSX elements while *its* dev server is
 * running. Inert unless `DEDUP_TAGGING=1`, so your own `next dev`, your CI and
 * your production build are unaffected.
 */
export declare function withDedup<T extends object>(
  nextConfig?: T,
  options?: WithDedupOptions,
): T;

export declare function configEdit(esm?: boolean): {
  importLine: string;
  wrap: (expr: string) => string;
};
