// Components tab (FR-5.2/5.3): the scanned component gallery in its own
// top-level view. Every qualifying component renders in isolation through the
// tagger's harness iframe, and the card takes the component's own measured
// width × height — not a fixed artboard size. Cluster members sit together in
// an accent group labeled with confidence + call sites; clicking a member
// opens the cluster review. AI categories (when present) become sections.
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";

/** Same clearances the canvas uses for the floating panels. */
const CHROME_GUTTER = 24;
const CHROME_TOP = 68;
const CHROME_BOTTOM = 64;
import type { GalleryEntry, ScanCluster } from "../lib/types";
import { CopyIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";

/** Harness iframes render this wide so a component's intrinsic width is never
 * clamped by its frame; the card then crops to the measured size. */
const PROBE_W = 800;
const MIN_W = 80;
const MAX_W = PROBE_W;
const MIN_H = 60;
const MAX_H = 800;
/** Placeholder card size until the harness reports a measurement. */
const DEFAULT_W = 360;
const DEFAULT_H = 240;

type SizeMap = Record<
  string,
  { w: number; h: number } | { error: string }
>;

const keyOf = (e: GalleryEntry) => `${e.file}#${e.name}`;

function sizeOf(sizes: SizeMap, key: string) {
  const s = sizes[key];
  if (!s) return { w: DEFAULT_W, h: DEFAULT_H, error: null };
  if ("error" in s) return { w: DEFAULT_W, h: 160, error: s.error };
  return {
    w: Math.min(Math.max(s.w, MIN_W), MAX_W),
    h: Math.min(Math.max(s.h, MIN_H), MAX_H),
    error: null,
  };
}

interface Section {
  title: string;
  groups: { cluster: ScanCluster; members: GalleryEntry[] }[];
  singles: GalleryEntry[];
}

/** Bucket the gallery by AI category (Uncategorized last, one unlabeled
 * bucket when no categories at all). A cluster renders once, intact, in its
 * anchor member's section — no component ever gets two cards. */
function sectionize(
  gallery: GalleryEntry[],
  clusters: ScanCluster[],
  categories: Record<string, string>,
): Section[] {
  const hasCategories = Object.keys(categories).length > 0;
  const buckets = new Map<string, GalleryEntry[]>();
  for (const g of gallery) {
    const cat = hasCategories ? (categories[keyOf(g)] ?? "Uncategorized") : "";
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(g);
  }
  const order = [...buckets.keys()].sort((a, b) => {
    if (a === "Uncategorized") return 1;
    if (b === "Uncategorized") return -1;
    return a.localeCompare(b);
  });

  const placed = new Set<string>();
  const sections: Section[] = [];
  for (const cat of order) {
    const bucket = buckets.get(cat)!;
    const bucketKeys = new Set(bucket.map(keyOf));
    const groups: Section["groups"] = [];
    for (const cluster of clusters) {
      const members = gallery.filter((g) => g.clusterId === cluster.id);
      if (members.length === 0) continue;
      const anchor = keyOf(members[0]);
      if (!bucketKeys.has(anchor) || placed.has(anchor)) continue;
      members.forEach((m) => placed.add(keyOf(m)));
      groups.push({ cluster, members });
    }
    const singles = bucket.filter((m) => {
      if (placed.has(keyOf(m))) return false; // rendered in a cluster group
      placed.add(keyOf(m));
      return true;
    });
    sections.push({ title: cat, groups, singles });
  }
  return sections;
}

/** Mount live iframes only near the viewport — dozens of vite pages at once
 * would bring the view to its knees. Also unmounts them while the whole tab
 * is hidden (display:none never intersects). */
function useNear<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), {
      rootMargin: "600px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, near };
}

/** Calm placeholder for cards that can't show a preview. */
function Unavailable({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      className="h-full flex flex-col items-center justify-center gap-1.5 px-6 text-center"
      title={detail}
    >
      <ExclamationTriangleIcon width={13} height={13} className="text-ink-faint" />
      <div className="text-2xs text-ink-dim">{title}</div>
      <div className="text-2xs text-ink-faint line-clamp-2 break-all">{detail}</div>
    </div>
  );
}

function ComponentCard({
  entry,
  sizes,
  origin,
}: {
  entry: GalleryEntry;
  sizes: SizeMap;
  origin: string | null;
}) {
  const { ref, near } = useNear<HTMLDivElement>();
  const openCluster = useStore((s) => s.openCluster);
  const mockProps = useStore((s) => s.mockProps);
  const key = keyOf(entry);

  // Preferred: the component's rendered size on the scanned artboard — the
  // card shows it at exactly the dimensions it has on the site. Fallback:
  // the harness's own intrinsic measurement (component not on that page, or
  // an overlay bundle from before the size report existed).
  const liveRaw = useStore((s) => s.liveSizes[key]);
  const live =
    liveRaw &&
    liveRaw.w >= 20 &&
    liveRaw.w <= 4000 &&
    liveRaw.h >= 10 &&
    liveRaw.h <= 4000
      ? liveRaw
      : null;
  const measured = sizeOf(sizes, key);
  const error = measured.error;
  const w = live ? live.w : measured.w;
  const h = live ? live.h : measured.h;
  // Oversized components (full-width heroes, page sections) render at true
  // size and scale down to fit the card row, Figma-style.
  const scale = Math.min(1, MAX_W / w);
  const cardW = Math.round(w * scale);
  const cardH = Math.round(h * scale);

  // File-local components import through a ?dedup-export=Name virtual export
  // the tagger appends for harness requests only.
  const fileParam =
    entry.exportKind === "local"
      ? `${entry.file}?dedup-export=${entry.name}`
      : entry.file;
  const nameParam = entry.exportKind === "default" ? "default" : entry.name;
  const props = mockProps[key];
  const src = origin
    ? `${origin}/__dedup/harness?file=${encodeURIComponent(fileParam)}` +
      `&name=${encodeURIComponent(nameParam)}` +
      (props ? `&props=${encodeURIComponent(props)}` : "") +
      // Lock the harness layout to the on-page width so the preview wraps
      // and flows exactly like the site.
      (live ? `&w=${live.w}` : "")
    : null;

  return (
    <div
      ref={ref}
      // The visual similarity pass captures cards by this key — a rendered
      // component has to be addressable from outside this component for its
      // pixels to become a signal (FR-5.2).
      data-component-card={key}
      className="shrink-0"
      style={{ maxWidth: "100%" }}
    >
      <div className="mb-1 text-2xs select-none truncate" style={{ maxWidth: cardW }}>
        <span className="text-ink font-medium">{entry.name}</span>
        <span className="text-ink-faint">
          {" "}· {entry.callSites} use{entry.callSites === 1 ? "" : "s"}
          {live && (
            <span className="tabular-nums">
              {" "}· {live.w}×{live.h}
            </span>
          )}
        </span>
      </div>
      <div
        className={`relative rounded-lg overflow-hidden ring-1 transition-shadow ${
          entry.clusterId
            ? "ring-accent/40 shadow-[0_8px_30px_rgba(0,0,0,0.35)]"
            : "ring-black/10 shadow-[0_4px_20px_rgba(0,0,0,0.3)]"
        } ${error || !src ? "bg-surface-1" : "bg-white"}`}
        data-component-surface={key}
        style={{ width: cardW, height: cardH, maxWidth: "100%" }}
      >
        {error ? (
          <Unavailable title="Preview unavailable" detail={error} />
        ) : !src ? (
          <Unavailable
            title="Preview offline"
            detail="Previews render through the project's dev server."
          />
        ) : near ? (
          // Live-sized: render at the true on-page dimensions, scaled to the
          // card. Fallback: wider than the card so intrinsic width measures
          // true; the card crops to the component's own reported size.
          <iframe
            src={src}
            title={key}
            className="border-0"
            style={
              live
                ? {
                    width: w,
                    height: h,
                    transform: `scale(${scale})`,
                    transformOrigin: "top left",
                  }
                : { width: PROBE_W, height: h }
            }
          />
        ) : (
          <div className="h-full bg-surface-1" />
        )}
        {/* Static previews: block iframe interaction so clicks work. */}
        <div
          className={`absolute inset-0 ${
            entry.clusterId ? "cursor-pointer hover:bg-accent/5" : ""
          }`}
          onClick={() => entry.clusterId && openCluster(entry.clusterId)}
          title={
            entry.clusterId
              ? "Open cluster review"
              : `${entry.file} · ${entry.callSites} call site${entry.callSites === 1 ? "" : "s"}`
          }
        />
      </div>
    </div>
  );
}

function scanAge(scannedAt: number | undefined): string | null {
  if (!scannedAt) return null;
  const mins = Math.round((Date.now() - scannedAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ComponentsView() {
  const editorTab = useStore((s) => s.editorTab);
  const scanResult = useStore((s) => s.scanResult);
  const scanning = useStore((s) => s.scanning);
  const devUrl = useStore((s) => s.devUrl);
  const instrumentation = useStore((s) => s.instrumentation);
  const categories = useStore((s) => s.categories);
  const mockProps = useStore((s) => s.mockProps);
  const panelWidths = useStore((s) => s.panelWidths);
  const [sizes, setSizes] = useState<SizeMap>({});

  // Natural sizes / render failures reported by the harness iframes. Runs
  // even while the tab is hidden — measurements land right after a scan.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.__dedup !== true || !m.file || !m.name) return;
      const key = `${m.file}#${m.name}`;
      if (m.type === "harness-size") {
        setSizes((prev) => {
          const w = Math.ceil((m.width as number) || DEFAULT_W);
          const h = Math.ceil(m.height as number);
          const cur = prev[key];
          if (cur && "w" in cur && cur.w === w && cur.h === h) return prev;
          return { ...prev, [key]: { w, h } };
        });
      } else if (m.type === "harness-error") {
        setSizes((prev) =>
          prev[key] && "error" in prev[key]!
            ? prev
            : { ...prev, [key]: { error: String(m.error ?? "render failed") } },
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // New scan or fresh mock props → forget stale measurements (a component
  // that failed with empty props may render fine with mocked ones).
  useEffect(() => setSizes({}), [scanResult, mockProps]);

  const sections = useMemo(
    () =>
      scanResult
        ? sectionize(scanResult.gallery, scanResult.clusters, categories)
        : [],
    [scanResult, categories],
  );

  const origin =
    devUrl && instrumentation?.active ? new URL(devUrl).origin : null;

  return (
    <div
      // The gallery scrolls under the floating chrome like the canvas does,
      // so it pads itself out of the panels' way rather than tucking its
      // first column of cards behind the sidebar.
      style={{
        paddingLeft: panelWidths.sidebar + CHROME_GUTTER,
        paddingRight: panelWidths.inspector + CHROME_GUTTER,
        paddingTop: CHROME_TOP,
        paddingBottom: CHROME_BOTTOM,
      }}
      className={`flex-1 min-w-0 overflow-y-auto bg-surface-0 ${
        editorTab === "components" ? "" : "hidden"
      }`}
    >
      {scanning ? (
        <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
          <CopyIcon width={22} height={22} className="text-ink-faint animate-pulse" />
          <div className="text-2xs text-ink-dim">Scanning components…</div>
        </div>
      ) : !scanResult || scanResult.gallery.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
          <CopyIcon width={22} height={22} className="text-ink-faint" />
          <div className="text-2xs text-ink-dim max-w-sm">
            No components yet. On the Canvas tab, select an artboard by
            clicking its name above the frame, then press Scan — each of its
            components renders here at its exact size.
          </div>
        </div>
      ) : (
        <div className="px-8 py-6">
          <div className="mb-6 text-2xs text-ink-faint">
            <span className="text-ink-dim">
              {scanResult.scopedFiles !== null
                ? `Scanned artboard · ${scanResult.scopedFiles} file${scanResult.scopedFiles === 1 ? "" : "s"}`
                : "Whole project"}
            </span>
            {" · "}
            {scanResult.gallery.length} component
            {scanResult.gallery.length === 1 ? "" : "s"}
            {scanAge(scanResult.scannedAt) && ` · ${scanAge(scanResult.scannedAt)}`}
          </div>
          {sections.map((s) => (
            <div key={s.title || "all"} className="mb-10">
              {s.title !== "" && (
                <div className="mb-4 text-xs font-semibold uppercase tracking-widest text-ink-dim select-none">
                  {s.title}
                </div>
              )}
              {s.groups.map((g) => (
                <div
                  key={g.cluster.id}
                  className="mb-6 rounded-xl border border-accent/35 bg-accent/[0.03] p-5"
                >
                  <div className="mb-3 text-2xs text-accent select-none">
                    Possible duplicates · {Math.round(g.cluster.confidence * 100)}%
                    {" · "}
                    {g.cluster.totalCallSites} call site
                    {g.cluster.totalCallSites === 1 ? "" : "s"}
                  </div>
                  <div className="flex flex-wrap items-start gap-6">
                    {g.members.map((m) => (
                      <ComponentCard
                        key={keyOf(m)}
                        entry={m}
                        sizes={sizes}
                        origin={origin}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {s.singles.length > 0 && (
                <div className="flex flex-wrap items-start gap-6">
                  {s.singles.map((m) => (
                    <ComponentCard
                      key={keyOf(m)}
                      entry={m}
                      sizes={sizes}
                      origin={origin}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
