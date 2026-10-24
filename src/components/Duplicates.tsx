// Duplicates tab + cluster review (FR-5.3). Rendered previews arrive with the
// visual pass in Phase 5 — until then the review shows the structural evidence:
// JSX skeletons with per-line agreement highlighting and the class-token diff.
import { useMemo } from "react";
import { rankClusters, useStore } from "../lib/store";
import { combinedConfidence, visualNote } from "../lib/visualPass";
import type { ScanCluster, ScanMember } from "../lib/types";
import {
  CopyIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";

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

/**
 * Starts the guarded merge (FR-5.4). Disabled without an AI backend, because
 * designing the canonical component is the one part of a merge that is not
 * mechanical — and saying so beats a button that fails when pressed.
 */
function MergeButton({ clusterId }: { clusterId: string }) {
  const startMerge = useStore((s) => s.startMerge);
  const backend = useStore((s) => s.activeAiBackend());
  const busy = useStore((s) => s.merge !== null);
  const disabled = !backend || busy;
  return (
    <button
      disabled={disabled}
      onClick={() => void startMerge(clusterId)}
      className={`rounded-md px-2.5 py-1 text-2xs ${
        disabled
          ? "bg-surface-2 text-ink-faint cursor-not-allowed"
          : "bg-accent text-white hover:brightness-110"
      }`}
      title={
        !backend
          ? "A merge proposal needs an AI backend — switch one on in the AI menu (top bar)"
          : busy
            ? "Finish the merge already in progress first"
            : "Propose a canonical component, review the diff, then merge behind the safety gates"
      }
    >
      Merge…
    </button>
  );
}

/**
 * The visual signal is opt-in per scan, and says so. It has to render every
 * cluster member in isolation and screenshot it, which takes seconds and needs
 * the Components tab on screen — so it runs when asked, not behind the user's
 * back during a scan.
 */
function VisualPassControls() {
  const run = useStore((s) => s.runVisualPass);
  const cancel = useStore((s) => s.cancelVisualPass);
  const progress = useStore((s) => s.visualPass);
  const scored = useStore((s) => Object.keys(s.visualScores).length);
  const dismissed = useStore((s) => s.dismissed);
  const result = useStore((s) => s.scanResult);
  const clusterCount = useMemo(
    () => rankClusters(result, dismissed).length,
    [result, dismissed],
  );

  if (clusterCount === 0) return null;

  return (
    <div className="px-3 py-1.5 border-b border-line flex items-center gap-2 text-2xs">
      {progress ? (
        <>
          <span className="text-accent">
            Rendering previews {progress.done}/{progress.total || "…"}
          </span>
          <span className="flex-1" />
          <button onClick={cancel} className="text-ink-dim hover:text-ink">
            Stop
          </button>
        </>
      ) : scored > 0 ? (
        <>
          <span className="text-ink-faint">
            Visual signal on {scored} cluster{scored === 1 ? "" : "s"}
          </span>
          <span className="flex-1" />
          <button
            onClick={() => void run()}
            className="text-accent hover:underline"
          >
            Re-check
          </button>
        </>
      ) : (
        <>
          <span className="text-ink-dim">
            Confidence is structural so far.
          </span>
          <span className="flex-1" />
          <button
            onClick={() => void run()}
            className="text-accent hover:underline"
            title="Render each member in isolation and compare the pixels — opens the Components tab"
          >
            Compare renders
          </button>
        </>
      )}
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
  const framework = useStore((s) => s.project?.framework);
  const scanning = useStore((s) => s.scanning);
  const progress = useStore((s) => s.scanProgress);
  const result = useStore((s) => s.scanResult);
  const error = useStore((s) => s.scanError);
  const runScan = useStore((s) => s.runScan);
  const openCluster = useStore((s) => s.openCluster);
  const dismissed = useStore((s) => s.dismissed);
  const visualScores = useStore((s) => s.visualScores);
  const clusters = useMemo(
    () => rankClusters(result, dismissed, visualScores),
    [result, dismissed, visualScores],
  );
  const dismissedCount = result
    ? result.clusters.length - clusters.length
    : 0;

  // Read-only with a reason, rather than a Scan button that finds nothing:
  // the duplicate engine reads React components, and a plain HTML site has
  // none to read. Everything else on the canvas works there.
  if (framework === "static") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
        <CopyIcon width={22} height={22} className="text-ink-faint" />
        <div className="text-2xs text-ink-dim leading-relaxed">
          Duplicate detection compares React components, so it has nothing to
          read in a static site. Inspection, styling, structure and the Pages
          tab all work here.
        </div>
      </div>
    );
  }

  if (scanning) {
    const pct =
      progress && progress.total > 0
        ? Math.round((progress.done / progress.total) * 100)
        : null;
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
        <CopyIcon width={22} height={22} className="text-ink-faint animate-pulse" />
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
        <ExclamationTriangleIcon width={20} height={20} className="text-danger" />
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
        <CopyIcon width={22} height={22} className="text-ink-faint" />
        <div className="text-2xs text-ink-dim">
          Select an artboard on the canvas (click its name), then scan it for
          near-duplicate components.
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
            ? `Selected artboard · ${result.scopedFiles} file${result.scopedFiles === 1 ? "" : "s"}`
            : "Whole project"}
        </span>
        {" · "}
        {result.components} components · {clusters.length} cluster
        {clusters.length === 1 ? "" : "s"}
        {dismissedCount > 0 && ` · ${dismissedCount} dismissed`}
        {age(result.scannedAt) && ` · ${age(result.scannedAt)}`}
      </div>
      <CategorizeControls />
      <VisualPassControls />
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
                <span
                  className="text-2xs text-positive tabular-nums shrink-0"
                  title={
                    visualScores[c.id]
                      ? "Structural, class and visual signals combined"
                      : "Structural and class signals (run the visual pass for the third)"
                  }
                >
                  {confidencePct(combinedConfidence(c.confidence, visualScores[c.id]))}
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
          <Cross2Icon width={12} height={12} />
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
  const visual = useStore((s) =>
    s.openClusterId ? s.visualScores[s.openClusterId] : undefined,
  );
  if (!openClusterId || !cluster) return null;
  const note = visualNote(visual);

  const shared = commonLines(cluster.members);
  const sharedClasses = new Set(
    cluster.members
      .flatMap((m) => [...new Set(m.classTokens)])
      .filter((t) => cluster.members.every((m) => m.classTokens.includes(t))),
  );

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 backdrop-blur-[2px] p-8"
      onClick={() => openCluster(null)}
    >
      <div
        className="panel w-full max-w-5xl max-h-full flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <CopyIcon width={16} height={16} className="text-ink-dim" />
          <span className="text-sm font-medium truncate">
            {cluster.members.map((m) => m.name).join(" · ")}
          </span>
          <span className="text-2xs text-positive tabular-nums">
            {confidencePct(combinedConfidence(cluster.confidence, visual))} match
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
          <MergeButton clusterId={cluster.id} />
          <button
            onClick={() => openCluster(null)}
            className="text-ink-faint hover:text-ink ml-1"
          >
            <Cross2Icon width={14} height={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {/* The visual signal is allowed to disagree with the structural one,
              and when it does the reviewer hears it before merging. */}
          {note && (
            <div
              className={`mb-3 rounded-lg border px-3 py-2 text-2xs ${
                visual?.score !== null && visual?.score !== undefined && visual.score < 0.75
                  ? "border-warn/40 bg-warn/10 text-warn"
                  : "border-line bg-surface-2 text-ink-dim"
              }`}
            >
              {note}
            </div>
          )}
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
            between members — the knobs a merge turns into props.
          </div>
        </div>
      </div>
    </div>
  );
}
