import { create } from "zustand";
import {
  captureCanvasThumbnail,
  agentAvailable,
  agentPrompt,
  commitSession,
  gitStatus,
  inspectElement,
  loadCategories,
  loadScanResult,
  readSource,
  saveCategories,
  scanProject,
  applyEdits,
  writeSource,
  loadSessionSeed as apiLoadSessionSeed,
  saveSessionSeed as apiSaveSessionSeed,
  collectAuthContext,
  detectRoutesFromSource,
  mergePlan as apiMergePlan,
  mergeApply,
  mergeTrash,
  sessionHistory,
  revertCommit,
  visualForget,
} from "./api";
import {
  captureArtboards,
  gateSummary,
  gatesPassed,
  hmrGate,
  runBuildGates,
  runVisualGate,
} from "./mergeFlow";
import { parseMergeReply, runMergePrompt } from "./mergeProposal";
import {
  combinedConfidence,
  runVisualPass,
  type VisualScore,
} from "./visualPass";
import { generateSeed } from "./session";
import { resolveOrigin } from "./origins";
import { buildEditPrompt, runChatPrompt } from "./chat";
import { applyEditBlocks, parseChatReply } from "./chatEdits";
import {
  categorizeComponents,
  needingCategorization,
  skeletonHash,
  type AiBackend,
  type CategoryCache,
} from "./categorize";
import {
  requestFrameFiles,
  requestFrameSizes,
  sendToFrame,
  sendToOverlay,
} from "./bridge";
import {
  isPendingId,
  isValueAction,
  opsForFile,
  PENDING_PREFIX,
  SCAN_SCHEMA,
  targetOf,
  VIEWPORTS,
} from "./types";
import {
  classNameOf,
  PALETTE,
  parseSimpleElement,
  textOf,
  type InsertKind,
} from "./palette";
import { foldLine, type ParsedError } from "./errors";
import { CLI_AGENTS } from "./types";
import type {
  AgentState,
  ChatMessage,
  ChatSession,
  CliAgent,
  GateResult,
  HistoryEntry,
  MergeSession,
  TrashEntry,
  DevServerStatus,
  GitStatus,
  InstrumentationInfo,
  LayerNode,
  LogEvent,
  PageMeta,
  ProjectInfo,
  ScanCluster,
  ScanProgress,
  AuthProvider,
  ScanResult,
  SelectedElement,
  SessionSeed,
  SidebarTab,
  DropPosition,
  EditAction,
  EditTarget,
  NodeInfo,
  StructuralAction,
  Viewport,
} from "./types";

const MAX_LOG_LINES = 2000;

type View = "launch" | "editor";

/**
 * The staged program is one ordered list of `EditAction`s (lib/types). Undo
 * pops the last action, redo pushes it back, and the canvas is re-synced from
 * the whole list each time — so there is exactly one description of an edit,
 * whether it is being previewed, undone, reviewed, or written to disk.
 */

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
  /** Why element tagging is on/off this session; null until reported. */
  instrumentation: InstrumentationInfo | null;

  logs: LogEvent[];
  consoleOpen: boolean;
  /** Build errors parsed out of the dev-server stream (see lib/errors) —
   * the truthful "is the app broken right now" state, cleared by the next
   * successful compile. */
  errors: ParsedError[];

  viewportId: Viewport["id"];
  /** Active canvas tool (FR-6.1): select = inspect on click, hand = drag to
   * pan, browse = clicks pass through so the user can navigate their app. */
  tool: "select" | "hand" | "browse";
  zoom: number;
  /** Canvas pan offset in px — where the frame's origin sits (FR-6.1). */
  pan: { x: number; y: number };
  /** Open page artboards, in canvas order. **Starts empty**: nothing is
   * mounted until the user picks a page in the Pages tab. Booting the app in
   * a frame is not free — it runs their real dev server, their real auth
   * guards and their real data fetching — so it happens when they ask for it,
   * on the page they asked for. Browsing (browse tool) spawns the rest. */
  routes: string[];
  /** Routes the tagger's static scan found (FR-6.3) — the Pages tab's list.
   * null = not fetched yet this dev-server session. */
  detectedRoutes: string[] | null;
  /** Natural page height per route, reported by each frame's overlay. */
  pageHeights: Record<string, number>;
  /** Where each frame actually is (assigned route → live path) — drifts on
   * app-initiated redirects like auth guards; labels show the drift. */
  pagePaths: Record<string, string>;
  /** Same dev server through an alternate loopback origin (e.g. [::1] vs
   * localhost) — separate localStorage, so frames there stay logged out. */
  devAltUrl: string | null;
  /** Per-frame origin: "shared" = the live session; "alt" = guest origin
   * (used when the app redirected the frame off its pinned route — public
   * pages guarded against logged-in users render again there); "stuck" =
   * both origins redirect, frame stays on shared with the drift label. */
  frameOrigins: Record<string, "shared" | "alt" | "stuck">;
  /** Which session a page artboard renders under (FR-6.3). "auto" leaves it
   * to the redirect heuristic above; "in"/"out" are the user's explicit
   * choice and always win — the way to hold a welcome page on screen while
   * signed in, or a dashboard while signed out. */
  sessionModes: Record<string, "auto" | "in" | "out">;
  /** Artboards frozen on their first screen, so a splash or interstitial can
   * be inspected and edited instead of vanishing (FR-6.3). */
  heldRoutes: Record<string, true>;
  /** Rendered element tree per page artboard (FR-6.2), pushed by each
   * frame's overlay on DOM mutations — what the Layers tab draws. */
  layers: Record<string, LayerNode[]>;
  /** Page title/route from the overlay — the root frame's label (FR-6.1). */
  pageMeta: PageMeta | null;
  /** Page artboard the user selected (click its label) — the scan's scope. */
  selectedRoute: string | null;

  // Mock session (zero-login editing). The seed that lets protected routes
  // render on the canvas; null until loaded for the project.
  sessionSeed: SessionSeed | null;
  sessionModalOpen: boolean;
  /** AI generation or a save in flight. */
  sessionBusy: boolean;
  sessionError: string | null;
  /** The app's auth SDK, when it uses one — tells the user up front whether a
   * seed can reach its session at all. null until probed. */
  authProvider: AuthProvider | null;
  /** Top-level editor view: the live canvas or the component gallery. */
  editorTab: "canvas" | "components";

  /**
   * The source file open in the split code panel, or null.
   *
   * This is the escape hatch behind every "dedup can't edit this here": a
   * className computed by `cn(...)`, text that comes from an expression. The
   * panel does not make those editable through the inspector — it shows the
   * user the code that produced them, at the right line, and lets them fix it
   * directly. `draft` is the working buffer; the file on disk is untouched
   * until Save, which goes through the same parse gate as every other write.
   */
  codePanel: {
    file: string;
    /** 1-based line to reveal and highlight (the element's opening tag). */
    line: number;
    /** Content as loaded — the baseline for "is this dirty". */
    original: string;
    draft: string;
    loading: boolean;
    saving: boolean;
    error: string | null;
  } | null;

  /** Element currently selected on the canvas (FR-2.2). */
  selected: SelectedElement | null;
  /** What the write-back says about the selection: classes, text, and which
   * structural edits it would accept (FR-4.2). */
  sourceInfo: NodeInfo | null;

  /** The staged edit program, in application order (FR-3.7). */
  actions: EditAction[];
  /** Actions removed by undo, newest last. */
  redoStack: EditAction[];
  /** Element the canvas is dragging, if any — drives the drop hint. */
  draggingId: string | null;
  /** Palette entry armed for the next canvas click (insert tool). */
  insertKind: InsertKind | null;
  saving: boolean;
  lastSave: { branch: string; hash: string } | null;
  saveError: string | null;

  sidebarTab: SidebarTab;

  // Inspector chat (AI edits on the selected element). Sessions persist per
  // project; the active one is what the panel shows. null active id = a new
  // chat that materializes on the first message.
  inspectorTab: "design" | "chat";
  chatSessions: ChatSession[];
  activeChatId: string | null;
  chatBusy: boolean;

  // Duplicate scan (FR-5.x).
  scanning: boolean;
  scanProgress: ScanProgress | null;
  scanResult: ScanResult | null;
  scanError: string | null;
  /** file#name → rendered size on the scanned artboard, measured from the
   * live DOM — the Components tab sizes each card to match the site.
   * Persisted per project so restored scans keep their card sizes. */
  liveSizes: Record<string, { w: number; h: number }>;
  /** Cluster ids the user marked "not duplicates" — persisted per project. */
  dismissed: Record<string, true>;
  /** Cluster open in the review view. */
  openClusterId: string | null;
  /** Visual similarity per cluster (FR-5.2's third signal). Absent = the pass
   * hasn't run; a `score` of null inside one = it ran and the members could
   * not be rendered in isolation, which is reported, not averaged away. */
  visualScores: Record<string, VisualScore>;
  /** file#name → perceptual hash, reused across passes within a scan. */
  visualHashes: Record<string, string>;
  visualPass: { done: number; total: number } | null;

  // AI categorization (organization only — detection stays deterministic).
  /** file#name → category label, for the components of the current scan. */
  categories: Record<string, string>;
  /** file#name → JSON mock props for the preview harness. */
  mockProps: Record<string, string>;
  categorizing: boolean;
  categorizeProgress: { done: number; total: number } | null;
  categorizeError: string | null;
  /** Anthropic API key (user-supplied, stored locally) — fallback backend. */
  anthropicKey: string;
  /** Per coding-agent CLI: installed, connected, model, last error. One
   * record rather than a set of fields per agent, so a third agent is a row
   * in CLI_AGENTS rather than five more pieces of state. */
  agents: Record<CliAgent, AgentState>;
  /** Which backend the user chose (persisted). null = not chosen yet. */
  aiPref: CliAgent | "api" | null;

  // Guarded merge (FR-5.4 → FR-5.7). One at a time: a merge rewrites the
  // project behind gates, so a second one running underneath the first would
  // make both reviews meaningless.
  merge: MergeSession | null;
  /** dedup's commits on this session branch — the revert panel (FR-5.7). */
  history: HistoryEntry[];
  historyOpen: boolean;
  /** Files staged for deletion, awaiting the end-of-session confirmation. */
  trash: TrashEntry[];

  // actions
  enterEditor: (
    project: ProjectInfo,
    git: GitStatus | null,
    customCommand?: string | null,
  ) => void;
  backToLaunch: () => void;
  setDevStatus: (status: DevServerStatus) => void;
  setInstrumentation: (info: InstrumentationInfo) => void;
  setDevReady: (url: string, port: number) => void;
  setCrashed: (code: number | null) => void;
  appendLog: (log: LogEvent) => void;
  /** Runtime output forwarded from inside a canvas frame (see the overlay's
   * console forwarding) — logged, but never treated as a build error. */
  appendPageLog: (line: string) => void;
  clearLogs: () => void;
  /** Hand the current build errors to the inspector chat as an instruction. */
  askAiToFix: () => void;
  toggleConsole: (open?: boolean) => void;
  setViewport: (id: Viewport["id"]) => void;
  setTool: (tool: "select" | "hand" | "browse") => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  /** Atomic zoom+pan update so zoom-toward-cursor never flickers. */
  setZoomPan: (zoom: number, pan: { x: number; y: number }) => void;
  visitRoute: (path: string) => void;
  /** Close one page artboard and forget everything keyed to it. */
  closeRoute: (path: string) => void;
  /** Open a route as a page artboard (if it isn't one) and pan the canvas to
   * it — the Pages tab's click, and where new artboards land (FR-6.3). */
  focusRoute: (path: string) => void;
  /** Ask the dev server for its statically discovered routes (FR-6.3). */
  fetchDetectedRoutes: () => Promise<void>;
  setPageHeight: (route: string, h: number) => void;
  setLayers: (route: string, layers: LayerNode[]) => void;
  setPagePath: (route: string, path: string) => void;
  setDevAltUrl: (url: string | null) => void;
  setFrameOrigin: (route: string, origin: "shared" | "alt" | "stuck") => void;
  /** Pin an artboard to a session (or back to "auto"), then reload it there. */
  setSessionMode: (route: string, mode: "auto" | "in" | "out") => void;
  /** Freeze an artboard on its first screen (reloads it into the hold), or
   * let a frozen one continue. */
  toggleHold: (route: string) => void;
  /** Dev-server origin a route's frame should load from — the one place the
   * explicit choice and the automatic fallback are reconciled. */
  originForRoute: (route: string) => string | null;
  setPageMeta: (meta: PageMeta | null) => void;
  setSelectedRoute: (route: string | null) => void;

  /** Load the project's saved mock-session seed (once per session). */
  loadSessionSeed: () => Promise<void>;
  openSessionModal: () => void;
  closeSessionModal: () => void;
  /** Reload every artboard at its pinned route on the shared origin — the
   * "a session just changed, go get it" step, shared by a real sign-in and a
   * seed save. */
  reloadPinnedFrames: () => void;
  /** Switch to browse mode on the login frame so the user can sign in to
   * their app for real. One WebKit session backs every same-origin frame, so
   * one login unlocks every protected artboard. */
  startCanvasSignIn: () => void;
  /** Persist the reviewed seed + active flag, then reload the canvas frames so
   * it takes effect (the tagger serves the seed per request). */
  saveSessionSeed: (enabled: boolean, script: string) => Promise<void>;
  /** Draft a seed from the project's auth source via the active AI backend. */
  generateSessionSeed: () => Promise<void>;
  setEditorTab: (tab: "canvas" | "components") => void;
  /** Open a source file in the split code panel, revealing `line`. */
  openCode: (file: string, line?: number) => Promise<void>;
  closeCode: () => void;
  setCodeDraft: (draft: string) => void;
  /** Write the buffer through the parse gate and commit it. */
  saveCode: () => Promise<void>;
  setSelected: (sel: SelectedElement | null) => void;
  /** Clear selection here and in the overlay. */
  clearSelection: () => void;
  /** Ask the overlay to select an element by dedupId (breadcrumb clicks). */
  selectById: (id: string) => void;

  /** The class string the panel should show/edit for the selection. */
  effectiveClassName: () => string | null;
  /** The text the panel should show/edit for the selection. */
  effectiveText: () => string | null;
  /** Append one action to the staged program and re-sync the canvas.
   * `collapse` folds it into the previous action instead (drag scrubs). */
  stage: (action: EditAction, collapse?: (prev: EditAction) => boolean) => void;
  /** Stage a class edit + live-patch the canvas (FR-3.7). `group` ties the
   * edit to one drag gesture so scrubbing costs a single undo step. */
  applyClassEdit: (next: string, group?: string) => void;
  /** Stage a static-text edit on the selection. */
  applyTextEdit: (next: string) => void;
  /** Stage deletion of the selected element (Delete/⌫). */
  removeSelected: () => void;
  /** Stage a move/reparent, as reported by a canvas drag. */
  moveElement: (fromId: string, toId: string, position: DropPosition) => void;
  /** Stage an insert of a palette element against a reference node. */
  insertElement: (kind: InsertKind, toId: string, position: DropPosition) => void;
  setDragging: (dedupId: string | null) => void;
  /** A canvas double-click asking to type into an element — allowed only when
   * the write-back says that element's text is editable. */
  requestTextEdit: (dedupId: string) => void;
  setInsertKind: (kind: InsertKind | null) => void;
  /** Re-send the staged program to the canvas (a frame reloaded). */
  resyncCanvas: () => void;
  /** Discard one staged action by list position (review panel), redoable. */
  revertAction: (index: number) => void;
  undo: () => void;
  redo: () => void;
  /** Write staged edits to source, commit on the session branch (FR-4.x). */
  saveAll: () => Promise<void>;

  setSidebarTab: (tab: SidebarTab) => void;
  /** Persisted widths of the two side panels, clamped to PANEL_BOUNDS. */
  panelWidths: Record<Panel, number>;
  setPanelWidth: (panel: Panel, px: number) => void;
  setInspectorTab: (tab: "design" | "chat") => void;
  /** Chat instruction for the selected element → AI edit → gated write +
   * commit on the session branch. */
  sendChat: (instruction: string) => Promise<void>;
  /** Start a fresh chat (created for real on the first message). */
  newChatSession: () => void;
  selectChatSession: (id: string | null) => void;
  deleteChatSession: (id: string) => void;
  /** Run the duplicate scan and land on the Duplicates tab (FR-5.1/5.2). */
  runScan: () => Promise<void>;
  /** Load the last persisted scan for the open project, if any. */
  restoreScan: () => Promise<void>;
  setScanProgress: (p: ScanProgress) => void;
  openCluster: (id: string | null) => void;
  /** "Not duplicates" — hide the cluster and remember that (FR-5.3). */
  dismissCluster: (id: string) => void;
  /** Drop one member out of a cluster (FR-5.3); dissolves at < 2 members. */
  removeMember: (clusterId: string, memberIndex: number) => void;
  /** Render every cluster member in isolation and compare the pixels — the
   * scan's visual signal (FR-5.2). Runs on demand, from the Components tab. */
  runVisualPass: () => Promise<void>;
  cancelVisualPass: () => void;

  setAnthropicKey: (key: string) => void;
  /** Detect a coding-agent CLI once per app run. */
  detectAgent: (agent: CliAgent) => Promise<void>;
  /** Pick the AI backend (persisted). */
  setAiPref: (pref: CliAgent | "api" | null) => void;
  setAgentModel: (agent: CliAgent, model: string | null) => void;
  /** Consent + live test: verifies Claude Code login and enables it. */
  /** Consent moment: a live round-trip that proves the CLI is installed and
   * signed in. dedup never spends someone's subscription before it passes. */
  connectAgent: (agent: CliAgent) => Promise<void>;
  /** The backend categorize() will actually use right now, if any. */
  activeAiBackend: () => CliAgent | "api" | null;
  /** Categorize the current gallery with Claude; cached per project. */
  categorize: () => Promise<void>;

  /** Plan the merge and ask the model for a canonical component (FR-5.4). */
  startMerge: (clusterId: string) => Promise<void>;
  /** Re-run the proposal, e.g. after the user edited the canonical source. */
  reproposeMerge: () => Promise<void>;
  /** Replace the proposed source by hand and re-compute the preview. */
  editProposal: (source: string) => Promise<void>;
  /** Write the merge, commit it, run the gates, roll back on any failure. */
  confirmMerge: () => Promise<void>;
  cancelMerge: () => void;
  /** Undo the merge that just landed, restoring its staged files. */
  rollbackMerge: (reason: string) => Promise<void>;

  loadHistory: () => Promise<void>;
  toggleHistory: (open?: boolean) => void;
  revertEntry: (hash: string) => Promise<void>;

  loadTrash: () => Promise<void>;
  restoreTrash: (files?: string[]) => Promise<void>;
  emptyTrash: () => Promise<void>;
  /** Apply cached categories (no API call) for the current scan result. */
  applyCachedCategories: () => Promise<void>;
}

const KEY_STORAGE = "dedup:anthropic-key";
const AI_PREF_STORAGE = "dedup:ai-pref";
const AGENTS_STORAGE = "dedup:cli-agents";
const PANEL_WIDTH_STORAGE = "dedup:panel-widths";

/** Panel width bounds. Below the minimum the sidebar's three tabs stop fitting
 * and the inspector's four-way spacing grid collapses; above the maximum the
 * canvas stops being the thing you're looking at. */
export const PANEL_BOUNDS = {
  sidebar: { min: 180, max: 480, default: 224 },
  inspector: { min: 220, max: 520, default: 256 },
  code: { min: 320, max: 900, default: 460 },
} as const;

export type Panel = keyof typeof PANEL_BOUNDS;

/** Gap between adjacent page artboards in the canvas's pages row. */
export const PAGE_GAP = 64;


/** Per-agent consent + model, persisted together. Detection is not persisted
 * — whether a binary exists is a fact about the machine right now, and a
 * remembered "installed" would outlive an uninstall. */
function loadAgents(): Record<CliAgent, AgentState> {
  const blank = (): AgentState => ({
    installed: null,
    consent: false,
    model: null,
    connecting: false,
    error: null,
  });
  const agents = Object.fromEntries(
    CLI_AGENTS.map((a) => [a.id, blank()]),
  ) as Record<CliAgent, AgentState>;
  try {
    const raw = localStorage.getItem(AGENTS_STORAGE);
    if (!raw) return agents;
    const saved = JSON.parse(raw) as Partial<
      Record<CliAgent, { consent?: unknown; model?: unknown }>
    >;
    for (const agent of CLI_AGENTS) {
      const entry = saved[agent.id];
      if (!entry) continue;
      agents[agent.id].consent = entry.consent === true;
      agents[agent.id].model =
        typeof entry.model === "string" && entry.model ? entry.model : null;
    }
  } catch {
    // A corrupt blob just means everyone reconnects — never a broken app.
  }
  return agents;
}

function saveAgentPrefs(agents: Record<CliAgent, AgentState>) {
  try {
    localStorage.setItem(
      AGENTS_STORAGE,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(agents).map(([id, a]) => [
            id,
            { consent: a.consent, model: a.model },
          ]),
        ),
      ),
    );
  } catch {
    // Session-only consent still works.
  }
}

const clampPanel = (panel: Panel, px: number) =>
  Math.round(
    Math.min(PANEL_BOUNDS[panel].max, Math.max(PANEL_BOUNDS[panel].min, px)),
  );

function loadPanelWidths(): Record<Panel, number> {
  const fallback: Record<Panel, number> = {
    sidebar: PANEL_BOUNDS.sidebar.default,
    inspector: PANEL_BOUNDS.inspector.default,
    code: PANEL_BOUNDS.code.default,
  };
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_STORAGE);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Record<Panel, unknown>>;
    // Clamp on the way in: a stale entry from a wider window must not leave a
    // panel eating the canvas on a smaller one.
    for (const panel of ["sidebar", "inspector"] as const) {
      const v = saved[panel];
      if (typeof v === "number" && Number.isFinite(v)) {
        fallback[panel] = clampPanel(panel, v);
      }
    }
  } catch {
    // Corrupt entry — defaults are always a valid layout.
  }
  return fallback;
}

/** Cache entries that still match their component's current skeleton. */
function validAssignments(
  cache: CategoryCache,
  gallery: { file: string; name: string; skeleton: string }[],
): { categories: Record<string, string>; mockProps: Record<string, string> } {
  const categories: Record<string, string> = {};
  const mockProps: Record<string, string> = {};
  for (const e of gallery) {
    const key = `${e.file}#${e.name}`;
    const hit = cache[key];
    if (hit && hit.hash === skeletonHash(e.skeleton)) {
      categories[key] = hit.category;
      if (hit.mockProps) mockProps[key] = hit.mockProps;
    }
  }
  return { categories, mockProps };
}

/** Clusters not dismissed, ranked by confidence × instance count (FR-5.3).
 * Pure so components can memo it instead of re-deriving on every store tick. */
/**
 * Clusters the user hasn't dismissed, ranked by confidence × reach (FR-5.3).
 *
 * `visualScores` folds the visual signal into the confidence when the pass has
 * run — which can push a structurally-similar-but-visually-different cluster
 * down the list, where it belongs. Without the pass the ordering is exactly
 * the scan's, so this is a refinement, never a different answer.
 */
export function rankClusters(
  result: ScanResult | null,
  dismissed: Record<string, true>,
  visualScores: Record<string, VisualScore> = {},
): ScanCluster[] {
  if (!result) return [];
  const weight = (c: ScanCluster) =>
    combinedConfidence(c.confidence, visualScores[c.id]) *
    Math.max(c.totalCallSites, c.members.length);
  return result.clusters
    .filter((c) => !dismissed[c.id])
    .sort((a, b) => weight(b) - weight(a));
}

const liveSizesKey = (root: string) => `dedup:live-sizes:${root}`;

function loadLiveSizes(root: string): Record<string, { w: number; h: number }> {
  try {
    const raw = localStorage.getItem(liveSizesKey(root));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLiveSizes(
  root: string,
  sizes: Record<string, { w: number; h: number }>,
) {
  try {
    localStorage.setItem(liveSizesKey(root), JSON.stringify(sizes));
  } catch {
    // Persistence is best-effort; the session still works without it.
  }
}

const dismissedKey = (root: string) => `dedup:dismissed:${root}`;

function loadDismissed(root: string): Record<string, true> {
  try {
    const raw = localStorage.getItem(dismissedKey(root));
    if (!raw) return {};
    return Object.fromEntries(
      (JSON.parse(raw) as string[]).map((id) => [id, true as const]),
    );
  } catch {
    return {};
  }
}

function saveDismissed(root: string, dismissed: Record<string, true>) {
  try {
    localStorage.setItem(dismissedKey(root), JSON.stringify(Object.keys(dismissed)));
  } catch {
    // Persistence is best-effort; the session still works without it.
  }
}

const chatsKey = (root: string) => `dedup:chats:${root}`;
/** Keep the most recent N sessions per project — localStorage isn't a vault. */
const MAX_CHAT_SESSIONS = 20;

function loadChatSessions(root: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(chatsKey(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChatSessions(root: string, sessions: ChatSession[]) {
  try {
    localStorage.setItem(
      chatsKey(root),
      JSON.stringify(sessions.slice(-MAX_CHAT_SESSIONS)),
    );
  } catch {
    // Persistence is best-effort; the session still works without it.
  }
}

/**
 * Push the whole staged program to the canvas overlay.
 *
 * The overlay gets state, not deltas: it resets whatever it applied last and
 * re-applies from this snapshot. That makes undo, redo, reverting one action
 * out of the middle, and re-applying after React re-renders the same code
 * path — there is no incremental protocol to get out of step.
 */
function syncCanvas(actions: EditAction[]) {
  const classes: Record<string, { from: string; to: string }> = {};
  const texts: Record<string, { from: string; to: string }> = {};
  for (const a of actions) {
    if (a.kind === "class") {
      const seen = classes[a.target.dedupId];
      classes[a.target.dedupId] = { from: seen?.from ?? a.before, to: a.after };
    } else if (a.kind === "text") {
      const seen = texts[a.target.dedupId];
      texts[a.target.dedupId] = { from: seen?.from ?? a.before, to: a.after };
    }
  }
  const structural = actions
    .filter((a): a is StructuralAction => !isValueAction(a))
    .map((a) =>
      a.kind === "remove"
        ? { op: "remove" as const, id: a.target.dedupId }
        : a.kind === "insert"
          ? {
              op: "insert" as const,
              id: a.target.dedupId,
              // The provisional id the preview node is stamped with, so the
              // canvas can select and edit an element that isn't saved yet.
              pendingId: a.id,
              position: a.position,
              html: a.preview,
            }
          : {
              op: "move" as const,
              id: a.target.dedupId,
              to: a.to.dedupId,
              position: a.position,
            },
    );
  sendToOverlay({ type: "stage", classes, texts, structural });
}

/**
 * The target an edit should be addressed to. A staged insert has no node in
 * the file yet, so it gets index -1 and the file of the element it was placed
 * against — enough for the save to group it correctly and fold it in.
 */
function editTargetFor(actions: EditAction[], dedupId: string): EditTarget | null {
  if (isPendingId(dedupId)) {
    const insert = actions.find((a) => a.kind === "insert" && a.id === dedupId);
    return insert && insert.kind === "insert"
      ? { dedupId, file: insert.target.file, index: -1 }
      : null;
  }
  return targetOf(dedupId);
}

/** The staged insert an id names, if it names one. */
function pendingInsert(actions: EditAction[], dedupId: string) {
  const found = actions.find((a) => a.kind === "insert" && a.id === dedupId);
  return found && found.kind === "insert" ? found : null;
}

/**
 * What the inspector should show for a not-yet-saved element. There is no file
 * to ask, so the snippet itself is the source of truth — and it says honestly
 * that the element can't be moved until it exists on disk.
 */
function pendingNodeInfo(snippet: string): NodeInfo {
  const parsed = parseSimpleElement(snippet);
  const text = textOf(snippet);
  return {
    editable: true,
    className: classNameOf(snippet),
    reason: null,
    line: 0,
    col: 0,
    tag: parsed?.tag ?? "div",
    component: null,
    dynamic: null,
    core: null,
    parentIndex: null,
    canRemove: true,
    canMove: false,
    structuralReason: "this element isn't saved yet — save to move it",
    canAcceptChildren: parsed ? !parsed.selfClosing : false,
    canEditText: text !== null,
    textReason: text === null ? "this element holds no text" : null,
    text,
  };
}

/** "Button · button" — how a staged structural action names its element. */
function labelOfElement(el: { component: string | null; tag: string }): string {
  return el.component ? `${el.component} · ${el.tag}` : el.tag;
}

/** The class/text a target currently shows, given the staged program. */
function stagedValue(
  actions: EditAction[],
  kind: "class" | "text",
  dedupId: string,
): string | null {
  let value: string | null = null;
  for (const a of actions) {
    if (a.kind === kind && a.target.dedupId === dedupId) value = a.after;
  }
  return value;
}

/** Human summary of a staged program, for the commit subject. */
function describeProgram(actions: EditAction[]): string {
  const structural = actions.filter(
    (a): a is StructuralAction => !isValueAction(a),
  );
  if (structural.length > 0) {
    const first = structural[0];
    const label =
      first.kind === "remove"
        ? `delete ${first.label}`
        : first.kind === "insert"
          ? `add ${first.label}`
          : `move ${first.label}`;
    const rest = actions.length - 1;
    return rest > 0 ? `${label} +${rest} more` : label;
  }
  const names = [
    ...new Set(
      actions.map((a) =>
        (a.kind === "class" || a.kind === "text" ? a.component : null) ?? "element",
      ),
    ),
  ];
  const label =
    names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1} more`;
  return `adjust classes on ${label}`;
}


// --- merge helpers -----------------------------------------------------------

type Setter = (partial: Partial<AppState>) => void;
type Getter = () => AppState;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Update one agent's slot without disturbing the others. */
function patchAgent(
  set: Setter,
  get: Getter,
  agent: CliAgent,
  patch: Partial<AgentState>,
) {
  const agents = get().agents;
  set({ agents: { ...agents, [agent]: { ...agents[agent], ...patch } } });
}

/**
 * Update the in-flight merge, and only that one. Every step of a merge is
 * async, so the session it started on may have been cancelled or replaced
 * before it returns — writing into a stale session would show one merge's
 * gate results under another merge's proposal.
 */
function patchMerge(set: Setter, get: Getter, patch: Partial<MergeSession>) {
  const current = get().merge;
  if (!current) return;
  set({ merge: { ...current, ...patch } });
}

/** The AI backend the user explicitly chose, or null (never a silent one). */
function aiBackend(state: AppState): AiBackend | null {
  const kind = state.activeAiBackend();
  if (kind && kind !== "api") {
    return {
      kind: "cli",
      agent: kind,
      run: (p: string) =>
        agentPrompt(kind, p, useStore.getState().agents[kind].model),
    };
  }
  if (kind === "api") return { kind: "api", apiKey: state.anthropicKey };
  return null;
}

/**
 * Re-run the codemod in dry-run mode and park the result for review. This is
 * the only thing that puts a merge into `review`: the user is shown the exact
 * before/after the real apply will produce, computed by the same code path,
 * so approving the diff approves what actually happens.
 */
async function refreshPreview(set: Setter, get: Getter): Promise<void> {
  const { project, merge } = get();
  if (!project || !merge?.proposal) return;
  const { proposal } = merge;
  try {
    const preview = await mergeApply(
      project.root,
      { name: proposal.name, file: proposal.file, source: proposal.source },
      proposal.mapping,
      true,
    );
    if (get().merge?.clusterId !== merge.clusterId) return;
    if (!preview.ok) throw new Error(preview.error ?? "the merge preview failed");
    patchMerge(set, get, { preview, stage: "review", error: null });
  } catch (e) {
    patchMerge(set, get, { stage: "failed", error: errorText(e) });
  }
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
  instrumentation: null,

  logs: [],
  consoleOpen: false,
  errors: [],

  viewportId: "desktop",
  tool: "select",
  zoom: 1,
  // Clears the floating chrome: the sidebar sits at left-3 with a ~200px
  // default width, and the top bar occupies the first ~60px. Starting the
  // artboards under a panel would make the app look like it failed to load.
  pan: { x: 232, y: 120 },
  routes: [],
  detectedRoutes: null,
  pageHeights: {},
  pagePaths: {},
  devAltUrl: null,
  frameOrigins: {},
  sessionModes: {},
  heldRoutes: {},
  layers: {},
  pageMeta: null,
  selectedRoute: null,
  sessionSeed: null,
  sessionModalOpen: false,
  sessionBusy: false,
  sessionError: null,
  authProvider: null,
  editorTab: "canvas",
  codePanel: null,
  selected: null,
  sourceInfo: null,

  actions: [],
  redoStack: [],
  draggingId: null,
  insertKind: null,
  saving: false,
  lastSave: null,
  saveError: null,

  sidebarTab: "layers",
  inspectorTab: "design",
  chatSessions: [],
  activeChatId: null,
  chatBusy: false,
  scanning: false,
  scanProgress: null,
  scanResult: null,
  scanError: null,
  liveSizes: {},
  dismissed: {},
  openClusterId: null,
  visualScores: {},
  visualHashes: {},
  visualPass: null,

  categories: {},
  mockProps: {},
  categorizing: false,
  categorizeProgress: null,
  categorizeError: null,
  anthropicKey: localStorage.getItem(KEY_STORAGE) ?? "",
  agents: loadAgents(),
  aiPref:
    (localStorage.getItem(AI_PREF_STORAGE) as CliAgent | "api" | null) ??
    // Existing key users keep working without re-choosing.
    (localStorage.getItem(KEY_STORAGE) ? "api" : null),
  panelWidths: loadPanelWidths(),

  merge: null,
  history: [],
  historyOpen: false,
  trash: [],

  enterEditor: (project, git, customCommand = null) => {
    // Past chats come back with the project; land on the most recent one.
    const chatSessions = loadChatSessions(project.root);
    set({
      // Nothing is mounted until the user picks a page, so Pages is the only
      // tab with anything to act on — land there rather than on empty Layers.
      sidebarTab: "pages",
      inspectorTab: "design",
      chatSessions,
      activeChatId: chatSessions[chatSessions.length - 1]?.id ?? null,
      chatBusy: false,
      scanning: false,
      scanProgress: null,
      scanResult: null,
      scanError: null,
      liveSizes: loadLiveSizes(project.root),
      dismissed: loadDismissed(project.root),
      openClusterId: null,
      visualScores: {},
      visualHashes: {},
      visualPass: null,
      categories: {},
      mockProps: {},
      categorizing: false,
      categorizeProgress: null,
      categorizeError: null,
      view: "editor",
      editorTab: "canvas",
      codePanel: null,
      selectedRoute: null,
      sessionSeed: null,
      sessionModalOpen: false,
      sessionBusy: false,
      sessionError: null,
      authProvider: null,
      // Per-project: one project's artboard session choices must not leak
      // into the next one opened.
      frameOrigins: {},
      sessionModes: {},
      project,
      git,
      customCommand,
      instrumentation: null,
      devStatus: "idle",
      devUrl: null,
      devPort: null,
      exitCode: null,
      crashed: false,
      logs: [],
      errors: [],
      tool: "select",
      selected: null,
      sourceInfo: null,
      actions: [],
      redoStack: [],
      draggingId: null,
      insertKind: null,
      lastSave: null,
      saveError: null,
      merge: null,
      history: [],
      historyOpen: false,
      trash: [],
    });
  },

  backToLaunch: () =>
    set({
      sidebarTab: "pages",
      chatSessions: [],
      activeChatId: null,
      chatBusy: false,
      scanning: false,
      scanProgress: null,
      scanResult: null,
      scanError: null,
      liveSizes: {},
      dismissed: {},
      openClusterId: null,
      visualScores: {},
      visualHashes: {},
      visualPass: null,
      categories: {},
      mockProps: {},
      categorizing: false,
      categorizeProgress: null,
      categorizeError: null,
      view: "launch",
      editorTab: "canvas",
      codePanel: null,
      selectedRoute: null,
      merge: null,
      history: [],
      historyOpen: false,
      trash: [],
      sessionSeed: null,
      sessionModalOpen: false,
      sessionBusy: false,
      sessionError: null,
      authProvider: null,
      // Per-project: one project's artboard session choices must not leak
      // into the next one opened.
      frameOrigins: {},
      sessionModes: {},
      project: null,
      git: null,
      customCommand: null,
      instrumentation: null,
      devStatus: "idle",
      devUrl: null,
      devPort: null,
      logs: [],
      errors: [],
      crashed: false,
      selected: null,
      sourceInfo: null,
      actions: [],
      redoStack: [],
      draggingId: null,
      insertKind: null,
      lastSave: null,
      saveError: null,
    }),

  setDevStatus: (devStatus) => set({ devStatus }),

  setInstrumentation: (instrumentation) => set({ instrumentation }),

  setDevReady: (url, port) =>
    set({
      devStatus: "ready",
      devUrl: url,
      devPort: port,
      crashed: false,
      // A restart clears the pages row rather than re-mounting what was
      // open: the artboards are the user's choice, and silently reloading
      // three frames of their app is the thing this defers.
      routes: [],
      detectedRoutes: null,
      pageHeights: {},
      layers: {},
      pageMeta: null,
      // A restart rebuilds the pages row — the old selection may be gone.
      selectedRoute: null,
    }),

  setCrashed: (code) =>
    set({ devStatus: "crashed", crashed: true, exitCode: code }),

  appendLog: (log) =>
    set((s) => {
      const next = s.logs.length >= MAX_LOG_LINES ? s.logs.slice(-MAX_LOG_LINES + 1) : s.logs.slice();
      next.push(log);
      const errors = foldLine(s.errors, log.line);
      return errors === s.errors ? { logs: next } : { logs: next, errors };
    }),

  appendPageLog: (line) =>
    set((s) => {
      const next =
        s.logs.length >= MAX_LOG_LINES
          ? s.logs.slice(-MAX_LOG_LINES + 1)
          : s.logs.slice();
      next.push({ stream: "stderr", line });
      // Deliberately not through foldLine: a runtime TypeError in the page is
      // not a broken build. Letting it light the build-error indicator would
      // be a lie the user can't clear — no recompile fixes it, because
      // nothing failed to compile.
      return { logs: next };
    }),

  clearLogs: () => set({ logs: [], errors: [] }),

  askAiToFix: () => {
    const { errors, selected } = get();
    if (errors.length === 0 || !selected) return;
    set({ inspectorTab: "chat" });
    void get().sendChat(
      `The dev server reports this build error. Fix it in this file if the cause is here; if it isn't, say where it is instead of guessing:\n\n${errors
        .map((e) => e.content)
        .join("\n\n")}`,
    );
  },

  toggleConsole: (open) =>
    set((s) => ({ consoleOpen: open ?? !s.consoleOpen })),

  setViewport: (viewportId) => set({ viewportId }),

  setTool: (tool) => {
    // Browse mode hands clicks back to the app — an active selection would
    // just be stale UI over a page the user is now navigating.
    if (tool === "browse") get().clearSelection();
    sendToOverlay({ type: "set-mode", mode: tool === "browse" ? "browse" : "inspect" });
    // Dragging elements belongs to the select tool: the hand tool pans and
    // browse hands the page back to the app.
    sendToOverlay({
      type: "set-edit-mode",
      drag: tool === "select",
      insert: false,
    });
    set({ tool, insertKind: tool === "select" ? get().insertKind : null });
  },

  setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.25, zoom)) }),

  setPan: (pan) => set({ pan }),

  setZoomPan: (zoom, pan) =>
    set({ zoom: Math.min(2, Math.max(0.25, zoom)), pan }),

  visitRoute: (path) =>
    set((s) =>
      s.routes.includes(path) || s.routes.length >= 40
        ? {}
        : { routes: [...s.routes, path] },
    ),

  closeRoute: (path) => {
    const s = get();
    if (!s.routes.includes(path)) return;
    const idx = s.routes.indexOf(path);
    const routes = s.routes.filter((r) => r !== path);

    // Everything keyed by route goes with it. Leaving entries behind would
    // resurrect a stale height, a stale drift label or a stale session choice
    // if the same route is opened again later.
    const drop = <T,>(map: Record<string, T>) => {
      const next = { ...map };
      delete next[path];
      return next;
    };

    set({
      routes,
      pageHeights: drop(s.pageHeights),
      pagePaths: drop(s.pagePaths),
      layers: drop(s.layers),
      frameOrigins: drop(s.frameOrigins),
      sessionModes: drop(s.sessionModes),
      heldRoutes: drop(s.heldRoutes),
      // The scan targets an artboard; closing it leaves no target.
      selectedRoute: s.selectedRoute === path ? null : s.selectedRoute,
      // pageMeta is the root frame's report of the live app.
      ...(path === "/" ? { pageMeta: null } : {}),
      // The selection lived in a frame that is going away. Staged edits do
      // NOT go with it — they address `file@ordinal`, so they still apply and
      // still save; only the on-screen selection is gone.
      selected: null,
      sourceInfo: null,
    });

    // Closing shifts every later artboard one slot left, so a fixed pan would
    // silently show a different page. Land on whatever took this one's place.
    const neighbour = routes[Math.min(idx, routes.length - 1)];
    if (neighbour) get().focusRoute(neighbour);
  },

  focusRoute: (path) => {
    const wasOpen = get().routes.includes(path);
    get().visitRoute(path);
    const s = get();
    const idx = s.routes.indexOf(path);
    if (idx < 0) return; // visitRoute refused (artboard cap reached)
    // Opening the first artboard is the clearest statement of "this is the
    // page I'm working on", and Scan needs a target — so it becomes one,
    // without ever overriding a choice the user made on the canvas.
    if (!wasOpen && !s.selectedRoute) set({ selectedRoute: path });
    const vp = VIEWPORTS.find((v) => v.id === s.viewportId)!;
    // Same clearance the initial pan uses: the focused artboard has to land
    // beside the floating sidebar and below the top bar, not under them.
    set({
      pan: { x: -(idx * (vp.width + PAGE_GAP)) * s.zoom + 232, y: 120 },
    });
  },

  fetchDetectedRoutes: async () => {
    const { devUrl, project } = get();
    if (!devUrl) return;

    /**
     * Read the routes off the filesystem through the sidecar. This is the
     * fallback for Vite and the *only* path for Next: the HTTP endpoint below
     * is served by the tagger's Vite middleware, and Next has no middleware
     * dedup can add — so without this, a Next project's file-based routes are
     * discovered and then never reachable.
     */
    const fromSource = async (): Promise<string[] | null> => {
      if (!project) return null;
      try {
        const res = await detectRoutesFromSource(project.root);
        return res.ok && Array.isArray(res.routes) ? res.routes : null;
      } catch {
        return null;
      }
    };

    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      const res = await fetch(new URL("/__dedup/routes", devUrl), {
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const data = (await res.json()) as { routes?: unknown };
      if (get().devUrl !== devUrl) return; // server changed meanwhile
      const routes = Array.isArray(data.routes)
        ? data.routes.filter((r): r is string => typeof r === "string")
        : [];
      // A bare "/" means the middleware answered but found nothing; the
      // source scan may still know better (it reads Next's route tree).
      if (routes.length > 1) {
        set({ detectedRoutes: routes });
        return;
      }
      const scanned = await fromSource();
      if (get().devUrl !== devUrl) return;
      set({ detectedRoutes: scanned ?? routes });
    } catch {
      // No endpoint (Next, or tagging off) — read the files directly. An
      // empty list is still the honest result if that finds nothing too.
      const scanned = await fromSource();
      if (get().devUrl === devUrl) set({ detectedRoutes: scanned ?? [] });
    }
  },

  setPagePath: (route, path) =>
    set((s) =>
      s.pagePaths[route] === path
        ? {}
        : { pagePaths: { ...s.pagePaths, [route]: path } },
    ),

  setDevAltUrl: (devAltUrl) => set({ devAltUrl }),

  setFrameOrigin: (route, origin) =>
    set((s) =>
      s.frameOrigins[route] === origin
        ? {}
        : { frameOrigins: { ...s.frameOrigins, [route]: origin } },
    ),

  setSessionMode: (route, mode) => {
    const { frameOrigins } = get();
    // An explicit choice supersedes whatever the redirect heuristic guessed,
    // so clear that state rather than leaving two answers in play.
    const nextOrigins = { ...frameOrigins };
    delete nextOrigins[route];
    set((s) => ({
      sessionModes: { ...s.sessionModes, [route]: mode },
      frameOrigins: nextOrigins,
    }));
    // Changing the origin re-points the iframe (React reloads it); staying on
    // the same origin does not, and that frame may be sitting on whatever the
    // app redirected it to — so ask for a reload at the pinned route either
    // way. Landing twice is harmless; not reloading leaves a stale page.
    sendToFrame(route, { type: "reload", path: route });
  },

  originForRoute: (route) => resolveOrigin(route, get()),

  toggleHold: (route) => {
    const held = { ...get().heldRoutes };
    if (held[route]) {
      // Releasing in place: the frame flushes the timers it queued and the
      // transition finally plays, which is worth watching. Reloading instead
      // would throw away whatever state the screen had reached.
      delete held[route];
      set({ heldRoutes: held });
      sendToFrame(route, { type: "release-hold" });
      return;
    }
    // Holding has to be armed before the app boots, so it rides in on the
    // frame's URL and takes effect on the reload that flag causes.
    held[route] = true;
    set({ heldRoutes: held });
  },

  setPageHeight: (route, h) =>
    set((s) =>
      s.pageHeights[route] === h
        ? {}
        : { pageHeights: { ...s.pageHeights, [route]: h } },
    ),

  setLayers: (route, layers) =>
    set((s) => ({ layers: { ...s.layers, [route]: layers } })),

  setPageMeta: (pageMeta) => set({ pageMeta }),

  setSelectedRoute: (selectedRoute) => set({ selectedRoute }),

  loadSessionSeed: async () => {
    const { project } = get();
    if (!project || get().sessionSeed) return;
    try {
      const seed = await apiLoadSessionSeed(project.root);
      if (get().project?.root !== project.root) return;
      set({ sessionSeed: seed ?? { enabled: false, script: "" } });
    } catch {
      set({ sessionSeed: { enabled: false, script: "" } });
    }
    // Cheap (one package.json read) and it decides what the setup modal
    // recommends, so probe it up front rather than on first open.
    try {
      const ctx = await collectAuthContext(project.root);
      if (get().project?.root === project.root) {
        set({ authProvider: ctx.provider });
      }
    } catch {
      // No provider info just means the modal leads with sign-in anyway.
    }
  },

  openSessionModal: () => set({ sessionModalOpen: true, sessionError: null }),
  closeSessionModal: () => set({ sessionModalOpen: false }),

  reloadPinnedFrames: () => {
    // Frames the guest-origin fallback pushed off the shared session go back
    // to it. That fallback exists for pages guarded *against* signed-in users;
    // for a page guarded *for* them it is exactly wrong — the guest origin has
    // its own storage, so a real login there never applies. Whenever a session
    // has just changed, the shared origin is the one that has it.
    set({ frameOrigins: {}, selected: null, sourceInfo: null });
    // Reload each frame *at its pinned route*, not wherever it sits: a
    // protected frame is parked on /login, and a plain refresh would just
    // reload the login page it was bounced to.
    for (const route of get().routes) {
      sendToFrame(route, { type: "reload", path: route });
    }
  },

  startCanvasSignIn: () => {
    // Hand the page back to the app so its real login form works, and put the
    // user on the frame that actually shows it (the route a guard bounced to).
    const { routes, pagePaths, frameOrigins } = get();
    const loginRoute =
      routes.find((r) => pagePaths[r] && pagePaths[r] !== r) ?? routes[0] ?? "/";
    set({ sessionModalOpen: false });
    get().setTool("browse");
    // Sign in on the canonical origin. A frame the guest-origin fallback
    // moved is on a different loopback spelling ([::1], 127.0.0.1), which is
    // a separate storage bucket — the login would apply to that frame alone —
    // and auth providers that check authorized domains (Firebase's reCAPTCHA
    // among them) only whitelist `localhost`, so the flow fails outright there.
    if (Object.keys(frameOrigins).length > 0) get().reloadPinnedFrames();
    // The bounced frame is already sitting on the login page — go look at it.
    get().focusRoute(loginRoute);
  },

  saveSessionSeed: async (enabled, script) => {
    const { project, sessionBusy } = get();
    if (!project || sessionBusy) return;
    set({ sessionBusy: true, sessionError: null });
    try {
      await apiSaveSessionSeed(project.root, enabled, script);
      set({ sessionSeed: { enabled, script }, sessionModalOpen: false });
      // The seed is served per request, so a fresh document load applies it.
      get().reloadPinnedFrames();
    } catch (e) {
      set({ sessionError: String(e instanceof Error ? e.message : e) });
    } finally {
      set({ sessionBusy: false });
    }
  },

  generateSessionSeed: async () => {
    const { project, sessionBusy } = get();
    if (!project || sessionBusy) return;
    const kind = get().activeAiBackend();
    const backend =
      kind && kind !== "api"
        ? {
            kind: "cli" as const,
            agent: kind,
            run: (p: string) => agentPrompt(kind, p, get().agents[kind].model),
          }
        : kind === "api"
          ? { kind: "api" as const, apiKey: get().anthropicKey }
          : null;
    if (!backend) {
      set({
        sessionError:
          "No AI backend connected — choose one in the AI switch (top bar), or write the seed by hand.",
      });
      return;
    }
    set({ sessionBusy: true, sessionError: null });
    try {
      const context = await collectAuthContext(project.root);
      set({ authProvider: context.provider });
      const script = await generateSeed(backend, context);
      if (get().project?.root !== project.root) return;
      // Draft into the editor for review — never saved or enabled silently.
      set({ sessionSeed: { enabled: get().sessionSeed?.enabled ?? false, script } });
    } catch (e) {
      set({ sessionError: String(e instanceof Error ? e.message : e) });
    } finally {
      set({ sessionBusy: false });
    }
  },

  setEditorTab: (editorTab) => set({ editorTab }),

  openCode: async (file, line = 1) => {
    const { project, codePanel } = get();
    if (!project) return;
    // Re-targeting the file already open keeps the user's unsaved buffer and
    // just moves the highlight — losing an edit because they clicked another
    // element in the same file would be its own bug.
    if (codePanel && codePanel.file === file) {
      set({ codePanel: { ...codePanel, line } });
      return;
    }
    set({
      codePanel: {
        file,
        line,
        original: "",
        draft: "",
        loading: true,
        saving: false,
        error: null,
      },
    });
    try {
      const content = await readSource(project.root, file);
      // The user may have closed it or opened another file meanwhile.
      const current = get().codePanel;
      if (!current || current.file !== file) return;
      set({
        codePanel: { ...current, original: content, draft: content, loading: false },
      });
    } catch (e) {
      const current = get().codePanel;
      if (!current || current.file !== file) return;
      set({
        codePanel: { ...current, loading: false, error: errorText(e) },
      });
    }
  },

  closeCode: () => set({ codePanel: null }),

  setCodeDraft: (draft) => {
    const codePanel = get().codePanel;
    if (!codePanel) return;
    set({ codePanel: { ...codePanel, draft, error: null } });
  },

  saveCode: async () => {
    const { project, codePanel } = get();
    if (!project || !codePanel || codePanel.saving) return;
    if (codePanel.draft === codePanel.original) return;
    set({ codePanel: { ...codePanel, saving: true, error: null } });
    try {
      // Same gate as the AI chat's writes: the sidecar re-parses strictly and
      // refuses anything that doesn't, so a half-typed edit can't land.
      const res = await writeSource(project.root, codePanel.file, codePanel.draft);
      if (!res.ok) throw new Error(res.error ?? "the file could not be written");
      const [, hash] = await commitSession(
        project.root,
        `dedup: edit ${codePanel.file}`,
        [codePanel.file],
      );
      const current = get().codePanel;
      if (current?.file === codePanel.file) {
        set({
          codePanel: {
            ...current,
            original: codePanel.draft,
            saving: false,
            error: null,
          },
        });
      }
      set({ lastSave: { branch: "", hash } });
      gitStatus(project.root).then((g) => set({ git: g })).catch(() => {});
      // A hand edit can add or remove elements, which renumbers the ordinals
      // every dedup id is built from — the canvas must re-read its tags.
      setTimeout(() => sendToOverlay({ type: "reload" }), 150);
      set({ selected: null, sourceInfo: null });
    } catch (e) {
      const current = get().codePanel;
      if (current?.file === codePanel.file) {
        set({ codePanel: { ...current, saving: false, error: errorText(e) } });
      }
    }
  },

  setSelected: (selected) => {
    set({ selected, sourceInfo: null });
    if (!selected) return;
    // A staged insert has no file to ask — its snippet is the source of truth.
    const insert = pendingInsert(get().actions, selected.dedupId);
    if (insert) {
      set({ sourceInfo: pendingNodeInfo(insert.snippet) });
      return;
    }
    // Ask the source of truth (the file) what this element is and admits.
    const target = targetOf(selected.dedupId);
    const root = get().project?.root;
    if (!target || !root) return;
    const unavailable = (reason: string): NodeInfo => ({
      editable: false,
      className: null,
      reason,
      line: 0,
      col: 0,
      tag: selected.tag,
      component: selected.component,
      dynamic: selected.dynamic,
      core: selected.core,
      parentIndex: null,
      canRemove: false,
      canMove: false,
      structuralReason: reason,
      canAcceptChildren: false,
      canEditText: false,
      textReason: reason,
      text: null,
    });
    inspectElement(root, target.file, target.index)
      .then((r) => {
        if (get().selected?.dedupId !== selected.dedupId) return; // stale
        if (!r.ok) {
          set({ sourceInfo: unavailable(r.error ?? "source lookup failed") });
          return;
        }
        set({
          sourceInfo: {
            editable: r.editable ?? false,
            className: r.className ?? null,
            reason: r.reason ?? null,
            line: r.line ?? 0,
            col: r.col ?? 0,
            tag: r.tag ?? selected.tag,
            component: r.component ?? selected.component,
            dynamic: r.dynamic ?? null,
            core: r.core ?? null,
            parentIndex: r.parentIndex ?? null,
            canRemove: r.canRemove ?? false,
            canMove: r.canMove ?? false,
            structuralReason: r.structuralReason ?? null,
            canAcceptChildren: r.canAcceptChildren ?? false,
            canEditText: r.canEditText ?? false,
            textReason: r.textReason ?? null,
            text: r.text ?? null,
          },
        });
      })
      .catch((e) => {
        if (get().selected?.dedupId !== selected.dedupId) return;
        set({ sourceInfo: unavailable(String(e)) });
      });
  },

  clearSelection: () => {
    sendToOverlay({ type: "clear" });
    set({ selected: null, sourceInfo: null });
  },

  selectById: (id) => sendToOverlay({ type: "select-id", id }),

  effectiveClassName: () => {
    const { selected, actions, sourceInfo } = get();
    if (!selected) return null;
    return (
      stagedValue(actions, "class", selected.dedupId) ??
      sourceInfo?.className ??
      null
    );
  },

  effectiveText: () => {
    const { selected, actions, sourceInfo } = get();
    if (!selected) return null;
    return (
      stagedValue(actions, "text", selected.dedupId) ?? sourceInfo?.text ?? null
    );
  },

  /** Push one action onto the program and re-sync the canvas from it. */
  stage: (action: EditAction, collapse?: (prev: EditAction) => boolean) => {
    const { actions } = get();
    const top = actions[actions.length - 1];
    const merges = top !== undefined && collapse !== undefined && collapse(top);
    const next = merges ? [...actions.slice(0, -1), action] : [...actions, action];
    set({ actions: next, redoStack: [] });
    syncCanvas(next);
  },

  applyClassEdit: (next, group) => {
    const { selected, sourceInfo, actions } = get();
    if (!selected || !sourceInfo?.editable) return;
    const target = editTargetFor(actions, selected.dedupId);
    if (!target) return;

    const from =
      stagedValue(actions, "class", selected.dedupId) ?? sourceInfo.className ?? "";
    if (next === from) return;

    // A scrub is one undo step: fold into the previous edit when both belong
    // to the same drag, keeping that step's original `before`.
    const top = actions[actions.length - 1];
    const merges =
      group !== undefined &&
      top?.kind === "class" &&
      top.group === group &&
      top.target.dedupId === selected.dedupId;

    get().stage(
      {
        kind: "class",
        target,
        before: merges && top.kind === "class" ? top.before : from,
        after: next,
        component: selected.component,
        group,
      },
      () => merges,
    );
  },

  applyTextEdit: (next) => {
    const { selected, sourceInfo, actions } = get();
    if (!selected || !sourceInfo?.canEditText) return;
    const target = editTargetFor(actions, selected.dedupId);
    if (!target) return;
    const from =
      stagedValue(actions, "text", selected.dedupId) ?? sourceInfo.text ?? "";
    if (next === from) return;
    const top = actions[actions.length - 1];
    const merges =
      top?.kind === "text" && top.target.dedupId === selected.dedupId;
    get().stage(
      {
        kind: "text",
        target,
        before: merges && top.kind === "text" ? top.before : from,
        after: next,
        component: selected.component,
      },
      () => merges,
    );
  },

  removeSelected: () => {
    const { selected, sourceInfo, actions } = get();
    if (!selected || !sourceInfo?.canRemove) return;

    // Deleting something that was never written means withdrawing the insert
    // itself — and any edits made to it, which would otherwise refer to an
    // element that no longer exists.
    if (isPendingId(selected.dedupId)) {
      const next = actions.filter(
        (a) =>
          !(a.kind === "insert" && a.id === selected.dedupId) &&
          !(isValueAction(a) && a.target.dedupId === selected.dedupId),
      );
      set({ actions: next, redoStack: [], selected: null, sourceInfo: null });
      syncCanvas(next);
      sendToOverlay({ type: "clear" });
      return;
    }

    const target = targetOf(selected.dedupId);
    if (!target) return;
    get().stage({
      kind: "remove",
      target,
      label: labelOfElement(selected),
    });
    // The element is gone from the canvas — a selection pointing at it would
    // show controls for something the user can no longer see.
    set({ selected: null, sourceInfo: null });
    sendToOverlay({ type: "clear" });
  },

  moveElement: (fromId, toId, position) => {
    const from = targetOf(fromId);
    const to = targetOf(toId);
    if (!from || !to || fromId === toId) return;
    // Cross-file moves would mean lifting markup out of one component and into
    // another — a refactor, not a drag. Refused with a reason rather than
    // half-done (the write-back would refuse it too).
    if (from.file !== to.file) {
      set({
        saveError: `Can't move between files yet — that element lives in ${from.file}, the drop target in ${to.file}.`,
      });
      return;
    }
    const { selected } = get();
    get().stage({
      kind: "move",
      target: from,
      to,
      position,
      label:
        selected?.dedupId === fromId ? labelOfElement(selected) : from.dedupId,
    });
  },

  insertElement: (kind, toId, position) => {
    const target = targetOf(toId);
    const entry = PALETTE[kind];
    if (!target || !entry) return;
    const id = `${PENDING_PREFIX}${crypto.randomUUID()}`;
    get().stage({
      kind: "insert",
      id,
      target,
      position,
      snippet: entry.snippet,
      preview: entry.preview,
      label: entry.label,
    });
    // Through the setter, not set(): the overlay has to be told to stop
    // waiting for a placement click, or it swallows the next selection.
    get().setInsertKind(null);
    // Select what was just placed, so the inspector is already pointed at it
    // and its text can be typed straight away.
    get().selectById(id);
  },

  setDragging: (draggingId) => set({ draggingId }),

  requestTextEdit: (dedupId) => {
    const { selected, sourceInfo } = get();
    // The double-click follows a click, so this element is the selection and
    // its capabilities are already known. If its text isn't editable, the
    // inspector is already showing the reason — nothing more to say here.
    if (selected?.dedupId !== dedupId || !sourceInfo?.canEditText) return;
    sendToOverlay({ type: "text-edit-begin", id: dedupId });
  },

  setInsertKind: (insertKind) => {
    set({ insertKind });
    sendToOverlay({
      type: "set-edit-mode",
      drag: get().tool === "select",
      insert: insertKind !== null,
    });
  },

  resyncCanvas: () => syncCanvas(get().actions),

  revertAction: (index) => {
    const { actions } = get();
    if (index < 0 || index >= actions.length) return;
    const next = actions.filter((_, i) => i !== index);
    set({ actions: next, redoStack: [] });
    syncCanvas(next);
  },

  undo: () => {
    const { actions, redoStack } = get();
    const top = actions[actions.length - 1];
    if (!top) return;
    const next = actions.slice(0, -1);
    set({ actions: next, redoStack: [...redoStack, top] });
    syncCanvas(next);
  },

  redo: () => {
    const { actions, redoStack } = get();
    const top = redoStack[redoStack.length - 1];
    if (!top) return;
    const next = [...actions, top];
    set({ actions: next, redoStack: redoStack.slice(0, -1) });
    syncCanvas(next);
  },

  saveAll: async () => {
    const { project, actions, saving } = get();
    if (!project || saving) return;
    // A class edit scrubbed back to where it started is not a change.
    const dirty = actions.filter(
      (a) => !isValueAction(a) || a.before !== a.after,
    );
    if (dirty.length === 0) return;

    set({ saving: true, saveError: null });
    try {
      // Group by file; one AST pass per file, every op resolved from that one
      // parse, so ops within a file need no ordering between themselves.
      const byFile = new Map<string, EditAction[]>();
      for (const a of dirty) {
        const file = a.target.file;
        byFile.set(file, [...(byFile.get(file) ?? []), a]);
      }
      for (const [file, group] of byFile) {
        const { ops, failures } = opsForFile(group);
        // A staged edit that cannot be expressed is a refusal, not something
        // to drop quietly on the way to disk.
        if (failures.length > 0) throw new Error(failures.join("; "));
        const res = await applyEdits(project.root, file, ops);
        if (!res.ok) throw new Error(res.error ?? `write failed for ${file}`);
      }

      const message = `dedup: ${describeProgram(dirty)}`;
      const [branch, hash] = await commitSession(
        project.root,
        message,
        [...byFile.keys()],
      );

      syncCanvas([]);
      set({
        actions: [],
        redoStack: [],
        lastSave: { branch, hash },
      });
      // Structural edits renumber the ordinals of everything after them in the
      // file, so the canvas must re-read its tags rather than trust the DOM it
      // already has. HMR re-stamps on its own for class-only saves.
      if (dirty.some((a) => !isValueAction(a))) {
        setTimeout(() => sendToOverlay({ type: "reload" }), 150);
        set({ selected: null, sourceInfo: null });
      }
      // Branch may have just been created — refresh the TopBar indicator.
      gitStatus(project.root)
        .then((g) => set({ git: g }))
        .catch(() => {});
      // Refresh the launch-grid card once HMR has repainted the canvas —
      // closing with ⌘Q never reaches the back button's capture.
      setTimeout(() => captureCanvasThumbnail(project.root), 1200);
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

  setSidebarTab: (sidebarTab) => set({ sidebarTab }),

  setPanelWidth: (panel, px) => {
    const panelWidths = { ...get().panelWidths, [panel]: clampPanel(panel, px) };
    set({ panelWidths });
    try {
      localStorage.setItem(PANEL_WIDTH_STORAGE, JSON.stringify(panelWidths));
    } catch {
      // Width is a nicety; a full quota must not break resizing.
    }
  },

  setInspectorTab: (inspectorTab) => set({ inspectorTab }),

  sendChat: async (instruction) => {
    const { project, selected, chatBusy } = get();
    const text = instruction.trim();
    if (!project || !selected || !text || chatBusy) return;
    const src = targetOf(selected.dedupId);
    if (!src) return;

    // Append to the active session, materializing a new one on first use.
    const push = (m: Omit<ChatMessage, "id">) =>
      set((s) => {
        let sessions = s.chatSessions;
        let id = s.activeChatId;
        if (!id || !sessions.some((x) => x.id === id)) {
          id = crypto.randomUUID();
          sessions = [
            ...sessions,
            { id, title: text.slice(0, 48), createdAt: Date.now(), messages: [] },
          ];
        }
        sessions = sessions.map((x) =>
          x.id === id
            ? { ...x, messages: [...x.messages, { id: crypto.randomUUID(), ...m }] }
            : x,
        );
        if (s.project) saveChatSessions(s.project.root, sessions);
        return { chatSessions: sessions, activeChatId: id };
      });

    // Conversation memory: prior turns of this session (texts only — the
    // file always goes in fresh), captured before this message lands.
    const active = get().chatSessions.find((x) => x.id === get().activeChatId);
    const history = (active?.messages ?? [])
      .filter((m) => !m.error)
      .slice(-12)
      .map((m) => ({ role: m.role, text: m.text }));

    push({
      role: "user",
      text,
      target: { label: selected.component ?? selected.tag, file: src.file },
    });

    // A full-file rewrite renumbers the ordinals this file's staged actions
    // are addressed by — make the user land or drop them first.
    const stagedHere = get().actions.some((a) => a.target.file === src.file);
    if (stagedHere) {
      push({
        role: "assistant",
        error: true,
        text: `This file has unsaved style edits. Save (⌘S) or discard them first — a chat edit would invalidate their positions.`,
      });
      return;
    }

    const kind = get().activeAiBackend();
    const backend =
      kind && kind !== "api"
        ? {
            kind: "cli" as const,
            agent: kind,
            run: (p: string) => agentPrompt(kind, p, get().agents[kind].model),
          }
        : kind === "api"
          ? { kind: "api" as const, apiKey: get().anthropicKey }
          : null;
    if (!backend) {
      push({
        role: "assistant",
        error: true,
        text: "No AI backend connected — choose one in the AI switch (top bar).",
      });
      return;
    }

    set({ chatBusy: true });
    try {
      const source = await readSource(project.root, src.file);
      // Stale-selection guard: edits since the selection can renumber the
      // file's elements, and a wrong element makes the model edit the wrong
      // thing. Re-resolve the id and check it still names the same tag.
      const live = await inspectElement(project.root, src.file, src.index);
      if (!live.ok || (live.tag ?? "").toLowerCase() !== selected.tag.toLowerCase()) {
        push({
          role: "assistant",
          error: true,
          text: "The file changed since you selected this element, so the selection is out of date. Re-select it on the canvas and try again.",
        });
        return;
      }
      const reply = parseChatReply(
        await runChatPrompt(
          backend,
          buildEditPrompt(
            { file: src.file, line: live.line ?? 0 },
            selected,
            source,
            text,
          ),
          history,
        ),
      );

      if (reply.kind === "answer") {
        push({ role: "assistant", text: reply.text });
        return;
      }
      const next =
        reply.kind === "blocks"
          ? applyEditBlocks(source, reply.blocks)
          : reply.content;

      // Trust gate: the sidecar re-parses the model's output and refuses
      // anything that doesn't parse; the write never lands on a user branch.
      const res = await writeSource(project.root, src.file, next);
      if (!res.ok) throw new Error(res.error ?? `write failed for ${src.file}`);
      if (!res.changed) {
        push({
          role: "assistant",
          text: "No change needed — the file already matches that instruction.",
        });
        return;
      }

      const [branch, hash] = await commitSession(
        project.root,
        `dedup: ${reply.summary}`,
        [src.file],
      );
      push({ role: "assistant", text: reply.summary, commit: hash });
      set({ lastSave: { branch, hash } });
      gitStatus(project.root)
        .then((g) => set({ git: g }))
        .catch(() => {});
      // Reload the canvas rather than trusting HMR (its socket can wedge),
      // and drop the selection — the edit may have shifted every position in
      // the file, so the old id can't be trusted for a follow-up.
      sendToOverlay({ type: "reload" });
      set({ selected: null, sourceInfo: null });
    } catch (e) {
      push({
        role: "assistant",
        error: true,
        text: String(e instanceof Error ? e.message : e),
      });
    } finally {
      set({ chatBusy: false });
    }
  },

  newChatSession: () => set({ activeChatId: null }),

  selectChatSession: (activeChatId) => set({ activeChatId }),

  deleteChatSession: (id) => {
    const { chatSessions, activeChatId, project } = get();
    const remaining = chatSessions.filter((x) => x.id !== id);
    if (project) saveChatSessions(project.root, remaining);
    set({
      chatSessions: remaining,
      activeChatId:
        activeChatId === id
          ? (remaining[remaining.length - 1]?.id ?? null)
          : activeChatId,
    });
  },

  runScan: async () => {
    const { project, scanning, devStatus, instrumentation, selectedRoute } =
      get();
    if (!project || scanning) return;
    // A live, tagged canvas scans one artboard at a time — the user picks
    // which by selecting it. No selection = ask, don't guess.
    const canvasLive = devStatus === "ready" && instrumentation?.active;
    if (canvasLive && !selectedRoute) {
      set({
        scanError:
          "Select an artboard first — click its name above the frame — then Scan.",
        sidebarTab: "duplicates",
      });
      return;
    }
    set({
      scanning: true,
      scanError: null,
      scanProgress: null,
      sidebarTab: "duplicates",
      openClusterId: null,
    });
    try {
      // Scope to the selected artboard's page, and grab each component's
      // rendered on-page size while the frame is right there — the gallery
      // cards take the same dimensions the components have on the site.
      // No running canvas or no tagged elements → honest fallback to a
      // whole-project scan (and harness-measured card sizes).
      const [canvasFiles, liveSizes] =
        canvasLive && selectedRoute
          ? await Promise.all([
              requestFrameFiles(selectedRoute),
              requestFrameSizes(selectedRoute),
            ])
          : [null, null];
      const scope = canvasFiles && canvasFiles.length > 0 ? canvasFiles : null;
      const result = await scanProject(project.root, scope);
      if (!result.ok) throw new Error(result.error ?? "scan failed");
      if (liveSizes) saveLiveSizes(project.root, liveSizes);
      // Fresh results land in the Components tab (restores stay put).
      set({
        scanResult: result,
        editorTab: "components",
        ...(liveSizes ? { liveSizes } : {}),
      });
      // One button, whole flow: cached categories apply instantly, then AI
      // categorizes whatever is new/changed (no-op without an API key).
      await get().applyCachedCategories();
      void get().categorize();
    } catch (e) {
      set({ scanError: String(e instanceof Error ? e.message : e) });
    } finally {
      set({ scanning: false, scanProgress: null });
    }
  },

  restoreScan: async () => {
    const { project, scanResult, scanning } = get();
    if (!project || scanResult || scanning) return;
    try {
      const saved = await loadScanResult(project.root);
      // Still relevant? The user may have scanned or left meanwhile. Saves
      // from older builds (schema mismatch) are ignored — just rescan.
      if (
        saved?.ok &&
        saved.schema === SCAN_SCHEMA &&
        get().project?.root === project.root &&
        !get().scanResult
      ) {
        set({ scanResult: saved });
        void get().applyCachedCategories();
      }
    } catch {
      // No saved scan is a perfectly fine state.
    }
  },

  setScanProgress: (scanProgress) => set({ scanProgress }),

  openCluster: (openClusterId) => set({ openClusterId }),

  dismissCluster: (id) => {
    const { project, dismissed, openClusterId } = get();
    const next = { ...dismissed, [id]: true as const };
    if (project) saveDismissed(project.root, next);
    set({
      dismissed: next,
      openClusterId: openClusterId === id ? null : openClusterId,
    });
  },

  setAnthropicKey: (anthropicKey) => {
    try {
      if (anthropicKey) localStorage.setItem(KEY_STORAGE, anthropicKey);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      // Best-effort persistence; the in-memory key still works this session.
    }
    set({ anthropicKey });
  },

  applyCachedCategories: async () => {
    const { project, scanResult } = get();
    if (!project || !scanResult) return;
    try {
      const cache = (await loadCategories(project.root)) ?? {};
      if (get().scanResult !== scanResult) return; // scan changed meanwhile
      set(validAssignments(cache, scanResult.gallery));
    } catch {
      // No cache is a fine state.
    }
  },

  detectAgent: async (agent) => {
    if (get().agents[agent].installed !== null) return;
    let installed = false;
    try {
      installed = await agentAvailable(agent);
    } catch {
      installed = false;
    }
    patchAgent(set, get, agent, { installed });
  },

  setAiPref: (aiPref) => {
    try {
      if (aiPref) localStorage.setItem(AI_PREF_STORAGE, aiPref);
      else localStorage.removeItem(AI_PREF_STORAGE);
    } catch {
      // In-memory pref still applies this session.
    }
    set({ aiPref });
  },

  setAgentModel: (agent, model) => {
    patchAgent(set, get, agent, { model });
    saveAgentPrefs(get().agents);
  },

  connectAgent: async (agent) => {
    if (get().agents[agent].connecting) return;
    const meta = CLI_AGENTS.find((a) => a.id === agent);
    const label = meta?.label ?? agent;
    const command = meta?.command ?? agent;
    patchAgent(set, get, agent, { connecting: true, error: null });
    try {
      if (get().agents[agent].installed === null) await get().detectAgent(agent);
      if (!get().agents[agent].installed) {
        throw new Error(
          `${label} CLI not found. Install it and run \`${command}\` once to sign in.`,
        );
      }
      // A live round-trip is the consent moment *and* the proof: it is the
      // only thing that distinguishes "installed" from "actually usable",
      // which for a CLI that can be signed out is a real difference.
      const reply = await agentPrompt(
        agent,
        "Reply with exactly: ok",
        get().agents[agent].model,
      );
      if (!/ok/i.test(reply)) {
        throw new Error(`unexpected reply from ${label}: ${reply.slice(0, 120)}`);
      }
      patchAgent(set, get, agent, { consent: true, error: null });
      saveAgentPrefs(get().agents);
      get().setAiPref(agent);
      // Organize the current scan right away with the new backend.
      void get().categorize();
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      patchAgent(set, get, agent, {
        error: /login|auth|credential|unauthorized|sign in/i.test(msg)
          ? `${msg}\n\nRun \`${command}\` in a terminal, sign in, then retry.`
          : msg,
      });
    } finally {
      patchAgent(set, get, agent, { connecting: false });
    }
  },

  activeAiBackend: () => {
    const { aiPref, agents, anthropicKey } = get();
    if (aiPref && aiPref !== "api") {
      const state = agents[aiPref];
      if (state?.consent && state.installed !== false) return aiPref;
    }
    if (aiPref === "api" && anthropicKey) return "api";
    return null;
  },

  categorize: async () => {
    const { project, scanResult, anthropicKey, categorizing } = get();
    if (!project || !scanResult || categorizing) return;
    // Backend is an explicit user choice (TopBar AI switch); no silent use.
    const kind = get().activeAiBackend();
    const backend: AiBackend | null =
      kind && kind !== "api"
        ? {
            kind: "cli",
            agent: kind,
            run: (p) => agentPrompt(kind, p, get().agents[kind].model),
          }
        : kind === "api"
          ? { kind: "api", apiKey: anthropicKey }
          : null;
    if (!backend) return;
    set({ categorizing: true, categorizeError: null, categorizeProgress: null });
    try {
      const cache = (await loadCategories(project.root)) ?? {};
      const pending = needingCategorization(scanResult.gallery, cache);
      if (pending.length > 0) {
        const fresh = await categorizeComponents(
          backend,
          pending,
          (done, total) => set({ categorizeProgress: { done, total } }),
        );
        Object.assign(cache, fresh);
        await saveCategories(project.root, cache);
      }
      set(validAssignments(cache, scanResult.gallery));
    } catch (e) {
      set({ categorizeError: String(e instanceof Error ? e.message : e) });
    } finally {
      set({ categorizing: false, categorizeProgress: null });
    }
  },

  removeMember: (clusterId, memberIndex) => {
    const { scanResult, openClusterId } = get();
    if (!scanResult) return;
    const clusters = scanResult.clusters
      .map((c) => {
        if (c.id !== clusterId) return c;
        const members = c.members.filter((_, i) => i !== memberIndex);
        return { ...c, members };
      })
      .filter((c) => c.members.length >= 2);
    const stillOpen = clusters.some((c) => c.id === openClusterId);
    set({
      scanResult: { ...scanResult, clusters },
      openClusterId: stillOpen ? openClusterId : null,
    });
  },

  runVisualPass: async () => {
    const { project, scanResult, dismissed, visualPass, editorTab } = get();
    if (!project || !scanResult || visualPass) return;
    const clusters = rankClusters(scanResult, dismissed);
    if (clusters.length === 0) return;
    // The pass hashes what the gallery draws, so the gallery has to be the
    // visible view — the snapshot API rasterises the window, not the DOM.
    if (editorTab !== "components") set({ editorTab: "components" });
    set({ visualPass: { done: 0, total: 0 } });
    try {
      const { scores, hashes } = await runVisualPass(
        clusters,
        (done, total) => set({ visualPass: { done, total } }),
        () => get().visualPass === null || get().scanResult !== scanResult,
      );
      if (get().scanResult !== scanResult) return; // rescanned meanwhile
      set({
        visualScores: { ...get().visualScores, ...scores },
        visualHashes: { ...get().visualHashes, ...hashes },
      });
    } finally {
      set({ visualPass: null });
    }
  },

  /** Stop the pass — `runVisualPass` polls this flag between captures. */
  cancelVisualPass: () => set({ visualPass: null }),

  // --- Guarded merge (FR-5.4 → FR-5.7) --------------------------------------

  startMerge: async (clusterId) => {
    const { project, scanResult, merge } = get();
    if (!project || merge) return; // one merge at a time, by design
    const cluster = scanResult?.clusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    const members = cluster.members.map((m) => ({ name: m.name, file: m.file }));
    set({
      merge: {
        clusterId,
        members,
        stage: "planning",
        plan: null,
        proposal: null,
        preview: null,
        gates: [],
        runningGate: null,
        error: null,
        commit: null,
        rollbackReason: null,
      },
    });
    try {
      const plan = await apiMergePlan(project.root, members);
      if (get().merge?.clusterId !== clusterId) return; // cancelled meanwhile
      if (!plan.ok) throw new Error(plan.error ?? "the merge plan failed");
      patchMerge(set, get, { plan });
      await get().reproposeMerge();
    } catch (e) {
      patchMerge(set, get, { stage: "failed", error: errorText(e) });
    }
  },

  reproposeMerge: async () => {
    const { project, merge } = get();
    if (!project || !merge?.plan) return;
    const backend = aiBackend(get());
    if (!backend) {
      patchMerge(set, get, {
        stage: "failed",
        error:
          "A merge proposal needs an AI backend — connect Claude Code or add an API key in the AI switch.",
      });
      return;
    }
    patchMerge(set, get, { stage: "proposing", error: null });
    try {
      const reply = await runMergePrompt(backend, merge.plan);
      if (get().merge?.clusterId !== merge.clusterId) return;
      const proposal = parseMergeReply(reply, merge.plan);
      patchMerge(set, get, { proposal });
      await refreshPreview(set, get);
    } catch (e) {
      patchMerge(set, get, { stage: "failed", error: errorText(e) });
    }
  },

  editProposal: async (source) => {
    const merge = get().merge;
    if (!merge?.proposal) return;
    patchMerge(set, get, {
      proposal: { ...merge.proposal, source },
      stage: "planning",
    });
    await refreshPreview(set, get);
  },

  confirmMerge: async () => {
    const { project, merge, routes, devStatus } = get();
    if (!project || !merge?.proposal || merge.stage !== "review") return;
    const { proposal } = merge;

    patchMerge(set, get, { stage: "applying", error: null, gates: [] });
    // The "before" side of the visual gate has to be taken while the old
    // code is still what the canvas is rendering — after the write, it is
    // gone. Nothing else in the merge can happen first.
    let capturedBefore: string[] = [];
    try {
      await visualForget("merge:");
      capturedBefore = await captureArtboards("before", routes);
    } catch {
      // No captures = no visual gate; runVisualGate reports that as skipped.
    }

    try {
      const preview = await mergeApply(
        project.root,
        { name: proposal.name, file: proposal.file, source: proposal.source },
        proposal.mapping,
        false,
      );
      if (!preview.ok) throw new Error(preview.error ?? "the merge could not be applied");

      const message = `dedup: merge ${merge.members
        .map((m) => m.name)
        .join(", ")} → ${proposal.name}`;
      // Commit every path the merge touched, including the files it retired,
      // so the commit is a complete unit that a single revert can undo.
      const paths = [
        ...new Set([...(preview.written ?? []), ...(preview.retired ?? [])]),
      ];
      const [, commit] = await commitSession(project.root, message, paths);
      patchMerge(set, get, { preview, commit, stage: "gating" });
      gitStatus(project.root).then((g) => set({ git: g })).catch(() => {});

      // Structural rewrite across files: ordinals everywhere shifted, so the
      // canvas must re-read its tags rather than trust the DOM it has.
      sendToOverlay({ type: "reload" });
      set({ selected: null, sourceInfo: null, actions: [], redoStack: [] });

      // --- gates (FR-5.6) ---
      const gates: GateResult[] = [];
      // 1 + 2: the project's own typecheck and build.
      const buildGates = await runBuildGates(project.root, (kind) =>
        patchMerge(set, get, { runningGate: kind }),
      );
      gates.push(...buildGates);
      // The live compile is a second, faster read on the same question — it
      // is what catches a break on the page the user is looking at.
      gates.push(hmrGate(devStatus === "ready", get().errors, 0));
      patchMerge(set, get, { gates: [...gates], runningGate: "visual" });

      // 3: the visual pass, against the artboards captured above.
      const capturedAfter = await captureArtboards("after", routes);
      gates.push(
        await runVisualGate({ before: capturedBefore, after: capturedAfter }),
      );
      patchMerge(set, get, { gates: [...gates], runningGate: null });

      if (!gatesPassed(gates)) {
        await get().rollbackMerge(gateSummary(gates));
        return;
      }
      patchMerge(set, get, { stage: "done" });
      void get().loadHistory();
      void get().loadTrash();
    } catch (e) {
      // A failure after the commit landed still has to be undone.
      if (get().merge?.commit) await get().rollbackMerge(errorText(e));
      else patchMerge(set, get, { stage: "failed", error: errorText(e) });
    }
  },

  rollbackMerge: async (reason) => {
    const { project, merge } = get();
    if (!project || !merge) return;
    patchMerge(set, get, { stage: "applying", rollbackReason: reason });
    try {
      // Files first: the commit's revert restores the retired sources, and
      // the trash copy would otherwise linger as a duplicate of a live file.
      if (merge.commit) await revertCommit(project.root, merge.commit);
      const staged = merge.preview?.trashed ?? [];
      if (staged.length > 0) {
        await mergeTrash(project.root, "restore", staged).catch(() => {});
        // The revert already put the files back; drop the staged copies
        // rather than leaving two spellings of the same source on disk.
        await mergeTrash(project.root, "empty").catch(() => {});
      }
      sendToOverlay({ type: "reload" });
      gitStatus(project.root).then((g) => set({ git: g })).catch(() => {});
      patchMerge(set, get, { stage: "rolledback", rollbackReason: reason });
      void get().loadHistory();
      void get().loadTrash();
    } catch (e) {
      patchMerge(set, get, {
        stage: "failed",
        error: `the merge failed (${reason}) and the rollback also failed: ${errorText(
          e,
        )} — your work is on the session branch; \`git log\` and revert by hand`,
      });
    }
  },

  cancelMerge: () => {
    void visualForget("merge:").catch(() => {});
    set({ merge: null });
  },

  loadHistory: async () => {
    const { project } = get();
    if (!project) return;
    try {
      set({ history: await sessionHistory(project.root) });
    } catch {
      // No repo or no commits yet is a perfectly ordinary state.
      set({ history: [] });
    }
  },

  toggleHistory: (open) => {
    const next = open ?? !get().historyOpen;
    set({ historyOpen: next });
    if (next) void get().loadHistory();
  },

  revertEntry: async (hash) => {
    const { project } = get();
    if (!project) return;
    await revertCommit(project.root, hash);
    sendToOverlay({ type: "reload" });
    set({ selected: null, sourceInfo: null });
    gitStatus(project.root).then((g) => set({ git: g })).catch(() => {});
    await get().loadHistory();
  },

  loadTrash: async () => {
    const { project } = get();
    if (!project) return;
    try {
      const res = await mergeTrash(project.root, "list");
      set({ trash: res.files ?? [] });
    } catch {
      set({ trash: [] });
    }
  },

  restoreTrash: async (files) => {
    const { project } = get();
    if (!project) return;
    await mergeTrash(project.root, "restore", files ?? null);
    await get().loadTrash();
  },

  emptyTrash: async () => {
    const { project } = get();
    if (!project) return;
    await mergeTrash(project.root, "empty");
    await get().loadTrash();
  },

}));
