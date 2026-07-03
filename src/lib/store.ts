import { create } from "zustand";
import type {
  DevServerStatus,
  GitStatus,
  LogEvent,
  ProjectInfo,
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
}));
