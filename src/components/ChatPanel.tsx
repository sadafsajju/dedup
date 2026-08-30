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
import { parseDedupId } from "../lib/types";
import type { PendingEdit } from "../lib/types";
import { CopyButton } from "./ui";
import { promptsFrom, stepHistory } from "../lib/promptHistory";
import type { HistoryState } from "../lib/promptHistory";

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
  const chat = sessions.find((x) => x.id === activeChatId)?.messages ?? [];

  const [draft, setDraft] = useState("");
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
  const canSend = !!backend && !chatBusy && draft.trim() !== "";

  const send = () => {
    if (!canSend) return;
    void sendChat(draft);
    setDraft("");
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
                  {m.text}
                </div>
              </div>
            </div>
          ) : (
            <div key={m.id} className="mr-4">
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
                        kept · <span className="font-mono">{m.commit}</span>
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
            Working…{elapsed >= 5 ? ` ${elapsed}s` : ""}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2.5">
        {!backend ? (
          <div className="text-2xs text-warn leading-relaxed mb-1.5">
            Connect an AI backend (top-bar AI switch) to chat.
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
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Typing makes it theirs again: the next ↑ stashes what they have
            // now and starts from the newest, so an edit is never overwritten
            // by a recall without being recoverable.
            walk.current = { at: null, stash: "", draft: e.target.value };
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
              return;
            }
            onHistoryKey(e);
          }}
          placeholder="What should change? (Enter to send, ↑ for earlier prompts)"
          disabled={!backend || chatBusy}
          rows={3}
          className="w-full resize-none rounded-md bg-surface-2 px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
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
