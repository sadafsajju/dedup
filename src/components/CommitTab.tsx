// The Commit tab: every state a change can be in, in one list, with the thing
// you can do about each beside it.
//
//   Unsaved    staged edits — not on disk. Discard one, discard all, commit.
//   AI preview a chat proposal — on disk, deliberately uncommitted. Keep/discard.
//   Commits    dedup's saves on this branch, newest first. Undo any one.
//   Publish    push a branch to a remote; bring the session onto your branch.
//
// It folds in what used to be two top-bar popovers (the staged-changes review
// and the session history), because they were two halves of one question —
// "what has dedup changed, and what happens to it next?" — asked in two places.
//
// Publish is the only part that reaches outside the session branch, so it is
// the only part that asks twice: the first click builds a sentence naming the
// branch, the remote and the number of commits, and nothing runs until that
// sentence is confirmed. What may be offered at all is decided in
// `lib/commitTab.ts` (tested); what is refused regardless is in `publish.rs`.
import { useEffect, useMemo, useState } from "react";
import { CommitIcon, Cross2Icon } from "@radix-ui/react-icons";
import { useStore } from "../lib/store";
import { gitStatus } from "../lib/api";
import { isValueAction } from "../lib/types";
import type { EditAction } from "../lib/types";
import {
  buildChangeList,
  landState,
  landSummary,
  pickTarget,
  previewClash,
  previewClashMessage,
  pushState,
} from "../lib/commitTab";
import type { CommitRow, StagedRow } from "../lib/commitTab";
import { SetUpGit } from "./SetUpGit";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const base = (path: string) => path.split("/").pop() ?? path;

function Heading({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
      <span className="text-[10px] uppercase tracking-wider text-ink-faint">{children}</span>
      <span className="flex-1" />
      {right}
    </div>
  );
}

// --- unsaved -----------------------------------------------------------------

function tokenDiff(original: string, current: string) {
  const o = original.split(/\s+/).filter(Boolean);
  const c = current.split(/\s+/).filter(Boolean);
  const oSet = new Set(o);
  const cSet = new Set(c);
  return {
    removed: o.filter((t) => !cSet.has(t)),
    added: c.filter((t) => !oSet.has(t)),
    kept: c.filter((t) => oSet.has(t)),
  };
}

/** How a structural action reads in one line. */
function structuralSummary(action: EditAction): string {
  switch (action.kind) {
    case "remove":
      return `Delete ${action.label}`;
    case "insert":
      return `Add ${action.label} ${action.position} ${action.target.dedupId.split("/").pop()}`;
    case "move":
      return `Move ${action.label} ${action.position === "inside" ? "into" : action.position} ${action.to.dedupId.split("/").pop()}`;
    default:
      return "";
  }
}

function ClassDiff({ action }: { action: Extract<EditAction, { kind: "class" }> }) {
  const { removed, added, kept } = tokenDiff(action.before, action.after);
  return (
    <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-2xs leading-tight select-text">
      {removed.map((t, i) => (
        <span
          key={`r${i}`}
          className="px-1 py-0.5 rounded bg-danger/10 text-danger line-through decoration-danger/60"
        >
          {t}
        </span>
      ))}
      {added.map((t, i) => (
        <span key={`a${i}`} className="px-1 py-0.5 rounded bg-positive/10 text-positive">
          {t}
        </span>
      ))}
      {removed.length === 0 && added.length === 0 && (
        <span className="text-ink-faint">reordered only</span>
      )}
      {kept.length > 0 && (
        <span className="text-ink-faint px-1 py-0.5" title={kept.join(" ")}>
          +{kept.length} unchanged
        </span>
      )}
    </div>
  );
}

function Staged({ row }: { row: StagedRow }) {
  const revertAction = useStore((s) => s.revertAction);
  const selectById = useStore((s) => s.selectById);
  const { action, index } = row;
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => selectById(action.target.dedupId)}
          className="min-w-0 truncate text-2xs font-medium text-ink hover:text-accent"
          title="Select on canvas"
        >
          {isValueAction(action) ? (action.component ?? "element") : structuralSummary(action)}
        </button>
        <span className="min-w-0 truncate font-mono text-[10px] text-ink-faint" title={action.target.file}>
          {base(action.target.file)}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => revertAction(index)}
          className="shrink-0 rounded p-0.5 text-ink-faint hover:text-danger"
          title="Discard this edit"
        >
          <Cross2Icon width={12} height={12} />
        </button>
      </div>
      {action.kind === "class" && <ClassDiff action={action} />}
      {action.kind === "text" && (
        <div className="mt-1.5 font-mono text-2xs leading-tight select-text">
          <span className="px-1 py-0.5 rounded bg-danger/10 text-danger line-through decoration-danger/60">
            {action.before || "(empty)"}
          </span>{" "}
          <span className="px-1 py-0.5 rounded bg-positive/10 text-positive">
            {action.after || "(empty)"}
          </span>
        </div>
      )}
    </div>
  );
}

// --- commits -----------------------------------------------------------------

function Commit({ row }: { row: CommitRow }) {
  const revertEntry = useStore((s) => s.revertEntry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2">
        <span
          className={`min-w-0 flex-1 text-2xs leading-snug break-words ${
            row.isUndo ? "text-ink-faint" : "text-ink-dim"
          }`}
        >
          {row.title}
        </span>
        <button
          disabled={busy || !!row.undoBlocked}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await revertEntry(row.hash);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
          title={
            row.undoBlocked ??
            "Roll this commit back: restore the files it touched to how they were before it, as a new commit. Nothing else in the project is touched."
          }
        >
          {busy ? "Undoing…" : "Undo"}
        </button>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-faint">
        <span className="font-mono">{row.hash}</span>
        <span>·</span>
        <span className="truncate">{row.when}</span>
        {row.pushed !== null && (
          <span
            className={`ml-auto shrink-0 ${row.pushed ? "text-ink-faint" : "text-warn"}`}
            title={row.pushed ? "On the remote" : "Only on this machine — not pushed yet"}
          >
            {row.pushed ? "pushed" : "local"}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={row.files.join("\n")}>
        {row.files.slice(0, 2).map(base).join(", ")}
        {row.files.length > 2 && ` +${row.files.length - 2} more`}
      </div>
      {error && <div className="mt-1 text-[10px] text-danger break-words">{error}</div>}
    </div>
  );
}

// --- publish -----------------------------------------------------------------

/** What is about to happen, held until the user confirms the sentence. */
type Pending =
  | { kind: "push"; branch: string; remote: string; text: string }
  | { kind: "land"; target: string; text: string };

function StepButton({
  label,
  enabled,
  reason,
  onClick,
}: {
  label: string;
  enabled: boolean;
  reason: string | null;
  onClick: () => void;
}) {
  return (
    <div>
      <button
        onClick={onClick}
        disabled={!enabled}
        className="w-full rounded-md bg-surface-2 px-2 py-1.5 text-left text-2xs text-ink hover:bg-surface-3 disabled:text-ink-faint disabled:hover:bg-surface-2"
      >
        <span className="break-words">{label}</span>
      </button>
      {reason && (
        <div className={`mt-1 text-[10px] leading-snug break-words ${enabled ? "text-ink-faint" : "text-ink-dim"}`}>
          {reason}
        </div>
      )}
    </div>
  );
}

function Publish({ unsaved, hasPreview }: { unsaved: number; hasPreview: boolean }) {
  const sync = useStore((s) => s.sync);
  const pushBranch = useStore((s) => s.pushBranch);
  const landOn = useStore((s) => s.landOn);
  const [remote, setRemote] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!sync?.isRepo) return null;
  const branch = sync.branch;
  if (sync.detached || !branch) {
    return (
      <>
        <Heading>Publish</Heading>
        <div className="px-3 pb-3 text-2xs text-ink-dim leading-snug">
          HEAD is detached — the project isn&rsquo;t on a branch, so there is nothing to push or
          move. Switch to a branch with your own git tools.
        </div>
      </>
    );
  }

  const remoteName =
    remote && sync.remotes.some((r) => r.name === remote) ? remote : sync.remote;
  const remoteUrl = sync.remotes.find((r) => r.name === remoteName)?.url ?? "";
  const targetName = pickTarget(sync.targets, target);
  const targetInfo = sync.targets.find((t) => t.name === targetName) ?? null;

  const pushHere = pushState(sync, branch, remoteName);
  const land = targetName ? landState(sync, targetName) : null;
  const pushTarget = targetName ? pushState(sync, targetName, remoteName) : null;

  // What stays behind, said in the confirmation rather than assumed known.
  const leftBehind = [
    unsaved > 0 ? `${plural(unsaved, "unsaved edit")}` : null,
    hasPreview ? "the AI preview" : null,
  ].filter(Boolean);
  const staysHere =
    leftBehind.length > 0
      ? ` Not included: ${leftBehind.join(" and ")} — only commits travel.`
      : "";

  const askPush = (b: string, count: number | null) =>
    remoteName &&
    setPending({
      kind: "push",
      branch: b,
      remote: remoteName,
      text: `Push ${count === null ? "" : `${plural(count, "commit")} on `}${b} to ${remoteName}${
        remoteUrl ? ` (${remoteUrl})` : ""
      }? Never a force-push: if ${remoteName} has moved on, it is refused.${staysHere}`,
    });

  const askLand = () =>
    targetInfo &&
    setPending({
      kind: "land",
      target: targetInfo.name,
      text: `Move ${targetInfo.name} forward to ${branch} — ${landSummary(targetInfo)}. Fast-forward only, on this machine; nothing is pushed.${
        targetInfo.checkedOutHere
          ? ` ${targetInfo.name} is checked out here, so its files will update (refused if it has uncommitted changes).`
          : " Your files and uncommitted work are not touched."
      }${staysHere}`,
    });

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (pending.kind === "push") {
        await pushBranch(pending.remote, pending.branch);
        setDone(`Pushed ${pending.branch} to ${pending.remote}.`);
      } else {
        const n = await landOn(pending.target);
        setDone(`${pending.target} now has ${plural(n, "more commit")} from this session. Not pushed yet.`);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const ask = (fn: () => void) => () => {
    setError(null);
    setDone(null);
    fn();
  };

  return (
    <>
      <Heading
        right={
          sync.remotes.length > 1 ? (
            <select
              value={remoteName ?? ""}
              onChange={(e) => {
                setRemote(e.target.value);
                setPending(null);
              }}
              className="max-w-[7rem] rounded bg-surface-2 px-1 py-0.5 text-[10px] text-ink-dim"
              title="Which remote to push to"
            >
              {sync.remotes.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : remoteName ? (
            <span className="truncate text-[10px] text-ink-faint" title={remoteUrl}>
              {remoteName}
            </span>
          ) : null
        }
      >
        Publish
      </Heading>

      <div className="px-3 pb-3 space-y-2.5">
        <StepButton
          label={`Push ${branch}${
            pushHere.count ? ` · ${plural(pushHere.count, "commit")}` : ""
          }${remoteName ? ` → ${remoteName}` : ""}`}
          enabled={pushHere.enabled && !busy}
          reason={pushHere.reason}
          onClick={ask(() => askPush(branch, pushHere.count))}
        />

        {sync.onSession && sync.targets.length > 0 && land && pushTarget && targetName && (
          <div className="space-y-1.5 border-t border-line pt-2.5">
            <div className="flex items-center gap-1.5 text-2xs text-ink-dim">
              <span className="shrink-0">Onto</span>
              <select
                value={targetName}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setPending(null);
                }}
                className="min-w-0 flex-1 rounded bg-surface-2 px-1.5 py-1 font-mono text-2xs text-ink"
                title="The branch to bring this session's commits onto"
              >
                {sync.targets.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <StepButton
              label={
                land.enabled && targetInfo
                  ? `Bring ${landSummary(targetInfo)} onto ${targetName}`
                  : `Bring this session onto ${targetName}`
              }
              enabled={land.enabled && !busy}
              reason={land.reason}
              onClick={ask(askLand)}
            />
            <StepButton
              label={`Push ${targetName}${
                pushTarget.count ? ` · ${plural(pushTarget.count, "commit")}` : ""
              }${remoteName ? ` → ${remoteName}` : ""}`}
              enabled={pushTarget.enabled && !busy}
              reason={pushTarget.reason}
              onClick={ask(() => askPush(targetName, pushTarget.count))}
            />
          </div>
        )}

        {pending && (
          <div role="alertdialog" className="rounded-md border border-line-strong bg-surface-2 p-2">
            <div className="text-2xs leading-snug text-ink break-words">{pending.text}</div>
            <div className="mt-2 flex items-center gap-1.5">
              <button
                onClick={() => void run()}
                disabled={busy}
                className="rounded bg-accent px-2 py-0.5 text-2xs font-medium text-white hover:brightness-110 disabled:opacity-60"
              >
                {busy
                  ? pending.kind === "push"
                    ? "Pushing…"
                    : "Moving…"
                  : pending.kind === "push"
                    ? `Push to ${pending.remote}`
                    : `Move ${pending.target}`}
              </button>
              <button
                onClick={() => setPending(null)}
                disabled={busy}
                className="rounded px-2 py-0.5 text-2xs text-ink-dim hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {error && <div className="text-2xs leading-snug text-danger break-words select-text">{error}</div>}
        {done && <div className="text-2xs leading-snug text-positive break-words">{done}</div>}
        <div className="text-[10px] leading-snug text-ink-faint">
          Counts are as of your last fetch — dedup doesn&rsquo;t contact the remote until you push.
        </div>
      </div>
    </>
  );
}

// --- the tab -----------------------------------------------------------------

export function CommitTab() {
  const root = useStore((s) => s.project?.root);
  const git = useStore((s) => s.git);
  const actions = useStore((s) => s.actions);
  const pendingEdit = useStore((s) => s.pendingEdit);
  const history = useStore((s) => s.history);
  const sync = useStore((s) => s.sync);
  const lastSave = useStore((s) => s.lastSave);
  const saving = useStore((s) => s.saving);
  const saveError = useStore((s) => s.saveError);
  const chatBusy = useStore((s) => s.chatBusy);
  const saveAll = useStore((s) => s.saveAll);
  const discardAllEdits = useStore((s) => s.discardAllEdits);
  const acceptChatEdit = useStore((s) => s.acceptChatEdit);
  const rejectChatEdit = useStore((s) => s.rejectChatEdit);
  const setInspectorTab = useStore((s) => s.setInspectorTab);
  const loadHistory = useStore((s) => s.loadHistory);
  const loadSync = useStore((s) => s.loadSync);
  const [draft, setDraft] = useState("");

  const list = useMemo(
    () => buildChangeList({ actions, pendingEdit, history, sync }),
    [actions, pendingEdit, history, sync],
  );

  // Anything that makes a commit, or changes what branch this is, changes
  // what the list and the publish buttons should say.
  const hasProposal = pendingEdit !== null;
  useEffect(() => {
    if (!root) return;
    void loadHistory();
    void loadSync();
  }, [root, lastSave, git?.branch, git?.isRepo, hasProposal, loadHistory, loadSync]);

  // git has other callers than dedup: a commit, fetch or checkout made in a
  // terminal shows up when the user comes back to the window.
  useEffect(() => {
    if (!root) return;
    const refresh = () => {
      void loadHistory();
      void loadSync();
      gitStatus(root)
        .then((g) => {
          if (useStore.getState().project?.root === root) useStore.setState({ git: g });
        })
        .catch(() => {});
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [root, loadHistory, loadSync]);

  // The message belonged to the edits it described.
  const stagedCount = list.staged.length;
  useEffect(() => {
    if (stagedCount === 0) setDraft("");
  }, [stagedCount]);

  const noGit = git?.isRepo === false;
  const clash = previewClash(list.stagedFiles, pendingEdit);
  const nothing = stagedCount === 0 && !list.proposal && list.commits.length === 0;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* No repository: a save still works (in place, after the warning), but
          there is no history to list and nothing to push. Said first, with
          the way out beside it. */}
      {noGit && (
        <div className="mx-2 mt-1 rounded-md bg-warn/10 p-2.5">
          <div className="text-2xs font-medium text-warn">No git in this folder</div>
          <div className="mt-1 text-2xs leading-snug text-ink-dim">
            Saving writes straight into your files — no commit, nothing to roll back, nothing to
            push. Set up git to get all three.
          </div>
          <div className="mt-2">
            <SetUpGit />
          </div>
        </div>
      )}

      <Heading
        right={
          stagedCount > 0 ? (
            <button
              onClick={discardAllEdits}
              disabled={saving}
              title="Throw every staged edit away. Nothing here has been written, so there is nothing to put back."
              className="rounded px-1 text-[10px] text-ink-faint hover:text-danger disabled:opacity-40"
            >
              Discard all
            </button>
          ) : null
        }
      >
        Unsaved{stagedCount > 0 ? ` · ${stagedCount}` : ""}
      </Heading>

      {stagedCount === 0 ? (
        <div className="px-3 pb-2 text-2xs text-ink-faint leading-snug">
          {nothing
            ? "Nothing changed yet. Edits you make on the canvas collect here until you commit them."
            : "Nothing staged."}
        </div>
      ) : (
        <>
          <div className="divide-y divide-line">
            {list.staged.map((row) => (
              <Staged key={row.index} row={row} />
            ))}
          </div>
          <div className="px-3 pt-1.5 pb-3">
            {!noGit && (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘↵ commits from the field; ⌘S works everywhere already.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void saveAll(draft);
                  }
                }}
                rows={2}
                spellCheck={false}
                placeholder="Commit message (optional — dedup describes the change if you don't)"
                className="mb-1.5 w-full resize-none rounded-md bg-surface-2 px-2 py-1.5 text-2xs text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-accent"
              />
            )}
            <button
              onClick={() => void saveAll(draft)}
              disabled={saving || !!clash}
              title={
                clash
                  ? previewClashMessage(clash)
                  : noGit
                    ? "Write these edits into your files in place"
                    : `Write ${plural(list.stagedFiles.length, "file")} and commit ${
                        list.stagedFiles.length === 1 ? "it" : "them"
                      } on dedup's session branch (⌘S)`
              }
              className="w-full rounded-md bg-accent px-2 py-1.5 text-2xs font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              {saving
                ? "Saving…"
                : noGit
                  ? `Save ${plural(stagedCount, "edit")} in place`
                  : `Commit ${plural(stagedCount, "edit")}`}
            </button>
            {clash && (
              <div className="mt-1.5 text-[10px] leading-snug text-warn break-words">
                {previewClashMessage(clash)}
              </div>
            )}
            {saveError && (
              <div className="mt-1.5 text-[10px] leading-snug text-danger break-words select-text">
                Save failed: {saveError}
              </div>
            )}
          </div>
        </>
      )}

      {/* On disk and on the canvas, committed to nothing — and it stays that
          way until it is kept: no save, push or landing here takes it along. */}
      {list.proposal && (
        <>
          <Heading>AI preview · not committed</Heading>
          <div className="px-3 pb-3">
            <button
              onClick={() => setInspectorTab("chat")}
              className="block w-full text-left text-2xs leading-snug text-ink hover:text-accent break-words"
              title="Open the chat this proposal came from"
            >
              {list.proposal.summary}
            </button>
            <div
              className="mt-0.5 truncate font-mono text-[10px] text-ink-faint"
              title={list.proposal.files.join("\n")}
            >
              {list.proposal.files.slice(0, 2).map(base).join(", ")}
              {list.proposal.files.length > 2 && ` +${list.proposal.files.length - 2} more`}
            </div>
            {!list.proposal.previewing && (
              <div className="mt-1 text-[10px] text-warn">
                The preview couldn&rsquo;t be written, so the canvas isn&rsquo;t showing it.
              </div>
            )}
            <div className="mt-2 flex items-center gap-1.5">
              <button
                onClick={() => void acceptChatEdit()}
                disabled={chatBusy}
                className="rounded bg-accent px-2 py-0.5 text-2xs font-medium text-white hover:brightness-110 disabled:opacity-50"
                title={noGit ? "Keep the files as previewed" : "Commit the previewed files on the session branch"}
              >
                {noGit ? "Keep" : "Keep & commit"}
              </button>
              <button
                onClick={() => void rejectChatEdit()}
                disabled={chatBusy}
                className="rounded bg-surface-2 px-2 py-0.5 text-2xs text-ink-dim hover:text-ink disabled:opacity-50"
                title="Put every file back exactly as it was"
              >
                Discard
              </button>
            </div>
          </div>
        </>
      )}

      {!noGit && (
        <>
          <Heading
            right={
              git?.branch ? (
                <span className="max-w-[9rem] truncate font-mono text-[10px] text-ink-faint" title={git.branch}>
                  {git.branch}
                </span>
              ) : null
            }
          >
            Commits{list.commits.length > 0 ? ` · ${list.commits.length}` : ""}
          </Heading>
          {list.commits.length === 0 ? (
            <div className="px-3 pb-2 text-2xs text-ink-faint leading-snug">
              Nothing committed yet. Every save lands here as its own commit, and each can be
              rolled back on its own.
            </div>
          ) : (
            <div className="divide-y divide-line">
              {list.commits.map((row) => (
                <Commit key={row.hash} row={row} />
              ))}
            </div>
          )}

          <Publish unsaved={stagedCount} hasPreview={!!list.proposal?.previewing} />
        </>
      )}
    </div>
  );
}

/** Top-bar entry point: opens the Commit tab. Stands where the session-history
 *  popover's button stood, so the place people look for history still works. */
export function CommitTabButton() {
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const open = tab === "commit";
  return (
    <button
      onClick={() => setTab("commit")}
      className={`relative flex h-6 w-7 items-center justify-center rounded-lg ${
        open ? "bg-surface-3 text-ink" : "text-ink-dim hover:text-ink hover:bg-surface-2"
      }`}
      title="Commit — staged edits, every dedup commit (each undoable), push"
    >
      <CommitIcon width={14} height={14} />
    </button>
  );
}
