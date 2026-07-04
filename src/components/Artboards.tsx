// Rendered component artboards (FR-5.2/5.3): after a scan, every qualifying
// component renders in isolation beside the app frame, Figma-style. Cluster
// members sit together under a confidence label; clicking one opens the
// cluster review. Each artboard is a harness iframe served by the tagger
// plugin; components that fail in isolation show why instead of a preview.
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../lib/store";
import { VIEWPORTS } from "../lib/types";
import type { GalleryEntry, ScanCluster } from "../lib/types";
import { WarnIcon } from "./icons";

export const ARTBOARD_W = 360;
const MIN_H = 120;
const MAX_H = 800;
const GAP = 32;
const GROUP_PAD = 20;
const COLS = 3;
/** Gap between the app frame and the artboard field. */
export const FIELD_OFFSET = 160;

interface Board {
  key: string; // file#name
  entry: GalleryEntry;
  x: number;
  y: number;
  h: number;
}

interface Group {
  cluster: ScanCluster;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SectionLabel {
  title: string;
  x: number;
  y: number;
}

type SizeMap = Record<string, { h: number } | { error: string }>;

/** Lay out cluster groups first (members in a row), then singles in a grid.
 * When AI categories exist, the same layout repeats per category section. */
function layout(
  gallery: GalleryEntry[],
  clusters: ScanCluster[],
  sizes: SizeMap,
  originX: number,
  categories: Record<string, string>,
) {
  const boards: Board[] = [];
  const groups: Group[] = [];
  const sections: SectionLabel[] = [];
  const heightOf = (m: GalleryEntry) => {
    const s = sizes[`${m.file}#${m.name}`];
    if (s && "error" in s) return 160;
    return s && "h" in s ? Math.min(Math.max(s.h, MIN_H), MAX_H) : 240;
  };

  // Bucket the gallery: categorized sections in stable order, uncategorized
  // last (or one unlabeled bucket when no categories at all).
  const hasCategories = Object.keys(categories).length > 0;
  const buckets = new Map<string, GalleryEntry[]>();
  for (const g of gallery) {
    const cat = hasCategories
      ? (categories[`${g.file}#${g.name}`] ?? "Uncategorized")
      : "";
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(g);
  }
  const order = [...buckets.keys()].sort((a, b) => {
    if (a === "Uncategorized") return 1;
    if (b === "Uncategorized") return -1;
    return a.localeCompare(b);
  });

  let y = 0;
  // A cluster's members can be categorized into different buckets; the
  // cluster renders once, in its anchor member's section. Track globally so
  // no component ever gets two boards.
  const placedKeys = new Set<string>();
  for (const cat of order) {
    const bucket = buckets.get(cat)!;
    if (cat !== "") {
      sections.push({ title: cat, x: originX - GROUP_PAD, y });
      y += 44; // headroom under the section title
    }

    // Clusters whose FIRST member lives in this bucket render here, intact.
    const bucketKeys = new Set(bucket.map((m) => `${m.file}#${m.name}`));
    for (const cluster of clusters) {
      const members = gallery.filter((g) => g.clusterId === cluster.id);
      if (members.length === 0) continue;
      const anchor = `${members[0].file}#${members[0].name}`;
      if (!bucketKeys.has(anchor) || placedKeys.has(anchor)) continue;
      members.forEach((m) => placedKeys.add(`${m.file}#${m.name}`));
      const rowH = Math.max(...members.map(heightOf));
      members.forEach((m, i) => {
        boards.push({
          key: `${m.file}#${m.name}`,
          entry: m,
          x: originX + i * (ARTBOARD_W + GAP),
          y,
          h: rowH,
        });
      });
      groups.push({
        cluster,
        x: originX - GROUP_PAD,
        y: y - GROUP_PAD,
        w: members.length * (ARTBOARD_W + GAP) - GAP + GROUP_PAD * 2,
        h: rowH + GROUP_PAD * 2,
      });
      y += rowH + GAP * 2.5;
    }

    let rowTop = y;
    let rowMax = 0;
    let placed = 0;
    for (const m of bucket) {
      const key = `${m.file}#${m.name}`;
      if (placedKeys.has(key)) continue; // rendered in a cluster group
      placedKeys.add(key);
      const col = placed % COLS;
      if (col === 0 && placed > 0) {
        rowTop += rowMax + GAP;
        rowMax = 0;
      }
      const h = heightOf(m);
      rowMax = Math.max(rowMax, h);
      boards.push({ key, entry: m, x: originX + col * (ARTBOARD_W + GAP), y: rowTop, h });
      placed++;
    }
    if (placed > 0) y = rowTop + rowMax + GAP;
    y += cat !== "" ? GAP * 2 : 0; // breathing room between sections
  }

  return { boards, groups, sections };
}

/** Calm, Framer-ish placeholder for artboards that can't show a preview. */
function Unavailable({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      className="h-full flex flex-col items-center justify-center gap-1.5 px-6 text-center"
      title={detail}
    >
      <WarnIcon size={13} className="text-ink-faint" />
      <div className="text-2xs text-ink-dim">{title}</div>
      <div className="text-2xs text-ink-faint line-clamp-2 break-all">{detail}</div>
    </div>
  );
}

export function Artboards() {
  const scanResult = useStore((s) => s.scanResult);
  const devUrl = useStore((s) => s.devUrl);
  const instrumentation = useStore((s) => s.instrumentation);
  const pan = useStore((s) => s.pan);
  const zoom = useStore((s) => s.zoom);
  const viewportId = useStore((s) => s.viewportId);
  const viewportWidth = VIEWPORTS.find((v) => v.id === viewportId)!.width;
  const openCluster = useStore((s) => s.openCluster);
  const categories = useStore((s) => s.categories);
  const mockProps = useStore((s) => s.mockProps);
  const [sizes, setSizes] = useState<SizeMap>({});

  // Natural sizes / render failures reported by the harness iframes.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.__dedup !== true || !m.file || !m.name) return;
      const key = `${m.file}#${m.name}`;
      if (m.type === "harness-size") {
        setSizes((prev) => {
          const cur = prev[key];
          const h = Math.ceil(m.height as number);
          if (cur && "h" in cur && cur.h === h) return prev;
          return { ...prev, [key]: { h } };
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

  const originX = viewportWidth + FIELD_OFFSET;
  const { boards, groups, sections } = useMemo(
    () =>
      scanResult
        ? layout(scanResult.gallery, scanResult.clusters, sizes, originX, categories)
        : { boards: [], groups: [], sections: [] },
    [scanResult, sizes, originX, categories],
  );

  if (!scanResult || !devUrl || !instrumentation?.active) return null;

  const origin = new URL(devUrl).origin;

  // Only mount iframes near the visible area — 100 live vite pages would
  // bring the canvas to its knees. Positions are known, so culling is math.
  const view = {
    left: -pan.x / zoom - 600,
    top: -pan.y / zoom - 600,
    right: (-pan.x + window.innerWidth) / zoom + 600,
    bottom: (-pan.y + window.innerHeight) / zoom + 600,
  };
  const visible = (b: Board) =>
    b.x < view.right && b.x + ARTBOARD_W > view.left && b.y < view.bottom && b.y + b.h > view.top;

  // Counter-scale labels so they render at constant screen size at any zoom:
  // parent layer scales by `zoom`, label scales by 1/zoom → net 1. The local
  // translateY lifts the label above the board edge, also in screen units.
  const label = {
    transform: `scale(${1 / zoom}) translateY(calc(-100% - 6px))`,
    transformOrigin: "top left",
  };

  return (
    <>
      {/* Category section titles (Framer-style), constant screen size. */}
      {sections.map((s) => (
        <div
          key={s.title}
          className="absolute select-none pointer-events-none whitespace-nowrap"
          style={{
            left: s.x,
            top: s.y,
            transform: `scale(${1 / zoom})`,
            transformOrigin: "top left",
          }}
        >
          <span className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
            {s.title}
          </span>
        </div>
      ))}

      {groups.map((g) => (
        <div key={g.cluster.id}>
          <div
            className="absolute rounded-xl border border-accent/35 bg-accent/[0.03]"
            style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
          />
          <div
            className="absolute text-2xs text-accent select-none pointer-events-none whitespace-nowrap"
            style={{ left: g.x, top: g.y, ...label }}
          >
            Possible duplicates · {Math.round(g.cluster.confidence * 100)}% ·{" "}
            {g.cluster.totalCallSites} call site{g.cluster.totalCallSites === 1 ? "" : "s"}
          </div>
        </div>
      ))}

      {boards.map((b) => {
        const size = sizes[b.key];
        const failed = size && "error" in size;
        // File-local components import through a ?dedup-export=Name virtual
        // export the tagger appends for harness requests only.
        const fileParam =
          b.entry.exportKind === "local"
            ? `${b.entry.file}?dedup-export=${b.entry.name}`
            : b.entry.file;
        const nameParam =
          b.entry.exportKind === "default" ? "default" : b.entry.name;
        const props = mockProps[b.key];
        const src =
          `${origin}/__dedup/harness?file=${encodeURIComponent(fileParam)}` +
          `&name=${encodeURIComponent(nameParam)}` +
          (props ? `&props=${encodeURIComponent(props)}` : "");
        return (
          <div key={b.key}>
            <div
              className="absolute text-2xs select-none pointer-events-none whitespace-nowrap"
              style={{ left: b.x, top: b.y, ...label }}
            >
              <span className="text-ink font-medium">{b.entry.name}</span>
              <span className="text-ink-faint"> · {b.entry.callSites} use{b.entry.callSites === 1 ? "" : "s"}</span>
            </div>
            <div
              className={`absolute rounded-lg overflow-hidden ring-1 transition-shadow ${
                b.entry.clusterId
                  ? "ring-accent/40 shadow-[0_8px_30px_rgba(0,0,0,0.35)]"
                  : "ring-black/10 shadow-[0_4px_20px_rgba(0,0,0,0.3)]"
              } ${failed ? "bg-surface-1" : "bg-white"}`}
              style={{ left: b.x, top: b.y, width: ARTBOARD_W, height: b.h }}
            >
              {failed ? (
                <Unavailable
                  title="Preview unavailable"
                  detail={(size as { error: string }).error}
                />
              ) : visible(b) ? (
                <iframe src={src} title={b.key} className="w-full h-full border-0" />
              ) : (
                <div className="h-full bg-surface-1" />
              )}
              {/* Static previews: block iframe interaction so pan/click work. */}
              <div
                className={`absolute inset-0 ${b.entry.clusterId ? "cursor-pointer hover:bg-accent/5" : ""}`}
                onClick={() => b.entry.clusterId && openCluster(b.entry.clusterId)}
                title={
                  b.entry.clusterId
                    ? "Open cluster review"
                    : `${b.entry.file} · ${b.entry.callSites} call site${b.entry.callSites === 1 ? "" : "s"}`
                }
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
