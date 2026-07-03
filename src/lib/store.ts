import { create } from "zustand";
import { sendToOverlay } from "./bridge";
import type {
  DevServerStatus,
  GitStatus,
  LogEvent,
  ProjectInfo,
  SelectedElement,
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
}

export const useStore = create<AppState>((set) => ({
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

  setSelected: (selected) => set({ selected }),

  clearSelection: () => {
    sendToOverlay({ type: "clear" });
    set({ selected: null });
  },

  selectById: (id) => sendToOverlay({ type: "select-id", id }),
}));
