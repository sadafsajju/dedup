// Types mirroring the Rust serde structs (camelCase over the IPC boundary).

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm" | "unknown";
export type Framework = "vite" | "next" | "unknown";
export type SupportLevel = "full" | "partial" | "unsupported";

export interface ProjectInfo {
  root: string;
  name: string;
  packageManager: PackageManager;
  framework: Framework;
  hasTailwind: boolean;
  hasTypescript: boolean;
  hasGit: boolean;
  devScript: string | null;
  support: SupportLevel;
  summary: string;
  warnings: string[];
}

export interface GitStatus {
  isRepo: boolean;
  isDirty: boolean;
  branch: string | null;
  changedFiles: number;
}

export interface RecentProject {
  path: string;
  name: string;
}

// Dev-server event payloads.
export interface LogEvent {
  stream: "stdout" | "stderr";
  line: string;
}
export interface ReadyEvent {
  /** URL the canvas should load (a local plain-HTTP tunnel when proxied). */
  url: string;
  /** The dev server's own port. */
  port: number;
  /** True when url is a tunnel in front of a self-signed https server. */
  proxied: boolean;
  /** The dev server's original URL when proxied. */
  upstreamUrl: string | null;
}
export interface ExitEvent {
  code: number | null;
  requested: boolean;
}
export interface StatusEvent {
  status: "starting" | "stopping" | "stopped";
}

export type DevServerStatus =
  | "idle"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "crashed";

// Canvas viewport presets (FR-1.4).
export interface Viewport {
  id: "mobile" | "tablet" | "desktop";
  label: string;
  width: number;
  height: number | null; // null = fill available height
}

export const VIEWPORTS: Viewport[] = [
  { id: "mobile", label: "Mobile", width: 390, height: 844 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "desktop", label: "Desktop", width: 1440, height: null },
];
