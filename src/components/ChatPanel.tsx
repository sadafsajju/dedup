// Inspector "Chat" tab — the AI agent.
//
// A canvas selection is *context*, not a precondition: with one, its file and
// the element are attached and named on the chip above the composer; with
// none, the agent starts from the project inventory and asks dedup to read or
// grep its way to the right file. Same composer, same loop either way.
//
// An edit lands as a proposal: written to disk (parse-gated, uncommitted) so
// the running app *shows* it, alongside the diff of what changed. A diff says
// what changed and the canvas says how it looks, and looking is the reason
// dedup renders the app at all. Keep commits it to the dedup session branch;
// Discard puts every file back exactly as it was.
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, Cross2Icon, FileIcon } from "@radix-ui/react-icons";
import { useStore } from "../lib/store";
import { diffLines, diffStat, toHunks } from "../lib/diff";
import { CLI_AGENTS, agentOn, parseDedupId } from "../lib/types";
import type { CliAgent, PendingEdit } from "../lib/types";
import { CopyButton } from "./ui";
import { SetUpGit } from "./SetUpGit";
import { promptsFrom, stepHistory } from "../lib/promptHistory";
import type { HistoryState } from "../lib/promptHistory";
import {
  insertMention,
  mentionAlias,
  mentionAt,
  mentionCandidates,
  routeMention,
  splitMentions,
} from "../lib/mentions";

const labelOf = (agent: CliAgent | "api") =>
  agent === "api"
    ? "Claude (API key)"
    : (CLI_AGENTS.find((a) => a.id === agent)?.label ?? agent);

/** A sent prompt with its `@agent` mentions marked, so it is visible at a
 *  glance which messages went to whom. */
function PromptText({ text }: { text: string }) {
  return (
    <>
      {splitMentions(text).map((run, i) =>
        run.agent ? (
          <span key={i} className="font-medium text-accent">
            {run.text}
          </span>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

/** One file's before/after, narrow enough for the inspector column: no line
 *  gutters, just the sign and the text, scrolling sideways rather than
 *  wrapping (a wrapped diff line reads as two changes). */
function FileDiff({
  file,
  before,
  after,
  open,
}: {
  file: string;
  before: string | null;
  after: string;
  open: boolean;
}) {
  const [show, setShow] = useState(open);
  const { hunks, stat } = useMemo(() => {
    const lines = diffLines(before ?? "", after);
    return { hunks: toHunks(lines, 2), stat: diffStat(lines) };
  }, [before, after]);

  return (
    <div className="rounded-md border border-line bg-surface-1 overflow-hidden">
      <button
        onClick={() => setShow((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-surface-2"
      >
        <FileIcon width={11} height={11} className="text-ink-faint shrink-0" />
        <span className="font-mono text-2xs truncate flex-1">{file}</span>
        {before === null && (
          <span className="text-2xs text-positive shrink-0">new</span>
        )}
        <span className="text-2xs tabular-nums shrink-0">
          <span className="text-positive">+{stat.added}</span>{" "}
          <span className="text-danger">−{stat.removed}</span>
        </span>
      </button>
      {show && (
        <div className="border-t border-line overflow-x-auto max-h-64 overflow-y-auto">
          {hunks.map((hunk, i) => (
            <div key={i}>
              {i > 0 && (
                <div className="px-2 py-0.5 text-[10px] text-ink-faint bg-surface-2/60">
                  ⋯
                </div>
              )}
              {hunk.lines.map((line, j) => (
                <div
                  key={j}
                  className={`flex font-mono text-[11px] leading-[1.45] ${
                    line.op === "add"
                      ? "bg-positive/10"
                      : line.op === "remove"
                        ? "bg-danger/10"
                        : ""
                  }`}
                >
                  <span
                    className={`w-3.5 shrink-0 select-none text-center ${
                      line.op === "add"
                        ? "text-positive"
                        : line.op === "remove"
                          ? "text-danger"
                          : "text-ink-faint"
                    }`}
                  >
                    {line.op === "add" ? "+" : line.op === "remove" ? "−" : " "}
                  </span>
                  <pre className="flex-1 whitespace-pre pr-2 text-ink">
                    {line.text || " "}
                  </pre>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The unresolved proposal: the diff, and the two buttons that decide.
 *
 *  While it is here the edit is already on disk and on the canvas — that is
 *  the only way to see how a change *looks*, which a diff cannot tell you. It
 *  is not committed: Keep commits it to the session branch, Discard puts every
 *  file back exactly as dedup found it. */
function Proposal({ edit, busy }: { edit: PendingEdit; busy: boolean }) {
  const accept = useStore((s) => s.acceptChatEdit);
  const reject = useStore((s) => s.rejectChatEdit);
  return (
    <div className="mt-1.5 space-y-1.5">
      {edit.files.map((f, i) => (
        <FileDiff
          key={f.file}
          file={f.file}
          before={f.before}
          after={f.after}
          open={i === 0 && edit.files.length <= 2}
        />
      ))}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => void accept()}
          disabled={busy}
          className="flex items-center gap-1 rounded px-2 py-1 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-40"
        >
          <CheckIcon width={11} height={11} />
          Keep {edit.files.length > 1 ? `${edit.files.length} files` : ""}
        </button>
        <button
          onClick={() => void reject()}
          disabled={busy}
          className="rounded px-2 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink disabled:opacity-40"
        >
          Discard
        </button>
        <span className="text-2xs text-ink-faint">
          {edit.previewing ? "live on canvas · not committed" : "not written"}
        </span>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const selected = useStore((s) => s.selected);
  const sessions = useStore((s) => s.chatSessions);
  const activeChatId = useStore((s) => s.activeChatId);
  const chatBusy = useStore((s) => s.chatBusy);
  const pendingEdit = useStore((s) => s.pendingEdit);
  const sendChat = useStore((s) => s.sendChat);
  const clearSelection = useStore((s) => s.clearSelection);
  const newChatSession = useStore((s) => s.newChatSession);
  const selectChatSession = useStore((s) => s.selectChatSession);
  const deleteChatSession = useStore((s) => s.deleteChatSession);
  const backend = useStore((s) => s.activeAiBackend());
  const agents = useStore((s) => s.agents);
  const chatActivity = useStore((s) => s.chatActivity);
  const noGit = useStore((s) => s.git?.isRepo === false);
  const chat = sessions.find((x) => x.id === activeChatId)?.messages ?? [];

  const [draft, setDraft] = useState("");
  // The `@` autocomplete: where the caret is, which row is highlighted, and
  // which mention the user waved away with Escape (by its start offset, so a
  // new `@` elsewhere opens it again).
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Where ↑/↓ have walked to, if anywhere. The rules live in
  // lib/promptHistory (pure, and tested — the edges are invisible on screen);
  // this holds the position and hands keystrokes to it.
  const walk = useRef<HistoryState>({ at: null, stash: "", draft: "" });

  /** This conversation's own prompts, newest first. */
  const history = useMemo(() => promptsFrom(chat), [chat]);

  // A different conversation has a different history; being three entries
  // into the old one is meaningless in the new.
  useEffect(() => {
    walk.current = { at: null, stash: "", draft: "" };
  }, [activeChatId]);

  // Seconds counter while the AI works — a silent bubble reads as a freeze.
  useEffect(() => {
    if (!chatBusy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [chatBusy]);

  // Keep the newest message in view (also on session switch).
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat.length, chatBusy, activeChatId, pendingEdit]);

  const src = selected ? parseDedupId(selected.dedupId) : null;
  const connected = (a: CliAgent) => agentOn(agents[a]);
  const anyConnected = !!backend || CLI_AGENTS.some((a) => connected(a.id));
  // A mention routes the message, so it can be sent with no default chosen —
  // and a bare "@codex" asks nothing, so it can't be sent at all. (A mention
  // of an agent that is off *is* sendable: the reply says so, which is
  // clearer than a Send button that is grey for no visible reason.)
  const routed = routeMention(draft);
  const canSend =
    !chatBusy && routed.instruction !== "" && (!!backend || routed.agent !== null);

  const query = mentionAt(draft, caret);
  const candidates = query ? mentionCandidates(query.query) : [];
  const popupOpen =
    !!query && candidates.length > 0 && dismissedAt !== query.start && !chatBusy;
  const highlighted = Math.min(pick, Math.max(0, candidates.length - 1));

  const choose = (agent: CliAgent) => {
    if (!query) return;
    const next = insertMention(draft, query, agent);
    setDraft(next.text);
    setCaret(next.caret);
    setPick(0);
    walk.current = { at: null, stash: "", draft: next.text };
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (!box) return;
      box.focus();
      box.selectionStart = box.selectionEnd = next.caret;
    });
  };

  /** The popup's keys, taken before the composer's own: while it is open,
   *  ↑/↓ move the highlight and Enter/Tab choose, rather than walking prompt
   *  history and sending a half-typed `@co`. Returns whether it took the key. */
  const onMentionKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!popupOpen || !query) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = candidates.length;
      setPick((highlighted + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      choose(candidates[highlighted]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissedAt(query.start);
      return true;
    }
    return false;
  };

  const send = () => {
    if (!canSend) return;
    void sendChat(draft);
    setDraft("");
    setCaret(0);
    setDismissedAt(null);
    walk.current = { at: null, stash: "", draft: "" };
  };

  /**
   * Hand ↑/↓ to the history, and only take them when it takes them — inside a
   * multi-line draft those keys belong to the caret, or the box cannot be
   * edited. Which edge the caret is on is the one thing the state machine
   * cannot work out for itself, so it is measured here.
   */
  const onHistoryKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const el = e.currentTarget;
    const collapsed = el.selectionStart === el.selectionEnd;
    const next = stepHistory({ ...walk.current, draft }, history, {
      key: e.key,
      atFirstLine: collapsed && !el.value.slice(0, el.selectionStart).includes("\n"),
      atLastLine: collapsed && !el.value.slice(el.selectionEnd).includes("\n"),
    });
    if (!next) return; // the caret's key, not ours
    e.preventDefault();
    walk.current = next;
    setDraft(next.draft);
    // Caret to the end of what was recalled, the way every shell and message
    // box does it — the point of recalling a prompt is to edit its tail.
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (!box) return;
      box.selectionStart = box.selectionEnd = box.value.length;
      box.scrollTop = box.scrollHeight;
    });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Session switcher — past chats persist per project. */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-line">
        <select
          value={activeChatId ?? ""}
          onChange={(e) => selectChatSession(e.target.value || null)}
          className="min-w-0 flex-1 rounded bg-surface-2 px-1.5 py-1 text-2xs text-ink outline-none focus:ring-1 focus:ring-accent"
          title="Chat history for this project"
        >
          <option value="">New chat</option>
          {[...sessions].reverse().map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || "Untitled"}
            </option>
          ))}
        </select>
        <button
          onClick={newChatSession}
          disabled={chatBusy || activeChatId === null}
          title="Start a new chat"
          className="shrink-0 rounded px-1.5 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink disabled:opacity-40"
        >
          +
        </button>
        {activeChatId && (
          <button
            onClick={() => deleteChatSession(activeChatId)}
            disabled={chatBusy}
            title="Delete this chat"
            className="shrink-0 rounded px-1.5 py-1 text-2xs bg-surface-2 text-ink-faint hover:text-danger disabled:opacity-40"
          >
            ✕
          </button>
        )}
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {chat.length === 0 && (
          <div className="text-2xs text-ink-faint leading-relaxed">
            Ask for anything in this project — &ldquo;make this a secondary
            button&rdquo;, &ldquo;where is the login form handled?&rdquo;,
            &ldquo;extract this list item into its own component&rdquo;. Select
            an element on the canvas to point at it; with nothing selected the
            AI searches the project itself. Every edit shows up on the canvas
            first, uncommitted, with its diff — keep it or put it back.
          </div>
        )}
        {chat.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="group ml-4">
              {m.target && (
                <div className="text-2xs text-ink-faint mb-0.5 text-right truncate">
                  {m.target.label}
                  <span className="font-mono"> · {m.target.file}</span>
                </div>
              )}
              {/* Copy sits in the gutter beside the bubble, out of the way
                  until the pointer is on the message. Kept visible on focus
                  too — hover-only would put it out of reach of the keyboard. */}
              <div className="flex items-start gap-1">
                <CopyButton
                  text={m.text}
                  title="Copy this prompt"
                  className="mt-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                />
                <div className="min-w-0 flex-1 rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs text-ink whitespace-pre-wrap break-words">
                  <PromptText text={m.text} />
                </div>
              </div>
            </div>
          ) : (
            <div key={m.id} className="mr-4">
              {/* Who answered — one conversation can hold both agents. */}
              {m.agent && (
                <div className="mb-0.5 text-2xs text-ink-faint">{labelOf(m.agent)}</div>
              )}
              {/* What the model was allowed to look at, and did. */}
              {m.tools && m.tools.length > 0 && (
                <div className="mb-1 space-y-0.5">
                  {m.tools.map((t, i) => (
                    <div
                      key={i}
                      className="font-mono text-[10px] text-ink-faint truncate"
                    >
                      ↳ {t}
                    </div>
                  ))}
                </div>
              )}
              <div
                className={`rounded-lg px-2.5 py-1.5 text-xs whitespace-pre-wrap break-words ${
                  m.error ? "bg-danger/10 text-danger" : "bg-surface-2 text-ink"
                }`}
              >
                {m.text}
              </div>
              {m.proposal &&
                (pendingEdit?.messageId === m.id ? (
                  <Proposal edit={pendingEdit} busy={chatBusy} />
                ) : (
                  <div className="mt-0.5 text-2xs text-ink-faint">
                    {m.outcome === "accepted" ? (
                      <span className="text-positive">
                        {m.writtenInPlace ? (
                          "kept · written into the files (no git)"
                        ) : (
                          <>
                            kept · <span className="font-mono">{m.commit}</span>
                          </>
                        )}
                      </span>
                    ) : m.outcome === "rejected" ? (
                      "discarded — the files were put back"
                    ) : (
                      "superseded by a later answer"
                    )}
                    <span className="font-mono">
                      {" "}
                      · {m.proposal.files.join(", ")}
                    </span>
                  </div>
                ))}
            </div>
          ),
        )}
        {chatBusy && (
          <div className="mr-4 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-ink-dim animate-pulse">
            {chatActivity ?? "Working…"}
            {elapsed >= 5 ? ` ${elapsed}s` : ""}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2.5">
        {noGit && (
          // Questions still work without git; changes can't be kept, so the
          // agent won't propose one — said before the user asks, not after.
          <div className="mb-2 rounded bg-warn/10 px-2 py-1.5 text-2xs text-warn leading-relaxed">
            This folder isn&rsquo;t a git repository, so keeping a change
            writes it straight into your files — there&rsquo;s no branch or
            commit to undo it. Set up git to keep a history instead
            {pendingEdit?.previewing ? " (the preview above is kept)." : "."}
            <div className="mt-1.5">
              <SetUpGit />
            </div>
          </div>
        )}
        {!anyConnected ? (
          <div className="text-2xs text-warn leading-relaxed mb-1.5">
            Switch on an AI backend (top-bar AI menu) to chat.
          </div>
        ) : selected && src ? (
          // The selection *is* the attached context, so removing the chip
          // clears the selection rather than pretending to be a second state.
          <div className="mb-1.5 flex items-center gap-1 rounded bg-surface-2 px-1.5 py-1 text-2xs">
            <span className="text-ink-dim shrink-0">
              {selected.component ?? selected.tag}
            </span>
            <span className="font-mono text-ink-faint truncate">
              {src.file}
            </span>
            <span className="flex-1" />
            <button
              onClick={clearSelection}
              title="Chat about the whole project instead"
              className="shrink-0 text-ink-faint hover:text-ink"
            >
              <Cross2Icon width={10} height={10} />
            </button>
          </div>
        ) : (
          <div className="mb-1.5 text-2xs text-ink-faint">
            Whole project — select an element to point at one.
          </div>
        )}
        <div className="relative">
          {popupOpen && (
            // Above the box, not below: the composer sits at the bottom of the
            // panel, and a list opening downward would open off-screen.
            <div
              role="listbox"
              className="panel absolute bottom-full left-0 right-0 mb-1 z-10 rounded-md py-1"
            >
              {candidates.map((a, i) => (
                <button
                  key={a}
                  role="option"
                  aria-selected={i === highlighted}
                  // mousedown, not click: a click would blur the textarea first
                  // and the caret position the insert depends on would be lost.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(a);
                  }}
                  onMouseEnter={() => setPick(i)}
                  className={`w-full flex items-center gap-2 px-2 py-1 text-left text-2xs ${
                    i === highlighted ? "bg-surface-2 text-ink" : "text-ink-dim"
                  }`}
                >
                  <span className="font-mono text-accent">@{mentionAlias(a)}</span>
                  <span className="flex-1 truncate">{labelOf(a)}</span>
                  <span className={connected(a) ? "text-positive" : "text-ink-faint"}>
                    {connected(a) ? "on" : "off"}
                  </span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={draft}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart);
              setPick(0);
              // Typing makes it theirs again: the next ↑ stashes what they have
              // now and starts from the newest, so an edit is never overwritten
              // by a recall without being recoverable.
              walk.current = { at: null, stash: "", draft: e.target.value };
            }}
            onKeyDown={(e) => {
              if (onMentionKey(e)) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
                return;
              }
              onHistoryKey(e);
            }}
            placeholder="What should change? (Enter to send, ↑ for earlier prompts, @ to pick an agent)"
            disabled={!anyConnected || chatBusy}
            rows={3}
            className="w-full resize-none rounded-md bg-surface-2 px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-2xs text-ink-faint leading-tight flex-1">
            Sends the files it reads to your AI backend.
          </span>
          <button
            onClick={send}
            disabled={!canSend}
            className="rounded px-2.5 py-1 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-40"
          >
            {chatBusy ? "Working…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
