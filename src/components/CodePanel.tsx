// The split code panel — the escape hatch behind every "dedup can't edit
// this here".
//
// The inspector's refusals are honest but they used to be dead ends: text that
// comes from an expression, a className computed by `cn(...)`. dedup will not
// guess at those, and it shouldn't — but it does know exactly which file and
// which line produced them, so it can put the user in front of that code
// instead of leaving them to go find it.
//
// Editing here is real editing, and it goes through the same gate as every
// other generated write: the sidecar re-parses the file strictly and refuses
// anything that doesn't parse, then the change lands as its own commit on the
// session branch. Nothing about "the user typed it" makes it safer to write a
// file that no longer compiles.
//
// The highlighting is painted *behind* a transparent textarea, which is the
// only reason it can stay a lexer rather than an editor library — but it also
// means the two must render byte-identical text, or the caret drifts from the
// characters. `tokenize` guarantees that (see lib/highlight).
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Cross2Icon, FileTextIcon } from "@radix-ui/react-icons";
import { PANEL_BOUNDS, useStore } from "../lib/store";
import { TOKEN_CLASS, tokenize } from "../lib/highlight";
import { ResizeHandle } from "./ui";

/** Matches the textarea's own metrics exactly — the two layers are stacked. */
const CODE_STYLE: React.CSSProperties = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 11.5,
  // An integer, not a ratio: the gutter renders one <div> per line while the
  // code renders as one text flow, and a fractional line box rounds
  // differently between them — by line 200 the numbers no longer line up with
  // the code they label.
  lineHeight: "18px",
  tabSize: 2,
  whiteSpace: "pre",
};

const LINE_HEIGHT = 18;

export function CodePanel() {
  const code = useStore((s) => s.codePanel);
  const closeCode = useStore((s) => s.closeCode);
  const setCodeDraft = useStore((s) => s.setCodeDraft);
  const saveCode = useStore((s) => s.saveCode);
  const width = useStore((s) => s.panelWidths.code);
  const inspectorWidth = useStore((s) => s.panelWidths.inspector);
  const setPanelWidth = useStore((s) => s.setPanelWidth);
  const scrollRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const dirty = !!code && code.draft !== code.original;
  const lines = useMemo(() => (code ? code.draft.split("\n") : []), [code]);
  const tokens = useMemo(
    () => (code ? tokenize(code.draft) : []),
    [code?.draft],
  );

  // Reveal the element's line whenever the panel is pointed at a new one.
  // useLayoutEffect so the scroll lands before paint rather than as a jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !code || code.loading) return;
    const target = (code.line - 1) * LINE_HEIGHT;
    // Centre it, but never scroll past the top for a line near the start.
    el.scrollTop = Math.max(0, target - el.clientHeight / 2);
  }, [code?.file, code?.line, code?.loading]);

  // ⌘S saves the panel while it has focus, rather than the canvas's staged
  // edits — the user is looking at a file, so that is what "save" means here.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        e.stopPropagation();
        void saveCode();
      }
    };
    area.addEventListener("keydown", onKey);
    return () => area.removeEventListener("keydown", onKey);
  }, [saveCode]);

  if (!code) return null;

  return (
    <aside
      style={{ width, right: inspectorWidth + 24 }}
      className="panel absolute top-16 bottom-16 z-20 flex flex-col overflow-hidden"
    >
      <ResizeHandle
        side="left"
        label="Code panel width"
        width={width}
        min={PANEL_BOUNDS.code.min}
        max={PANEL_BOUNDS.code.max}
        onResize={(px) => setPanelWidth("code", px)}
        onReset={() => setPanelWidth("code", PANEL_BOUNDS.code.default)}
      />

      <div className="flex items-center gap-2 px-3 h-9 shrink-0 border-b border-line">
        <FileTextIcon width={12} height={12} className="text-ink-faint shrink-0" />
        <span className="font-mono text-2xs truncate" title={code.file}>
          {code.file}
        </span>
        <span className="text-[10px] text-ink-faint shrink-0">:{code.line}</span>
        <span className="flex-1" />
        {dirty && (
          <button
            onClick={() => void saveCode()}
            disabled={code.saving}
            className="rounded-lg px-2 py-0.5 text-2xs font-medium bg-accent text-white hover:brightness-110 disabled:opacity-60"
            title="Write this file and commit it (⌘S)"
          >
            {code.saving ? "Saving…" : "Save"}
          </button>
        )}
        <button
          onClick={closeCode}
          className="text-ink-faint hover:text-ink shrink-0"
          title="Close the code panel"
        >
          <Cross2Icon width={13} height={13} />
        </button>
      </div>

      {code.error && (
        <div className="shrink-0 border-b border-line bg-danger/10 px-3 py-2 text-2xs text-danger">
          {code.error}
        </div>
      )}

      {code.loading ? (
        <div className="flex-1 flex items-center justify-center text-2xs text-ink-faint">
          Loading {code.file}…
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
          {/* w-max so the column is as wide as its longest line: the
              highlight layer and the textarea are stacked, so they have to
              scroll as one thing. Sizing the textarea to the *viewport* would
              put the end of a long line beyond the caret's reach. */}
          <div className="flex min-h-full w-max min-w-full">
            {/* Gutter. Its own column so line numbers can't drift out of
                step with the text the way an inline prefix would, and pinned
                left so scrolling to the end of a long line doesn't take the
                numbers with it. Opaque, so code scrolls *under* it. */}
            <div
              style={CODE_STYLE}
              className="sticky left-0 z-10 shrink-0 select-none border-r border-line bg-surface-1 px-2 text-right text-ink-faint"
            >
              {lines.map((_, i) => (
                <div
                  key={i}
                  className={i + 1 === code.line ? "text-accent" : undefined}
                >
                  {i + 1}
                </div>
              ))}
            </div>

            <div className="relative min-w-0 flex-1">
              {/* The selected element's line, marked behind everything. */}
              <div
                className="pointer-events-none absolute inset-x-0 bg-accent/10"
                style={{
                  top: (code.line - 1) * LINE_HEIGHT,
                  height: LINE_HEIGHT,
                }}
              />
              {/* Colour layer. aria-hidden: the textarea is the real content,
                  and a screen reader should not hear the file twice. */}
              <pre
                aria-hidden
                style={CODE_STYLE}
                className="pointer-events-none m-0 px-3 py-0"
              >
                {tokens.map((t, i) => (
                  <span key={i} className={TOKEN_CLASS[t.kind]}>
                    {t.text}
                  </span>
                ))}
              </pre>
              <textarea
                ref={areaRef}
                value={code.draft}
                onChange={(e) => setCodeDraft(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                style={CODE_STYLE}
                // Transparent text over the painted layer; a visible caret is
                // the only thing this layer contributes visually.
                className="absolute inset-0 w-full resize-none overflow-hidden bg-transparent px-3 py-0 text-transparent caret-ink outline-none selection:bg-accent/30"
              />
            </div>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
        {dirty
          ? "Unsaved. Save re-parses the file and refuses anything that doesn't compile, then commits it."
          : "Saved changes land as their own commit — undo from History."}
      </div>
    </aside>
  );
}
