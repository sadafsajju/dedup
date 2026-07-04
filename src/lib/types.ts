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

/** Page identity reported by the overlay — the canvas frame's label. */
export interface PageMeta {
  title: string;
  path: string;
}

/** Whether element tagging is active for the session, and why not when off. */
export interface InstrumentationInfo {
  active: boolean;
  mode: "tagged" | "custom" | "framework" | "script" | "error";
  detail: string | null;
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
  /** The element's current DOM class attribute (may include runtime classes). */
  domClassName: string;
}

/** What the source says about the selected element's className (FR-4.2). */
export interface SourceClassInfo {
  editable: boolean;
  /** Static class string from source; null when dynamic. */
  className: string | null;
  /** Why the panel is read-only, when it is. */
  reason: string | null;
}

/** An unsaved class edit, keyed by dedupId (FR-3.7). */
export interface StagedEdit {
  dedupId: string;
  file: string;
  line: number;
  col: number;
  original: string;
  current: string;
  component: string | null;
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

// --- Duplicate scan (FR-5.1, FR-5.2, FR-5.3) --------------------------------

export interface ScanMember {
  name: string;
  file: string;
  line: number;
  col: number;
  exportKind: "default" | "named" | "local";
  props: string[];
  nodeCount: number;
  /** Name-based `<Name` usage count across the project (approximate). */
  callSites: number;
  classTokens: string[];
  /** Indented tag/class outline of the component's JSX, for the diff view. */
  skeleton: string;
}

export interface ScanCluster {
  /** Stable hash of the member set — dismissals key off this. */
  id: string;
  confidence: number;
  totalCallSites: number;
  members: ScanMember[];
}

/** A component that qualifies for a rendered artboard on the canvas. */
export interface GalleryEntry {
  name: string;
  file: string;
  line: number;
  col: number;
  exportKind: "default" | "named" | "local";
  props: string[];
  nodeCount: number;
  callSites: number;
  clusterId: string | null;
  /** Capped structural outline — AI categorization input + change hash. */
  skeleton: string;
}

/** Bump alongside scan.mjs's `schema` whenever the result shape changes. */
export const SCAN_SCHEMA = 2;

export interface ScanResult {
  ok: boolean;
  /** Persisted-result schema version; restores require an exact match. */
  schema?: number;
  error?: string;
  files: number;
  skipped: number;
  components: number;
  /** File count when scoped to the current canvas page; null = whole project. */
  scopedFiles: number | null;
  clusters: ScanCluster[];
  gallery: GalleryEntry[];
  durationMs: number;
  /** Epoch ms when the scan ran — restored results show their age. */
  scannedAt?: number;
}

export interface ScanProgress {
  stage: "inventory" | "similarity";
  done: number;
  total: number;
}

export type SidebarTab = "pages" | "layers" | "duplicates";

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
