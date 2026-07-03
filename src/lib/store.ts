import { create } from "zustand";
import { commitSession, gitStatus, inspectElement, writeClasses } from "./api";
import { sendToOverlay } from "./bridge";
import { parseDedupId } from "./types";
import type {
  DevServerStatus,
  GitStatus,
  LogEvent,
  ProjectInfo,
  SelectedElement,
  SourceClassInfo,
  StagedEdit,
  Viewport,
} from "./types";

const MAX_LOG_LINES = 2000;

type View = "launch" | "editor";

interface AppState {
  view: View;
  project: ProjectInfo | null;
  git: GitStatus | null;
  /** Custom dev command override (FR-1.3); null = `<pm> run dev`. */
  customCommand: string | null;

  devStatus: DevServerStatus;
  devUrl: string | null;
  devPort: number | null;
  exitCode: number | null;
  crashed: boolean;

  logs: LogEvent[];
  consoleOpen: boolean;

  viewportId: Viewport["id"];
  zoom: number;

  /** Element currently selected on the canvas (FR-2.2). */
  selected: SelectedElement | null;
  /** What the source says about the selection's className (FR-4.2). */
  sourceInfo: SourceClassInfo | null;

  /** Unsaved class edits keyed by dedupId (FR-3.7). */
  staged: Record<string, StagedEdit>;
  undoStack: Array<{ dedupId: string; from: string; to: string }>;
  redoStack: Array<{ dedupId: string; from: string; to: string }>;
  saving: boolean;
  lastSave: { branch: string; hash: string } | null;
  saveError: string | null;

  // actions
  enterEditor: (
    project: ProjectInfo,
    git: GitStatus | null,
    customCommand?: string | null,
  ) => void;
  backToLaunch: () => void;
  setDevStatus: (status: DevServerStatus) => void;
  setDevReady: (url: string, port: number) => void;
  setCrashed: (code: number | null) => void;
  appendLog: (log: LogEvent) => void;
  clearLogs: () => void;
  toggleConsole: (open?: boolean) => void;
  setViewport: (id: Viewport["id"]) => void;
  setZoom: (zoom: number) => void;
  setSelected: (sel: SelectedElement | null) => void;
  /** Clear selection here and in the overlay. */
  clearSelection: () => void;
  /** Ask the overlay to select an element by dedupId (breadcrumb clicks). */
  selectById: (id: string) => void;

  /** The class string the panel should show/edit for the selection. */
  effectiveClassName: () => string | null;
  /** Stage a class edit + live-patch the canvas (FR-3.7). */
  applyClassEdit: (next: string) => void;
  undo: () => void;
  redo: () => void;
  /** Write staged edits to source, commit on the session branch (FR-4.x). */
  saveAll: () => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  view: "launch",
  project: null,
  git: null,
  customCommand: null,

  devStatus: "idle",
  devUrl: null,
  devPort: null,
  exitCode: null,
  crashed: false,

  logs: [],
  consoleOpen: false,

  viewportId: "desktop",
  zoom: 1,
  selected: null,
  sourceInfo: null,

  staged: {},
  undoStack: [],
  redoStack: [],
  saving: false,
  lastSave: null,
  saveError: null,

  enterEditor: (project, git, customCommand = null) =>
    set({
      view: "editor",
      project,
      git,
      customCommand,
      devStatus: "idle",
      devUrl: null,
      devPort: null,
      exitCode: null,
      crashed: false,
      logs: [],
      selected: null,
      sourceInfo: null,
      staged: {},
      undoStack: [],
      redoStack: [],
      lastSave: null,
      saveError: null,
    }),

  backToLaunch: () =>
    set({
      view: "launch",
      project: null,
      git: null,
      customCommand: null,
      devStatus: "idle",
      devUrl: null,
      devPort: null,
      logs: [],
      crashed: false,
      selected: null,
      sourceInfo: null,
      staged: {},
      undoStack: [],
      redoStack: [],
      lastSave: null,
      saveError: null,
    }),

  setDevStatus: (devStatus) => set({ devStatus }),

  setDevReady: (url, port) =>
    set({ devStatus: "ready", devUrl: url, devPort: port, crashed: false }),

  setCrashed: (code) =>
    set({ devStatus: "crashed", crashed: true, exitCode: code }),

  appendLog: (log) =>
    set((s) => {
      const next = s.logs.length >= MAX_LOG_LINES ? s.logs.slice(-MAX_LOG_LINES + 1) : s.logs.slice();
      next.push(log);
      return { logs: next };
    }),

  clearLogs: () => set({ logs: [] }),

  toggleConsole: (open) =>
    set((s) => ({ consoleOpen: open ?? !s.consoleOpen })),

  setViewport: (viewportId) => set({ viewportId }),

  setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.25, zoom)) }),

  setSelected: (selected) => {
    set({ selected, sourceInfo: null });
    if (!selected) return;
    // Ask the source of truth (the file) what this element's classes are.
    const pos = parseDedupId(selected.dedupId);
    const root = get().project?.root;
    if (!pos || !root) return;
    inspectElement(root, pos.file, pos.line, pos.col)
      .then((r) => {
        if (get().selected?.dedupId !== selected.dedupId) return; // stale
        if (!r.ok) {
          set({
            sourceInfo: {
              editable: false,
              className: null,
              reason: r.error ?? "source lookup failed",
            },
          });
          return;
        }
        set({
          sourceInfo: {
            editable: r.editable ?? false,
            className: r.className ?? null,
            reason: r.reason ?? null,
          },
        });
      })
      .catch((e) => {
        if (get().selected?.dedupId !== selected.dedupId) return;
        set({
          sourceInfo: { editable: false, className: null, reason: String(e) },
        });
      });
  },

  clearSelection: () => {
    sendToOverlay({ type: "clear" });
    set({ selected: null, sourceInfo: null });
  },

  selectById: (id) => sendToOverlay({ type: "select-id", id }),

  effectiveClassName: () => {
    const { selected, staged, sourceInfo } = get();
    if (!selected) return null;
    const entry = staged[selected.dedupId];
    if (entry) return entry.current;
    return sourceInfo?.className ?? null;
  },

  applyClassEdit: (next) => {
    const { selected, sourceInfo, staged, undoStack } = get();
    if (!selected || !sourceInfo?.editable) return;
    const pos = parseDedupId(selected.dedupId);
    if (!pos) return;

    const existing = staged[selected.dedupId];
    const from = existing?.current ?? sourceInfo.className ?? "";
    if (next === from) return;

    const entry: StagedEdit = existing
      ? { ...existing, current: next }
      : {
          dedupId: selected.dedupId,
          file: pos.file,
          line: pos.line,
          col: pos.col,
          original: sourceInfo.className ?? "",
          current: next,
          component: selected.component,
        };

    sendToOverlay({ type: "set-class", id: selected.dedupId, className: next });
    set({
      staged: { ...staged, [selected.dedupId]: entry },
      undoStack: [...undoStack, { dedupId: selected.dedupId, from, to: next }],
      redoStack: [],
    });
  },

  undo: () => {
    const { undoStack, redoStack, staged } = get();
    const op = undoStack[undoStack.length - 1];
    if (!op) return;
    const entry = staged[op.dedupId];
    if (entry) {
      const nextStaged = { ...staged };
      if (op.from === entry.original) {
        // Fully reverted — drop the staged entry and let source rule again.
        delete nextStaged[op.dedupId];
        sendToOverlay({
          type: "reset-class",
          id: op.dedupId,
          className: entry.original,
        });
      } else {
        nextStaged[op.dedupId] = { ...entry, current: op.from };
        sendToOverlay({ type: "set-class", id: op.dedupId, className: op.from });
      }
      set({
        staged: nextStaged,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, op],
      });
    } else {
      set({ undoStack: undoStack.slice(0, -1) });
    }
  },

  redo: () => {
    const { undoStack, redoStack, staged, selected } = get();
    const op = redoStack[redoStack.length - 1];
    if (!op) return;
    const entry = staged[op.dedupId];
    const pos = parseDedupId(op.dedupId);
    if (!pos) return;
    const base: StagedEdit = entry ?? {
      dedupId: op.dedupId,
      file: pos.file,
      line: pos.line,
      col: pos.col,
      original: op.from,
      current: op.from,
      component:
        selected?.dedupId === op.dedupId ? selected.component : null,
    };
    sendToOverlay({ type: "set-class", id: op.dedupId, className: op.to });
    set({
      staged: { ...staged, [op.dedupId]: { ...base, current: op.to } },
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, op],
    });
  },

  saveAll: async () => {
    const { project, staged, saving } = get();
    if (!project || saving) return;
    const dirty = Object.values(staged).filter((e) => e.current !== e.original);
    if (dirty.length === 0) return;

    set({ saving: true, saveError: null });
    try {
      // Group by file; one AST pass per file, all ranges from one parse.
      const byFile = new Map<string, StagedEdit[]>();
      for (const e of dirty) {
        byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
      }
      for (const [file, edits] of byFile) {
        const res = await writeClasses(
          project.root,
          file,
          edits.map((e) => ({ line: e.line, col: e.col, className: e.current })),
        );
        if (!res.ok) throw new Error(res.error ?? `write failed for ${file}`);
      }

      const names = [...new Set(dirty.map((e) => e.component ?? "element"))];
      const label =
        names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1} more`;
      const message = `dedup: adjust classes on ${label}`;
      const [branch, hash] = await commitSession(
        project.root,
        message,
        [...byFile.keys()],
      );

      sendToOverlay({ type: "clear-staged" });
      set({
        staged: {},
        undoStack: [],
        redoStack: [],
        lastSave: { branch, hash },
      });
      // Branch may have just been created — refresh the TopBar indicator.
      gitStatus(project.root)
        .then((g) => set({ git: g }))
        .catch(() => {});
      // Re-sync the selection's source info after HMR settles (FR-4.3 lite).
      const sel = get().selected;
      if (sel) {
        setTimeout(() => {
          const still = get().selected;
          if (still?.dedupId === sel.dedupId) get().setSelected(still);
        }, 800);
      }
    } catch (e) {
      set({ saveError: String(e instanceof Error ? e.message : e) });
    } finally {
      set({ saving: false });
    }
  },
}));
