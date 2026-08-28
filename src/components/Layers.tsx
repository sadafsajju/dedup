// Layers tab (FR-6.2): the rendered element tree of every page artboard,
// synced with canvas selection both ways — clicking a row selects the element
// on the canvas, selecting on the canvas highlights, reveals, and scrolls to
// its row here. Hovering a row draws the canvas hover box, so the tree and
// the page always point at the same thing.
//
// The tree mirrors each frame's DOM (pushed by the overlay on mutations), so
// staged inserts and removes appear live, and one source element rendered
// from a `.map()` shows once per instance — same as on the page.
import { useEffect, useRef, useState } from "react";
import { sendToOverlay } from "../lib/bridge";
import { useStore } from "../lib/store";
import type { LayerNode } from "../lib/types";
import { LayersIcon, TriangleRightIcon } from "@radix-ui/react-icons";

/** Row keys are tree positions, not dedup ids — a `.map()` renders one source
 * element many times, so ids alone can't name a row. */
const keyOf = (prefix: string, index: number) => `${prefix}.${index}`;

/** Position keys of the chain leading to the first row with this id
 * (ancestors first, the row itself last), or null when it isn't in `nodes`. */
function pathToId(
  nodes: LayerNode[],
  id: string,
  prefix: string,
): string[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const key = keyOf(prefix, i);
    if (nodes[i].id === id) return [key];
    const inner = pathToId(nodes[i].children, id, key);
    if (inner) return [key, ...inner];
  }
  return null;
}

function Row({
  node,
  depth,
  rowKey,
  collapsed,
  onToggle,
}: {
  node: LayerNode;
  depth: number;
  rowKey: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const isSelected = useStore((s) => s.selected?.dedupId === node.id);
  const selectById = useStore((s) => s.selectById);
  const open = !collapsed.has(rowKey);
  const hasKids = node.children.length > 0;
  // A component's root row wears the component's name — that's the row you
  // scan for — with the tag demoted; every other row is its tag.
  const isComponentRoot = node.core === "root" && node.component !== null;

  return (
    <>
      <div
        data-layer-selected={isSelected || undefined}
        onClick={() => selectById(node.id)}
        onMouseEnter={() => sendToOverlay({ type: "hover-id", id: node.id })}
        className={`flex items-center gap-1 pr-2 py-0.75 text-2xs cursor-pointer select-none ${
          isSelected
            ? "bg-accent/15 text-accent"
            : "text-ink-dim hover:bg-surface-2 hover:text-ink"
        }`}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span
          onClick={(e) => {
            if (!hasKids) return;
            e.stopPropagation();
            onToggle(rowKey);
          }}
          className={`shrink-0 w-3.5 h-3.5 flex items-center justify-center ${
            hasKids ? "text-ink-faint hover:text-ink" : ""
          }`}
        >
          {hasKids && (
            <TriangleRightIcon
              width={12}
              height={12}
              className={open ? "rotate-90" : ""}
            />
          )}
        </span>
        <span
          className={`truncate ${isComponentRoot ? "font-medium" : ""} ${
            isComponentRoot && !isSelected ? "text-ink" : ""
          }`}
        >
          {isComponentRoot ? node.component : node.tag}
        </span>
        {isComponentRoot && (
          <span className="text-ink-faint shrink-0">{node.tag}</span>
        )}
        {node.text !== null && (
          <span className="text-ink-faint truncate">{node.text}</span>
        )}
        {node.staged && (
          <span className="ml-auto shrink-0 rounded bg-warn/15 px-1 text-[9px] leading-3 text-warn">
            unsaved
          </span>
        )}
      </div>
      {open &&
        node.children.map((child, i) => (
          <Row
            key={keyOf(rowKey, i)}
            node={child}
            depth={depth + 1}
            rowKey={keyOf(rowKey, i)}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

export function LayersTab() {
  const routes = useStore((s) => s.routes);
  const layers = useStore((s) => s.layers);
  const pageMeta = useStore((s) => s.pageMeta);
  const selectedId = useStore((s) => s.selected?.dedupId ?? null);
  const devStatus = useStore((s) => s.devStatus);
  const instrumentation = useStore((s) => s.instrumentation);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  // The overlay pushes on mutations, but this tab can mount after the last
  // push (e.g. the store was reset) — ask every frame for a fresh tree.
  useEffect(() => {
    sendToOverlay({ type: "list-layers" });
  }, []);

  // Canvas → tree sync: expand the selection's ancestors and scroll its row
  // into view, leaving everything the user collapsed elsewhere alone.
  useEffect(() => {
    if (!selectedId) return;
    setCollapsed((prev) => {
      let next: Set<string> | null = null;
      for (const [route, tree] of Object.entries(
        useStore.getState().layers,
      )) {
        const path = pathToId(tree, selectedId, route);
        if (!path) continue;
        for (const key of path.slice(0, -1)) {
          if ((next ?? prev).has(key)) {
            next = next ?? new Set(prev);
            next.delete(key);
          }
        }
      }
      return next ?? prev;
    });
    // After the expansion above has rendered the row.
    const t = setTimeout(() => {
      listRef.current
        ?.querySelector("[data-layer-selected]")
        ?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => clearTimeout(t);
  }, [selectedId]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const populated = routes.filter((r) => (layers[r] ?? []).length > 0);

  if (populated.length === 0) {
    const reason =
      instrumentation && !instrumentation.active
        ? (instrumentation.detail ??
          "element tagging is off for this session, so there is no tree to show")
        : devStatus !== "ready"
          ? "waiting for the dev server"
          : "waiting for the page to report its elements";
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
        <LayersIcon width={22} height={22} className="text-ink-faint" />
        <div className="text-2xs text-ink-dim">No layers yet — {reason}.</div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="flex-1 overflow-y-auto py-1"
      onMouseLeave={() => sendToOverlay({ type: "hover-id", id: null })}
    >
      {populated.map((route) => (
        <div key={route}>
          {/* One artboard per route — a header per artboard only once there
              is more than one, mirroring the canvas frame labels. */}
          {populated.length > 1 && (
            <div className="sticky top-0 z-10 bg-surface-1 px-2 py-1 text-2xs text-ink-faint truncate border-b border-line">
              {route === "/" ? pageMeta?.title || "Home" : route}
            </div>
          )}
          {(layers[route] ?? []).map((node, i) => (
            <Row
              key={keyOf(route, i)}
              node={node}
              depth={0}
              rowKey={keyOf(route, i)}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
