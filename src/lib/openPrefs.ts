// What dedup remembers about opening a project, and the rule for when opening
// one has to stop and ask something.
//
// Opening used to go through a compatibility card: a full / partial /
// unsupported verdict shown before the project loaded. The verdict is gone —
// every folder opens, and what dedup cannot do for a particular project is
// said inside the editor, beside the thing that is unavailable. What is left
// are the two questions only the user can answer, and the panel appears for
// exactly those:
//
//   - "what command starts this?" — when detection found no way to run it and
//     no command has been given before;
//   - the dirty-tree acknowledgement (FR-1.5) — once per project, not once
//     per open. The tree flips dirty several times an hour during real work,
//     and re-asking is how an acknowledgement becomes a click-through. The
//     uncommitted-change count lives in the top bar for the whole session.
//
// Everything else goes straight in.

import type { GitStatus, ProjectInfo } from "./types";

const STORAGE = "dedup:opened";

export interface OpenPref {
  /** The start command the user set, so going straight in doesn't silently
   * drop back to the project's own script. */
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
    // of starting over is being asked once more.
    return {};
  }
}

function save(store: Store) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(store));
  } catch {
    // Remembering is a convenience. Failing to remember asks again, which is
    // the safe direction to fail in.
  }
}

export function prefFor(root: string): OpenPref | null {
  return load()[root] ?? null;
}

/** Record how the user opened this project. */
export function rememberOpen(
  info: ProjectInfo,
  git: GitStatus,
  customCommand: string | null,
) {
  const store = load();
  const previous = store[info.root];
  store[info.root] = {
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
 * What dedup runs to start this project when the user has set nothing — for
 * showing, not for running (the launch is decided in `start_dev_server`).
 * Null when there is nothing to show: a static site dedup serves itself, or a
 * project it found no command for.
 */
export function defaultCommand(info: ProjectInfo): string | null {
  if (info.framework === "static") return null;
  if (info.runCommand) return info.runCommand;
  if (info.devScriptName) return `${info.packageManager === "unknown" ? "npm" : info.packageManager} run ${info.devScriptName}`;
  if (info.framework === "vite" && info.runnable) return "vite";
  return null;
}

/**
 * Does opening this project need to ask the user something first?
 *
 * `null` means go straight in. There is no "first open" and no "the verdict
 * changed" any more: neither is a question.
 */
export function reasonToAsk(
  info: ProjectInfo,
  git: GitStatus,
): "needs-command" | "needs-ack" | null {
  const pref = prefFor(info.root);
  // Nothing dedup could find starts this project, and nothing was given
  // before: without a command there is nothing to put on the canvas.
  if (!info.runnable && !pref?.customCommand) return "needs-command";
  // FR-1.5's gate, asked once per project rather than once per open.
  if (git.isRepo && git.isDirty && !pref?.ackedDirty) return "needs-ack";
  return null;
}
