// Types mirroring the Rust serde structs (camelCase over the IPC boundary).

import { withAttr, withText } from "./palette";

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
  /** Cached at open time; null for entries written before the launch grid. */
  framework: Framework | null;
  /** Unix millis of the last open, or null when unknown. */
  lastOpened: number | null;
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
  /** `next-optin` = a Next project dedup could tag once the user adds the
   * wrapper to their own next.config (see NextSetup). */
  mode: "tagged" | "custom" | "framework" | "script" | "error" | "next-optin";
  detail: string | null;
}

/** What dedup can do for a Next.js project (Phase 5). */
export type NextStatus =
  | { state: "wired"; config: string; needsWebpack: boolean }
  | {
      state: "offered";
      config: string;
      before: string;
      after: string;
      /** The project's dev script asks for Turbopack, which never runs the
       * webpack hook dedup tags through — so dedup launches it under webpack
       * while inspecting. Said out loud: it is a different bundler than the
       * one the user's own `next dev` uses. */
      needsWebpack: boolean;
    }
  | { state: "unavailable"; reason: string };

export type DevServerStatus =
  | "idle"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "crashed";

// --- Element selection (FR-2.2, FR-2.4) -----------------------------------

/** Why an element resists structural editing (stamped by the tagger). */
export type DynamicKind = "array" | "conditional";
export type CoreKind = "root" | "body";

/** One tagged element as reported by the canvas overlay. */
export interface ElementRef {
  /** `<file>@<ordinal>` — stable identity, position-free (see jsxwalk.mjs). */
  dedupId: string;
  /** Enclosing component name, when the tagger could determine it. */
  component: string | null;
  /** DOM tag name (or lowercased component tag for custom elements). */
  tag: string;
  /** The element's current DOM class attribute (may include runtime classes). */
  domClassName: string;
  /** Set when the element is a `.map()` item or a conditional branch. */
  dynamic: DynamicKind | null;
  /** Set for a component's root element and for `<body>`. */
  core: CoreKind | null;
  /** Per-DOM-node id assigned by the overlay — one source node has N of these
   * when it renders inside a list, so a gesture can name the instance it hit. */
  domId: string | null;
}

/**
 * What the source says about the selected element — the write-back's own
 * report, so every affordance in the UI is gated by what it would actually
 * accept (FR-4.2, "honesty over magic").
 */
export interface NodeInfo {
  editable: boolean;
  /** Static class string from source; null when dynamic. */
  className: string | null;
  /** Why className is read-only, when it is. */
  reason: string | null;
  /** Live source position, derived at inspect time — never carried in the id. */
  line: number;
  col: number;
  tag: string;
  component: string | null;
  dynamic: DynamicKind | null;
  core: CoreKind | null;
  parentIndex: number | null;
  canRemove: boolean;
  canMove: boolean;
  /** Why the element can't be moved or deleted, when it can't. */
  structuralReason: string | null;
  canAcceptChildren: boolean;
  canEditText: boolean;
  textReason: string | null;
  /** Current static text, when the element has exactly one text child. */
  text: string | null;
}

// --- Edit actions (the staged program) --------------------------------------

/** Where a dropped/inserted element lands relative to the reference node. */
export type DropPosition = "before" | "after" | "inside";

/** Identity of one JSX node in one file. */
export interface EditTarget {
  dedupId: string;
  file: string;
  /** Ordinal in the shared walk; -1 for a staged insert, which has no node in
   * the file yet — such edits are folded into the insert's snippet on save. */
  index: number;
}

/** An element that exists only in the staged program, not yet in the source. */
export const PENDING_PREFIX = "pending:";
export const isPendingId = (dedupId: string) => dedupId.startsWith(PENDING_PREFIX);

/**
 * One staged edit. Value edits (class/text) collapse per element — the newest
 * wins — while structural edits keep their order, because moving A into B and
 * then B into C is not the same program as the reverse.
 *
 * Every action carries what it needs to be inverted, so undo is a property of
 * the action rather than of the UI that produced it.
 */
export type ValueAction =
  | {
      kind: "class";
      target: EditTarget;
      before: string;
      after: string;
      component: string | null;
      /** Drag id — consecutive same-group edits collapse into one undo step. */
      group?: string;
    }
  | {
      kind: "text";
      target: EditTarget;
      before: string;
      after: string;
      component: string | null;
    };

export type StructuralAction =
  | { kind: "remove"; target: EditTarget; label: string }
  | {
      kind: "insert";
      /** Provisional id for the element being inserted (`pending:…`). It has
       * no source node yet, so it cannot have a real one — but the canvas
       * still needs to address it, or a new element can't be selected, styled
       * or typed into until after it is saved. */
      id: string;
      /** The reference node the new element is placed against. */
      target: EditTarget;
      position: DropPosition;
      /** JSX written to source. */
      snippet: string;
      /** HTML rendered into the canvas for the live preview. */
      preview: string;
      label: string;
    }
  | {
      kind: "move";
      target: EditTarget;
      to: EditTarget;
      position: DropPosition;
      label: string;
    };

export type EditAction = ValueAction | StructuralAction;

/** Value edits collapse per element; structural ones keep their order. */
export const isValueAction = (a: EditAction): a is ValueAction =>
  a.kind === "class" || a.kind === "text";

/** The write-back op wire format (one entry of a file's edit program). */
export type EditOp = Record<string, unknown>;

/**
 * Translate staged actions into the sidecar's op program for one file.
 *
 * Class and text edits made on a not-yet-saved insert have no node to address,
 * so they are folded into that insert's snippet here — the element the user
 * typed into is written once, in its final form, rather than as an insert
 * followed by edits to something that did not exist when the insert ran.
 *
 * Returns the ops, plus anything that could not be expressed (a fold that
 * failed validation), so the caller can refuse the save rather than write a
 * program that silently drops an edit.
 */
export function opsForFile(actions: EditAction[]): {
  ops: EditOp[];
  failures: string[];
} {
  const failures: string[] = [];
  // Pending id → the snippet as edits accumulate.
  const pending = new Map<string, string>();
  for (const a of actions) {
    if (a.kind === "insert") pending.set(a.id, a.snippet);
  }
  for (const a of actions) {
    if (!isValueAction(a) || !isPendingId(a.target.dedupId)) continue;
    const current = pending.get(a.target.dedupId);
    if (current === undefined) {
      failures.push("an edit refers to an inserted element that is no longer staged");
      continue;
    }
    const next =
      a.kind === "class"
        ? withAttr(current, "className", a.after)
        : withText(current, a.after);
    if (next === null) {
      failures.push(
        a.kind === "class"
          ? `those classes can't be applied to the new element`
          : `that text can't be applied to the new element`,
      );
      continue;
    }
    pending.set(a.target.dedupId, next);
  }

  const ops: EditOp[] = [];
  for (const a of actions) {
    switch (a.kind) {
      case "class":
      case "text":
        // Folded above; the insert op carries it.
        if (isPendingId(a.target.dedupId)) break;
        ops.push(
          a.kind === "class"
            ? { op: "class", index: a.target.index, className: a.after }
            : { op: "text", index: a.target.index, text: a.after },
        );
        break;
      case "remove":
        ops.push({ op: "remove", index: a.target.index });
        break;
      case "insert":
        ops.push({
          op: "insert",
          target: a.target.index,
          position: a.position,
          snippet: pending.get(a.id) ?? a.snippet,
        });
        break;
      case "move":
        ops.push({
          op: "move",
          index: a.target.index,
          target: a.to.index,
          position: a.position,
        });
        break;
    }
  }
  return { ops, failures };
}

/**
 * One node of a page artboard's rendered element tree (FR-6.2), as reported
 * by that frame's overlay. Mirrors the DOM, so a `.map()`-rendered source
 * element appears once per instance, and staged inserts show before saving.
 */
export interface LayerNode {
  /** `<file>@<ordinal>`, or `pending:…` for a staged insert. */
  id: string;
  tag: string;
  component: string | null;
  dynamic: DynamicKind | null;
  core: CoreKind | null;
  /** True for a staged-insert preview node that isn't in source yet. */
  staged: boolean;
  /** Short direct-text snippet, leaf nodes only — tells list rows apart. */
  text: string | null;
  children: LayerNode[];
}

export interface SelectedElement extends ElementRef {
  rect: { x: number; y: number; width: number; height: number };
  /** How many DOM instances share this source position (.map() loops). */
  instanceCount: number;
  /** Innermost-first chain of tagged ancestors, including the element. */
  ancestry: ElementRef[];
}

/** One chat conversation, persisted per project (localStorage). */
export interface ChatSession {
  id: string;
  /** First instruction, truncated — the label in the session switcher. */
  title: string;
  createdAt: number;
  messages: ChatMessage[];
}

/** One inspector-chat message (AI edits). */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** The element the instruction targeted (on user messages). */
  target?: { label: string; file: string };
  /** Short commit hash when this reply applied an edit. */
  commit?: string;
  error?: boolean;
}

/**
 * Parse a dedupId (`<file>@<ordinal>`) back into its parts. The ordinal is the
 * element's position in the shared jsxwalk traversal, not a source position —
 * it survives edits that shift lines and columns.
 */
export function parseDedupId(
  id: string,
): { file: string; index: number } | null {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const index = Number(id.slice(at + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { file: id.slice(0, at), index };
}

/** dedupId → EditTarget, or null when the id is malformed. */
export function targetOf(dedupId: string): EditTarget | null {
  const parsed = parseDedupId(dedupId);
  return parsed ? { dedupId, ...parsed } : null;
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

// --- Mock session (zero-login editing, FR-6.3) ------------------------------

/** A user-reviewed browser-storage seed that makes a client-side auth guard
 * consider itself signed in, so protected routes render on the canvas.
 * Persisted per project in `node_modules/.dedup/session.json`; served by the
 * tagger into framed canvas pages only. */
export interface SessionSeed {
  enabled: boolean;
  /** Bare JS statements (the tagger wraps them in the framed gate). */
  script: string;
}

/** A source file that hints at how the app stores its auth session — the
 * context handed to the AI when drafting a seed. */
export interface AuthContextFile {
  path: string;
  snippet: string;
}

/** A managed auth SDK found in the project's dependencies. `seedable` is
 * false when the SDK keeps its session somewhere a storage seed structurally
 * cannot reach (IndexedDB, httpOnly cookies, memory) — then signing in for
 * real is the only path, and the UI says so instead of letting the user
 * spend an AI call finding out. */
export interface AuthProvider {
  name: string;
  storage: string;
  seedable: boolean;
}

export interface AuthContext {
  provider: AuthProvider | null;
  files: AuthContextFile[];
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

// --- Guarded merge (FR-5.4 → FR-5.7) ----------------------------------------

/** One member of a cluster, as the codemod reads it back off disk. */
export interface MergeMemberPlan {
  name: string;
  file: string;
  exportKind: "default" | "named" | "local";
  /** The component's full declaration, verbatim — what the model rewrites. */
  source: string;
  props: string[];
  behavior: {
    hooks: string[];
    handlers: string[];
    calls: string[];
    statements: number;
  };
  /** Everything else the file declares — empty means the file can be retired. */
  otherDeclarations: string[];
  callSites: number;
  fileIsDedicated: boolean;
}

/** One traced use of a member. Traced, not name-matched: a `<Card>` only
 * counts when its binding resolves to this member's file (see resolve.mjs). */
export interface MergeCallSite {
  file: string;
  component: string;
  localName: string;
  line: number;
  col: number;
  attrs: { name: string | null; spread: boolean; text: string; value?: string | null }[];
  text: string;
}

export interface MergePlan {
  ok: boolean;
  error?: string;
  canonicalSuggestion: { name: string; file: string };
  members: MergeMemberPlan[];
  callSites: MergeCallSite[];
  /** FR-5.8: do the members differ in behaviour, not just markup? */
  behaviorDiff: { differs: boolean; detail: string | null };
  /** Barrels re-exporting a member — these block a merge until resolved. */
  reExports: { file: string; name: string }[];
  filesScanned: number;
}

/** What the model proposed, after parsing — never applied unreviewed. */
export interface MergeProposal {
  /** Canonical component name and the file it will live in. */
  name: string;
  file: string;
  /** The complete new content of that file. */
  source: string;
  /** Per member: the props a call site needs to keep looking the same. */
  mapping: { name: string; file: string; props: Record<string, string | number | boolean> }[];
  /** One-line description of the API the model chose. */
  summary: string;
  /** Anything it wants the reviewer to know (behaviour it could not merge). */
  notes: string[];
}

export interface MergeChange {
  file: string;
  before: string;
  after: string;
  kind: "canonical" | "created" | "callsite" | "retired";
}

/** The dry run: every file's before/after, written nowhere yet (FR-5.4). */
export interface MergePreview {
  ok: boolean;
  error?: string;
  dryRun?: boolean;
  canonical: { name: string; file: string };
  changes: MergeChange[];
  retired: string[];
  leftBehind: { file: string; name: string }[];
  callSiteFiles: number;
  warnings: string[];
  /** Present only on a real apply. */
  trashed?: string[];
  written?: string[];
}

/** One safety gate's verdict (FR-5.6). "skipped" is never a pass. */
export interface GateResult {
  kind: "typecheck" | "build" | "visual";
  status: "passed" | "failed" | "skipped";
  command: string;
  output: string;
  durationMs: number;
}

export type MergeStage =
  | "idle"
  | "planning"
  | "proposing"
  | "review"
  | "applying"
  | "gating"
  | "done"
  | "rolledback"
  | "failed";

/** Everything about the merge currently in flight. One at a time, on purpose:
 * a merge is a whole-project rewrite behind gates, not a background task. */
export interface MergeSession {
  clusterId: string;
  members: { name: string; file: string }[];
  stage: MergeStage;
  plan: MergePlan | null;
  proposal: MergeProposal | null;
  preview: MergePreview | null;
  gates: GateResult[];
  /** Which gate is running right now, for the progress line. */
  runningGate: GateResult["kind"] | null;
  error: string | null;
  /** Short hash of the merge commit, once it lands. */
  commit: string | null;
  /** Why the merge was rolled back, when it was. */
  rollbackReason: string | null;
}

/** One dedup commit on the session branch (FR-5.7). */
export interface HistoryEntry {
  hash: string;
  subject: string;
  when: string;
  files: string[];
  isMerge: boolean;
}

/** Pixel comparison of two canvas captures (FR-5.6 #3). */
export interface VisualDiff {
  ratio: number;
  changedPixels: number;
  totalPixels: number;
  width: number;
  height: number;
  sizeChanged: boolean;
}

/** Files staged for deletion, awaiting the session-end confirmation. */
export interface TrashEntry {
  path: string;
  at: number;
}

/** Default visual-regression tolerance (FR-5.6 #3 says "configurable, 1%"). */
export const VISUAL_TOLERANCE = 0.01;

/** The shape mergeFlow needs from a parsed build error — declared here so the
 * gate runner doesn't import the whole error parser just for a type. */
export interface ParsedErrorLike {
  source: string;
  content: string;
}
