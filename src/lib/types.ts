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

// --- Element selection (FR-2.2, FR-2.4) -----------------------------------

/** One tagged element as reported by the canvas overlay. */
export interface ElementRef {
  /** `file:line:col` — the source position of the JSX element. */
  dedupId: string;
  /** Enclosing component name, when the tagger could determine it. */
  component: string | null;
  /** DOM tag name (or lowercased component tag for custom elements). */
  tag: string;
}

export interface SelectedElement extends ElementRef {
  rect: { x: number; y: number; width: number; height: number };
  /** How many DOM instances share this source position (.map() loops). */
  instanceCount: number;
  /** Innermost-first chain of tagged ancestors, including the element. */
  ancestry: ElementRef[];
}

/** Parse a dedupId back into its parts. */
export function parseDedupId(
  id: string,
): { file: string; line: number; col: number } | null {
  const m = id.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), col: Number(m[3]) };
}

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
