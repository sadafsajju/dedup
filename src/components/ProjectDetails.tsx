import { useState } from "react";
import type { GitStatus, ProjectInfo } from "../lib/types";
import { defaultCommand } from "../lib/openPrefs";
import { InfoCircledIcon } from "@radix-ui/react-icons";

interface Props {
  info: ProjectInfo;
  git: GitStatus;
  /** The command remembered from last time, if the user set one. */
  initialCommand: string | null;
  onCancel: () => void;
  onConfirm: (customCommand: string | null) => void;
}

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium bg-surface-3 text-ink">
      {label}
    </span>
  );
}

/**
 * What dedup found in a folder, and the two things only the user can say
 * about it: the command that starts it, and that they know their tree is
 * dirty.
 *
 * It carries no verdict. This panel used to grade a project — fully,
 * partially, un-supported — and stand between the user and every first open.
 * Every project opens now, so it appears on its own only when one of those
 * two answers is actually missing (`reasonToAsk`), and otherwise lives behind
 * the gear on a project's card. It lists what the project *has*; a struck-out
 * "Tailwind" chip was a grade in miniature.
 */
export function ProjectDetails({
  info,
  git,
  initialCommand,
  onCancel,
  onConfirm,
}: Props) {
  const [ackDirty, setAckDirty] = useState(false);
  const [customCommand, setCustomCommand] = useState(initialCommand ?? "");
  const needsAck = git.isRepo && git.isDirty;
  const needsCommand = !info.runnable;
  const hasCommand = customCommand.trim().length > 0;
  const blocked = (needsCommand && !hasCommand) || (needsAck && !ackDirty);
  // dedup *is* the dev server for a static site, so there is no command of
  // theirs to override — offering the box would only let someone replace the
  // one server that does the tagging.
  const isStatic = info.framework === "static";
  const fallback = defaultCommand(info);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-8">
      <div className="w-full max-w-lg rounded-xl border border-line bg-surface-1 shadow-2xl">
        <div className="px-5 pt-5 pb-3">
          <div className="text-[15px] font-semibold">{info.name}</div>
          <div className="text-2xs text-ink-faint font-mono truncate">
            {info.root}
          </div>
        </div>

        <div className="px-5 py-3 flex flex-wrap gap-1.5 border-t border-line">
          <Chip label={info.stack} />
          {info.hasTailwind && <Chip label="Tailwind" />}
          {info.hasTypescript && <Chip label="TypeScript" />}
          {info.hasGit && <Chip label="git" />}
          {!isStatic && info.packageManager !== "unknown" && (
            <Chip label={info.packageManager} />
          )}
        </div>

        {info.notes.length > 0 && (
          <ul className="px-5 py-3 border-t border-line flex flex-col gap-2">
            {info.notes.map((n, i) => (
              <li key={i} className="flex gap-2 text-2xs text-ink-dim">
                <InfoCircledIcon
                  width={13}
                  height={13}
                  className="text-ink-faint shrink-0 mt-px"
                />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        )}

        {isStatic ? (
          <div className="px-5 py-3 border-t border-line text-2xs text-ink-faint leading-snug">
            dedup serves this folder itself and stamps the pages on the way out,
            so element inspection works with no build step and nothing is
            written into your files.
          </div>
        ) : (
          <div className="px-5 py-3 border-t border-line">
            <label className="block text-2xs text-ink-dim mb-1.5">
              {needsCommand
                ? "What command starts this project?"
                : "Start command"}
            </label>
            <input
              value={customCommand}
              onChange={(e) => setCustomCommand(e.currentTarget.value)}
              autoFocus={needsCommand}
              placeholder={fallback ?? "e.g. npm run dev"}
              spellCheck={false}
              className="w-full rounded-md bg-surface-2 border border-line px-2.5 py-1.5 text-2xs font-mono text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
            <p className="text-2xs text-ink-faint mt-1.5 leading-snug">
              {needsCommand ? (
                <>
                  Whatever you type in a terminal to see it in a browser. dedup
                  runs it in the project root and shows the address it prints.
                </>
              ) : (
                <>
                  Leave empty to use{" "}
                  <span className="font-mono">{fallback}</span>. A command of
                  your own runs via <span className="font-mono">sh -c</span> in
                  the project root, without dedup's tagger — so elements can't
                  be clicked to inspect.
                </>
              )}
            </p>
          </div>
        )}

        {needsAck && (
          <div className="px-5 py-3 border-t border-line">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={ackDirty}
                onChange={(e) => setAckDirty(e.currentTarget.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span className="text-2xs text-ink-dim leading-snug">
                Working tree has{" "}
                <span className="text-ink font-medium">
                  {git.changedFiles} uncommitted change
                  {git.changedFiles === 1 ? "" : "s"}
                </span>{" "}
                on{" "}
                <span className="font-mono text-ink">{git.branch ?? "?"}</span>.
                dedup writes on its own branch, but I understand and want to
                continue.
              </span>
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-line">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink-dim hover:text-ink hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(customCommand.trim() || null)}
            disabled={blocked}
            className="rounded-md px-3.5 py-1.5 text-[13px] font-medium bg-accent text-white hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Open project
          </button>
        </div>
      </div>
    </div>
  );
}
