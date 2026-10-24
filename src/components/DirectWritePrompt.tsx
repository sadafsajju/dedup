// The warning before dedup saves into a project with no git.
//
// dedup's safety model is a session branch and a commit per change. With no
// repository there is neither, so a save replaces the user's files in place
// and nothing in git can undo it. That is allowed — it is their folder — but
// never silently: this names the files, says what is missing, and offers the
// way to get the safety back (setting up git) beside the way to go ahead.
// Shown once per session; confirming covers the saves after it.
import { useStore } from "../lib/store";
import { SetUpGit } from "./SetUpGit";

export function DirectWritePrompt() {
  const prompt = useStore((s) => s.directWritePrompt);
  const confirm = useStore((s) => s.confirmDirectWrite);
  const cancel = useStore((s) => s.cancelDirectWrite);
  const git = useStore((s) => s.git);

  // Setting up git from here answers the question: the save it was holding
  // can then go through the normal path, so the prompt steps aside.
  if (!prompt || git?.isRepo) return null;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-8"
      onClick={cancel}
    >
      <div
        role="alertdialog"
        aria-labelledby="direct-write-title"
        className="w-full max-w-md rounded-xl border border-line bg-surface-0 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="direct-write-title" className="text-sm font-medium text-warn">
          This will replace your working files
        </div>
        <p className="mt-2 text-xs text-ink-dim leading-relaxed">
          This folder isn&rsquo;t a git repository, so dedup can&rsquo;t create
          a branch for the change or commit it. Saving writes straight into:
        </p>
        <ul className="mt-1.5 max-h-32 overflow-y-auto space-y-0.5">
          {prompt.files.map((f) => (
            <li key={f} className="font-mono text-2xs text-ink truncate">
              {f}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-dim leading-relaxed">
          There will be no commit to undo it. Set up git first to keep a history
          — or go ahead, and dedup won&rsquo;t ask again this session.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={confirm}
            className="rounded px-2.5 py-1 text-2xs font-medium bg-warn text-black hover:brightness-110"
          >
            Replace files
          </button>
          <SetUpGit compact />
          <span className="flex-1" />
          <button
            onClick={cancel}
            className="rounded px-2 py-1 text-2xs text-ink-dim hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
