import { useState } from "react";
import type { GitStatus, ProjectInfo } from "../lib/types";
import { CheckIcon, WarnIcon, XIcon } from "./icons";

interface Props {
  info: ProjectInfo;
  git: GitStatus;
  onCancel: () => void;
  onConfirm: (customCommand: string | null) => void;
}

const SUPPORT_STYLE: Record<
  ProjectInfo["support"],
  { label: string; cls: string }
> = {
  full: { label: "Fully supported", cls: "text-positive bg-positive/10" },
  partial: { label: "Partially supported", cls: "text-warn bg-warn/10" },
  unsupported: { label: "Unsupported", cls: "text-danger bg-danger/10" },
};

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium
        ${ok ? "bg-surface-3 text-ink" : "bg-surface-2 text-ink-faint line-through"}`}
    >
      {ok ? <CheckIcon size={11} /> : <XIcon size={11} />}
      {label}
    </span>
  );
}

export function CompatCard({ info, git, onCancel, onConfirm }: Props) {
  const support = SUPPORT_STYLE[info.support];
  const [ackDirty, setAckDirty] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customCommand, setCustomCommand] = useState("");
  const needsAck = git.isRepo && git.isDirty;
  // A custom command makes an "unsupported: no dev script" project drivable.
  const canOpen =
    info.support !== "unsupported" || customCommand.trim().length > 0;
  const blocked = !canOpen || (needsAck && !ackDirty);

  const fwLabel =
    info.framework === "next"
      ? "Next.js"
      : info.framework === "vite"
        ? "Vite"
        : "Unknown framework";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-8">
      <div className="w-full max-w-lg rounded-xl border border-line bg-surface-1 shadow-2xl">
        <div className="flex items-start justify-between px-5 pt-5 pb-3">
          <div>
            <div className="text-[15px] font-semibold">{info.name}</div>
            <div className="text-2xs text-ink-faint font-mono truncate max-w-sm">
              {info.root}
            </div>
          </div>
          <span
            className={`shrink-0 rounded-md px-2 py-1 text-2xs font-medium ${support.cls}`}
          >
            {support.label}
          </span>
        </div>

        <div className="px-5 pb-2">
          <p className="text-[13px] text-ink-dim">{info.summary}</p>
        </div>

        <div className="px-5 py-3 flex flex-wrap gap-1.5 border-t border-line">
          <Badge ok label={fwLabel} />
          <Badge ok={info.hasTailwind} label="Tailwind" />
          <Badge ok={info.hasTypescript} label="TypeScript" />
          <Badge ok={info.hasGit} label="git" />
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium bg-surface-3 text-ink">
            {info.packageManager}
          </span>
        </div>

        {info.warnings.length > 0 && (
          <ul className="px-5 py-3 border-t border-line flex flex-col gap-2">
            {info.warnings.map((w, i) => (
              <li key={i} className="flex gap-2 text-2xs text-ink-dim">
                <WarnIcon size={13} className="text-warn shrink-0 mt-px" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="px-5 py-3 border-t border-line">
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-2xs text-ink-dim hover:text-ink"
          >
            {showAdvanced ? "▾" : "▸"} Advanced — custom dev command
          </button>
          {showAdvanced && (
            <div className="mt-2">
              <input
                value={customCommand}
                onChange={(e) => setCustomCommand(e.currentTarget.value)}
                placeholder={`default: ${info.packageManager} run dev`}
                spellCheck={false}
                className="w-full rounded-md bg-surface-2 border border-line px-2.5 py-1.5 text-2xs font-mono text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
              />
              <p className="text-2xs text-ink-faint mt-1.5 leading-snug">
                Runs via <span className="font-mono">sh -c</span> in the project
                root. Use this if your dev script needs env flags — e.g. the
                canvas can't load self-signed HTTPS, so serve plain HTTP here.
              </p>
            </div>
          )}
        </div>

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
            {canOpen ? "Open project" : "Can't open"}
          </button>
        </div>
      </div>
    </div>
  );
}
