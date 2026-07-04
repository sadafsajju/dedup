// TopBar AI backend switch: Claude Code subscription vs raw API key.
// Claude Code is opt-in via an explicit Connect step (consent + live test);
// the API key entry lives here too, out of the Duplicates tab.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";

export function AiSwitch() {
  const claudeCode = useStore((s) => s.claudeCode);
  const aiPref = useStore((s) => s.aiPref);
  const ccConnecting = useStore((s) => s.ccConnecting);
  const ccError = useStore((s) => s.ccError);
  const anthropicKey = useStore((s) => s.anthropicKey);
  const setAnthropicKey = useStore((s) => s.setAnthropicKey);
  const setAiPref = useStore((s) => s.setAiPref);
  const connectClaudeCode = useStore((s) => s.connectClaudeCode);
  const active = useStore((s) => s.activeAiBackend());

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  // Click-away closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const label =
    active === "claude-code"
      ? "AI: Claude Code"
      : active === "api"
        ? "AI: API"
        : "AI: off";

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-md px-2 py-1 text-2xs ${
          open
            ? "bg-surface-3 text-ink"
            : active
              ? "bg-surface-2 text-ink-dim hover:text-ink"
              : "bg-warn/15 text-warn hover:bg-warn/25"
        }`}
        title="Choose how dedup's AI features run"
      >
        {label}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-80 rounded-lg border border-line bg-surface-1 shadow-2xl p-3">
          <div className="text-2xs uppercase tracking-wider text-ink-faint mb-2">
            AI backend
          </div>

          {/* Claude Code subscription */}
          <div
            className={`rounded-md border p-2.5 mb-2 ${
              active === "claude-code"
                ? "border-accent/50 bg-accent/5"
                : "border-line"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-ink">Claude Code</span>
              <span className="text-2xs text-ink-faint">subscription</span>
              <span className="flex-1" />
              {active === "claude-code" ? (
                <span className="text-2xs text-positive">connected ✓</span>
              ) : claudeCode === false ? (
                <span className="text-2xs text-ink-faint">not installed</span>
              ) : (
                <button
                  onClick={connectClaudeCode}
                  disabled={ccConnecting}
                  className="rounded px-2 py-0.5 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-60"
                >
                  {ccConnecting ? "Connecting…" : "Connect"}
                </button>
              )}
            </div>
            <div className="mt-1 text-2xs text-ink-dim leading-relaxed">
              Runs the local <span className="font-mono">claude</span> CLI on
              your plan — no API key. Connecting sends one test prompt to
              verify your login.
            </div>
            {ccError && (
              <div className="mt-1.5 text-2xs text-danger break-words">
                {ccError}
              </div>
            )}
            {active === "claude-code" && (
              <button
                onClick={() => setAiPref(null)}
                className="mt-1.5 text-2xs text-ink-faint hover:text-ink"
              >
                Disconnect
              </button>
            )}
          </div>

          {/* Raw API key */}
          <div
            className={`rounded-md border p-2.5 ${
              active === "api" ? "border-accent/50 bg-accent/5" : "border-line"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-ink">Anthropic API</span>
              <span className="text-2xs text-ink-faint">pay per token</span>
              <span className="flex-1" />
              {active === "api" && (
                <span className="text-2xs text-positive">active ✓</span>
              )}
            </div>
            {anthropicKey ? (
              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-2xs font-mono text-ink-faint">
                  sk-…{anthropicKey.slice(-4)}
                </span>
                {active !== "api" && (
                  <button
                    onClick={() => setAiPref("api")}
                    className="text-2xs text-accent hover:underline"
                  >
                    Use this
                  </button>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => {
                    setAnthropicKey("");
                    if (aiPref === "api") setAiPref(null);
                  }}
                  className="text-2xs text-ink-faint hover:text-ink"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="mt-1.5 flex gap-1">
                <input
                  type="password"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="sk-ant-…"
                  className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-2xs text-ink placeholder:text-ink-faint outline-none focus:ring-1 focus:ring-accent"
                />
                <button
                  onClick={() => {
                    const key = draft.trim();
                    if (!key) return;
                    setAnthropicKey(key);
                    setAiPref("api");
                    setDraft("");
                  }}
                  disabled={!draft.trim()}
                  className="rounded px-2 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            )}
          </div>

          <div className="mt-2 text-2xs text-ink-faint leading-relaxed">
            Used for auto-organizing scans (and merges, later). Prompts carry
            component names and structural outlines only — never source code.
          </div>
        </div>
      )}
    </div>
  );
}
