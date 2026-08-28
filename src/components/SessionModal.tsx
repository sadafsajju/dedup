// Mock-session setup (zero-login editing). Protected routes redirect the
// canvas to the login page; this modal lets the user install a reviewed
// browser-storage seed that makes the app's own client guard consider itself
// signed in — the real page then renders and its visuals become editable.
//
// Honesty over magic, applied to auth:
// - the seed is always shown and editable before it can be enabled; the AI
//   only drafts it (from the project's own auth source), never applies it;
// - it can only write browser storage — the tagger's wrapper gates it to
//   framed canvas pages and swallows failures, and dedup never scripts a
//   real login or stores credentials;
// - while enabled, every canvas frame label carries a "mock session" badge.
import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import {
  Cross2Icon,
  EnterIcon,
  LockOpen1Icon,
  MagicWandIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";

export function SessionModal() {
  const open = useStore((s) => s.sessionModalOpen);
  const close = useStore((s) => s.closeSessionModal);
  const seed = useStore((s) => s.sessionSeed);
  const busy = useStore((s) => s.sessionBusy);
  const error = useStore((s) => s.sessionError);
  const save = useStore((s) => s.saveSessionSeed);
  const generate = useStore((s) => s.generateSessionSeed);
  const backend = useStore((s) => s.activeAiBackend());
  const signIn = useStore((s) => s.startCanvasSignIn);
  const reloadFrames = useStore((s) => s.reloadPinnedFrames);
  const setTool = useStore((s) => s.setTool);
  const provider = useStore((s) => s.authProvider);
  const [showSeed, setShowSeed] = useState(false);

  const [script, setScript] = useState(seed?.script ?? "");
  // AI drafts land in the store; mirror them into the editor. Also picks up
  // the initial load, which may finish after the modal mounts.
  useEffect(() => {
    setScript(seed?.script ?? "");
  }, [seed?.script]);

  if (!open) return null;
  const enabled = seed?.enabled ?? false;
  const canEnable = script.trim().length > 0;

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-8"
      onClick={close}
    >
      <div
        className="w-full max-w-xl max-h-full flex flex-col rounded-xl border border-line bg-surface-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-line">
          <LockOpen1Icon width={15} height={15} className="text-ink-dim" />
          <span className="text-sm font-medium">Zero-login editing</span>
          {enabled && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-2xs text-warn">
              mock session active
            </span>
          )}
          <span className="flex-1" />
          <button onClick={close} className="text-ink-faint hover:text-ink">
            <Cross2Icon width={14} height={14} />
          </button>
        </div>

        {/* The real-login path leads: it is accurate by construction, needs
            no provider knowledge, and returns real tokens (so data loads too,
            not just the shell). The seed below is for when signing in isn't
            possible. */}
        <div className="px-4 py-3 border-b border-line flex flex-col gap-2.5">
          <div className="text-2xs text-ink-dim leading-5">
            Every canvas frame shares one browser session, so signing in{" "}
            <span className="text-ink">once</span> unlocks every protected page
            — with real tokens, so your data loads too.
          </div>
          {/* The answer to "why did Draft with AI just refuse?", given before
              the user spends a call finding out. */}
          {provider && !provider.seedable && (
            <div className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2 text-2xs text-ink-dim leading-5">
              This project uses{" "}
              <span className="text-ink font-medium">{provider.name}</span>,
              which keeps the session in {provider.storage} — a seed can't
              reach that. Signing in is the only path here.
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={signIn}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-2xs font-medium bg-accent text-white hover:brightness-110"
            >
              <EnterIcon width={12} height={12} />
              Sign in on the canvas
            </button>
            <button
              onClick={() => {
                // Back to inspect: browse mode deliberately stops dedup from
                // reacting to redirects, so leaving it is what re-arms the
                // signed-out fallback for pages guarded against logged-in
                // users — which is exactly what a fresh login creates.
                setTool("select");
                reloadFrames();
                close();
              }}
              title="Already signed in? Bring every artboard back to its own route."
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-2xs bg-surface-2 text-ink-dim hover:text-ink"
            >
              <ReloadIcon width={12} height={12} />
              I'm signed in — reload pages
            </button>
          </div>
          <div className="text-2xs text-ink-faint leading-5">
            Switches to browse mode so your app's own login form works. Use a
            dev/staging account — the session lives in dedup's webview for this
            dev-server origin.
          </div>
        </div>

        {/* An active seed is always shown — it is affecting what the user
            sees, so it must never be a click away from being noticed. */}
        {!showSeed && !enabled ? (
          <button
            onClick={() => setShowSeed(true)}
            className="px-4 py-3 text-left text-2xs text-ink-dim hover:text-ink"
          >
            Can't sign in? Use a mock-session seed instead →
          </button>
        ) : (
        <div className="p-4 flex flex-col gap-2 min-h-0">
          <div className="text-2xs text-ink-dim leading-5">
            A seed runs inside dedup's canvas frames before your app boots,
            writing the browser storage your app's own guard checks. It can
            only touch{" "}
            <span className="font-mono text-ink">localStorage</span>/
            <span className="font-mono text-ink">sessionStorage</span>/
            <span className="font-mono text-ink">cookies</span>, never your
            source — so it can't help when an SDK keeps the session in
            IndexedDB. Server-fetched data will still come back signed-out; the
            page's layout renders, which is what dedup edits.
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xs text-ink-dim">Seed script</span>
            <span className="flex-1" />
            <button
              onClick={generate}
              disabled={busy || provider?.seedable === false}
              title={
                provider?.seedable === false
                  ? `${provider.name} stores its session in ${provider.storage} — no seed can reach it. Sign in instead.`
                  : backend
                    ? "Read the project's auth code and draft the matching seed"
                    : "Connect an AI backend (top bar) to draft the seed — or write it by hand"
              }
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink disabled:opacity-50"
            >
              <MagicWandIcon width={12} height={12} />
              {busy ? "Working…" : "Draft with AI"}
            </button>
          </div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            spellCheck={false}
            placeholder={`localStorage.setItem("authToken", "dedup-mock");\nlocalStorage.setItem("user", JSON.stringify({ id: 1, name: "Dedup" }));`}
            className="w-full h-48 resize-y rounded-md border border-line bg-surface-1 p-2.5 font-mono text-2xs leading-5 text-ink outline-none focus:border-accent"
          />
          {error && <div className="text-2xs text-danger">{error}</div>}
        </div>
        )}

        {(showSeed || enabled) && (
          <div className="flex items-center gap-2 px-4 py-3 border-t border-line">
            <span className="text-2xs text-ink-faint">
              Review before enabling — the script is stored in{" "}
              <span className="font-mono">node_modules/.dedup/</span>, never
              committed.
            </span>
            <span className="flex-1" />
            {enabled ? (
              <button
                onClick={() => void save(false, script)}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-2xs bg-surface-2 text-ink hover:bg-surface-3 disabled:opacity-50"
              >
                Disable
              </button>
            ) : (
              <button
                onClick={() => void save(false, script)}
                disabled={busy || !canEnable}
                title="Keep the script without activating it"
                className="rounded-md px-3 py-1.5 text-2xs bg-surface-2 text-ink-dim hover:text-ink disabled:opacity-50"
              >
                Save draft
              </button>
            )}
            <button
              onClick={() => void save(true, script)}
              disabled={busy || !canEnable}
              className="rounded-md px-3 py-1.5 text-2xs bg-accent text-white hover:brightness-110 disabled:opacity-50"
            >
              {enabled ? "Update & reload" : "Enable & reload"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
