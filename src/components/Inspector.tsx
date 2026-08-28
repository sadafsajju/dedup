import { PANEL_BOUNDS, useStore } from "../lib/store";
import { parseDedupId } from "../lib/types";
import { ChatPanel } from "./ChatPanel";
import { NextSetup } from "./NextSetup";
import {
  ChatBubbleIcon,
  ChevronRightIcon,
  CodeIcon,
  Component1Icon,
  ComponentInstanceIcon,
  ExclamationTriangleIcon,
  MixerHorizontalIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { StylePanel } from "./StylePanel";
import { ResizeHandle, Section, type IconType } from "./ui";

const TABS: Array<{ id: "design" | "chat"; label: string; icon: IconType }> = [
  { id: "design", label: "Design", icon: MixerHorizontalIcon },
  { id: "chat", label: "Chat", icon: ChatBubbleIcon },
];

/**
 * Text content + structural actions for the selection. Every control here is
 * enabled by a capability the write-back reported, and disabled controls say
 * why — the same reason string the save would have failed with.
 */
function ElementActions() {
  const sourceInfo = useStore((s) => s.sourceInfo);
  const actions = useStore((s) => s.actions);
  const effectiveText = useStore((s) => s.effectiveText);
  const applyTextEdit = useStore((s) => s.applyTextEdit);
  const removeSelected = useStore((s) => s.removeSelected);
  if (!sourceInfo) return null;

  const text = actions.length >= 0 ? effectiveText() : null;

  return (
    <Section title="Content">
      {sourceInfo.canEditText ? (
        <input
          value={text ?? ""}
          onChange={(e) => applyTextEdit(e.target.value)}
          placeholder="Text"
          className="w-full rounded border border-line bg-surface-2 px-1.5 py-1 text-2xs text-ink outline-none focus:border-accent"
        />
      ) : (
        <OpenInCode
          reason={sourceInfo.textReason ?? "not a text element"}
          line={sourceInfo.line}
        />
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={removeSelected}
          disabled={!sourceInfo.canRemove}
          title={
            sourceInfo.canRemove
              ? "Delete this element (⌫)"
              : (sourceInfo.structuralReason ?? "This element can't be deleted")
          }
          className="flex items-center gap-1 rounded border border-line px-1.5 py-1 text-2xs text-ink-dim hover:text-danger hover:border-danger/40 disabled:opacity-40 disabled:hover:text-ink-dim disabled:hover:border-line"
        >
          <TrashIcon width={11} height={11} />
          Delete
        </button>
        <span className="text-2xs text-ink-faint truncate">
          {sourceInfo.canMove
            ? "Drag on the canvas to move or re-parent"
            : (sourceInfo.structuralReason ?? "")}
        </span>
      </div>
    </Section>
  );
}

/** Human explanation for why inspection is off (FR-1.6 honesty). */
/**
 * What the inspector offers where it refuses to edit.
 *
 * The refusal itself stays — dedup will not guess at a className built by
 * `cn(...)` or text that comes from a prop. But it knows the file and the
 * line that produced them, so the honest answer comes with a way out rather
 * than being a dead end: one click puts the user in front of that exact code.
 */
function OpenCodeButton({ line }: { line: number }) {
  const selected = useStore((s) => s.selected);
  const openCode = useStore((s) => s.openCode);
  const file = selected ? (parseDedupId(selected.dedupId)?.file ?? null) : null;
  if (!file) return null;
  return (
    <button
      onClick={() => void openCode(file, line)}
      title={`Open ${file}:${line} — edit it directly`}
      className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-surface-3 hover:text-ink"
    >
      <CodeIcon width={13} height={13} />
    </button>
  );
}

function OpenInCode({ reason, line }: { reason: string; line: number }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="flex-1 text-2xs text-ink-faint leading-relaxed">
        {reason}
      </span>
      <OpenCodeButton line={line} />
    </div>
  );
}

function noInspectionReason(
  mode: "custom" | "framework" | "script" | "error" | "next-optin",
  detail: string | null,
): string {
  switch (mode) {
    case "next-optin":
      return `Element inspection needs one line in ${detail ?? "next.config"} — see below.`;
    case "framework":
      return `${detail ?? "This framework"} isn't instrumented — element inspection needs dedup's tagger in the build. The canvas preview and duplicate Scan still work.`;
    case "custom":
      return "The custom dev command runs without dedup's tagging plugin, so element inspection is off. Use the project's plain `vite` dev script to inspect.";
    case "script":
      return "The dev script isn't a plain `vite` invocation, so dedup couldn't inject its tagging plugin — element inspection is off.";
    case "error":
      return `Tagging setup failed (${detail ?? "unknown error"}) — element inspection is off.`;
  }
}

export function Inspector() {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  const instrumentation = useStore((s) => s.instrumentation);
  const selectById = useStore((s) => s.selectById);
  const sourceInfo = useStore((s) => s.sourceInfo);
  const actions = useStore((s) => s.actions);
  const tab = useStore((s) => s.inspectorTab);
  const setTab = useStore((s) => s.setInspectorTab);
  const effectiveClassName = useStore((s) => s.effectiveClassName);
  // Recomputed whenever the program changes — `actions` is read above so this
  // component re-renders on every staged edit.
  const effective = actions.length >= 0 ? effectiveClassName() : null;

  // Ancestry arrives innermost-first; breadcrumb reads root-first (FR-2.4).
  const crumbs = selected ? [...selected.ancestry].reverse() : [];
  const src = selected ? parseDedupId(selected.dedupId) : null;
  const width = useStore((s) => s.panelWidths.inspector);
  const setPanelWidth = useStore((s) => s.setPanelWidth);

  return (
    <aside
      style={{ width }}
      className="panel absolute right-3 top-16 bottom-16 z-20 flex flex-col overflow-hidden"
    >
      <ResizeHandle
        side="left"
        label="Inspector width"
        width={width}
        min={PANEL_BOUNDS.inspector.min}
        max={PANEL_BOUNDS.inspector.max}
        onResize={(px) => setPanelWidth("inspector", px)}
        onReset={() => setPanelWidth("inspector", PANEL_BOUNDS.inspector.default)}
      />
      {/* Same segmented control as the sidebar's — two panels of the same
          chrome must not each invent their own tab pattern. */}
      <div className="shrink-0 p-2">
        <div className="flex items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.label}
              className={`flex flex-1 items-center justify-center gap-1.5 h-7 rounded-lg text-2xs transition-colors ${
                tab === t.id
                  ? "bg-surface-3 text-ink shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                  : "text-ink-dim hover:text-ink"
              }`}
            >
              <t.icon width={13} height={13} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "chat" ? (
        <ChatPanel />
      ) : selected ? (
        <div className="flex-1 overflow-y-auto">
          {/* Selection header (FR-3.1 seed) */}
          <div className="px-3 py-3 border-b border-line">
            <div className="flex items-center gap-1.5">
              {selected.component ? (
                <Component1Icon
                  width={13}
                  height={13}
                  className="shrink-0 text-accent"
                />
              ) : (
                <ComponentInstanceIcon
                  width={13}
                  height={13}
                  className="shrink-0 text-ink-faint"
                />
              )}
              <span className="text-[13px] font-semibold truncate">
                {selected.component ?? selected.tag}
              </span>
              <span className="text-2xs font-mono text-ink-faint bg-surface-2 rounded px-1 py-0.5">
                {selected.tag}
              </span>
              {selected.instanceCount > 1 && (
                <span
                  className="text-2xs text-warn bg-warn/10 rounded px-1.5 py-0.5 shrink-0"
                  title="This source element renders multiple DOM instances (e.g. inside a .map()). Edits affect all of them."
                >
                  ×{selected.instanceCount}
                </span>
              )}
            </div>
            {src && (
              <div className="mt-1.5 text-2xs font-mono text-ink-dim truncate">
                {src.file}
                {/* Position comes from the write-back's live parse, not from
                    the id — after an edit shifts the file, this stays true. */}
                {sourceInfo && sourceInfo.line > 0 && (
                  <span className="text-ink-faint">
                    :{sourceInfo.line}:{sourceInfo.col}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Component ancestry breadcrumb (FR-2.4) */}
          <Section title="Ancestry">
            <div className="flex flex-wrap items-center gap-y-1">
              {crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1;
                return (
                  <span key={`${c.dedupId}-${i}`} className="flex items-center">
                    <button
                      onClick={() => !isLast && selectById(c.dedupId)}
                      disabled={isLast}
                      className={`text-2xs rounded px-1 py-0.5 ${
                        isLast
                          ? "text-ink font-medium"
                          : "text-ink-dim hover:text-ink hover:bg-surface-2"
                      }`}
                      title={c.dedupId}
                    >
                      {c.component ?? c.tag}
                      {c.component && (
                        <span className="text-ink-faint"> · {c.tag}</span>
                      )}
                    </button>
                    {!isLast && (
                      <ChevronRightIcon
                        width={11}
                        height={11}
                        className="text-ink-faint mx-0.5"
                      />
                    )}
                  </span>
                );
              })}
            </div>
          </Section>

          {/* Content + structure: what this element is made of, and what may
              be done to it. Both are gated by the write-back's own report, so
              a control is only offered when the save would accept it. */}
          {sourceInfo !== null && <ElementActions />}

          {sourceInfo === null ? (
            <div className="px-3 py-3 text-2xs text-ink-faint">
              Reading source…
            </div>
          ) : sourceInfo.editable && effective !== null ? (
            <StylePanel className={effective} />
          ) : (
            <div className="px-3 py-3 border-b border-line">
              <div className="flex gap-2 items-start">
                <ExclamationTriangleIcon
                  width={13}
                  height={13}
                  className="text-warn shrink-0 mt-px"
                />
                <div className="flex-1 text-2xs text-ink-dim leading-relaxed">
                  <span className="text-ink">Read-only:</span> this element's
                  classes are {sourceInfo.reason ?? "not statically editable"}.
                  dedup only rewrites what it can rewrite safely — open the
                  source to change it yourself.
                </div>
                <OpenCodeButton line={sourceInfo.line} />
              </div>
              {selected.domClassName && (
                <div className="mt-2 text-2xs font-mono text-ink-faint break-words select-text">
                  {selected.domClassName}
                </div>
              )}
            </div>
          )}
        </div>
      ) : instrumentation && !instrumentation.active ? (
        <div className="flex-1 flex flex-col justify-center gap-2 overflow-auto py-4">
          <div className="flex flex-col items-center gap-2 px-6 text-center">
            <ExclamationTriangleIcon width={16} height={16} className="text-warn" />
            <div className="text-2xs text-ink-dim leading-relaxed">
              {noInspectionReason(
                instrumentation.mode as Exclude<
                  typeof instrumentation.mode,
                  "tagged"
                >,
                instrumentation.detail,
              )}
            </div>
          </div>
          {/* Next.js: the one case where the reason comes with a fix. */}
          <NextSetup />
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-2">
          <div className="text-2xs text-ink-dim leading-relaxed">
            Click an element on the canvas to inspect it. Hover shows the
            component under the cursor.
          </div>
        </div>
      )}

      <div className="border-t border-line px-3 py-2 text-2xs text-ink-faint flex items-center justify-between">
        <span>{project?.hasTailwind ? "Tailwind detected" : "No Tailwind"}</span>
        <span className="font-mono">{project?.framework}</span>
      </div>
    </aside>
  );
}
