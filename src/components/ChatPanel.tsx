// Inspector "Chat" tab: instruct the AI about the selected element; edits are
// parse-gated by the sidecar and land as commits on the session branch. This
// is the one AI feature that sends the selected file's source to the backend
// — the composer says so (honesty over magic).
import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { parseDedupId } from "../lib/types";

export function ChatPanel() {
  const selected = useStore((s) => s.selected);
  const sessions = useStore((s) => s.chatSessions);
  const activeChatId = useStore((s) => s.activeChatId);
  const chatBusy = useStore((s) => s.chatBusy);
  const sendChat = useStore((s) => s.sendChat);
  const newChatSession = useStore((s) => s.newChatSession);
  const selectChatSession = useStore((s) => s.selectChatSession);
  const deleteChatSession = useStore((s) => s.deleteChatSession);
  const backend = useStore((s) => s.activeAiBackend());
  const chat = sessions.find((x) => x.id === activeChatId)?.messages ?? [];

  const [draft, setDraft] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

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
  }, [chat.length, chatBusy, activeChatId]);

  const src = selected ? parseDedupId(selected.dedupId) : null;
  const canSend = !!selected && !!backend && !chatBusy && draft.trim() !== "";

  const send = () => {
    if (!canSend) return;
    void sendChat(draft);
    setDraft("");
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
            Select an element on the canvas, then tell the AI what to change —
            &ldquo;make this a secondary button&rdquo;, &ldquo;add a loading
            state&rdquo;, &ldquo;extract this list item into its own
            component&rdquo;. Each applied edit is one commit on the dedup
            session branch.
          </div>
        )}
        {chat.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="ml-4">
              {m.target && (
                <div className="text-2xs text-ink-faint mb-0.5 text-right truncate">
                  {m.target.label}
                  <span className="font-mono"> · {m.target.file}</span>
                </div>
              )}
              <div className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs text-ink whitespace-pre-wrap break-words">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={m.id} className="mr-4">
              <div
                className={`rounded-lg px-2.5 py-1.5 text-xs whitespace-pre-wrap break-words ${
                  m.error
                    ? "bg-danger/10 text-danger"
                    : "bg-surface-2 text-ink"
                }`}
              >
                {m.text}
              </div>
              {m.commit && (
                <div className="mt-0.5 text-2xs text-positive">
                  committed <span className="font-mono">{m.commit}</span>
                </div>
              )}
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
          <div className="text-2xs text-warn leading-relaxed">
            Connect an AI backend (top-bar AI switch) to chat-edit.
          </div>
        ) : !selected ? (
          <div className="text-2xs text-ink-faint leading-relaxed">
            Select an element on the canvas to chat about it.
          </div>
        ) : (
          <div className="text-2xs text-ink-faint mb-1.5 truncate">
            To:{" "}
            <span className="text-ink-dim">
              {selected.component ?? selected.tag}
            </span>
            {src && <span className="font-mono"> · {src.file}</span>}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            selected ? "What should change? (Enter to send)" : "Select an element first"
          }
          disabled={!selected || !backend || chatBusy}
          rows={3}
          className="w-full resize-none rounded-md bg-surface-2 px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
        <div className="mt-1 flex items-center gap-2">
          <span className="text-2xs text-ink-faint leading-tight flex-1">
            Sends this file&rsquo;s source to your AI backend.
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
