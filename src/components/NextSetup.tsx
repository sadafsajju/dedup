// Next.js element tagging — the opt-in (Phase 5).
//
// Vite lets dedup instrument a project invisibly: it generates a wrapper
// config under node_modules/.dedup and starts vite with `--config`. Next has
// no equivalent flag, so tagging needs one line in a file dedup does not own.
//
// The standing rule is that dedup never mutates the user's source or config
// for tooling, and this does not bend it: the change is offered, not made; the
// exact diff is shown first; it goes through the same parse gate and the same
// session-branch commit as every other dedup write; and History can undo it.
// It is also inert — the wrapper does nothing unless `DEDUP_TAGGING=1`, which
// only dedup's own dev server sets — so having the line changes nothing about
// the user's `next dev`, their CI, or their production build.
import { useEffect, useState } from "react";
import { CheckCircledIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { commitSession, nextStatus, writeSource } from "../lib/api";
import { diffLines, toHunks } from "../lib/diff";
import { useStore } from "../lib/store";
import type { NextStatus } from "../lib/types";

export function NextSetup() {
  const project = useStore((s) => s.project);
  const instrumentation = useStore((s) => s.instrumentation);
  const [status, setStatus] = useState<NextStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const offered = instrumentation?.mode === "next-optin";

  useEffect(() => {
    if (!project || !offered) return;
    let live = true;
    nextStatus(project.root)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [project?.root, offered]);

  if (!project || !offered) return null;
  if (status && status.state !== "offered") return null;

  const hunks = status?.state === "offered"
    ? toHunks(diffLines(status.before, status.after), 2)
    : [];

  async function enable() {
    if (!project || status?.state !== "offered") return;
    setBusy(true);
    setError(null);
    try {
      // Same gate as every generated write: the sidecar re-parses the new
      // content and refuses anything that does not parse.
      const res = await writeSource(project.root, status.config, status.after);
      if (!res.ok) throw new Error(res.error ?? "the config could not be written");
      await commitSession(
        project.root,
        "dedup: enable element tagging in next.config",
        [status.config],
      );
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mx-3 mb-3 rounded-lg border border-positive/40 bg-positive/10 px-3 py-2 text-2xs text-positive">
        <div className="flex items-center gap-1.5">
          <CheckCircledIcon width={13} height={13} />
          <span>Tagging is wired into {status?.state === "offered" ? status.config : "next.config"}.</span>
        </div>
        <div className="mt-1 opacity-90">
          Restart the project (close it and reopen) so Next rebuilds with the
          loader. The change is committed — undo it from History any time.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-3 mb-3 rounded-lg border border-line bg-surface-2 overflow-hidden">
      <div className="px-3 py-2">
        <div className="text-2xs text-ink">
          Turn on element inspection for Next.js
        </div>
        <div className="mt-1 text-2xs text-ink-dim leading-relaxed">
          Next reads its config from your project root and takes no config
          flag, so dedup can't inject the tagger the way it does on Vite. One
          line in{" "}
          <span className="font-mono text-ink">
            {status?.state === "offered" ? status.config : "next.config"}
          </span>{" "}
          enables it. The wrapper is inert unless dedup starts the dev server,
          so your own <span className="font-mono">next dev</span>, CI and
          production build are unaffected.
        </div>
      </div>

      {hunks.length > 0 && (
        <div className="border-y border-line max-h-40 overflow-auto">
          {hunks.map((h, i) => (
            <div key={i}>
              {i > 0 && (
                <div className="px-3 text-[10px] text-ink-faint bg-surface-1/60">⋯</div>
              )}
              {h.lines.map((l, j) => (
                <div
                  key={j}
                  className={`flex font-mono text-[10px] leading-[1.5] ${
                    l.op === "add"
                      ? "bg-positive/10 text-positive"
                      : l.op === "remove"
                        ? "bg-danger/10 text-danger"
                        : "text-ink-dim"
                  }`}
                >
                  <span className="w-3 shrink-0 text-center select-none">
                    {l.op === "add" ? "+" : l.op === "remove" ? "−" : " "}
                  </span>
                  <pre className="whitespace-pre pr-3">{l.text || " "}</pre>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="px-3 py-1.5 text-2xs text-danger flex items-start gap-1.5">
          <ExclamationTriangleIcon width={12} height={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      <div className="px-3 py-2 flex items-center gap-2">
        <button
          disabled={busy || status?.state !== "offered"}
          onClick={() => void enable()}
          className="rounded-md px-2.5 py-1 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-60"
        >
          {busy ? "Writing…" : "Add it & commit"}
        </button>
        <span className="text-2xs text-ink-faint">
          Committed on the session branch — undoable from History.
        </span>
      </div>

      {/* Both limitations, said before the user opts in rather than
          discovered afterwards. */}
      <div className="px-3 pb-2 text-[10px] text-ink-faint">
        {status?.state === "offered" && status.needsWebpack && (
          <div className="mb-1">
            Your dev script uses Turbopack, which never runs the hook dedup tags
            through — so while inspecting, dedup starts the dev server with{" "}
            <span className="font-mono">--webpack</span>. Same script, same env,
            different bundler: slower to start, and not what your own{" "}
            <span className="font-mono">next dev</span> uses.
          </div>
        )}
        Isolated component previews (the Components tab) stay Vite-only — they
        need the dev server to serve arbitrary module URLs, which Next doesn't.
      </div>
    </div>
  );
}
