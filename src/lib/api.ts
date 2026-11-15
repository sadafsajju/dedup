// Typed wrappers over the Tauri command + event surface.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  CoreKind,
  DynamicKind,
  EditOp,
  ExitEvent,
  Framework,
  GitStatus,
  InstrumentationInfo,
  LogEvent,
  ProjectInfo,
  ReadyEvent,
  RecentProject,
  SessionSeed,
  AuthContext,
  StatusEvent,
  HistoryEntry,
  SyncStatus,
  NextStatus,
  CliAgent,
  StarterKind,
} from "./types";

export const detectProject = (root: string) =>
  invoke<ProjectInfo>("detect_project", { root });

export const gitStatus = (root: string) =>
  invoke<GitStatus>("git_status", { root });

/** The menu bar's Settings… (⌘,) — the native menu item lives in Rust
 *  (appmenu.rs) and says so with this event. Resolves to the unsubscribe. */
export const onOpenSettings = (cb: () => void): Promise<UnlistenFn> =>
  listen("open-settings", () => cb());

/** One artboard export. Rendered by WebKit at the artboard's real size in an
 *  off-screen view — not a crop of the canvas (see export.rs). */
export interface ExportRequest {
  url: string;
  width: number;
  height: number;
  format: "png" | "pdf";
  /** PNG pixels per CSS px. */
  scale?: number;
  path: string;
}

export const exportArtboard = (request: ExportRequest) =>
  invoke<{ path: string; bytes: number; width: number; height: number }>(
    "export_artboard",
    { request },
  );

/** Ask where to save an export. null when the user cancels. */
export const chooseExportPath = async (
  defaultName: string,
  format: "png" | "pdf",
): Promise<string | null> =>
  (await save({
    defaultPath: defaultName,
    filters: [{ name: format === "png" ? "PNG image" : "PDF document", extensions: [format] }],
  })) ?? null;

/** A region of the app window as a PNG data URL, rendered `width` points
 *  wide — a parked element's picture, taken while it is still on its page. */
export const snapshotRegion = (rect: Rect, width: number) =>
  invoke<string>("snapshot_region", { rect, width });

/** The project's parked canvas pieces, as stored (validated by the caller). */
export const loadParked = (root: string) => invoke<unknown>("load_parked", { root });
export const saveParked = (root: string, items: unknown) =>
  invoke<void>("save_parked", { root, items });

/** Make a folder with no git a repository whose first commit is its files as
 *  they stand. Refuses one already inside a repository. */
export const gitInitBaseline = (root: string) =>
  invoke<GitStatus>("git_init_baseline", { root });

/** Start the project's dev server. Takes the whole detection result because
 *  what to launch is a property of the project, not five loose arguments —
 *  and a static site needs `staticDir`, which only detection knows. */
export const startDevServer = (project: ProjectInfo, customCommand?: string) =>
  invoke<void>("start_dev_server", {
    root: project.root,
    packageManager: project.packageManager,
    framework: project.framework,
    devScript: project.devScript,
    devScriptName: project.devScriptName,
    staticDir: project.staticDir,
    runCommand: project.runCommand,
    stack: project.stack,
    customCommand: customCommand ?? null,
  });

/** Write a starter into an empty folder and make it a git repo. Returns the
 *  freshly detected project. Progress streams as `scaffold://log`. */
export const scaffoldProject = (root: string, kind: StarterKind) =>
  invoke<ProjectInfo>("scaffold_project", { root, kind });

export const onScaffoldLog = (
  cb: (line: string) => void,
): Promise<UnlistenFn> =>
  listen<{ line: string }>("scaffold://log", (e) => cb(e.payload.line));

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

/** One element's own source, as a snippet a paste can write elsewhere, plus
 *  the names it reads but does not carry with it (components, variables). */
export const copyElement = (root: string, file: string, index: number) =>
  invoke<{
    ok: boolean;
    error?: string;
    snippet?: string;
    lang?: "jsx" | "html";
    tag?: string;
    component?: string | null;
    refs?: string[];
    /** Ordinals inside the copied subtree, itself included. */
    contains?: number[];
  }>("copy_element", { root, file, index });

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

/**
 * Replace several source files as one all-or-nothing write — the chat agent's
 * write path. Every file's new content is validated before any of them is
 * written, so a multi-file edit cannot leave the project half-changed. Files
 * that don't exist yet are created (and only here: this is the one path on
 * which dedup writes a file the user didn't already have).
 */
export const writeSources = (root: string, files: [string, string][]) =>
  invoke<{ ok: boolean; changed?: string[]; error?: string }>("write_sources", {
    root,
    files,
  });

/**
 * Put files back exactly as dedup found them — discarding a previewed chat
 * edit. A null content means the file didn't exist before and is removed.
 * Deliberately not content-gated: this restores bytes dedup read off these
 * files, and a file that was already broken must still be restorable.
 */
export const revertSources = (
  root: string,
  files: [string, string | null][],
) =>
  invoke<{ ok: boolean; restored?: string[]; error?: string }>(
    "revert_sources",
    { root, files },
  );

/** Every file the chat agent may look at, project-relative. */
export const listProjectFiles = (root: string) =>
  invoke<{ ok: boolean; files?: string[]; total?: number; error?: string }>(
    "list_project_files",
    { root },
  );

/** Line matches for `pattern` across those same files. */
export const grepProject = (root: string, pattern: string) =>
  invoke<{
    ok: boolean;
    matches?: { file: string; line: number; text: string }[];
    truncated?: boolean;
    error?: string;
  }>("grep_project", { root, pattern });

/** Is this coding-agent CLI installed? (preferred AI backends — they run on
 *  a subscription the user already has; an API key is the fallback). */
export const agentAvailable = (agent: CliAgent) =>
  invoke<boolean>("agent_available", { agent });

/** One headless prompt through the named agent's CLI. `model` is whatever
 *  that CLI calls a model; null/omitted uses its own default. */
export const agentPrompt = (
  agent: CliAgent,
  prompt: string,
  model?: string | null,
) => invoke<string>("agent_prompt", { agent, prompt, model: model ?? null });

/** The models this agent's installed CLI offers, in its own order. Empty for
 *  a CLI with no catalog (Claude Code — its aliases are in CLI_AGENTS). */
export const agentModels = (agent: CliAgent) =>
  invoke<{ value: string; label: string }[]>("agent_models", { agent });

/** Copy a file the agent generated into the project — an image, the one
 *  output it cannot put in its reply. Every gate is in `asset.rs`: the source
 *  must be inside that agent's own output directory, the bytes must sniff as
 *  an image, and the destination must be a new path inside the project. */
export const importAgentAsset = (
  root: string,
  agent: CliAgent,
  source: string,
  dest: string,
  /** For a destination named before the image existed (an IMAGE request):
   *  correct a disagreeing extension rather than refuse. `file` in the result
   *  is then where it actually landed. */
  adaptExtension = false,
) =>
  invoke<{ file: string; bytes: number; kind: string }>("import_agent_asset", {
    root,
    agent,
    source,
    dest,
    adaptExtension,
  });

/** Reviewed mock-session seed, if configured. */
export const loadSessionSeed = (root: string) =>
  invoke<SessionSeed | null>("load_session_seed", { root });

export const saveSessionSeed = (root: string, enabled: boolean, script: string) =>
  invoke<void>("save_session_seed", { root, enabled, script });

export const collectAuthContext = (root: string) =>
  invoke<AuthContext>("collect_auth_context", { root });

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

// --- Terminals (console drawer) ---------------------------------------------

/** A login shell on a PTY in `cwd`. Output arrives on `onOutput` as raw bytes
 *  (a multi-byte character can straddle two chunks, so it is never decoded
 *  here — xterm reassembles it). */
export const openTerminal = (
  cwd: string,
  cols: number,
  rows: number,
  onOutput: (bytes: Uint8Array) => void,
) => {
  const output = new Channel<ArrayBuffer>();
  output.onmessage = (buf) => onOutput(new Uint8Array(buf));
  return invoke<{ id: number; shell: string }>("terminal_open", {
    cwd,
    cols,
    rows,
    output,
  });
};

export const writeTerminal = (id: number, data: string) =>
  invoke<void>("terminal_write", { id, data });

export const resizeTerminal = (id: number, cols: number, rows: number) =>
  invoke<void>("terminal_resize", { id, cols, rows });

export const closeTerminal = (id: number) =>
  invoke<void>("terminal_close", { id });

export const closeAllTerminals = () => invoke<void>("terminal_close_all");

/** The shell ended on its own (`exit`, ^D) — not sent for one we closed. */
export const onTerminalExit = (
  cb: (e: { id: number; code: number | null }) => void,
): Promise<UnlistenFn> =>
  listen<{ id: number; code: number | null }>("terminal://exit", (e) =>
    cb(e.payload),
  );

export const onInstrumentation = (
  cb: (e: InstrumentationInfo) => void,
): Promise<UnlistenFn> =>
  listen<InstrumentationInfo>("devserver://instrumentation", (e) =>
    cb(e.payload),
  );

/** Page routes read from the project's files — works with no dev server, and
 *  is the only route source a Next.js project has (no middleware to add). */
export const detectRoutesFromSource = (root: string, framework: Framework) =>
  invoke<{ ok: boolean; routes?: string[]; error?: string }>("detect_routes", {
    root,
    framework,
  });

/** What dedup can do for a Next.js project: wired, offered (with the exact
 *  config diff), or unavailable with a reason. Read-only. */
export const nextStatus = (root: string) =>
  invoke<NextStatus>("next_status", { root });

/** dedup's own commits on the session branch, newest first (FR-5.7). */
export const sessionHistory = (root: string, limit?: number) =>
  invoke<HistoryEntry[]>("session_history", { root, limit: limit ?? null });

/** Undo one dedup commit; returns the short hash of the undo commit. */
export const revertCommit = (root: string, hash: string) =>
  invoke<string>("revert_commit", { root, hash });

/** Branch/remote standing for the Commit tab. Reads refs; never fetches. */
export const gitSyncStatus = (root: string) =>
  invoke<SyncStatus>("git_sync_status", { root });

/** Push one named branch to one named remote. Never forced. */
export const gitPush = (root: string, remote: string, branch: string) =>
  invoke<{ remote: string; branch: string }>("git_push", { root, remote, branch });

/** Fast-forward `target` to the session branch, or throw the refusal. */
export const gitLand = (root: string, session: string, target: string) =>
  invoke<{ target: string; from: string; commits: number }>("git_land", {
    root,
    session,
    target,
  });

export type Rect = { x: number; y: number; width: number; height: number };
