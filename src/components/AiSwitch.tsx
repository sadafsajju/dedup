// TopBar AI backend switch: a coding-agent CLI the user already pays for, or
// a raw API key.
//
// Every CLI agent is opt-in through an explicit Connect step — a live
// round-trip that proves the binary is there *and* signed in, which is the one
// thing "installed" doesn't tell you. dedup never spends someone's
// subscription before that succeeds.
//
// The cards are generated from CLI_AGENTS rather than written per agent, so
// adding a third is a row in that list.
import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { CLI_AGENTS } from "../lib/types";
import type { CliAgent } from "../lib/types";

/** One agent's card: state, Connect, model picker, and its last error. */
function AgentCard({
  meta,
  active,
}: {
  meta: (typeof CLI_AGENTS)[number];
  active: boolean;
}) {
  const state = useStore((s) => s.agents[meta.id]);
  const connect = useStore((s) => s.connectAgent);
  const setModel = useStore((s) => s.setAgentModel);
  const setAiPref = useStore((s) => s.setAiPref);

  return (
    <div
      className={`rounded-lg border p-2.5 mb-2 ${
        active ? "border-accent/50 bg-accent/5" : "border-line"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-ink">{meta.label}</span>
        <span className="text-2xs text-ink-faint">{meta.detail}</span>
        <span className="flex-1" />
        {active ? (
          <span className="text-2xs text-positive">connected ✓</span>
        ) : state.installed === false ? (
          <span className="text-2xs text-ink-faint">not installed</span>
        ) : (
          <button
            onClick={() => void connect(meta.id)}
            disabled={state.connecting}
            className="rounded-md px-2 py-0.5 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-60"
          >
            {state.connecting ? "Connecting…" : state.consent ? "Use this" : "Connect"}
          </button>
        )}
      </div>

      <div className="mt-1 text-2xs text-ink-dim leading-relaxed">
        Runs the local <span className="font-mono">{meta.command}</span> CLI on
        your plan — no API key. Connecting sends one test prompt to check it's
        signed in.
      </div>

      {meta.models.length > 1 && (
        <div className="mt-1.5 flex items-center gap-2">
          <label className="text-2xs text-ink-faint" htmlFor={`${meta.id}-model`}>
            Model
          </label>
          <select
            id={`${meta.id}-model`}
            value={state.model ?? ""}
            onChange={(e) => setModel(meta.id, e.target.value || null)}
            className="rounded-md bg-surface-2 px-1.5 py-0.5 text-2xs text-ink outline-none focus:ring-1 focus:ring-accent"
          >
            {meta.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {state.error && (
        <div className="mt-1.5 whitespace-pre-wrap text-2xs text-danger break-words">
          {state.error}
        </div>
      )}

      {active && (
        <button
          onClick={() => setAiPref(null)}
          className="mt-1.5 text-2xs text-ink-faint hover:text-ink"
        >
          Disconnect
        </button>
      )}
    </div>
  );
}

export function AiSwitch() {
  const aiPref = useStore((s) => s.aiPref);
  const anthropicKey = useStore((s) => s.anthropicKey);
  const setAnthropicKey = useStore((s) => s.setAnthropicKey);
  const setAiPref = useStore((s) => s.setAiPref);
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

  const label = !active
    ? "AI: off"
    : active === "api"
      ? "AI: API"
      : `AI: ${CLI_AGENTS.find((a) => a.id === active)?.label ?? active}`;

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
        <div className="panel absolute right-0 top-full mt-1.5 z-50 w-80 p-3">
          <div className="text-2xs uppercase tracking-wider text-ink-faint mb-2">
            AI backend
          </div>

          {CLI_AGENTS.map((meta) => (
            <AgentCard
              key={meta.id}
              meta={meta}
              active={active === (meta.id as CliAgent)}
            />
          ))}

          {/* Raw API key */}
          <div
            className={`rounded-lg border p-2.5 ${
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
