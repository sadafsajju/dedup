import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  addRecentProject,
  detectProject,
  getRecentProjects,
  gitStatus,
  pickProjectFolder,
  removeRecentProject,
} from "../lib/api";
import { useStore } from "../lib/store";
import type { GitStatus, ProjectInfo, RecentProject } from "../lib/types";
import { CompatCard } from "./CompatCard";
import { FolderIcon, XIcon } from "./icons";

interface Candidate {
  info: ProjectInfo;
  git: GitStatus;
}

export function LaunchScreen() {
  const enterEditor = useStore((s) => s.enterEditor);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRecentProjects().then(setRecents).catch(() => {});
  }, []);

  const inspect = useCallback(async (path: string) => {
    setError(null);
    setInspecting(true);
    try {
      const [info, git] = await Promise.all([
        detectProject(path),
        gitStatus(path),
      ]);
      setCandidate({ info, git });
    } catch (e) {
      setError(String(e));
    } finally {
      setInspecting(false);
    }
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

  async function confirmOpen(info: ProjectInfo, git: GitStatus) {
    const updated = await addRecentProject(info.root, info.name);
    setRecents(updated);
    enterEditor(info, git);
  }

  async function dropRecent(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    const updated = await removeRecentProject(path);
    setRecents(updated);
  }

  return (
    <div className="h-full flex flex-col items-center justify-center bg-surface-0 text-ink px-8">
      <div className="w-full max-w-xl">
        <header className="mb-8 select-none">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">dedup</h1>
            <span className="text-2xs text-ink-faint font-mono">v0.1 · MVP</span>
          </div>
          <p className="text-ink-dim mt-1.5 text-[13px] leading-snug">
            Open a React&nbsp;+&nbsp;Tailwind project to inspect, tune, and merge
            near-duplicate components.
          </p>
        </header>

        <button
          onClick={handleOpenClick}
          disabled={inspecting}
          className={`w-full rounded-lg border border-dashed px-6 py-10 transition-colors text-center
            ${
              dragOver
                ? "border-accent bg-accent-soft/30"
                : "border-line-strong hover:border-ink-faint bg-surface-1"
            } disabled:opacity-60`}
        >
          <FolderIcon size={26} className="mx-auto text-ink-dim mb-3" />
          <div className="text-[13px] font-medium">
            {inspecting ? "Inspecting project…" : "Open a project folder"}
          </div>
          <div className="text-2xs text-ink-faint mt-1">
            Click to browse, or drag a folder onto the window
          </div>
        </button>

        {error && (
          <div className="mt-4 text-2xs text-danger bg-danger/10 border border-danger/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {recents.length > 0 && (
          <section className="mt-8">
            <h2 className="text-2xs uppercase tracking-wider text-ink-faint mb-2 select-none">
              Recent
            </h2>
            <ul className="flex flex-col gap-0.5">
              {recents.map((r) => (
                <li key={r.path}>
                  <button
                    onClick={() => inspect(r.path)}
                    className="group w-full flex items-center gap-3 rounded-md px-3 py-2 hover:bg-surface-2 text-left"
                  >
                    <FolderIcon size={15} className="text-ink-faint shrink-0" />
                    <span className="text-[13px] shrink-0">{r.name}</span>
                    <span className="text-2xs text-ink-faint truncate flex-1 font-mono">
                      {r.path}
                    </span>
                    <span
                      onClick={(e) => dropRecent(r.path, e)}
                      className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-ink p-0.5 rounded"
                      title="Remove from recents"
                    >
                      <XIcon size={13} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {candidate && (
        <CompatCard
          info={candidate.info}
          git={candidate.git}
          onCancel={() => setCandidate(null)}
          onConfirm={() => confirmOpen(candidate.info, candidate.git)}
        />
      )}
    </div>
  );
}
