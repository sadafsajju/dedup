// What dedup remembers about opening a project, so the compatibility card is
// shown when it has something to say and skipped when it doesn't.
//
// The card is a verdict plus two gates: the dirty-tree acknowledgement
// (FR-1.5) and the custom dev command. Showing it on every open turns all
// three into a click-through, which is worse than not showing it — a dialog
// people dismiss without reading is not a safety feature.
//
// So it is shown when it carries *new information*: the first time, and any
// time the verdict changes. "Changes" is a fingerprint of everything the card
// actually renders, so a project that gains Tailwind, loses git, or has its
// Next config wired up gets a fresh look rather than a stale silent skip.
//
// Deliberately NOT in the fingerprint: the dirty tree. It flips several times
// an hour during real work, and re-asking for the same acknowledgement is the
// click-through failure above. The acknowledgement is remembered per project
// instead, and the uncommitted-change count moves to the top bar where it
// stays visible for the whole session rather than flashing past once.

import type { GitStatus, ProjectInfo } from "./types";

const STORAGE = "dedup:opened";

export interface OpenPref {
  /** Everything the card renders, hashed — a change means a fresh verdict. */
  fingerprint: string;
  /** The dev command the user set on the card, so skipping it doesn't
   * silently drop back to the project's own script. */
  customCommand: string | null;
  /** They have acknowledged that dedup writes into this repo (FR-1.5). */
  ackedDirty: boolean;
}

type Store = Record<string, OpenPref>;

function load(): Store {
  try {
    const raw = localStorage.getItem(STORAGE);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    // A corrupt entry must never keep a project from opening; the only cost
    // of starting over is one more look at the card.
    return {};
  }
}

function save(store: Store) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(store));
  } catch {
    // Remembering is a convenience. Failing to remember shows the card again,
    // which is the safe direction to fail in.
  }
}

/**
 * Everything the card puts on screen. If any of it differs from last time,
 * the user has not seen this verdict and gets to see it.
 */
export function fingerprintOf(info: ProjectInfo): string {
  return JSON.stringify([
    info.support,
    info.framework,
    info.packageManager,
    info.hasTailwind,
    info.hasTypescript,
    info.hasGit,
    info.devScript,
    info.summary,
    info.warnings,
  ]);
}

export function prefFor(root: string): OpenPref | null {
  return load()[root] ?? null;
}

/** Record that the user accepted this exact verdict. */
export function rememberOpen(
  info: ProjectInfo,
  git: GitStatus,
  customCommand: string | null,
) {
  const store = load();
  const previous = store[info.root];
  store[info.root] = {
    fingerprint: fingerprintOf(info),
    customCommand,
    // Once acknowledged, it stays acknowledged: the arrangement they agreed
    // to (dedup branches and commits only its own files) does not change when
    // the tree happens to be dirty again next Tuesday.
    ackedDirty: (previous?.ackedDirty ?? false) || (git.isRepo && git.isDirty),
  };
  save(store);
}

export function forgetOpen(root: string) {
  const store = load();
  delete store[root];
  save(store);
}

/**
 * Should the card be shown for this project, and why?
 *
 * `null` means go straight in. Anything else is a reason the user has not
 * already seen and agreed to.
 */
export function reasonToShowCard(
  info: ProjectInfo,
  git: GitStatus,
): "first-open" | "verdict-changed" | "unsupported" | "needs-ack" | null {
  // An unsupported project cannot be opened without the card's escape hatch
  // (a custom dev command), so it always gets one.
  if (info.support === "unsupported") return "unsupported";

  const pref = prefFor(info.root);
  if (!pref) return "first-open";
  if (pref.fingerprint !== fingerprintOf(info)) return "verdict-changed";
  // FR-1.5's gate, asked once per project rather than once per open.
  if (git.isRepo && git.isDirty && !pref.ackedDirty) return "needs-ack";
  return null;
}
