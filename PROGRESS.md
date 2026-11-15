# dedup — build progress

Tracks phase completion against [dedup-mvp-prd.md](./dedup-mvp-prd.md).
Updated at the end of every phase (and for significant mid-phase decisions).
Format per phase: what shipped, FR coverage, deviations from the PRD, and
known limitations accepted knowingly.

**Current state (2026-11-10): visual editor; deduplication removed.**

The Canvas/Components tab switch and component gallery have also been removed.
The editor now opens directly onto its canvas. Component scan controls and
frontend gallery state no longer run or restore in the editor. The remaining
implementation has now also been deleted: inventory sidecar and native commands,
AI categorization and mock props, gallery types and APIs, isolated render harness,
virtual component exports, and overlay file/size reporting. Shared AI backend
types now live in `types.ts` for chat and mock-session generation.

Removed duplicate clusters, inline Drift detection, visual similarity scoring,
merge proposals and codemods, merge gates, the merge deletion tray, associated
commands, sidecars, and tests. Save history and scoped undo now live
in `history.rs`.

The phase entries below record earlier implementations and decisions; references
to the removed features describe historical behavior.

**Earlier milestone: Phases 0–5 complete.**
(Plus a 2026-08-22 inspector/chrome UI pass, a 2026-08-23 structural-editing
+ element-identity rework, a 2026-08-28 floating-canvas redesign, a
2026-08-29 pass widening what dedup can open — static HTML sites, and empty
folders that become a project — and a 2026-09-02 canvas-markup tool; see the
interludes below.)

---

## Phase 0 — Spike ✅ (2026-07-03)

Tauri 2 shell + project open + dev-server child process + webview canvas.

| FR | Status | Notes |
|---|---|---|
| FR-1.1 open/drag/recents | ✅ | Native picker, drag-onto-window, persisted recents |
| FR-1.2 detection | ✅ | pm / framework / Tailwind / TS / git. The full/partial/unsupported verdict and its card were removed 2026-11-10 — see "Every project opens" |
| FR-1.3 managed dev server | ✅ | Own process group (killpg teardown), log streaming, ready-URL parse, custom command escape hatch |
| FR-1.4 canvas + viewports | ✅ | iframe; mobile/tablet/desktop widths, ⌘-scroll zoom |
| FR-1.5 git state check | ✅ | Dirty-tree acknowledgement, asked once per project (project details panel) |
| FR-1.6 failure states | ✅ | Crash panel + restart, slow-start hint, console drawer; port conflicts delegated to Vite's auto-increment |

**Decisions / deviations**
- Canvas is an **iframe**, not a native child webview — the postMessage bridge
  works cross-origin and is massively simpler. Holds unless a target app sends
  frame-blocking headers (Vite/Next don't by default).
- **HTTPS auto-tunnel:** WKWebView can't trust self-signed certs
  (@vitejs/plugin-basic-ssl projects rendered blank), so the Rust core fronts
  https dev servers with a local plain-HTTP TCP↔TLS splice tunnel. Dials IPv6
  loopback first (Vite on macOS binds `[::1]` only), IPv4 fallback.
- Dev server exits are killed by process group on stop, window close, *and*
  app exit (⌘Q leaked children before).

**Known limitations**
- `tauri dev` hot-restarts kill the app hard → a running project dev server
  can be orphaned during *dedup development only* (`lsof -ti:5173 | xargs kill`).
- Dev scripts that prompt interactively will hang (stdin is null); the PTY
  escape hatch is noted for Phase 5.

## Phase 1 — Mapping ✅ (2026-07-03)

Element↔source tagging + hover/select overlay + selection UI.

| FR | Status | Notes |
|---|---|---|
| FR-2.1 build-time tagging | ✅ | Vite plugin (bundled @babel/parser + magic-string) stamps `data-dedup-id="file:line:col"` + enclosing component name. Served-JS only — **user source and config never touched** (explicit anti-Onlook decision) |
| FR-2.2 hover/select overlay | ✅ | Injected script: hover highlight + badge, click-to-select (inspect-don't-activate), postMessage bridge both directions |
| FR-2.3 AST node resolution | ✅* | Resolution happens in the write-back sidecar at inspect/save time (Phase 2), keyed by the stamped file:line:col |
| FR-2.4 ancestry breadcrumb | ✅ | DOM-derived component chain, clickable re-selection |
| `.map()` limitation | ✅ | ×N instances badge from live DOM count |

**Mechanism:** assets are written to `node_modules/.dedup/` (git-invisible);
dev launch is rewritten to `node_modules/.bin/vite --config <wrapper>` where
the wrapper imports the user's real config and prepends the tagger. Anything
not confidently rewritable (non-`vite` scripts, pinned `--config`, custom
command) runs uninstrumented with a console note.

**Known limitations**
- Only project source is tagged — third-party components don't highlight.
- ~~Clicks are always swallowed in the canvas (no interact-mode toggle yet).~~
  Resolved: the Browse tool (floating toolbar, Phase 3 addendum) passes
  clicks through to the app.
- Fragments can't carry tags (React limitation) — children are tagged instead.

## Phase 2 — Inspector ✅ (2026-07-03)

Figma-style panel + live editing + AST write-back + git safety model.

| FR | Status | Notes |
|---|---|---|
| FR-3.1 selection header | ✅ | Component, tag, file:line:col, ×N badge (reveal-in-editor pending) |
| FR-3.2 layout section | ✅ | Display, flex direction/justify/align, gap, 4-way padding + margin (minimal-form regeneration: `p-6` / `py-1 px-2` / per-side / negatives) |
| FR-3.3 size section | ✅ | w/h/min/max, scale steppers on gap, arbitrary values |
| FR-3.4 typography | ✅ | Size, weight, align, color |
| FR-3.5 fill & border | ◐ | bg / border width+color / radius / shadow. **Deferred:** theme-token color picker (colors typed as Tailwind names for now) |
| FR-3.6 raw classes field | ✅ | Textarea escape hatch |
| FR-3.7 live + staged | ✅ | Instant DOM patch to all instances, survives HMR; nothing on disk until ⌘S |
| FR-4.1 AST write-back | ✅ | Surgical magic-string range replacement — formatting untouched by construction; output re-parsed before write (never corrupt). **Deviation:** Prettier not run — unnecessary when only the class string range changes |
| FR-4.2 honesty rule | ✅ | `cn(...)`/vars/conditionals → read-only with human reason. **Deferred:** static-base template editing (fully static templates work) |
| FR-4.3 HMR verify | ◐ | Selection re-syncs from source ~1s post-save; no formal re-read assertion yet |
| FR-4.4 undo/redo | ✅ | Snapshot-based staged-edit stack (pre-save); post-save revert = session history panel, pending (flow C) |
| FR-4.5 commit per save | ✅ | `dedup: adjust classes on <Components>`; commits **only dedup's files** — user's own staged index preserved (tested) |
| FR-4.6 session branch | ✅ | `dedup/session-<stamp>` created on first write; never writes to the user's branch; git required to save |

**Beyond the PRD (earned by dogfooding)**
- **Staged-diff review panel** — TopBar "N edits" popover: token-level class
  diffs (red removed / green added), click-to-select, per-edit undoable revert.
- **Live preview interpreter** — Tailwind JIT has no CSS for classes not yet
  in source, so staged classes are mirrored as inline styles resolving through
  the project's own Tailwind v4 theme variables (`--spacing`, `--color-*`);
  cleaned up on revert/save.
- **Full-page canvas frames** — overlay reports natural page height
  (mutation-driven, feedback-loop-safe, 12000px cap); frame grows to fit,
  canvas pans. Two runtime-only assists make this hold for app-shell pages
  (mintWash-verified): a **vh-freeze** stylesheet pins Tailwind's
  `h-screen`/`*-dvh|svh|lvh` classes to the device viewport height (sent by
  the editor via `set-viewport`, incl. after HMR overlay reloads) so
  `min-h-screen` sections keep their designed proportions as the frame grows;
  and **page-scroller unpinning** sets `height:auto` on viewport-pinned
  full-width scrollers (`100dvh` + `overflow-y-auto` shells, e.g. Lenis
  wrappers) so the document, not an inner scrollbar, carries the true height.
  Width filter (≥60%) leaves sidebars/chat panels scrolling on their own.
  **Fixed (was: non-class vh usages still shift):** a raw-CSS/Bootstrap/
  CSS-in-JS `vh`/`dvh`/`svh`/`lvh` height, uncaught by the classname freeze,
  wasn't just a proportion mismatch — since height reporting is mutation-
  driven, its already-grown size got measured again on the next unrelated
  mutation and grew the frame further, ratcheting a plain full-height header
  toward the 12000px cap on nothing but ordinary re-renders. `findViewportRules`
  (same-origin stylesheets, incl. `@media`/`@supports`/`@layer`) and
  `pinInlineVh` (inline styles, reasserted every measurement pass — a
  re-render replaces the whole `style` attribute and would otherwise put the
  raw vh value straight back) generalize the pin beyond Tailwind's own
  classnames. `calc()`/`clamp()` vh expressions are left alone rather than
  pinned wrong — still shift, and still the case for the "device viewport"
  toggle if that turns out to matter in practice.
  Caveat: `fixed`/`sticky` positioning still shifts (Figma-model tradeoff).
- **Pages as artboards, spawned by navigation** — the canvas starts with just
  the root frame; navigating (browse mode) pins the destination as a new
  full-height page artboard at the end of the row and snaps the originating
  frame back to its route (soft popstate replay, hard `location.replace`
  fallback), auto-panning to the new artboard. The overlay flags navigations
  within 1.5s of a pointer/key gesture; app-initiated redirects (auth guards)
  don't spawn — the frame stays put and its label shows the drift
  (`/orders → /welcome`, warn tint). Since all frames share one origin,
  logging in once in any frame makes gated artboards render for real. The
  bridge is multi-frame: frames register per route, commands broadcast
  (staged classes, tool mode, vh-freeze stay consistent), incoming
  page-size/wheel messages key by source window, `requestCanvasFiles` unions
  all frames, selection syncs via `select-id` broadcast (non-holders clear).
  Root frame always stays mounted; off-screen route frames unmount via the
  same culling math as component artboards.
  **Guest-origin frames:** signing in flips apps with reverse auth guards
  (`state.user ? <Navigate away>`) on every public-page artboard — all frames
  share the origin's localStorage. Fix: the editor probes for the same dev
  server under an alternate loopback spelling (`[::1]` vs `localhost` vs
  `127.0.0.1`, via the CORS-open `/__dedup/routes` endpoint; works through
  the https tunnel too, which binds 127.0.0.1). A different host string is a
  different origin — separate storage, logged out. When a pinned frame
  drift-redirects without a user gesture, it retries once on the guest origin
  (labeled "guest"); if that also redirects (page truly needs auth), it stays
  on the shared origin with the drift label and stops flipping. Net effect:
  public pages survive login, gated pages keep the session. Route discovery
  (`/__dedup/routes`: conservative regex scan, static react-router paths
  only, capped 40, CORS-open) is built and tested but currently unconsumed —
  reserved for a future "add page" picker.

**Known limitations**
- Elements *after* an edited element on the same source line keep stale ids
  until re-selected (class-length changes shift columns).
- Preview interpreter covers the panel's knob set; uncovered classes apply
  correctly on save but don't preview if unused in the project.
- Tailwind v3 projects: color preview needs `--color-*` vars (v4) — falls back
  to no preview.

## Phase 3 — Scan ✅ (2026-07-03 → 07-04)

Component inventory + structural similarity + cluster review UI, plus a large
run of addenda: rendered component artboards, Figma-style canvas navigation,
AI categorization/mock-props with a Claude Code **or** API backend, and
several FR-1.6 robustness fixes. Semantic signal stays opt-in; the visual
similarity *pass* (perceptual-hash scoring) remains Phase 5, though isolated
component rendering — its prerequisite — now exists.

| FR | Status | Notes |
|---|---|---|
| FR-5.1 component inventory | ✅ | Scan sidecar walks the project, extracts function components (incl. `memo`/`forwardRef` wrappers): name, file:line, props, export kind, simplified JSX tree. Skips node_modules/dist/hidden dirs, >512 KB and unparseable files |
| FR-5.2 similarity scoring | ◐ | **Structural signal only** (per milestone cut): Zhang–Shasha tree edit distance on simplified JSX trees (pre-order sequence fallback above 10k node-product) + class comparison where `p-4` vs `p-6` and `bg-red-500` vs `bg-blue-600` count as "same knob, different value" + prop-name overlap. Weights 0.6/0.3/0.1, cluster threshold 0.8, union-find. Visual → Phase 5, semantic → opt-in pending embeddings decision |
| FR-5.3 cluster review UI | ◐ | Duplicates tab: ranked cluster list (confidence × call sites), badge count. Review modal: side-by-side JSX skeletons with per-line agreement highlighting + class-token diff chips, remove-member, "Not duplicates" persisted per project (localStorage, keyed by member-set hash). Rendered previews shipped as canvas artboards (see addendum below); the modal keeps skeleton diffs |
| Scan button + progress | ✅ | TopBar Scan streams sidecar progress lines as `scan://progress` events (inventory / similarity stages) |

**Decisions / deviations**
- **Canvas-scoped scan:** the scan clusters only components on the current
  canvas page (the overlay reports the source files behind the rendered DOM;
  the sidecar filters clustering to them). The whole project is still parsed
  so call-site counts stay project-wide truth. No running canvas / untagged
  project → falls back to a whole-project scan; the Duplicates header always
  labels which scope ran ("Current page · N files" / "Whole project").
  Deviation from the PRD's codebase-wide scan — product call (2026-07-03).
- **@babel/parser, not SWC:** the PRD said SWC-based, but the tagger and
  write-back sidecars already ship a bundled @babel/parser — one parser, one
  sidecar pattern (JSON in / JSON lines out, bundle in `node_modules/.dedup/`).
  Perf is a non-issue at MVP scale: 40 components scan in ~130 ms; the 300-
  component / ≤90 s NFR has orders of magnitude of headroom.
- Detection is fully deterministic (no LLM anywhere in the scan path) — scores
  are reproducible and explainable by construction.
- Components with a single JSX element are excluded from clustering (they'd
  cluster the world); two-element components stay in — real duplicates are
  often that small.
- Cluster confidence = mean pairwise similarity across members.

**Also shipped (FR-5.2/5.3 pulled forward): rendered component artboards**
- Scan now renders every *qualifying* component (structural composites and
  interactive controls — pure text wrappers and svg-only icons filtered out)
  as Figma-style artboards beside the app frame. Cluster members sit together
  inside an accent group frame labeled with confidence + call sites; clicking
  a member opens the cluster review. Canvas auto-pans to the artboard field
  when a scan lands.
- Mechanism: the tagger plugin serves `/__dedup/harness?file=&name=` — an
  HTML shell + Vite virtual module that dynamically imports the component,
  renders it with neutral props inside an error boundary (project global CSS
  auto-imported for Tailwind theme), and reports natural size or failure via
  postMessage. Components that can't render in isolation show "Can't render
  in isolation" + reason instead of a preview (PRD graceful-degradation rule).
- Off-screen artboards aren't mounted (position-math culling) so large
  galleries don't spawn dozens of live iframes at once.
- Harness renders bare first, then climbs a retry ladder one failure at a
  time: a `MemoryRouter` when the failure is router-shaped (covers
  `useNavigate` et al without double-wrapping components that own a Router;
  router package availability is decided server-side at module generation),
  then app context providers discovered from the error itself — the module a
  context hook throws from (`useTheme` → `theme-provider.tsx`) usually also
  exports the `*Provider` that fixes it, so the harness imports it and wraps.
  Wrappers accumulate, so a page needing router + theme gets both. App shells (`App`, `*Routes`, `*Router`,
  `*Provider`, `*Layout`) are excluded from the gallery; file-local
  (unexported) components show a "Not exported" placeholder instead of a
  doomed import. Served through `transformIndexHtml` so plugin-react's
  refresh preamble applies (raw middleware HTML broke every module load).
- Vite-only, like all instrumentation (Next.js in Phase 5). Browser-level
  render verified down to the served, transformed harness module; in-app
  visual confirmation pending next dogfood session.
- **Scan results persist per project** (`node_modules/.dedup/scan-result.json`,
  written on every successful scan): reopening the project restores the last
  gallery/clusters/artboards immediately — no rescan ritual. The Duplicates
  header shows the scan's age; only a *fresh* scan auto-pans the canvas to
  the artboard field. Wiped by a node_modules reinstall (then just rescan).

**Also shipped: AI component categorization (organization, not detection)**
- **One-button flow:** Scan runs the whole pipeline — deterministic
  inventory/clustering, then (when an AI backend is connected) AI
  categorization automatically: cached assignments apply first, only
  new/changed components hit the model. TopBar shows Scanning… →
  Organizing…; the Duplicates tab shows a status strip, never extra buttons.
- Auto-organize categorizes scanned components with
  Claude (`claude-opus-4-8`, structured outputs) into a fixed vocabulary —
  Buttons / Cards / Forms & Inputs / Navigation / … — and the artboard field
  reflows into Framer-style labeled category sections; cluster groups stay
  intact inside their anchor member's section. **The trust boundary holds:**
  the LLM only names what components are; duplicate detection remains fully
  deterministic.
- **TopBar AI switch:** backend choice is explicit — an `AI: Claude Code /
  API / off` chip opens a popover: Claude Code connects via a consent step
  (one live test prompt verifies the CLI login before dedup ever uses the
  subscription; disconnectable), the API side holds the key entry (moved out
  of the Duplicates tab, masked, removable). No silent backend use; choice
  and consent persist in localStorage. Duplicates strip is status-only.
- **Claude Code as an AI backend:** when the `claude` CLI is
  installed and the user connects it (TopBar switch → Connect), AI calls run
  headlessly through it (`claude -p --output-format json`, prompt on stdin —
  the same one-shot sidecar pattern as the tagger/scan bundles) on the user's
  existing subscription, no API key. The API key (also in the TopBar switch,
  stored locally) is the alternative backend; the API path keeps
  schema-enforced structured outputs, the CLI path uses prompt-requested JSON
  with lenient extraction. Live-verified against the real CLI envelope.
- Privacy either way: prompts carry only component names, file paths, prop
  names, and capped tag/class skeletons — never source.
- **AI mock props:** the same Scan-time call also invents realistic demo
  props per component (from prop names + skeleton; JSON-string field since
  structured-output objects must be closed schemas; validated client-side).
  The harness renders with them — prop-dependent components (ReceiptCard's
  `order.orderNumber`) preview with plausible data instead of erroring; bad
  guesses degrade to the neutral-props behavior. Cached alongside categories.
- **File-local components render now:** the tagger appends a virtual
  `export { Name }` when the harness imports with `?dedup-export=Name` — the
  query makes it a separate module, so the app's own imports are untouched.
  Replaces the "Not exported" placeholder with a real preview.
- Assignments cached in `node_modules/.dedup/categories.json` keyed by
  skeleton hash — unchanged components are never re-sent; re-categorize only
  processes new/changed ones. Cached categories apply instantly on scan
  restore with zero API calls.

**Also shipped (honesty rule, FR-1.6)**
- **Explicit "inspection off" state:** uninstrumented sessions (Next.js,
  custom dev command, non-`vite` script, tagging failure) now emit a
  `devserver://instrumentation` event; the Inspector explains *why* clicking
  won't select instead of showing the generic hint, and the compat card
  marks Next.js as partial with the Phase 5 note. Previously dedup degraded
  silently and inspection just "didn't work".

**Also shipped (FR-1.6 failure recovery)**
- **Stale dev-server auto-cleanup:** when Next refuses to start because an
  orphaned sibling still holds the project ("Another next dev server is
  already running"), dedup parses the PID/Dir from the refusal, verifies the
  PID is a live `next` process for the *same* project, kills it (TERM→KILL),
  and retries once — instead of showing a crash and telling the user to run
  `kill` by hand. The stale server's own `- Local:` line is also excluded
  from ready-URL detection (previously the canvas could silently attach to
  the dying orphan). Fixed alongside: a StrictMode listener leak that
  rendered every console line twice.

**Also shipped (FR-6.1 canvas UX)**
- **Frame label** (Figma artboard name): the page's own `document.title` +
  route (reported by the overlay) with the viewport preset, floating above
  the frame — pans with it, never scales. Falls back to the project name on
  uninstrumented sessions.
- **Floating canvas toolbar** (Figma-style, bottom-center): Select (V),
  Hand (H — Space still works as momentary), and **Browse (B)** — clicks pass
  through to the user's app so it can be navigated in place, resolving the
  Phase 1 "clicks are always swallowed" limitation. Overlay re-asserts the
  active tool after full-reload HMR. Zoom controls moved here from the TopBar.
- **Figma-style canvas navigation**, replacing the scroll-box: trackpad
  scroll pans freely, pinch / ⌘+scroll zooms toward the cursor, Space+drag is
  a hand tool, middle-drag pans, the dot grid moves and scales with the
  canvas, and TopBar ± zooms about the viewport center. The overlay forwards
  wheel events from inside the iframe (which otherwise swallows them) unless
  an inner scrollable panel can consume the scroll — nested app panels keep
  scrolling natively. Frame re-centers on viewport switch.

**Known limitations**
- Call-site counts are name-based (`<Name` occurrences project-wide), not
  import-resolved — same-named components in different files pool their counts.
- Similarity uses each component's **largest** JSX root; alternate conditional
  returns aren't compared.
- Structurally identical wrapper sets (e.g. an icon library: all `svg > path`)
  cluster legitimately and read as noise — dismissible, and the dismissal
  sticks per project.
- Dismissal keys on the member set — if a cluster gains/loses a member on a
  later scan it resurfaces (arguably correct: new evidence).

**Addendum (2026-07-07): Inspector chat tab + Claude Code model picker**
- The AI switch's Claude Code card gained a model picker (CLI default / Haiku /
  Sonnet / Opus) — persisted, passed as `--model` on every headless invocation
  including the connect test.
- New Inspector **Chat** tab: select an element, type an instruction, the AI
  edits the code. The model gets the whole source file with the selection
  marked (line + tag/component + ×N instance note) and replies with
  SEARCH/REPLACE edit blocks (full-file fence accepted as fallback; prose =
  answer, no write). Blocks are applied locally with exact-unique matching —
  a misquoted or ambiguous SEARCH aborts with a reason, nothing half-applies.
  Works with both backends (Claude Code CLI honoring the model pick, or API
  key). First cut asked for the complete updated file back — Opus streaming a
  whole file took minutes and read as a hang; block edits land in ~8 s.
- Headless CLI hardening (the "stuck in Working…" fixes): the one-shot
  `claude -p` now runs stripped (`--tools "" --strict-mcp-config
  --setting-sources "" --no-session-persistence --disable-slash-commands`,
  neutral cwd) — a bare invocation loads the user's whole Claude Code
  environment and MCP servers, which stalled for minutes before any API call.
  Hard 300 s timeout kills the child (the UI can never spin forever), and
  stdin/stdout/stderr are pumped on separate threads (a >64 KB prompt could
  deadlock both processes on full pipes).
- Safety model unchanged and load-bearing: the reply is written via a new
  sidecar `writeFile` command that **strict-parses (no error recovery) before
  writing** — unparseable model output is refused with the file untouched;
  `resolve_in_root` gates the path; each applied edit is its own commit on the
  `dedup/session-*` branch (`dedup: <model summary>`). Chat edits are blocked
  for a file with unsaved staged class edits (a rewrite would strand their
  line/col positions) — save or discard first.
- This is the one AI feature that sends **source code** to the backend (scan
  categorization still sends outlines only); the composer states it inline.
- Chats are sessions, persisted per project (localStorage, most recent 20,
  same pattern as dismissed clusters) and restored on reopen. The panel has a
  session switcher + new/delete; a new chat materializes on its first message.
  Each turn carries conversation memory: the last 12 message texts go back to
  the model (real message turns on the API backend, inline transcript for the
  headless CLI) — never past file snapshots; the current file is always sent
  fresh.
- Stale selections are guarded, not guessed: commits shift line numbers, and
  a stale line made the model edit the *wrong* button in dogfooding. Before
  prompting, the selected line in the just-read source must still contain the
  selected tag (else: "re-select and try again"); the prompt also quotes the
  line's text so the model targets by content, not position. After an applied
  edit the canvas is told to `location.reload()` (new overlay `reload`
  command) — never trust HMR sockets to be alive — and the selection is
  cleared because every position in the file may have shifted.

### Addendum — launch screen as a project grid (2026-08-22)

The recents list became a Figma-dashboard-style grid: 16:10 cards with a real
preview image, name, framework + "3d ago" line, hover remove, and a dashed
"Open project" tile in the first cell. The old dropzone survives as the
empty state (no recents = nothing to show a grid of).

**Mechanism.** Thumbnails are WKWebView *self*-snapshots
(`takeSnapshotWithConfiguration:`, `src-tauri/src/thumbs.rs`): the webview
rasterises its own layer tree, so it captures the cross-origin canvas iframe
that a DOM rasteriser can't read, and — unlike `screencapture`/CGWindowList —
it needs no Screen Recording permission (verified: that permission is not
granted here and CGWindowList capture fails). `snapshotWidth` does the
downscaling, so no image resampling on our side; PNGs live in the app config
dir beside `recents.json`, keyed by FNV-1a of the project root, and are
deleted with their recents entry. The frontend reads them back as data URLs.
Capture points: closing a project (back button, before the dev server stops)
and ~1.2 s after a successful save — ⌘Q never reaches the back button, so
saves are the second chance at a fresh card.

**Deviations / limitations**
- macOS only by construction (`snapshot_png` errors elsewhere); the grid
  degrades to generated cards — a per-path hue gradient with the project's
  initials — which is also what a never-opened project shows.
- Recents entries gained `framework` + `lastOpened`; pre-existing entries have
  neither (serde defaults), so their cards show the parent folder instead of
  inventing a framework or a date.
- Quitting with ⌘Q without ever saving leaves the previous card (or the
  placeholder) in place; there is no capture-on-quit hook.

### Addendum — artboard-scoped scan + Components tab (2026-08-23)

Three connected UX changes to the scan flow:

- **Scan targets a selected artboard.** Page artboards are now selectable
  (click the frame's name label; accent ring + label tint show the selection,
  click again to deselect). On a live, tagged canvas, Scan requires a
  selection and scopes clustering to that one frame's source files (new
  `requestFrameFiles(route)` in the bridge — the old union-across-all-frames
  `requestCanvasFiles` is gone). The TopBar Scan button disables with a hint
  until an artboard is picked; untagged/offline sessions keep the honest
  whole-project fallback with no selection demanded.
- **Components moved to their own top-level tab.** The TopBar gained a
  centered Canvas / Components switch (gallery count as a badge). The
  rendered gallery no longer lives on the canvas beside the page frames —
  `Artboards.tsx` is deleted, replaced by `ComponentsView.tsx`, a scrollable
  view with the same category sections, cluster groups, and click-to-review.
  A fresh scan lands on the Components tab; restores stay put (replaces the
  old `scanSeq` auto-pan, now removed). Canvas and ComponentsView both stay
  mounted and hide via CSS — unmounting would reload the app frames and drop
  live state + staged class previews. Off-screen harness iframes unmount via
  IntersectionObserver (rootMargin 600px) instead of pan-math culling.
- **Cards take each component's on-site size.** Scan asks the selected
  artboard's overlay for every component's rendered DOM rect (new `list-sizes`
  command: first non-nested instance per `file#name`, measured via
  `getBoundingClientRect`), and cards take exactly those dimensions — the
  preview matches how the component actually renders on the page. The harness
  gets the width as `?w=` and locks `#root` to it (padding dropped) so text
  wraps and flex flows like the site; oversized components (full-width heroes)
  render at true size and scale down to fit an 800px card, Figma-style, with
  the real `w×h` shown in the card label. Live sizes persist per project in
  localStorage so restored scans keep them. Fallback when the page can't
  answer (component not on the scanned page, older overlay bundle, dev server
  down): the harness's own intrinsic measurement at a fixed 800px probe width.
  This one required a plugin rebuild — overlay `list-sizes` + harness `?w=`.

Then Phase 4 (guarded merge), Phase 5 (harden + Next.js).

---

## Interlude — Figma-grade inspector chrome (2026-08-22)

Not a PRD phase: a UI pass over the right rail and the app chrome, prompted by
the inspector still reading as "labelled text inputs" rather than a design tool.

**What shipped**
- `@radix-ui/react-icons` replaces the hand-rolled `src/components/icons.tsx`
  (now deleted). Radix's set is the only common one carrying the
  alignment/spacing/typography vocabulary this panel needs
  (`AlignCenterHorizontally`, `SpaceBetweenVertically`, `Padding`, `Corners`,
  `BorderWidth`, …). It is in maintenance mode, which is fine — we need a fixed
  vocabulary, not a growing one.
- New `src/components/ui.tsx`: 24px rows, icon-prefixed fields, segmented icon
  groups, colour swatches — the primitives the style sections are built from.
- `StylePanel` rewritten on those primitives: direction/justify/align/text-align
  became icon toggle groups; padding and margin became Figma's axis-pair control
  with a split-to-four-sides toggle; size fields carry `Width`/`Height` prefixes
  with min/max behind a disclosure; fill/border/text colour gained live swatches.
- Alignment icons flip between the horizontal and vertical sets with
  `flex-direction`, so `justify-start` reads as "top" on a column.
- Drag-to-scrub on a field's prefix icon steps the Tailwind spacing scale,
  replacing the `−`/`+` buttons.
- App chrome followed: sidebar tabs, toolbar, zoom buttons, viewport switcher
  (device glyphs instead of "Mobile/Tablet/Desktop"), console drawer, launch
  screen, duplicates, review panel, inspector tabs and breadcrumb.
- Both side panels resize by dragging their inner edge (`ResizeHandle` in
  `ui.tsx`), double-click resets, widths persist per machine in localStorage.
- Second pass against a screenshot of Figma's UI3 right panel: section titles
  are 13px normal-case ink (not micro-caps) with their actions hung on the
  right; grey captions sit *above* their controls instead of in a left label
  column; fields and toggle groups grew to 28px with 12px values. Fill, Stroke
  and Appearance became their own sections, matching how Figma splits them.

**Decisions**
- *Icons must not hide the vocabulary.* Every toggle, select and field carries
  the literal class it writes in its `title` (`justify-between`, `pt-*`,
  `rounded-*`), and the raw Classes textarea stays. Honesty over magic (PRD §6)
  applies to affordances, not just to write safety.
- *The mapping layer was not touched.* This is a view-layer change end to end;
  `pnpm test:tw` passing unchanged is the evidence.
- *Swatches resolve real colours.* Palette tokens paint via
  `var(--color-<token>)`, which forced `@import "tailwindcss" theme(static)` in
  `styles.css` — Tailwind v4 tree-shakes theme variables, and the swatch needs
  the whole palette present (CSS 7.4 → 11.2 kB gzipped). `cssColor` lives in
  `lib/tailwind.ts` and returns null for anything it can't resolve, so an
  unresolvable token renders as a checkerboard rather than a guess.
- *A scrub is one undo step.* `applyClassEdit` gained an optional `group` (a
  drag id); consecutive edits sharing it collapse into a single `EditOp` instead
  of pushing one entry per 5px of pointer travel.
- *Panel widths clamp on read, not just on write.* `PANEL_BOUNDS` caps both
  panels; a width restored from a wider window (or a corrupt entry) is clamped
  as it loads, so a stored value can never leave the canvas unusable.
- *Resizing needs pointer capture.* The canvas iframe swallows pointer events
  the moment the cursor crosses it, so the drag strip captures the pointer for
  the whole gesture and releases on both pointerup and pointercancel — a
  cancelled drag must not strand a `col-resize` cursor over the app.

**Deviations / limitations**
- `justify-around` has no dedicated Radix glyph; it borrows
  `ColumnSpacing`/`RowSpacing`. Distinguishable from `evenly`, but the tooltip
  is what disambiguates.
- `flex-row-reverse` / `flex-col-reverse` show the base axis's alignment icons —
  the glyphs don't mirror to match the reversed main axis.
- Swatches resolve Tailwind's *default* palette. A project's own theme colours
  (`bg-brand`) aren't in dedup's CSS, so they render as "unresolved" honestly
  rather than wrong.
- Rendered-UI verification is still manual; there are no component snapshot
  tests, so this pass is covered only by typecheck plus the mapping suite.

---

## Fix — PATH for GUI-launched bundles (2026-08-22)

The packaged `.app` crashed every project open with `env: node: No such file
or directory` / exit 127, while `pnpm tauri dev` worked. A bundle started from
Finder inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so
the `#!/usr/bin/env node` shebang in `node_modules/.bin/vite` — and `pnpm`,
and the sidecars — had no node to find.

`toolpath.rs` now builds the PATH the user's own terminal has: their login
shell is asked for it (`$SHELL -ilc`, 5s bounded so a slow rc can't stall the
first open, since nvm/fnm live in `.zshrc`, which non-interactive shells never
read), unioned with the inherited PATH and the usual install dirs (homebrew,
volta, bun, pnpm, asdf, every `~/.nvm/versions/node/*/bin` newest-first), with
dead entries dropped. Every child gets it: dev server, write-back sidecar,
scan sidecar, Claude Code CLI.

Binaries are resolved to absolute paths through `toolpath::which` rather than
named bare — on Unix `Command`'s own program lookup uses the *parent's* PATH,
so setting `PATH` on the child alone would not have fixed `pnpm`/`node`. An
unrequested exit 127 now also logs what it means instead of a bare code.

---

## Structural editing + identity rework (2026-08-23)

Prompted by a read of Onlook's open-source editor (Apache-2.0). Four of its
design decisions are better than what we had; they are reimplemented here, not
copied. The dedup engine remains ours alone — Onlook has no component
inventory, no similarity clustering, and no guarded merge anywhere in its tree.

**Element identity is now position-free.** `data-dedup-id` was
`file:line:col`, which went stale the moment a save shifted a column — the
"ids of later elements on the same line go stale" gotcha. It is now
`file@ordinal`, the element's index in a *shared* depth-first JSX walk
(`plugin-src/jsxwalk.mjs`) that the tagger and the write-back both import.
Sharing the walk is the point: an ordinal only means something if both sides
count identically, and two copies of "the same" traversal would not stay the
same. Source positions are still needed (open-in-editor, chat prompts) and are
derived on demand by `inspect`, which always reports the live line/col.
Onlook solves this by writing persistent nanoids into the user's source; our
convention forbids touching their files, and a deterministic ordinal buys the
same stability without it.

**Nodes now carry what may be done to them.** The walk classifies each element
as a `.map()` item (`data-dedup-dyn="array"`), a conditional branch
(`"conditional"`), a component root or `<body>` (`data-dedup-core`). The
write-back's `inspect` returns capability flags (`canRemove`, `canMove`,
`canAcceptChildren`, `canEditText`) with the reason when false, and refuses
ops that contradict them. The overlay reads the same attributes, so a drag
never starts on an element the save would reject — the affordance is honest
before the user pulls on it, not after.

**One edit-action model replaces staged class diffs.** `EditAction` (class,
text, remove, insert, move) is the single description of an edit whether it is
being previewed, undone, reviewed, or written. The staged program is one
ordered list; undo pops, redo pushes, review reverts by position. The overlay
receives the whole program as *state* (`stage`), resets what it applied and
replays — so undo, redo, mid-list revert, and recovery after a React re-render
are all the same code path rather than an incremental protocol that can drift.

**Insert / move / re-parent / delete land as source edits.** Dragging an
element on the canvas re-parents it; the toolbar's palette places a frame,
text, button or image; ⌫ deletes. All of it is one `apply` program per file,
resolved from one parse, applied as magic-string ranges, re-parsed before the
write — all ops land or none do. A move is capture → delete → re-insert rather
than a chunk move, so the block is re-indented for its new depth *and* class
or text edits made inside the moved subtree travel with it (drag, then tweak
padding, is one save). Dropping into a self-closing element expands it to a
pair. Cross-file moves are refused with a reason: lifting markup out of one
component into another is a refactor, not a drag.

**Also from the same read**
- Staged classes preview through an injected stylesheet keyed by dedup id
  rather than the inline `style` attribute — the element's own inline styles
  survive, variants become expressible, and undoing a preview is dropping a
  rule instead of remembering which properties we touched.
- `tailwind-merge` (+ a background-group fix: it treats `bg-cover` and
  `bg-red-500` as one group; they are different properties) backs a new
  `mergeClasses`, offered as "Tidy" on the raw Classes field.
- Dev-server output is parsed into structured build errors (`lib/errors`) —
  a fixed pattern list, not "anything on stderr", grouped with their detail
  lines and cleared by the next successful compile. The console shows them
  above the raw stream with "Ask AI" to hand one to the inspector chat.

**Deliberately not taken from Onlook:** their sandbox/CodeSandbox execution
model, hosted backend, deploy and collaboration (all contradict "the codebase
never leaves the machine"), and their fast-apply code-rewriting services
(Morph/Relace) — a third-party service rewriting user source is exactly what
our AST-gated write-back exists to avoid. `penpal` for typed iframe RPC was
considered and skipped: the bridge's message union is now typed on both sides,
which was the actual benefit.

**Deviations / limitations**
- A structural save renumbers every ordinal after the edit in that file, so it
  ends with a canvas reload rather than trusting HMR. Class-only saves are
  unchanged.
- Moves are refused across files, into `.map()` items, conditional branches,
  component roots, `<body>`, and void tags — each with the reason shown.
- Inserted elements are neutral markup to be styled in the inspector, not a
  guess at a design; the image placeholder has an empty `src` the user fills in.
- A staged insert carries a provisional `pending:<uuid>` id so it can be
  selected, styled and typed into before it exists on disk. Class and text
  edits addressed to one are folded into that insert's snippet at save time —
  it is written once in its final form, rather than as an insert followed by
  edits to something that did not exist when the insert ran. A fold that fails
  validation refuses the save rather than dropping the edit.
- A staged insert still can't be *moved*: that would mean rewriting the insert
  action's own target, and the inspector says so instead of offering it.
- Indentation of moved blocks is corrected relative to the drop target, but
  dedup still doesn't run the project's Prettier (FR-4.1's optional half).
- The canvas gestures that need real hit-testing and layout (drag, drop
  indicator, click-to-insert) have no automated coverage — there is no browser
  in the test path. The write-back half of every gesture is covered end-to-end
  through the built bundle, and `test:overlay` covers the overlay's load,
  select and staged-program paths against a stub DOM.
- `test:tw` / `test:chat` used `node --experimental-strip-types` (Node ≥22.6);
  they now bundle through esbuild (`plugin-src/run-ts.mjs`) and run anywhere.

---

## Layers tree (FR-6.2) ✅ (2026-08-23)

The sidebar's Layers tab (an Onlook-style layers panel, placeholder since
Phase 1) now shows the rendered element tree of every page artboard, synced
with canvas selection both directions.

**The DOM is the source of the tree, not the source files.** Each frame's
overlay walks its rendered DOM and reports nested `data-dedup-id` elements
(`layers` message, per route). That choice buys three things for free: staged
inserts/removes appear in the tree live (they exist only in the DOM), a
`.map()`-rendered element shows once per instance exactly as on the page, and
untagged wrappers (portals, third-party markup) are transparent — their tagged
descendants attach to the tagged ancestor above. Reports ride the same
debounced MutationObserver tick as the height report, gated by a JSON
signature so quiet ticks send nothing; the editor can force one with
`list-layers` (the tab does, on mount).

**Selection sync both ways.** A row click goes through the existing
`selectById` → overlay `select-id` → `selected` round-trip, so the inspector,
canvas box, and tree all agree by construction. A canvas click highlights the
row, auto-expands its collapsed ancestors (only those — the user's other
collapse state survives), and scrolls it into view. Hovering a row sends a new
`hover-id` command that draws the same hover box + badge a pointer over the
canvas would.

- Rows are keyed by tree position, not dedup id — one source element rendered
  N times is N rows sharing an id, and all N highlight when it is selected
  (matching what the class-patch preview does on the canvas).
- Component roots (`data-dedup-core="root"`) wear the component's name with
  the tag demoted; leaf rows show a short text snippet ("Sign out" tells three
  `li`s apart). Staged inserts carry an "unsaved" chip.
- `test:overlay` +3: the nested/labeled tree incl. the untagged-wrapper case,
  a staged insert appearing in the tree marked `staged`, and `hover-id`
  drawing/clearing chrome without a pointer.

---

## Pages tab (FR-6.3) ✅ (2026-08-23)

The last sidebar placeholder. The tagger already served statically discovered
routes at `/__dedup/routes` (conservative react-router path-literal scan,
covered in `test:plugin`) — but the editor only ever probed that endpoint for
alt-origin detection and threw the payload away. The Pages tab now consumes it.

- The list is the detected routes merged with the artboards already open:
  browsing spawns artboards at dynamic paths (`/orders/42`) the static scan
  can't know, and they belong in the list too. When the scan finds nothing
  (or tagging is off), the tab says so and why instead of presenting an
  empty pane as if the app had one page.
- Clicking a row opens the route as a page artboard (if it isn't one) and
  pans the canvas to it. That focus behavior was inlined in the canvas's
  navigation handler; it is now one store action (`focusRoute`) shared by
  both paths, and `PAGE_GAP` moved from Canvas into the store with it.
- Rows carry the same honesty markers as the canvas frame labels: a frame
  its app redirected away shows `→ where-it-landed`, and the artboard the
  scan targets is marked.
- Detected routes are fetched once per dev-server session (reset on restart)
  with a manual re-scan button; the endpoint answers fixed `{routes}` JSON
  with CORS open, so the editor webview fetches it cross-origin directly.

---

## Zero-login editing — mock-session seed (2026-08-23)

Protected routes were unreachable on the canvas: the app's client guard sees
no session and redirects the frame to `/login`, so the page the user wanted to
edit never renders. (The existing guest-origin retry only helped the opposite
case — public pages guarded *against* signed-in users.)

**What was rejected, and why.** Scripting a real login means storing the
user's credentials and re-breaking on every auth provider (OAuth popups,
magic links, hosted widgets). Mocking the *render* — AI-generated fake page
state — was rejected outright: it contradicts "honesty over magic" at the
worst possible place, since the user would be editing a page state that does
not exist in their app, and a save could look right on the canvas and wrong in
production.

**What landed instead: a seed, not a lie.** The user installs a small
*session seed* — browser-storage writes that make their app's **own** client
guard consider itself authenticated. The real page then renders and its real
markup is what gets edited. Every guarantee is structural rather than
promised:

- **Storage only.** The seed writes `localStorage`/`sessionStorage`/cookies.
  It never mutates source, never intercepts the network, never mocks a
  component. What renders is the app's genuine authenticated shell.
- **Framed-only.** The tagger wraps the seed in a `window.top === window.self`
  gate before serving, so it runs in dedup's canvas frames and *never* when
  the user opens their own dev server in a browser. The gate is in the
  wrapper, not the seed, so no seed can opt out of it.
- **Crash-proof.** The wrapper try/catches: a bad seed warns to the console
  and the page boots logged-out exactly as before, rather than dying in
  `<head>`.
- **Reviewed, opt-in, and visible.** AI only *drafts* the seed (from the
  project's own auth-related source, scanned by `session.rs` — storage API
  plus an auth-ish word, so a theme toggle doesn't flood the prompt); the user
  reads and edits it before it can be enabled, and while it is on, the canvas
  frame label and the Pages tab both say "mock session".
- **Never committed.** It lives in `node_modules/.dedup/session.json`, the
  same sanctioned injection point as the tagger and overlay assets. The
  user's source and config stay untouched, per the standing convention.

**Reaching a bounced frame.** A frame parked on `/login` can't be fixed by a
plain refresh — that just reloads the login page. `reload` now takes an
optional `path` and does `location.replace(path)` when the frame sits
somewhere else, so enabling a seed brings every frame back to its *pinned*
route in one fresh document load (which is what the seed needs — it runs
before the app boots). Enabling also resets `frameOrigins`: the guest-origin
fallback existed because the page was unreachable, which is the thing the seed
just fixed.

**Discovery.** A frame whose drift lands on an auth-looking path
(`/login`, `/signin`, `/auth/…`) shows a lock in the Pages tab that opens the
setup modal; the tab also carries a permanent "Zero-login editing" row with
its on/off state, since locks only appear after a page has bounced once.

**Correction after first real use (same day): sign-in leads, the seed is the
fallback.** Dogfooding on a Firebase app returned `INSUFFICIENT` — and the
model was right. The seed generator's premise was that *the app* writes its
session storage, which is false for every managed auth SDK: Firebase persists
to IndexedDB from inside the SDK, NextAuth to an httpOnly cookie, Clerk to its
own short-lived tokens. The scanner looks at the user's source, so for those
apps it correctly finds nothing, and no seed could have reached the session
anyway.

The path that *does* work needed no new mechanism: every canvas frame on one
origin shares a single WebKit session, so signing in for real once unlocks
every protected artboard — with real tokens, so data loads too, not just the
shell. Two things were blocking it:

- it was undiscoverable — nothing in the UI said "just sign in";
- the guest-origin fallback actively fought it. That retry exists for pages
  guarded *against* signed-in users; for a page guarded *for* them it is
  precisely backwards, since the guest origin has separate storage and a real
  login there never applies.

So the modal now leads with **Sign in on the canvas** (switches to browse mode
on the frame the guard bounced, so the app's own login form works — any
provider, no credentials stored by dedup) plus **I'm signed in — reload
pages**. Both run `reloadPinnedFrames`, which resets `frameOrigins` to the
shared origin and reloads each frame at its pinned route — the same step a
seed save takes, now shared. The seed collapses behind a "Can't sign in?"
disclosure (an *enabled* seed always stays visible — it is changing what the
user sees).

`session.rs` also detects the auth SDK from `package.json` and says whether a
seed can reach it at all. That answer reaches the user two ways: the modal
shows "Firebase Auth keeps the session in IndexedDB — a seed can't reach that"
and disables **Draft with AI**, and the generation prompt now *names the SDK*,
so an app using a seedable one (Supabase, Amplify — both localStorage) gets a
correct seed instead of the model concluding "no auth here" from an app that
is full of it.

**Second correction: browse mode was still being steered.** A phone-OTP login
reset to step one before the code could be entered. Both reactions to
`page-meta` were firing during browse mode, and either one is fatal to a
multi-step flow:

- the overlay marks a navigation as a user gesture only within **1.5s of a
  click** — far shorter than an SMS round-trip — so the step change read as an
  app-initiated redirect and flipped the frame to the guest origin. That
  swaps the iframe's `src`, i.e. a full reload, and Firebase's
  `ConfirmationResult` lives in memory, so the flow restarted;
- had it landed inside the window instead, the snap-back would have yanked
  the frame to its pinned route with the same result.

Browse mode now returns from that handler after recording the path: it exists
to hand the page to the user, so dedup stops steering. Labels stay honest
(the path is tracked either way); pinning is the Pages tab's job.
`startCanvasSignIn` also resets any guest-origin frames first — signing in on
`[::1]`/`127.0.0.1` writes a different storage bucket than the other frames
read, and providers that check authorized domains (Firebase's reCAPTCHA) only
whitelist `localhost`.

**Page console forwarding.** The above was undiagnosable from the editor: the
console drawer shows the dev server, while an auth SDK's complaint happens
inside the iframe. The overlay now wraps `console.error`/`.warn` and listens
for `error`/`unhandledrejection`, forwarding to the drawer as
`[page /route] …`. It observes rather than replaces (the page's own console
still fires), serializes defensively (Errors keep stacks, cyclic objects don't
throw), and is budgeted at 200 lines with slow refill so a render loop can't
flood. These lines bypass the build-error parser deliberately — a runtime
`TypeError` is not a broken build, and lighting that indicator would be a lie
no recompile could clear.

**Third correction: the session becomes a property of the artboard.** With a
real login in place the *opposite* guard bites — a welcome/marketing page
protected *against* signed-in users redirects to the dashboard, and the
artboard the user wanted to edit won't hold still. The guest-origin fallback
was built for exactly this but couldn't fire: it sits after the browse-mode
early return (so never during sign-in), it excluded `route !== "/"` (the
common case for a landing page), and it only reacts to a *changed* page
report, so it never re-evaluates once a redirect has settled.

Rather than keep patching the inference, the choice is now explicit and
per-artboard: **auto / signed in / signed out**, on each Pages-tab row. The
user is designing a logged-out welcome page and a logged-in dashboard at the
same time, so which session a frame renders under is a property of the
artboard, not something to be guessed from one redirect. An explicit choice
always beats the fallback. "Signed out" is the same mechanism as before — a
second loopback spelling of the same dev server, hence a separate storage
bucket, hence genuinely no session — so nothing is mocked; it is a browser
that never logged in. Canvas frame labels say which session a frame is on
whenever it isn't the live one, so two frames of the same app can never
silently disagree.

`resolveOrigin` (new `lib/origins.ts`) is the one place the explicit choice
and the fallback are reconciled — pure, so React calls it with subscribed
values while the store calls it with `get()`, with no second implementation
to drift. `pnpm test:origins` pins the precedence, including the degrade path
when no alternate origin exists (the control disables and says why rather
than silently doing nothing).

"I'm signed in — reload pages" now also returns to Select, since browse mode
deliberately suppresses the redirect fallback that a fresh login makes
relevant.

**Hold: freezing a transient screen.** Splash screens, interstitials and
"redirecting…" states are gone before anyone can look at them, so they could
never be inspected or edited at all. **Hold** (per artboard, in the Pages tab)
freezes a frame on its first screen.

It works by queueing the mechanism those screens advance on: timers of
**≥400ms** are held rather than scheduled, and `history.pushState`/
`replaceState` are frozen so timer-driven navigation is covered twice over.
Short timers deliberately still run — React's scheduler falls back to
`setTimeout`, and stalling that hangs the page instead of pausing it. 400ms
separates the two cleanly: no framework schedules rendering that far out, and
no splash is that brief. **Release** restores every patched function and
flushes what was queued, so the transition finally plays and the app carries
on rather than having lost the work; a timer the app itself cleared while held
stays cleared.

Holding has to be armed *before* the app boots, so it rides in on the frame's
URL (`?__dedup_hold=1`) and is read by the same head-injected boot script that
carries the mock-session seed — which is why toggling it reloads the frame.
That flag is written by the editor and read by the separately bundled tagger,
so `test:origins` asserts the two constants agree; if they drifted, holding
would silently stop working with nothing to see. Held artboards are badged
"held" on the canvas, since a held frame is deliberately not showing what the
app would do on its own.

**Deviations / limitations**
- Hold catches screens that advance on a timer or a client-side navigation,
  which is the common case. A screen waiting on a network response is not
  held — dedup does not intercept the app's requests, and a faked response is
  exactly the kind of invented state the seed design already rejected.
- Browsing no longer auto-pins visited routes as artboards; add them from the
  Pages tab. Losing a login halfway is a worse failure than an extra click.
- A "signed out" artboard needs a second reachable loopback origin. Vite on
  macOS usually binds both, but where only one is available the control is
  disabled with the reason shown.
- Seeds only make sense for apps that keep their session in JS-reachable
  storage. For an SDK-managed session (Firebase, Clerk, NextAuth, Auth0's
  default) signing in is the only path, and the UI says so up front rather
  than spending an AI call to find out.
- The seed satisfies *client-side* guards. Data fetched from a real server
  can still return 401, so a protected page may render its authenticated
  shell with empty or error content. That is the honest result and still the
  editable thing — the layout is what dedup edits — but it is not a login.
- Server-rendered guards (a Next middleware redirect) are unaffected; this is
  a client-storage seed by design.
- Generation quality depends on the app keeping its session in storage the
  scanner can see. When the model can't tell, it returns an `INSUFFICIENT`
  marker that surfaces as an error telling the user to write the seed by hand
  — rather than inventing keys that will silently not work.
- The seed is *not* automatically applied to a project that has one saved:
  `enabled` is persisted and honored, but nothing turns it on by itself.

---

## Phase 4 — Guarded merge ✅ (2026-08-28)

The differentiator, and the one feature where a bug is a corrupted codebase
rather than an annoyance. The whole phase is organised around PRD §6's metric:
*zero* merges that land and break the build.

| FR | Status | Notes |
|---|---|---|
| FR-5.4 merge proposal | ✅ | Read-only `plan` (member sources, prop signatures, behaviour, traced call sites) → model writes the canonical component → dry-run codemod produces every file's before/after → full diff review with the source editable in place |
| FR-5.5 call-site rewrite | ✅ | Retag + prop-merge + import fix-up, per call site; retired files staged in `.dedup-trash/` with a manifest, restorable, deleted only on explicit confirmation |
| FR-5.6 safety gates | ✅ | Typecheck, build (project script *and* the dev server's live compile), visual regression at 1% tolerance; any failure rolls the merge back automatically |
| FR-5.7 per-merge commit + history | ✅ | `dedup: merge A, B → A` on the session branch; History panel lists every dedup commit with a one-click undo |
| FR-5.8 behaviour differences | ✅ | Hooks/handlers/calls compared across members; differences shown in the prompt *and* on the review screen before approval |
| FR-5.9 batch mode | ✗ | Deliberately not built — see below |

**The division of labour, and why.** The model does exactly one thing: decide
what the merged component's API should be, and write it. It never touches call
sites (the codemod rewrites those mechanically from a validated prop map), it
never decides what may be deleted, and its output crosses a narrow boundary —
a component source that must parse and must export the promised name, plus a
prop map whose values must be strings, numbers or booleans. Everything else it
emits is discarded. That boundary is `lib/mergeProposal.ts`, and it is tested
against malformed replies, forgotten members, escape-attempt prop values and
paths outside the project.

**A name match is not a call site.** The scan counts `<Card` occurrences by
name, which is fine for ranking clusters and catastrophic for a codemod: a
`<Card>` imported from a UI library would be renamed along with yours. Every
call site the merge touches is traced back to the member's file through a real
import — relative specifiers, tsconfig `paths` aliases and `baseUrl`
(`plugin-src/resolve.mjs`). Anything unresolvable is reported, never guessed.

**All-or-nothing, across files.** The class write-back's guarantee (one parse,
one write, output re-parsed first) is applied to the whole project: every
output file is computed in memory and re-parsed strictly, and only then is
anything written. A merge that would leave the project half-rewritten does not
happen at all — which for a multi-file rewrite is the only safe version of it.

**Refusals, each because the alternative is a broken build**
- The proposed canonical source doesn't parse, or doesn't export the name it
  promised.
- Merging into an existing file would drop exports that file already had —
  every importer of those would break, and it is checkable, so it is checked.
- A member is re-exported by a barrel (`export { Card } from "./Card"`): those
  bindings are not imports, so the call-site pass cannot see them, and the
  module they point at is about to be retired. Refused with the file named.
- A member is no longer declared where the scan found it (stale scan).
- A prop value that would break out of the JSX attribute it is written into.
- A file that declares more than the member is never gutted surgically; it is
  left in place, its call sites moved, and the leftover declaration reported.

**Gates: "couldn't run" is not "passed."** A JS project has no `tsc`; a project
may have no build script; an artboard scrolled off screen cannot be
screenshotted. Each of those produces a `skipped` verdict carrying its reason,
the merge is allowed to stay, and the review says plainly that it landed on
weaker evidence. Rounding a skip up to a pass is how a tool corrupts a codebase
while showing green, so the summary line names every skip.

The build question is asked twice on purpose: the dev server's live compile is
fast and catches the page the user is looking at, but it only compiles what a
loaded route pulled in — the project's own build script is what proves the
project. Both run; both are reported separately.

**Rollback is not `git revert`.** Revert demands a clean tree and would refuse
(or worse, involve) the user's in-flight work. A failed gate instead restores
exactly the paths the merge commit touched — including files it deleted — and
commits that. dedup's blast radius stays dedup's own files, which is the same
promise every save on this branch already makes. The staged `.dedup-trash/`
copies are dropped in the same step, so a restored file never has two spellings
on disk.

**Deviations / limitations**
- **FR-5.9 batch mode is not built.** Queueing merges means running gates on a
  codebase that several unreviewed rewrites have already changed, so a failure
  no longer identifies which merge caused it — and the rollback story stops
  being "undo one commit". One at a time is not a shortcut here; it is what
  makes the gates mean anything.
- The visual gate can only compare artboards that are mounted on the canvas at
  both capture points. Off-screen frames unmount, so they are reported as not
  checked rather than assumed unchanged.
- A merge whose canonical file is new leaves both members retired; merging in
  place keeps one file and retires the rest.
- Import fix-up handles value imports. A member referenced in a type position
  keeps its import, with a warning, rather than being rewritten on a guess.

## Phase 5 — Harden ✅ (2026-08-28)

| FR | Status | Notes |
|---|---|---|
| FR-5.2 visual signal | ✅ | Perceptual hash of each cluster member rendered in isolation; folded into cluster confidence and ranking, and allowed to contradict the structural score out loud |
| harness rendering | ✅ | Shipped in Phase 3 (Components tab) — the visual pass consumes it |
| Next.js support | ◐ | Route discovery, dev server, canvas; element tagging via a user-approved one-line `next.config` wrapper. Isolated previews stay Vite-only — see below |
| failure states | ✅ | Carried from Phase 0–3 plus the merge's own rollback reporting |

**The visual signal, and why it is median-aHash rather than dHash.** The
textbook perceptual hash compares each cell to its right-hand neighbour, which
only sees horizontal gradients — so a component with a dark left column and one
with a dark top row hash identically. UI components are almost entirely flat,
axis-aligned blocks, which is exactly that failure mode. The hash instead
thresholds every cell of an 8×8 grid against the image's *median* cell: the
whole 2-D layout survives, and using the median rather than the mean keeps the
invariance that matters, since a uniformly lighter render of the same component
crosses the threshold in the same places. Both properties are pinned by tests.

The pass is opt-in per scan (it renders and screenshots every cluster member,
which takes seconds and needs the Components tab on screen), it refines
confidence rather than replacing it, and it never adds or removes a cluster
member — a decision the user made about a cluster is not something a screenshot
gets to rewrite. A member that cannot render in isolation has no hash, and its
cluster is reported as *scored on structure alone* rather than quietly averaged.

**Next.js: what it can and cannot do, and why.** Vite takes `--config`, so
dedup instruments it invisibly. Next reads `next.config.*` from the project root
and takes no config flag, so element tagging needs a line in a file dedup does
not own. The standing convention forbids *silent* mutation, and this does not
bend it: the change is offered with its exact diff, written through the same
parse gate as any generated write, committed on the session branch, and
undoable from History. It is also inert — the wrapper does nothing unless
`DEDUP_TAGGING=1`, which only dedup's own dev server sets — so the user's
`next dev`, their CI and their production build behave identically with the line
present.

Once wired, the same `tagCode` runs as a webpack loader. That sharing is not
tidiness: an element's id is its ordinal in the shared `jsxwalk` traversal, so a
second tagger would be a second, silently incompatible identity scheme for one
write-back. `tagCode` was extracted to `plugin-src/tagcode.mjs` for exactly this
reason, and both pipelines are thin shells around it.

Route discovery now reads Next's file system directly (`app/**/page.*`,
`pages/**`), skipping dynamic segments — an artboard needs a URL that resolves —
and collapsing route groups.

**Not shipped for Next: the component harness.** Rendering one component in
isolation needs an arbitrary module URL from the dev server, which Vite serves
and Next does not. The Components tab says so rather than showing empty cards,
which also means the visual similarity signal is Vite-only.

## Next.js, verified against a real app (2026-08-28)

The Phase 5 write-up claimed Next support on the strength of unit tests. Run
against a real Next 16.2.4 project (yarn, TypeScript config, 31 routes), three
things were wrong — two of them silent.

**Route discovery was unreachable.** `discoverNextRoutes` was served only from
the Vite plugin's `/__dedup/routes` middleware, and Next has no middleware
dedup can add — so the feature written for Next projects worked on every
project except Next. Discovery now lives in `plugin-src/routes.mjs`, the
write-back sidecar answers a `routes` command, and the frontend falls back to
it whenever the HTTP endpoint is absent or empty. One implementation, two
callers, same rule as `tagCode` and `jsxwalk`.

**A TypeScript config broke dedup's own gate.** `next.config.ts` under `strict`
importing an untyped `.mjs` is TS7016, and `skipLibCheck` does not help — it
skips checking declaration files, not their absence. dedup's config line would
have failed dedup's typecheck gate. A `next.d.mts` now ships beside the
wrapper; deleting it reproduces the error on the real project, restoring it
passes clean.

**Turbopack never runs `webpack()`.** The project's dev script is
`next dev --turbopack`, and Next 16 uses Turbopack by default anyway — so the
wrapper would have been a config line that looks wired and tags nothing. The
first fix refused to offer the wrapper at all, which was worse: a Turbopack
project could then never reach a wired state. Since dedup starts the dev
server, it starts it under `--webpack` instead, and the flag goes *through* the
project's own script rather than replacing it — that project's script carries
`NODE_OPTIONS=--max-old-space-size=8192` for a documented OOM, and a direct
`next dev` would have dropped it.

**Correction, from first real use: appending the flag doesn't work either.**
Forwarding `--webpack` through the package manager only works when the script
sets no bundler flag of its own. This one says `--turbopack`, so Next received
both and refused to start — "Multiple bundler flags set". The flag has to
*replace* theirs, which cannot be done from outside the script, so dedup now
runs `next` itself: it reads the script's leading `KEY=value` assignments into
the child's env, drops any bundler flag, keeps every other argument, and adds
`--webpack`. A script with shell operators (`&&`, a pipe, a wrapper like
`concurrently`) is refused rather than rewritten, and dedup says tagging is off
instead of starting a server that tags nothing — the same conservatism the Vite
launch rewrite uses. The regression test drives the exact failing script.

**What the run proved.** With the wrapper in place: dev server ready in 930ms,
**346 tagged elements** in the SSR HTML with correct `file@ordinal` ids,
component names, and the capability markers the overlay gates gestures on (17
`core="root"`, 2 `core="body"`, 15 `dyn="array"`, 13 `dyn="conditional"`); the
overlay entry present in `main-app.js`; `tsc --noEmit` clean. The project was
restored to a clean tree afterwards.

**Still not supported on Next:** isolated component previews, and therefore the
visual similarity signal — they need the dev server to serve arbitrary module
URLs, which Vite does and Next does not. Turbopack itself remains unsupported
as a *bundler*; dedup works around it by launching webpack rather than by
tagging under it.


## Codex as a second AI backend (2026-08-29)

`ai.rs` was a Claude Code bridge; it is now an agent bridge with two arms. The
process plumbing (spawn, feed stdin on a thread so a large prompt can't
deadlock against a child already writing, hard timeout, read the answer) was
never Claude-specific — only the binary name, the flags meaning "headless, no
tools, no session, touch nothing", and how the answer is framed. Those live in
`Agent` and nowhere else.

Codex is invoked as `codex exec --sandbox read-only --skip-git-repo-check
--output-last-message <file> -`, prompt on stdin. Three of those are load-
bearing: the prompt cannot be an argv entry (these carry whole source files),
the sandbox is read-only because dedup wants words rather than edits, and the
git check is skipped because dedup deliberately runs agents from a neutral temp
directory, which is not a repo. The answer is read from the last-message file
when there is one and scraped from stdout only as a fallback for an older CLI.

The frontend's five Claude-specific store fields collapsed into
`agents: Record<CliAgent, AgentState>`, and the AI switch renders a card per
entry in `CLI_AGENTS` — a third agent is a row in that list.

**Not verified end to end.** No `codex` binary exists on the machine this was
written on, so the flags are from documentation, not from a run. The detection
path *is* verified (an absent CLI reports "not installed"), and the Connect
round-trip is what proves the rest on a machine that has it — now that a failed
invocation reports the CLI's own words instead of a bare exit code, a wrong
flag will name itself rather than looking like a hang.

## Interlude — the canvas becomes the app (2026-08-28)

The chrome was docked columns with hairline dividers, squeezing the canvas into
what was left. It now floats: the canvas is full-bleed and the sidebar,
inspector, top bar, toolbar and console are rounded, blurred, elevated panels
over it. The app being designed is the thing at the centre of the screen.

Three things follow from that, and each is a real change rather than styling:

- **`.panel` is one class, not a recipe repeated per component.** Every floating
  surface has to sit at exactly the same elevation or the illusion that they
  share a plane above the canvas collapses.
- **"Centre the artboard" now means centre it in the space the user can see.**
  Centring on the raw container parks the artboard's label under the top bar and
  its left edge under the sidebar. The fit maths insets by the live panel widths.
- **Separation is elevation, not dividers.** `--color-line` became a low-alpha
  white so one token reads correctly both inside a panel and against the canvas
  behind it, and the panels' inner tab strips became segmented controls — a
  second horizontal rule inside a panel that already has an edge reads as a seam.

---

## Two more kinds of folder — static sites and empty ones (2026-08-29)

dedup could open a Vite or Next project and nothing else. It now opens two more
things, and they turned out to be one change rather than two: what dedup can
*create* in an empty folder is exactly the set of things it can *open*.

**PRD deviation, deliberate.** §1.5 lists "creating new projects / scaffolding"
as an MVP non-goal, on the reasoning that dedup is not a v0/Lovable competitor.
That reasoning still holds and this does not cross it: there is no generation
here, no prompt-to-app. There are two fixed starter templates, offered only
when the folder is empty, so that "open a folder" has a sensible answer for a
folder with nothing in it. The non-goal it protects — dedup does not compete on
building apps from prompts — is untouched.

### Static sites (`Framework::Static`)

A folder of `.html` files has no build step to inject a tagger into. It also
needs none: the file *is* the markup, so the element↔source mapping is 1:1
rather than compiled — genuinely simpler than the JSX path, not a degraded
version of it.

**dedup is the dev server.** `plugin-src/serve.mjs` serves the folder and runs
every HTML response through the stamper on the way out. It announces its URL in
Vite's format on purpose: `devserver.rs` parses that line, so process-group
teardown, log streaming and ready-URL detection all apply with no second code
path. Live reload is an SSE endpoint plus `fs.watch` — the static equivalent of
HMR, which for a page with no module graph is just a reload.

**One walk, two languages.** `htmlwalk.mjs` is to HTML what `jsxwalk.mjs` is to
JSX: the single definition of which elements dedup knows about, in what order,
and what may be done to each. The stamper (`htmltag.mjs`) and the write-back
(`htmlback.mjs`) both import it, for the same reason the JSX pair does — an
element's id is its ordinal in that walk, so two walks would be two
incompatible identity schemes for one write-back. `writeback.mjs` dispatches
between the two by file extension and nothing else.

**The gate is structural, because parsing proves nothing here.** This is the
one genuinely new safety problem. A JSX write-back can re-parse its output and
be told definitively that it broke the file. HTML5 is *required* to recover
from anything, so `<div class="a><p>x</p></div>` is not an error — it is a
`<div>` with a very long class attribute that ate the paragraph. So:

- a content-only program must leave the output's tag sequence (depth + tag, in
  walk order) **identical**;
- a structural program must produce **exactly** the element count its ops imply;
- either way the output may introduce **no HTML5 parse error the input did not
  already have**;
- and a snippet whose element is never closed is refused at the boundary — it
  is a legal fragment that would swallow every sibling after it, and nothing
  downstream would notice.

Each of those is a test in `pnpm test:html`, written before the rule it guards.

**Where dedup's files go.** `node_modules/.dedup` was chosen because it is
git-invisible by construction. A static site has no node_modules, and creating
one to hide files in would drop an untracked folder into the user's repo. So
`sidecar::support_dir` is now the single answer to "where do this project's
dedup files live": `node_modules/.dedup` with a package.json, the app cache
directory keyed by project path without one. Nothing lands in a static site's
folder at all.

**Honest about what's off.** The Duplicates tab reads React components, so it
is read-only with that reason on a static site rather than a Scan button that
could only ever find nothing — and `runScan` refuses it too, so a shortcut
can't start one. The typecheck and build gates report `skipped`, which is
already a first-class verdict. The compatibility card drops the TypeScript and
package-manager badges: those aren't things a hand-written site is missing,
they're things it doesn't have.

### Empty folders

`project::detect` answers `is_empty` before any heuristic runs. "Unsupported —
no package.json" is a true statement about an empty folder and a useless one;
the launch screen shows a starter picker instead of a verdict.

Two starters, matching the two things dedup opens: **React app** (Vite +
TypeScript + Tailwind v4, installs dependencies) and **HTML page** (index.html
+ style.css + the Tailwind CDN, no install, works offline). Both include
Tailwind deliberately — the Style panel writes Tailwind classes, and a starter
without it would let the panel write classes that render nothing.

`scaffold.rs` refuses any folder that isn't empty, writes the files, runs
`git init`, and commits the starter as the repo's **initial commit** — so every
dedup edit afterwards has a clean baseline to diff against. Install runs after
the commit, so the first commit is the starter and not whatever a lockfile
resolved to. An install failure keeps the files and says what to run.

### Deviations / limitations accepted

- The static write-back edits `.html`; `.css` gets a brace-balance check on
  whole-file AI writes, explicitly **not** called a parse gate (dedup bundles
  no CSS parser, and the check is honest about being a truncation guard).
- Isolated component previews, the duplicate scan and the merge stay
  React-only. There is no component to preview in a static site.
- A static site's pages are found at the root or in one of `public/`, `site/`,
  `www/`, `docs/`, `src/`. The server serves that folder (`--root`) while ids
  stay relative to the project root (`--base`), so one project has one path
  vocabulary.
- The starter picker and the static editor session are wired and typechecked
  but were not clicked through by hand; every layer beneath them is covered by
  the tests below, including the seam between them.

**Tests:** `pnpm test:html` (25) — the HTML walk, stamper, write-back, every
refusal above, the static server's path-traversal refusal, and the id
round-trip between the two separately-bundled halves. Rust (80 total, +10):
empty/static detection, the subfolder case, Tailwind read off the page, a Vite
project's index.html *not* being mistaken for a static site, both starters
producing a project `detect` recognises, and one end-to-end test that takes an
empty folder to a served, stamped page with the user's file untouched.

## Fix — double-click to edit text, and a text tool to show it (2026-08-29)

Double-clicking text on the canvas was supposed to put the caret in it. It did,
intermittently, which read as broken.

**The race.** A double-click's two clicks each select, and `setSelected` fires
an `inspect` through the node sidecar to learn whether the element's text may
be edited. `requestTextEdit` read `sourceInfo` and returned silently on a null
— and the sidecar spawn usually had not returned by the time `dblclick` fired.
Worse, the *second* click reset `sourceInfo` to null and started a second
lookup, so the gesture actively raced itself.

Two changes: `setSelected` no longer restarts an inspect for the element that
is already selected, and the in-flight lookup is held in `sourceInfoPending` so
`requestTextEdit` can **await** the answer instead of giving up on it. When the
answer is "no", the element is still selected and the Inspector is already
showing `textReason` — the reason is on screen, and entering a text mode that
could not type would be the dishonest part.

**The missing mode.** Nothing in the UI ever said a caret was on the canvas.
There is now a `text` tool (T) beside Select/Hand/Browse:

- Double-clicking text enters it for that one edit and hands it back when the
  caret leaves; choosing it with T or the button is sticky, so the next click
  edits the next thing (`textToolSticky`).
- In the tool, a **single** click puts the caret in — a selection *is* an edit
  request there.
- While a caret is actually in the page the button widens to read "Typing", so
  the user can tell an armed tool from a live one and knows why their
  keystrokes are going into the artboard.

The mode follows the caret rather than intent: only the overlay knows when an
edit ends (Escape, Enter, a click elsewhere, a re-render), so it now posts
`text-editing {id|null}` and the store's `setTextEditing` owns the tool. The
overlay also gained a `text-edit-end` command, because leaving the tool has to
take the caret with it — one still blinking in a page you are now panning is a
lie about the mode.

Two smaller things fell out: a repeat `text-edit-begin` on the element already
being typed into is now a no-op (it used to end and restart the edit,
reselecting all its text and losing the caret position), and the insert
palette's text button became a paragraph glyph — two identical `T`s a few
pixels apart read as one control.

**Not done:** the canvas cursor doesn't change to an I-beam in the text tool.
That needs the overlay to be told the tool, which is a third field on
`set-edit-mode` and three call sites, for a cosmetic cue the highlighted
toolbar and the "Typing" label already carry.

**Tests:** `pnpm test:overlay` (17, +3) — the overlay reports a caret landing
and leaving, a repeat begin does not restart the edit, the editor can take the
caret back, and the tool shortcuts (now including T) are forwarded from inside
the canvas but never while typing, so "the" can no longer switch tools and
delete the selection.

---

## Chat becomes an agent (2026-08-30)

The chat tab could only do one thing: edit the file behind the element you had
selected. No selection, no chat — the composer was disabled and the placeholder
said "Select an element first". That is not what anyone coming from Cursor
expects, and it is wrong on its own terms too: the moment you most need to ask
a question is when the build is broken and there is nothing on the canvas to
click.

**A selection is context, not a gate.** The composer is always live once a
backend is connected. With something selected, its file goes in with the
element named and its line pointed at, and a chip above the composer says so —
dismissing the chip clears the selection, because the selection *is* the
attachment and a second piece of state pretending otherwise would drift. With
nothing selected, the project's file inventory goes in instead, and the model
finds its own way.

**Tools it doesn't have.** Finding its own way means reading files, and the
non-negotiable rule is that a coding agent dedup borrows is never given tools
or write access — a second path to the user's source would be an unaudited one.
So the tools are a *protocol*, not a capability: the model replies with `TOOL:
read <path>`, `TOOL: grep <pattern>` or `TOOL: list`, dedup runs the read-only
sidecar and hands the results back as the next turn, up to `MAX_TOOL_ROUNDS`
(6). Everything the model can see, dedup fetched on purpose and can show the
user — the trace of what it looked at is printed above each answer.

**Multi-file, all or nothing.** Edit blocks now carry the file they belong to
(`<<<<<<< SEARCH src/Card.tsx`), and `<<<<<<< CREATE … >>>>>>> END` adds a whole
new file, so "extract this into its own component" — which the empty-state copy
had been promising since Phase 4 — is finally a thing chat can do. The write
path is `writeFiles`: every file's new content is validated *before any file is
written*, the same guarantee the class write-back makes within one file and the
merge codemod makes across a set. A refactor that half-lands is not a state the
project can reach.

Two refusals fell out of it and both have tests. A block naming a file the
model never read is refused rather than applied — a SEARCH written from memory
is exactly what the exact-match rule exists to catch. And a file over 120KB is
not sent at all: a reply that got truncated mid-file, written back, would
delete the rest of the module.

**A proposal you can look at.** The old flow applied the model's edit and
committed it in one breath; the first sight of the change was a canvas reload
of something already in your history. The first pass at fixing that showed a
diff and wrote nothing until Apply — which was safer and still wrong, because a
diff tells you what changed and not how it looks, and looking is the reason
dedup renders the app at all.

So a reply becomes a *proposal that is on the canvas*: written out through the
parse-gated `writeSources`, uncommitted, with its diff in the chat. **Keep**
commits it to the session branch; **Discard** calls `revertSources` and puts
every file back byte-for-byte — original content restored, created files
removed. The safety line moved from "written vs not" to "committed vs not",
which is the same bargain Cursor makes and the only one under which a preview
can exist at all.

Three things fell out of that and each is load-bearing. The revert path is the
one write that is deliberately **not** content-gated: it restores bytes dedup
read off those exact files, and validating them would refuse to put back a file
that was already broken — precisely the case where the user asked the agent for
help, previewed the fix, and wants their tree back. Leaving the project reverts
a live preview, because closing is not a decision to keep it. And the top bar
carries an **AI preview — keep or discard** badge, because a user who switched
to the Design tab would otherwise have uncommitted AI edits on disk with
nothing on screen saying so.

Only one proposal is unresolved at a time: a second was computed against the
contents the first put on disk, so keeping both would mean keeping one that is
quietly wrong. Superseding reverts the older preview and marks it `superseded`
in the transcript rather than dropping it silently.

The proposal's file *contents* live in transient store state, not in the
persisted transcript. A chat log is saved per project; it has no business
holding snapshots of the user's source.

Two guards moved rather than disappeared. The stale-selection check no longer
kills the turn — the element pointer is dropped and the model is told the
selection is out of date, which is strictly better than aiming it at the wrong
element. And the "this file has unsaved style edits" refusal moved from
send-time to just before the preview write: until the model answers dedup does
not know which files are in play, and the preview is the moment it starts
mattering.

Also un-gated: the console drawer's **Ask AI** button, which required a
selection to send a build error to a chat that then had to fix it in that one
file. It now asks the agent to find the cause.

Still not Cursor: replies do not stream (the CLI bridge waits for the whole
child process, so there is no Stop button either), and there is no ⌘K inline
edit in the code panel. Both are additive on top of this shape.

## Fix — committing a file that didn't exist (2026-08-30)

"Can we add a new page?" produced a good answer, a correct preview, and then
`git commit failed: error: pathspec 'docs.html' did not match any file(s)
known to git` on Keep.

`git commit -- <path>` takes a **pathspec**, and a pathspec matches only files
git already knows about. That form was chosen deliberately — it commits the
worktree state of exactly those paths and leaves the user's own staged work for
other files alone (FR-4.5) — but it silently cannot express "and this file is
new". The failure lands at the worst possible moment: after the file is on
disk, when the user has already looked at it and said yes.

`commit_paths` now stages the untracked paths in the set first, and only those.
A tracked path keeps the bare pathspec form, so the guarantee that made the
original choice right is untouched. A path that is neither tracked nor listed
as untracked is covered by the user's `.gitignore`; that is refused with the
reason spelled out, because force-adding it would be dedup overriding a
decision the user wrote down, and git's own error names the path without ever
saying why.

This was latent in the merge too, not just chat — merging into a new file goes
through the same commit. Two tests: a commit mixing an edited file, a new file
and a new file in a new directory, with an unrelated staged file still only
staged afterwards; and an ignored new file refused with both the path and
`.gitignore` in the message.

## Cut, copy and paste a section (2026-08-31)

The canvas could add an element from the palette, delete one, and drag one to a
new parent. It could not take a section and put another one like it somewhere
else — the gesture everybody reaches for first, and the one a duplicate-finder
has the least excuse for missing.

**A copy is two renderings of one element, exactly like a palette entry.** The
palette writes both by hand — the JSX that goes into source and the HTML that
goes on the canvas — because deriving one from the other would mean shipping a
JSX renderer into the overlay. A copy has the same two halves and gets them
from the two places that actually know: the *source* from the write-back's new
`copy` command, because the file is the truth about what a paste will write,
and the *picture* from the overlay's `copy-element`, because only the page
knows what that source rendered as.

Which means the copy is what the **file** says, not what the screen shows. A
staged-but-unsaved edit inside the copied section is not in it. Rather than
refuse the copy or silently take the stale version, `copy` reports every
ordinal it swallowed — from the same parse that produced the snippet, so it
is exact where the DOM could not be (an element staged for deletion is already
off the screen and still in the file) — and the editor counts the staged
actions that land inside and says so: *"Copied Card · section as it is saved —
2 unsaved edits inside it aren't included."*

**A snippet now carries its language.** Everything the palette stages is JSX,
respelled once at the boundary for a page that speaks HTML; that only works
because palette markup is a single element `toHtmlSnippet` can rewrite. An
arbitrary copied subtree has no such translation, so `EditAction`'s insert
carries a `SnippetLang` and a mismatch is refused — at paste time, where the
user can still see what they aimed at, and again in `opsForFile` as the
backstop. Copying between two files of the same kind, which is the case worth
having, is verbatim.

**Where a paste lands.** As a sibling *after* the selection, which is what the
gesture means most of the time. Not everything can have a sibling, though: a
component's root element and `<body>` would put the copy somewhere the file
cannot express (adjacent JSX with no parent), so those take it as a child
instead, and something that can be neither is refused with the reason. Pasting
again straight after a paste aims at the anchor the last one used, so repeats
pile up as siblings rather than refusing against an element that has no node in
the file yet.

**Cut and paste arrive as one program.** A cut stages a remove and a paste
stages an insert, and both land in the same save. Appending content onto a
chunk that the same program removes drops it silently — magic-string is right
to, and it is the one failure a paste must never have — so both write-backs now
resolve what a program deletes *up front* and refuse an insert whose anchor is
being deleted or whose insertion point falls inside something that is. A paste
somewhere else in the same program is a real move and still lands. The order
the two ops arrive in does not matter, which is why the ranges are resolved
before the loop rather than during it.

**Names a snippet cannot carry.** `<Card title={title} />` needs both `Card`
and `title` wherever it lands, and neither travels with the markup. `copy`
reports them (components it renders, variables its expressions read, minus the
names it binds itself and the obvious globals) and a paste into a *different*
file asks the one question it can answer for certain: does the destination
mention this name at all? A no is proof the paste will not build and is said
out loud; a yes proves nothing — a same-named local is not the same binding —
and is left alone. Said, not refused: the paste is staged and undoable, and a
gate that cannot be sure has no business blocking.

That message needed somewhere to go. `saveError` renders as **Save failed —
retry**, which is not what "copied" or "nothing to paste" means, so the top bar
gained a plain `notice` slot that clears itself — its own slot, not part of the
save-state chain, because a paste both says something and leaves an edit
staged. The cross-file move refusal, which had been borrowing `saveError`,
moved there too.

**A pasted section is read-only until it is saved.** The rewriter that folds
class and text edits into a not-yet-written insert parses one element with
quoted attributes; a whole subtree is not that. So `pendingNodeInfo` reports a
pasted section as read-only with a reason rather than accepting edits the save
would refuse — one ⌘S gives it real nodes and everything works on it.

Keyboard-first (⌘C/⌘X/⌘V, forwarded from inside the canvas like every other
shortcut, and only when nothing else has a claim on the gesture — a text
selection, a field, or a caret in an element on the canvas all mean the user is
copying text) with buttons in the inspector beside Delete, because a gesture
with no visible affordance is one most people never find.

Limitations kept on purpose: it is dedup's own clipboard, not the system one —
what is being carried is a piece of source with a rendering attached, and
neither half survives a round trip through plain text. It clears when the
project does, since a snippet from a closed codebase has no business landing in
the next one.

**Tests:** `pnpm test:plugin` (41, +3) — copy handing back verbatim,
de-indented source that insert takes straight back, the ordinals it swallowed,
the names it reports (and the ones it correctly doesn't: a name the snippet
binds itself, an attribute name); and a paste refused in all three positions
when its anchor is being deleted, writing nothing, while a paste elsewhere in
the same program lands. `pnpm test:html` (28, +3) — the same three for markup,
plus `<body>` refusing to be copied. `pnpm test:overlay` (26, +2) — the
subtree's markup reported with every `data-dedup-` stamp stripped (left in, the
copy would answer to the same id as its original and every lookup in the
overlay would hit whichever the DOM returned first), a frame without the
element staying quiet, and two inserts at one anchor previewing in the order
the save writes them. `pnpm test:actions` (8, +1) — the language matrix, both
directions. `cargo test` (87, +1) — copy from one file, paste into another,
re-indented for where it landed, and nothing outside the project copyable.

## Show the app with no internet (2026-08-31)

Every app has a screen for "no connection" and almost nobody ever gets to look
at one: you cannot style an error state you cannot reach. That is the same
problem the hold solves for splash screens and the mock session solves for
protected pages, so it is solved the same way — a per-artboard toggle whose
flag rides in on the frame's URL, read by the boot script before the app boots.
`?__dedup_offline=1`, next to `?__dedup_hold=1`.

**It cuts the app's network, not the frame's.** The naive version — kill
`fetch` — also kills hot reload, and an artboard that stops updating the moment
you switch it offline is useless for the thing you switched it offline to do.
So the cut has an allowlist of same-origin prefixes that belong to the dev
server and to dedup rather than to the app (`/__dedup/`, `/@vite/`, `/@id/`,
`/@fs/`, `/node_modules/`, `/_next/static/`, `/_next/webpack-hmr`, …), plus
Vite's HMR socket, which announces itself by its `vite-hmr` protocol.
Everything else — every cross-origin request, and every same-origin route the
app itself defines — fails.

**Nothing is mocked, and that is the whole point.** `session.rs` already says
dedup "never mocks the network"; this does not break that rule, it is the rule
applied. dedup changes the *conditions* and lets the app answer: a blocked
`fetch` rejects with WebKit's own `TypeError: Load failed` (the canvas is a
WKWebView, so that is the message the app would really be handed), a blocked
XHR reaches readyState 4 with status 0 and fires `error` then `loadend`, a
socket constructs and then dies with close code 1006, `sendBeacon` returns
false, and `navigator.onLine` reads false from the first line the app runs. No
response is invented anywhere. What renders is the app's real offline
behaviour, which is the only version worth styling.

The XHR case is where the fidelity is load-bearing rather than decorative: a
library that waits for readyState 4 and never sees it does not show an error
state, it shows a spinner forever — so `readyState` is shadowed with an own
property and the event sequence is the real one. The alternative considered and
rejected was pointing blocked requests at a dead local port to get authentic
failures for free; it works, but it fills the user's console with requests to
`127.0.0.1:1` that their app never made, and a design tool that lies in the
console is not worth the saved code.

**Flags now travel.** They live in the query string, so anything that sends a
frame to a bare path drops them — and `reload {path}` (how a session change
brings a bounced frame back to its pinned route) did exactly that. An offline
artboard would have quietly come back online with the editor's label still
saying "offline", which is the worst kind of bug this app can have. The overlay
now carries any `__dedup`-prefixed param across a navigation it drives, matched
by prefix rather than by name: it is a third separately bundled world after
`boot.mjs` and `lib/origins.ts`, and one more list to keep in sync is one more
way to lose a flag with nothing to see. `frameUrl` took a positional `held`
boolean and now takes `FrameFlags`, so the next one is a field rather than a
fourth argument.

Said out loud on the artboard itself, in the label beside "held": an artboard
whose every request is failing looks exactly like an app that is broken, and
the badge is the difference between the two.

Drive-by, in the same spirit: `heldRoutes` was not cleared when the project
changed, so a held "/" leaked into the next project's "/" artboard. It is
cleared alongside the new `offlineRoutes`, next to the comment that already
promised it.

Limitation kept on purpose: the cut blocks requests the app *makes*, not
subresources the browser fetches for it, so a remote `<img>` or webfont still
loads. Blocking those needs a CSP injected ahead of the page's own content —
a bigger, riskier mechanism aimed at a smaller part of the problem, and the
data fetching is what the error states are actually about.

**Tests:** `pnpm test:plugin` (49, +8) — armed only by the flag and only inside
the canvas (the user's own browsing of their dev server is never cut); a clean
install on a page missing any given request API, since a throw in `<head>`
takes the app down; the app's requests failing while six kinds of tooling
request still go out; the XHR event sequence and readyState; a socket dying
with 1006 while the `vite-hmr` one is left alone; the `offline` event fired
only once the page can have a listener; and offline composing with the hold —
the regression that matters, since the hold ends the boot script with a
`return` and anything after it would silently stop installing.
`pnpm test:overlay` (27, +1) — a driven navigation keeping the frame's dedup
flags and dropping the app's own query. `pnpm test:origins` (8) — the editor
and the boot script agreeing on every flag, both flags wearing the prefix the
overlay matches on, and `frameUrl` carrying either or both.

## The agent can bring an image it generated (2026-08-31)

Reported from a real session: Codex was asked for an image, generated one, and
then had to say so rather than use it —

> The image was generated, but I can't safely wire it into `index.html`:
> dedup's protocol has no way to import the generated binary asset.

It was right, and the file was really there: a 1.5 MB PNG under
`~/.codex/generated_images/`. The chat protocol carries text — SEARCH/REPLACE
and whole CREATE files — and `validateContent` refuses any extension it has no
parser for, so a PNG could not be expressed at any point in the path.

**A fourth marker, and it is a request rather than an instruction.**

    <<<<<<< ASSET public/hero.png
    /Users/…/.codex/generated_images/…/exec-….png
    >>>>>>> END

The block holds one path and nothing else, because it is a *reference* to a
file dedup will go and look at, not content to salvage — two paths in there is
a model that has misunderstood, and picking one would be dedup guessing.

**This is the first time something the model said names a path outside the
project, so it is the first place that has to assume the model is wrong.** The
failure to design against is not a clumsy agent, it is `~/.ssh/id_rsa` →
`public/hero.png` → committed → pushed. `asset.rs` therefore refuses on four
counts before it copies anything: the source must resolve **through symlinks**
(canonicalize both sides — a link planted inside the allowed directory is the
same attack wearing an allowed path) into that agent's own output directory and
nowhere else; it must be under 16 MB; its **magic bytes** must say PNG, JPEG,
GIF or WebP, never its extension, which is the part the model chose; and the
destination extension has to agree with those bytes, on a new path inside the
root. Each has a test, the symlink one included.

Where that directory is belongs to the agent, so it is `Agent::asset_dir` — one
more match arm, the pattern the file already uses for binaries, flags and
fallbacks. Claude Code returns `None`: it generates nothing to import, and the
prompt is only given the ASSET directive when the backend's `generatesAssets`
is true. Inviting a model to use a directive that could only fail is worse than
not having it — it will reach for it and then have to explain itself to the
user, which is exactly the message that started this.

**Imports go first, and that ordering is the all-or-nothing rule.** An import
is a new file, so it can be taken back cleanly; a text write that has landed
cannot be, without the `before` snapshots `sendChat` is still holding. So the
gated half runs first and is unwound if the rest fails. After that an asset is
an ordinary part of the proposal: previewed on the canvas uncommitted like
everything else, committed with the text on Apply (untracked, which
`git::commit_paths` already stages by name), and removed on Discard —
`revertSources` with a null content, which is the same path a created file
takes. Two collisions are refused outright rather than resolved: a reply that
both writes and imports the same path is two answers to one question, and an
ASSET block from a backend that generates nothing is a model off script.

Deliberately *not* built: a general file-import capability. The model may name
a file it just generated, in the one directory it generates into. Everything
else on the machine stays exactly as unreachable as it was.

**Fix, same day.** The first real attempt failed with *"that image is a PNG,
so it cannot be saved as .png> — name it .png"*, which is a confusing way to
be told the model made a typo. The prompt writes its placeholders as
`<project-relative path>`, the model copied the brackets, and
`<public/hero.png>` has the extension `png>`. Paths in markers now go through
`undecoratePath`, which takes off angle brackets, quotes and backticks —
unambiguous rather than a guess, since a real path wears none of them, and the
same undressing `parseTools` has always done for TOOL arguments.

Reported a second time, in a shape the first fix missed: only *balanced*
wrappers were stripped, and a model that opens a bracket does not reliably
close one, so `public/hero.png>` complained exactly as `<public/hero.png>` had.
Angle brackets now come off unpaired — safe in a way it would not be for
quotes, since `<` and `>` are illegal in a Windows path and effectively never
seen in a real one anywhere else, while an apostrophe in a filename is
ordinary. The refusal also names the destination it was handed rather than the
extension alone: "cannot be saved as .png> — name it .png" is two nearly
identical strings with the difference invisible. The prompt
also now says outright that the brackets mark where a value goes and are not
part of it. A bare marker still means "the file in play" rather than a file
called `<>`.

**Tests:** `cargo test` (90, +3) — the source confinement (an ordinary path
refused, and a symlink out of the allowed directory refused too), the byte
sniff and the name having to agree with it, a successful import arriving
byte-for-byte, no overwrite, no escape from the root, and an agent that
generates nothing saying so. `pnpm test:chat` (21, +4) — an ASSET block parsed
alongside the markup that uses it, one on its own still being an edit, four
malformed shapes throwing rather than importing a guess, and a path wearing the
prompt's own placeholder brackets (or quotes, or both) still being a path.

## Two small things in the chat composer (2026-08-31)

**Copy a prompt you already sent.** Hovering a sent message shows a copy icon
in the gutter beside it; it turns into a tick for a moment when the write
lands, and only then — a clipboard write makes no sound and changes nothing on
screen, so a button that looks identical afterwards reads as one that did
nothing. It stays visible on keyboard focus as well, since hover-only would put
it out of reach. `copyText` tries `navigator.clipboard` and falls back to the
old textarea + `execCommand` route, returning false rather than throwing so the
tick never appears for a copy that did not happen. Both live in `ui.tsx`, so
the same button can go on assistant replies whenever that is wanted.

**↑/↓ through prompts already sent**, shell-style, scoped to the conversation
on screen. The rules are in `lib/promptHistory.ts` rather than the panel
because they are a state machine whose edges are invisible in a screenshot, and
one of them matters: the composer is a textarea, so ↑ inside a multi-line draft
belongs to the caret and taking it would make the box impossible to edit.
History moves only from the edges. Two other edges earned their tests — ↑ at
the oldest entry is swallowed rather than passed on (a caret jumping to the top
reads as a recall that silently failed), and a half-written draft is stashed on
the first ↑ and handed back by the last ↓, including one edited out of a
recalled prompt. Losing typed text to a keystroke is the whole reason the shape
has a stash in it. Consecutive duplicate prompts collapse; ones returned to
after others keep their place.

**Tests:** `pnpm test:prompts` (6, new) — the history list (newest first,
replies and blanks skipped, consecutive repeats collapsed but distant ones
kept), the walk in both directions, the stop at the oldest, the draft
surviving a round trip, and every case where the keys belong to the caret
instead.

## Fix — a staged program that could not be saved or escaped (2026-08-31)

Reported: the chat refused with *"index.html has unsaved style edits. Save
(⌘S) or discard them first"*, and saving answered *"Save failed — retry"*.
Neither door opened. Retry could not work, and the reason it could not was in a
tooltip.

**The trap.** An edit addressed to a `pending:` insert has nowhere to land once
that insert is gone, so `opsForFile` refuses it — correctly, and permanently:
every later save throws on the same orphan. Deleting an inserted element on the
canvas always took its edits with it. The review panel's per-row *Discard this
edit* did not: it dropped exactly one action, so discarding the insert row
stranded the class or text edit made to that element. And the chat refuses to
run while any staged action targets the file, so the app's own advice —
"discard them first" — was the thing that could produce the deadlock.

Three parts to the fix, and only the first is the bug:

- `withoutAction` puts the rule in one place: discarding an insert discards
  what was addressed to it, the same rule `removeSelected` already applied.
- `discardAllEdits` is the way out of a program that is *already* stuck.
  Nothing staged has ever been written, so there is nothing to put back — but
  every other exit from a staged program went through a save, which is exactly
  what was failing. It sits in the review panel as **Discard all** and beside
  the failure in the top bar.
- The top bar shows the reason instead of hiding it. "Save failed — retry" made
  a save that could never succeed indistinguishable from one worth retrying,
  and offered only the button that could not help. It now reads the error out,
  with Retry and Discard edits next to it.

**A second bug, found on the way**, from the paste feature: a staged insert
used to be JSX always, so folding a restyle into one wrote `className`. A
pasted snippet carries the spelling of the file it came from, and `className`
in an HTML page is an unknown attribute that styles nothing — the restyle
silently did not happen and the original classes stayed. `classAttrFor` now
answers that question everywhere a staged snippet's classes are read or
rewritten: the fold in `opsForFile`, the inspector's view of a pending element
(which had been reporting *no* classes for HTML markup that plainly had some),
and the clipboard's own fold.

**Tests:** `pnpm test:actions` (10, +2) — a pasted HTML element restyled in
`class` and not `className`, with the palette's JSX inserts still respelled on
the way in; and discarding an insert taking its edits with it, with the orphan
first shown to be fatal so the guard is demonstrably load-bearing.

## Fix — a staged program that could not be saved (2026-08-31)

Reported as three symptoms with one cause: `save failed: insert: the element it
is placed against is being deleted`, a Save button stuck on "Save failed —
retry", and the chat refusing with "index.html has unsaved style edits".

The write-back refusal was correct and new — it arrived with cut/copy/paste,
because appending content into a chunk the same program removes drops it
silently. What was wrong is that the editor let the program be *built*. Paste a
copy beside a section, then delete that section, and the staged program holds
an insert anchored to an element the same program removes: refused at save, for
ever, with the chat also refusing while any edit targets that file. Exactly the
failure the "a staged program must never be able to strand itself" rule exists
to prevent — the rule was written down and then not applied to the actions
cut/copy/paste added.

**The check moved to where actions arrive.** `stage` is the single choke point
every staged action goes through, so `stagingConflict` runs there and `stage`
now returns false when it refuses. A program is only ever invalid as a
*combination* — the action being added is fine on its own, it is the company it
would keep — so no individual call site could have owned this. The callers that
chain off a stage (selecting a pasted element, clearing the selection after a
delete) check the return instead of assuming.

The rule is one sentence: an element on its way out cannot also be a party to
another structural edit. That covers the reported case and two more that were
already reachable, one of them worse — a *move* onto an element the same
program deletes never even produced an error, because the write-back appends
into a removed chunk and content appended to a removed chunk is dropped in
silence.

Refusing rather than repairing, and refusing the *second* action rather than
unpicking the first: re-anchoring the paste to the deleted element's parent
would move it somewhere the user did not put it, and dropping it would lose
what they pasted. So the delete is refused with what is in the way named —
"Card · section is staged to go next to this element — save (⌘S) first, then
delete it" — which is also the honest answer, since two saves is all the
sequence ever needed.

**Tests:** `pnpm test:actions` (12, +2) — deleting the anchor of a staged
paste, pasting against something already staged for deletion, both directions
for a move's source and destination, and the message naming both the obstacle
and the key; plus the negative half, that an ordinary delete-here-paste-there
program is untouched and a value edit never conflicts (it is also the action
staged hundreds of times during a drag, so the check has to fall straight
through).

## Click empty canvas to deselect (2026-08-31)

The canvas had no way to select nothing with the mouse — Escape cleared the
selection, clicking the background did not, which is the one thing every canvas
tool does.

Both ends of the click have to land on the background: a pan that happens to
finish over empty canvas is a drag, not a click, and there is a 4px allowance
for a hand that moves while pressing. "Background" is the container or the
pannable surface itself and nothing else, so artboard labels and every floating
control keep their own clicks — they bubble through this handler and are
ignored by target. Clicks *inside* an artboard never arrive here at all: they
happen in another document and reach the editor as overlay messages.

It clears the artboard selection too, since that is drawn as a selection (the
accent ring, the scan's target) and reads as one.

One thing it dragged out: `clearSelection` did not end a text edit in flight.
The overlay's `clear` does not touch the caret, and the iframe losing focus
only ends drags — so an element could stay contenteditable while the editor
believed nothing was selected. It now ends the edit, which fixes the same hole
behind Escape and the Layers panel.

Not changed: clicking blank space *inside* an app still selects the nearest
tagged ancestor rather than deselecting. `<body>` and a component's root are
real elements an inspector should be able to point at, and treating some tagged
elements as unselectable would be a different decision from this one.

**Tests:** none — this is editor chrome, which has no browser in the test path
(the gap is already listed below). Typecheck and build only.

## A readable element name, and a canvas that says where the AI is working (2026-08-31)

**The name badge got bigger** — 11px to 13px, with the padding and the parking
offset to match. It is drawn in screen pixels rather than page ones, which is
what makes the size worth setting at all: zoomed out to fit a page on screen is
exactly when a name is hardest to read, and it is also when the badge is the
only thing telling you what you are pointing at. Worth knowing and unchanged:
it follows the *hover*, not the selection, so it disappears when the pointer
leaves.

**And the canvas now says where a chat turn is working.** A turn can take a
minute, and the only sign of it was a spinner in a side panel the user may have
scrolled away from, while the element they asked about sat there looking idle.
Squares now light up across that element in a diagonal wave — deliberately not
a progress bar, because there is no progress to report, only that something is
running. Drawn *over* the element rather than replacing it: the user is still
entitled to look at the thing they asked about.

Three details earned their place. The grid is rebuilt only when its cell count
changes, because repaint runs on every scroll and re-creating it each time
would restart every animation and leave the wave stuttering in place. It is
cleared in `sendChat`'s `finally`, so a turn that throws does not leave a
section looking busy for ever. And `prefers-reduced-motion` gets a still wash
instead of a pulse — the message is "work is happening here", which does not
need the movement.

With nothing selected there is no section to mark and the panel's own
"Working…" is the whole answer, which is the honest outcome rather than a
missing feature: the agent genuinely is not working on one place.

**Tests:** `pnpm test:overlay` (28, +1) — the layer mounted with the rest of
the chrome and invisible until asked for, squares laid over the element with
neighbours a beat apart, an id this frame does not hold drawing nothing rather
than erroring (every artboard hears the same broadcast), and the grid stopping
when the turn ends. The badge's size is style, and untested as such.

## The canvas comes back with the project (2026-08-31)

Reported: *"every time I open the project I have to reopen the canvas"*. True,
and by design — the pages row started empty every time, because each artboard
runs the user's real app (their dev server, their auth guards, their data
fetching) and dedup does not boot one on a hunch. But the hunch was never the
problem. The user already answered the question yesterday; asking again every
morning is the same guess from the other side, and it cost three clicks before
any work started.

**What is remembered** (`lib/canvasMemory.ts`, per project, localStorage —
same shape as `openPrefs` and the per-project scan/chat state): the open
routes in canvas order, which artboard the scan was pointed at, and the
per-artboard choices that ride on the frame URL — session mode, hold, offline.
Not `frameOrigins`: that is the automatic guest-origin fallback's verdict about
a dev-server run that is over, so the next run starts every frame on the shared
session and lets the fallback decide again with fresh evidence. Not zoom or
pan either — the restore lands the canvas on the artboard that was selected,
which is a better answer than the pixel offset it was left at.

**When it is restored.** `enterEditor` loads it into `pendingCanvas` (module
scope, deliberately not store state — nothing renders it), where it waits for
a dev server to mount it against; `setDevReady` **consumes** it. That is the
whole reason it is consumed rather than read: a dev-server *restart* mid-
session still clears the pages row, which is the settled decision that dedup
does not silently reload three frames of a running app. Reopening the project
is the exception, and it is the only one.

**When it is written.** From each gesture that changes the row —
`visitRoute`, `closeRoute`, `focusRoute`, `setSelectedRoute`, `setSessionMode`,
`toggleHold`, `toggleOffline` — rather than from a subscription on the store.
A subscription would also have caught the restart's clear and dutifully
remembered an empty canvas, erasing the thing this exists to keep. Dropping a
project from the launch screen forgets its canvas along with its verdict:
nothing about a forgotten project should outlive it.

Everything read back is re-validated. It is dedup's own blob, but it is also
the only state that survives to point iframes at URLs: a route must be a path
(no origin, no scheme, no protocol-relative `//host` that a URL join would
read as one), the row is capped at the same `MAX_ARTBOARDS` the canvas
mounts, and a mode, hold or selection keyed to an artboard that did not come
back is dropped rather than restored as a stale choice.

**Tests:** `pnpm test:canvas` (13, new) — the round trip, per-project
isolation, forgetting one project leaving the others alone, an empty row
restoring an empty canvas rather than a guess, a corrupt entry costing one
empty canvas and never a project that will not open, and the refusals: a
non-path route, a duplicate, a row over the cap, an unknown session mode, and
every choice keyed to an artboard that is no longer open.

## Verification inventory

- `cargo test` (src-tauri): 90 — URL/ANSI parsing, project detection,
  instrumentation, tunnel (real TLS upstream, IPv6-only), sidecar (real node
  spawn E2E incl. the full-file parse gate and an edit program that is
  all-or-nothing; the chat agent's multi-file write landing whole or not at
  all, with the valid file in a refused set left untouched and a new file
  created only on success; discarding a preview restoring the tree exactly,
  including content that never parsed; new-file paths resolving only inside
  the project; and the agent's list/grep skipping the user's node_modules),
  git branch/commit isolation (incl. committing a file that did not exist
  before, and an ignored new file refused with its reason), Next stale-lock parsing, scan
  persist/restore round-trip, Claude Code result-envelope parsing, thumbnail
  key stability, toolchain PATH resolution (enriched PATH is dead-entry-free,
  `which` resolves node; the node-spawning suites also pass under a simulated
  launchd env), mock-session seed persistence, the auth-context scanner
  (storage+auth-word files only — a theme toggle and a bare fetch are both
  ignored), and auth-SDK detection incl. whether a seed can reach that SDK's
  session (Firebase not seedable, Supabase seedable, NextAuth not read as
  plain Next, no SDK → falls back to the file scan).
- `pnpm test:plugin`: 49 — tagger transform (ordinal ids stable across
  reformatting, dynamic/core marking, fragments, generics, sourcemaps,
  virtual-export + unsafe-name rejection); write-back program E2E via child
  process (inspect incl. capabilities, class/text/insert/remove/move, moves
  that carry nested edits and expand self-closing targets, every refusal path
  writing nothing, full-file replace); and the cross-bundle invariant that the
  tagger and the write-back resolve every ordinal to the same element; and
  the injected boot script, exercised by *running* it against a stand-in page:
  no/disabled/empty seed serves valid no-op JS, an active seed is gated to
  framed pages (asserted both ways), a throwing seed warns instead of breaking
  the page's boot, the hold arms only when flagged, queues long timers
  while letting short ones through, freezes navigation, keeps a cleared timer
  cleared, and hands timers and history back intact on release; and the
  offline cut arms only when flagged and only inside the canvas, installs
  without throwing on a page missing any request API, fails the app's requests
  (with the real failure shapes) while the dev server's still go out, kills a
  socket but not Vite's HMR one, and composes with the hold rather than being
  silently skipped by its early return.
- `pnpm test:actions`: 12 — staged program → write-back ops: palette snippets
  round-trip through the rewriters, values that would break out of the markup
  refused, text/classes typed into a staged insert folded into its snippet
  (newest wins), edits on real elements kept as their own ops in order, an
  unfoldable or orphaned edit reported rather than silently dropped, and a
  copied section written in the language it was copied from — verbatim into a
  file of the same kind, refused in both crossing directions. Plus a pasted
  element restyled in its own spelling rather than JSX's, and discarding an
  insert taking with it the edits that were addressed to it (an orphan is a
  permanent save failure, so that rule is what keeps a staged program
  escapable).
- `pnpm test:overlay`: 28 — the built overlay evaluated in a stub DOM: it loads
  and announces itself (the guard against a throw killing every listener after
  it), click → selection payload with markers and ancestry, click on an
  untagged child resolving to its tagged ancestor, browse mode passing clicks
  through, a staged class patch applied then rolled back, structural ops
  applied and fully reverted, a staged insert placed, addressable by its
  provisional id and withdrawn, double-click asking permission before a
  caret goes anywhere (with Escape restoring the original text), the layer
  tree reported nested/labeled with untagged wrappers transparent, a staged
  insert appearing in that tree marked `staged`, `hover-id`
  drawing/clearing the hover chrome without a pointer, `reload`
  refreshing in place but reloading *at* a pinned route when given one (how a
  newly enabled mock session reaches a frame bounced to /login), and page
  console forwarding (an SDK error reaches the editor with objects
  serialized, the page's own console still fires, a cyclic argument doesn't
  throw), a copied subtree's markup reported with every `data-dedup-` stamp
  stripped (a frame that doesn't hold the element stays quiet), two inserts
  at one anchor previewing in the order the save will write them, and the
  AI-working grid (mounted but invisible until asked for, squares over the
  element with neighbours a beat apart, silent for an id the frame doesn't
  hold, and cleared when the turn ends).
- `pnpm test:scan`: 10 — scan bundle E2E via child process: near-dup clustering
  + unrelated separation, canvas-scope filtering (project-wide call sites),
  knob-value equivalence, trivial-component exclusion, node_modules/garbage
  resilience, memo/forwardRef, progress stream, gallery filter (structural +
  interactive; text/icons/app-shells excluded), gallery cluster-id + schema.
- `pnpm test:tw`: 16 — class⇄knob mapping, spacing precedence + regeneration,
  swatch colour resolution (palette vars, arbitrary values, refusals),
  `mergeClasses` conflict resolution incl. independent background properties.
- `pnpm test:errors`: 5 — dev-server stream → build errors: chatter ignored,
  detail lines folded into one error, cleared by a successful compile,
  repeats deduped, ANSI stripped.
- `pnpm test:origins`: 8 — which session a page artboard renders under: the
  default, the redirect fallback moving one frame only, an explicit choice
  beating the fallback in both directions, a signed-out and a signed-in
  artboard live at once, graceful degrade with no alternate origin, and null
  before the dev server is up; plus the hold flag's URL handling and the
  cross-bundle invariant that the editor and the tagger spell it the same.
- `pnpm test:highlight`: 11 — the code panel's syntax colouring, with the
  load-bearing invariant first: every character survives tokenizing exactly
  once (the tokens are painted *behind* a transparent textarea, so a dropped
  character moves the caret away from what the user is typing). Plus strings,
  templates and comments as single tokens, an escaped quote not ending a
  string, an unterminated quote stopping at its line rather than painting the
  rest of the file, comment markers inside strings and vice versa, keywords vs
  identifiers that merely start with one, JSX tag names, and a `<` that isn't
  a tag.
- `pnpm test:canvas`: 13 — the canvas a project reopens with: the round trip,
  per-project isolation, an empty or corrupt entry restoring an empty canvas,
  and the validation every restored row goes through (paths only, no
  duplicates, capped at what the canvas mounts, and no mode, hold or selection
  keyed to an artboard that did not come back).
- `pnpm test:prompts`: 6 — the chat composer's ↑/↓ prompt history: the list it
  walks (newest first, consecutive repeats collapsed but distant ones kept),
  both directions, the swallowed ↑ at the oldest entry, an interrupted draft
  handed back intact, and every case where the arrow keys belong to the caret
  rather than to the history.
- `pnpm test:chat`: 21 — the chat agent's reply protocol. Edit-block
  parse/apply (single/multi block, deletion, non-match + ambiguous + malformed
  all throw — no half-applies, full-file fallback, prose passthrough); the
  agent half (tool lines read as a context request not an edit, `list` with no
  argument and a bare `read` ignored, an edit reply winning over stray tool
  lines, file-addressed blocks assembled into a multi-file program, an
  unaddressed block falling back to the file in play); and four refusals —
  editing a file the model never read, overwriting an existing file with
  CREATE, a CREATE with no path or no terminator, and a fenced snippet with no
  SUMMARY staying an *answer* rather than becoming a whole-file rewrite that
  would blank the module. Plus the ASSET block an agent uses to hand over an
  image it generated: parsed alongside the markup that references it, valid on
  its own, and four malformed shapes throwing rather than importing a guess
  (the copy's own gates are in `cargo test`).
- `pnpm test:merge`: 18 — the merge codemod against the built bundle: a plan
  reporting sources/props/call sites; a same-named component from a library
  *not* counted as a call site (the trap a name-based codemod falls into); call
  sites reached through a tsconfig alias; behaviour differences surfaced and
  identical behaviour left unflagged; a dry run producing the whole diff and
  writing nothing; an apply that rewrites call sites, fixes imports and stages
  the retired file; merging into a new file; a name collision aliasing the
  import instead of shadowing a library's `Card`; a default-exported member
  rewritten through its default import; a shared file left in place with a
  reason rather than gutted; and six refusals that each write nothing — source
  that doesn't parse, a missing export, dropped exports on the canonical file,
  a re-exporting barrel, a member that moved, and a prop value that would break
  out of its JSX attribute. Plus the trash lifecycle.
- `pnpm test:proposal`: 21 — the frontend half of the merge. The model-reply
  parser (a well-formed proposal; a forgotten member, a source that never
  mentions the promised name, a path escaping the project, a prop value that
  would break out of the JSX, and a non-scalar prop all refused); the review
  diff (an unchanged file has no hunks, a changed line carries both line
  numbers, distant changes stay in separate hunks with nothing elided, created
  and retired files, and a realistic import swap); the gate rules (a failed
  gate blocks and a skipped one does not, the summary never hides a skip, no
  dev server means *skipped* rather than passed); and the visual signal
  (confidence untouched with no pass or no renders, a disagreement pulling it
  down and saying so, an unrenderable member reported rather than averaged).
- Manual E2E: wrapper config against a real Vite app (tags + overlay + harness
  served); Claude Code CLI envelope round-trip; dogfooded on mintWash.
- Manual: the whole editor chrome was driven in a browser against a stub
  Tauri bridge during the floating-canvas redesign — top bar, both panels,
  toolbar, console, the Components gallery, the merge review with a full
  proposal + diff, and the history panel.
- Not yet auto-covered: in-app artboard render, AI categorization/mock-props
  end-to-end and the merge *proposal* call itself (all need a live backend),
  the canvas navigation and editing gestures (drag-to-reparent, drop
  indicators, click-to-insert) — no browser in the test path, though their
  write-back half is covered — the visual pass's capture half (needs a real
  webview; its comparison and hashing halves are unit-tested), and the Next.js
  webpack loader against a real Next build (the transform it calls is the same
  one 38 tagger tests cover).

---

## Addendum — inline duplicate detection (FR-5.10, detector landed 2026-08-31)

The scan's unit of comparison is a *named component's whole tree*. That makes
the most common form of UI duplication invisible to it by construction: markup
that was never a component at all — the same styled `<button>` pasted into
twelve pages. It is three nodes buried inside each page's tree, and no signal
the scan has ever compares it to its twin.

`plugin-src/extract.mjs` is the second detector: same deterministic contract,
different unit. It finds repeated JSX **subtrees**, and reports exactly what
varies between the copies.

**Why it is a separate sidecar, not a mode of the scan.** Different unit,
different algorithm (shape hashing, not O(n²) tree edit distance), and a
different codemod on the other end — the merge *retags existing call sites*,
while extraction has no call sites and must replace an arbitrary source range
with a new element plus an import. Sharing the entry point would have meant one
command with two unrelated halves.

**What the two detectors must agree on, and where that lives.**
`plugin-src/jsxfacts.mjs` now holds the facts both read off a node — tag name,
static class tokens — and the arithmetic both score with — `knobOf`, `jaccard`,
`djb2`. Forked, the same button would be a duplicate to one tab and not to the
other, and the user would be told two different things about one element (the
rule `jsxwalk.mjs` already holds for ids). It is its own module rather than an
export of `scan.mjs` because **each detector is bundled as its own sidecar and
both bundles end with an `isMainModule` stdin loop** — importing one from the
other inlines that loop into the wrong bundle, where it *is* main, and two
handlers then answer one request on one stdout.

**The rules, each with a test in `pnpm test:extract`:**

- **Shape is exact, classes are fuzzy.** Bucket by structural shape
  (`tag(child,child)`), then group within a bucket by the scan's own class
  blend (0.6 knob + 0.4 token) at 0.75 — tighter than the scan's 0.8, because
  these are supposed to be literal pastes and the shape already matched. The
  exactness pays for itself twice: it collapses the space so the pairwise pass
  only ever runs inside a bucket, and it means every occurrence's pre-order
  node list **lines up index for index**, so "what varies" is a column-wise
  comparison rather than a diff.
- **Weight, not size, is the floor.** `elements + class tokens + attributes`
  ≥ 5. `<div className="flex">` is not a component waiting to happen however
  often it appears; weight rises with how much *decision* the markup carries.
- **A capitalized root is not markup.** `<Button …>` repeated is usage, not
  duplication — that is the scan's business, or nobody's.
- **Layout knobs stay at the call site.** `LAYOUT_KNOBS` in `jsxfacts.mjs` is
  the rule that decides whether the output is trustworthy: two buttons that
  differ in `bg-blue-600` vs `bg-red-600` differ in what they *are*, and that
  is a variant; two that differ in `mt-4` differ in where they were *put*, and
  baking that into a shared component makes it fight every later use. Written
  down and tested rather than left to the model's taste.
- **The outer candidate claims its range.** Groups are accepted in value order
  (`occurrences × weight`) and claim source ranges as they go, so a card and
  the button inside it don't both get extracted into overlapping edits.
- **A copy dedup can't describe is reported, not dropped.** A spread attribute
  makes the prop signature unknowable and a computed `className` makes the
  classes unreadable; both refuse the *occurrence* and say why, listed
  alongside the group it would have joined.
- **The best answer is "you already have this."** When one occurrence is a
  component's entire body, `existing` names it — the canonical component the
  user is looking for already exists and everything else should point at it.

**Dogfooded on dedup's own frontend** (26 files, 483ms): 7 candidates. The top
one is a primary button written out **10 times across 10 files**, and the
finding is not that they are duplicated but that they have *drifted* —
`rounded`/`rounded-md`/`rounded-lg`, `px-2`/`px-2.5`/`px-3`,
`py-0.5`/`py-1`/`py-1.5`, `disabled:opacity-40`/`-50`/`-60`, and one that lost
`font-medium` entirely. Second is a secondary button, 9 copies across 6 files,
drifting the same way. That drift is the argument for the feature: nobody
chose those differences.

**The open question the dogfood raised, which the proposal half has to answer.**
When copies have drifted, is `px-2` vs `px-3` (a) noise to be normalized onto
one canonical value, or (b) a real `size` variant? (a) is almost always what
was meant and is the whole consistency win — but it *changes pixels*, so the
FR-5.6 visual regression gate will correctly flag it, and for extraction that
gate cannot simply be "nothing moved". (b) is safe and produces three variants
of what should be one button. Not yet decided; it changes the prompt, the
codemod and the gate.

**The Drift tab (landed 2026-09-01).** `extract.rs` runs the sidecar exactly
as `scan.rs` runs its own — progress relayed as `drift://progress`, last JSON
line kept, result persisted under `sidecar::support_dir` (not a hardcoded
`node_modules/.dedup`, which `scan.rs` predates the rule for).
`components/Drift.tsx` is the fourth sidebar tab.

It is **read-only on purpose**, and that is the design, not a shortfall: the
detector is deterministic and the extraction codemod does not exist, so the tab
shows evidence and jumps to source rather than offering a fix it cannot land —
the same rule the merge gates follow. There is no Fix button and the absence is
the honest answer to why.

The one thing the tab must communicate is the *drift*, not the repetition. A
row saying "15 copies" would be a lint rule; the per-knob **value spread with
counts** (`px-3 ×11  px-4 ×4`) is the part no one can see by reading the code.
Layout knobs are marked with a `*` and a footnote, because the whole
trustworthiness of a future extraction rests on that distinction being visible
before anyone acts on it. A copy that sets no value for a knob shows `—` as a
real value: "three of these have no hover state at all" is a finding, not a
gap in the data.

**Drift is deliberately not artboard-scoped**, which is the one place it
departs from the scan's shape. The scan needs a selected artboard because its
output is *rendered previews of what is on that page*. Drift's finding is by
definition cross-file — "the same button in nine files" cannot be seen one page
at a time — so scoping it to a page turns a true finding into a much smaller
false one. Measured on the Harbor demo project: whole-project finds 5
candidates including a button repeated 15 times across 9 files; scoped to a
single artboard the same run finds 1. The sidecar still accepts a file list;
nothing in the app has a reason to pass one.

**The drift view is a canvas, not a list** (2026-09-01). Clicking a candidate
renders every copy of it together on a pan/zoom surface with the same gesture
vocabulary as the artboard canvas — because a list of `file:line` is a lint
rule and ESLint could print it, while fifteen buttons side by side, three
visibly a different size and one visibly a lighter weight, is the finding no
one can get from reading code. That is the reason a duplicate-finder runs the
user's app at all.

The copies cannot use the component harness, which imports a module and mounts
an export: a drift occurrence has neither. It has markup, so `extract.mjs`
emits a static preview per occurrence from the tree it already parsed, and the
tagger's new `/__dedup/snippet` route drops that markup into a page carrying
the project's own stylesheets — real Tailwind, real pixels, nothing to import.
It is a picture rather than a translation: handlers and computed values are
dropped rather than approximated, because a preview that invented an `href` or
a `disabled` state would be lying about the very thing the user is judging. A
component child renders as an empty box wearing its own classes, which is
enough for its sizing to hold the layout together.

`lib/panZoom.ts` holds the gesture arithmetic for both surfaces. Two canvas-like
views that anchored zoom differently, or clamped at different points, would
feel like two different applications; `Canvas.tsx` delegates to it too, and
`test:drift` pins the cursor-anchoring invariant. Each surface keeps its *own*
transform, though: switching tabs is a change of scene, not of viewport, and
carrying the canvas's pan into the drift view would open it on empty space
thousands of pixels from any card.

Selecting is the interaction, because the tool's job is evidence and the user's
is the decision. Opening a candidate selects every copy — "these are all the
same thing" is the common case, and deselecting the odd one out beats picking
fifteen — and the proposal is built from the selection, so the variance columns
the model is shown follow what the user kept rather than what the detector
found. A click that moved more than 4px is a pan that began on a card, not a
selection (the rule the canvas already uses for click-to-deselect).

`lib/driftProposal.ts` is the model boundary, shaped like `mergeProposal.ts`
and strict for the same reason: nothing on this path writes to the project, but
a proposal the user cannot trust is worse than none. It carries one rule the
merge does not need, and it is the whole point of the feature — when copies
have drifted, the model must pick one canonical value rather than preserve the
spread as variants. Fifteen buttons with three paddings are not three sizes;
they are one button and two accidents. Layout knobs are the exception, and the
detector has already marked them. **Apply is present and disabled with its
reason**: the extraction codemod does not exist, and offering an edit that
cannot land safely is the one thing the merge gates have never done.

**Three kinds of varying value, not two** (2026-09-02, from a real failure).
Asked to combine a badge that had three tones — neutral, success, warning —
the model returned one emerald pill, silently deleting a distinction the UI was
carrying. Two causes, both in the prompt:

- The detector knew `bg-color` was a colour and never said so. `knobOf` already
  names every colour utility `*-color`, so `isColourKnob` reads the detector's
  own classification rather than inventing a second one, and colour knobs are
  now marked **SEMANTIC** the way position knobs are marked **LAYOUT**. Only
  *unprefixed* colours qualify: a `hover:` colour some copies have and others
  don't is a missing state — ordinary drift — and marking it semantic would
  invite the model to turn "three of these forgot a hover" into a prop.
- **Co-variance was invisible.** `bg-color` and `text-color` partitioned the
  seven copies identically — slate/slate, emerald/emerald, amber/amber — and
  were shown as two unrelated rows next to an instruction to normalise. Nobody
  drifts two knobs into perfect agreement three times over; that pattern is a
  set of named states somebody wrote on purpose, and it is the strongest
  evidence of meaning the detector has. `covaryingGroups` reports them as one
  decision with its members and their counts. Two guards keep it honest: a knob
  with a distinct value in *every* copy partitions nothing (fifteen labels are
  not fifteen variants), and co-variance is computed over the user's selection,
  because two knobs can agree across all the copies and disagree across the
  four that were kept.

So a varying value is now drift (pick one canonical value), LAYOUT (stays at
the call site), or SEMANTIC (becomes a variant named for what it means, never
for the colour). The prompt says which, per knob, rather than leaving the model
to infer it.

**Not yet built:** the extraction codemod (replace each range with `<Name …>`, add the import, reusing
`renderProps` / `importAnchor` / `takenNames` collision-aliasing from
`merge.mjs`, all-or-nothing across files).

**Two gaps found while building the demo, neither fixed:**

- **The weight floor swallows the very copies the refusal exists to report.**
  Weight counts *static* class tokens, so an element whose classes are all
  computed (`cn(…)`) scores near zero and is filtered out before it can reach
  the `dynamicClass` refusal. The refusal therefore only fires for an element
  that has some static classes *and* a dynamic one. Harbor's Orders filter
  buttons are invisible for exactly this reason. Fixing it means giving a
  dynamic `className` nominal weight — but a dynamic element has empty token
  and knob sets, so `classSimilarity` returns 1 against *anything* of the same
  shape, and it would join an arbitrary group. Both halves need doing together.
- **Structurally identical SVG icons cluster as duplicates** in the component
  scan (`svg(path,path)` twice is a 1.0 match with no classes to separate
  them). Harbor's icons were deliberately given distinct child shapes so the
  demo doesn't show it. On a real codebase it will.

---

## Interlude — canvas markup (2026-09-02)

The annotate tool: hand-drawn marks over the page artboards, drawn with
[rough.js](https://roughjs.com), each with an optional note. `A` arms it, or
the pencil in the toolbar; circle / box / arrow / freehand, four ink colours.

**Why a sketch library rather than four `<path>`s.** A machine-perfect
rectangle drawn over a machine-perfect UI reads as part of the UI. A wobbly one
reads as somebody's pen. The whole job of this layer is to be visibly *not*
the app, on top of the app — which is the same reason dedup renders the app at
all rather than printing file:line.

**Where it is not.** Not in `overlay.js`. The overlay is a single IIFE injected
into the user's project, where anything that throws while it evaluates kills
every listener after it — and marks are dedup's chrome, not the user's page, so
nothing about them needs to be inside the frame. `AnnotationLayer` is one
layer *above* the iframes instead. It is inert (`pointer-events: none`) in
every tool but its own, and while armed it covers the frames completely, which
is also why entering the tool clears the selection: resize grips drawn over an
element no gesture can reach are a lie about what is interactive.

**Two rules that only show up on screen**, both in `lib/annotate.ts`:

- **Every mark stores its rough seed.** rough re-randomises per call, so a
  shape regenerated on a pan or any React re-render is a *different* shape —
  ink that crawls while you scroll. With the seed stored, geometry is a pure
  function of the annotation, generated once and memoised. `test:annotate`
  pins both directions (same seed → same path data, different seed → not).
- **Geometry is generated once at artboard scale; the nib is held to a
  constant screen width by `vector-effect: non-scaling-stroke`.** Regenerating
  per zoom step would be slower *and* worse — the wobble would breathe while
  you pinch. This is deliberately the opposite of the rule overlay chrome
  follows (screen pixels, because it is chrome): a mark belongs to the page it
  was drawn on. Note chips are the exception that proves it — they are chrome,
  so they are positioned in screen space at a fixed size.

**Marks belong to a route, not to a spot on the canvas.** Coordinates are
artboard-local and stored per project (`dedup:marks:<root>`), re-validated on
load exactly as the remembered canvas is: a NaN in a point is a path attribute
that silently draws nothing, and a route that isn't a path is a stale choice.

**Notes are chat context, in the same sense a selection is.** `annotationNotes`
sends the words the user wrote, on pages that are currently open, and says in
the prompt that dedup does *not* know which element each mark covers —
resolving that lives inside the frame, and the overlay is not asked. A mark
with no note sends nothing: a pointer with no words is not context.

Nothing here touches the user's source. The gesture hint says so, because that
is the question a tool that draws on your running app raises.

## Both agents in one chat: `@claude`, `@codex`, and an image on request (2026-10-24)

Both agents could already be connected at once — each Connect is its own
consent — but one global `aiPref` decided every message, and connecting one
made it the default. Using both meant flipping the top-bar switch back and
forth. Two changes, at the two places that decision was actually being made.

**Who answers is a property of the message.** `@claude` / `@codex` anywhere in
a prompt sends *that* message to that agent; with no mention the top-bar
default answers, as before. `lib/mentions.ts` is the rule, pure and pinned by
`pnpm test:mentions` (17):

- A mention is `@alias` at the start or after whitespace, ending at
  whitespace, the end or sentence punctuation. `@radix-ui/react-icons` and
  `me@codex.dev` are not mentions — a chat about code names both, and
  mis-routing on them would be a real failure. Aliases come from `CLI_AGENTS`
  (id + command), so a third agent is mentionable by being a row there.
- Only the **first** mention routes, and only it is taken out of the prompt.
  "@claude, ask @codex for a hero image" is a sentence, and the second mention
  is part of it. The transcript keeps what the user typed.
- A mention of an agent that isn't connected is answered by an error naming
  it, never handed quietly to the default — that would be the silent backend
  the AI switch exists to rule out.
- The composer's `@` popup takes ↑/↓/Enter/Tab/Escape *before* prompt history
  and Send do, and only while it is open: otherwise Enter would send a
  half-typed `@co`. It opens upward, because the composer is at the bottom.

Every assistant message now records `agent`. The bubble shows it, and the next
turn's transcript labels a reply some *other* agent wrote as such rather than
handing it over as "You:" — a model defending a choice it never made is worse
at the follow-up than one that knows a colleague made it.

**Claude can ask Codex for an image.** A fifth marker, offered only to a
backend that cannot generate images itself, and only while a connected agent
can (`generatesAssets` — the same honesty rule the ASSET directive follows):

    <<<<<<< IMAGE public/hero.png
    a description of the picture
    >>>>>>> END

**It names no source path, so it widens nothing.** dedup sends the description
to Codex with a strict prompt (`imageRequestPrompt`) and reads the answer with
`pickGeneratedImage`, which takes exactly one ASSET block and refuses prose,
two images, or any edit riding along — a second agent writing source the user
asked a different agent about is not something anyone reviewed. The path Codex
returns then goes through `asset.rs` as **Codex's** output (its own
`asset_dir`), exactly as if the user had asked Codex directly; the destination
is the requester's, because that is where its markup already points. Imports
now carry their agent, so the gate is chosen per file rather than per turn.

Ordering, because generating is the slow part: every cheap refusal (write and
import of the same path, nothing to change, staged style edits in the way) runs
on destinations *before* Codex is asked. After that a delegated image rides the
proposal lifecycle unchanged — imported before the text write, previewed
uncommitted, committed by Keep, removed by Discard. `chatActivity` puts
"Codex is generating public/hero.png…" in the working bubble, because a minute
of bare "Working…" reads as a hang.

**Tests:** `pnpm test:mentions` (17, new). `pnpm test:chat` (28, +7): an IMAGE
block beside the markup using it, one on its own, three malformed shapes
throwing, the picker taking one path and refusing four other answers, the
request prompt being answerable by its own picker, and the prompt offering
IMAGE only to a non-generator with a generator connected — and never ASSET
alongside it.

**Not verified end to end:** a real Claude → Codex image round trip in the
running app. The parsing, the picker and the gate are each tested; the live
hand-off between two signed-in CLIs is the part a test here cannot reach.

## The AI menu becomes switches, and Codex gets a model picker (2026-10-24)

With `@` routing, "Use this" was asking the wrong question — nothing needs to
be *the* backend when a message can name one. Each backend now has an on/off
switch (`AgentState.enabled`, persisted; the API key has `apiEnabled`).
Switching an agent on for the first time is Connect — the live test prompt —
and lands on only if it passes; switching off keeps consent, so on again is
instant. A message with no mention, and everything outside the chat (scan
organizing, merges, the session seed), goes to the first one on in CLI_AGENTS
order, then the API key; the menu marks it "default". Fixed order rather than
last-used, so that label is stable. The old single `dedup:ai-pref` carries
over: the backend it named is the one that starts on, and nothing else is
switched on behind the user's back. `agentOn` (`lib/types.ts`) is the one
rule for "may this be sent to", shared by the store and the composer.

**Codex's models come from Codex.** `ai::models` runs `codex debug models` and
keeps the entries its own picker lists (`visibility: "list"`), in its
`priority` order. Not a list in dedup, because of the failure that prompted
it: the ChatGPT app updated its bundled Codex and wrote a new default model
into the shared `~/.codex/config.toml`, and the older standalone CLI dedup
runs refused it. The catalog is per-binary, so the picker only offers names
the copy dedup actually runs knows. A saved model neither list contains stays
visible as "(saved)" instead of the select silently showing the default.

`cargo test` (102, +1): the catalog parse — hidden entries dropped, priority
order, a blank display name falling back to the slug, one row per slug.

## Fix — a delegated image refused for being a PNG (2026-10-24)

The first real Claude → Codex hand-off got all the way to the import gate:
Claude asked for `images/hero-container-lift.jpg`, Codex generated it, and the
gate refused it — "that image is a PNG, but the AI asked to save it as …jpg".
The gate was right that a name must agree with its bytes, and wrong about whose
mistake it was: an IMAGE request names its destination *before* the image
exists, and the generating agent decides the format (every one of the 152 files
in `~/.codex/generated_images` is a PNG).

Two layers. The IMAGE directive now says generated images arrive as PNG and to
name the destination `.png`. And for a delegated import only, `asset::import`
takes `adapt_extension`: a disagreeing extension is corrected (`.jpg` → `.png`)
rather than refused, and the result says where the file landed. Every other
gate is untouched — a non-image is still refused, and the *corrected* name is
the one checked for already existing. A direct ASSET import, where the agent
that made the file also named it, stays strict.

The requester's markup still says `.jpg`, so `retargetReferences` renames the
references the edit added — matched on the file name with path-character
boundaries, so `big-hero.jpg` and `hero.jpg.bak` are left alone. A file whose
*before* contents already mentioned the name is refused rather than renamed:
the image didn't exist until now, so that reference is the user's, about
something else. The renamed text is what the preview writes and what Discard
reverts, and the proposal's file list shows the real name.

Also fixed: that refusal message had a run of spaces in the middle of it — a
line break inside a Rust string literal, written without its `\`.

`cargo test` (103, +1): a delegated PNG named `.jpg` lands as `.png`, a
non-image is still refused, the corrected name is the one checked for
collisions. `pnpm test:chat` (32, +4): references renamed in the edit's markup,
every spelling of the path (`./`, `/`, `url()`, `srcset`) caught and a longer
name not, a pre-existing mention refused, untouched and new files handled.

## No git: set one up, or save in place after a warning (2026-10-24)

Opened a static site with no repository, a chat edit previewed fine and Keep
failed: "This project is not a git repository — dedup requires git to save."
Two things were wrong. The preview path never asked about git, so an AI edit
went onto disk that Keep could never commit. And worse, found while tracing
it: `saveAll` and `saveCode` write first and commit second, so in a folder
with no git a style or code save *landed*, then reported a save error, and
left the edit staged — a second ⌘S could apply it twice.

**"Set up git"** (top bar, chat panel, and the warning below):
`git::init_baseline` runs `git init -b main` and commits the folder's files as
"Baseline before dedup edits". It refuses a folder already inside a repository
(a parent's included — that history is the user's), and if the commit fails —
usually no git identity, which it names with the two commands to fix — it
removes the `.git` it just created, so the folder is left exactly as found.
With a chat preview on disk, the preview is set aside for the baseline and put
back after, images re-imported from the agent's directory through the same
gates: the first commit in a new history never contains an AI edit nobody
accepted. The proposal is then Keep-able as normal.

**Or save in place, after being told.** The owner's call: a folder with no git
is still theirs to edit. Every save path — chat Keep, ⌘S, the code panel —
goes through `needsDirectWriteWarning` *before* writing anything: the first
time in a session it raises `DirectWritePrompt`, which lists the files and
says there is no branch to put the change on and no commit to undo it, with
"Replace files", "Set up git" and Cancel. Confirmed, `commitOrDirect` skips
the commit; the top bar says "Saved in place" and the transcript "kept ·
written into the files (no git)" instead of showing a hash that doesn't exist.
**Merges are the exception** and still require git: their gates undo a failed
merge by restoring the commit, so in place a failed merge would stay applied.

Also learnt the hard way: a pending preview's `before` snapshots live only in
memory, and a tauri-dev hot restart (an `src-tauri/` edit) kills the app hard.
Editing Rust mid-session left the user's hero-image preview on disk with dedup
no longer knowing it was one. Recovered by un-stamping a copy of the page the
static server had served earlier — `data-dedup-*` attributes and the injected
scripts removed — which came back byte-identical to the original (36,742
bytes), making the AI's three-line change exactly visible.

`cargo test` (105, +2): a plain folder becomes a repo whose one commit is its
files, clean, on `main`, and can then make a session branch; a second call and
a folder inside another repository are both refused.

Not covered by an automated test: the prompt flow itself (store + modal), and
setting git up with a live preview, which needs a running app.

## Export an artboard as PNG or PDF (2026-10-24)

Each artboard label has a hover export button (beside close): PNG at 1x, PNG
@2x, or PDF, then a save dialog, then a notice with the size and "Show in
Finder". The PDF is vector — one page as tall as the artboard, real selectable
text (Arabic included, on the page it was tried on).

**A render, not a crop.** The existing capture (`thumbs::snapshot_png`)
rasterises a region of the app window: whatever zoom the canvas is at, cut off
at the window edge, with any floating panel in the picture. `export.rs` instead
loads the artboard's URL into a throwaway `WKWebView` exactly the artboard's
size, in a borderless window at alpha 0 placed 40,000pt off-screen, and asks
WebKit for `takeSnapshot` or `createPDF`. Three details, each found by a
throwaway Swift probe before any app code was written:

- The window must be on the window list (`orderFrontRegardless`) — WebKit does
  not paint an ordered-out view — and borderless, because a titled window is
  clamped to the screen and a 1440×6400 page is taller than any screen.
- `takeSnapshot`'s width is in points and comes back at the backing scale:
  asking for "2x" on a retina screen produced 4x (5760×25600).
  `snapshot_width_pt` divides it back out.
- The page is loaded inside an iframe, because the boot script (seed,
  offline, hold) only runs framed. The view shares the canvas's
  `WKWebsiteDataStore`, so a real sign-in applies too.

URL and size come from two helpers the canvas now uses as well — `artboardUrl`
(lib/origins) and `artboardHeight` (lib/types) — so an export cannot render a
different session or a different height than the artboard on screen. One
export at a time; the window is torn down on every path out. Staged edits are
not included (they are an overlay preview, not file contents) and the notice
says so. PNG refuses past 32,000px a side with a message pointing at 1x or PDF,
which has no limit.

`cargo test` (108, +3): the wrapper frames the URL at the artboard's size with
the URL escaped for its attribute, the points-vs-pixels arithmetic, and the
up-front refusals. `pnpm test:origins` (10, +2): `artboardUrl` equals what the
canvas built inline for every session and flag combination, and the height rule.

**Not verified in the running app:** the export path itself — the native code
mirrors the probe (which produced a correct full-page PNG and a vector PDF of
shipnsecure) but has not been clicked through.

## Drag an element off its artboard — park it, or move it to another page (2026-10-25)

Figma lets a layer leave its frame. A codebase has no "outside" — every element
lives in a file, and only pages render — so the question was what an element
dropped on the empty canvas *is*. The owner's answer: it is **parked**. It
leaves its page (a staged removal, saved like any other) and dedup keeps it as a
card where it was dropped, until it is dragged into an artboard or deleted.

Three gestures, one set of rules:
- **Off the page onto the canvas → parked.** A staged removal plus a
  `ParkedPiece` holding what a paste writes (`captureClip`, the same capture ⌘C
  makes — source from the file, markup from the page) and a picture for the
  card (`snapshot_region`, taken while the element is still on screen).
- **Off one page into another → moved.** A paste at the probed slot, then the
  removal, as one gesture with one undo step. Paste first, because it is the
  half with refusals of its own (another language, an anchor on its way out);
  if the removal is then refused, the paste is taken back.
- **A card into a page → placed.** A paste of what the card holds.
All three go through `stagePaste` / `stageRemoval`, split out of ⌘V and ⌫, so a
parked or moved element obeys exactly what a paste does: same-language only,
missing names said out loud, an anchor being deleted refused.

**Lifecycle rides the staged program, not a parallel one** (`lib/parking.ts`):
undo the removal and the piece is gone (it is back in its page); undo a
placement and the card comes back; a save turns pending removals into settled
pieces and finishes placed ones. Save settles in the *same* state update that
empties the program — afterwards, the reconcile would see no removals and throw
away what is now the only copy. `test:parking` pins that ordering explicitly.

**Kept where nothing routine can lose it.** Settled pieces are written to the
app's data directory (`parking.rs`, atomic rename), not `node_modules/.dedup`
(a reinstall wipes it) and not a cache dir (the OS may purge it). Writes wait
until the project's pieces have been read back, or an early save would write
`[]` over them.

**The overlay.** It now captures the pointer when a drag starts, so it keeps
hearing it past the frame's edge; out there it posts `drag-outside` (with the
element's id and label, for the editor's ghost) and finishes with
`drop-outside` — never also an in-page `drop`. Other pages are *probed*: the
editor sends the point in that page's own coordinates (`probe-drop`), that
overlay answers with the slot its own `dropTargetAt` picks and draws it, so a
drop from outside lands exactly where a drag inside would.

**One gesture, one undo.** Structural actions can carry a `gesture` id, and
`lib/undo.ts` treats a run sharing one as one step — undoing half a move would
leave the element in both pages, or neither.

Tests: `pnpm test:overlay` (38, +3 — capture past the edge, the drop-outside
that is not a drop, probing and clearing); `pnpm test:parking` (13, new — every
lifecycle transition, the save ordering, what persists, loading untrusted data,
coordinate round-trips, one-gesture undo); `cargo test` (110, +2 — the stored
list's shape, atomic writes).

**Not verified in the running app:** none of the gestures have been clicked
through. Known gaps: the card's picture is a crop of the app window, so a panel
floating over the element at the moment of the drop is in it; a pending (never
saved) element can't be parked or moved between pages yet; and the overlay
change only reaches a project when it is reopened.

## Artboards move, like Figma frames (2026-10-25)

Artboards were a row: `index × (width + gap)`, recomputed everywhere that
needed one. They now sit where the user puts them, dragged by their name label
— Figma's gesture, and the only one that leaves the page itself to editing. A
click on the label still selects the artboard for Scan; four pixels of travel
makes it a move.

**One layout rule** (`layoutArtboards`, read through the store's
`artboardLayout`): stored positions win; an artboard without one goes to the
right of the rightmost so far, which with nothing stored is exactly the old
row. The canvas (labels, frames, the off-screen culling, now in two
dimensions), the markup layer, "focus this page" and the cursor-anchored pinch
zoom all read it. Canvas markup is artboard-local, so marks follow their page;
the layer's nearest-artboard rule is now a 2D distance to the box rather than
the nearest column.

Positions are stored with the remembered canvas **per viewport id** — boards
are sized by the viewport, so a layout made for 390px boards would overlap at
1440 — validated on load like the rest of it (finite numbers, open artboards
only). The first move stores the whole current layout rather than one board:
unstored boards are placed relative to the rightmost, so storing only the
moved one would make the rest jump with it. Closing an artboard drops its
position in every viewport, the same way every other per-route choice goes
with it.

`pnpm test:canvas` (17, +4): the row with nothing moved, a moved board staying
put while a new one joins past the rightmost, a board moved far left not
dragging arrivals with it, positions round-tripping per viewport and dirty
ones dropped. Not clicked through in the running app.

## A Settings page, from the menu bar (2026-10-25)

AI backends moved out of the top-bar popover into a Settings page, opened from
the menu bar — **dedup → Settings… (⌘,)**, where every Mac app keeps it — or
from the top bar's AI status chip ("AI: Claude Code + Codex"), which stays so
it is always visible whether AI is on.

The menu is Tauri's default with one item inserted after About (`appmenu.rs`),
not a menu built from scratch: on macOS the Edit menu's items *are* what gives
text fields ⌘C/⌘V/⌘Z/⌘A, so a hand-written menu that forgot one would break
copy and paste in every input. Being a native accelerator, ⌘, also works with
focus inside a canvas iframe, which a keydown listener in the editor window
could not hear.

The page mounts at the app root, so it opens over the launch screen as well as
the editor (a backend is chosen once, for every project), with a section rail
that has one entry today — a new section is a row in `SECTIONS`. Escape closes
it, taken in the capture phase so the editor's own Escape doesn't also fire.
Every message that said "the AI menu (top bar)" now says Settings → AI (⌘,),
and the chat's "no backend" note links straight to it.

Not clicked through in the running app.

Follow-up, same day: the top bar's AI status chip is gone too, at the owner's
request — the backends live in Settings only. The ways in are the menu bar
(⌘,) and the chat's "Open Settings", shown exactly when no backend is on, which
is the moment the chip's orange "AI: off" used to matter.

## Scan moves into the Duplicates tab (2026-10-25)

The top bar's Scan button is gone; scanning lives in the sidebar's Duplicates
tab, beside the results it produces — the same arrangement Drift already had
with its own Rerun. "Scan now" in the empty tab and a new **Rescan** in the
results summary both carry the rule the header button enforced (a live, tagged
canvas scans the artboard you picked, so they wait for one, saying why), and
Rescan reads "Organizing…" while the last scan's components are categorized.
The top bar is now project, view switch, viewport, server status, save and
history.

## Terminals in the console drawer (2026-10-25)

The console was a read-only feed of the dev server. It is now a tabbed,
resizable drawer: **Dev server** (the stream and its parsed errors, as before)
plus any number of shells opened with **+**, each the user's own login shell
on a PTY in the project root (`terminal.rs`). Drag the drawer's top edge to
resize it (remembered across projects; the toolbar lifts by the live height).
⌘K or Clear clears a terminal; a shell that exits leaves its tab readable
until a key is pressed, as Terminal.app does.

- **A PTY, opened with `libc::openpty` + `setsid`/`TIOCSCTTY`** rather than a
  crate: libc was already a dependency and the whole thing is ~100 lines with
  tests driving a real shell. Both ends are `FD_CLOEXEC` — a dev server that
  inherited a master would keep a closed terminal's tty alive and its shell
  would never see the hangup.
- **The pane owns the shell.** Mounting a `TerminalPane` opens it, unmounting
  hangs it up (SIGHUP to the group, SIGKILL after 800ms, reaped). Panes stay
  mounted while the drawer is folded, so folding is not closing; leaving the
  project unmounts them; quitting closes every one (`RunEvent::Exit`), and
  opening a project sweeps any a reloaded webview orphaned.
- **Output is raw bytes over a Tauri `Channel`**, never decoded in Rust or in
  `api.ts` — a UTF-8 character split across two reads would come out as two
  replacement characters. xterm reassembles it.
- **Nothing but the user types into a terminal.** The chat agent has no tools
  by design; a shell would be the most unaudited path to the source there is.

Not clicked through in the running app.

## Every project opens: no compatibility verdict (2026-11-10)

By the owner's decision: there is no "unsupported" or "partially supported"
dialog any more, and dedup opens almost any web project.

**What changed**

- `project::detect` no longer grades. `SupportLevel` is gone; `ProjectInfo`
  gains `stack` (what the project is called — "Astro", "Django"), `run_command`
  (the shell command that starts a project with no package script) and
  `runnable` (did dedup find a way to start it). `warnings` became `notes`.
- `Framework` keeps its four values and now means only *how dedup drives it*.
  `Unknown` is no longer a failure: it is "run the project's own server as
  written, untagged".
- Detection recognises more: any package.json with a `dev`/`start`/`develop`/
  `serve`/`storybook` script; Astro, Remix, Nuxt, SvelteKit, Gatsby, Create
  React App, Angular, Vue CLI, Docusaurus, Eleventy, Parcel, Rsbuild/Rspack,
  webpack by dependency; Django, Rails, Laravel, Phoenix, Hugo, Jekyll, MkDocs,
  FastAPI, Flask and bare PHP by their marker file, each started with the
  command its own docs give (through the project's virtualenv / uv / poetry /
  pipenv when it has one).
- Backends are recognised **before** the JS heuristics, which each got them
  wrong: Laravel depends on `vite` (was "Vite", and the canvas showed Vite's
  asset server), Rails ships `public/404.html` (was a static site). Create
  React App's `public/index.html` template was likewise being served as a flat
  page; a framework with a server of its own and a script now outranks static.
- The Vite tagger launch reads through `KEY=value` prefixes, `cross-env` and
  `npx` (`instrument::split_script`, shared with the Next launch), carrying the
  env. `NODE_ENV=development vite` used to cost a project its tagging.
- `extract_local_url` stops at closing punctuation — Laravel prints
  `[http://127.0.0.1:8000].` and the `]` was ending up in the canvas URL.
- `CompatCard` → `ProjectDetails`: no badge, no struck-out chips, an always
  visible start-command field. `reasonToShowCard` → `reasonToAsk`, which
  returns only `needs-command` (not runnable and none remembered) or
  `needs-ack` (FR-1.5, once per project). First opens and changed projects go
  straight in.

**What "opens" means for a project with no tagger** — and what it does not.
The canvas, routes-by-browsing, viewports, markup, export, the console and
terminals all work. Click-to-inspect, the Style panel and structural edits do
not: they need element ids, which only the Vite+React, Next and static-HTML
pipelines stamp. The editor already says so in place (the instrumentation
event → Inspector / Layers / Pages). The chat and code panel still write only
what the write-back can gate — JS/TS, CSS, HTML — so `.vue`, `.svelte`,
`.astro`, templates and server code are shown, not written. That gate was
deliberately **not** widened here: "written hopefully" is the thing the safety
model forbids.

**Kept on purpose:** the dirty-tree acknowledgement. It is not a verdict about
the project, it is FR-1.5, and dropping it is a safety-model decision that
was not asked for.

**Known gaps:** a backend that needs a second process for assets (Laravel +
Vite, Rails + vite_ruby) gets only its app server — two servers print two
URLs and the first line wins; run the asset watcher in a terminal tab.
Dependencies that aren't installed are noted in project details, not
installed. A workspace root is run by its root script and noted as such.

Tests: `cargo test` (detection per stack, env-prefixed vite scripts, URL
forms), `pnpm test:openprefs` (rewritten for the new rule). Not clicked
through in the running app.

## Mobile apps open through their web build (2026-11-10)

dedup's canvas is a browser, so a mobile app can be shown only where it has a
web build. `project::detect_mobile` (the tail of `detect_backend`) names each
kind and says which case it is:

- **Expo** — `npx expo start --web`, or the project's own `web` script when it
  has one. Without `react-native-web` the note gives the one install line.
- **React Native (bare)** — runnable only through a `web` script. Otherwise
  `runnable: false` with the reason; never the `start` script, which boots
  Metro and prints no address a browser can open (the canvas would wait
  forever). A recognised backend/mobile project no longer falls back to a
  package script at all.
- **Flutter** — `flutter run -d web-server`. Flutter paints its own canvas, so
  it is a live preview with no DOM elements to select.
- **Swift / Kotlin** (`*.xcodeproj` / `*.xcworkspace`, or a Gradle root) —
  named "iOS app" / "Android app", `runnable: false`, and told plainly there is
  no web build.

Expo is JS/TS, so the chat and code panel can edit it; element tagging does
not apply (Metro, not Vite or Next's webpack). Rendering native screens would
mean a simulator/emulator surface instead of an iframe — a different canvas,
not attempted. Tests in `cargo test`; not run against a real Expo or Flutter
project.

## Fix — a Tauri app wouldn't start: "Port 1420 is already in use" (2026-11-10)

Tauri's Vite template sets `server.strictPort: true` on port 1420, because its
shell loads a fixed `devUrl`. dedup starts only Vite and reads the address
from its output, so the pin protects nothing here — and it collides whenever
1420 is taken, which it always is while dedup itself runs under `tauri dev`
(dedup is a Tauri app on the same template port), or while the user's own
`tauri dev` is up. The generated wrapper config (`instrument::wrapper_source`)
now turns `strictPort` off, so Vite takes the next free port. Only in dedup's
wrapper under `node_modules/.dedup`; the user's config is untouched.

Detection adds a note for Tauri projects: the canvas shows the web frontend
without the Rust side, so `invoke` calls get no answer.

## Commit tab: one place to review, commit, roll back, push and land (2026-11-10)

The left sidebar has three tabs — **Pages**, **Layers**, **Commit**. The
Commit tab lists every state a change can be in, top to bottom: staged edits
(not on disk), a chat proposal (on disk, uncommitted on purpose), and dedup's
commits on the branch (newest first, files touched, pushed/local, each with
Undo). Below that, **Publish**.

**Decision (owner, 2026-11-10): dedup may now push, and may move the user's
own branch — main included.** Until today every git write stayed on
`dedup/session-*`. The exception is narrow and lives in `publish.rs`:

- Explicit only. Each action is a button whose first click builds a sentence
  naming the branch, the remote (with its URL) and the commit count; nothing
  runs until that sentence is confirmed. Nothing here is triggered by a save.
- **Push**: one named local branch to the same name on one named remote.
  The refspec is built by dedup with no `+`, so a force is not expressible.
  No `-u` (no config written), no `--no-verify` (the user's pre-push hook is
  theirs), `GIT_TERMINAL_PROMPT=0` so a missing credential fails with advice
  instead of hanging.
- **Land** ("Bring N commits onto main"): **fast-forward or refuse.** With
  the target not checked out it is a compare-and-swap of the ref — HEAD, the
  index and the working tree are untouched, so uncommitted work and a chat
  preview cannot be carried along. Target checked out in this folder: allowed
  only on a clean tree. In another worktree: refused. Landing does not push;
  "Push main" is its own button and its own confirmation.
- **Diverged is refused, not merged.** A merge commit would be a tree nobody
  has seen rendered, written to the trunk by a tool. The message gives the
  two ways on: merge with your own tools, or push the session branch and open
  a pull request. (An in-memory `merge-tree` merge is possible if this turns
  out to be the common case — it needs its own decision.)
- A session cut from a feature branch carries that branch's commits; the
  button says "5 commits: 3 dedup saves and 2 from the branch this session
  started on" rather than a bare number. The preselected target is the branch
  the session most plausibly started from, not always main.
- Status is read from refs only; dedup never fetches.

**Folded in, nothing dropped.** The top bar's staged-changes popover
(`ReviewPanel`) and session-history popover (`History`) are gone; their rows —
per-edit discard, discard all, select on canvas, the class/text diff, per-commit
Undo — are the Commit tab's. Two popovers and a tab would have been three
copies of one list. Kept in the top bar: **Save ⌘S** (the quick commit with a
generated message), the "N edits" chip (now opens the tab), the AI-preview
chip, the save-failed/Retry/Discard state, and a Commit button where the
history clock was. Undo is still `history::revert` (restore the commit's own
paths) — no `git revert`.

**Commit with a message.** `saveAll(message?)`; the subject is always
`dedup: …` because history and undo recognise dedup's commits by it.

**Fixed on the way: a save could commit an unaccepted AI preview.** A save
commits whole files, so a staged edit saved into a file a live preview had
changed took the preview into history. `previewClash` now refuses that save
(and the code panel's), and blocks Undo on a commit whose file holds a preview.

**No git:** the tab says so first, offers "Set up git", and the button reads
"Save N edits in place" — still through `needsDirectWriteWarning` +
`commitOrDirect`. No commits list, no Publish.

Tests: `cargo test` — 18 in `publish.rs` (push: sends only the named branch and
only commits, no git, no remote, unknown remote/branch, option- and
refspec-shaped names, detached HEAD, non-fast-forward never forced; land:
fast-forward leaves tracked/staged/untracked work untouched, diverged, dirty
checked-out target, other worktree, detached, no git, non-session source,
session target). `pnpm test:commit` — 23 (the list, the message, when each
button is offered and the reason when it isn't, the preselected target).
`pnpm build` typechecks.

**Not clicked through in the running app**, and not run against a real remote:
the push tests use a local bare repository, so credential prompts, SSH and a
hosting provider's branch protection are untested. Known limits: undo of a
commit still overwrites the user's own uncommitted edits to that commit's
files (older behaviour, unchanged); only the 24 most recent branches plus
main/master are offered as targets.

## Marquee and multi-selection (2026-11-10)

Asked for in the owner's words: "if i want to select multiple elements i can
just drag across an artboard which selects the elements".

**Decision — which drag is which.** A press inside the single selected element
is the re-parent drag (unchanged after that: ghost, park, cross-artboard);
every other press-and-drag in the select tool draws a marquee. Shift always
marquees and adds; with several selected a drag is a marquee. Moving an
element is therefore select-then-drag, where it used to be one gesture on
anything — the price of having a marquee on a page with no empty space.

**What it does.** Marquee selects the outermost elements it touches and looks
through a container that encloses it (`plugin-src/marquee.mjs`, pure; the
overlay is now bundled so it can import it). Shift-click (canvas or a Layers
row) adds/removes one. Every selected element is outlined; Layers lights all
of them; the inspector says "N elements selected" and offers Delete / Copy /
Cut for all of them as one undo step. A copy of several pastes as several,
also one step. Class edits, text and resize stay single-selection — the store
keeps `selected` null while `multi` is non-empty, so they cannot act on one of
several by accident — and the panel says so.

Tests: `pnpm test:overlay` (52; 14 new — start, threshold, geometry, release,
one/none/many, Escape and blur, never a click or a drop, drag-from-selection
still re-parents, Shift, shift-click, `select-ids`, select-tool only);
`pnpm test:marquee` (15 — the hit rule, `outermostOnly`, `toggleId`). The
drag tests now select before dragging. `pnpm build` typechecks.

**Not tried in the running app.** Nothing here was clicked through: real
hit-testing and layout, the trailing click under real pointer capture, the
store's multi delete/copy/cut/paste against a real write-back (they are
composed from the tested single-element paths but have no test of their own),
and the Layers and inspector rendering. Known limits: no multi-element
re-parent drag or class edit; a selection cannot span artboards; multi-delete
asks the write-back once per element (one sidecar spawn each).

## Fix — four bugs found while filming the demo (2026-11-15)

Recording the YouTube demo against a small Vite + react-router project turned
up four bugs. Each now has a test.

- **Drops in a row nested instead of reordering.** `dropTargetAt` read the
  before / inside / after bands off the pointer's *y* even when the siblings
  run horizontally, so a sideways drag spent its whole life in the middle band
  and nested the element inside its neighbour. It now reads *x* when the
  target's parent is a flex row (flipped for `row-reverse`, so the element
  goes to whichever side the pointer is on), and the insertion line is drawn
  vertically beside the target. Columns are unchanged. `pnpm test:overlay`
  (two new tests; the old `row-reverse` assertion encoded the y rule and was
  rewritten).
- **Phantom pages in Vite projects.** Route discovery always added Next's
  file routes, so a react-router app keeping its views in `src/pages/` showed
  `/Home`, `/Shop`… beside its real routes. Next file routing now applies only
  when the project was detected as Next: `detect_routes` passes `next`/`vite`
  through instead of collapsing everything to `app`, and the Vite tagger says
  `vite`. `pnpm test:plugin` (new routes test); the Rust Next-routes test now
  asks with `next`.
- **Chat keystrokes reaching tool shortcuts.** A keystroke the canvas overlay
  forwards is replayed on `window`, so the shortcut handler's target-only
  "is this a field?" check never saw the composer. It now also asks which
  element has focus (`typingInEditor`, `src/lib/keys.ts`, `pnpm test:keys`).
  Seen only with keystrokes delivered to a background app during recording,
  not reproduced with ordinary typing — this closes the path either way.
- **Stale Settings wording.** The AI note still said the default agent was
  used "for organizing scans and merges". It now names what actually uses it:
  drafting a mock sign-in session.

**Not clicked through in the running app**: the row drop rule and the
vertical line are covered by the overlay suite's stub layout only.
