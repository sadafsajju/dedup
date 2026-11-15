import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  addRecentProject,
  detectProject,
  getRecentProjects,
  gitStatus,
  pickProjectFolder,
  projectThumbnail,
  removeRecentProject,
} from "../lib/api";
import { useStore } from "../lib/store";
import type { Framework, GitStatus, ProjectInfo, RecentProject } from "../lib/types";
import { ProjectDetails } from "./ProjectDetails";
import { forgetOpen, prefFor, reasonToAsk, rememberOpen } from "../lib/openPrefs";
import { forgetCanvas } from "../lib/canvasMemory";
import { StarterPicker } from "./StarterPicker";
import { CubeIcon, Cross2Icon, GearIcon } from "@radix-ui/react-icons";

interface Candidate {
  info: ProjectInfo;
  git: GitStatus;
}

const FRAMEWORK_LABEL: Record<Framework, string> = {
  vite: "Vite",
  next: "Next.js",
  static: "HTML",
  // dedup runs these on their own dev server; the recents list only stores
  // how a project is driven, not what it is called.
  unknown: "App",
};

/** "Edited" line under a card: Figma-ish, coarse on purpose. */
function relativeTime(ms: number | null): string | null {
  if (!ms) return null;
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Stable hue per project path, so an uncaptured card still reads as *that*
 *  project at a glance. */
function hue(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Fallback card subtitle: the folder the project sits in. */
function parentDir(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : path;
}

function initials(name: string): string {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Card art for a project captured no screenshot yet (first open, or a
 *  project last closed before thumbnails existed). */
function Placeholder({ name, path }: { name: string; path: string }) {
  const h = hue(path);
  return (
    <div
      className="w-full h-full grid place-items-center"
      style={{
        backgroundImage: `linear-gradient(140deg, hsl(${h} 42% 24%), hsl(${(h + 45) % 360} 38% 12%))`,
      }}
    >
      <span className="text-[26px] font-semibold tracking-tight text-white/55">
        {initials(name)}
      </span>
    </div>
  );
}

function Spinner() {
  return (
    <span className="block w-4 h-4 rounded-full border-2 border-ink-faint border-t-transparent animate-spin" />
  );
}

export function LaunchScreen() {
  const enterEditor = useStore((s) => s.enterEditor);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRecents = useCallback(async (list: RecentProject[]) => {
    setRecents(list);
    // Card images are data URLs — fetch them per project, tolerating misses.
    const pairs = await Promise.all(
      list.map(async (r) => {
        try {
          return [r.path, await projectThumbnail(r.path)] as const;
        } catch {
          return [r.path, null] as const;
        }
      }),
    );
    setThumbs(Object.fromEntries(pairs));
  }, []);

  useEffect(() => {
    getRecentProjects()
      .then(loadRecents)
      .catch(() => {});
  }, [loadRecents]);

  /**
   * Open a project. It goes straight in unless there is a question only the
   * user can answer (`reasonToAsk`). `force` shows project details anyway —
   * the deliberate way back to the start command.
   */
  const inspect = useCallback(async (path: string, force = false) => {
    setError(null);
    setPending(path);
    try {
      const [info, git] = await Promise.all([
        detectProject(path),
        gitStatus(path),
      ]);
      // An empty folder gets the starter picker. Everything else opens —
      // carrying the start command they set last time — unless dedup needs a
      // command it couldn't find or the one-time dirty-tree acknowledgement.
      if (!info.isEmpty && !force && reasonToAsk(info, git) === null) {
        await confirmOpen(info, git, prefFor(info.root)?.customCommand ?? null);
        return;
      }
      setCandidate({ info, git });
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(null);
    }
    // confirmOpen is stable for the life of the screen (it only closes over
    // store actions), so it is safe to leave out of the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native drag-and-drop of a folder onto the window (FR-1.1).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over" || p.type === "enter") setDragOver(true);
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          const first = p.paths?.[0];
          if (first) inspect(first);
        }
      })
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, [inspect]);

  async function handleOpenClick() {
    const path = await pickProjectFolder();
    if (path) inspect(path);
  }

  /** A folder dedup just scaffolded: open it without a second verdict — the
   *  user already chose what to build here. */
  async function openFresh(info: ProjectInfo) {
    await confirmOpen(info, await gitStatus(info.root), null);
  }

  async function confirmOpen(
    info: ProjectInfo,
    git: GitStatus,
    customCommand: string | null,
  ) {
    await addRecentProject(info.root, info.name, info.framework);
    // Remember the command and the acknowledgement, so the next open has
    // nothing left to ask.
    rememberOpen(info, git, customCommand);
    enterEditor(info, git, customCommand);
  }

  async function dropRecent(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    // Nothing about a forgotten project should outlive it — re-adding it
    // later is a first open again: nothing remembered, canvas empty.
    forgetOpen(path);
    forgetCanvas(path);
    await loadRecents(await removeRecentProject(path));
  }

  const empty = recents.length === 0;

  return (
    <div className="h-full overflow-y-auto bg-surface-0 text-ink">
      <div className="mx-auto w-full max-w-5xl px-10 pt-14 pb-16">
        <header className="flex items-end justify-between gap-8 select-none">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <h1 className="text-[22px] font-semibold tracking-tight">dedup</h1>
              <span className="text-2xs text-ink-faint font-mono">
                v0.1 · MVP
              </span>
            </div>
            <p className="text-ink-dim mt-1.5 text-[13px] leading-snug">
              Open any web project to see it on the canvas and edit it.
              React&nbsp;+&nbsp;Tailwind and plain HTML get click-to-inspect
              styling; an empty folder starts a new one.
            </p>
          </div>
          {!empty && (
            <button
              onClick={handleOpenClick}
              disabled={pending !== null}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-accent text-white text-2xs font-medium px-3 py-1.5 hover:brightness-110 disabled:opacity-60"
            >
              <CubeIcon width={13} height={13} /> Open project…
            </button>
          )}
        </header>

        {error && (
          <div className="mt-6 text-2xs text-danger bg-danger/10 border border-danger/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {empty ? (
          <button
            onClick={handleOpenClick}
            disabled={pending !== null}
            className={`mt-10 w-full rounded-xl border border-dashed px-6 py-16 transition-colors text-center
              ${
                dragOver
                  ? "border-accent bg-accent-soft/30"
                  : "border-line-strong hover:border-ink-faint bg-surface-1"
              } disabled:opacity-60`}
          >
            <CubeIcon width={26} height={26} className="mx-auto text-ink-dim mb-3" />
            <div className="text-[13px] font-medium">
              {pending ? "Inspecting project…" : "Open a project folder"}
            </div>
            <div className="text-2xs text-ink-faint mt-1">
              Click to browse, or drag a folder onto the window. An empty one
              gets a starter.
            </div>
          </button>
        ) : (
          <section className="mt-10">
            <div className="flex items-baseline justify-between mb-3.5 select-none">
              <h2 className="text-2xs uppercase tracking-wider text-ink-faint">
                Recent
              </h2>
              <span className="text-2xs text-ink-faint">
                {recents.length} project{recents.length === 1 ? "" : "s"}
              </span>
            </div>

            <ul className="grid gap-x-5 gap-y-7 grid-cols-[repeat(auto-fill,minmax(212px,1fr))]">
              {/* New-project tile, sized like a card so the row aligns. */}
              <li>
                <button
                  onClick={handleOpenClick}
                  disabled={pending !== null}
                  className="w-full text-left group disabled:opacity-60"
                >
                  <div
                    className={`aspect-[16/10] rounded-lg border border-dashed flex flex-col items-center justify-center gap-1.5 transition-colors
                      ${
                        dragOver
                          ? "border-accent bg-accent-soft/30"
                          : "border-line-strong bg-surface-1 group-hover:border-ink-faint group-hover:bg-surface-2"
                      }`}
                  >
                    <CubeIcon width={19} height={19} className="text-ink-dim" />
                    <span className="text-2xs text-ink-dim">Open project</span>
                  </div>
                  <div className="mt-2.5 text-[13px] font-medium text-ink-dim">
                    New
                  </div>
                  <div className="mt-0.5 text-2xs text-ink-faint">
                    Browse, drop, or start in an empty folder
                  </div>
                </button>
              </li>

              {recents.map((r) => {
                const thumb = thumbs[r.path];
                const busy = pending === r.path;
                // Entries written before the grid have neither field — fall
                // back to where the project lives rather than inventing facts.
                const bits = [
                  r.framework ? FRAMEWORK_LABEL[r.framework] : null,
                  relativeTime(r.lastOpened),
                ].filter(Boolean);
                const meta = bits.length ? bits.join(" · ") : parentDir(r.path);
                return (
                  <li key={r.path} className="group relative">
                    <button
                      onClick={() => inspect(r.path)}
                      disabled={pending !== null}
                      title={r.path}
                      className="w-full text-left disabled:opacity-60"
                    >
                      <div className="relative aspect-[16/10] rounded-lg overflow-hidden bg-surface-1 ring-1 ring-line shadow-[0_2px_10px_rgba(0,0,0,0.25)] transition-all group-hover:ring-accent/60 group-hover:shadow-[0_10px_26px_rgba(0,0,0,0.45)] group-hover:-translate-y-0.5">
                        {thumb ? (
                          <img
                            src={thumb}
                            alt=""
                            draggable={false}
                            className="w-full h-full object-cover object-left-top"
                          />
                        ) : (
                          <Placeholder name={r.name} path={r.path} />
                        )}
                        {busy && (
                          <div className="absolute inset-0 grid place-items-center bg-surface-0/70">
                            <Spinner />
                          </div>
                        )}
                      </div>
                      <div className="mt-2.5 text-[13px] font-medium truncate">
                        {r.name}
                      </div>
                      <div className="mt-0.5 text-2xs text-ink-faint truncate">
                        {meta}
                      </div>
                    </button>
                    {/* Opening goes straight in, so project details need a
                        deliberate way in — it is the only place the start
                        command lives. */}
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        void inspect(r.path, true);
                      }}
                      title="Project details — start command"
                      className="absolute top-2 right-9 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded bg-surface-0/80 text-ink-dim hover:text-ink p-1 backdrop-blur-sm transition-opacity cursor-default"
                    >
                      <GearIcon width={12} height={12} />
                    </span>
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => dropRecent(r.path, e)}
                      title="Remove from recents"
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded bg-surface-0/80 text-ink-dim hover:text-ink p-1 backdrop-blur-sm transition-opacity cursor-default"
                    >
                      <Cross2Icon width={12} height={12} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      {/* Whole-window drop affordance — the native drag event isn't scoped to
          the dropzone, so neither is the feedback. */}
      {dragOver && !empty && (
        <div className="fixed inset-0 pointer-events-none border-2 border-accent rounded-lg bg-accent/5 flex items-end justify-center pb-10">
          <span className="text-2xs text-ink bg-surface-2 border border-line-strong rounded-full px-3 py-1.5 shadow-lg">
            Drop a folder to open it
          </span>
        </div>
      )}

      {/* An empty folder gets the starter picker — see StarterPicker. Once it has written a starter the folder is a real
          project, so it re-enters through the same open path as any other. */}
      {candidate?.info.isEmpty ? (
        <StarterPicker
          info={candidate.info}
          onCancel={() => setCandidate(null)}
          onCreated={(info) => {
            setCandidate(null);
            void openFresh(info);
          }}
        />
      ) : (
        candidate && (
          <ProjectDetails
            info={candidate.info}
            git={candidate.git}
            initialCommand={prefFor(candidate.info.root)?.customCommand ?? null}
            onCancel={() => setCandidate(null)}
            onConfirm={(cmd) => confirmOpen(candidate.info, candidate.git, cmd)}
          />
        )
      )}
    </div>
  );
}
