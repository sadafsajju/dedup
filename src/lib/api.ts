// Typed wrappers over the Tauri command + event surface.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  CoreKind,
  DynamicKind,
  EditOp,
  ExitEvent,
  Framework,
  GitStatus,
  InstrumentationInfo,
  LogEvent,
  PackageManager,
  ProjectInfo,
  ReadyEvent,
  RecentProject,
  ScanProgress,
  ScanResult,
  SessionSeed,
  AuthContext,
  StatusEvent,
  MergePlan,
  MergePreview,
  GateResult,
  HistoryEntry,
  TrashEntry,
  VisualDiff,
  NextStatus,
} from "./types";

export const detectProject = (root: string) =>
  invoke<ProjectInfo>("detect_project", { root });

export const gitStatus = (root: string) =>
  invoke<GitStatus>("git_status", { root });

export const startDevServer = (
  root: string,
  packageManager: PackageManager,
  framework: Framework,
  devScript: string | null,
  customCommand?: string,
) =>
  invoke<void>("start_dev_server", {
    root,
    packageManager,
    framework,
    devScript,
    customCommand: customCommand ?? null,
  });

export const stopDevServer = () => invoke<void>("stop_dev_server");

export const devServerRunning = () =>
  invoke<boolean>("dev_server_running");

// --- Write-back (FR-4.x) ---------------------------------------------------

/** The write-back's report on one node — see NodeInfo in lib/types. */
export interface InspectResult {
  ok: boolean;
  error?: string;
  editable?: boolean;
  className?: string | null;
  reason?: string | null;
  line?: number;
  col?: number;
  tag?: string;
  component?: string | null;
  dynamic?: DynamicKind | null;
  core?: CoreKind | null;
  parentIndex?: number | null;
  canRemove?: boolean;
  canMove?: boolean;
  structuralReason?: string | null;
  canAcceptChildren?: boolean;
  canEditText?: boolean;
  textReason?: string | null;
  text?: string | null;
}

/** `index` is the element's ordinal in the shared jsxwalk traversal. */
export const inspectElement = (root: string, file: string, index: number) =>
  invoke<InspectResult>("inspect_element", { root, file, index });

/** Apply one file's staged edit program — all ops land, or none do. */
export const applyEdits = (root: string, file: string, ops: EditOp[]) =>
  invoke<{ ok: boolean; changed?: boolean; error?: string }>("apply_edits", {
    root,
    file,
    ops,
  });

// --- AI chat edits (Inspector chat tab) --------------------------------------

/** Read one project source file (path resolved inside the project root). */
export const readSource = (root: string, file: string) =>
  invoke<string>("read_source", { root, file });

/** Replace one source file; the sidecar re-parses before writing. */
export const writeSource = (root: string, file: string, content: string) =>
  invoke<{ ok: boolean; changed?: boolean; error?: string }>("write_source", {
    root,
    file,
    content,
  });

// --- Duplicate scan (FR-5.x) -----------------------------------------------

/** `files` scopes clustering to the current canvas page; omit for project-wide. */
export const scanProject = (root: string, files?: string[] | null) =>
  invoke<ScanResult>("scan_project", { root, files: files ?? null });

/** Last persisted scan for the project, or null when never scanned. */
export const loadScanResult = (root: string) =>
  invoke<ScanResult | null>("load_scan_result", { root });

/** Is the Claude Code CLI installed? (preferred AI backend). */
export const claudeCodeAvailable = () =>
  invoke<boolean>("claude_code_available");

/** One headless prompt through the user's Claude Code install.
 *  `model` is a CLI alias or full id; null/omitted uses the CLI default. */
export const claudeCodePrompt = (prompt: string, model?: string | null) =>
  invoke<string>("claude_code_prompt", { prompt, model: model ?? null });

/** Cached AI category assignments (file#name → {hash, category}). */
export const loadSessionSeed = (root: string) =>
  invoke<SessionSeed | null>("load_session_seed", { root });

export const saveSessionSeed = (root: string, enabled: boolean, script: string) =>
  invoke<void>("save_session_seed", { root, enabled, script });

export const collectAuthContext = (root: string) =>
  invoke<AuthContext>("collect_auth_context", { root });

export const loadCategories = (root: string) =>
  invoke<Record<string, { hash: string; category: string }> | null>(
    "load_categories",
    { root },
  );

export const saveCategories = (
  root: string,
  categories: Record<string, { hash: string; category: string }>,
) => invoke<void>("save_categories", { root, categories });

export const onScanProgress = (
  cb: (e: ScanProgress) => void,
): Promise<UnlistenFn> =>
  listen<ScanProgress>("scan://progress", (e) => cb(e.payload));

/** Returns [branch, shortHash]. */
export const commitSession = (root: string, message: string, paths: string[]) =>
  invoke<[string, string]>("commit_session", { root, message, paths });

export const getRecentProjects = () =>
  invoke<RecentProject[]>("get_recent_projects");

export const addRecentProject = (
  path: string,
  name: string,
  framework?: Framework | null,
) =>
  invoke<RecentProject[]>("add_recent_project", {
    path,
    name,
    framework: framework ?? null,
  });

export const removeRecentProject = (path: string) =>
  invoke<RecentProject[]>("remove_recent_project", { path });

// --- Launch-grid thumbnails -------------------------------------------------

/** Stored card image as a data URL, or null if never captured. */
export const projectThumbnail = (root: string) =>
  invoke<string | null>("project_thumbnail", { root });

/** Snapshot a region of the app window (CSS px) as the project's card image.
 *  Best-effort: capture failures must never block leaving a project. */
export const captureProjectThumbnail = (
  root: string,
  rect?: { x: number; y: number; width: number; height: number } | null,
) => invoke<void>("capture_project_thumbnail", { root, rect: rect ?? null });

/** Capture the canvas surface as the project card image; silent on failure. */
export async function captureCanvasThumbnail(root: string): Promise<void> {
  const el = document.querySelector("[data-canvas-root]");
  const r = el?.getBoundingClientRect();
  try {
    await captureProjectThumbnail(
      root,
      r && r.width > 0 && r.height > 0
        ? { x: r.x, y: r.y, width: r.width, height: r.height }
        : null,
    );
  } catch {
    /* thumbnails are a nicety — never surface this */
  }
}

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

export const onInstrumentation = (
  cb: (e: InstrumentationInfo) => void,
): Promise<UnlistenFn> =>
  listen<InstrumentationInfo>("devserver://instrumentation", (e) =>
    cb(e.payload),
  );

/** Page routes read from the project's files — works with no dev server, and
 *  is the only route source a Next.js project has (no middleware to add). */
export const detectRoutesFromSource = (root: string) =>
  invoke<{ ok: boolean; routes?: string[]; error?: string }>("detect_routes", {
    root,
  });

/** What dedup can do for a Next.js project: wired, offered (with the exact
 *  config diff), or unavailable with a reason. Read-only. */
export const nextStatus = (root: string) =>
  invoke<NextStatus>("next_status", { root });

// --- Guarded merge (FR-5.4 → FR-5.7) ----------------------------------------

/** Read-only: member sources, prop signatures, behaviour, traced call sites. */
export const mergePlan = (root: string, members: { file: string; name: string }[]) =>
  invoke<MergePlan>("merge_plan", { root, members });

/** `dryRun` returns every file's before/after and writes nothing. */
export const mergeApply = (
  root: string,
  canonical: { name: string; file: string; source: string },
  mapping: { name: string; file: string; props: Record<string, unknown> }[],
  dryRun: boolean,
) => invoke<MergePreview>("merge_apply", { root, canonical, mapping, dryRun });

/** Staged-deletion lifecycle (FR-5.5). */
export const mergeTrash = (
  root: string,
  action: "list" | "restore" | "empty",
  files?: string[] | null,
) =>
  invoke<{ ok: boolean; files?: TrashEntry[]; restored?: string[]; deleted?: number }>(
    "merge_trash",
    { root, action, files: files ?? null },
  );

/** One safety gate. A project with no such script reports `skipped`. */
export const runCheck = (root: string, kind: "typecheck" | "build") =>
  invoke<GateResult>("run_check", { root, kind });

/** dedup's own commits on the session branch, newest first (FR-5.7). */
export const sessionHistory = (root: string, limit?: number) =>
  invoke<HistoryEntry[]>("session_history", { root, limit: limit ?? null });

/** Undo one dedup commit; returns the short hash of the undo commit. */
export const revertCommit = (root: string, hash: string) =>
  invoke<string>("revert_commit", { root, hash });

// --- Visual pass (FR-5.2 visual signal, FR-5.6 #3) --------------------------

type Rect = { x: number; y: number; width: number; height: number };

/** Snapshot a canvas region under `label`, held in Rust for a later compare. */
export const visualCapture = (label: string, rect?: Rect | null) =>
  invoke<void>("visual_capture", { label, rect: rect ?? null });

export const visualCompare = (before: string, after: string) =>
  invoke<VisualDiff>("visual_compare", { before, after });

/** Perceptual hash of a canvas region, as hex. */
export const visualHash = (rect?: Rect | null) =>
  invoke<string>("visual_hash", { rect: rect ?? null });

export const visualSimilarity = (a: string, b: string) =>
  invoke<number>("visual_similarity", { a, b });

export const visualForget = (prefix?: string) =>
  invoke<void>("visual_forget", { prefix: prefix ?? null });

/**
 * Where an artboard sits in the app window right now, in CSS px — the region
 * the snapshot API captures. Returns null when that artboard isn't mounted
 * (off-screen frames unmount), which the caller must treat as "cannot check",
 * never as "nothing changed".
 */
export function artboardRect(route: string): Rect | null {
  const el = document.querySelector(`[data-artboard="${CSS.escape(route)}"]`);
  const r = el?.getBoundingClientRect();
  if (!r || r.width < 1 || r.height < 1) return null;
  // Clip to the visible window: a frame scrolled half off-screen would
  // otherwise capture a region the webview cannot rasterise.
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const width = Math.min(r.right, window.innerWidth) - x;
  const height = Math.min(r.bottom, window.innerHeight) - y;
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}
