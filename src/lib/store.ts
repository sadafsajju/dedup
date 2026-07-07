import { create } from "zustand";
import {
  claudeCodeAvailable,
  claudeCodePrompt,
  commitSession,
  gitStatus,
  inspectElement,
  loadCategories,
  loadScanResult,
  readSource,
  saveCategories,
  scanProject,
  writeClasses,
  writeSource,
} from "./api";
import { buildEditPrompt, runChatPrompt } from "./chat";
import { applyEditBlocks, parseChatReply } from "./chatEdits";
import {
  categorizeComponents,
  needingCategorization,
  skeletonHash,
  type AiBackend,
  type CategoryCache,
} from "./categorize";
import { requestCanvasFiles, sendToOverlay } from "./bridge";
import { parseDedupId, SCAN_SCHEMA } from "./types";
import type {
  ChatMessage,
  ChatSession,
  DevServerStatus,
  GitStatus,
  InstrumentationInfo,
  LogEvent,
  PageMeta,
  ProjectInfo,
  ScanCluster,
  ScanProgress,
  ScanResult,
  SelectedElement,
  SidebarTab,
  SourceClassInfo,
  StagedEdit,
  Viewport,
} from "./types";

const MAX_LOG_LINES = 2000;

type View = "launch" | "editor";

/** One undoable step: the staged entry's state before and after (null =
 * not staged, i.e. the element matched its source). */
interface EditOp {
  dedupId: string;
  before: StagedEdit | null;
  after: StagedEdit | null;
}

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

  viewportId: Viewport["id"];
  /** Active canvas tool (FR-6.1): select = inspect on click, hand = drag to
   * pan, browse = clicks pass through so the user can navigate their app. */
  tool: "select" | "hand" | "browse";
  zoom: number;
  /** Canvas pan offset in px — where the frame's origin sits (FR-6.1). */
  pan: { x: number; y: number };
  /** Natural page height reported by the overlay; frame grows to fit. */
  contentHeight: number | null;
  /** Page title/route from the overlay — the frame's label (FR-6.1). */
  pageMeta: PageMeta | null;

  /** Element currently selected on the canvas (FR-2.2). */
  selected: SelectedElement | null;
  /** What the source says about the selection's className (FR-4.2). */
  sourceInfo: SourceClassInfo | null;

  /** Unsaved class edits keyed by dedupId (FR-3.7). */
  staged: Record<string, StagedEdit>;
  undoStack: EditOp[];
  redoStack: EditOp[];
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
  /** Bumped only by fresh scans (not restores) — drives the canvas auto-pan. */
  scanSeq: number;
  scanError: string | null;
  /** Cluster ids the user marked "not duplicates" — persisted per project. */
  dismissed: Record<string, true>;
  /** Cluster open in the review view. */
  openClusterId: string | null;

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
  /** Claude Code CLI detected on this machine (null = not yet checked). */
  claudeCode: boolean | null;
  /** Which backend the user chose (persisted). null = not chosen yet. */
  aiPref: "claude-code" | "api" | null;
  /** User explicitly connected Claude Code (consent + live test passed). */
  ccConsent: boolean;
  ccConnecting: boolean;
  ccError: string | null;
  /** Claude Code model alias ("sonnet", "opus", …). null = CLI default. */
  ccModel: string | null;

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
  clearLogs: () => void;
  toggleConsole: (open?: boolean) => void;
  setViewport: (id: Viewport["id"]) => void;
  setTool: (tool: "select" | "hand" | "browse") => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  /** Atomic zoom+pan update so zoom-toward-cursor never flickers. */
  setZoomPan: (zoom: number, pan: { x: number; y: number }) => void;
  setContentHeight: (h: number | null) => void;
  setPageMeta: (meta: PageMeta | null) => void;
  setSelected: (sel: SelectedElement | null) => void;
  /** Clear selection here and in the overlay. */
  clearSelection: () => void;
  /** Ask the overlay to select an element by dedupId (breadcrumb clicks). */
  selectById: (id: string) => void;

  /** The class string the panel should show/edit for the selection. */
  effectiveClassName: () => string | null;
  /** Stage a class edit + live-patch the canvas (FR-3.7). */
  applyClassEdit: (next: string) => void;
  /** Discard one staged edit (review panel), undoable. */
  revertEdit: (dedupId: string) => void;
  undo: () => void;
  redo: () => void;
  /** Write staged edits to source, commit on the session branch (FR-4.x). */
  saveAll: () => Promise<void>;

  setSidebarTab: (tab: SidebarTab) => void;
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

  setAnthropicKey: (key: string) => void;
  /** Detect the Claude Code CLI once per app run. */
  detectClaudeCode: () => Promise<void>;
  /** Pick the AI backend (persisted). */
  setAiPref: (pref: "claude-code" | "api" | null) => void;
  setCcModel: (model: string | null) => void;
  /** Consent + live test: verifies Claude Code login and enables it. */
  connectClaudeCode: () => Promise<void>;
  /** The backend categorize() will actually use right now, if any. */
  activeAiBackend: () => "claude-code" | "api" | null;
  /** Categorize the current gallery with Claude; cached per project. */
  categorize: () => Promise<void>;
  /** Apply cached categories (no API call) for the current scan result. */
  applyCachedCategories: () => Promise<void>;
}

const KEY_STORAGE = "dedup:anthropic-key";
const AI_PREF_STORAGE = "dedup:ai-pref";
const CC_CONSENT_STORAGE = "dedup:claude-code-consent";
const CC_MODEL_STORAGE = "dedup:claude-code-model";

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
export function rankClusters(
  result: ScanResult | null,
  dismissed: Record<string, true>,
): ScanCluster[] {
  if (!result) return [];
  return result.clusters
    .filter((c) => !dismissed[c.id])
    .sort(
      (a, b) =>
        b.confidence * Math.max(b.totalCallSites, b.members.length) -
        a.confidence * Math.max(a.totalCallSites, a.members.length),
    );
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

/** Set one staged entry to a snapshot (or remove it) and sync the canvas. */
function applyOp(
  dedupId: string,
  entry: StagedEdit | null,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
) {
  const staged = { ...get().staged };
  if (entry) {
    staged[dedupId] = entry;
    sendToOverlay({ type: "set-class", id: dedupId, className: entry.current });
  } else {
    const prev = staged[dedupId];
    delete staged[dedupId];
    if (prev) {
      sendToOverlay({ type: "reset-class", id: dedupId, className: prev.original });
    }
  }
  set({ staged });
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

  viewportId: "desktop",
  tool: "select",
  zoom: 1,
  pan: { x: 80, y: 40 },
  contentHeight: null,
  pageMeta: null,
  selected: null,
  sourceInfo: null,

  staged: {},
  undoStack: [],
  redoStack: [],
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
  scanSeq: 0,
  scanError: null,
  dismissed: {},
  openClusterId: null,

  categories: {},
  mockProps: {},
  categorizing: false,
  categorizeProgress: null,
  categorizeError: null,
  anthropicKey: localStorage.getItem(KEY_STORAGE) ?? "",
  claudeCode: null,
  aiPref:
    (localStorage.getItem(AI_PREF_STORAGE) as "claude-code" | "api" | null) ??
    // Existing key users keep working without re-choosing.
    (localStorage.getItem(KEY_STORAGE) ? "api" : null),
  ccConsent: localStorage.getItem(CC_CONSENT_STORAGE) === "yes",
  ccConnecting: false,
  ccError: null,
  ccModel: localStorage.getItem(CC_MODEL_STORAGE),

  enterEditor: (project, git, customCommand = null) => {
    // Past chats come back with the project; land on the most recent one.
    const chatSessions = loadChatSessions(project.root);
    set({
      sidebarTab: "layers",
      inspectorTab: "design",
      chatSessions,
      activeChatId: chatSessions[chatSessions.length - 1]?.id ?? null,
      chatBusy: false,
      scanning: false,
      scanProgress: null,
      scanResult: null,
      scanError: null,
      dismissed: loadDismissed(project.root),
      openClusterId: null,
      categories: {},
      mockProps: {},
      categorizing: false,
      categorizeProgress: null,
      categorizeError: null,
      view: "editor",
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
      tool: "select",
      selected: null,
      sourceInfo: null,
      staged: {},
      undoStack: [],
      redoStack: [],
      lastSave: null,
      saveError: null,
    });
  },

  backToLaunch: () =>
    set({
      sidebarTab: "layers",
      chatSessions: [],
      activeChatId: null,
      chatBusy: false,
      scanning: false,
      scanProgress: null,
      scanResult: null,
      scanError: null,
      dismissed: {},
      openClusterId: null,
      categories: {},
      mockProps: {},
      categorizing: false,
      categorizeProgress: null,
      categorizeError: null,
      view: "launch",
      project: null,
      git: null,
      customCommand: null,
      instrumentation: null,
      devStatus: "idle",
      devUrl: null,
      devPort: null,
      logs: [],
      crashed: false,
      selected: null,
      sourceInfo: null,
      staged: {},
      undoStack: [],
      redoStack: [],
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
      contentHeight: null,
      pageMeta: null,
    }),

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

  setTool: (tool) => {
    // Browse mode hands clicks back to the app — an active selection would
    // just be stale UI over a page the user is now navigating.
    if (tool === "browse") get().clearSelection();
    sendToOverlay({ type: "set-mode", mode: tool === "browse" ? "browse" : "inspect" });
    set({ tool });
  },

  setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.25, zoom)) }),

  setPan: (pan) => set({ pan }),

  setZoomPan: (zoom, pan) =>
    set({ zoom: Math.min(2, Math.max(0.25, zoom)), pan }),

  setContentHeight: (contentHeight) => set({ contentHeight }),

  setPageMeta: (pageMeta) => set({ pageMeta }),

  setSelected: (selected) => {
    set({ selected, sourceInfo: null });
    if (!selected) return;
    // Ask the source of truth (the file) what this element's classes are.
    const pos = parseDedupId(selected.dedupId);
    const root = get().project?.root;
    if (!pos || !root) return;
    inspectElement(root, pos.file, pos.line, pos.col)
      .then((r) => {
        if (get().selected?.dedupId !== selected.dedupId) return; // stale
        if (!r.ok) {
          set({
            sourceInfo: {
              editable: false,
              className: null,
              reason: r.error ?? "source lookup failed",
            },
          });
          return;
        }
        set({
          sourceInfo: {
            editable: r.editable ?? false,
            className: r.className ?? null,
            reason: r.reason ?? null,
          },
        });
      })
      .catch((e) => {
        if (get().selected?.dedupId !== selected.dedupId) return;
        set({
          sourceInfo: { editable: false, className: null, reason: String(e) },
        });
      });
  },

  clearSelection: () => {
    sendToOverlay({ type: "clear" });
    set({ selected: null, sourceInfo: null });
  },

  selectById: (id) => sendToOverlay({ type: "select-id", id }),

  effectiveClassName: () => {
    const { selected, staged, sourceInfo } = get();
    if (!selected) return null;
    const entry = staged[selected.dedupId];
    if (entry) return entry.current;
    return sourceInfo?.className ?? null;
  },

  applyClassEdit: (next) => {
    const { selected, sourceInfo, staged, undoStack } = get();
    if (!selected || !sourceInfo?.editable) return;
    const pos = parseDedupId(selected.dedupId);
    if (!pos) return;

    const before = staged[selected.dedupId] ?? null;
    const from = before?.current ?? sourceInfo.className ?? "";
    if (next === from) return;

    const after: StagedEdit = before
      ? { ...before, current: next }
      : {
          dedupId: selected.dedupId,
          file: pos.file,
          line: pos.line,
          col: pos.col,
          original: sourceInfo.className ?? "",
          current: next,
          component: selected.component,
        };

    sendToOverlay({ type: "set-class", id: selected.dedupId, className: next });
    set({
      staged: { ...staged, [selected.dedupId]: after },
      undoStack: [...undoStack, { dedupId: selected.dedupId, before, after }],
      redoStack: [],
    });
  },

  revertEdit: (dedupId) => {
    const { staged, undoStack } = get();
    const before = staged[dedupId];
    if (!before) return;
    const nextStaged = { ...staged };
    delete nextStaged[dedupId];
    sendToOverlay({ type: "reset-class", id: dedupId, className: before.original });
    set({
      staged: nextStaged,
      undoStack: [...undoStack, { dedupId, before, after: null }],
      redoStack: [],
    });
  },

  undo: () => {
    const { undoStack, redoStack } = get();
    const op = undoStack[undoStack.length - 1];
    if (!op) return;
    applyOp(op.dedupId, op.before, set, get);
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, op],
    });
  },

  redo: () => {
    const { undoStack, redoStack } = get();
    const op = redoStack[redoStack.length - 1];
    if (!op) return;
    applyOp(op.dedupId, op.after, set, get);
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, op],
    });
  },

  saveAll: async () => {
    const { project, staged, saving } = get();
    if (!project || saving) return;
    const dirty = Object.values(staged).filter((e) => e.current !== e.original);
    if (dirty.length === 0) return;

    set({ saving: true, saveError: null });
    try {
      // Group by file; one AST pass per file, all ranges from one parse.
      const byFile = new Map<string, StagedEdit[]>();
      for (const e of dirty) {
        byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
      }
      for (const [file, edits] of byFile) {
        const res = await writeClasses(
          project.root,
          file,
          edits.map((e) => ({ line: e.line, col: e.col, className: e.current })),
        );
        if (!res.ok) throw new Error(res.error ?? `write failed for ${file}`);
      }

      const names = [...new Set(dirty.map((e) => e.component ?? "element"))];
      const label =
        names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1} more`;
      const message = `dedup: adjust classes on ${label}`;
      const [branch, hash] = await commitSession(
        project.root,
        message,
        [...byFile.keys()],
      );

      sendToOverlay({ type: "clear-staged" });
      set({
        staged: {},
        undoStack: [],
        redoStack: [],
        lastSave: { branch, hash },
      });
      // Branch may have just been created — refresh the TopBar indicator.
      gitStatus(project.root)
        .then((g) => set({ git: g }))
        .catch(() => {});
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

  setInspectorTab: (inspectorTab) => set({ inspectorTab }),

  sendChat: async (instruction) => {
    const { project, selected, chatBusy } = get();
    const text = instruction.trim();
    if (!project || !selected || !text || chatBusy) return;
    const src = parseDedupId(selected.dedupId);
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

    // A full-file rewrite would strand unsaved class edits in this file
    // (their line/col positions go stale) — make the user land them first.
    const stagedHere = Object.values(get().staged).some(
      (e) => e.file === src.file && e.current !== e.original,
    );
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
      kind === "claude-code"
        ? {
            kind: "claude-code" as const,
            run: (p: string) => claudeCodePrompt(p, get().ccModel),
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
      // Stale-selection guard: commits since selection shift line numbers,
      // and a wrong line makes the model edit the wrong element. The tag at
      // the selected position must still be there.
      const lineText = source.split("\n")[src.line - 1] ?? "";
      if (!lineText.toLowerCase().includes(`<${selected.tag.toLowerCase()}`)) {
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
          buildEditPrompt(src, selected, source, text),
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
    const { project, scanning, devStatus } = get();
    if (!project || scanning) return;
    set({
      scanning: true,
      scanError: null,
      scanProgress: null,
      sidebarTab: "duplicates",
      openClusterId: null,
    });
    try {
      // Scope to what's on the canvas (the current page). No running canvas
      // or no tagged elements → honest fallback to a whole-project scan.
      const canvasFiles =
        devStatus === "ready" ? await requestCanvasFiles() : null;
      const scope = canvasFiles && canvasFiles.length > 0 ? canvasFiles : null;
      const result = await scanProject(project.root, scope);
      if (!result.ok) throw new Error(result.error ?? "scan failed");
      set({ scanResult: result, scanSeq: get().scanSeq + 1 });
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

  detectClaudeCode: async () => {
    if (get().claudeCode !== null) return;
    try {
      set({ claudeCode: await claudeCodeAvailable() });
    } catch {
      set({ claudeCode: false });
    }
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

  setCcModel: (ccModel) => {
    try {
      if (ccModel) localStorage.setItem(CC_MODEL_STORAGE, ccModel);
      else localStorage.removeItem(CC_MODEL_STORAGE);
    } catch {
      // In-memory choice still applies this session.
    }
    set({ ccModel });
  },

  connectClaudeCode: async () => {
    if (get().ccConnecting) return;
    set({ ccConnecting: true, ccError: null });
    try {
      if (get().claudeCode === null) await get().detectClaudeCode();
      if (!get().claudeCode) {
        throw new Error(
          "Claude Code CLI not found. Install it and run `claude` once to log in.",
        );
      }
      // Live round-trip proves the login works and is the explicit consent
      // moment — dedup never uses the subscription before this succeeds.
      const reply = await claudeCodePrompt("Reply with exactly: ok", get().ccModel);
      if (!/ok/i.test(reply)) {
        throw new Error(`unexpected reply from Claude Code: ${reply.slice(0, 80)}`);
      }
      try {
        localStorage.setItem(CC_CONSENT_STORAGE, "yes");
      } catch {
        // Session-only consent still works.
      }
      set({ ccConsent: true });
      get().setAiPref("claude-code");
      // Organize the current scan right away with the new backend.
      void get().categorize();
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      set({
        ccError: /login|auth|credential|unauthorized/i.test(msg)
          ? `${msg} — run \`claude\` in a terminal and complete /login, then retry.`
          : msg,
      });
    } finally {
      set({ ccConnecting: false });
    }
  },

  activeAiBackend: () => {
    const { aiPref, ccConsent, claudeCode, anthropicKey } = get();
    if (aiPref === "claude-code" && ccConsent && claudeCode !== false) {
      return "claude-code";
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
      kind === "claude-code"
        ? { kind: "claude-code", run: (p) => claudeCodePrompt(p, get().ccModel) }
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

}));
