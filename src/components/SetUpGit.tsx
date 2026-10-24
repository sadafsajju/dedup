// "Set up git" — for a project that has none.
//
// dedup's safety model is a session branch and a commit per change, so a
// folder with no repository can be looked at but never saved. This is the
// one-click way out: `git init` plus a first commit of the files exactly as
// they are, which becomes the baseline every dedup edit lands on top of. It is
// the user's own request, made from a button that says what it does — the
// same footing as scaffolding a starter, and the opposite of a silent change.
import { useState } from "react";
import { useStore } from "../lib/store";

export function SetUpGit({ compact = false }: { compact?: boolean }) {
  const setUpGit = useStore((s) => s.setUpGit);
  const busy = useStore((s) => s.settingUpGit);
  const chatBusy = useStore((s) => s.chatBusy);
  const hasPreview = useStore((s) => !!s.pendingEdit?.previewing);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setError(await setUpGit());
  };

  const title = hasPreview
    ? "Make this folder a git repository with its files as they were before the AI's preview as the first commit — the preview is put back afterwards, ready to keep."
    : "Make this folder a git repository with its current files as the first commit. dedup then saves every change as its own commit on a separate branch.";

  return (
    <span className={compact ? "inline-flex items-center gap-1.5" : "block"}>
      <button
        onClick={() => void run()}
        disabled={busy || chatBusy}
        title={title}
        className="rounded px-2 py-0.5 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-50"
      >
        {busy ? "Setting up git…" : "Set up git"}
      </button>
      {error && (
        <span
          className={`text-2xs text-danger break-words ${compact ? "max-w-72 truncate" : "mt-1 block"}`}
          title={error}
        >
          {error}
        </span>
      )}
    </span>
  );
}
