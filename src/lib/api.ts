// Typed wrappers over the Tauri command + event surface.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ExitEvent,
  GitStatus,
  LogEvent,
  PackageManager,
  ProjectInfo,
  ReadyEvent,
  RecentProject,
  StatusEvent,
} from "./types";

export const detectProject = (root: string) =>
  invoke<ProjectInfo>("detect_project", { root });

export const gitStatus = (root: string) =>
  invoke<GitStatus>("git_status", { root });

export const startDevServer = (
  root: string,
  packageManager: PackageManager,
  customCommand?: string,
) =>
  invoke<void>("start_dev_server", {
    root,
    packageManager,
    customCommand: customCommand ?? null,
  });

export const stopDevServer = () => invoke<void>("stop_dev_server");

export const devServerRunning = () =>
  invoke<boolean>("dev_server_running");

export const getRecentProjects = () =>
  invoke<RecentProject[]>("get_recent_projects");

export const addRecentProject = (path: string, name: string) =>
  invoke<RecentProject[]>("add_recent_project", { path, name });

export const removeRecentProject = (path: string) =>
  invoke<RecentProject[]>("remove_recent_project", { path });

/** Native folder picker (FR-1.1). Returns the chosen path or null if cancelled. */
export async function pickProjectFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open a React project",
  });
  return typeof selected === "string" ? selected : null;
}

// --- Dev-server event subscriptions --------------------------------------

export const onDevServerLog = (cb: (e: LogEvent) => void): Promise<UnlistenFn> =>
  listen<LogEvent>("devserver://log", (e) => cb(e.payload));

export const onDevServerReady = (
  cb: (e: ReadyEvent) => void,
): Promise<UnlistenFn> =>
  listen<ReadyEvent>("devserver://ready", (e) => cb(e.payload));

export const onDevServerExit = (
  cb: (e: ExitEvent) => void,
): Promise<UnlistenFn> =>
  listen<ExitEvent>("devserver://exit", (e) => cb(e.payload));

export const onDevServerStatus = (
  cb: (e: StatusEvent) => void,
): Promise<UnlistenFn> =>
  listen<StatusEvent>("devserver://status", (e) => cb(e.payload));
