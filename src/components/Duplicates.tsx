// Duplicates tab + cluster review (FR-5.3). Rendered previews arrive with the
// visual pass in Phase 5 — until then the review shows the structural evidence:
// JSX skeletons with per-line agreement highlighting and the class-token diff.
import { useMemo } from "react";
import { rankClusters, useStore } from "../lib/store";
import type { ScanCluster, ScanMember } from "../lib/types";
import { DuplicatesIcon, WarnIcon, XIcon } from "./icons";

/** AI status strip: categorization runs automatically as part of Scan;
 * the backend is chosen in the TopBar AI switch. Status + retry only. */
function CategorizeControls() {
  const categorize = useStore((s) => s.categorize);
  const categorizing = useStore((s) => s.categorizing);
  const progress = useStore((s) => s.categorizeProgress);
  const error = useStore((s) => s.categorizeError);
  const categorized = useStore((s) => Object.keys(s.categories).length);
  const galleryCount = useStore((s) => s.scanResult?.gallery.length ?? 0);
  const backend = useStore((s) => s.activeAiBackend());

  if (galleryCount === 0) return null;

  return (
    <div className="px-3 py-1.5 border-b border-line flex items-center gap-2 text-2xs">
      {categorizing ? (
        <span className="text-accent">
          {progress
            ? `Organizing ${progress.done}/${progress.total}…`
            : "Organizing…"}
        </span>
      ) : error ? (
        <>
          <span className="text-danger truncate" title={error}>
            AI organize failed
          </span>
          <button onClick={categorize} className="text-accent hover:underline">
            Retry
          </button>
        </>
      ) : backend ? (
        <span className="text-ink-faint">
          AI organize · {categorized}/{galleryCount} ·{" "}
          {backend === "claude-code" ? "Claude Code" : "API"}
        </span>
      ) : (
        <span className="text-ink-dim">
          AI organize is off — choose a backend via{" "}
          <span className="text-ink">AI: off</span> in the top bar.
        </span>
      )}
      <span className="flex-1" />
    </div>
  );
}

function confidencePct(c: number) {
  return `${Math.round(c * 100)}%`;
}

function age(scannedAt: number | undefined): string | null {
  if (!scannedAt) return null;
  const mins = Math.round((Date.now() - scannedAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Sidebar tab body: scan state, then the ranked cluster list. */
export function DuplicatesTab() {
  const scanning = useStore((s) => s.scanning);
  const progress = useStore((s) => s.scanProgress);
  const result = useStore((s) => s.scanResult);
  const error = useStore((s) => s.scanError);
  const runScan = useStore((s) => s.runScan);
  const openCluster = useStore((s) => s.openCluster);
  const dismissed = useStore((s) => s.dismissed);
  const clusters = useMemo(
    () => rankClusters(result, dismissed),
    [result, dismissed],
  );
  const dismissedCount = result
    ? result.clusters.length - clusters.length
    : 0;

  if (scanning) {
    const pct =
      progress && progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : null;
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
        <DuplicatesIcon size={22} className="text-ink-faint animate-pulse" />
        <div className="text-2xs text-ink-dim">
          {progress?.stage === "similarity" ? "Comparing components" : "Reading components"}
          {pct !== null && ` · ${pct}%`}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
        <WarnIcon size={20} className="text-danger" />
        <div className="text-2xs text-ink-dim break-all">{error}</div>
        <button
          onClick={runScan}
          className="text-2xs text-accent hover:underline"
        >
          Retry scan
        </button>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
        <DuplicatesIcon size={22} className="text-ink-faint" />
        <div className="text-2xs text-ink-dim">
          Scan finds near-duplicates among the components on the current
          canvas page.
        </div>
        <button
          onClick={runScan}
          className="mt-1 rounded-md px-2.5 py-1 text-2xs font-medium bg-accent text-white hover:brightness-110"
        >
          Scan now
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-2 text-2xs text-ink-faint border-b border-line">
        <span className="text-ink-dim">
          {result.scopedFiles !== null
            ? `Current page · ${result.scopedFiles} file${result.scopedFiles === 1 ? "" : "s"}`
            : "Whole project"}
        </span>
        {" · "}
        {result.components} components · {clusters.length} cluster
        {clusters.length === 1 ? "" : "s"}
        {dismissedCount > 0 && ` · ${dismissedCount} dismissed`}
        {age(result.scannedAt) && ` · ${age(result.scannedAt)}`}
      </div>
      <CategorizeControls />
      {clusters.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center text-2xs text-ink-dim">
          No duplicate clusters found.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {clusters.map((c) => (
            <button
              key={c.id}
              onClick={() => openCluster(c.id)}
              className="w-full text-left px-3 py-2 border-b border-line hover:bg-surface-2"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-2xs text-ink truncate flex-1">
                  {c.members.map((m) => m.name).join(" · ")}
                </span>
                <span className="text-2xs text-positive tabular-nums shrink-0">
                  {confidencePct(c.confidence)}
                </span>
              </div>
              <div className="text-2xs text-ink-faint mt-0.5">
                {c.members.length} components · {c.totalCallSites} call site
                {c.totalCallSites === 1 ? "" : "s"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lines present in every member's skeleton — the structural common ground. */
function commonLines(members: ScanMember[]): Set<string> {
  const sets = members.map(
    (m) => new Set(m.skeleton.split("\n").map((l) => l.trim())),
  );
  const common = new Set<string>();
  for (const line of sets[0] ?? []) {
    if (sets.every((s) => s.has(line))) common.add(line);
  }
  return common;
}

function MemberCard({
  member,
  cluster,
  index,
  shared,
  sharedClasses,
}: {
  member: ScanMember;
  cluster: ScanCluster;
  index: number;
  shared: Set<string>;
  sharedClasses: Set<string>;
}) {
  const removeMember = useStore((s) => s.removeMember);
  return (
    <div className="min-w-64 flex-1 rounded-lg border border-line bg-surface-1 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="text-xs font-medium truncate">{member.name}</span>
        <span className="text-2xs text-ink-faint">{member.exportKind}</span>
        <span className="flex-1" />
        <span className="text-2xs text-ink-faint tabular-nums">
          {member.callSites} use{member.callSites === 1 ? "" : "s"}
        </span>
        <button
          onClick={() => removeMember(cluster.id, index)}
          className="text-ink-faint hover:text-ink"
          title="Remove from cluster"
        >
          <XIcon size={12} />
        </button>
      </div>
      <div className="px-3 py-1.5 text-2xs font-mono text-ink-faint truncate border-b border-line">
        {member.file}:{member.line}
      </div>
      <pre className="px-3 py-2 text-2xs font-mono leading-5 overflow-x-auto">
        {member.skeleton.split("\n").map((line, i) => (
          <div
            key={i}
            className={shared.has(line.trim()) ? "text-ink-dim" : "text-warn"}
          >
            {line}
          </div>
        ))}
      </pre>
      {member.classTokens.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {[...new Set(member.classTokens)].map((t) => (
            <span
              key={t}
              className={`rounded px-1 py-0.5 text-2xs font-mono ${
                sharedClasses.has(t)
                  ? "bg-surface-2 text-ink-faint"
                  : "bg-warn/15 text-warn"
              }`}
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Modal cluster review: side-by-side members, dismiss, remove (FR-5.3). */
export function ClusterReview() {
  const openClusterId = useStore((s) => s.openClusterId);
  const openCluster = useStore((s) => s.openCluster);
  const dismissCluster = useStore((s) => s.dismissCluster);
  const cluster = useStore((s) =>
    s.scanResult?.clusters.find((c) => c.id === s.openClusterId),
  );
  if (!openClusterId || !cluster) return null;

  const shared = commonLines(cluster.members);
  const sharedClasses = new Set(
    cluster.members
      .flatMap((m) => [...new Set(m.classTokens)])
      .filter((t) => cluster.members.every((m) => m.classTokens.includes(t))),
  );

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-8"
      onClick={() => openCluster(null)}
    >
      <div
        className="w-full max-w-5xl max-h-full flex flex-col rounded-xl border border-line bg-surface-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <DuplicatesIcon size={16} className="text-ink-dim" />
          <span className="text-sm font-medium truncate">
            {cluster.members.map((m) => m.name).join(" · ")}
          </span>
          <span className="text-2xs text-positive tabular-nums">
            {confidencePct(cluster.confidence)} match
          </span>
          <span className="text-2xs text-ink-faint">
            {cluster.totalCallSites} call site
            {cluster.totalCallSites === 1 ? "" : "s"}
          </span>
          <span className="flex-1" />
          <button
            onClick={() => dismissCluster(cluster.id)}
            className="rounded-md px-2.5 py-1 text-2xs bg-surface-2 text-ink-dim hover:text-ink"
            title="Hide this cluster and don't show it again"
          >
            Not duplicates
          </button>
          <button
            disabled
            className="rounded-md px-2.5 py-1 text-2xs bg-surface-2 text-ink-faint cursor-not-allowed"
            title="Guarded merge — Phase 4"
          >
            Merge…
          </button>
          <button
            onClick={() => openCluster(null)}
            className="text-ink-faint hover:text-ink ml-1"
          >
            <XIcon size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4">
          <div className="flex gap-3 items-start">
            {cluster.members.map((m, i) => (
              <MemberCard
                key={`${m.file}#${m.name}`}
                member={m}
                cluster={cluster}
                index={i}
                shared={shared}
                sharedClasses={sharedClasses}
              />
            ))}
          </div>
          <div className="mt-3 text-2xs text-ink-faint">
            <span className="text-warn">Amber</span> lines and classes differ
            between members — the knobs a merge would turn into props. Rendered
            previews land with the visual pass in Phase 5.
          </div>
        </div>
      </div>
    </div>
  );
}
