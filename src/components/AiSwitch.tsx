// AI backends: coding-agent CLIs the user already pays for, and a raw API key
// — each with its own on/off switch. Lives in Settings → AI (⌘,), and only
// there.
//
// Switches rather than one choice, because a chat message names its agent
// (`@claude`, `@codex`): with both on, both are one `@` away, and the only
// remaining question is who answers when nobody was named — the first one on,
// marked "default".
//
// Every CLI agent is still opt-in through a live round-trip: switching one on
// for the first time *is* Connect, and the switch only lands on if the test
// passes — the one thing "installed" doesn't tell you. dedup never spends
// someone's subscription before that.
//
// The cards are generated from CLI_AGENTS rather than written per agent, so
// adding a third is a row in that list.
import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { CLI_AGENTS, agentOn } from "../lib/types";
import { mentionAlias } from "../lib/mentions";

/** An on/off switch. `busy` shows the knob mid-travel while a first switch-on
 *  runs its test prompt, so a slow Connect doesn't read as a dead control. */
function Toggle({
  on,
  busy = false,
  disabled = false,
  label,
  onChange,
}: {
  on: boolean;
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={() => onChange(!on)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-accent" : "bg-surface-3"
      } ${busy ? "animate-pulse" : ""}`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left] ${
          busy ? "left-2" : on ? "left-3.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** One agent's card: its switch, model picker, and last error. */
function AgentCard({
  meta,
  isDefault,
}: {
  meta: (typeof CLI_AGENTS)[number];
  /** Answers messages that name no agent (and the non-chat AI features). */
  isDefault: boolean;
}) {
  const state = useStore((s) => s.agents[meta.id]);
  const setEnabled = useStore((s) => s.setAgentEnabled);
  const setModel = useStore((s) => s.setAgentModel);
  const on = agentOn(state);

  // The static list ("CLI default" + any stable aliases), then whatever the
  // installed CLI says it offers, then a saved model neither knows — kept so
  // the select shows the truth instead of silently snapping to the default.
  const models = [...meta.models];
  for (const m of state.catalog ?? []) {
    if (!models.some((x) => x.value === m.value)) models.push(m);
  }
  if (state.model && !models.some((x) => x.value === state.model)) {
    models.push({ value: state.model, label: `${state.model} (saved)` });
  }

  return (
    <div
      className={`rounded-lg border p-2.5 mb-2 ${
        on ? "border-accent/50 bg-accent/5" : "border-line"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-ink">{meta.label}</span>
        <span className="font-mono text-2xs text-ink-faint">@{mentionAlias(meta.id)}</span>
        <span className="flex-1" />
        {state.installed === false ? (
          <span className="text-2xs text-ink-faint">not installed</span>
        ) : state.connecting ? (
          <span className="text-2xs text-ink-faint">testing…</span>
        ) : (
          isDefault && <span className="text-2xs text-positive">default</span>
        )}
        <Toggle
          on={on}
          busy={state.connecting}
          disabled={state.installed === false}
          label={on ? `Turn ${meta.label} off` : `Turn ${meta.label} on`}
          onChange={(next) => void setEnabled(meta.id, next)}
        />
      </div>

      <div className="mt-1 text-2xs text-ink-dim leading-relaxed">
        Runs the local <span className="font-mono">{meta.command}</span> CLI on
        your {meta.detail} — no API key.{" "}
        {state.consent
          ? `Type @${mentionAlias(meta.id)} in chat to ask it directly.`
          : "Switching it on sends one test prompt to check it's signed in."}
      </div>

      {models.length > 1 && (
        <div className="mt-1.5 flex items-center gap-2">
          <label className="text-2xs text-ink-faint" htmlFor={`${meta.id}-model`}>
            Model
          </label>
          <select
            id={`${meta.id}-model`}
            value={state.model ?? ""}
            onChange={(e) => setModel(meta.id, e.target.value || null)}
            className="min-w-0 flex-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-2xs text-ink outline-none focus:ring-1 focus:ring-accent"
          >
            {models.map((m) => (
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
    </div>
  );
}

/** Settings → AI: the agents' cards and the API key. */
export function AiBackends() {
  const anthropicKey = useStore((s) => s.anthropicKey);
  const apiEnabled = useStore((s) => s.apiEnabled);
  const setAnthropicKey = useStore((s) => s.setAnthropicKey);
  const setApiEnabled = useStore((s) => s.setApiEnabled);
  const detectAgent = useStore((s) => s.detectAgent);
  const loadAgentModels = useStore((s) => s.loadAgentModels);
  const active = useStore((s) => s.activeAiBackend());
  const [draft, setDraft] = useState("");

  // Ask each installed CLI for its models when the section is first shown.
  // Each is asked once per app run (the store remembers the answer).
  useEffect(() => {
    for (const meta of CLI_AGENTS) {
      void detectAgent(meta.id).then(() => loadAgentModels(meta.id));
    }
  }, [detectAgent, loadAgentModels]);

  const apiOn = apiEnabled && !!anthropicKey;

  return (
    <div>
      {CLI_AGENTS.map((meta) => (
        <AgentCard key={meta.id} meta={meta} isDefault={active === meta.id} />
      ))}

      {/* Raw API key */}
      <div
        className={`rounded-lg border p-2.5 ${
          apiOn ? "border-accent/50 bg-accent/5" : "border-line"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink">Anthropic API</span>
          <span className="text-2xs text-ink-faint">pay per token</span>
          <span className="flex-1" />
          {active === "api" && <span className="text-2xs text-positive">default</span>}
          {anthropicKey && (
            <Toggle
              on={apiOn}
              label={apiOn ? "Turn the API key off" : "Turn the API key on"}
              onChange={setApiEnabled}
            />
          )}
        </div>
        {anthropicKey ? (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-2xs font-mono text-ink-faint">sk-…{anthropicKey.slice(-4)}</span>
            <span className="flex-1" />
            <button
              onClick={() => {
                setAnthropicKey("");
                setApiEnabled(false);
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
                setApiEnabled(true);
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

      <p className="mt-3 text-2xs text-ink-faint leading-relaxed">
        A chat message goes to the agent it @mentions; with no mention — and for
        organizing scans and merges — the first one that&rsquo;s on answers. The
        API key is used only when no agent is on.
      </p>
    </div>
  );
}
