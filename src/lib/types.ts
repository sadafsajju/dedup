// Types mirroring the Rust serde structs (camelCase over the IPC boundary).

import { classAttrFor, toHtmlSnippet, withAttr, withText } from "./palette";

/** A coding-agent CLI dedup can borrow for a prompt. Mirrors `ai::Agent`. */
export type CliAgent = "claude-code" | "codex";

/** How editor chat and session prompts reach the selected AI backend. */
export type AiBackend =
  | { kind: "cli"; agent: CliAgent; run: (prompt: string) => Promise<string> }
  | { kind: "api"; apiKey: string };

/** What dedup knows about one agent on this machine. */
export interface AgentState {
  /** null until probed. */
  installed: boolean | null;
  /** The user explicitly connected it — a live round-trip that succeeded.
   * dedup never spends someone's subscription before that. */
  consent: boolean;
  /** Model override for that CLI; null keeps its own default. */
  model: string | null;
  /** Switched on in Settings → AI (persisted). Both agents can be on at once —
   * a message names one with `@claude`/`@codex` — so this is a per-agent
   * switch rather than a single choice. Off keeps `consent`: switching back
   * on is instant, with no second test prompt. */
  enabled: boolean;
  /** The models the installed CLI itself offers (`agent_models`), once asked;
   * null until then or for a CLI with no catalog. Not persisted — it belongs
   * to whichever binary is installed right now. */
  catalog: { value: string; label: string }[] | null;
  connecting: boolean;
  error: string | null;
}

/** Whether a message may be sent to this agent: connected (a live
 *  round-trip passed), switched on, and still installed. One rule, so the
 *  store and the composer cannot disagree about who is available. */
export function agentOn(a: AgentState | undefined): boolean {
  return !!a && a.consent && a.enabled && a.installed !== false;
}

export const CLI_AGENTS: {
  id: CliAgent;
  label: string;
  /** What the user gets billed through, in their words. */
  detail: string;
  /** Command to run if it isn't installed or isn't signed in. */
  command: string;
  /** This CLI can generate files (images) dedup knows how to import. Mirrors
   * `Agent::asset_dir` — a backend without one is never told the ASSET
   * directive exists, since it could only fail. */
  generatesAssets: boolean;
  /** Model choices offered; "" means the CLI's own default. */
  models: { value: string; label: string }[];
}[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detail: "subscription",
    command: "claude",
    generatesAssets: false,
    models: [
      { value: "", label: "CLI default" },
      { value: "haiku", label: "Haiku" },
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    detail: "subscription",
    command: "codex",
    generatesAssets: true,
    models: [{ value: "", label: "CLI default" }],
  },
];

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm" | "unknown";
/** How dedup runs a project. `static` is a plain HTML site: no build step, no
 *  package manager — dedup serves the folder itself and stamps the markup on
 *  the way out. */
export type Framework = "vite" | "next" | "static" | "unknown";

/** The starters dedup can write into an empty folder. */
export type StarterKind = "react" | "html";

/**
 * Active canvas tool (FR-6.1). `text` is a mode rather than a creator: it puts
 * the caret in existing text on the canvas. Inserting a *new* text element is
 * the palette's job, which is a different gesture (arm, then place).
 * `annotate` draws over the artboards instead of into them — it is the one
 * tool whose gestures never reach the user's page or their source.
 */
export type Tool = "select" | "hand" | "browse" | "text" | "annotate";

export interface ProjectInfo {
  root: string;
  name: string;
  packageManager: PackageManager;
  framework: Framework;
  /** What the project is called ("Astro", "Django") — `framework` is only
   *  how dedup drives it, and `unknown` there means "runs its own server". */
  stack: string;
  hasTailwind: boolean;
  hasTypescript: boolean;
  hasGit: boolean;
  /** Nothing here to open — the launch screen offers a starter instead. */
  isEmpty: boolean;
  /** For a static site whose pages sit in a subfolder (`site/`, `www/`), the
   *  folder dedup serves. Element ids stay relative to the project root. */
  staticDir: string | null;
  devScript: string | null;
  /** Which script that was (`dev` or `start`) — the launch needs the name,
   *  not just the body. */
  devScriptName: string | null;
  /** The shell command that starts a project with no package script to run
   *  (Django, Rails, Laravel, Hugo…). When set, it is how the project starts. */
  runCommand: string | null;
  /** False when dedup found no way to start it — the one case the launch
   *  screen stops to ask, and what it asks for is a command. */
  runnable: boolean;
  summary: string;
  /** How dedup will handle this project. Information, never a gate. */
  notes: string[];
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

/**
 * Which spelling a staged snippet is written in.
 *
 * Everything the palette stages is JSX, and `opsForFile` respells it once, at
 * the boundary, for a file that speaks HTML. A *copied* snippet is different:
 * it is a verbatim slice of a real file, so it arrives already in that file's
 * language and there is no translation for an arbitrary subtree — hence the
 * tag, and hence the refusal when the two don't match.
 */
export type SnippetLang = "jsx" | "html";

/**
 * What a copy or a cut put on dedup's clipboard.
 *
 * Two renderings of one element, exactly like a palette entry: the source that
 * will be written (from the write-back, because the file is the truth about
 * what a paste writes) and the picture the canvas shows before the save (from
 * the overlay, because only the page knows what that source rendered as).
 */
export interface Clipboard {
  /** The copied element's own source, de-indented — written on paste. */
  snippet: string;
  lang: SnippetLang;
  /** Rendered HTML, for the staged preview on the canvas. */
  preview: string;
  /** "Card · div" — how the paste reads in the review panel. */
  label: string;
  /** The file it came out of, so a paste elsewhere can say so. */
  file: string;
  /** Components and variables the snippet reads but doesn't carry with it. */
  refs: string[];
  /** True when the copy was a cut — the source element is staged for removal. */
  cut: boolean;
  /** The rest of a multi-selection's copy, in page order. A paste writes
   *  this clip and then each of these, as one gesture. */
  more?: Omit<Clipboard, "cut" | "more">[];
}

export type StructuralAction =
  | { kind: "remove"; target: EditTarget; label: string; gesture?: string }
  | {
      kind: "insert";
      /** One user gesture staged as several actions (a drag between
       *  artboards is a paste *and* a removal) shares an id, so undo and
       *  redo take it as one step — see lib/undo. */
      gesture?: string;
      /** Provisional id for the element being inserted (`pending:…`). It has
       * no source node yet, so it cannot have a real one — but the canvas
       * still needs to address it, or a new element can't be selected, styled
       * or typed into until after it is saved. */
      id: string;
      /** The reference node the new element is placed against. */
      target: EditTarget;
      position: DropPosition;
      /** Markup written to source, in `lang`'s spelling. */
      snippet: string;
      /** The language `snippet` is written in. Palette entries are always
       * JSX (respelled for an HTML page on the way out); a pasted snippet
       * carries the language of the file it was copied from. */
      lang: SnippetLang;
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

/**
 * Drop one staged action — and anything that only made sense because of it.
 *
 * A class or text edit on a not-yet-saved element is addressed to the insert
 * that created it, and has nowhere to land without it: `opsForFile` refuses
 * such an orphan, correctly, and that refusal is permanent. Discarding one row
 * of the review panel could therefore leave a program that can never be saved
 * *and* never be got out of, since the chat refuses to run while any edit
 * targets the file. Deleting an inserted element already took its edits with
 * it; discarding it from the review list has to do the same.
 */
export function withoutAction(actions: EditAction[], index: number): EditAction[] {
  const target = actions[index];
  if (!target) return actions;
  const orphaned =
    target.kind === "insert"
      ? (id: string) => id === target.id
      : () => false;
  return actions.filter(
    (a, i) =>
      i !== index && !(isValueAction(a) && orphaned(a.target.dedupId)),
  );
}

/**
 * Why `next` cannot join the staged program, or null when it can.
 *
 * A staged program must never be able to strand itself. Every combination the
 * editor allows has to be one the write-back will accept — otherwise the user
 * reaches a save that always fails, a chat that refuses while any edit targets
 * the file, and no way forward or back except discarding work.
 *
 * The rule is one sentence: an element on its way out cannot also be a party
 * to another structural edit. Delete a section and the copy you staged beside
 * it has nothing to sit next to; the write-back sees an insertion point inside
 * a chunk it is removing and either refuses or, worse, silently drops the
 * content. Said here, at the moment the second action is made, it is a
 * sentence about what the user just did rather than an error about a program
 * they can no longer see.
 */
export function stagingConflict(
  actions: EditAction[],
  next: EditAction,
): string | null {
  if (isValueAction(next)) return null;

  /** The element ids `a` needs to still exist for it to mean anything. */
  const refs = (a: EditAction): string[] => {
    if (a.kind === "insert") return [a.target.dedupId];
    if (a.kind === "move") return [a.target.dedupId, a.to.dedupId];
    return [];
  };

  if (next.kind === "remove") {
    const blocked = actions.find(
      (a): a is StructuralAction =>
        !isValueAction(a) && refs(a).includes(next.target.dedupId),
    );
    if (!blocked) return null;
    const what =
      blocked.kind === "insert"
        ? `${blocked.label} is staged to go next to this element`
        : `${blocked.label} is staged to move here`;
    return `${what} — save (⌘S) first, then delete it.`;
  }

  const gone = new Set(
    actions
      .filter((a) => a.kind === "remove")
      .map((a) => a.target.dedupId),
  );
  const orphan = refs(next).find((id) => gone.has(id));
  return orphan
    ? "that element is staged for deletion, so there is nothing left to place this against — discard the deletion first, or save it and start from what's on screen."
    : null;
}

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
export function opsForFile(
  actions: EditAction[],
  file?: string,
): {
  ops: EditOp[];
  failures: string[];
} {
  // A plain HTML page spells the same element differently. The snippet is
  // translated once, at the boundary, rather than staging two versions of it.
  const html = file !== undefined && /\.html?$/i.test(file);
  const failures: string[] = [];
  // Pending id → the snippet as edits accumulate, in the spelling that
  // snippet is written in (a pasted one carries its source file's).
  const pending = new Map<string, { snippet: string; lang: SnippetLang }>();
  for (const a of actions) {
    if (a.kind === "insert") pending.set(a.id, { snippet: a.snippet, lang: a.lang });
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
        ? withAttr(current.snippet, classAttrFor(current.lang), a.after)
        : withText(current.snippet, a.after);
    if (next === null) {
      failures.push(
        a.kind === "class"
          ? `those classes can't be applied to the new element`
          : `that text can't be applied to the new element`,
      );
      continue;
    }
    pending.set(a.target.dedupId, { ...current, snippet: next });
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
      case "insert": {
        const staged = pending.get(a.id)?.snippet ?? a.snippet;
        // A snippet already in the destination's language is written as it
        // stands — that is what makes pasting a whole section possible, since
        // no translation exists for an arbitrary subtree. A JSX one bound for
        // an HTML page is respelled, which only the palette's simple markup
        // survives; anything else is refused rather than guessed at.
        let snippet: string | null = staged;
        if (html && a.lang !== "html") snippet = toHtmlSnippet(staged);
        else if (!html && a.lang === "html") snippet = null;
        if (snippet === null) {
          failures.push(
            html
              ? "that element can't be written into an HTML page"
              : "that element was copied from an HTML page and can't be written into a component",
          );
          break;
        }
        ops.push({
          op: "insert",
          target: a.target.index,
          position: a.position,
          snippet,
        });
        break;
      }
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
  /** The colours the page painted it with at selection time (computed CSS
   *  strings). Absent from an overlay built before this was reported. */
  colors?: { background: string | null; text: string | null; border: string | null };
}

/** One chat conversation, persisted per project (localStorage). */
export interface ChatSession {
  id: string;
  /** First instruction, truncated — the label in the session switcher. */
  title: string;
  createdAt: number;
  messages: ChatMessage[];
}

/** One chat message. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** The element the instruction targeted (on user messages). Absent when
   *  nothing was selected — chat works either way. */
  target?: { label: string; file: string };
  /** Short commit hash when this reply's edit was accepted and committed. */
  commit?: string;
  /** Accepted in a project with no git: written into the files in place, so
   *  there is no commit — the transcript says that rather than show none. */
  writtenInPlace?: boolean;
  error?: boolean;
  /** Which backend wrote this reply (assistant messages). Both agents can be
   *  connected and a message can name either (`@claude`, `@codex`), so one
   *  conversation can hold both — the label is how the reader tells them
   *  apart, and how the next turn's transcript does. Absent on messages saved
   *  before there was more than one voice. */
  agent?: CliAgent | "api";
  /** The context lookups dedup ran for this turn, shown as a trace the way an
   *  agent's tool calls are — the user should be able to see what the model
   *  was allowed to look at. */
  tools?: string[];
  /** An edit the model proposed: the files it touches and what it says it
   *  did. The file *contents* live in `pendingEdit` (transient) — a
   *  transcript is persisted per project and has no business holding
   *  snapshots of the user's source. */
  proposal?: { files: string[]; summary: string };
  /** How the proposal ended, once it has. */
  outcome?: "accepted" | "rejected" | "superseded";
}

/** An edit the chat agent proposed and the user has not resolved yet.
 *
 * Nothing here has been written. This is the whole point of the shape: the
 * model's output becomes a diff the user accepts or rejects, and only an
 * accept reaches the parse-gated write-back and the session branch. */
export interface PendingEdit {
  /** The assistant message this proposal belongs to. */
  messageId: string;
  summary: string;
  files: {
    file: string;
    /** null for a file the edit creates. */
    before: string | null;
    after: string;
  }[];
  /** Binaries the agent generated and dedup copied in — images, which have
   * no `after` string to carry. They are new files by construction, so
   * discarding the proposal removes them the same way it removes a created
   * one. */
  assets: { file: string; source: string; agent: CliAgent }[];
  /** Whether `after` is currently on disk so the canvas renders it.
   *
   * A diff says what changed; it does not say how it looks, and looking is the
   * whole reason dedup renders the app at all. So a proposal is written out
   * uncommitted and the running dev server shows it — the same bargain Cursor
   * makes. `before` above is what puts it back, exactly, if the user discards.
   * False when the preview write itself failed. */
  previewing: boolean;
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

export type SidebarTab = "pages" | "layers" | "commit";

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

/** How tall an artboard is: at least the device height, grown to the page's
 *  reported natural height, sanity-capped for runaway layouts. One rule for
 *  the canvas and the export — an export a different height from the
 *  artboard would be a different picture of the same page. */
export function artboardHeight(viewport: Viewport, measured: number | undefined): number {
  return Math.min(Math.max(viewport.height ?? 800, measured ?? 0), 12000);
}

/** One dedup commit on the session branch (FR-5.7). */
export interface HistoryEntry {
  hash: string;
  subject: string;
  when: string;
  files: string[];
}

// --- pushing and landing (src-tauri/src/publish.rs) --------------------------

export interface RemoteInfo {
  name: string;
  /** Credentials already removed. */
  url: string;
}

/** One of the user's branches, measured against the current one. */
export interface BranchSync {
  name: string;
  /** Commits the current branch has that this one lacks. */
  ahead: number;
  /** How many of those are dedup's own saves. */
  dedupAhead: number;
  /** Commits this branch has that the current one lacks — non-zero = diverged. */
  behind: number;
  checkedOutAt: string | null;
  checkedOutHere: boolean;
  /** Commits not on `<remote>/<name>`; null when the remote has no such branch. */
  unpushed: number | null;
}

/** Where the branches stand, from refs alone (no fetch). */
export interface SyncStatus {
  isRepo: boolean;
  /** null on a detached HEAD. */
  branch: string | null;
  detached: boolean;
  onSession: boolean;
  remotes: RemoteInfo[];
  /** The remote a push defaults to. */
  remote: string | null;
  /** Short hashes the remote branch lacks; null = never pushed (or no remote). */
  unpushed: string[] | null;
  /** Commits the remote branch has that this one lacks, as of the last fetch. */
  remoteAhead: number;
  targets: BranchSync[];
}
