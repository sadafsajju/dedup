import { create } from "zustand";
import {
  captureCanvasThumbnail,
  agentAvailable,
  agentModels,
  agentPrompt,
  chooseExportPath,
  exportArtboard as renderArtboardExport,
  loadParked,
  saveParked,
  snapshotRegion,
  type Rect,
  commitSession,
  gitInitBaseline,
  gitStatus,
  copyElement,
  importAgentAsset,
  inspectElement,
  loadCategories,
  loadScanResult,
  readSource,
  writeSources,
  revertSources,
  listProjectFiles,
  grepProject,
  saveCategories,
  scanProject,
  extractProject,
  loadExtractResult,
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
  parseExtractReply,
  runExtractPrompt,
  type ExtractionProposal,
} from "./driftProposal";
import {
  combinedConfidence,
  runVisualPass,
  type VisualScore,
} from "./visualPass";
import { generateSeed } from "./session";
import { artboardUrl, resolveOrigin } from "./origins";
import { clampZoom } from "./panZoom";
import {
  layoutArtboards,
  loadCanvas,
  saveCanvas,
  MAX_ARTBOARDS,
  type SavedCanvas,
} from "./canvasMemory";
import {
  MAX_ANNOTATIONS,
  MAX_NOTE,
  PENS,
  annotationNotes,
  loadAnnotations,
  saveAnnotations,
  type Annotation,
  type AnnotationKind,
} from "./annotate";
import {
  buildTurnPrompt,
  formatToolResult,
  imageRequestPrompt,
  isHtmlFile,
  runChatPrompt,
  systemPromptFor,
  type ChatAttachment,
  type ChatTurn,
} from "./chat";
import {
  MAX_TOOL_ROUNDS,
  applyProgram,
  parseChatReply,
  pickGeneratedImage,
  retargetReferences,
  type ChatReply,
  type ToolCall,
} from "./chatEdits";
import { mentionAlias, routeMention } from "./mentions";
import { redoStep, undoStep } from "./undo";
import {
  persistable,
  reconcileParked,
  sanitizeParked,
  settleParked,
  type ParkedPiece,
  type Point,
} from "./parking";
import {
  categorizeComponents,
  needingCategorization,
  skeletonHash,
  type AiBackend,
  type CategoryCache,
} from "./categorize";
import {
  requestElementHtml,
  requestFrameFiles,
  requestFrameSizes,
  sendToFrame,
  sendToOverlay,
} from "./bridge";
import {
  isPendingId,
  isValueAction,
  opsForFile,
  stagingConflict,
  withoutAction,
  PENDING_PREFIX,
  SCAN_SCHEMA,
  DRIFT_SCHEMA,
  targetOf,
  VIEWPORTS,
} from "./types";
import {
  KNOBS,
  fromTokens,
  setKnob,
  sizeClass,
  toTokens,
} from "./tailwind";
import {
  classAttrFor,
  classNameOf,
  PALETTE,
  parseSimpleElement,
  textOf,
  withAttr,
  withText,
  type InsertKind,
} from "./palette";
import { foldLine, type ParsedError } from "./errors";
import { CLI_AGENTS, agentOn, artboardHeight } from "./types";
import type {
  AgentState,
  ChatMessage,
  Clipboard,
  ChatSession,
  CliAgent,
  GateResult,
  HistoryEntry,
  MergeSession,
  PendingEdit,
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
  SnippetLang,
  SidebarTab,
  DriftProgress,
  DriftResult,
  Tool,
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
  tool: Tool;
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
  /** Artboards rendering with the app's network cut, so its no-internet
   * state — the error and empty screens nobody can otherwise reach — is on
   * the canvas to look at and style. The dev server's own traffic is left
   * alone, so the frame still hot-reloads while the app inside it fails. */
  offlineRoutes: Record<string, true>;
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
  editorTab: "canvas" | "components" | "drift";

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

  /** Hand-drawn marks over the artboards (lib/annotate), every route of this
   * project — the layer renders the ones whose page is open. */
  annotations: Annotation[];
  /** Shape the annotate tool draws next. */
  annotateKind: AnnotationKind;
  /** Ink colour for the next mark. */
  annotateColor: string;
  /** The mark whose note is open for typing, if any. */
  noteEditing: string | null;
  /** What a copy or a cut put down, until the next one replaces it. Not
   * the system clipboard: what is being carried is a piece of the user's
   * source with a rendering attached, and neither half survives a round trip
   * through plain text. */
  clipboard: Clipboard | null;
  saving: boolean;
  /** `direct`: written in place in a project with no git — no branch, no
   *  commit, so there is no hash to show. */
  lastSave: { branch: string; hash: string; direct?: boolean } | null;
  /** The user has been warned, this session, that saving into a project with
   *  no git replaces their files in place — no branch to put the change on,
   *  no commit to undo it. Reset with the project. */
  directWriteOk: boolean;
  /** A save waiting on that warning: the files it would replace, and how to
   *  run it once the user confirms. */
  directWritePrompt: { files: string[]; run: () => void } | null;
  confirmDirectWrite: () => void;
  cancelDirectWrite: () => void;
  saveError: string | null;
  /** A passing message about the gesture just made — what was copied, or why
   * it could not be. Distinct from `saveError`, which is specifically a save
   * that failed and offers a retry. Clears itself. */
  notice: string | null;

  sidebarTab: SidebarTab;

  // Inspector chat (AI edits on the selected element). Sessions persist per
  // project; the active one is what the panel shows. null active id = a new
  // chat that materializes on the first message.
  inspectorTab: "design" | "chat";
  chatSessions: ChatSession[];
  activeChatId: string | null;
  chatBusy: boolean;
  /** What a turn in flight is doing right now, when it is worth saying —
   *  another agent generating an image takes long enough that a bare
   *  "Working…" reads as a hang. null while there is nothing to add. */
  chatActivity: string | null;
  /** The edit the agent has proposed and the user hasn't resolved yet — a
   *  diff on screen, nothing on disk. One at a time: a second proposal is
   *  computed against file contents the first one would have changed, so
   *  holding two would mean holding one that is quietly wrong. */
  pendingEdit: PendingEdit | null;

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

  // Inline drift (FR-5.10) — repeated markup that was never a component.
  driftRunning: boolean;
  driftProgress: DriftProgress | null;
  driftResult: DriftResult | null;
  driftError: string | null;
  /** Candidate expanded in the drift list, and shown in the drift view. */
  openDriftId: string | null;
  /** The drift view's own viewport. Separate from the canvas's: switching
   *  tabs is a change of scene, not of viewport. */
  driftZoom: number;
  driftPan: { x: number; y: number };
  /** The model's proposed component for the current selection, once asked. */
  driftProposal: ExtractionProposal | null;
  driftProposing: boolean;
  driftProposalError: string | null;
  /** Occurrences of the open candidate the user wants in the extraction,
   *  keyed `file:start`. Opening a candidate selects all of them — the common
   *  case is "these are all the same thing", and deselecting the odd one out
   *  is less work than picking fifteen. */
  driftSelection: Record<string, true>;
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
  /** The API-key backend's switch (persisted). The agents' switches live in
   *  `agents[…].enabled`; this is the same thing for the key. */
  apiEnabled: boolean;

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
  setTool: (tool: Tool) => void;
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
  /** Cut (or restore) one artboard's network. Takes effect on the reload the
   * flag change causes — it has to be armed before the app boots. */
  toggleOffline: (route: string) => void;
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
  setEditorTab: (tab: "canvas" | "components" | "drift") => void;
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
  /** Add one action to the staged program. Returns false when it was refused
   *  — a program the write-back could not save is never staged in the first
   *  place (see `stagingConflict`), so callers that chain off a stage must
   *  check rather than assume. */
  stage: (action: EditAction, collapse?: (prev: EditAction) => boolean) => boolean;
  /** Stage a class edit + live-patch the canvas (FR-3.7). `group` ties the
   * edit to one drag gesture so scrubbing costs a single undo step. */
  applyClassEdit: (next: string, group?: string) => void;
  /** Stage a static-text edit on the selection. */
  applyTextEdit: (next: string) => void;
  /** Size the selection from a canvas resize gesture. `group` collapses the
   * whole drag into one undo step, the way a scrub does. */
  resizeSelected: (
    width: number | null,
    height: number | null,
    group: string,
  ) => void;
  /** Stage deletion of the selected element (Delete/⌫). */
  removeSelected: () => void;
  /** Stage a move/reparent, as reported by a canvas drag. */
  moveElement: (fromId: string, toId: string, position: DropPosition) => void;
  /** Stage an insert of a palette element against a reference node. */
  insertElement: (kind: InsertKind, toId: string, position: DropPosition) => void;
  /** Put the selected element on dedup's clipboard (⌘C). */
  copySelected: () => Promise<void>;
  /** Copy the selection, then stage its deletion (⌘X). */
  cutSelected: () => Promise<void>;
  /** Stage an insert of whatever is on the clipboard, against the selection
   * (⌘V). Placed as a sibling after it, or inside it when a sibling is not a
   * legal place for the copy to go. */
  pasteClipboard: () => Promise<void>;
  /** Say something in passing, and take it back after a few seconds. */
  setNotice: (message: string | null) => void;
  setDragging: (dedupId: string | null) => void;
  /** The element the caret is currently in on the canvas, or null. Reported
   * by the overlay, which is the only side that knows: Escape, Enter, a click
   * elsewhere and a re-render all end an edit without the editor's help. */
  textEditing: string | null;
  /** True when the user chose the text tool deliberately (the T button or
   * shortcut), so it stays put after an edit ends. A double-click borrows the
   * tool for one edit and hands it back — the gesture was "edit this", not
   * "switch modes". */
  textToolSticky: boolean;
  setTextEditing: (dedupId: string | null) => void;
  /** A canvas double-click asking to type into an element — allowed only when
   * the write-back says that element's text is editable. */
  requestTextEdit: (dedupId: string) => Promise<void>;
  setInsertKind: (kind: InsertKind | null) => void;
  setAnnotateKind: (kind: AnnotationKind) => void;
  setAnnotateColor: (color: string) => void;
  /** Put a finished mark on the canvas. Returns it so the caller can open its
   * note straight away — drawing a circle and writing what is wrong with it
   * is one gesture, not two. */
  addAnnotation: (a: Annotation) => void;
  setNote: (id: string, note: string) => void;
  setNoteEditing: (id: string | null) => void;
  removeAnnotation: (id: string) => void;
  /** Re-send the staged program to the canvas (a frame reloaded). */
  resyncCanvas: () => void;
  /** Discard one staged action by list position (review panel), redoable. */
  revertAction: (index: number) => void;
  /** Throw the whole staged program away. The way out of a program that
   * cannot be saved — every other exit from one goes through a save. */
  discardAllEdits: () => void;
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
  /** Commit the previewed proposal to the session branch. */
  acceptChatEdit: () => Promise<void>;
  /** Put the files back exactly as they were and drop the proposal. */
  rejectChatEdit: () => Promise<void>;
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
  /** Find repeated JSX subtrees and land on the Drift tab (FR-5.10). */
  runDrift: () => Promise<void>;
  /** Load the last persisted drift run for the open project, if any. */
  restoreDrift: () => Promise<void>;
  setDriftProgress: (p: DriftProgress) => void;
  /** Open a candidate: expands its row, selects every copy, and shows them
   *  rendered together in the main view. */
  openDrift: (id: string | null) => void;
  toggleDriftOccurrence: (key: string) => void;
  /** Put every copy back in the selection. */
  selectAllDrift: () => void;
  setDriftTransform: (t: { zoom: number; pan: { x: number; y: number } }) => void;
  /** Ask the model for the component that replaces the selected copies. This
   *  never writes: the extraction codemod does not exist, so a proposal is
   *  shown and nothing lands. */
  proposeExtraction: () => Promise<void>;
  /** Render every cluster member in isolation and compare the pixels — the
   * scan's visual signal (FR-5.2). Runs on demand, from the Components tab. */
  runVisualPass: () => Promise<void>;
  cancelVisualPass: () => void;

  setAnthropicKey: (key: string) => void;
  /** Detect a coding-agent CLI once per app run. */
  detectAgent: (agent: CliAgent) => Promise<void>;
  /** Switch an agent on or off. On for one never connected runs Connect
   *  (the live test); off keeps its consent, so on again is instant. */
  setAgentEnabled: (agent: CliAgent, on: boolean) => Promise<void>;
  setApiEnabled: (on: boolean) => void;
  setAgentModel: (agent: CliAgent, model: string | null) => void;
  /** Ask the installed CLI which models it offers, once per app run. */
  loadAgentModels: (agent: CliAgent) => Promise<void>;
  /** Export one artboard as a PNG (at `scale`) or a vector PDF, after asking
   *  where to save it. Renders the page at its real size, off-screen. */
  exportArtboard: (route: string, format: "png" | "pdf", scale?: number) => Promise<void>;
  /** The route an export is running for, if any — one at a time. */
  exporting: string | null;
  /** Where the user has put each artboard, per viewport id (persisted with
   *  the canvas). Missing entries fall back to the row — `artboardLayout`. */
  artboardPos: Record<string, Record<string, Point>>;
  /** Put an artboard somewhere on the canvas (dragged by its name label). */
  moveArtboard: (route: string, at: Point) => void;
  /** Elements dragged off every artboard onto the canvas (see lib/parking). */
  parked: ParkedPiece[];
  /** A drag that has left its artboard: where the pointer is on screen and
   *  which artboard, if any, it is over. Drawn as a ghost by the canvas. */
  dragOut: { route: string; id: string; label: string; screen: Point; over: string | null } | null;
  setDragOut: (d: AppState["dragOut"]) => void;
  /** Drop an element on the empty canvas: stage its removal from its page
   *  and park it at `at` (surface coordinates). `rect` is where it is on
   *  screen now, for its picture. */
  parkElement: (a: {
    id: string;
    route: string;
    element: SelectedElement;
    at: Point;
    rect: Rect | null;
  }) => Promise<void>;
  /** Drop an element into another artboard: a cut and a paste, staged as one
   *  gesture by the same rules as ⌘X then ⌘V. */
  moveAcross: (a: {
    id: string;
    element: SelectedElement;
    drop: { id: string; position: DropPosition };
  }) => Promise<void>;
  /** Drop a parked piece into an artboard: a paste of what it holds. */
  placeParked: (pieceId: string, drop: { id: string; position: DropPosition }) => Promise<void>;
  moveParked: (pieceId: string, at: Point) => void;
  deleteParked: (pieceId: string) => void;
  /** How the last export went, until dismissed. */
  exportNotice: { text: string; error: boolean; path?: string } | null;
  dismissExportNotice: () => void;
  /** Make a project with no git a repository, with its files as the first
   *  commit. A live preview is set aside for the baseline and put back after,
   *  so it can then be kept. Resolves to an error message, or null. */
  setUpGit: () => Promise<string | null>;
  settingUpGit: boolean;
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

/**
 * The `inspect` call behind the current selection, while it is still in
 * flight. Not store state — nothing renders it; it exists so an action can
 * *wait* for the selection's capabilities rather than read a null and give up.
 *
 * That matters for exactly one gesture. A double-click's two clicks both
 * select, and the answer to "may I type into this?" comes from a node sidecar
 * spawn that usually has not returned by the time `dblclick` fires. Dropping
 * the request there made double-click-to-edit work intermittently, which read
 * as broken.
 */
let sourceInfoPending: { id: string; done: Promise<void> } | null = null;

/**
 * The element's capabilities as the write-back reports them, waiting for an
 * in-flight lookup when there is one. Null when the selection moved on.
 */
async function sourceInfoFor(
  get: () => AppState,
  dedupId: string,
): Promise<NodeInfo | null> {
  const now = get();
  if (now.selected?.dedupId === dedupId && now.sourceInfo) return now.sourceInfo;
  if (sourceInfoPending?.id === dedupId) {
    await sourceInfoPending.done;
    const after = get();
    return after.selected?.dedupId === dedupId ? after.sourceInfo : null;
  }
  return null;
}

/**
 * Take a previewed edit back off the disk. Returns an error string when some
 * file could not be restored, so the caller can say so rather than leaving the
 * user believing their tree is clean when it isn't.
 */
async function revertPreview(
  root: string,
  edit: PendingEdit,
): Promise<string | null> {
  if (!edit.previewing) return null;
  try {
    const res = await revertSources(root, [
      ...edit.files.map((f) => [f.file, f.before] as [string, string | null]),
      // An imported image is a new file by construction — dedup refuses to
      // import over an existing one — so putting the tree back means removing
      // it, which is what a null restores to.
      ...edit.assets.map((a) => [a.file, null] as [string, string | null]),
    ]);
    return res.ok ? null : (res.error ?? "restore failed");
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Stop a save for the no-git warning when it needs one. dedup's safety model
 * is a session branch and a commit per change; a folder with no git has
 * neither, so a save there replaces the user's files in place with nothing in
 * git to undo it. That is allowed — it is their folder — but only once they
 * have been told, in so many words, once per session. `run` is how the save
 * gets back in after they confirm. Returns whether the save must stop here.
 */
function needsDirectWriteWarning(
  set: Setter,
  get: Getter,
  files: string[],
  run: () => void,
): boolean {
  const { git, directWriteOk } = get();
  if (git?.isRepo !== false || directWriteOk) return false;
  set({ directWritePrompt: { files: [...new Set(files)], run } });
  return true;
}

/**
 * Record a save: a commit on the session branch, or — in a project with no
 * git, after the warning — nothing more. The write has already landed and
 * there is no history to put it in; `direct` says so, so nothing downstream
 * presents a hash that does not exist.
 */
async function commitOrDirect(
  get: Getter,
  root: string,
  message: string,
  paths: string[],
): Promise<{ branch: string; hash: string; direct: boolean }> {
  if (get().git?.isRepo === false) return { branch: "", hash: "", direct: true };
  const [branch, hash] = await commitSession(root, message, paths);
  return { branch, hash, direct: false };
}

/**
 * Put a set-aside preview back on disk exactly as it was: images first (new
 * files, so they can be taken back if the text write fails), then the text.
 * The images are re-imported from where the agent left them, under the same
 * gates — under their final names, so no extension is adapted twice.
 */
async function reapplyPreview(root: string, edit: PendingEdit): Promise<string | null> {
  const imported: string[] = [];
  try {
    for (const a of edit.assets) {
      imported.push((await importAgentAsset(root, a.agent, a.source, a.file)).file);
    }
    const res = edit.files.length > 0
      ? await writeSources(root, edit.files.map((f) => [f.file, f.after] as [string, string]))
      : { ok: true };
    if (!res.ok) throw new Error(res.error ?? "write failed");
    return null;
  } catch (e) {
    if (imported.length > 0) {
      await revertSources(root, imported.map((f) => [f, null] as [string, string | null])).catch(() => {});
    }
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Rewrite one message in the active chat session — how a proposal records
 * what became of it (accepted with its commit, rejected, superseded). The
 * transcript is the audit trail for AI edits, so an outcome that never got
 * written back would leave it claiming a change that did not happen.
 */
function patchChatMessage(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  messageId: string,
  patch: Partial<ChatMessage>,
) {
  set((s) => {
    const sessions = s.chatSessions.map((session) => ({
      ...session,
      messages: session.messages.map((m) =>
        m.id === messageId ? { ...m, ...patch } : m,
      ),
    }));
    if (s.project) saveChatSessions(s.project.root, sessions);
    return { chatSessions: sessions };
  });
}

const KEY_STORAGE = "dedup:anthropic-key";
const AI_PREF_STORAGE = "dedup:ai-pref";
const AGENTS_STORAGE = "dedup:cli-agents";
const API_ON_STORAGE = "dedup:api-enabled";

/** The single backend choice that predates per-agent switches. Read only to
 *  carry it over: whichever backend was chosen is the one that starts on. */
function legacyAiPref(): string | null {
  try {
    return localStorage.getItem(AI_PREF_STORAGE);
  } catch {
    return null;
  }
}

/** Whether the API-key backend is switched on. Before the switches existed a
 *  saved key with no other choice meant "use the key", so that carries over. */
function loadApiEnabled(): boolean {
  try {
    const saved = localStorage.getItem(API_ON_STORAGE);
    if (saved !== null) return saved === "1";
    const pref = legacyAiPref();
    return pref === "api" || (!pref && !!localStorage.getItem(KEY_STORAGE));
  } catch {
    return false;
  }
}
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
    enabled: false,
    catalog: null,
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
      Record<CliAgent, { consent?: unknown; model?: unknown; enabled?: unknown }>
    >;
    const pref = legacyAiPref();
    for (const agent of CLI_AGENTS) {
      const entry = saved[agent.id];
      if (!entry) continue;
      agents[agent.id].consent = entry.consent === true;
      agents[agent.id].model =
        typeof entry.model === "string" && entry.model ? entry.model : null;
      // Saved before the switches: on only if it was *the* chosen backend,
      // so nobody finds a second subscription quietly switched on.
      agents[agent.id].enabled =
        typeof entry.enabled === "boolean"
          ? entry.enabled
          : agents[agent.id].consent && pref === agent.id;
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
            { consent: a.consent, model: a.model, enabled: a.enabled },
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

/**
 * The canvas waiting for a dev server that can mount it, from entering a
 * project until its first ready URL. Module scope, deliberately not store
 * state — nothing renders it, and it is consumed exactly once.
 */
let pendingCanvas: SavedCanvas | null = null;

/** Remember the pages row for this project.
 *
 * Called from each gesture that changes it rather than from a subscription on
 * the store, because the one change that must *not* be remembered is the
 * pages row a dev-server restart clears: that is dedup deferring a reload of
 * the user's app, not the user closing anything. */
function rememberCanvas(s: AppState) {
  if (!s.project) return;
  saveCanvas(s.project.root, {
    routes: s.routes,
    selectedRoute: s.selectedRoute,
    sessionModes: s.sessionModes,
    heldRoutes: Object.keys(s.heldRoutes),
    offlineRoutes: Object.keys(s.offlineRoutes),
    positions: s.artboardPos,
  });
}

/** Where each open artboard sits on the canvas surface, for the current
 *  viewport — the one layout every consumer reads (canvas, markup, focus). */
export function artboardLayout(s: Pick<AppState, "routes" | "artboardPos" | "viewportId">) {
  const vp = VIEWPORTS.find((v) => v.id === s.viewportId) ?? VIEWPORTS[0];
  return layoutArtboards(s.routes, s.artboardPos[vp.id], vp.width, PAGE_GAP);
}

/** Remember this project's marks. Called from each gesture that changes them,
 * for the same reason the canvas is: a subscription would also fire for the
 * clear that happens when a project closes, which is dedup tidying up rather
 * than the user rubbing anything out. */
function rememberAnnotations(s: AppState) {
  if (!s.project) return;
  saveAnnotations(s.project.root, s.annotations);
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
function pendingNodeInfo(snippet: string, lang: SnippetLang): NodeInfo {
  const parsed = parseSimpleElement(snippet);
  if (!parsed) {
    // A pasted section rather than a palette element: a whole subtree, which
    // the single-element rewriter that folds edits into a staged snippet
    // cannot touch. Read-only with a reason until a save gives it real nodes
    // — the alternative is a style panel that accepts edits the save refuses.
    const tag = snippet.trim().match(/^<\s*([A-Za-z][\w.]*)/)?.[1] ?? "div";
    const unsaved = "this pasted section isn't saved yet — save to edit it";
    return {
      editable: false,
      className: null,
      reason: unsaved,
      line: 0,
      col: 0,
      tag,
      component: null,
      dynamic: null,
      core: null,
      parentIndex: null,
      canRemove: true,
      canMove: false,
      structuralReason: "this element isn't saved yet — save to move it",
      canAcceptChildren: false,
      canEditText: false,
      textReason: unsaved,
      text: null,
    };
  }
  const text = textOf(snippet);
  return {
    editable: true,
    // In the snippet's own spelling: a pasted one carries the class attribute
    // of the file it came from, and reading `className` off HTML markup
    // reports no classes for an element that plainly has some.
    className: classNameOf(snippet, lang),
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

/** Live timer behind `setNotice` — module scope, because nothing renders it. */
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Capture one element as a clip, for a copy, a cut or a park.
 *
 * A copied section needs the same two renderings a palette entry has, and they
 * come from the two places that actually know: the *source* from the
 * write-back, because the file is the truth about what a paste will write, and
 * the *picture* from the overlay, because only the page knows what that source
 * rendered as. Deriving one from the other would mean shipping a JSX renderer
 * into the overlay — the same reason the palette writes both by hand.
 *
 * Which also means the copy is what the file says, not what the screen shows.
 * Staged edits inside the copied section are not in it, and that difference is
 * said out loud rather than papered over.
 *
 * This captures any element on the canvas — the selection (⌘C/⌘X) or one
 * being dragged off its page, which is not necessarily selected. `unsaved`
 * counts the staged edits inside it that the clip does not carry.
 */
async function captureClip(
  get: () => AppState,
  dedupId: string,
  element: { component: string | null; tag: string },
): Promise<{ clip: Omit<Clipboard, "cut">; unsaved: number } | { error: string }> {
  const { project, actions } = get();
  const preview = await requestElementHtml(dedupId);
  if (!preview) return { error: "Couldn't read that element from the canvas." };

  // A staged insert has no node in any file — its snippet *is* its source, so
  // the edits made to it since have to be folded in exactly as a save would.
  const staged = pendingInsert(actions, dedupId);
  if (staged) {
    let snippet = staged.snippet;
    const className = stagedValue(actions, "class", staged.id);
    const text = stagedValue(actions, "text", staged.id);
    if (className !== null) {
      snippet = withAttr(snippet, classAttrFor(staged.lang), className) ?? snippet;
    }
    if (text !== null) snippet = withText(snippet, text) ?? snippet;
    return {
      clip: {
        snippet,
        lang: staged.lang,
        preview,
        label: staged.label,
        file: staged.target.file,
        refs: [],
      },
      unsaved: 0,
    };
  }

  const target = targetOf(dedupId);
  if (!target || !project) return { error: "That element can't be copied." };
  const result = await copyElement(project.root, target.file, target.index).catch(
    (e) => ({ ok: false, error: String(e instanceof Error ? e.message : e) }) as const,
  );
  if (!result.ok || !("snippet" in result) || !result.snippet || !result.lang) {
    return { error: ("error" in result && result.error) || "That element can't be copied." };
  }

  // Ordinals the copy swallowed, from the same parse that produced it — an
  // exact answer to "is there staged work in here?", which the DOM cannot give
  // (an element staged for deletion is already off the screen but still in the
  // file, and therefore still in the copy).
  const inside = new Set(result.contains ?? [target.index]);
  const unsaved = actions.filter(
    (a) => a.target.file === target.file && inside.has(a.target.index),
  ).length;
  return {
    clip: {
      snippet: result.snippet,
      lang: result.lang,
      preview,
      label: labelOfElement(element),
      file: target.file,
      refs: result.refs ?? [],
    },
    unsaved,
  };
}

/**
 * Stage a paste of `clip` at `target`/`position` — what ⌘V, dropping a
 * parked piece and dragging between artboards all go through, so every way of
 * putting markup somewhere obeys the same rules. Returns the pending insert's
 * id, or null when it was refused (and the notice says why).
 */
async function stagePaste(
  get: () => AppState,
  clip: Omit<Clipboard, "cut">,
  target: EditTarget,
  position: DropPosition,
  verb: string,
  gesture?: string,
): Promise<string | null> {
  const { project } = get();
  // One language per file, and no translation exists for an arbitrary
  // subtree — see SnippetLang. Refused here, where the user can still see
  // what they aimed at, rather than at save time.
  const destLang = isHtmlFile(target.file) ? "html" : "jsx";
  if (clip.lang !== destLang) {
    get().setNotice(
      destLang === "html"
        ? "That came from a React component — this page is plain HTML."
        : "That came from an HTML page — this file is a React component.",
    );
    return null;
  }

  // Names the snippet reads but does not carry: a `<Card title={title} />`
  // needs both wherever it lands. dedup cannot resolve bindings from here,
  // so it asks the one question it can answer for certain — does the
  // destination file mention this name at all? A no is proof; a yes proves
  // nothing and is left alone. Said out loud rather than refused, because
  // the paste is staged and undoable and the user can see the result.
  let missing: string[] = [];
  if (clip.refs.length > 0 && project && target.file !== clip.file) {
    try {
      const code = await readSource(project.root, target.file);
      missing = clip.refs.filter(
        (name) => !new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(code),
      );
    } catch {
      // Couldn't read it — say nothing rather than guess.
    }
  }

  const id = `${PENDING_PREFIX}${crypto.randomUUID()}`;
  if (
    !get().stage({
      kind: "insert",
      id,
      target,
      position,
      snippet: clip.snippet,
      lang: clip.lang,
      preview: clip.preview,
      label: clip.label,
      gesture,
    })
  ) {
    // Refused — the anchor is on its way out. Whatever was being pasted keeps
    // its contents, so it can be put somewhere that still exists.
    return null;
  }
  get().setNotice(
    missing.length > 0
      ? `${verb} ${clip.label} — but ${target.file.split("/").pop()} has no ${missing
          .slice(0, 3)
          .join(", ")}, so it won't build until you add ${missing.length === 1 ? "it" : "them"}.`
      : `${verb} ${clip.label}.`,
  );
  return id;
}

/** Where a drop next to `id` lands in source. A pending insert has no node of
 *  its own to aim at, so a drop beside one reuses the anchor it used — the
 *  same rule as pasting twice in a row. */
function dropAnchor(
  actions: EditAction[],
  id: string,
  position: DropPosition,
): { target: EditTarget; position: DropPosition } | null {
  const staged = pendingInsert(actions, id);
  if (staged) return { target: staged.target, position: staged.position };
  const target = targetOf(id);
  return target ? { target, position } : null;
}

/** Stage the removal of one element by id (selected or not). Returns whether
 *  it was staged. A selection on it is dropped, since it leaves the canvas. */
function stageRemoval(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  dedupId: string,
  label: string,
  gesture?: string,
): boolean {
  const target = targetOf(dedupId);
  if (!target) return false;
  if (!get().stage({ kind: "remove", target, label, gesture })) return false;
  if (get().selected?.dedupId === dedupId) {
    set({ selected: null, sourceInfo: null });
    sendToOverlay({ type: "clear" });
  }
  return true;
}

/** How a capture reads in a notice: what it was, and what it leaves behind. */
function captureNotice(verb: string, label: string, unsaved: number): string {
  return unsaved > 0
    ? `${verb} ${label} as it is saved — ${unsaved} unsaved edit${
        unsaved === 1 ? "" : "s"
      } inside it ${unsaved === 1 ? "isn't" : "aren't"} included.`
    : `${verb} ${label}.`;
}

/**
 * The copy that both ⌘C and ⌘X go through: capture the selection onto
 * dedup's clipboard. Returns whether anything was copied — a cut only deletes
 * if it did.
 */
async function copyToClipboard(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  cut: boolean,
): Promise<boolean> {
  const { selected } = get();
  if (!selected) {
    get().setNotice("Select something on the canvas first.");
    return false;
  }
  const captured = await captureClip(get, selected.dedupId, selected);
  if ("error" in captured) {
    get().setNotice(captured.error);
    return false;
  }
  set({ clipboard: { ...captured.clip, cut } });
  get().setNotice(captureNotice(cut ? "Cut" : "Copied", captured.clip.label, captured.unsaved));
  return true;
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

/** An agent the user has connected (a live round-trip, not just installed) —
 *  the only kind a message may be sent to, by mention or by default. */
function agentConnected(state: AppState, agent: CliAgent): boolean {
  return agentOn(state.agents[agent]);
}

/** The connected agent that can generate images on another's behalf, if any.
 *  First in CLI_AGENTS order, so the answer is stable rather than whichever
 *  was connected last. */
function imageAgent(state: AppState): CliAgent | null {
  return (
    CLI_AGENTS.find((a) => a.generatesAssets && agentConnected(state, a.id))?.id ??
    null
  );
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
  textEditing: null,
  textToolSticky: false,
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
  offlineRoutes: {},
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
  annotations: [],
  annotateKind: "ellipse",
  annotateColor: PENS[0],
  noteEditing: null,
  clipboard: null,
  saving: false,
  lastSave: null,
  directWriteOk: false,
  directWritePrompt: null,
  saveError: null,
  notice: null,

  sidebarTab: "layers",
  inspectorTab: "design",
  chatSessions: [],
  activeChatId: null,
  chatBusy: false,
  chatActivity: null,
  pendingEdit: null,
  scanning: false,
  scanProgress: null,
  scanResult: null,
  driftRunning: false,
  driftProgress: null,
  driftResult: null,
  driftError: null,
  openDriftId: null,
  driftSelection: {},
  driftZoom: 1,
  driftPan: { x: 120, y: 96 },
  driftProposal: null,
  driftProposing: false,
  driftProposalError: null,
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
  apiEnabled: loadApiEnabled(),
  settingUpGit: false,
  exporting: null,
  exportNotice: null,
  parked: [],
  dragOut: null,
  artboardPos: {},
  panelWidths: loadPanelWidths(),

  merge: null,
  history: [],
  historyOpen: false,
  trash: [],

  enterEditor: (project, git, customCommand = null) => {
    // Parked canvas pieces come back too — after the reset below has cleared
    // the last project's, and only into the project that asked for them.
    void loadParked(project.root)
      .then((raw) => {
        if (useStore.getState().project?.root === project.root) {
          parkedLoaded = project.root;
          useStore.setState({ parked: sanitizeParked(raw) });
        }
      })
      .catch(() => {});
    // Past chats come back with the project; land on the most recent one.
    const chatSessions = loadChatSessions(project.root);
    // So does the canvas — but it cannot be mounted until there is a dev
    // server to mount it against, so it waits for the ready URL.
    pendingCanvas = loadCanvas(project.root);
    set({
      // Nothing is mounted until the user picks a page, so Pages is the only
      // tab with anything to act on — land there rather than on empty Layers.
      sidebarTab: "pages",
      inspectorTab: "design",
      chatSessions,
      activeChatId: chatSessions[chatSessions.length - 1]?.id ?? null,
      chatBusy: false,
      chatActivity: null,
      parked: [],
      dragOut: null,
      artboardPos: {},
      pendingEdit: null,
      scanning: false,
      scanProgress: null,
      scanResult: null,
      driftRunning: false,
      driftProgress: null,
      driftResult: null,
      driftError: null,
      openDriftId: null,
      driftSelection: {},
      driftZoom: 1,
      driftPan: { x: 120, y: 96 },
      driftProposal: null,
      driftProposing: false,
      driftProposalError: null,
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
      // Per-project: one project's artboard choices must not leak into the
      // next one opened — every project has a "/" for them to land on.
      frameOrigins: {},
      sessionModes: {},
      heldRoutes: {},
      offlineRoutes: {},
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
      textEditing: null,
      textToolSticky: false,
      selected: null,
      sourceInfo: null,
      actions: [],
      redoStack: [],
      draggingId: null,
      insertKind: null,
      // Marks come back with the project — they are notes about pages, and
      // the pages are about to be restored under them.
      annotations: loadAnnotations(project.root),
      noteEditing: null,
      // A copied snippet is a piece of one project's source; carrying it into
      // another one would paste markup from a codebase that isn't open.
      clipboard: null,
      lastSave: null,
      directWriteOk: false,
      directWritePrompt: null,
      saveError: null,
      notice: null,
      merge: null,
      history: [],
      historyOpen: false,
      trash: [],
    });
  },

  backToLaunch: () => {
    // A previewed edit is uncommitted work the user never accepted. Closing
    // the project is not a decision to keep it, so it comes back off first.
    const { project, pendingEdit } = get();
    // Leaving before the dev server ever came up: the remembered canvas stays
    // on disk for the next open, but nothing is left waiting to mount it.
    pendingCanvas = null;
    if (project && pendingEdit) void revertPreview(project.root, pendingEdit);
    set({
      sidebarTab: "pages",
      chatSessions: [],
      activeChatId: null,
      chatBusy: false,
      chatActivity: null,
      parked: [],
      dragOut: null,
      artboardPos: {},
      pendingEdit: null,
      scanning: false,
      scanProgress: null,
      scanResult: null,
      driftRunning: false,
      driftProgress: null,
      driftResult: null,
      driftError: null,
      openDriftId: null,
      driftSelection: {},
      driftZoom: 1,
      driftPan: { x: 120, y: 96 },
      driftProposal: null,
      driftProposing: false,
      driftProposalError: null,
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
      // Per-project: one project's artboard choices must not leak into the
      // next one opened — every project has a "/" for them to land on.
      frameOrigins: {},
      sessionModes: {},
      heldRoutes: {},
      offlineRoutes: {},
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
      annotations: [],
      noteEditing: null,
      // A copied snippet is a piece of one project's source; carrying it into
      // another one would paste markup from a codebase that isn't open.
      clipboard: null,
      lastSave: null,
      directWriteOk: false,
      directWritePrompt: null,
      saveError: null,
      notice: null,
    });
  },

  setDevStatus: (devStatus) => set({ devStatus }),

  setInstrumentation: (instrumentation) => set({ instrumentation }),

  setDevReady: (url, port) => {
    // The first ready URL after opening a project is the one moment the
    // remembered canvas can be mounted; a restart later in the session is
    // not, so it is consumed here rather than read.
    const restore = pendingCanvas;
    pendingCanvas = null;
    set({
      devStatus: "ready",
      devUrl: url,
      devPort: port,
      crashed: false,
      // A restart clears the pages row rather than re-mounting what was
      // open: the artboards are the user's choice, and silently reloading
      // three frames of their app is the thing this defers. Reopening the
      // project is the exception — the choice was already made, and dedup
      // asking for it again every morning is the same thing from the other
      // side.
      routes: restore?.routes ?? [],
      artboardPos: restore?.positions ?? {},
      detectedRoutes: null,
      pageHeights: {},
      layers: {},
      pageMeta: null,
      // A restart rebuilds the pages row — the old selection may be gone.
      selectedRoute: restore?.selectedRoute ?? null,
      // Restored with the artboards they belong to, and cleared with them:
      // an entry keyed to a route that is no longer on the canvas is a stale
      // choice waiting to surprise whoever opens that page next.
      sessionModes: restore?.sessionModes ?? {},
      heldRoutes: Object.fromEntries(
        (restore?.heldRoutes ?? []).map((r) => [r, true as const]),
      ),
      offlineRoutes: Object.fromEntries(
        (restore?.offlineRoutes ?? []).map((r) => [r, true as const]),
      ),
      // Whichever origin the last run's frames drifted onto, this run starts
      // every artboard on the shared session and lets the fallback decide.
      frameOrigins: {},
    });
    // Land on the artboard they were working on. Restoring the row without
    // this leaves the canvas panned at the origin, which for a row of five
    // reads as "it didn't remember" no matter how much of it is mounted.
    const landing = restore?.selectedRoute ?? restore?.routes[0];
    if (landing) get().focusRoute(landing);
  },

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
    const { errors } = get();
    if (errors.length === 0) return;
    // Deliberately not gated on a selection. A build error is the case where
    // there is least likely to be one — the page didn't compile, so there may
    // be nothing on the canvas to click. The agent finds the file itself.
    set({ inspectorTab: "chat" });
    void get().sendChat(
      `The dev server reports this build error. Find the cause and fix it — read the files named in the error before quoting them:\n\n${errors
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
    // Annotate clears it for the mirror-image reason: its capture layer sits
    // over the frames, so the selection box and its resize grips would still
    // be drawn on an element no gesture can reach any more.
    if (tool === "browse" || tool === "annotate") get().clearSelection();
    // A note left open belongs to the tool that opened it.
    if (tool !== "annotate" && get().noteEditing) set({ noteEditing: null });
    // Leaving the text tool takes the caret off the canvas with it; a caret
    // still blinking in a page you are now panning is a lie about the mode.
    if (tool !== "text" && get().textEditing) {
      sendToOverlay({ type: "text-edit-end" });
    }
    sendToOverlay({ type: "set-mode", mode: tool === "browse" ? "browse" : "inspect" });
    // Dragging elements belongs to the select tool: the hand tool pans and
    // browse hands the page back to the app.
    sendToOverlay({
      type: "set-edit-mode",
      drag: tool === "select",
      insert: false,
    });
    set({
      tool,
      // Chosen here means chosen on purpose (the T button or shortcut), so
      // the tool stays put once an edit ends. `requestTextEdit` sets this
      // false for the double-click path, which borrows the tool for one edit.
      textToolSticky: tool === "text",
      insertKind: tool === "select" ? get().insertKind : null,
    });
    // In the text tool a selection *is* an edit request, so entering it with
    // something already selected puts the caret straight in.
    if (tool === "text") {
      const id = get().selected?.dedupId;
      if (id) void get().requestTextEdit(id);
    }
  },

  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),

  setPan: (pan) => set({ pan }),

  setZoomPan: (zoom, pan) => set({ zoom: clampZoom(zoom), pan }),

  visitRoute: (path) => {
    set((s) =>
      s.routes.includes(path) || s.routes.length >= MAX_ARTBOARDS
        ? {}
        : { routes: [...s.routes, path] },
    );
    rememberCanvas(get());
  },

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
      // Its place on the canvas too, in every viewport: reopened later, it
      // joins the end of the layout rather than reclaiming a spot that the
      // pages around it may since have moved into.
      artboardPos: Object.fromEntries(
        Object.entries(s.artboardPos).map(([vp, byRoute]) => [vp, drop(byRoute)]),
      ),
      pageHeights: drop(s.pageHeights),
      pagePaths: drop(s.pagePaths),
      layers: drop(s.layers),
      frameOrigins: drop(s.frameOrigins),
      sessionModes: drop(s.sessionModes),
      heldRoutes: drop(s.heldRoutes),
      offlineRoutes: drop(s.offlineRoutes),
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

    rememberCanvas(get());

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
    // Same clearance the initial pan uses: the focused artboard has to land
    // beside the floating sidebar and below the top bar, not under them —
    // wherever the user has put it.
    const at = artboardLayout(s)[path] ?? { x: 0, y: 0 };
    set({
      pan: { x: -at.x * s.zoom + 232, y: 120 - at.y * s.zoom },
    });
    rememberCanvas(get());
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
        const res = await detectRoutesFromSource(project.root, project.framework);
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
    rememberCanvas(get());
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
      rememberCanvas(get());
      return;
    }
    // Holding has to be armed before the app boots, so it rides in on the
    // frame's URL and takes effect on the reload that flag causes.
    held[route] = true;
    set({ heldRoutes: held });
    rememberCanvas(get());
  },

  toggleOffline: (route) => {
    const offline = { ...get().offlineRoutes };
    if (offline[route]) delete offline[route];
    else offline[route] = true;
    // Both directions reload, and both have to: the cut is installed before
    // the app boots, so it can neither be added nor taken away from a page
    // that is already running. React re-points the frame when the flag on its
    // URL changes — the reload *is* the mechanism, not a side effect of it.
    set({ offlineRoutes: offline });
    rememberCanvas(get());
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

  setSelectedRoute: (selectedRoute) => {
    set({ selectedRoute });
    rememberCanvas(get());
  },

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
          "No AI backend is on — switch one on in the AI menu (top bar), or write the seed by hand.",
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
    if (needsDirectWriteWarning(set, get, [codePanel.file], () => void get().saveCode())) {
      return;
    }
    set({ codePanel: { ...codePanel, saving: true, error: null } });
    try {
      // Same gate as the AI chat's writes: the sidecar re-parses strictly and
      // refuses anything that doesn't, so a half-typed edit can't land.
      const res = await writeSource(project.root, codePanel.file, codePanel.draft);
      if (!res.ok) throw new Error(res.error ?? "the file could not be written");
      const { hash, direct } = await commitOrDirect(
        get,
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
      set({ lastSave: { branch: "", hash, direct } });
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
    // Re-selecting what is already selected must not restart the inspect.
    // The two clicks of a double-click both select, and throwing away an
    // in-flight answer on the second one is exactly how the double-click used
    // to lose its race. (A save clears the selection, so nothing stale
    // survives here.)
    const current = get();
    if (
      selected &&
      current.selected?.dedupId === selected.dedupId &&
      (current.sourceInfo !== null || sourceInfoPending?.id === selected.dedupId)
    ) {
      set({ selected });
      return;
    }
    sourceInfoPending = null;
    set({ selected, sourceInfo: null });
    if (!selected) return;
    // A staged insert has no file to ask — its snippet is the source of truth.
    const insert = pendingInsert(get().actions, selected.dedupId);
    if (insert) {
      set({ sourceInfo: pendingNodeInfo(insert.snippet, insert.lang) });
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
    const inspecting = inspectElement(root, target.file, target.index)
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
    // Held so `requestTextEdit` can await the answer instead of giving up on
    // it — the whole difference between a double-click that edits text and
    // one that edits text about half the time.
    sourceInfoPending = { id: selected.dedupId, done: inspecting };
    // In the text tool a selection *is* an edit request: one click puts the
    // caret in, the way the tool advertises.
    if (get().tool === "text") void get().requestTextEdit(selected.dedupId);
  },

  clearSelection: () => {
    // A caret on the canvas is part of the selection, and the overlay's own
    // `clear` does not touch it — nor does the iframe losing focus, which
    // only ends drags. Left behind, the element stays contenteditable while
    // the editor believes nothing is selected.
    if (get().textEditing !== null) sendToOverlay({ type: "text-edit-end" });
    sendToOverlay({ type: "clear" });
    sourceInfoPending = null;
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
    // The one gate on what may be staged. It lives here because every action
    // arrives through this function, and a program is only ever invalid as a
    // *combination* — the action being added is fine on its own, it is the
    // company it would keep that the write-back would refuse.
    const conflict = stagingConflict(actions, action);
    if (conflict) {
      get().setNotice(conflict);
      return false;
    }
    const top = actions[actions.length - 1];
    const merges = top !== undefined && collapse !== undefined && collapse(top);
    const next = merges ? [...actions.slice(0, -1), action] : [...actions, action];
    set({ actions: next, redoStack: [] });
    syncCanvas(next);
    return true;
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

  resizeSelected: (width, height, group) => {
    const { selected, sourceInfo, actions } = get();
    // Same gate as every other class edit — and the overlay already refuses to
    // show grips here, so this is the second line of defence rather than the
    // first.
    if (!selected || !sourceInfo?.editable) return;

    const current =
      stagedValue(actions, "class", selected.dedupId) ?? sourceInfo.className ?? "";
    let tokens = toTokens(current);
    // Only the axes the grip actually drags: a side handle must not pin the
    // dimension it never touched, which would freeze a content-sized element
    // at whatever height it happened to have.
    if (width !== null) tokens = setKnob(tokens, KNOBS.width, sizeClass("w", width));
    if (height !== null) tokens = setKnob(tokens, KNOBS.height, sizeClass("h", height));
    get().applyClassEdit(fromTokens(tokens), group);
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
    if (
      !get().stage({
        kind: "remove",
        target,
        label: labelOfElement(selected),
      })
    ) {
      // Refused — something staged is anchored to this element. It is still
      // on the canvas, so the selection stays on it and the notice says what
      // is in the way.
      return;
    }
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
      // A refusal, not a failed save — `saveError` renders as "Save failed —
      // retry", which is the wrong thing to say about a drag that never
      // started. (Copy and paste it, though: that crosses files fine.)
      get().setNotice(
        `Can't move between files — that element lives in ${from.file}, the drop target in ${to.file}. Copy and paste it instead.`,
      );
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
    const staged = get().stage({
      kind: "insert",
      id,
      target,
      position,
      snippet: entry.snippet,
      lang: "jsx",
      preview: entry.preview,
      label: entry.label,
    });
    // Through the setter, not set(): the overlay has to be told to stop
    // waiting for a placement click, or it swallows the next selection.
    get().setInsertKind(null);
    // Select what was just placed — but only if it was. Selecting a pending
    // id that never entered the program would point the inspector at nothing.
    if (staged) get().selectById(id);
  },

  copySelected: async () => {
    await copyToClipboard(get, set, false);
  },

  /**
   * Cut: the copy has to succeed before the delete is staged, or the section
   * is gone and on no clipboard.
   */
  cutSelected: async () => {
    const selected = get().selected;
    if (!selected) {
      get().setNotice("Select something on the canvas first.");
      return;
    }
    // Whether it may be deleted comes from the write-back, and that answer can
    // still be in flight right after a click — awaiting it is the same fix
    // double-click-to-edit needed. Asked *before* the copy so a cut that will
    // not delete never says it cut anything.
    const info = await sourceInfoFor(get, selected.dedupId);
    if (!info?.canRemove) {
      get().setNotice(info?.structuralReason ?? "This element can't be cut.");
      return;
    }
    if (!(await copyToClipboard(get, set, true))) return;
    get().removeSelected();
  },

  pasteClipboard: async () => {
    const { clipboard, selected, sourceInfo, actions } = get();
    if (!clipboard) {
      get().setNotice("Nothing to paste — copy something on the canvas first.");
      return;
    }
    if (!selected) {
      get().setNotice("Select where to paste — the copy lands next to it.");
      return;
    }

    // Where it goes. A sibling *after* the selection is what a paste means
    // most of the time (it is the duplicate gesture), but not everything has
    // a sibling to be: a component's root element and <body> would put the
    // copy somewhere the file cannot express, so those take it as a child.
    let target: EditTarget | null;
    let position: DropPosition;
    const staged = pendingInsert(actions, selected.dedupId);
    if (staged) {
      // Pasting again right after a paste: the selection is the element the
      // last one put down, which has no node in the file to aim at. Reuse the
      // anchor it used, so repeated pastes pile up as siblings.
      target = staged.target;
      position = staged.position;
    } else {
      target = targetOf(selected.dedupId);
      if (!target) return;
      // The write-back's own report, awaited: right after a click it can still
      // be in flight, and reading a null would refuse a paste that is fine.
      const info = sourceInfo ?? (await sourceInfoFor(get, selected.dedupId));
      const sibling =
        info !== null && info.parentIndex !== null && info.core === null;
      position = sibling ? "after" : "inside";
      if (!sibling && !(info?.canAcceptChildren ?? false)) {
        get().setNotice(
          info?.structuralReason ??
            "There's nowhere to put it here — select the element it should sit next to.",
        );
        return;
      }
    }

    const id = await stagePaste(get, clipboard, target, position, "Pasted");
    if (id) get().selectById(id);
  },

  setNotice: (message) => {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    set({ notice: message });
    if (message === null) return;
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      // Only if it is still the same message — a newer one owns the slot.
      if (useStore.getState().notice === message) useStore.setState({ notice: null });
    }, 6000);
  },

  setDragging: (draggingId) => set({ draggingId }),

  /**
   * The caret landed on, or left, an element on the canvas — reported by the
   * overlay, which is the only side that knows.
   *
   * The tool follows the caret rather than the other way round: whatever put
   * it there (a double-click, the T tool, selecting while in it), the mode
   * shown is the mode the canvas is actually in. That also keeps the two
   * paths from calling each other — `setTool` starts an edit, and if starting
   * an edit went back through `setTool` they would bounce.
   */
  setTextEditing: (textEditing) => {
    const { textToolSticky, tool } = get();
    set({ textEditing });
    if (textEditing !== null) {
      if (tool !== "text") {
        // Entered by typing into something, not by choosing the tool — so it
        // is borrowed for this one edit (see `textToolSticky`). Set directly
        // rather than through setTool, which would mark it chosen and
        // re-request the edit that is already underway.
        sendToOverlay({ type: "set-edit-mode", drag: false, insert: false });
        set({ tool: "text", textToolSticky: false, insertKind: null });
      }
      return;
    }
    // Caret gone. A borrowed tool goes back; a chosen one stays, so the next
    // click edits the next thing.
    if (tool === "text" && !textToolSticky) get().setTool("select");
  },

  requestTextEdit: async (dedupId) => {
    // The double-click's own clicks have already selected this element, but
    // *whether its text may be edited* comes from the write-back, and that
    // answer is usually still in flight when `dblclick` fires. Waiting for it
    // is the whole fix: reading `sourceInfo` and giving up on a null is what
    // made this gesture work only sometimes.
    if (get().selected?.dedupId !== dedupId) {
      // Selection never landed (a Layers row, a stale id) — point the canvas
      // at it; the selection that follows re-enters here in the text tool.
      sendToOverlay({ type: "select-id", id: dedupId });
      return;
    }
    const info = await sourceInfoFor(get, dedupId);
    // Refused: the element is selected, so the Inspector is already showing
    // `textReason`. Entering a text mode that could not type would be the
    // dishonest part.
    if (!info?.canEditText) return;
    if (get().selected?.dedupId !== dedupId) return; // moved on while waiting
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

  setAnnotateKind: (annotateKind) => set({ annotateKind }),

  setAnnotateColor: (annotateColor) => set({ annotateColor }),

  addAnnotation: (a) => {
    set((s) => ({
      annotations:
        s.annotations.length >= MAX_ANNOTATIONS
          ? s.annotations
          : [...s.annotations, a],
      // Straight into the note: the mark and the words are one thought, and
      // an empty shape is a pointer at nothing.
      noteEditing: a.id,
    }));
    rememberAnnotations(get());
  },

  setNote: (id, note) => {
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, note: note.slice(0, MAX_NOTE) } : a,
      ),
    }));
    rememberAnnotations(get());
  },

  setNoteEditing: (noteEditing) => set({ noteEditing }),

  removeAnnotation: (id) => {
    set((s) => ({
      annotations: s.annotations.filter((a) => a.id !== id),
      noteEditing: s.noteEditing === id ? null : s.noteEditing,
    }));
    rememberAnnotations(get());
  },

  resyncCanvas: () => syncCanvas(get().actions),

  revertAction: (index) => {
    const { actions } = get();
    if (index < 0 || index >= actions.length) return;
    // Takes any edit made to a discarded insert with it — see withoutAction.
    // Leaving one behind produced a program that could never be saved and
    // never be escaped, since the chat also refuses while edits are staged.
    const next = withoutAction(actions, index);
    set({ actions: next, redoStack: [] });
    syncCanvas(next);
  },

  discardAllEdits: () => {
    if (get().actions.length === 0) return;
    // Nothing here was ever written, so there is nothing to put back — the
    // staged program only ever existed in memory and on the canvas.
    set({
      actions: [],
      redoStack: [],
      saveError: null,
      selected: null,
      sourceInfo: null,
    });
    syncCanvas([]);
    sendToOverlay({ type: "clear" });
    // Staged structural edits were previewed by moving real nodes around;
    // the reload is what puts the page back to what the file actually says.
    sendToOverlay({ type: "reload" });
    get().setNotice("Staged edits discarded.");
  },

  undo: () => {
    const step = undoStep(get().actions, get().redoStack);
    if (!step) return;
    set({ actions: step.actions, redoStack: step.redo });
    syncCanvas(step.actions);
  },

  redo: () => {
    const step = redoStep(get().actions, get().redoStack);
    if (!step) return;
    set({ actions: step.actions, redoStack: step.redo });
    syncCanvas(step.actions);
  },

  saveAll: async () => {
    const { project, actions, saving } = get();
    if (!project || saving) return;
    // A class edit scrubbed back to where it started is not a change.
    const dirty = actions.filter(
      (a) => !isValueAction(a) || a.before !== a.after,
    );
    if (dirty.length === 0) return;
    if (
      needsDirectWriteWarning(set, get, dirty.map((a) => a.target.file), () =>
        void get().saveAll(),
      )
    ) {
      return;
    }

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
        const { ops, failures } = opsForFile(group, file);
        // A staged edit that cannot be expressed is a refusal, not something
        // to drop quietly on the way to disk.
        if (failures.length > 0) throw new Error(failures.join("; "));
        const res = await applyEdits(project.root, file, ops);
        if (!res.ok) throw new Error(res.error ?? `write failed for ${file}`);
      }

      const message = `dedup: ${describeProgram(dirty)}`;
      const saved = await commitOrDirect(get, project.root, message, [...byFile.keys()]);

      syncCanvas([]);
      set({
        actions: [],
        redoStack: [],
        lastSave: saved,
        // In the same update as the program emptying: settled afterwards,
        // the reconcile would see every removal gone and drop the pieces —
        // which by now are the only copy (see lib/parking).
        parked: settleParked(get().parked),
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

  /**
   * One instruction through the chat agent.
   *
   * A canvas selection is context, not a precondition. With one, its file goes
   * in with the element pointed at; with none, the project inventory goes in
   * and the model finds its own way with read/grep/list — the same loop, the
   * same protocol, the same review at the end.
   *
   * Nothing here writes. The turn ends with a *proposal*: the files the model
   * would change, as a diff the user accepts or rejects. Only `acceptChatEdit`
   * reaches the parse-gated write-back and the session branch.
   */
  sendChat: async (instruction) => {
    const { project, selected, chatBusy } = get();
    const text = instruction.trim();
    if (!project || !text || chatBusy) return;
    // `@claude` / `@codex` sends this one message to that agent — both can be
    // connected, so who answers is a property of the message rather than a
    // mode to flip. The mention is the user's words (kept in the transcript)
    // but not the model's instruction (taken out of the prompt).
    const { agent: mentioned, instruction: ask } = routeMention(text);
    if (!ask) return; // a bare "@codex" asks nothing

    // Who is answering this turn, stamped on every reply it produces. Set once
    // the backend is known; the user's own message never carries it.
    let by: CliAgent | "api" | undefined;

    // Append to the active session, materializing a new one on first use.
    // Returns the message's id so a proposal can be resolved onto it later.
    const push = (m: Omit<ChatMessage, "id">): string => {
      if (m.role === "assistant" && by) m = { ...m, agent: by };
      const messageId = crypto.randomUUID();
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
            ? { ...x, messages: [...x.messages, { id: messageId, ...m }] }
            : x,
        );
        if (s.project) saveChatSessions(s.project.root, sessions);
        return { chatSessions: sessions, activeChatId: id };
      });
      return messageId;
    };

    // A mention picks the agent; without one, the top-bar default answers.
    const kind = mentioned ?? get().activeAiBackend();
    const agentLabel = (k: CliAgent | "api") =>
      k === "api" ? "Claude (API key)" : (CLI_AGENTS.find((a) => a.id === k)?.label ?? k);

    // Conversation memory: prior turns of this session (texts only — files
    // always go in fresh), captured before this message lands. A reply some
    // *other* agent wrote is labelled as such: the transcript otherwise hands
    // it over as "You:", and a model defending a choice it never made is
    // worse at the follow-up than one that knows a colleague made it.
    const active = get().chatSessions.find((x) => x.id === get().activeChatId);
    const history: ChatTurn[] = (active?.messages ?? [])
      .filter((m) => !m.error)
      .slice(-12)
      .map((m) => ({
        role: m.role,
        text:
          m.role === "assistant" && m.agent && kind && m.agent !== kind
            ? `(${agentLabel(m.agent)}, another assistant in this chat, replied:) ${m.text}`
            : m.text,
      }));

    const src = selected ? targetOf(selected.dedupId) : null;
    push({
      role: "user",
      text,
      target:
        selected && src
          ? { label: selected.component ?? selected.tag, file: src.file }
          : undefined,
    });

    // A mention is a request for that agent specifically, so it is answered
    // by that agent or not at all — quietly handing the message to the
    // default instead would be the silent backend the AI switch exists to
    // rule out.
    if (mentioned && !agentConnected(get(), mentioned)) {
      push({
        role: "assistant",
        error: true,
        text: `${agentLabel(mentioned)} is off — switch it on in the AI menu (top bar), then send again.`,
      });
      return;
    }
    by = kind ?? undefined;
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
        text: "No AI backend is on — switch one on in the AI menu (top bar).",
      });
      return;
    }

    // Everything dedup has read for this turn. It is also the *only* thing an
    // edit may quote: `applyProgram` refuses a block naming a file that isn't
    // in here, because a SEARCH the model wrote from memory is exactly what
    // the exact-match rule exists to catch.
    const sources = new Map<string, string>();
    const attachments: ChatAttachment[] = [];
    const toolTrace: string[] = [];

    /** A file dedup will not put in front of the model. Past this size the
     *  reply would be truncated somewhere in the middle, and a truncated
     *  source that got written would delete the rest of the file. */
    const MAX_CONTEXT_BYTES = 120_000;

    const runTool = async (call: ToolCall): Promise<string> => {
      try {
        if (call.tool === "list") {
          const r = await listProjectFiles(project.root);
          if (!r.ok || !r.files) return r.error ?? "listing failed";
          return r.files.join("\n");
        }
        if (call.tool === "grep") {
          const r = await grepProject(project.root, call.arg);
          if (!r.ok || !r.matches) return r.error ?? "grep failed";
          if (r.matches.length === 0) return "no matches";
          return (
            r.matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n") +
            (r.truncated ? "\n… (more matches not shown)" : "")
          );
        }
        const source = await readSource(project.root, call.arg);
        if (source.length > MAX_CONTEXT_BYTES) {
          return `${call.arg} is too large (${Math.round(source.length / 1024)}KB) for dedup to edit through chat. Work in a smaller file.`;
        }
        sources.set(call.arg, source);
        return `\`\`\`${isHtmlFile(call.arg) ? "html" : "tsx"}\n${source}\n\`\`\``;
      } catch (e) {
        return `cannot ${call.tool} ${call.arg}: ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    set({ chatBusy: true });
    // Say where the work is happening. A turn can take a minute, and the only
    // sign of it was a spinner in the chat panel — while the element the user
    // asked about sat on the canvas looking idle. With nothing selected there
    // is no section to mark, and the panel's own "Working…" is the whole
    // answer.
    sendToOverlay({ type: "set-busy", id: selected?.dedupId ?? null });
    try {
      let staleSelection = false;
      if (selected && src) {
        const source = await readSource(project.root, src.file);
        if (source.length <= MAX_CONTEXT_BYTES) {
          sources.set(src.file, source);
          // Stale-selection guard: edits since the selection can renumber the
          // file's elements. A stale id doesn't kill the turn any more — it
          // just stops being a pointer, and the model is told so rather than
          // being aimed at the wrong element.
          const live = await inspectElement(project.root, src.file, src.index);
          const fresh =
            live.ok &&
            (live.tag ?? "").toLowerCase() === selected.tag.toLowerCase();
          staleSelection = !fresh;
          attachments.push({
            file: src.file,
            source,
            element: fresh
              ? { selected, line: live.line ?? 0 }
              : undefined,
          });
        }
      }

      // With nothing selected the model starts from the project's own file
      // list rather than a blind grep — the cheapest way to make a cold
      // conversation land on the right file first time.
      const inventory =
        attachments.length === 0
          ? ((await listProjectFiles(project.root)).files ?? null)
          : null;

      // Only a CLI backend generates files, and only some of them do — a
      // model told about a directive dedup would refuse for it would reach
      // for it and then have to explain itself to the user. One that can't
      // is offered the next best thing when it exists: a connected agent that
      // can, asked on its behalf.
      const generates =
        backend.kind === "cli" &&
        (CLI_AGENTS.find((a) => a.id === backend.agent)?.generatesAssets ?? false);
      const painter = generates ? null : imageAgent(get());
      const system = systemPromptFor(
        attachments[0]?.file ?? null,
        project.framework === "static",
        generates,
        painter ? agentLabel(painter) : null,
      );
      let prompt = buildTurnPrompt({
        instruction: staleSelection
          ? `${ask}\n\n(The canvas selection is out of date — the file changed since the user clicked. Re-read the file above rather than trusting any line number.)`
          : ask,
        attachments,
        inventory,
        framework: project.framework,
        // Only marks on pages that are actually open: a note about a page the
        // user closed three sessions ago is not what they are pointing at now.
        notes: annotationNotes(get().annotations, get().routes),
      });
      let turns = history;
      let reply: ChatReply | null = null;

      for (let round = 0; ; round++) {
        const raw = await runChatPrompt(backend, prompt, turns, system);
        const parsed = parseChatReply(raw);
        if (parsed.kind !== "tools") {
          reply = parsed;
          break;
        }
        if (round >= MAX_TOOL_ROUNDS) {
          push({
            role: "assistant",
            error: true,
            tools: toolTrace,
            text: `Still looking for context after ${MAX_TOOL_ROUNDS} rounds — nothing was changed. Narrow the instruction, or select the element you mean on the canvas.`,
          });
          return;
        }
        const results: string[] = [];
        for (const call of parsed.calls) {
          toolTrace.push(call.tool === "list" ? "list" : `${call.tool} ${call.arg}`);
          results.push(
            formatToolResult(call.tool, call.arg, await runTool(call)),
          );
        }
        turns = [...turns, { role: "user", text: prompt }, { role: "assistant", text: raw }];
        prompt = results.join("\n\n");
      }

      const tools = toolTrace.length > 0 ? toolTrace : undefined;
      if (reply.kind === "answer") {
        push({ role: "assistant", text: reply.text, tools });
        return;
      }

      // Which file an unaddressed block belongs to: the selection's, or the
      // only one in play. With neither, an unaddressed block is refused.
      const fallback =
        attachments[0]?.file ??
        (sources.size === 1 ? [...sources.keys()][0] : null);

      let program: Map<string, string>;
      if (reply.kind === "file") {
        if (!fallback) {
          push({
            role: "assistant",
            error: true,
            tools,
            text: "The AI replied with a whole file but didn't say which one — nothing was changed. Try again, or select the element you mean.",
          });
          return;
        }
        program = new Map([[fallback, reply.content]]);
      } else {
        program = applyProgram(sources, reply.blocks, reply.creates, fallback);
      }

      const files = [...program]
        .map(([file, after]) => ({
          file,
          before: sources.get(file) ?? null,
          after,
        }))
        .filter((f) => f.before !== f.after);

      // Images the agent generated and wants placed in the project. They are
      // only ever a CLI backend's, and only from an agent that makes them —
      // the prompt never mentions the directive otherwise, so one appearing
      // anyway is a model going off script.
      const assets = reply.kind === "blocks" ? reply.assets : [];
      if (assets.length > 0 && backend.kind !== "cli") {
        push({
          role: "assistant",
          error: true,
          tools,
          text: "The AI tried to import a generated file, which this backend doesn't produce — nothing was changed.",
        });
        return;
      }
      // Images it asked another agent to generate. Answered only by a
      // connected agent that makes them; the prompt only offers the directive
      // when there is one, but the connection can change mid-turn.
      const images = reply.kind === "blocks" ? reply.images : [];
      const imagePainter = images.length > 0 ? imageAgent(get()) : null;
      if (images.length > 0 && !imagePainter) {
        push({
          role: "assistant",
          error: true,
          tools,
          text: "The AI asked for a generated image, but no connected agent can make one — connect Codex and ask again. Nothing was changed.",
        });
        return;
      }

      // A destination the same reply also writes as text is two answers to
      // one question; neither can be the right one. Checked on destinations,
      // before anything is generated, because generating is the slow part.
      const destinations = [...assets, ...images].map((a) => a.file);
      const clashing = destinations.find((d) => program.has(d));
      if (clashing) {
        push({
          role: "assistant",
          error: true,
          tools,
          text: `The AI tried to both write and import ${clashing} — nothing was changed.`,
        });
        return;
      }

      if (files.length === 0 && destinations.length === 0) {
        push({
          role: "assistant",
          tools,
          text: "No change needed — the project already matches that instruction.",
        });
        return;
      }


      // A file rewrite renumbers the ordinals this file's staged style edits
      // are addressed by. Checked here rather than before the prompt, because
      // until the model answers dedup doesn't know which files are in play —
      // and here rather than at Apply, because the preview writes.
      const touched = new Set(files.map((f) => f.file));
      const clash = get().actions.find((a) => touched.has(a.target.file));
      if (clash) {
        push({
          role: "assistant",
          error: true,
          tools,
          text: `${clash.target.file} has unsaved style edits. Save (⌘S) or discard them first — a chat edit would invalidate their positions.`,
        });
        return;
      }

      // Every import, and whose output it is. The agent matters: `asset.rs`
      // only fetches from *that agent's* output directory, so a delegated
      // image is checked exactly as if the user had asked that agent
      // directly — delegating adds a conversation, not a way in.
      // `delegated` marks a destination the requester named before the image
      // existed — the one case where the import may correct the extension.
      const imports: {
        file: string;
        source: string;
        agent: CliAgent;
        delegated: boolean;
      }[] = assets.map((a) => ({
        ...a,
        agent: (backend as { agent: CliAgent }).agent,
        delegated: false,
      }));
      if (imagePainter) {
        const name = agentLabel(imagePainter);
        for (const img of images) {
          toolTrace.push(`@${mentionAlias(imagePainter)} image ${img.file}`);
          set({ chatActivity: `${name} is generating ${img.file}…` });
          try {
            const raw = await agentPrompt(
              imagePainter,
              imageRequestPrompt(img.file, img.prompt),
              get().agents[imagePainter].model,
            );
            imports.push({
              file: img.file,
              source: pickGeneratedImage(raw),
              agent: imagePainter,
              delegated: true,
            });
          } catch (e) {
            push({
              role: "assistant",
              error: true,
              tools: [...toolTrace],
              text: `Asked ${name} for ${img.file}, but ${String(e instanceof Error ? e.message : e)} — nothing was changed.`,
            });
            return;
          } finally {
            set({ chatActivity: null });
          }
        }
      }

      // One unresolved proposal at a time. The new one was computed against
      // file contents the old one put on disk, so keeping both would mean
      // keeping one that is quietly wrong — and the old preview has to come
      // off the canvas before the new one goes on.
      const previous = get().pendingEdit;
      if (previous) {
        await revertPreview(project.root, previous);
        patchChatMessage(set, previous.messageId, { outcome: "superseded" });
      }

      const messageId = push({
        role: "assistant",
        text: reply.summary,
        // Read again rather than reusing `tools`: a delegated image added its
        // line to the trace after that was taken.
        tools: toolTrace.length > 0 ? [...toolTrace] : undefined,
        proposal: {
          files: [...files.map((f) => f.file), ...imports.map((a) => a.file)],
          summary: reply.summary,
        },
      });

      // Assets first, and this is the ordering that keeps the proposal
      // all-or-nothing across both kinds of write: an import is a new file, so
      // it can be taken back cleanly, while a text write that has landed
      // cannot be undone without the `before` snapshots this function is still
      // holding. So the fragile, gated half goes first and is unwound if the
      // rest fails.
      const imported: string[] = [];
      const undoImports = async () => {
        if (imported.length > 0) {
          await revertSources(
            project.root,
            imported.map((file) => [file, null] as [string, string | null]),
          ).catch(() => {});
        }
      };
      // The text the preview will write. Not `files` itself: a delegated image
      // that lands under a corrected name has its references renamed here.
      let toWrite = files;
      for (const a of imports) {
        try {
          const done = await importAgentAsset(
            project.root,
            a.agent,
            a.source,
            a.file,
            a.delegated,
          );
          imported.push(done.file);
          if (done.file !== a.file) {
            toWrite = retargetReferences(toWrite, a.file, done.file);
            a.file = done.file;
          }
        } catch (e) {
          await undoImports();
          patchChatMessage(set, messageId, { outcome: "rejected" });
          push({
            role: "assistant",
            error: true,
            text: `${String(e instanceof Error ? e.message : e)} — nothing was changed.`,
          });
          return;
        }
      }

      // Show it. A diff says what changed; the canvas says how it looks, and
      // looking is why dedup renders the app at all. The write is parse-gated
      // and uncommitted — Apply commits it, Discard puts the files back.
      const res = toWrite.length > 0
        ? await writeSources(
            project.root,
            toWrite.map((f) => [f.file, f.after] as [string, string]),
          )
        : { ok: true };
      if (!res.ok) {
        await undoImports();
        patchChatMessage(set, messageId, { outcome: "rejected" });
        push({
          role: "assistant",
          error: true,
          text: `${res.error ?? "write failed"} — nothing was changed.`,
        });
        return;
      }
      // A renamed image changes what the proposal names, so the message says
      // what is actually on disk rather than what was first asked for.
      if (imports.some((a) => a.delegated)) {
        patchChatMessage(set, messageId, {
          proposal: {
            files: [...toWrite.map((f) => f.file), ...imports.map((a) => a.file)],
            summary: reply.summary,
          },
        });
      }
      set({
        pendingEdit: {
          messageId,
          summary: reply.summary,
          files: toWrite,
          assets: imports.map(({ file, source, agent }) => ({ file, source, agent })),
          previewing: true,
        },
      });
      gitStatus(project.root)
        .then((g) => set({ git: g }))
        .catch(() => {});
      // Reload rather than trusting HMR (its socket can wedge), and drop the
      // selection — the edit may have shifted every position in the file, so
      // the old id can't be trusted for a follow-up.
      sendToOverlay({ type: "reload" });
      set({ selected: null, sourceInfo: null });
    } catch (e) {
      push({
        role: "assistant",
        error: true,
        text: String(e instanceof Error ? e.message : e),
      });
    } finally {
      set({ chatBusy: false, chatActivity: null });
      // However the turn ended — answered, refused, or thrown — the canvas
      // must stop claiming work is under way. In the `finally` for exactly
      // that reason: an error path that left the squares running would be a
      // section that looks busy for ever.
      sendToOverlay({ type: "set-busy", id: null });
    }
  },

  /**
   * Keep the previewed edit. The files are already on disk — that is what the
   * user has been looking at — so this is only the commit, which is the step
   * that makes it part of the session's history and undoable from History.
   */
  acceptChatEdit: async () => {
    const { project, pendingEdit, chatBusy } = get();
    if (!project || !pendingEdit || chatBusy) return;
    if (
      needsDirectWriteWarning(
        set,
        get,
        [...pendingEdit.files.map((f) => f.file), ...pendingEdit.assets.map((a) => a.file)],
        () => void get().acceptChatEdit(),
      )
    ) {
      return;
    }

    const push = (m: Omit<ChatMessage, "id">) =>
      set((s) => {
        const sessions = s.chatSessions.map((x) =>
          x.id === s.activeChatId
            ? { ...x, messages: [...x.messages, { id: crypto.randomUUID(), ...m }] }
            : x,
        );
        if (s.project) saveChatSessions(s.project.root, sessions);
        return { chatSessions: sessions };
      });

    set({ chatBusy: true });
    try {
      // Imported images are part of the change and are committed with it —
      // an accepted proposal whose picture stayed untracked would be a page
      // referencing a file nobody else has. They are untracked at this point,
      // which `git::commit_paths` stages by name.
      const paths = [
        ...pendingEdit.files.map((f) => f.file),
        ...pendingEdit.assets.map((a) => a.file),
      ];
      // The preview write can have been skipped (it failed); commit the files
      // first in that case rather than committing a change that isn't there.
      if (!pendingEdit.previewing) {
        const res = await writeSources(
          project.root,
          pendingEdit.files.map((f) => [f.file, f.after] as [string, string]),
        );
        if (!res.ok) throw new Error(res.error ?? "write failed");
      }
      const saved = await commitOrDirect(
        get,
        project.root,
        `dedup: ${pendingEdit.summary}`,
        paths,
      );
      patchChatMessage(set, pendingEdit.messageId, {
        commit: saved.direct ? undefined : saved.hash,
        writtenInPlace: saved.direct || undefined,
        outcome: "accepted",
      });
      set({ lastSave: saved, pendingEdit: null });
      gitStatus(project.root)
        .then((g) => set({ git: g }))
        .catch(() => {});
      if (!pendingEdit.previewing) {
        sendToOverlay({ type: "reload" });
        set({ selected: null, sourceInfo: null });
      }
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

  /** Put the files back exactly as dedup found them and take the preview off
   *  the canvas. Nothing was committed, so there is nothing to revert in git. */
  rejectChatEdit: async () => {
    const { project, pendingEdit, chatBusy } = get();
    if (!project || !pendingEdit || chatBusy) return;
    set({ chatBusy: true });
    try {
      const error = await revertPreview(project.root, pendingEdit);
      patchChatMessage(set, pendingEdit.messageId, { outcome: "rejected" });
      set({ pendingEdit: null });
      if (error) {
        set((s) => ({
          chatSessions: s.chatSessions.map((x) =>
            x.id === s.activeChatId
              ? {
                  ...x,
                  messages: [
                    ...x.messages,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant" as const,
                      error: true,
                      text: `Could not put every file back: ${error}. Check git status — the session branch has the original.`,
                    },
                  ],
                }
              : x,
          ),
        }));
      }
      gitStatus(project.root)
        .then((g) => set({ git: g }))
        .catch(() => {});
      sendToOverlay({ type: "reload" });
      set({ selected: null, sourceInfo: null });
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
    // The duplicate engine reads React components; a static site has none.
    // Refused here as well as hidden in the tab, so a keyboard shortcut or a
    // stale call can't start a scan that could only ever find nothing.
    if (project.framework === "static") {
      set({
        scanError:
          "Duplicate detection compares React components — a static HTML site has none to compare.",
        sidebarTab: "duplicates",
      });
      return;
    }
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

  runDrift: async () => {
    const { project, driftRunning } = get();
    if (!project || driftRunning) return;
    // Same refusal as the scan, for the same reason: the detector reads JSX.
    if (project.framework === "static") {
      set({
        driftError:
          "Drift detection reads JSX subtrees — a static HTML site has none.",
        sidebarTab: "drift",
      });
      return;
    }
    set({
      driftRunning: true,
      driftError: null,
      driftProgress: null,
      sidebarTab: "drift",
      openDriftId: null,
    });
    try {
      // Deliberately NOT scoped to the selected artboard, which is where the
      // scan differs: the scan needs an artboard because its output is
      // rendered previews of what is on that page, while drift is *by
      // definition* cross-file — "the same button in nine files" cannot be
      // seen one page at a time. Scoping it to a page turns the finding into
      // a much smaller and much less true one. The sidecar still takes a file
      // list; nothing here has a reason to pass one.
      const result = await extractProject(project.root, null);
      if (!result.ok) throw new Error(result.error ?? "drift scan failed");
      set({ driftResult: result });
    } catch (e) {
      set({ driftError: String(e instanceof Error ? e.message : e) });
    } finally {
      set({ driftRunning: false, driftProgress: null });
    }
  },

  restoreDrift: async () => {
    const { project, driftResult, driftRunning } = get();
    if (!project || driftResult || driftRunning) return;
    try {
      const saved = await loadExtractResult(project.root);
      // Still relevant? Saves from older builds are ignored — just rerun.
      if (
        saved?.ok &&
        saved.schema === DRIFT_SCHEMA &&
        get().project?.root === project.root &&
        !get().driftResult
      ) {
        set({ driftResult: saved });
      }
    } catch {
      // No saved run is a perfectly fine state.
    }
  },

  setDriftProgress: (driftProgress) => set({ driftProgress }),

  openDrift: (openDriftId) => {
    const candidate = get().driftResult?.candidates.find(
      (c) => c.id === openDriftId,
    );
    const driftSelection: Record<string, true> = {};
    for (const o of candidate?.occurrences ?? []) {
      driftSelection[`${o.file}:${o.start}`] = true;
    }
    set({
      openDriftId,
      driftSelection,
      driftProposal: null,
      driftProposalError: null,
      // A new candidate is a new scene — open it framed, not wherever the
      // last one was left.
      ...(openDriftId ? { driftZoom: 1, driftPan: { x: 120, y: 96 } } : {}),
      // Opening a candidate is the request to *see* the copies — that is the
      // whole point of the tab, and a list of file:line is what every other
      // tool already gives you.
      ...(openDriftId ? { editorTab: "drift" as const } : {}),
    });
  },

  proposeExtraction: async () => {
    const { driftResult, openDriftId, driftSelection, driftProposing } = get();
    if (driftProposing) return;
    const candidate = driftResult?.candidates.find((c) => c.id === openDriftId);
    if (!candidate) return;
    const picked = candidate.occurrences.filter(
      (o) => driftSelection[`${o.file}:${o.start}`],
    );
    if (picked.length < 2) {
      set({ driftProposalError: "Select at least two copies to combine." });
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
      set({
        driftProposalError:
          "No AI backend is on — switch one on in the AI menu (top bar).",
      });
      return;
    }
    set({ driftProposing: true, driftProposalError: null, driftProposal: null });
    try {
      const reply = await runExtractPrompt(backend, candidate, picked);
      set({
        driftProposal: { ...parseExtractReply(reply), fromCount: picked.length },
      });
    } catch (e) {
      set({ driftProposalError: String(e instanceof Error ? e.message : e) });
    } finally {
      set({ driftProposing: false });
    }
  },

  setDriftTransform: ({ zoom, pan }) =>
    set({ driftZoom: clampZoom(zoom), driftPan: pan }),

  selectAllDrift: () => {
    const { driftResult, openDriftId } = get();
    const candidate = driftResult?.candidates.find((c) => c.id === openDriftId);
    if (!candidate) return;
    const driftSelection: Record<string, true> = {};
    for (const o of candidate.occurrences) {
      driftSelection[`${o.file}:${o.start}`] = true;
    }
    set({ driftSelection });
  },

  toggleDriftOccurrence: (key) => {
    const next = { ...get().driftSelection };
    if (next[key]) delete next[key];
    else next[key] = true;
    set({ driftSelection: next });
  },

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

  setAgentEnabled: async (agent, on) => {
    if (!on) {
      patchAgent(set, get, agent, { enabled: false });
      saveAgentPrefs(get().agents);
      return;
    }
    // Never connected: switching on *is* the consent moment, so it is the
    // live test — and the switch only lands on if the test passes.
    if (!get().agents[agent].consent) {
      await get().connectAgent(agent);
      return;
    }
    patchAgent(set, get, agent, { enabled: true, error: null });
    saveAgentPrefs(get().agents);
  },

  setApiEnabled: (apiEnabled) => {
    try {
      localStorage.setItem(API_ON_STORAGE, apiEnabled ? "1" : "0");
    } catch {
      // In-memory switch still applies this session.
    }
    set({ apiEnabled });
  },

  setAgentModel: (agent, model) => {
    patchAgent(set, get, agent, { model });
    saveAgentPrefs(get().agents);
  },

  exportArtboard: async (route, format, scale = 1) => {
    const s = get();
    if (!s.project || s.exporting) return;
    const viewport = VIEWPORTS.find((v) => v.id === s.viewportId) ?? VIEWPORTS[0];
    // Exactly the frame the artboard loads — same origin (session), same
    // flags (held, offline) — and exactly its size.
    const url = artboardUrl(
      route,
      {
        sessionModes: s.sessionModes,
        frameOrigins: s.frameOrigins,
        devUrl: s.devUrl,
        devAltUrl: s.devAltUrl,
      },
      { held: !!s.heldRoutes[route], offline: !!s.offlineRoutes[route] },
    );
    if (!url) {
      set({ exportNotice: { text: "The dev server isn't running, so there is nothing to export yet.", error: true } });
      return;
    }
    const slug =
      route === "/" ? "home" : route.replace(/^\/+|\/+$/g, "").replace(/[^\w.-]+/g, "-") || "page";
    const suffix = format === "png" && scale !== 1 ? `@${scale}x` : "";
    const name = `${s.project.name}-${slug}-${viewport.id}${suffix}.${format}`;
    const path = await chooseExportPath(name, format);
    if (!path) return; // cancelled
    set({ exporting: route, exportNotice: null });
    try {
      const done = await renderArtboardExport({
        url,
        width: viewport.width,
        height: artboardHeight(viewport, s.pageHeights[route]),
        format,
        scale: format === "png" ? scale : undefined,
        path,
      });
      const size =
        done.bytes >= 1024 * 1024
          ? `${(done.bytes / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.max(1, Math.round(done.bytes / 1024))} KB`;
      // An export shows what the *files* render. Staged edits are previewed
      // on the canvas by the overlay, not written, so they are not in it —
      // said, rather than discovered when the picture looks wrong.
      const staged = get().actions.length > 0;
      set({
        exportNotice: {
          text: `Exported ${route} as ${format.toUpperCase()} · ${done.width}×${done.height}${
            format === "pdf" ? " pt" : " px"
          } · ${size}${staged ? " — unsaved edits aren't included; save first to export them" : ""}`,
          error: false,
          path: done.path,
        },
      });
    } catch (e) {
      set({
        exportNotice: {
          text: `Couldn't export ${route}: ${e instanceof Error ? e.message : String(e)}`,
          error: true,
        },
      });
    } finally {
      set({ exporting: null });
    }
  },

  dismissExportNotice: () => set({ exportNotice: null }),

  setDragOut: (dragOut) => set({ dragOut }),

  moveArtboard: (route, at) => {
    const s = get();
    if (!s.routes.includes(route)) return;
    // The whole layout as it stands, not just this one board: an artboard
    // without a stored position is placed relative to the rightmost, so
    // storing only the moved one would make every other one jump with it.
    const layout = artboardLayout(s);
    layout[route] = { x: Math.round(at.x), y: Math.round(at.y) };
    set({ artboardPos: { ...s.artboardPos, [s.viewportId]: layout } });
    rememberCanvas(get());
  },

  parkElement: async ({ id, route, element, at, rect }) => {
    if (isPendingId(id)) {
      get().setNotice("Save it first — something that was never written can't be parked yet.");
      return;
    }
    // Whether it may leave its page is the write-back's call, the same one ⌫
    // and ⌘X ask. Asked first, so a park that cannot remove never captures.
    const info = await sourceInfoFor(get, id);
    if (!info?.canRemove) {
      get().setNotice(info?.structuralReason ?? "This element can't be moved off its page.");
      return;
    }
    const captured = await captureClip(get, id, element);
    if ("error" in captured) {
      get().setNotice(captured.error);
      return;
    }
    // The picture, taken while it is still on the page (a staged removal
    // takes it off the canvas). Drawn at twice its page size so the card
    // stays sharp when zoomed in; a failed capture just means a plainer card.
    let picture: string | null = null;
    if (rect && rect.width >= 1 && rect.height >= 1) {
      try {
        picture = await snapshotRegion(rect, Math.min(2400, element.rect.width * 2));
      } catch {
        picture = null;
      }
    }
    if (!stageRemoval(get, set, id, captured.clip.label)) return;
    const piece: ParkedPiece = {
      id: crypto.randomUUID(),
      x: at.x,
      y: at.y,
      width: element.rect.width,
      height: element.rect.height,
      clip: captured.clip,
      picture,
      fromRoute: route,
      removal: id,
      placement: null,
      createdAt: Date.now(),
    };
    set({ parked: [...get().parked, piece] });
    get().setNotice(
      captureNotice("Parked", captured.clip.label, captured.unsaved) +
        " Drag it into any artboard to place it.",
    );
  },

  moveAcross: async ({ id, element, drop }) => {
    if (isPendingId(id)) {
      get().setNotice("Save it first — something that was never written can't move between pages yet.");
      return;
    }
    const info = await sourceInfoFor(get, id);
    if (!info?.canRemove) {
      get().setNotice(info?.structuralReason ?? "This element can't be moved off its page.");
      return;
    }
    const anchor = dropAnchor(get().actions, drop.id, drop.position);
    if (!anchor) return;
    const captured = await captureClip(get, id, element);
    if ("error" in captured) {
      get().setNotice(captured.error);
      return;
    }
    // Paste first: it is the half that can be refused for reasons of its own
    // (another language, an anchor on its way out), and a removal staged
    // before a refused paste would delete the element with nowhere to go.
    // One gesture, one undo step: the paste and the removal share an id.
    const gesture = crypto.randomUUID();
    const pasted = await stagePaste(get, captured.clip, anchor.target, anchor.position, "Moved", gesture);
    if (!pasted) return;
    if (!stageRemoval(get, set, id, captured.clip.label, gesture)) {
      // The removal was refused (something staged depends on it): take the
      // paste back too, so the gesture is all or nothing.
      const next = get().actions.filter((a) => !(a.kind === "insert" && a.id === pasted));
      set({ actions: next });
      syncCanvas(next);
      return;
    }
    get().selectById(pasted);
  },

  placeParked: async (pieceId, drop) => {
    const piece = get().parked.find((p) => p.id === pieceId);
    if (!piece) return;
    const anchor = dropAnchor(get().actions, drop.id, drop.position);
    if (!anchor) return;
    const pasted = await stagePaste(get, piece.clip, anchor.target, anchor.position, "Placed");
    if (!pasted) return;
    set({
      parked: get().parked.map((p) => (p.id === pieceId ? { ...p, placement: pasted } : p)),
    });
    get().selectById(pasted);
  },

  moveParked: (pieceId, at) =>
    set({ parked: get().parked.map((p) => (p.id === pieceId ? { ...p, x: at.x, y: at.y } : p)) }),

  deleteParked: (pieceId) => set({ parked: get().parked.filter((p) => p.id !== pieceId) }),

  confirmDirectWrite: () => {
    const prompt = get().directWritePrompt;
    set({ directWriteOk: true, directWritePrompt: null });
    prompt?.run();
  },

  cancelDirectWrite: () => set({ directWritePrompt: null }),

  setUpGit: async () => {
    const { project, pendingEdit, chatBusy, settingUpGit } = get();
    if (!project || chatBusy || settingUpGit) return null;
    const root = project.root;
    set({ settingUpGit: true });
    // A preview on disk is a proposal, not the user's work. The baseline must
    // be what they had, or the first commit in their new history would quietly
    // contain an AI edit they never accepted.
    const preview = pendingEdit?.previewing ? pendingEdit : null;
    try {
      if (preview) {
        const err = await revertPreview(root, preview);
        if (err) return `Couldn't set the preview aside for the baseline (${err}) — git was not set up.`;
      }
      try {
        set({ git: await gitInitBaseline(root) });
      } catch (e) {
        // Back to exactly where we were: no repo, preview on screen.
        if (preview) await reapplyPreview(root, preview);
        return e instanceof Error ? e.message : String(e);
      }
      if (preview) {
        const err = await reapplyPreview(root, preview);
        if (err) {
          // Git is set up and the folder is its baseline — a safe place to
          // stop. The proposal is gone from disk, so it is no longer pending.
          patchChatMessage(set, preview.messageId, { outcome: "rejected" });
          set({ pendingEdit: null });
          return `Git is set up, but the preview couldn't be put back (${err}). Ask again to redo it.`;
        }
        gitStatus(root)
          .then((g) => set({ git: g }))
          .catch(() => {});
      }
      sendToOverlay({ type: "reload" });
      return null;
    } finally {
      set({ settingUpGit: false });
    }
  },

  loadAgentModels: async (agent) => {
    const a = get().agents[agent];
    if (a.catalog !== null || a.installed === false) return;
    try {
      const catalog = await agentModels(agent);
      patchAgent(set, get, agent, { catalog });
    } catch {
      // No catalog is fine: the picker keeps "CLI default" and whatever was
      // saved. Marked as asked, so a broken CLI is not re-run on every open.
      patchAgent(set, get, agent, { catalog: [] });
    }
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
      patchAgent(set, get, agent, { consent: true, enabled: true, error: null });
      saveAgentPrefs(get().agents);
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

  /**
   * Who answers when nobody was named: the first agent switched on, in
   * CLI_AGENTS order, then the API key. Fixed order rather than "last used"
   * so the answer is stable and the AI menu can say which one it is — the
   * other is one `@` away. Everything that isn't the chat (organizing scans,
   * merges, the session seed) has no `@` to use, so this is its backend too.
   */
  activeAiBackend: () => {
    const { agents, apiEnabled, anthropicKey } = get();
    const first = CLI_AGENTS.find((a) => agentOn(agents[a.id]));
    if (first) return first.id;
    if (apiEnabled && anthropicKey) return "api";
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
          "A merge proposal needs an AI backend — switch an agent on, or add an API key, in the AI menu (top bar).",
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
    // The one save that never writes in place. Its gates undo a failed merge
    // by restoring the commit — without git, a merge that fails its typecheck
    // or build would stay applied, which is the codebase corruption the
    // gates exist to prevent.
    if (get().git?.isRepo === false) {
      patchMerge(set, get, {
        error:
          "A merge needs git: if it fails its checks, dedup undoes it by restoring the commit. Use “Set up git” in the top bar first.",
      });
      return;
    }

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

// --- parked pieces: kept in step with the staged program, and on disk --------

/** The project whose parked pieces have been read back. Until they have, a
 *  save would write an empty list over the ones on disk — the only copy. */
let parkedLoaded: string | null = null;

useStore.subscribe((state, prev) => {
  // Undo, redo, discard and every other change to the program: a piece whose
  // removal was taken back is back in its page; one whose placement was taken
  // back is back on the canvas (lib/parking).
  if (state.actions !== prev.actions) {
    const next = reconcileParked(state.parked, state.actions);
    if (next !== state.parked) {
      useStore.setState({ parked: next });
      return; // the update above re-enters with the pieces to save
    }
  }
  if (state.parked !== prev.parked && state.project && parkedLoaded === state.project.root) {
    void saveParked(state.project.root, persistable(state.parked)).catch((e) => {
      useStore
        .getState()
        .setNotice(`Couldn't save the parked pieces: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  if (state.project?.root !== prev.project?.root) parkedLoaded = null;
});

